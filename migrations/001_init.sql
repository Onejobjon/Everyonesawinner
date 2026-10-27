-- 001_init.sql — the account and lead store.
--
-- Applied idempotently by `bun scripts/db-init.ts` (run it the moment
-- DATABASE_URL exists). Every statement is IF NOT EXISTS so re-running is safe.
--
-- Why both a normalised column and a lower() index: emails are stored lowercased
-- by the application, and the unique index on lower(email) is the backstop that
-- makes a duplicate account impossible even if a caller forgets to normalise.

CREATE TABLE IF NOT EXISTS users (
  id                      BIGSERIAL PRIMARY KEY,
  email                   TEXT        NOT NULL,
  name                    TEXT        NOT NULL,
  -- scrypt hash (hex) + per-user salt (hex). Never store the plaintext.
  password_hash           TEXT        NOT NULL,
  salt                    TEXT        NOT NULL,
  -- 'starter' | 'pro' | 'annual' | NULL (free)
  plan                    TEXT,
  -- Stripe subscription state: 'active' | 'trialing' | 'past_due' | 'canceled' | NULL.
  -- NULL means "no Stripe subscription" — an owner seat or a manually comped
  -- account. Entitlement rules live in src/server/entitlement.ts.
  subscription_status     TEXT,
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at           TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

CREATE TABLE IF NOT EXISTS leads (
  id         BIGSERIAL PRIMARY KEY,
  email      TEXT        NOT NULL,
  name       TEXT,
  source     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS leads_email_lower_key ON leads (lower(email));
