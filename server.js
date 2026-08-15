/**
 * Reference API layer for the SeaFare app, backed by Neon Postgres.
 *
 * Contract expected by the front-end (index.html):
 *   GET  /api/data/:boatId/:key   -> { value: <json or null> }
 *   PUT  /api/data/:boatId/:key   body { value: <json> }  -> upserts, returns { value }
 *
 * This example uses Express + the Neon serverless driver (HTTP-based, works
 * anywhere -- Node, Vercel Functions, Cloudflare Workers with small tweaks).
 * Swap the Express wrapper for your platform's handler signature as needed;
 * the Neon query logic in the middle stays the same.
 *
 * Setup:
 *   npm install express @neondatabase/serverless cors
 *   export DATABASE_URL="postgresql://<user>:<password>@<host>/<db>?sslmode=require"
 *   node server.js
 */

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const { authenticator } = require('otplib');
const { google } = require('googleapis');
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);
const app = express();

// Every response here is JSON text -- shipment lists, settings, invoices --
// which gzip compresses extremely well (typically 60-80% smaller on the
// wire). This was previously being sent completely uncompressed. This
// compresses the browser<->server leg specifically; it doesn't change what
// Neon itself transfers (that's addressed separately, at the query level,
// for the shipments-photo case below), but it directly cuts the data every
// device on a slow connection actually has to download.
app.use(compression());

// The default express.json() body limit is 100kb. Shipments now carry
// compressed photos (base64) inside the same JSON blob, and even a handful
// of them across different shipments comfortably exceeds that -- once it
// does, every save silently starts failing with a 413. 25mb gives plenty of
// headroom for many photos in a single save.
app.use(express.json({ limit: '25mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

// --- Owner PIN reset (emailed via Gmail) -----------------------------------
// GMAIL_USER / GMAIL_APP_PASSWORD are the credentials the app itself sends
// FROM (a Gmail account with an "App Password" generated at
// https://myaccount.google.com/apppasswords — this requires 2-Step
// Verification to be on). The reset link is sent TO whatever address the
// Owner has registered in Settings ("Registered Gmail"). APP_URL is the
// public URL of the front-end (your GitHub Pages site), used to build the
// link, e.g. https://YOUR-USERNAME.github.io
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

const mailer = (GMAIL_USER && GMAIL_APP_PASSWORD)
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    })
  : null;

// --- Owner PIN reset (texted via Twilio SMS) --------------------------------
// TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN come from your Twilio console.
// TWILIO_PHONE_NUMBER is the Twilio number the text is sent FROM (must be
// SMS-capable). The reset link is texted TO whatever number the Owner has
// registered in Settings ("Registered Phone").
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

const smsClient = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN)
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

// --- Owner PIN reset (authenticator app code) -------------------------------
// TOTP_SECRET is a base32 secret known only to this server (set as a Render
// env var, never returned by any API response) and to whatever authenticator
// app (OneAuth, Google Authenticator, Authy, etc.) the Owner entered it into.
// Unlike the email/phone paths, this needs no outside service to work -- the
// 6-digit code the app shows is verified locally against the same secret.
const TOTP_SECRET = process.env.TOTP_SECRET;
authenticator.options = { window: 1 }; // allow 1 step (\u00b130s) of clock drift

// Restrict this to your actual GitHub Pages origin in production,
// e.g. cors({ origin: 'https://seafaremv.github.io' })
app.use(cors());

// Never let browsers or intermediate CDNs cache these responses -- this data
// changes constantly (new check-ins, staff PIN changes, etc), and a cached
// stale response can make the app look broken even when the DB is fine.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

const ALLOWED_KEYS = new Set(['shipments', 'rates', 'settings', 'trips']);

