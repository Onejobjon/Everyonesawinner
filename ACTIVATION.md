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

## 3. Billing → plan (the checkout + subscription state machine)

**Nothing here is live until you flip one switch.** The whole billing surface is
built and tested, and reads `CHECKOUT_ENABLED`, which is **OFF** unless it is
exactly `1`, `true`, `on`, `yes` or `enabled`. With it off:

- `POST /api/checkout` refuses with `checkout_disabled` and never calls Stripe;
- `POST /api/stripe-webhook` refuses with `checkout_disabled`, so **no event can
  grant or revoke access**, even a perfectly signed one.

`GET /api/checkout` answers with a readiness report (booleans and plan names, no
keys): which of the pieces below are still missing.

### The switch, after the Stripe reconnect

1. **Reconnect Stripe** on the Finance tab so the account is no longer express and
   can create subscriptions.
2. **Create three recurring prices** — Starter £19.99/month, Pro £29.99/month,
   Pro Annual £269.99/year (the amounts `/subscribe` prints; checkout refuses any
   price that disagrees with them, so a mismatch cannot be sold by accident).
3. **Save four secrets**: `STRIPE_SECRET_KEY` (`sk_…` or `rk_…`), and
   `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_ANNUAL`.
4. **Point a webhook endpoint at `https://<platform-host>/api/stripe-webhook`**
   and save its signing secret as `STRIPE_WEBHOOK_SECRET`. Use the platform host,
   not the custom domain: the domain redirects to `www`, and the signature is
   checked against the raw request body, so the target must be the host that
   terminates the request directly.
5. **Set `CHECKOUT_ENABLED=on`.** One flag turns on both checkout and the webhook.
6. `GET /api/checkout` must now say `canTakeSubscriptionPayments: true`.

### What each event does to access

| Event | Written | Access |
|---|---|---|
| `checkout.session.completed` | Stripe customer + subscription ids, plan if the price is named | **unchanged** — it links, it grants nothing (no period yet) |
| `customer.subscription.created` / `.updated`, status `active`/`trialing` | plan, status, `current_period_end` | **in** until that period end |
| … status `past_due` | status, `grace_ends_at` (first failure only) | **in** until the grace date |
| … status `canceled` | status, period end kept | **in** until the period already paid for ends (terms §8) |
| … status `unpaid` / `incomplete` / `incomplete_expired` | status | **out** |
| `customer.subscription.deleted` | status `canceled`, period end kept | **in** to the period end, then **out** |
| `invoice.paid` | status `active`, period end **extended**, grace cleared | **in** |
| `invoice.payment_failed` | status `past_due`, grace date kept from the first failure | **in** during grace; the owner is told `EMAIL DUE` |
| `charge.refunded` (full) | status `refunded`, plan and period **cleared** | **out** immediately; partial refunds change nothing |

An **unrecognised price id grants NOTHING** and alerts the owner — never a
default tier. Every event is deduplicated by its Stripe event id in
`stripe-events.json` (beside the account store, `STRIPE_EVENTS_FILE` overrides):
the same event delivered twice is applied once, so a replayed old event cannot
resurrect a cancelled subscription. Unsigned, wrong-secret and stale (>5 min)
payloads are rejected with 400 and change nothing.

`STRIPE_GRACE_DAYS` (1–30, default 7) sets how long a failed card keeps access.

## 4. Customer email (receipts and failed-card notices)

Two emails are promised by /terms and are sent by the webhook itself:
a **receipt** after `invoice.paid` (the first payment and every renewal) and a
**failed-card notice** after the first `invoice.payment_failed`, quoting the
grace end date stored on the account. Code: `src/server/customer-email.ts`
(the words) over `src/server/email-transport.ts` (the wire).

**With nothing configured, nothing is sent and nothing breaks.** The email is
composed, recorded as `unsent` in the `customer-emails` store, and the Stripe
event still answers 200 with the billing state written. That is the state today,
with billing on hold — and it is why a paying customer currently gets no receipt.

To turn sending on, save ONE secret in Settings → Secrets:

| Secret | Value |
| --- | --- |
| `EAW_EMAIL_API_KEY` | a **Resend** API key (`re_…`). A key alone implies Resend. |

Optional: `EAW_EMAIL_TRANSPORT` (`resend` \| `postmark` \| `none` — `none` turns
sending off without deleting the key) and `EAW_EMAIL_FROM` (defaults to
`Everyone's A Winner <support@everyonesawinner.uk>`). `RESEND_API_KEY` and
`POSTMARK_SERVER_TOKEN` are accepted as the key too.

**DNS is required once, in Resend, not here:** add `everyonesawinner.uk` (or the
`send.` subdomain Resend offers) as a sending domain and publish the SPF and DKIM
records Resend shows you in the domain's DNS. Until that verifies, Resend refuses
the message — the refusal is recorded as `failed` with the provider's reason, and
the owner is alerted, so the failure is visible rather than silent.

Reading back what happened: `recentCustomerEmails()` returns the log newest-last
(`sent` / `failed` / `unsent`, with the reason and the provider's message id).
A `failed` row also raises an owner alert naming the customer.

## 5. Verify

```bash
bun scripts/owner-seat-proof.ts      # owner seat cannot be claimed by a stranger
bun scripts/stripe-webhook-proof.ts  # signature checks + the subscription lifecycle
bun scripts/db-init.ts               # schema present, idempotent

# Live contract, run against each environment:
bun scripts/verify-auth-surface.ts                                  # platform host
bun scripts/verify-auth-surface.ts https://everyonesawinner.uk      # public domain (www)
```

`verify-auth-surface.ts` checks the server's answers, not the page: no token →
401, forged token → 401, a real signup's token → 200 with `subscription:false`,
owner email + wrong password → 401, an unsigned webhook → never 200. The
"owner logs in with `OWNER_PASSWORD`" line reads **SKIP** until that secret is
saved, and must read **PASS** afterwards — that one line is the proof the seat
works without handing it to a stranger. It creates one throwaway `verify-…@example.com`
account per run. Always target the canonical `www` host: the apex 308-redirects,
and a redirect across origins drops the `Authorization` header (a bogus 401).

Then in a browser: sign in as the owner → `/lay-bets` opens; sign in as an
ordinary account → the subscribe screen; forge `localStorage.eaw_session` with a
made-up token → sign-in screen, never a paid tool.

Current state, measured 2026-10-27: both hosts pass every check except the owner
line, which skips because `OWNER_PASSWORD` is not saved yet.
