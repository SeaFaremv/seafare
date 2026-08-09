# SeaFare

A mobile-first cargo dispatch app for inter-island ferry operations. Multi-
tenant: any number of organizations, each with their own boat(s), staff,
shipments, and settings, all sharing one API + database.

## Repo structure

```
index.html          <- the whole front-end app (deploy via GitHub Pages)
server.js            <- the API layer (Express + Neon serverless driver)
package.json          <- dependencies for the API
neon-schema.sql        <- run once against your new Neon database
env.example              <- copy to .env and fill in real values
```

---

## Setting up a new Neon project

This sets up a brand new, separate Neon project -- not touching your old
one at all. Use this to move away from an old project that's hit its data
transfer quota (or any other reason you want a clean start), while keeping
everything else about the app the same.

### 1. Create the new Neon project
1. Go to [neon.tech](https://neon.tech) and sign in. If your old project's
   quota is tied to your account rather than that specific project, create
   a *new Neon account* instead (the free-tier data transfer quota is
   per-account) -- otherwise a new project under the same account is fine.
2. Create a new project. Note the region -- pick one close to where your API
   server (Render, etc.) will run, to keep latency low.
3. Open the **SQL Editor** for the new project and paste in the entire
   contents of `neon-schema.sql`, then run it. This creates five tables:
   `organizations`, `boats`, `app_data`, `pin_resets`, `boat_requests`.
4. Go to **Connection Details** and copy the connection string (the pooled
   one, if Neon shows both a pooled and direct option). This is your new
   `DATABASE_URL`.

### 2. Deploy the API
If you're keeping your existing Render service and just swapping databases:
1. Go to your service on [Render](https://dashboard.render.com) -> **Environment**.
2. Update `DATABASE_URL` to the new Neon connection string from step 1.
3. Save -- Render will automatically redeploy with the new value.
4. While you're there, upload the latest `server.js` and `package.json`
   (replace the files in your GitHub repo that Render deploys from, then
   push).

If you're setting up a **new** Render service too:
1. Push `server.js`, `package.json`, and `neon-schema.sql` to a GitHub repo.
2. On Render, **New -> Web Service**, connect that repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Under **Environment**, add every variable from `env.example` that applies
   to you (see the comments in that file for what each one does and which
   are optional). At minimum you need `DATABASE_URL` and `APP_URL`;
   `ADMIN_USERNAME`/`ADMIN_PASSWORD` if you want the Super Admin dashboard;
   the Gmail/Twilio ones only if you want automatic PIN-reset delivery
   (the reset link still works without them, just isn't auto-sent).
5. Deploy. Note the service's public URL (e.g.
   `https://your-service.onrender.com`) -- you need it for step 3.

### 3. Point the front-end at the new API
1. Open `index.html` and find this line near the top of the `<script>` tag:
   ```js
   const API_BASE = 'https://YOUR-API-DOMAIN-HERE';
   ```
2. If your API's URL changed (new Render service), update it here. If you
   only swapped the database and kept the same Render service, this line
   doesn't need to change.
3. Commit and push `index.html` to your GitHub Pages repo.

### 4. Verify it's working
1. Open your GitHub Pages URL and go to `#signup`.
2. Create a test organization + boat.
3. Add a customer, log an item, mark it delivered. If all of that works
   without errors, the new database is fully wired up.
4. If you use the Super Admin dashboard, log in at `#admin` with the
   `ADMIN_USERNAME`/`ADMIN_PASSWORD` you set and confirm the test
   organization shows up there.

---

## Moving existing data over (optional)

A fresh Neon project starts **completely empty** -- no organizations, no
boats, no shipments. If you want to keep what's in the old project:

1. In the **old** Neon project's SQL Editor, export each table's data (Neon's
   SQL Editor can export query results as CSV, or use `pg_dump` /
   `COPY ... TO STDOUT` if you have `psql` access) for: `organizations`,
   `boats`, `app_data`, `pin_resets` (usually skippable -- these are
   short-lived tokens), `boat_requests`.
2. Import each into the new project's matching tables, in this order:
   `organizations` first, then `boats` (references organizations), then
   `app_data` and `boat_requests` (reference boats/organizations).
3. If the old database is currently blocked by an exceeded quota, exports
   won't work until either the quota resets (Neon's free tier resets
   monthly -- check **Usage** in that project's dashboard for the exact
   date) or you temporarily upgrade that old project's plan just long enough
   to pull the data out.

If the data isn't critical, skipping this and starting fresh is much
simpler -- every organization just signs up again through the app's normal
`#signup` screen.

---

## Using the app

- **Owner** signs in at `#org` with the boat name (used as username) and
  passkey chosen at signup.
- **Boat Staff / Manager** sign in with a PIN set by the Owner under
  Settings > Staff Management.
- **Sender / Receiver** open the app with no hash (or the boat's specific
  link) -- no login needed, just "I'm Sending" / "I'm Receiving".
- **Super Admin** (you) signs in at `#admin` with `ADMIN_USERNAME`/
  `ADMIN_PASSWORD` to manage every organization and boat.

## Notes

- PINs and passkeys are a light gate, not full security -- see the low-auth
  model described inline in `server.js`. Don't rely on this for
  highly-sensitive data.
- All roles for a given boat share the same live data, refreshed via polling
  every 8-45 seconds depending on connection quality.
- Shipment photos are compressed client-side before upload and excluded
  from routine polling (only fetched in full when actually needed) to keep
  data transfer well within Neon's free-tier quota.