// Phase 3: every shipments/rates/settings/trips read & write is now scoped
// to a specific boat_id, so each boat's dispatch data is private to it.
// boatId isn't re-verified against a passkey here -- same low-auth model as
// the rest of this API (see README) -- but it does have to be a real,
// existing boat, which at least rules out typos/garbage IDs silently
// creating orphaned data.
// Simple public lookup of a boat's display name -- used client-side to
// build things like auto-generated staff usernames (name.boatname).
app.get('/api/boats/:id/name', async (req, res) => {
  try {
    const rows = await sql`SELECT name FROM boats WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'unknown boat' });
    res.json({ name: rows[0].name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db error' });
  }
});

app.get('/api/data/:boatId/:key', async (req, res) => {
  const { boatId, key } = req.params;
  if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: 'unknown key' });
  try {
    const boatRows = await sql`SELECT status, suspension_note FROM boats WHERE id = ${boatId}`;
    if (boatRows.length && boatRows[0].status === 'suspended') {
      return res.status(403).json({ error: 'This boat has been suspended.', note: boatRows[0].suspension_note || null });
    }
    // Routine polling only needs to know whether anything changed, not the
    // embedded photo on every shipment -- and shipments can carry a lot of
    // those. Stripping the 'photo' field *inside* the query (rather than
    // fetching everything and trimming it before responding) means Neon
    // never has to transfer that data out of the database at all, which is
    // what actually counts against the data transfer quota -- not just
    // what reaches the browser. Writes, the initial full load, and photo
    // viewing/downloading all still go through the normal path below,
    // completely unaffected.
    if (key === 'shipments' && req.query.photos === 'exclude') {
      const rows = await sql`
        SELECT
          CASE WHEN jsonb_typeof(value) = 'array' THEN COALESCE(
            (SELECT jsonb_agg(elem - 'photo' ORDER BY ord)
             FROM jsonb_array_elements(value) WITH ORDINALITY AS t(elem, ord)),
            '[]'::jsonb
          ) ELSE value END AS value
        FROM app_data
        WHERE boat_id = ${boatId} AND key = ${key}
      `;
      return res.json({ value: rows.length ? rows[0].value : null });
    }
    const rows = await sql`SELECT value FROM app_data WHERE boat_id = ${boatId} AND key = ${key}`;
    res.json({ value: rows.length ? rows[0].value : null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db error' });
  }
});

app.put('/api/data/:boatId/:key', async (req, res) => {
  const { boatId, key } = req.params;
  if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: 'unknown key' });
  const { value } = req.body || {};
  if (value === undefined) return res.status(400).json({ error: 'missing value' });
  try {
    const boatRows = await sql`SELECT id, status, suspension_note FROM boats WHERE id = ${boatId}`;
    if (boatRows.length === 0) return res.status(404).json({ error: 'unknown boat' });
    if (boatRows[0].status === 'suspended') return res.status(403).json({ error: 'This boat has been suspended.', note: boatRows[0].suspension_note || null });
    await sql`
      INSERT INTO app_data (boat_id, key, value, updated_at)
      VALUES (${boatId}, ${key}, ${JSON.stringify(value)}::jsonb, now())
      ON CONFLICT (boat_id, key) DO UPDATE SET value = ${JSON.stringify(value)}::jsonb, updated_at = now()
    `;
    res.json({ value });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db error' });
  }
});

// --- Swipe payment integration (Pro upgrade) --------------------------------
// Lets the Pro-upgrade popup offer a real payment link (via Swipe's Merchants
// API) alongside the existing manual bank-transfer + screenshot flow. Swipe
// confirms payment through a webhook, which grants/renews Pro on this boat's
// settings automatically -- no admin approval needed for this path (the
// manual bank-transfer path is untouched and still requires it).
//
// SWIPE_CLIENT_ID / SWIPE_CLIENT_SECRET: from the Swipe Merchant Portal
// (merchant.swipe.mv) -> Settings -> API Access -> Create.
// SWIPE_WEBHOOK_SECRET: the "Webhook HMAC Key" shown on that same page.
// SWIPE_ENV: 'production' (default) or 'development' -- selects which of
// Swipe's two API base URLs to use.
// SWIPE_PRO_AMOUNT: MVR amount charged for a 30-day Pro period (defaults to
// the same ރ500 shown in the manual bank-transfer flow).
const SWIPE_CLIENT_ID = process.env.SWIPE_CLIENT_ID;
const SWIPE_CLIENT_SECRET = process.env.SWIPE_CLIENT_SECRET;
const SWIPE_WEBHOOK_SECRET = process.env.SWIPE_WEBHOOK_SECRET;
const SWIPE_BASE_URL = process.env.SWIPE_ENV === 'development'
  ? 'https://merchant-api.swipeapp.dev'
  : 'https://api.swipe.mv';
// Token endpoint is on the production host even in development per Swipe's
// own docs example -- both environments' credentials are exchanged there.
const SWIPE_TOKEN_URL = 'https://api.swipe.mv/oauth2/token';
const SWIPE_PRO_AMOUNT = Number(process.env.SWIPE_PRO_AMOUNT) || 500;

// Cached in memory (per server process) rather than fetched fresh on every
// request -- client-credentials tokens are normally valid for a while, and
// refetching one per payment link would be wasteful. Refreshed a minute
// before actual expiry to avoid a request failing right at the boundary.
let _swipeToken = null;
let _swipeTokenExpiresAt = 0;
async function getSwipeAccessToken(){
  if(!SWIPE_CLIENT_ID || !SWIPE_CLIENT_SECRET){
    throw new Error('Swipe is not configured (SWIPE_CLIENT_ID / SWIPE_CLIENT_SECRET missing).');
  }
  if(_swipeToken && Date.now() < _swipeTokenExpiresAt - 60000) return _swipeToken;
  const res = await fetch(SWIPE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SWIPE_CLIENT_ID,
      client_secret: SWIPE_CLIENT_SECRET,
    }),
  });
  if(!res.ok) throw new Error(`Swipe token request failed (HTTP ${res.status})`);
  const data = await res.json();
  _swipeToken = data.access_token;
  _swipeTokenExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  return _swipeToken;
}
async function swipeApiRequest(method, path, body){
  const token = await getSwipeAccessToken();
  const res = await fetch(`${SWIPE_BASE_URL}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if(!res.ok){
    const detail = (data && (data.detail || data.type)) || `HTTP ${res.status}`;
    throw new Error(`Swipe API error: ${detail}`);
  }
  return data;
}

// Verifies a Swipe webhook per the Standard Webhooks spec: the signed
// content is "{webhook-id}.{webhook-timestamp}.{raw body}", HMAC-SHA256'd
// with the webhook secret (Standard Webhooks secrets are given as
// "whsec_<base64>" -- the part after the prefix is what actually gets
// base64-decoded into key bytes). The header can carry multiple
// space-separated "v1,<sig>" values; matching any one of them counts as
// verified. Also rejects anything older than 5 minutes to guard against a
// replayed request.
function verifySwipeWebhookSignature(headers, rawBody){
  if(!SWIPE_WEBHOOK_SECRET) return false;
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatureHeader = headers['webhook-signature'];
  if(!id || !timestamp || !signatureHeader) return false;

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if(!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

  const secretBytes = Buffer.from(
    SWIPE_WEBHOOK_SECRET.startsWith('whsec_') ? SWIPE_WEBHOOK_SECRET.slice('whsec_'.length) : SWIPE_WEBHOOK_SECRET,
    'base64'
  );
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  return signatureHeader.split(' ').some(part => {
    const sig = part.includes(',') ? part.split(',')[1] : part;
    if(!sig) return false;
    try{
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    }catch(e){ return false; } // length mismatch -- definitely not equal
  });
}

// Same grant/renew math as the Super Admin's manual approval (adminApproveProForBoat
// in index.html): extends 30 days from the boat's existing expiry if it has
// one (so a renewal never loses days), otherwise 30 days from now.
async function grantProToBoat(boatId){
  const rows = await sql`SELECT value FROM app_data WHERE boat_id = ${boatId} AND key = 'settings'`;
  const settings = rows.length ? rows[0].value : {};
  const periodStart = settings.proExpiresAt ? new Date(settings.proExpiresAt) : new Date();
  const periodEnd = new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000);
  settings.isPro = true;
  settings.proStartedAt = periodStart.toISOString();
  settings.proExpiresAt = periodEnd.toISOString();
  settings.proRequestPending = false;
  settings.proRequestScreenshot = null;
  await sql`
    INSERT INTO app_data (boat_id, key, value, updated_at)
    VALUES (${boatId}, 'settings', ${JSON.stringify(settings)}::jsonb, now())
    ON CONFLICT (boat_id, key) DO UPDATE SET value = ${JSON.stringify(settings)}::jsonb, updated_at = now()
  `;
}

// Creates a Swipe payment link for this boat's Pro upgrade/renewal. The
// `reference` Swipe returns (its transaction code) is stored alongside the
// boat ID so the webhook -- which only knows that reference, not anything
// about SeaFare -- can find its way back to the right boat.
app.post('/api/pro/payment-link', async (req, res) => {
  try{
    const { boatId } = req.body || {};
    if(!boatId) return res.status(400).json({ ok:false, error:'boatId is required.' });
    const boatRows = await sql`SELECT id FROM boats WHERE id = ${boatId}`;
    if(!boatRows.length) return res.status(404).json({ ok:false, error:'Unknown boat.' });

    const payment = await swipeApiRequest('POST', '/api/v1/payments', {
      amount: SWIPE_PRO_AMOUNT,
      currency: 'MVR',
      type: 'LINK',
      description: `SeaFare Pro upgrade -- boat ${boatId}`,
    });
    // TEMP DEBUG -- remove once we've confirmed Swipe's actual field names.
    console.log('SWIPE PAYMENT RESPONSE:', JSON.stringify(payment));

    await sql`
      INSERT INTO pro_payments (id, boat_id, swipe_payment_id, reference, amount, currency, status, payment_url)
      VALUES (${'pp-' + Date.now() + '-' + Math.random().toString(36).slice(2,8)}, ${boatId}, ${payment.id}, ${payment.transaction_code}, ${payment.amount}, ${payment.currency}, ${payment.status}, ${payment.payment_url || null})
    `;

    res.status(201).json({ ok:true, paymentUrl: payment.payment_url, reference: payment.transaction_code, status: payment.status });
  }catch(e){
    console.error('create payment link failed', e);
    res.status(502).json({ ok:false, error: 'Could not create a Swipe payment link. Try again, or use the bank transfer option.' });
  }
});

// Manual fallback check (used by a "Check payment status" button in the
// popup) -- polls Swipe directly for this reference's current status,
// rather than only ever waiting on the webhook. Grants Pro here too if it
// turns out to already be COMPLETED and this reference hasn't been
// processed yet, in case the webhook was missed or isn't configured yet.
app.get('/api/pro/payment-link/:reference/status', async (req, res) => {
  try{
    const rows = await sql`SELECT * FROM pro_payments WHERE reference = ${req.params.reference}`;
    if(!rows.length) return res.status(404).json({ ok:false, error:'Unknown payment reference.' });
    const record = rows[0];
    if(record.status === 'COMPLETED'){
      return res.json({ ok:true, status: 'COMPLETED' });
    }
    const remote = await swipeApiRequest('GET', `/api/v1/payments/${record.swipe_payment_id}`);
    if(remote.status === 'COMPLETED' && record.status !== 'COMPLETED'){
      await grantProToBoat(record.boat_id);
      await sql`UPDATE pro_payments SET status = 'COMPLETED', completed_at = now() WHERE reference = ${req.params.reference}`;
    } else if(remote.status !== record.status){
      await sql`UPDATE pro_payments SET status = ${remote.status} WHERE reference = ${req.params.reference}`;
    }
    res.json({ ok:true, status: remote.status });
  }catch(e){
    console.error('payment status check failed', e);
    res.status(502).json({ ok:false, error:'Could not check payment status.' });
  }
});

// Swipe calls this whenever a transaction's status changes. Only
// transaction.state_changed events with status COMPLETED, for a reference
// we actually created a link for, ever grant Pro -- and only once (the
// pro_payments.status check makes this safe against Swipe retrying/
// redelivering the same webhook).
app.post('/api/webhooks/swipe', async (req, res) => {
  try{
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
    if(!verifySwipeWebhookSignature(req.headers, rawBody)){
      return res.status(401).json({ ok:false, error:'Invalid webhook signature.' });
    }
    const { eventType, data } = req.body || {};
    if(eventType !== 'transaction.state_changed' || !data){
      return res.json({ ok:true }); // acknowledged, nothing to do
    }
    const reference = data.transaction_code;
    if(!reference) return res.json({ ok:true });

    const rows = await sql`SELECT * FROM pro_payments WHERE reference = ${reference}`;
    if(!rows.length) return res.json({ ok:true }); // not one of ours (or a different payment type)
    const record = rows[0];

    if(data.status === 'COMPLETED' && record.status !== 'COMPLETED'){
      await grantProToBoat(record.boat_id);
      await sql`UPDATE pro_payments SET status = 'COMPLETED', completed_at = now() WHERE reference = ${reference}`;
    } else if(data.status !== record.status){
      await sql`UPDATE pro_payments SET status = ${data.status} WHERE reference = ${reference}`;
    }
    res.json({ ok:true });
  }catch(e){
    console.error('swipe webhook handling failed', e);
    res.status(500).json({ ok:false });
  }
});


// the email matches, whether Gmail is configured, or whether sending
// succeeds -- this endpoint must never reveal what the registered address
// is or whether an account exists.
// Returns the currently configured authenticator secret (or null if
// TOTP_SECRET hasn't been set on this deployment), so the Owner Settings
// screen can show it for setting up a new device. Note: like every other
// endpoint in this API, there is no server-side login check here -- anyone
// with the API URL can call this, consistent with the rest of this app's
// security model (see README).
app.get('/api/totp-secret', (req, res) => {
  res.json({ secret: TOTP_SECRET || null });
});

app.post('/api/reset-pin/request', async (req, res) => {
  const generic = { ok: true };
  const raw = (req.body && (req.body.identifier || req.body.email) || '').trim();
  if (!raw) return res.json(generic);

  try {
    const rows = await sql`SELECT value FROM app_data WHERE key = 'settings'`;
    const settings = rows.length ? rows[0].value : {};
    const registeredEmail = (settings.ownerEmail || '').trim().toLowerCase();
    const registeredPhone = (settings.ownerPhone || '').replace(/\D/g, '');

    const inputLower = raw.toLowerCase();
    const inputDigits = raw.replace(/\D/g, '');

    const matchedEmail = !!(registeredEmail && registeredEmail === inputLower);
    const matchedPhone = !!(registeredPhone && inputDigits && registeredPhone === inputDigits);

    if ((!matchedEmail && !matchedPhone) || !APP_URL) {
      if (!APP_URL) console.error('Reset requested but APP_URL is not set.');
      return res.json(generic);
    }

    // Housekeeping: drop old tokens so the table doesn't grow forever.
    await sql`DELETE FROM pin_resets WHERE expires_at < now() - interval '1 day'`;

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    await sql`
      INSERT INTO pin_resets (token, role, expires_at)
      VALUES (${token}, 'owner', ${expiresAt})
    `;

    const link = `${APP_URL}/#reset-pin/${token}`;

    // Email and SMS are both best-effort bonuses, not requirements -- if
    // either isn't configured or fails to send, the link is still returned
    // directly below so the Owner (who just proved they know a registered
    // email or phone) can open it themselves or share it via WhatsApp.
    if (matchedEmail && mailer) {
      mailer.sendMail({
        from: `"SeaFare" <${GMAIL_USER}>`,
        to: registeredEmail,
        subject: 'Reset your SeaFare Owner PIN',
        text: `A reset was requested for your SeaFare Owner PIN.\n\nOpen this link to set a new PIN (it expires in 30 minutes):\n${link}\n\nIf you didn't request this, you can safely ignore this email.`,
        html: `<p>A reset was requested for your SeaFare Owner PIN.</p>
               <p><a href="${link}">Click here to set a new PIN</a> (expires in 30 minutes).</p>
               <p>If you didn't request this, you can safely ignore this email.</p>`,
      }).catch(e => console.error('reset-pin email send failed (link is still returned to the app)', e));
    } else if (matchedEmail && !mailer) {
      console.error('Reset matched by email but GMAIL_USER/GMAIL_APP_PASSWORD are not set -- link returned directly to the app instead.');
    }

    if (matchedPhone && smsClient && TWILIO_PHONE_NUMBER) {
      smsClient.messages.create({
        body: `SeaFare: reset your Owner PIN here (expires in 30 min): ${link}`,
        from: TWILIO_PHONE_NUMBER,
        to: settings.ownerPhone,
      }).catch(e => console.error('reset-pin SMS send failed (link is still returned to the app)', e));
    } else if (matchedPhone && (!smsClient || !TWILIO_PHONE_NUMBER)) {
      console.error('Reset matched by phone but TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_PHONE_NUMBER are not fully set -- link returned directly to the app instead.');
    }

    res.json({ ok: true, link });
  } catch (e) {
    console.error(e);
    res.json(generic); // never leak failure details to the client
  }
});

// Verify an authenticator-app code. If it matches TOTP_SECRET, issue a
// reset token directly (no email/SMS round-trip needed) -- this path works
// even if Gmail/Twilio are misconfigured or unreachable, since it's fully
// self-contained on this server.
app.post('/api/reset-pin/totp-verify', async (req, res) => {
  const code = (req.body && req.body.code || '').trim();
  const boatId = (req.body && req.body.boatId || '').trim();
  if (!code || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ ok: false, error: 'Enter the 6-digit code from your authenticator app.' });
  }
  try {
    // Each organization got its own totp_secret at signup. If a boatId is
    // given, use THAT organization's secret; otherwise fall back to the
    // single legacy TOTP_SECRET env var (kept only for backward safety).
    let secret = TOTP_SECRET;
    let ownerBoatId = boatId || null;
    if (boatId) {
      const rows = await sql`
        SELECT o.totp_secret FROM boats b
        JOIN organizations o ON o.id = b.organization_id
        WHERE b.id = ${boatId}
      `;
      if (rows.length && rows[0].totp_secret) secret = rows[0].totp_secret;
    }
    if (!secret) {
      return res.status(400).json({ ok: false, error: 'Authenticator reset is not set up for this boat yet.' });
    }
    const valid = authenticator.verify({ token: code, secret });
    if (!valid) {
      return res.status(400).json({ ok: false, error: 'That code is incorrect or expired. Try the latest code shown in your app.' });
    }

    await sql`DELETE FROM pin_resets WHERE expires_at < now() - interval '1 day'`;

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    await sql`
      INSERT INTO pin_resets (token, role, expires_at, boat_id)
      VALUES (${token}, 'owner', ${expiresAt}, ${ownerBoatId})
    `;

    res.json({ ok: true, token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Something went wrong. Try again.' });
  }
});

// Confirm a reset: consumes the token and sets the new Owner PIN, scoped to
// whichever boat the token was issued for (falls back to the legacy
// unscoped settings row only for very old tokens with no boat_id, which
// will no longer occur going forward).
app.post('/api/reset-pin/confirm', async (req, res) => {
  const { token, newPin } = req.body || {};
  if (!token || !newPin || !/^\d{4,6}$/.test(String(newPin))) {
    return res.status(400).json({ ok: false, error: 'Enter a valid 4\u20136 digit PIN.' });
  }
  try {
    const rows = await sql`SELECT * FROM pin_resets WHERE token = ${token}`;
    const record = rows[0];
    if (!record || record.used || new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ ok: false, error: 'That link is invalid or expired. Request a new one.' });
    }
    if (!record.boat_id) {
      return res.status(400).json({ ok: false, error: 'This reset link is outdated. Request a new one.' });
    }

    const settingsRows = await sql`SELECT value FROM app_data WHERE boat_id = ${record.boat_id} AND key = 'settings'`;
    const settings = settingsRows.length ? settingsRows[0].value : {};
    settings.ownerPin = String(newPin);

    await sql`
      INSERT INTO app_data (boat_id, key, value, updated_at)
      VALUES (${record.boat_id}, 'settings', ${JSON.stringify(settings)}::jsonb, now())
      ON CONFLICT (boat_id, key) DO UPDATE SET value = ${JSON.stringify(settings)}::jsonb, updated_at = now()
    `;
    await sql`UPDATE pin_resets SET used = true WHERE token = ${token}`;

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Something went wrong. Try again.' });
  }
});

