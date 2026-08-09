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
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Boat names are looked up case-insensitively (lower(boat_name)) both for
-- uniqueness at signup and for every org login -- this index makes both fast
-- and enforces the uniqueness at the database level too, not just in app code.
CREATE UNIQUE INDEX IF NOT EXISTS organizations_boat_name_lower_idx
  ON organizations (lower(boat_name));

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
-- That's the whole schema. No default/seed rows are inserted here (unlike
-- the old single-tenant version) -- every organization, boat, and its
-- initial rates/settings are created dynamically through the app's own
-- signup flow (POST /api/signup) as real owners sign up. There's nothing
-- to pre-seed at the database level anymore.
-- ---------------------------------------------------------------------------
