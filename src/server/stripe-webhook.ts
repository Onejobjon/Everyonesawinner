/**
 * Stripe webhook → per-user subscription state.
 *
 * Without this every paying customer stays unentitled and the paywall blocks
 * people who have paid — the worst failure mode a subscription business can
 * have. This verifies Stripe's signature and then writes the billing state onto
 * the account. What "entitled" then means is decided in ONE place:
 * src/server/entitlement.ts.
 *
 * THE TERMS THIS CODE HAS TO KEEP (terms §7–§11, promised to customers):
 *   • plans auto-renew until cancelled — so a renewal (`invoice.paid`) must
 *     EXTEND the paid period, not be ignored;
 *   • cancelling stops future billing but access runs to the end of the period
 *     already paid for — so `customer.subscription.deleted` records the status
 *     and leaves the period end where it is;
 *   • a failed card gets a grace window and an email, never an instant
 *     lock-out — so `invoice.payment_failed` sets a grace end date and does NOT
 *     revoke anything. The date is stored so the email can quote it.
 *
 * WHAT WAS WRONG BEFORE (fixed 2026-11-02):
 *   • every `customer.subscription.*` event required `metadata.email`, which
 *     Stripe does not put on subscription objects, so every one was ignored;
 *   • an unrecognised price id fell back to "pro", so a Starter payment bought
 *     Pro;
 *   • no period end was ever stored, so one payment granted Pro for ever;
 *   • `invoice.paid` / `invoice.payment_failed` were not handled at all.
 *
 * Required secrets: STRIPE_WEBHOOK_SECRET (the endpoint's signing secret).
 * Required to grant anything: STRIPE_PRICE_STARTER / STRIPE_PRICE_PRO /
 * STRIPE_PRICE_ANNUAL — the price ids we actually sell. With those unset, a
 * paying customer is NOT guessed into a tier: nothing is granted and the owner
 * is alerted, because a wrong tier is a refund and an apology.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { findEmailByStripeIds, findByEmail, updateSubscription, type SubscriptionPatch } from "./users";
import { GRACE_STATUS, graceEndFrom, isFutureDate, isKnownPlan, type Plan } from "./entitlement";
import { notifyOwner } from "./notify-owner";

export function verifyStripeSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const parts = header.split(",").reduce<Record<string, string>>((acc, kv) => {
    const i = kv.indexOf("=");
    if (i > 0) acc[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    return acc;
  }, {});
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;
  // Reject anything older than 5 minutes (replay protection).
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Price → plan ────────────────────────────────────────────────────────────

/** The environment variable that carries each plan's Stripe price id. */
const PRICE_ENV: ReadonlyArray<{ env: string; plan: Plan }> = [
  { env: "STRIPE_PRICE_STARTER", plan: "starter" },
  { env: "STRIPE_PRICE_PRO", plan: "pro" },
  { env: "STRIPE_PRICE_ANNUAL", plan: "annual" },
];

/**
 * Which plan a Stripe price id is, from the environment and nowhere else.
 *
 * There is deliberately NO default. The old code ended in `?? "pro"`, so an
 * unrecognised (or newly created) price silently bought the top tier. A price
 * we cannot name is a price we do not grant.
 */
export function planFromPriceId(priceId: string | null | undefined): Plan | null {
  if (!priceId) return null;
  for (const { env, plan } of PRICE_ENV) {
    const configured = (process.env[env] || "").trim();
    if (configured && configured === priceId) return plan;
  }
  return null;
}

/** The Stripe price ids that are configured at all (for the alert text). */
function configuredPriceEnvs(): string[] {
  return PRICE_ENV.filter(({ env }) => (process.env[env] || "").trim() !== "").map(({ env }) => env);
}

// ── Reading Stripe objects (they are untyped JSON to us) ────────────────────

interface StripeEvent {
  type: string;
  data: { object: Record<string, any> };
}

type AnyObject = Record<string, any>;