// --- Super Admin dashboard (Phase 1 of multi-tenant rebuild) ---------------
// ADMIN_USERNAME / ADMIN_PASSWORD are set once as Render env vars, known
// only to you. There's no session system here (consistent with the rest of
// this API's low-auth model) -- the admin dashboard resends both values with
// every request, and each request is checked against these env vars fresh.
// This is fine for a single admin user; it would need a real session/JWT
// layer before adding more admin accounts.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Reuses the same scrypt hashing already used for owner passkeys (see
// hashPasskey/verifyPasskey further down) -- defined early here since
// checkAdmin needs it above their definition.
function hashSecret(secret){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(secret), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifySecret(secret, stored){
  if(!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(String(secret), salt, 64).toString('hex');
  try{ return crypto.timingSafeEqual(Buffer.from(hash,'hex'), Buffer.from(check,'hex')); }
  catch(e){ return false; }
}

async function getAdminSettingsRow(){
  const rows = await sql`SELECT * FROM admin_settings WHERE id = 'admin'`;
  return rows.length ? rows[0] : null;
}
// Ensures the single admin_settings row exists, seeded from the env vars
// the first time anything touches it -- so a fresh install still works with
// nothing but ADMIN_USERNAME/ADMIN_PASSWORD, but the moment the admin
// changes anything in Settings, that row takes over as the source of truth.
async function ensureAdminSettingsRow(){
  const existing = await getAdminSettingsRow();
  if(existing) return existing;
  await sql`
    INSERT INTO admin_settings (id, username, password_hash)
    VALUES ('admin', ${ADMIN_USERNAME || null}, ${ADMIN_PASSWORD ? hashSecret(ADMIN_PASSWORD) : null})
    ON CONFLICT (id) DO NOTHING
  `;
  return await getAdminSettingsRow();
}

async function checkAdmin(req){
  const u = (req.body && req.body.username) || (req.query && req.query.username) || '';
  const p = (req.body && req.body.passkey) || (req.query && req.query.passkey) || '';
  if(!u || !p) return false;
  const row = await getAdminSettingsRow();
  if(row && row.username && row.password_hash){
    return u === row.username && verifySecret(p, row.password_hash);
  }
  // No override saved yet -- fall back to the env vars.
  return !!(ADMIN_USERNAME && ADMIN_PASSWORD && u === ADMIN_USERNAME && p === ADMIN_PASSWORD);
}
async function requireAdmin(req, res, next){
  try{
    const row = await getAdminSettingsRow();
    const hasOverride = !!(row && row.username && row.password_hash);
    if(!hasOverride && !(ADMIN_USERNAME && ADMIN_PASSWORD)){
      return res.status(503).json({ ok:false, error:'Admin login is not configured yet. Set ADMIN_USERNAME and ADMIN_PASSWORD on the server.' });
    }
    if(!(await checkAdmin(req))) return res.status(401).json({ ok:false, error:'Invalid admin credentials.' });
    next();
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:'Could not verify admin credentials.' });
  }
}

