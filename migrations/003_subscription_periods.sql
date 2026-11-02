-- 003_subscription_periods.sql — the dates entitlement is decided on.
--
-- WHY (2026-11-02): the users table stored a plan and a Stripe status but no
-- dates, so nothing could say when a paid period ended. Entitlement was
-- therefore "has a plan" — one payment bought Pro for ever. The single rule in
-- src/server/entitlement.ts needs the period end (and, for a failed renewal,
-- the grace end) to answer honestly.
--
-- current_period_end: the end of the period the customer has paid for (ISO from
--   Stripe, stored as a timestamp).
-- grace_ends_at: while subscription_status = 'past_due', access continues until
--   this date; the email we send quotes it (terms §9).
--
-- Both nullable: an owner seat (comped, no subscription) has neither, and is
-- entitled by identity rather than by a date.

ALTER TABLE users ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS grace_ends_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS users_stripe_customer_idx ON users (stripe_customer_id);
CREATE INDEX IF NOT EXISTS users_stripe_subscription_idx ON users (stripe_subscription_id);
