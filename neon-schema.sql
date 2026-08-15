-- SeaFare -- full database schema, matching the current multi-
-- tenant server.js exactly (organizations -> boats -> app_data, plus PIN
-- reset tokens and boat-add requests). Run this once against a brand new
-- Neon database.
--
-- This replaces the old single-tenant neon-schema.sql (a single app_data
-- table keyed only by `key`, no organizations/boats at all) which no
-- longer matches how the app has grown. If you're setting up a fresh
-- Neon project, this is the file to run -- the old one is obsolete.

-- ---------------------------------------------------------------------------
-- organizations: one row per owner/company. Created at signup (POST
-- /api/signup). The first boat's name doubles as the login username
-- (case-insensitive unique), so boat_name lives here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id                      TEXT PRIMARY KEY,
  boat_name               TEXT NOT NULL,
  owner_name              TEXT NOT NULL,
  contact_number          TEXT NOT NULL,
  gmail                   TEXT,
  mobile                  TEXT NOT NULL,
  passkey_hash            TEXT NOT NULL,
  bank_account_name       TEXT,
  bank_account_number     TEXT,
  tracking_link           TEXT,
  viber_link              TEXT,
  social_links            JSONB NOT NULL DEFAULT '[]'::jsonb,
  routes                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  totp_secret             TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'suspended'
  suspension_note         TEXT,
  google_refresh_token    TEXT,
  google_connected_email  TEXT,
  is_pro                  BOOLEAN NOT NULL DEFAULT false,
  pro_started_at          TIMESTAMPTZ,
  pro_expires_at          TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Boat names are looked up case-insensitively (lower(boat_name)) both for
-- uniqueness at signup and for every org login -- this index makes both fast
-- and enforces the uniqueness at the database level too, not just in app code.
CREATE UNIQUE INDEX IF NOT EXISTS organizations_boat_name_lower_idx
  ON organizations (lower(boat_name));

-- Safe to run against an existing database that already has the
-- organizations table from before Pro moved to the organization level --
-- adds the three columns only if they're not already there.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS is_pro BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS pro_started_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS pro_expires_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- boats: one row per boat. Every organization gets one free boat at
-- signup (is_primary = true); additional boats go through a request/
-- approval flow (boat_requests below).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS boats (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  is_primary       BOOLEAN NOT NULL DEFAULT false,
  status           TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'suspended'
  suspension_note  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS boats_organization_id_idx ON boats (organization_id);

-- ---------------------------------------------------------------------------
-- app_data: every boat's own shipments/rates/trips/settings, stored as JSON
-- documents scoped by boat_id. This is intentionally NOT cascade-deleted
-- from boats/organizations -- the API cleans it up by hand first (see the
-- DELETE /api/admin/organizations/:id and /api/admin/boats/:id handlers)
-- since it's a different table with its own lifecycle, not a strict
-- ownership relationship worth a hard FK cascade.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_data (
  boat_id     TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (boat_id, key)
);

-- ---------------------------------------------------------------------------
-- pin_resets: one-time tokens for the three PIN/passkey reset flows --
-- Owner PIN reset (role='owner', scoped by boat_id), org login passkey
-- reset (role='org-owner', scoped by organization_id), and the older
-- unscoped legacy path (both null, kept only for backward safety and no
-- longer created by current code). Tokens are single-use and expire after
-- 30 minutes; expired ones older than a day get swept on each new request.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pin_resets (
  token            TEXT PRIMARY KEY,
  role             TEXT NOT NULL DEFAULT 'owner',
  expires_at       TIMESTAMPTZ NOT NULL,
  used             BOOLEAN NOT NULL DEFAULT false,
  boat_id          TEXT REFERENCES boats(id) ON DELETE CASCADE,
  organization_id  TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pin_resets_expires_at_idx ON pin_resets (expires_at);

-- ---------------------------------------------------------------------------
-- boat_requests: an owner's request for an additional boat beyond their
-- free first one, reviewed from the Super Admin dashboard. The payment
-- screenshot is cleared (set to NULL) once approved -- it's sensitive
-- banking info and shouldn't be retained after review.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS boat_requests (
  id                    TEXT PRIMARY KEY,
  organization_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_boat_name   TEXT NOT NULL,
  payment_screenshot    TEXT,
  status                TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'approved' | 'rejected'
  admin_note            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS boat_requests_organization_id_idx ON boat_requests (organization_id);

-- ---------------------------------------------------------------------------
-- admin_settings: a single row (id = 'admin') holding the Super Admin's
-- in-app-editable settings -- an optional username/password override (falls
-- back to the ADMIN_USERNAME/ADMIN_PASSWORD env vars when not set here), the
-- bank account details shown to owners in the Pro upgrade payment popup, and
-- which notification types should be raised to the admin queue. There's only
-- ever one admin account, so a single fixed-id row is enough -- no need for
-- a full table keyed by user.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_settings (
  id                    TEXT PRIMARY KEY DEFAULT 'admin',
  username              TEXT,
  password_hash         TEXT,
  bank_account_name     TEXT,
  bank_account_number   TEXT,
  notify_new_signups    BOOLEAN NOT NULL DEFAULT true,
  notify_boat_requests  BOOLEAN NOT NULL DEFAULT true,
  notify_new_boats      BOOLEAN NOT NULL DEFAULT true,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- pro_payments: one row per Swipe payment link created from the Pro upgrade
-- popup. `reference` is Swipe's transaction code for the payment (returned
-- as `reference` from POST /api/v1/payments, and again as `transaction_code`
-- on the webhook payload) -- it's what correlates an incoming webhook back
-- to the boat that requested the link, since the webhook itself has no idea
-- which SeaFare boat initiated the payment.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pro_payments (
  id            TEXT PRIMARY KEY,
  boat_id       TEXT NOT NULL REFERENCES boats(id) ON DELETE CASCADE,
  swipe_payment_id TEXT NOT NULL,
  reference     TEXT,
  amount        NUMERIC NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'MVR',
  status        TEXT NOT NULL DEFAULT 'PENDING',   -- 'PENDING' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED'
  payment_url   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

-- swipe_payment_id, not reference, is the reliable correlation key --
-- Swipe doesn't always return `reference` at creation time (it may only
-- get assigned once the payment actually progresses), so it can't be
-- required or relied on for matching a webhook back to this row.
CREATE UNIQUE INDEX IF NOT EXISTS pro_payments_swipe_payment_id_idx ON pro_payments (swipe_payment_id);
CREATE INDEX IF NOT EXISTS pro_payments_reference_idx ON pro_payments (reference);
CREATE INDEX IF NOT EXISTS pro_payments_boat_id_idx ON pro_payments (boat_id);

-- Safe to run against an existing database that already has this table
-- from before this fix -- drops the old NOT NULL + unique constraint on
-- reference and adds the new unique index on swipe_payment_id instead.
ALTER TABLE pro_payments ALTER COLUMN reference DROP NOT NULL;
DROP INDEX IF EXISTS pro_payments_reference_idx;
CREATE INDEX IF NOT EXISTS pro_payments_reference_idx ON pro_payments (reference);
CREATE UNIQUE INDEX IF NOT EXISTS pro_payments_swipe_payment_id_idx ON pro_payments (swipe_payment_id);

-- ---------------------------------------------------------------------------
-- That's the whole schema. No default/seed rows are inserted here (unlike
-- the old single-tenant version) -- every organization, boat, and its
-- initial rates/settings are created dynamically through the app's own
-- signup flow (POST /api/signup) as real owners sign up. There's nothing
-- to pre-seed at the database level anymore.
-- ---------------------------------------------------------------------------