app.post('/api/admin/login', async (req, res) => {
  try{
    const row = await getAdminSettingsRow();
    const hasOverride = !!(row && row.username && row.password_hash);
    if(!hasOverride && !(ADMIN_USERNAME && ADMIN_PASSWORD)){
      return res.status(503).json({ ok:false, error:'Admin login is not configured yet.' });
    }
    if(await checkAdmin(req)) res.json({ ok:true });
    else res.status(401).json({ ok:false, error:'Incorrect username or passkey.' });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:'Something went wrong. Try again.' });
  }
});

// --- Super Admin Settings ---------------------------------------------------
// Everything the Super Admin can edit about their own account/setup: login
// credentials, the bank account shown to owners in the Pro upgrade popup,
// and which notification types raise an alert in the admin queue.
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  try{
    const row = await ensureAdminSettingsRow();
    res.json({ ok:true, settings: {
      username: row.username || ADMIN_USERNAME || '',
      bankAccountName: row.bank_account_name || '',
      bankAccountNumber: row.bank_account_number || '',
      notifyNewSignups: row.notify_new_signups,
      notifyBoatRequests: row.notify_boat_requests,
      notifyNewBoats: row.notify_new_boats,
    }});
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:'Could not load admin settings.' });
  }
});
app.post('/api/admin/settings/credentials', requireAdmin, async (req, res) => {
  try{
    const { newUsername, newPassword } = req.body || {};
    if(!newUsername || !String(newUsername).trim()) return res.status(400).json({ ok:false, error:'Username is required.' });
    if(!newPassword || String(newPassword).length < 6) return res.status(400).json({ ok:false, error:'New password must be at least 6 characters.' });
    await ensureAdminSettingsRow();
    await sql`
      UPDATE admin_settings SET username = ${String(newUsername).trim()}, password_hash = ${hashSecret(newPassword)}, updated_at = now()
      WHERE id = 'admin'
    `;
    res.json({ ok:true });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:'Could not update credentials.' });
  }
});
app.post('/api/admin/settings/bank', requireAdmin, async (req, res) => {
  try{
    const { bankAccountName, bankAccountNumber } = req.body || {};
    await ensureAdminSettingsRow();
    await sql`
      UPDATE admin_settings SET bank_account_name = ${bankAccountName || ''}, bank_account_number = ${bankAccountNumber || ''}, updated_at = now()
      WHERE id = 'admin'
    `;
    res.json({ ok:true });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:'Could not update bank details.' });
  }
});
app.post('/api/admin/settings/notifications', requireAdmin, async (req, res) => {
  try{
    const { notifyNewSignups, notifyBoatRequests, notifyNewBoats } = req.body || {};
    await ensureAdminSettingsRow();
    await sql`
      UPDATE admin_settings SET
        notify_new_signups = ${!!notifyNewSignups},
        notify_boat_requests = ${!!notifyBoatRequests},
        notify_new_boats = ${!!notifyNewBoats},
        updated_at = now()
      WHERE id = 'admin'
    `;
    res.json({ ok:true });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:'Could not update notification preferences.' });
  }
});

// List every organization (owner) with their boats attached, for the
// Super Admin overview screen.
// Runs opportunistically whenever the Super Admin dashboard loads the
// organizations list (there's no background job runner here, so this is
// the closest equivalent to a scheduled check -- it just runs on demand
// instead of on a timer). Anything suspended for more than 15 days,
// whether at the organization level or an individual boat within an
// otherwise-active organization, is permanently deleted: a
// deleted_accounts record is kept first (mobile + names + reason only,
// nothing else), matching exactly what the manual admin delete does.
const SUSPENSION_AUTO_DELETE_MS = 15 * 24 * 60 * 60 * 1000;
async function cleanupExpiredSuspensions(){
  const cutoff = new Date(Date.now() - SUSPENSION_AUTO_DELETE_MS).toISOString();

  const expiredOrgs = await sql`SELECT id, mobile, boat_name, owner_name FROM organizations WHERE status = 'suspended' AND suspended_at IS NOT NULL AND suspended_at < ${cutoff}`;
  for(const org of expiredOrgs){
    const boats = await sql`SELECT id FROM boats WHERE organization_id = ${org.id}`;
    for(const b of boats){ await sql`DELETE FROM app_data WHERE boat_id = ${b.id}`; }
    await sql`
      INSERT INTO deleted_accounts (id, mobile, boat_name, owner_name, reason)
      VALUES (${'del-' + Date.now() + '-' + Math.random().toString(36).slice(2,8)}, ${org.mobile}, ${org.boat_name}, ${org.owner_name}, 'auto_deleted_inactive_suspension')
    `;
    await sql`DELETE FROM organizations WHERE id = ${org.id}`;
  }

  // Individual boats suspended on their own (org itself still active) --
  // same 15-day rule, scoped to just that boat.
  const expiredBoats = await sql`
    SELECT b.id, b.name AS boat_name, o.mobile, o.owner_name
    FROM boats b JOIN organizations o ON o.id = b.organization_id
    WHERE b.status = 'suspended' AND b.suspended_at IS NOT NULL AND b.suspended_at < ${cutoff} AND o.status != 'suspended'
  `;
  for(const boat of expiredBoats){
    await sql`DELETE FROM app_data WHERE boat_id = ${boat.id}`;
    await sql`
      INSERT INTO deleted_accounts (id, mobile, boat_name, owner_name, reason)
      VALUES (${'del-' + Date.now() + '-' + Math.random().toString(36).slice(2,8)}, ${boat.mobile}, ${boat.boat_name}, ${boat.owner_name}, 'auto_deleted_inactive_suspension')
    `;
    await sql`DELETE FROM boats WHERE id = ${boat.id}`;
  }
}

