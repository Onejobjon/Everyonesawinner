# Activation runbook

One page, hand it to anyone: what to do the moment `DATABASE_URL` exists, and how
to recover the owner seat. Nothing here spends odds credits.

## 1. Make accounts durable (the one-line activation)

```bash
export DATABASE_URL='postgres://…'      # Neon / Supabase / any Postgres
bun scripts/db-init.ts                  # applies migrations/*.sql, idempotent
```

Expect: `✓ schema ready. tables: leads, sessions, users` and a row count.
Then reload the site and sign up — the account survives the next deploy. With no
`DATABASE_URL` the app still runs, but logs that accounts are **non-durable** and
every account is lost on publish.

## 2. Owner seat

The seat is controlled **only** by the `OWNER_PASSWORD` secret — it fails closed,
so with no secret nobody can log in as the owner. Save it in Settings → Secrets
(name: `OWNER_PASSWORD`), then log in with that password. No deploy needed: the
secret is read at runtime.

**Recovery** if the secret is lost (does not weaken the gate — nothing can
provision from an arbitrary login):

```bash
OWNER_PASSWORD='new-secret' bun scripts/set-owner-password.ts owner@everyonesawinner.uk
```

Where that lands matters:

- **With `DATABASE_URL`** — it writes the Postgres row, which every environment
  reads, so this command *is* the recovery path. Do this one.
- **Without `DATABASE_URL`** — it writes only this checkout's
  `.run/users.json`. Each environment keeps its own copy of that file, so it
  does not change the live site. Before Postgres, the live lever is the
  `OWNER_PASSWORD` secret itself: the running app rewrites its own owner row
  from that secret on the next owner login.

Either way, `OWNER_PASSWORD` in Secrets must match the password you set.

## 3. Billing → plan (per-user subscription status)

Point a Stripe webhook endpoint at `/api/stripe-webhook` and save the signing
secret as `STRIPE_WEBHOOK_SECRET`. Events handled:

- `checkout.session.completed` → plan set, subscription marked active
- `customer.subscription.created` / `.updated` → plan + status updated
- `customer.subscription.deleted` → access revoked (record kept)

Optional price mapping: `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`,
`STRIPE_PRICE_ANNUAL`. Without a price mapping the plan comes from the price's
`metadata.plan`, then falls back to `pro`. Without `STRIPE_WEBHOOK_SECRET` the
endpoint returns 503 and grants nothing — paying customers would stay
`subscription:false`, so this secret is required before selling anything.

## 4. Verify

```bash
bun scripts/owner-seat-proof.ts      # owner seat cannot be claimed by a stranger
bun scripts/db-init.ts               # schema present, idempotent
```

Then in a browser: sign in as the owner → `/lay-bets` opens; sign in as an
ordinary account → the subscribe screen; forge `localStorage.eaw_session` with a
made-up token → sign-in screen, never a paid tool.
