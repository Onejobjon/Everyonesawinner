-- 005_record_store.sql — the one table behind the storage interface.
--
-- WHY (2026-11-07): accounts, sessions, the Stripe event ledger, comps, leads
-- and the click log were files on the hosting disk, and a redeploy replaces that
-- disk. Verified: an account created on the live site could not be found after
-- the next publish. A paying customer would lose their login at the next deploy,
-- which is why checkout cannot go live on the file driver.
--
-- ONE TABLE, NOT SIX. (store, key) is the primary key and the record is JSONB.
-- The stores hold app documents — an account with a free-access comp, a Stripe
-- event with a note — and the file driver already stores them as documents.
-- Giving each one its own typed table would mean a second schema to keep in step
-- with src/server/storage/types.ts, and two schemas for one record is how the
-- SQL path and the file path drift apart.
--
-- (store, key) PRIMARY KEY is load-bearing: it is what makes Store.create()
-- atomic, and Store.create() is what stops a Stripe event being applied twice.
--
-- Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS, so bootstrapping on
-- every start is safe. Applied by src/server/db-pg.ts ensureSchema().

CREATE TABLE IF NOT EXISTS eaw_store (
  store      TEXT        NOT NULL,
  key        TEXT        NOT NULL,
  value      JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store, key)
);

-- list() orders by created_at; this is the index the prune and the click log use.
CREATE INDEX IF NOT EXISTS eaw_store_created_idx ON eaw_store (store, created_at);