// Super Admin notification queue -- new signups, new boats, pending
// requests, and re-signups of a previously-deleted mobile number.
app.get('/api/admin/notifications', requireAdmin, async (req, res) => {
  try{
    const rows = await sql`SELECT id, type, message, read, created_at FROM admin_notifications ORDER BY created_at DESC LIMIT 200`;
    res.json({ ok:true, notifications: rows });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:'Could not load notifications.' });
  }
});
app.post('/api/admin/notifications/:id/read', requireAdmin, async (req, res) => {
  try{
    await sql`UPDATE admin_notifications SET read = true WHERE id = ${req.params.id}`;
    res.json({ ok:true });
  }catch(e){ console.error(e); res.status(500).json({ ok:false, error:'Could not update notification.' }); }
});
app.post('/api/admin/notifications/read-all', requireAdmin, async (req, res) => {
  try{
    await sql`UPDATE admin_notifications SET read = true WHERE read = false`;
    res.json({ ok:true });
  }catch(e){ console.error(e); res.status(500).json({ ok:false, error:'Could not update notifications.' }); }
});

app.get('/api/admin/organizations', requireAdmin, async (req, res) => {
  try{
    await cleanupExpiredSuspensions();
    const orgs = await sql`SELECT id, boat_name, owner_name, contact_number, gmail, mobile, status, suspension_note, suspended_at, totp_secret, created_at FROM organizations ORDER BY created_at DESC`;
    const boats = await sql`SELECT id, organization_id, name, is_primary, status, suspension_note, suspended_at, created_at FROM boats ORDER BY created_at ASC`;
    // Flag any org whose mobile number has a prior deletion on record, so
    // the admin can see at a glance (and open up why) even outside the
    // notification queue -- e.g. if they missed the original notification.
    const priorDeletions = await sql`SELECT DISTINCT ON (mobile) mobile, boat_name, reason, deleted_at FROM deleted_accounts ORDER BY mobile, deleted_at DESC`;
    const deletionsByMobile = Object.fromEntries(priorDeletions.map(d => [d.mobile, d]));
    const withBoats = orgs.map(o => ({
      ...o,
      boats: boats.filter(b => b.organization_id === o.id),
      priorDeletion: deletionsByMobile[o.mobile] || null,
    }));
    res.json({ ok:true, organizations: withBoats });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:'Could not load organizations.' });
  }
});

// Suspend/unsuspend an organization -- every boat under it becomes
// unusable while suspended (checked at login/data-access time below), but
// nothing is deleted, so access can be restored at any time.
app.post('/api/admin/organizations/:id/suspend', requireAdmin, async (req, res) => {
  try{
    const note = (req.body && req.body.note || '').trim() || null;
    await sql`UPDATE organizations SET status = 'suspended', suspension_note = ${note}, suspended_at = now() WHERE id = ${req.params.id}`;
    await sql`UPDATE boats SET status = 'suspended', suspension_note = ${note}, suspended_at = now() WHERE organization_id = ${req.params.id} AND status != 'suspended'`;
    res.json({ ok:true });
  }catch(e){ console.error(e); res.status(500).json({ ok:false, error:'Could not suspend this organization.' }); }
});
app.post('/api/admin/organizations/:id/unsuspend', requireAdmin, async (req, res) => {
  try{
    await sql`UPDATE organizations SET status = 'active', suspension_note = NULL, suspended_at = NULL WHERE id = ${req.params.id}`;
    await sql`UPDATE boats SET status = 'active', suspension_note = NULL, suspended_at = NULL WHERE organization_id = ${req.params.id} AND status = 'suspended'`;
    res.json({ ok:true });
  }catch(e){ console.error(e); res.status(500).json({ ok:false, error:'Could not unsuspend this organization.' }); }
});

// Permanently delete an organization and everything under it -- boats,
// boat requests (cascade via FK), and each boat's own app_data (shipments,
// rates, trips, settings), which isn't covered by a cascade so it's
// cleaned up by hand first.
app.delete('/api/admin/organizations/:id', requireAdmin, async (req, res) => {
  try{
    const orgRows = await sql`SELECT mobile, boat_name, owner_name FROM organizations WHERE id = ${req.params.id}`;
    const org = orgRows[0];
    const boats = await sql`SELECT id FROM boats WHERE organization_id = ${req.params.id}`;
    for(const b of boats){
      await sql`DELETE FROM app_data WHERE boat_id = ${b.id}`;
    }
    if(org){
      await sql`
        INSERT INTO deleted_accounts (id, mobile, boat_name, owner_name, reason)
        VALUES (${'del-' + Date.now() + '-' + Math.random().toString(36).slice(2,8)}, ${org.mobile}, ${org.boat_name}, ${org.owner_name}, 'deleted_by_admin')
      `;
    }
    await sql`DELETE FROM organizations WHERE id = ${req.params.id}`;
    res.json({ ok:true });
  }catch(e){ console.error(e); res.status(500).json({ ok:false, error:'Could not delete this organization.' }); }
});

// Suspend/unsuspend a single boat (doesn't affect sibling boats under the
// same organization).
app.post('/api/admin/boats/:id/suspend', requireAdmin, async (req, res) => {
  try{
    const note = (req.body && req.body.note || '').trim() || null;
    await sql`UPDATE boats SET status = 'suspended', suspension_note = ${note}, suspended_at = now() WHERE id = ${req.params.id}`;
    res.json({ ok:true });
  }catch(e){ console.error(e); res.status(500).json({ ok:false, error:'Could not suspend this boat.' }); }
});
app.post('/api/admin/boats/:id/unsuspend', requireAdmin, async (req, res) => {
  try{
    await sql`UPDATE boats SET status = 'active', suspension_note = NULL, suspended_at = NULL WHERE id = ${req.params.id}`;
    res.json({ ok:true });
  }catch(e){ console.error(e); res.status(500).json({ ok:false, error:'Could not unsuspend this boat.' }); }
});

// Permanently delete a single boat and its own app_data.
app.delete('/api/admin/boats/:id', requireAdmin, async (req, res) => {
  try{
    const boatRows = await sql`
      SELECT b.name AS boat_name, o.mobile, o.owner_name
      FROM boats b JOIN organizations o ON o.id = b.organization_id
      WHERE b.id = ${req.params.id}
    `;
    const boat = boatRows[0];
    await sql`DELETE FROM app_data WHERE boat_id = ${req.params.id}`;
    if(boat){
      await sql`
        INSERT INTO deleted_accounts (id, mobile, boat_name, owner_name, reason)
        VALUES (${'del-' + Date.now() + '-' + Math.random().toString(36).slice(2,8)}, ${boat.mobile}, ${boat.boat_name}, ${boat.owner_name}, 'deleted_by_admin')
      `;
    }
    await sql`DELETE FROM boats WHERE id = ${req.params.id}`;
    res.json({ ok:true });
  }catch(e){ console.error(e); res.status(500).json({ ok:false, error:'Could not delete this boat.' }); }
});