/** A Stripe id, whether the API sent the string or the expanded object. */
function idOf(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object" && typeof (value as AnyObject).id === "string") {
    return (value as AnyObject).id.trim() || null;
  }
  return null;
}

function emailCandidate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function secondsToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * When the paid period ends, from wherever this event carries it.
 *
 * Stripe has moved this field around (top-level `current_period_end`, then on
 * the subscription item, and on an invoice it is the line's `period.end`), so we
 * read all the places it can be and take the LATEST: a renewal must extend the
 * period, never shorten it.
 */
export function periodEndFrom(obj: AnyObject): string | null {
  const candidates = [
    obj?.current_period_end,
    obj?.items?.data?.[0]?.current_period_end,
    obj?.lines?.data?.[0]?.period?.end,
    obj?.period_end,
    obj?.period?.end,
  ];
  let latest: number | null = null;
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c > (latest ?? 0)) latest = c;
  }
  return latest == null ? null : secondsToIso(latest);
}

/** The price id on a subscription or an invoice line. */
export function priceIdFrom(obj: AnyObject): string | null {
  return (
    idOf(obj?.items?.data?.[0]?.price) ??
    idOf(obj?.lines?.data?.[0]?.price) ??
    idOf(obj?.plan) ??
    idOf(obj?.price) ??
    null
  );
}

/**
 * Tie an event to an account.
 *
 * Order matters: the email WE put on the checkout (`metadata.email`, and
 * `client_reference_id` as the belt-and-braces copy) is tried first, because
 * that is the account the customer signed in as. Only then the address Stripe
 * collected for the card — a payer whose Stripe email differs from their
 * account email must still reach their account. Last, the stored Stripe ids,
 * which is the link that survives every later event.
 */
async function resolveAccountEmail(
  candidates: unknown[],
  ids: { customerId?: string | null; subscriptionId?: string | null },
): Promise<{ email: string | null; via: string }> {
  for (const candidate of candidates) {
    const email = emailCandidate(candidate);
    if (!email) continue;
    const found = await findByEmail(email);
    if (found) return { email: found.email, via: `email ${email}` };
  }
  const byId = await findEmailByStripeIds(ids);
  if (byId) return { email: byId, via: "stored Stripe id" };
  return { email: null, via: "no match" };
}

/** Every place this event might carry the account's email. */
function emailCandidates(obj: AnyObject): unknown[] {
  return [
    obj?.metadata?.email,
    obj?.client_reference_id,
    obj?.customer_details?.email,
    obj?.customer_email,
    obj?.subscription_details?.metadata?.email,
    obj?.billing_details?.email,
  ];
}

/** The subscription price id on this event, if it has one. */
function priceIdOf(obj: AnyObject): string | null {
  return priceIdFrom(obj) ?? idOf(obj?.metadata?.price_id);
}

// ── Writing state ───────────────────────────────────────────────────────────

/**
 * Apply a patch and shout if it did not land.
 *
 * A patch that misses (no such account) or a write that throws is the moment a
 * paying customer is silently left with nothing, so both reach the owner. The
 * throw is re-raised: serve-static answers 500, Stripe retries the event.
 */
async function applyPatch(email: string, patch: SubscriptionPatch, context: string): Promise<void> {
  let updated: boolean;
  try {
    updated = await updateSubscription(email, patch);
  } catch (e) {
    await notifyOwner(
      `${context}: writing billing state for ${email} FAILED (${String(e)}). Stripe will retry.`,
    );
    throw e;
  }
  if (!updated) {
    await notifyOwner(
      `${context}: no account exists for ${email}, so nothing was recorded. The customer may have paid for nothing — check Stripe.`,
    );
  }
}

/** Alert text for a price we cannot name. Never a guessed tier. */
async function alertUnknownPrice(priceId: string | null, context: string): Promise<void> {
  const configured = configuredPriceEnvs();
  await notifyOwner(
    `${context}: unrecognised price id ${priceId ?? "(none)"} — NOTHING was granted. ` +
      `Configured price variables: ${configured.length ? configured.join(", ") : "none"}. ` +
      `Set STRIPE_PRICE_STARTER / STRIPE_PRICE_PRO / STRIPE_PRICE_ANNUAL to the price ids you sell.`,
  );
}