// List boat requests (pending additional-boat approvals), newest first.
app.get('/api/admin/boat-requests', requireAdmin, async (req, res) => {
  try{
    const rows = await sql`
      SELECT br.id, br.organization_id, br.requested_boat_name, br.payment_screenshot,
             br.status, br.admin_note, br.created_at, br.reviewed_at,
             o.boat_name AS org_boat_name, o.owner_name
      FROM boat_requests br
      JOIN organizations o ON o.id = br.organization_id
      ORDER BY br.created_at DESC
    `;
    res.json({ ok:true, requests: rows });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:'Could not load boat requests.' });
  }
});

// Approve a pending boat request: creates the new boat row and marks the
// request approved. This is the step you take after confirming the
// transfer landed in your account.
app.post('/api/admin/boat-requests/:id/approve', requireAdmin, async (req, res) => {
  try{
    const rows = await sql`SELECT * FROM boat_requests WHERE id = ${req.params.id}`;
    const request = rows[0];
    if(!request) return res.status(404).json({ ok:false, error:'Request not found.' });
    if(request.status !== 'pending') return res.status(400).json({ ok:false, error:'This request was already reviewed.' });

    const boatId = crypto.randomBytes(8).toString('hex');
    await sql`
      INSERT INTO boats (id, organization_id, name, is_primary, status)
      VALUES (${boatId}, ${request.organization_id}, ${request.requested_boat_name}, false, 'active')
    `;

    // Pre-fill this new boat's Payment Details and Trip Defaults contact
    // number from the org's own info (set at signup) -- editable separately
    // per boat from here on.
    const orgRows = await sql`SELECT contact_number, bank_account_name, bank_account_number FROM organizations WHERE id = ${request.organization_id}`;
    const org = orgRows[0];
    if(org && (org.bank_account_name || org.bank_account_number || org.contact_number)){
      const initialSettings = {
        bankAccountName: org.bank_account_name || '', bankAccountNumber: org.bank_account_number || '',
        tripDefaults: { boatContacts: org.contact_number || '', trackingLink: '', viberLink: '' },
      };
      await sql`
        INSERT INTO app_data (boat_id, key, value, updated_at)
        VALUES (${boatId}, 'settings', ${JSON.stringify(initialSettings)}::jsonb, now())
        ON CONFLICT (boat_id, key) DO UPDATE SET value = ${JSON.stringify(initialSettings)}::jsonb, updated_at = now()
      `;
    }

    // The screenshot is returned once in this response (so the admin can
    // download it), then permanently cleared from the database -- it's
    // sensitive banking info and shouldn't be retained after approval.
    await sql`UPDATE boat_requests SET status = 'approved', reviewed_at = now(), payment_screenshot = NULL WHERE id = ${req.params.id}`;
    res.json({ ok:true, boatId, paymentScreenshot: request.payment_screenshot || null, requestedBoatName: request.requested_boat_name });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:'Could not approve this request.' });
  }
});

app.post('/api/admin/boat-requests/:id/reject', requireAdmin, async (req, res) => {
  try{
    const note = (req.body && req.body.note) || '';
    await sql`UPDATE boat_requests SET status = 'rejected', admin_note = ${note}, reviewed_at = now() WHERE id = ${req.params.id}`;
    res.json({ ok:true });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:'Could not reject this request.' });
  }
});

// Test-only helper for this phase: lets you (or me, during testing) create
// a boat request without the owner-facing request UI existing yet -- that
// UI is later-phase work. Remove or restrict this once real owner signups
// exist.
app.post('/api/admin/boat-requests/seed', requireAdmin, async (req, res) => {
  try{
    const { organizationId, requestedBoatName, paymentScreenshot } = req.body || {};
    if(!organizationId || !requestedBoatName) return res.status(400).json({ ok:false, error:'organizationId and requestedBoatName are required.' });
    const id = crypto.randomBytes(8).toString('hex');
    await sql`
      INSERT INTO boat_requests (id, organization_id, requested_boat_name, payment_screenshot)
      VALUES (${id}, ${organizationId}, ${requestedBoatName}, ${paymentScreenshot || null})
    `;
    res.json({ ok:true, id });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:'Could not create request.' });
  }
});

// --- Owner signup / org login (Phase 2 of the multi-tenant rebuild) --------
// Passkeys are hashed with scrypt (Node's built-in crypto, no extra
// dependency) -- never stored or compared as plain text.
function hashPasskey(passkey){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(passkey), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPasskey(passkey, stored){
  if(!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(String(passkey), salt, 64).toString('hex');
  try{ return crypto.timingSafeEqual(Buffer.from(hash,'hex'), Buffer.from(check,'hex')); }
  catch(e){ return false; }
}

// Create a new owner + their one free boat. Returns the TOTP secret once,
// in the response, so the front-end can show it to the owner for adding to
// an authenticator app -- it is never returned again after this call.
// Small helper for the Super Admin notification queue -- used from
// signup, boat requests, and boat-request approval below.
async function notifyAdmin(type, message){
  try{
    await sql`
      INSERT INTO admin_notifications (id, type, message)
      VALUES (${'note-' + Date.now() + '-' + Math.random().toString(36).slice(2,8)}, ${type}, ${message})
    `;
  }catch(e){ console.error('notifyAdmin failed', e); }
}

app.post('/api/signup', async (req, res) => {
  try{
    const b = req.body || {};
    const required = ['boatName','ownerName','contactNumber','mobile','passkey'];
    for(const f of required){
      if(!b[f] || !String(b[f]).trim()) return res.status(400).json({ ok:false, error:`Missing ${f}.` });
    }
    if(String(b.passkey).length < 6) return res.status(400).json({ ok:false, error:'PIN must be at least 6 characters.' });

    // The first boat's name doubles as the owner's login username, so it
    // has to be unique across every organization -- otherwise two owners
    // could collide and neither could log in reliably.
    const existing = await sql`SELECT id FROM organizations WHERE lower(boat_name) = lower(${b.boatName})`;
    if(existing.length > 0) return res.status(409).json({ ok:false, error:'That boat name is already taken as a username. Choose a different one.' });

    // Was this mobile number previously deleted (by an admin, or
    // automatically after 15 days suspended)? Flag it distinctly for the
    // Super Admin rather than silently letting it back in unnoticed.
    const priorDeletion = await sql`SELECT boat_name, reason, deleted_at FROM deleted_accounts WHERE mobile = ${b.mobile} ORDER BY deleted_at DESC LIMIT 1`;

    const orgId = crypto.randomBytes(8).toString('hex');
    const totpSecret = authenticator.generateSecret();
    const passkeyHash = hashPasskey(b.passkey);

    await sql`
      INSERT INTO organizations (
        id, boat_name, owner_name, contact_number, gmail, mobile, passkey_hash,
        bank_account_name, bank_account_number, tracking_link, viber_link,
        social_links, routes, totp_secret
      ) VALUES (
        ${orgId}, ${b.boatName}, ${b.ownerName}, ${b.contactNumber}, ${b.gmail || null}, ${b.mobile}, ${passkeyHash},
        ${b.bankAccountName || null}, ${b.bankAccountNumber || null}, ${b.trackingLink || null}, ${b.viberLink || null},
        ${JSON.stringify(b.socialLinks || [])}::jsonb, ${JSON.stringify(b.routes || [])}::jsonb, ${totpSecret}
      )
    `;

    const boatId = crypto.randomBytes(8).toString('hex');
    await sql`
      INSERT INTO boats (id, organization_id, name, is_primary, status)
      VALUES (${boatId}, ${orgId}, ${b.boatName}, true, 'active')
    `;

    if(priorDeletion.length > 0){
      await notifyAdmin('resignup_after_deletion', `${b.ownerName} (${b.mobile}) signed up again as "${b.boatName}" -- was previously deleted ("${priorDeletion[0].boat_name}", removed ${priorDeletion[0].deleted_at.toISOString().slice(0,10)}).`);
    } else {
      await notifyAdmin('new_signup', `New signup: ${b.ownerName} created boat "${b.boatName}".`);
    }

    // Pre-fill this boat's own Payment Details and Trip Defaults contact
    // number from what was entered at signup -- stays editable separately
    // per boat from here on, this just saves re-typing it the first time.
    if(b.bankAccountName || b.bankAccountNumber || b.contactNumber){
      const initialSettings = {
        bankAccountName: b.bankAccountName || '', bankAccountNumber: b.bankAccountNumber || '',
        tripDefaults: { boatContacts: b.contactNumber || '', trackingLink: b.trackingLink || '', viberLink: b.viberLink || '' },
      };
      await sql`
        INSERT INTO app_data (boat_id, key, value, updated_at)
        VALUES (${boatId}, 'settings', ${JSON.stringify(initialSettings)}::jsonb, now())
        ON CONFLICT (boat_id, key) DO UPDATE SET value = ${JSON.stringify(initialSettings)}::jsonb, updated_at = now()
      `;
    }

    res.json({ ok:true, organizationId: orgId, boatId, totpSecret });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:'Could not create your account. Try again.' });
  }
});

// Owner login: identify by boat name (case-insensitive) + passkey.
// "Forgot Password" for the #org Owner Login screen. Verifies the code
// against that organization's own authenticator secret (set at signup),
// then issues a token scoped to resetting THAT organization's login
// passkey -- distinct from the older per-boat ownerPin reset flow.
app.post('/api/org-reset/totp-verify', async (req, res) => {
  const boatName = (req.body && req.body.boatName || '').trim();
  const code = (req.body && req.body.code || '').trim();
  const generic = { ok: false, error: 'Incorrect boat name or code.' };
  if (!boatName || !code || !/^\d{6}$/.test(code)) return res.status(400).json(generic);
  try {
    const rows = await sql`SELECT id, totp_secret FROM organizations WHERE lower(boat_name) = lower(${boatName})`;
    const org = rows[0];
    if (!org || !org.totp_secret) return res.status(400).json(generic);
    const valid = authenticator.verify({ token: code, secret: org.totp_secret });
    if (!valid) return res.status(400).json(generic);

    await sql`DELETE FROM pin_resets WHERE expires_at < now() - interval '1 day'`;

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    await sql`
      INSERT INTO pin_resets (token, role, expires_at, organization_id)
      VALUES (${token}, 'org-owner', ${expiresAt}, ${org.id})
    `;
    res.json({ ok: true, token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Something went wrong. Try again.' });
  }
});

app.post('/api/org-reset/confirm', async (req, res) => {
  const { token, newPasskey } = req.body || {};
  if (!token || !newPasskey || String(newPasskey).length < 6) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters.' });
  }
  try {
    const rows = await sql`SELECT * FROM pin_resets WHERE token = ${token}`;
    const record = rows[0];
    if (!record || record.used || new Date(record.expires_at) < new Date() || !record.organization_id) {
      return res.status(400).json({ ok: false, error: 'That link is invalid or expired. Request a new one.' });
    }
    const passkeyHash = hashPasskey(newPasskey);
    await sql`UPDATE organizations SET passkey_hash = ${passkeyHash} WHERE id = ${record.organization_id}`;
    await sql`UPDATE pin_resets SET used = true WHERE token = ${token}`;
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Something went wrong. Try again.' });
  }
});

app.post('/api/org-login', async (req, res) => {
  try{
    const { boatName, passkey } = req.body || {};
    if(!boatName || !passkey) return res.status(400).json({ ok:false, error:'Username and PIN are required.' });
    const rows = await sql`SELECT * FROM organizations WHERE lower(boat_name) = lower(${boatName})`;
    const org = rows[0];
    if(!org || !verifyPasskey(passkey, org.passkey_hash)){
      return res.status(401).json({ ok:false, error:'Incorrect username or PIN.' });
    }
    if(org.status === 'suspended'){
      return res.status(403).json({ ok:false, error:'This account has been suspended. Contact support for help.', note: org.suspension_note || null, suspendedAt: org.suspended_at || null });
    }
    const boats = await sql`SELECT id, name, is_primary, status, suspension_note, suspended_at FROM boats WHERE organization_id = ${org.id} ORDER BY created_at ASC`;
    res.json({
      ok:true,
      organization: {
        id: org.id, boatName: org.boat_name, ownerName: org.owner_name,
        contactNumber: org.contact_number, gmail: org.gmail, mobile: org.mobile,
        bankAccountName: org.bank_account_name, bankAccountNumber: org.bank_account_number,
        trackingLink: org.tracking_link, viberLink: org.viber_link,
        socialLinks: org.social_links, routes: org.routes,
      },
      boats,
    });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:'Something went wrong. Try again.' });
  }
});

// Owner requests an additional boat. Re-verifies the org's own passkey so
// this can't be called by anyone who merely knows the organizationId.
app.post('/api/boat-requests', async (req, res) => {
  try{
    const { organizationId, passkey, requestedBoatName, paymentScreenshot } = req.body || {};
    if(!organizationId || !passkey || !requestedBoatName){
      return res.status(400).json({ ok:false, error:'Missing required fields.' });
    }
    const rows = await sql`SELECT passkey_hash, boat_name FROM organizations WHERE id = ${organizationId}`;
    const org = rows[0];
    if(!org || !verifyPasskey(passkey, org.passkey_hash)){
      return res.status(401).json({ ok:false, error:'Could not verify your account.' });
    }
    const id = crypto.randomBytes(8).toString('hex');
    await sql`
      INSERT INTO boat_requests (id, organization_id, requested_boat_name, payment_screenshot)
      VALUES (${id}, ${organizationId}, ${requestedBoatName}, ${paymentScreenshot || null})
    `;
    await notifyAdmin('pending_request', `${org.boat_name} requested a new boat: "${requestedBoatName}".`);
    res.json({ ok:true, id });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:'Could not submit your request. Try again.' });
  }
});

// Every owner is entitled to one free boat. Normally that's the primary
// boat created at signup -- but if it (and every other boat) has since been
// deleted, an org can be left with zero boats. In that specific case, adding
// a boat is free and immediate, same as signup, with no request/approval/
// payment step -- it only becomes a paid request once they already have one.
app.post('/api/boats/first-free', async (req, res) => {
  try{
    const { organizationId, passkey, boatName } = req.body || {};
    if(!organizationId || !passkey || !boatName){
      return res.status(400).json({ ok:false, error:'Missing required fields.' });
    }
    const rows = await sql`SELECT passkey_hash, contact_number, bank_account_name, bank_account_number FROM organizations WHERE id = ${organizationId}`;
    const org = rows[0];
    if(!org || !verifyPasskey(passkey, org.passkey_hash)){
      return res.status(401).json({ ok:false, error:'Could not verify your account.' });
    }
    const existing = await sql`SELECT id FROM boats WHERE organization_id = ${organizationId} LIMIT 1`;
    if(existing.length > 0){
      return res.status(400).json({ ok:false, error:'This organization already has a boat. Additional boats require a request and approval.' });
    }
    const boatId = crypto.randomBytes(8).toString('hex');
    await sql`
      INSERT INTO boats (id, organization_id, name, is_primary, status)
      VALUES (${boatId}, ${organizationId}, ${boatName}, true, 'active')
    `;
    if(org.bank_account_name || org.bank_account_number || org.contact_number){
      const initialSettings = {
        bankAccountName: org.bank_account_name || '', bankAccountNumber: org.bank_account_number || '',
        tripDefaults: { boatContacts: org.contact_number || '', trackingLink: '', viberLink: '' },
      };
      await sql`
        INSERT INTO app_data (boat_id, key, value, updated_at)
        VALUES (${boatId}, 'settings', ${JSON.stringify(initialSettings)}::jsonb, now())
        ON CONFLICT (boat_id, key) DO UPDATE SET value = ${JSON.stringify(initialSettings)}::jsonb, updated_at = now()
      `;
    }
    await notifyAdmin('new_boat', `New boat created: "${boatName}".`);
    res.json({ ok:true, boatId });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:'Could not add your boat. Try again.' });
  }
});