// ── Events ──────────────────────────────────────────────────────────────────

/** Apply one verified Stripe event. Returns a short description for the log. */
export async function handleStripeEvent(event: StripeEvent): Promise<string> {
  const obj = (event.data?.object ?? {}) as AnyObject;
  switch (event.type) {
    // Checkout finished. This is where the ACCOUNT LINK is made: the customer
    // id and subscription id are written onto the account, so every later event
    // (which carries no email) can find it. The tier and the dates come from the
    // subscription events, which carry the price and the period end.
    case "checkout.session.completed": {
      const customerId = idOf(obj.customer);
      const subscriptionId = idOf(obj.subscription);
      const { email, via } = await resolveAccountEmail(emailCandidates(obj), {
        customerId,
        subscriptionId,
      });
      if (!email) {
        await notifyOwner(
          `Checkout completed but no account matched it (looked up by ${via}; customer ${customerId ?? "unknown"}). ` +
            `A payment may have been taken with nothing granted — check Stripe.`,
        );
        return "checkout.session.completed: no matching account, owner alerted";
      }

      const patch: SubscriptionPatch = { customerId, subscriptionId };
      const plan = planFromPriceId(priceIdOf(obj)) ?? (isKnownPlan(obj?.metadata?.plan) ? obj.metadata.plan : null);
      if (plan) patch.plan = plan;

      // A one-time payment (mode "payment") buys no subscription and therefore
      // no period. Granting it anything would be the "one payment = permanent
      // access" bug in a new costume, so it grants nothing and the owner is told.
      const mode = typeof obj.mode === "string" ? obj.mode : null;
      if (!subscriptionId) {
        await notifyOwner(
          `Checkout completed in mode "${mode ?? "unknown"}" with NO subscription (customer ${customerId ?? "unknown"}). ` +
            `Nothing was granted — a one-off payment must not buy permanent access. Handle this one by hand.`,
        );
        await applyPatch(email, patch, "checkout.session.completed");
        return `checkout.session.completed: ${email} linked, no subscription — owner alerted`;
      }

      await applyPatch(email, patch, "checkout.session.completed");
      return `checkout.session.completed: ${email} linked (customer ${customerId}, subscription ${subscriptionId})`;
    }

    // The subscription itself: status + the date the paid period ends. Also
    // covers renewals (an `updated` event carries the new period end), a plan
    // change, and cancellation.
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const deleted = event.type === "customer.subscription.deleted";
      const customerId = idOf(obj.customer);
      const subscriptionId = idOf(obj.id);
      const status =
        deleted ? "canceled" : typeof obj.status === "string" ? obj.status : null;
      const priceId = priceIdOf(obj);
      const plan = planFromPriceId(priceId);
      const periodEnd = periodEndFrom(obj);

      const { email, via } = await resolveAccountEmail(emailCandidates(obj), {
        customerId,
        subscriptionId,
      });
      if (!email) {
        await notifyOwner(
          `${event.type}: could not tie subscription ${subscriptionId ?? "unknown"} to an account (${via}). ` +
            `Nothing was recorded — check Stripe.`,
        );
        return `${event.type}: no matching account, owner alerted`;
      }

      const patch: SubscriptionPatch = { customerId, subscriptionId, status };
      if (plan) patch.plan = plan;
      if (periodEnd) patch.currentPeriodEnd = periodEnd;

      if (status && (status === "active" || status === "trialing")) {
        patch.graceEndsAt = null; // a successful payment ends any grace window
      } else if (status === GRACE_STATUS) {
        const existing = await findByEmail(email);
        patch.graceEndsAt =
          existing?.graceEndsAt && isFutureDate(existing.graceEndsAt)
            ? existing.graceEndsAt
            : graceEndFrom();
      } else if (deleted || status === "unpaid" || status === "incomplete_expired") {
        patch.graceEndsAt = null;
      }

      await applyPatch(email, patch, event.type);

      // Only shout about a price we were actually given: a cancellation carries
      // no items at all, and that is not a misconfiguration.
      if (priceId && !plan) {
        await alertUnknownPrice(priceId, event.type);
      }
      if (!periodEnd && (status === "active" || status === "trialing")) {
        await notifyOwner(
          `${event.type}: no period end on the event for ${email}, so access is NOT granted on it. ` +
            `A subscription that cannot be dated is not a paid period.`,
        );
      }
      // A cancellation is the customer's decision, not a fault: log it, do not
      // alarm. Access runs to the period end already stored (terms §8).
      return `${event.type}: ${email} → ${plan ?? "plan unchanged"}, status ${status ?? "unknown"}` +
        (periodEnd ? `, paid to ${periodEnd}` : "");
    }

    // A renewal was paid. This EXTENDS the paid period — the promise that a plan
    // renews until cancelled lives or dies here.
    case "invoice.paid": {
      const customerId = idOf(obj.customer);
      const subscriptionId = idOf(obj.subscription);
      if (!subscriptionId && !customerId) return "invoice.paid: not a subscription invoice, ignored";

      const periodEnd = periodEndFrom(obj);
      const priceId = priceIdOf(obj);
      const plan = planFromPriceId(priceId);
      const { email, via } = await resolveAccountEmail(emailCandidates(obj), {
        customerId,
        subscriptionId,
      });
      if (!email) {
        await notifyOwner(
          `invoice.paid: could not tie invoice ${idOf(obj.id) ?? "unknown"} to an account (${via}). ` +
            `A payment may have been taken with nothing recorded — check Stripe.`,
        );
        return "invoice.paid: no matching account, owner alerted";
      }

      const patch: SubscriptionPatch = {
        customerId,
        subscriptionId,
        status: "active",
        graceEndsAt: null,
      };
      if (plan) patch.plan = plan;
      if (periodEnd) patch.currentPeriodEnd = periodEnd;

      await applyPatch(email, patch, "invoice.paid");
      if (priceId && !plan) await alertUnknownPrice(priceId, "invoice.paid");
      if (!periodEnd) {
        await notifyOwner(
          `invoice.paid: no period end on invoice ${idOf(obj.id) ?? "unknown"} for ${email} — the paid period was not extended.`,
        );
      }
      return `invoice.paid: ${email} renewed${periodEnd ? ` to ${periodEnd}` : ""}`;
    }

    // A renewal failed. NOT a revocation: the customer keeps access until the
    // grace end date, which is stored here so the email can quote it (terms §9).
    case "invoice.payment_failed": {
      const customerId = idOf(obj.customer);
      const subscriptionId = idOf(obj.subscription);
      const { email, via } = await resolveAccountEmail(emailCandidates(obj), {
        customerId,
        subscriptionId,
      });
      if (!email) {
        await notifyOwner(
          `invoice.payment_failed: could not tie invoice ${idOf(obj.id) ?? "unknown"} to an account (${via}).`,
        );
        return "invoice.payment_failed: no matching account, owner alerted";
      }

      // Keep the FIRST grace end date: Stripe retries a failed card several
      // times, and recomputing on every retry would extend the window for ever
      // and move the date the customer was told.
      const existing = await findByEmail(email);
      const alreadyInGrace = !!existing?.graceEndsAt && isFutureDate(existing.graceEndsAt);
      const graceEndsAt = alreadyInGrace ? existing!.graceEndsAt : graceEndFrom();

      await applyPatch(
        email,
        { customerId, subscriptionId, status: GRACE_STATUS, graceEndsAt },
        "invoice.payment_failed",
      );

      if (!alreadyInGrace) {
        await notifyOwner(
          `Card failed for ${email} — access continues on grace until ${graceEndsAt}. ` +
            `A customer email quoting that date is still to be sent.`,
        );
      }
      return `invoice.payment_failed: ${email} in grace until ${graceEndsAt}`;
    }

    default:
      return `${event.type}: ignored`;
  }
}