// --- Google Sheets trip logging ---------------------------------------------
// Each ORGANIZATION (not boat) connects one Google account, once, via OAuth.
// Sheets created for that organization's boats live directly in that
// person's own Google Drive -- nothing is stored on our side except the
// refresh token needed to act on their behalf. Requires a Google Cloud
// project with the Sheets + Drive APIs enabled, an OAuth 2.0 Client ID, and
// these three env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
// GOOGLE_REDIRECT_URI (must exactly match the redirect URI registered in
// Google Cloud Console), plus APP_URL (your GitHub Pages URL) to bounce
// back to after connecting.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const GOOGLE_APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/userinfo.email'];
const SHEET_TAB = 'Cargo Log';
const SHEET_HEADER = ['Tracking Code','Sender Name','Sender Mobile','Receiver Name','Receiver Mobile','Destination Island','Items','Total','Payment Status','Delivery Status','Loaded At','Delivered At'];

function googleConfigured(){ return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI); }
function makeGoogleOAuthClient(){
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}
// Every organization's Google connection is looked up via whichever boat is
// asking -- boats don't each get their own Google account, they share their
// organization's one connection.
async function getGoogleClientForBoat(boatId){
  const rows = await sql`
    SELECT o.google_refresh_token FROM boats b
    JOIN organizations o ON o.id = b.organization_id
    WHERE b.id = ${boatId}
  `;
  const token = rows[0] && rows[0].google_refresh_token;
  if(!token) return null;
  const client = makeGoogleOAuthClient();
  client.setCredentials({ refresh_token: token });
  return client;
}
function shipmentToSheetRow(s){
  const items = (s.items||[]).map(i => `${i.qty}x ${i.name}`).join(', ');
  return [
    s.id || '', s.name || '', s.mobile || '', s.receiverName || '', s.receiverMobile || '',
    s.island || '', items, (s.total != null ? s.total : ''), (s.paid ? 'Paid' : 'Unpaid'),
    s.status || '', s.loadedAt || '', s.deliveredAt || '',
  ];
}

// Start the connect flow -- boatId travels through as the OAuth "state" so
// the callback knows which boat's organization to attach the token to.
app.get('/api/google/auth-url', (req, res) => {
  if(!googleConfigured()) return res.status(503).json({ error: 'Google integration is not configured yet.' });
  const boatId = req.query.boatId;
  if(!boatId) return res.status(400).json({ error: 'boatId is required.' });
  const client = makeGoogleOAuthClient();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // forces a refresh_token every time, not just the first connect
    scope: GOOGLE_SCOPES,
    state: boatId,
  });
  res.json({ url });
});

app.get('/api/google/oauth-callback', async (req, res) => {
  const { code, state: boatId } = req.query;
  if(!googleConfigured() || !code || !boatId){
    return res.status(400).send('Missing information. Close this tab and try connecting again.');
  }
  try{
    const client = makeGoogleOAuthClient();
    const { tokens } = await client.getToken(code);
    if(!tokens.refresh_token){
      // Happens if the account already granted consent before without
      // prompt=consent forcing a fresh one -- shouldn't occur here since we
      // always pass prompt=consent, but guard anyway.
      return res.status(400).send('Google did not return a long-lived connection. Revoke access for this app in your Google Account and try again.');
    }
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const me = await oauth2.userinfo.get();
    const email = me.data.email;

    const boatRows = await sql`SELECT organization_id FROM boats WHERE id = ${boatId}`;
    const orgId = boatRows[0] && boatRows[0].organization_id;
    if(orgId){
      await sql`UPDATE organizations SET google_refresh_token = ${tokens.refresh_token}, google_connected_email = ${email} WHERE id = ${orgId}`;
    }
    res.redirect(`${GOOGLE_APP_URL}/#owner/${boatId}`);
  }catch(e){
    console.error(e);
    res.status(500).send('Could not connect your Google account. Close this tab and try again.');
  }
});

app.get('/api/google/status', async (req, res) => {
  const boatId = req.query.boatId;
  if(!boatId) return res.status(400).json({ connected:false });
  try{
    const rows = await sql`
      SELECT o.google_connected_email FROM boats b
      JOIN organizations o ON o.id = b.organization_id
      WHERE b.id = ${boatId}
    `;
    const email = rows[0] && rows[0].google_connected_email;
    res.json({ connected: !!email, email: email || null, configured: googleConfigured() });
  }catch(e){ console.error(e); res.status(500).json({ connected:false }); }
});

app.post('/api/google/disconnect', async (req, res) => {
  const { boatId } = req.body || {};
  if(!boatId) return res.status(400).json({ ok:false });
  try{
    const boatRows = await sql`SELECT organization_id FROM boats WHERE id = ${boatId}`;
    const orgId = boatRows[0] && boatRows[0].organization_id;
    if(orgId) await sql`UPDATE organizations SET google_refresh_token = NULL, google_connected_email = NULL WHERE id = ${orgId}`;
    res.json({ ok:true });
  }catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});

// Create a new sheet for a trip, with a header row already in place.
// Silently no-ops with { ok:false, error:'not_connected' } if this boat's
// organization hasn't connected Google -- trips still work fine without it.
app.post('/api/google/sheets/create', async (req, res) => {
  const { boatId, title } = req.body || {};
  try{
    const client = await getGoogleClientForBoat(boatId);
    if(!client) return res.json({ ok:false, error:'not_connected' });
    const sheets = google.sheets({ version:'v4', auth: client });
    const created = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: title || 'Ferry Cargo Trip' },
        sheets: [{ properties: { title: SHEET_TAB } }],
      },
    });
    const spreadsheetId = created.data.spreadsheetId;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_HEADER] },
    });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{
        repeatCell: {
          range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      }]},
    });
    res.json({ ok:true, sheetId: spreadsheetId, sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:'Could not create the sheet.' });
  }
});

// Live row sync -- called on every shipment change (check-in, loaded,
// delivered, paid). Upserts by tracking code: updates the existing row if
// found, appends a new one if not.
app.post('/api/google/sheets/sync-row', async (req, res) => {
  const { boatId, sheetId, shipment } = req.body || {};
  if(!sheetId || !shipment || !shipment.id) return res.json({ ok:false });
  try{
    const client = await getGoogleClientForBoat(boatId);
    if(!client) return res.json({ ok:false, error:'not_connected' });
    const sheets = google.sheets({ version:'v4', auth: client });
    const colA = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${SHEET_TAB}!A:A` });
    const rows = colA.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === shipment.id);
    const row = shipmentToSheetRow(shipment);
    if(rowIndex === -1){
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: `${SHEET_TAB}!A:L`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      });
    } else {
      const rowNum = rowIndex + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${SHEET_TAB}!A${rowNum}:L${rowNum}`,
        valueInputOption: 'RAW',
        requestBody: { values: [row] },
      });
    }
    res.json({ ok:true });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false });
  }
});

// Trip end: rename the sheet to mark it closed out, and save a PDF export
// alongside it in the same Drive.
app.post('/api/google/sheets/finalize', async (req, res) => {
  const { boatId, sheetId, tripTitle } = req.body || {};
  if(!sheetId) return res.json({ ok:false });
  try{
    const client = await getGoogleClientForBoat(boatId);
    if(!client) return res.json({ ok:false, error:'not_connected' });
    const drive = google.drive({ version:'v3', auth: client });
    const dateStr = new Date().toISOString().slice(0,10);
    const finalName = `${tripTitle || 'Trip'} \u2014 FINAL \u2014 ${dateStr}`;
    await drive.files.update({ fileId: sheetId, requestBody: { name: finalName } });

    const exported = await drive.files.export(
      { fileId: sheetId, mimeType: 'application/pdf' },
      { responseType: 'arraybuffer' }
    );
    const pdfBuffer = Buffer.from(exported.data);
    const { Readable } = require('stream');
    const pdfFile = await drive.files.create({
      requestBody: { name: `${finalName}.pdf`, mimeType: 'application/pdf' },
      media: { mimeType: 'application/pdf', body: Readable.from(pdfBuffer) },
    });
    res.json({ ok:true, pdfFileId: pdfFile.data.id });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:'Could not finalize the sheet.' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Cargo API listening on :${port}`));
