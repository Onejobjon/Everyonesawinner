/**
 * CANCELLING YOUR OWN SUBSCRIPTION (2026-11-08).
 *
 * WHY THIS EXISTS. The terms we publish (terms §8) promise two things the product
 * could not do: "you can cancel at any time" and "cancelling does not end the plan
 * on the spot — your access continues to the end of the period you have already
 * paid for". Before this file, the only way to cancel was to email the owner and
 * have him do it by hand. The moment a payment can be taken, that gap is both a
 * customer-service failure and a consumer-law exposure.
 *
 * WHAT IS CANCELLED, EXACTLY. There is no new record and no second copy of the
 * truth. The account record (StoredUser, src/server/users.ts) already holds the
 * plan, the status and `currentPeriodEnd`, and `isEntitled()` in
 * src/server/entitlement.ts already keeps access for a `canceled` status until
 * the paid period ends. Cancelling is therefore ONE FIELD:
 *
 *     subscriptionStatus: "active"  →  "canceled_at_period_end"
 *
 * ("canceled_at_period_end" is in CANCELED_STATUSES, which entitlement.ts has
 * honoured since 2026-11-03.) `currentPeriodEnd` is NOT touched — that date is
 * the promise. `canceledAt` records when they asked, for the page's own wording,
 * and decides nothing.
 *
 * RESUMING is the same field going back to "active", which is why it is possible
 * right up to the last minute: nothing has been torn down.
 *
 * THE STRIPE HALF. When there is a real Stripe subscription, the customer's
 * decision has to reach Stripe too — otherwise Stripe keeps the renewal and would
 * charge a card we have told the customer would not be charged. That call lives
 * in `stripeSubscriptionClient()` below, behind the `SubscriptionBillingClient`
 * interface, so this whole flow can be built and tested with no Stripe key: the
 * `noStripeClient()` implementation reports honestly that it changed nothing at a
 * payment provider, and the local record still does the right thing.
 *
 * ⚠️ THE LINE THAT NEEDS THE LIVE KEY — for a real subscription to stop renewing
 * for real, this exact request must run against Stripe:
 *
 *     subscription.ts → stripeSubscriptionClient().setCancelAtPeriodEnd()
 *       → fetchImpl(`${STRIPE_API_BASE}/subscriptions/${id}`, { method: "POST",
 *           body: "cancel_at_period_end=true" })
 *
 * It is reached only when `STRIPE_SECRET_KEY` is set AND the account carries a
 * `stripeSubscriptionId`. With either missing, no request is made, nothing is
 * claimed about a payment provider, and `stripe.changed` is false.
 */
import { STRIPE_API_BASE } from "./checkout";
import {
  CANCELED_STATUSES,
  GRACE_STATUS,
  isFutureDate,
  isKnownPlan,
  type Plan,
} from "./entitlement";
import { PUBLISHED_PLANS, formatPence } from "./price-catalogue";
import { findByEmail, updateSubscription, type PublicUser } from "./users";

/* ------------------------------------------------------------------ *
 * The Stripe interface (real call implemented, exercised by tests)
 * ------------------------------------------------------------------ */

export interface BillingClientOutcome {
  ok: boolean;
  /** Human-readable reason when ok is false. */
  message?: string;
}

/**
 * The ONE thing this feature asks of a payment provider: "stop renewing at the
 * end of the period already paid for" — and the reverse, "carry on renewing".
 *
 * Deliberately tiny. Cancelling a subscription must never mean "delete the
 * customer", "refund them" or "cut access now", so the interface has no way to
 * express any of those.
 */
export interface SubscriptionBillingClient {
  /** True only when this client can actually reach a payment provider. */
  readonly live: boolean;
  /**
   * Set `cancel_at_period_end` on one Stripe subscription. `true` stops the
   * renewal, `false` puts it back. Returns ok:false rather than throwing, so the
   * caller can tell the customer the truth instead of a stack trace.
   */
  setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean): Promise<BillingClientOutcome>;
}

/**
 * A client that reaches nothing, and says so.
 *
 * `reason` is shown to the owner in the log and (in plainer words) is what makes
 * `stripe.changed === false` on the API response — never a claim that Stripe was
 * told something it was not.
 */
export function noStripeClient(reason: string): SubscriptionBillingClient {
  return {
    live: false,
    async setCancelAtPeriodEnd() {
      return { ok: false, message: reason };
    },
  };
}

/**
 * The real Stripe call.
 *
 * `POST /v1/subscriptions/{id}` with `cancel_at_period_end=true|false` is the
 * documented way to stop a renewal without ending the subscription: Stripe keeps
 * the subscription (and the customer's access) alive until the current period
 * ends, then cancels it and fires `customer.subscription.deleted`, which
 * src/server/stripe-webhook.ts turns into a final `canceled` status.
 */
export function stripeSubscriptionClient(
  secretKey: string,
  fetchImpl: typeof fetch = fetch,
): SubscriptionBillingClient {
  return {
    live: true,
    async setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean): Promise<BillingClientOutcome> {
      let res: Response;
      try {
        res = await fetchImpl(
          `${STRIPE_API_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${secretKey}`,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: `cancel_at_period_end=${cancel ? "true" : "false"}`,
          },
        );
      } catch (e) {
        return {
          ok: false,
          message: `Could not reach Stripe to change the renewal (${String(e)}).`,
        };
      }
      let body: { error?: { message?: string; code?: string } } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        body = {};
      }
      if (!res.ok) {
        const detail = body?.error?.message || body?.error?.code || `HTTP ${res.status}`;
        return { ok: false, message: `Stripe refused the change (${detail}).` };
      }
      return { ok: true };
    },
  };
}

/**
 * Which client applies to this account, from the environment and nowhere else.
 *
 * No key, or no Stripe subscription on the record ⇒ the inert client. That is the
 * state of the whole business today (checkout is inert, no money has ever moved),
 * and it must not look like a failure: it means "there is no payment provider
 * relationship to change", which the customer-facing copy says in plain words.
 */
export function billingClientFor(
  account: Pick<PublicUser, "stripeSubscriptionId" | "subscriptionStatus">,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): SubscriptionBillingClient {
  const secret = (env.STRIPE_SECRET_KEY || "").trim();
  const subscriptionId = (account.stripeSubscriptionId || "").trim();
  if (!secret) return noStripeClient("STRIPE_SECRET_KEY is not set");
  if (!subscriptionId) return noStripeClient("this account has no Stripe subscription id");
  return stripeSubscriptionClient(secret, fetchImpl);
}

/* ------------------------------------------------------------------ *
 * What the account page is shown — derived, never stored twice
 * ------------------------------------------------------------------ */

/**
 * The states the account page can be in. One of these, never a guess.
 *
 *  none     no paid plan and no free access — nothing to cancel
 *  comp     free access granted by the owner — nothing is being paid
 *  owner    the owner's own seat — never paid for
 *  renewing an active paid plan that WILL renew
 *  ending   cancelled: access runs to `accessEndsAt`, then stops
 *  past_due a renewal failed; access continues to the grace end date
 *  ended    a plan is on the record but the period has run out
 */
export type SubscriptionStateName =
  | "none"
  | "comp"
  | "owner"
  | "renewing"
  | "ending"
  | "past_due"
  | "ended";

export interface SubscriptionView {
  email: string;
  state: SubscriptionStateName;
  /** The plan we sell, or null when there is none. */
  plan: Plan | null;
  planLabel: string | null;
  /** Exactly the amount and interval /subscribe prints, in pence. */
  pricePence: number | null;
  priceInterval: "month" | "year" | null;
  /** "£29.99 a month" — the same words the pricing page uses. */
  priceText: string | null;
  /** Does this plan renew on its own? False once it is ending, ended or comped. */
  renews: boolean;
  /** May this account use the paid tools right now (the one entitlement rule)? */
  entitled: boolean;
  /** When the paid period ends (ISO), or null. */
  currentPeriodEnd: string | null;
  /** When access actually stops (ISO). Same as the period end, or a grace date. */
  accessEndsAt: string | null;
  /** When the customer asked to stop renewing (ISO), or null. */
  canceledAt: string | null;
  /** A free-access grant, if this account has one. */
  comp: {
    plan: Plan;
    endsAt: string | null;
    permanent: boolean;
    note: string | null;
  } | null;
  /** A pending cancellation can be undone (reversible until access ends). */
  canResume: boolean;
  /** There is a renewal here that the customer may stop. */
  canCancel: boolean;
  /**
   * Set when this account IS linked to a payment provider we cannot reach. We
   * then refuse to record a cancellation or a resume, because doing so would
   * describe a change at Stripe that has not happened — and a customer who was
   * told "you won't be charged again" while Stripe keeps the renewal is the one
   * failure this feature must never produce.
   */
  providerBlockedReason: string | null;
  /**
   * Did we actually tell a payment provider? False means the change is recorded
   * on our side only — honest wording, because today no card is connected.
   */
  stripe: {
    /** A Stripe subscription id exists on the account. */
    hasSubscription: boolean;
    /** A key is configured, so a real request can be made. */
    configured: boolean;
    /** True only when a real request succeeded during this call. */
    changed: boolean;
  };
}

function planLabel(plan: Plan | null): string | null {
  return plan ? PUBLISHED_PLANS[plan].label : null;
}

function priceText(plan: Plan | null): string | null {
  if (!plan) return null;
  const published = PUBLISHED_PLANS[plan];
  return `${formatPence(published.amountPence)} ${published.interval === "year" ? "a year" : "a month"}`;
}

function compView(account: PublicUser): SubscriptionView["comp"] {
  const comp = account.comp;
  if (!comp || !isKnownPlan(comp.plan)) return null;
  return {
    plan: comp.plan,
    endsAt: comp.endsAt ?? null,
    permanent: comp.permanent === true,
    note: comp.note ?? null,
  };
}

/**
 * Build the account page's answer from the ONE record.
 *
 * `stripe` is passed in rather than derived so a POST can report what it actually
 * did, and a GET can report what is merely possible.
 */
export function subscriptionView(
  account: PublicUser,
  opts: {
    nowMs?: number;
    /** Override the "did we just tell Stripe" flag (POST responses). */
    stripeChanged?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): SubscriptionView {
  const nowMs = opts.nowMs ?? Date.now();
  const env = opts.env ?? process.env;
  const status = (account.subscriptionStatus || "").trim();
  const plan = isKnownPlan(account.plan) ? account.plan : null;
  const comp = compView(account);
  const configured = !!(env.STRIPE_SECRET_KEY || "").trim();
  const hasSubscription = !!(account.stripeSubscriptionId || "").trim();
  /**
   * A subscription id with no key is the one state where we must NOT act: the
   * customer's plan really is linked to Stripe, and we cannot tell Stripe
   * anything. Recording a cancellation here would promise "no further payment"
   * while Stripe went on renewing. Refuse, and say who can do it instead.
   */
  const providerBlockedReason =
    hasSubscription && !configured
      ? "Your plan is linked to a subscription at our payment provider and this deployment cannot reach it, " +
        "so we will not record a change we cannot pass on. Email support@everyonesawinner.uk and we will cancel it for you the same day."
      : null;
  const providerOk = providerBlockedReason === null;

  const base = {
    email: account.email,
    plan,
    planLabel: planLabel(plan),
    pricePence: plan ? PUBLISHED_PLANS[plan].amountPence : null,
    priceInterval: plan ? PUBLISHED_PLANS[plan].interval : null,
    priceText: priceText(plan),
    entitled: account.entitled,
    currentPeriodEnd: account.currentPeriodEnd ?? null,
    canceledAt: account.canceledAt ?? null,
    comp,
    providerBlockedReason,
    stripe: {
      hasSubscription,
      configured,
      changed: opts.stripeChanged === true,
    },
  };

  // The owner's own seat is never paid for and never cancelled.
  if (account.owner) {
    return {
      ...base,
      state: "owner",
      renews: false,
      accessEndsAt: null,
      canCancel: false,
      canResume: false,
    };
  }

  // A live free-access grant speaks for the account (stateOf() in users.ts).
  if (comp && (status === "comp" || !plan)) {
    return {
      ...base,
      state: "comp",
      renews: false,
      accessEndsAt: comp.permanent ? null : comp.endsAt,
      canCancel: false,
      canResume: false,
    };
  }

  if (!plan) {
    return {
      ...base,
      state: "none",
      renews: false,
      accessEndsAt: null,
      canCancel: false,
      canResume: false,
    };
  }

  const periodEndLive = isFutureDate(account.currentPeriodEnd, nowMs);

  if (CANCELED_STATUSES.includes(status)) {
    return {
      ...base,
      state: periodEndLive ? "ending" : "ended",
      renews: false,
      accessEndsAt: periodEndLive ? (account.currentPeriodEnd ?? null) : null,
      // Reversible right up to the moment access ends — the terms allow it.
      canCancel: false,
      canResume: periodEndLive && providerOk,
    };
  }

  if (status === GRACE_STATUS) {
    const graceLive = isFutureDate(account.graceEndsAt, nowMs);
    return {
      ...base,
      state: graceLive ? "past_due" : "ended",
      renews: graceLive,
      accessEndsAt: graceLive ? (account.graceEndsAt ?? null) : null,
      // A failing card is still a live subscription: stopping it is allowed.
      canCancel: graceLive && providerOk,
      canResume: false,
    };
  }

  if (periodEndLive) {
    return {
      ...base,
      state: "renewing",
      renews: true,
      accessEndsAt: account.currentPeriodEnd ?? null,
      canCancel: providerOk,
      canResume: false,
    };
  }

  return {
    ...base,
    state: "ended",
    renews: false,
    accessEndsAt: null,
    canCancel: false,
    canResume: false,
  };
}

/* ------------------------------------------------------------------ *
 * The two actions
 * ------------------------------------------------------------------ */

export interface SubscriptionActionDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  /** Test seam: notified when a write fails after Stripe was changed. */
  notifyOwner?: (message: string) => Promise<void> | void;
}

export interface SubscriptionActionResult {
  ok: boolean;
  /** HTTP status the route should send. */
  status: number;
  /** Machine-readable refusal code (never a substitute for the message). */
  code?: string;
  /** Plain English for the customer. */
  message?: string;
  /** The state AFTER the action, so the page can quote the date it just set. */
  subscription?: SubscriptionView;
}

function refusal(status: number, code: string, message: string, subscription?: SubscriptionView): SubscriptionActionResult {
  return { ok: false, status, code, message, subscription };
}

/**
 * STOP RENEWING, BUT KEEP THE DAYS ALREADY PAID FOR.
 *
 * Order matters and is deliberate: Stripe FIRST, our record second.
 *  - If Stripe refuses, nothing is written, because telling a customer "you have
 *    cancelled" while a card is still due to be charged is the worst outcome
 *    available.
 *  - If Stripe succeeds and our write then fails, the renewal really is stopped
 *    (no charge), and the owner is told so it can be reconciled — the customer is
 *    told the truth too.
 *
 * Idempotent: cancelling an already-cancelled subscription changes nothing and
 * makes no second Stripe call.
 */
export async function cancelSubscription(
  email: string,
  deps: SubscriptionActionDeps = {},
): Promise<SubscriptionActionResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const account = await findByEmail(email);
  if (!account) {
    return refusal(404, "account_not_found", "We could not find that account.");
  }

  const before = subscriptionView(account, { nowMs, env });

  if (!before.canCancel) {
    if (before.state === "ending") {
      // Already cancelled: say so with the date, rather than an error.
      return { ok: true, status: 200, subscription: before, message: "This subscription is already cancelled." };
    }
    if (before.providerBlockedReason) {
      // The plan really is linked to Stripe and we cannot reach it: refuse
      // rather than promise "no further payment" we cannot deliver.
      return refusal(503, "provider_unreachable", before.providerBlockedReason, before);
    }
    if (before.state === "comp" || before.state === "owner") {
      return refusal(
        409,
        "nothing_to_cancel",
        "You have free access, so there is no payment to cancel and no renewal to stop. " +
          "You have not paid anything.",
        before,
      );
    }
    return refusal(
      409,
      "nothing_to_cancel",
      "There is no active subscription on this account, so there is no renewal to stop. " +
        "You have not paid anything.",
      before,
    );
  }

  // 1. The payment provider (a no-op that reports honestly when there is none).
  const client = billingClientFor(account, env, fetchImpl);
  let stripeChanged = false;
  if (client.live) {
    const outcome = await client.setCancelAtPeriodEnd(account.stripeSubscriptionId!.trim(), true);
    if (!outcome.ok) {
      return refusal(
        502,
        "stripe_refused",
        `We could not stop the renewal yet, so your subscription is unchanged and nothing has been cancelled. ` +
          `${outcome.message ?? ""} Please try again, or email support@everyonesawinner.uk and we will do it for you.`,
        before,
      );
    }
    stripeChanged = true;
  }

  // 2. Our record — the one that decides access.
  try {
    await updateSubscription(account.email, {
      status: "canceled_at_period_end",
      canceledAt: new Date(nowMs).toISOString(),
    });
  } catch (e) {
    const message =
      "Your renewal has been stopped, but we could not save that on your account. " +
      "No further payment will be taken, and access ends on the date shown. " +
      "Please email support@everyonesawinner.uk so we can confirm it.";
    console.error(`[subscription] cancel: Stripe changed but the account write failed for ${account.email}: ${String(e)}`);
    try {
      await deps.notifyOwner?.(
        `CANCEL PARTIALLY APPLIED — ${account.email}: Stripe has cancel_at_period_end=true but the account write failed (${String(e)}). The record still says it renews; the customer has been told the renewal is stopped.`,
      );
    } catch {
      /* the owner alert is best-effort; the customer's answer is not */
    }
    return refusal(500, "save_failed", message, before);
  }

  const after = await findByEmail(account.email);
  return {
    ok: true,
    status: 200,
    subscription: after ? subscriptionView(after, { nowMs, env, stripeChanged }) : undefined,
  };
}

/**
 * UNDO A PENDING CANCELLATION — allowed any time before access ends.
 *
 * A resume after the period has ended is refused: there is nothing left to
 * resume, and silently re-charging a card to "resume" would be a new purchase
 * the customer never agreed to. They are pointed at /subscribe instead.
 */
export async function resumeSubscription(
  email: string,
  deps: SubscriptionActionDeps = {},
): Promise<SubscriptionActionResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const account = await findByEmail(email);
  if (!account) {
    return refusal(404, "account_not_found", "We could not find that account.");
  }

  const before = subscriptionView(account, { nowMs, env });

  if (before.state === "renewing") {
    // Already renewing: nothing to undo, and no provider call.
    return { ok: true, status: 200, subscription: before, message: "This subscription is already renewing." };
  }
  if (before.state === "ended") {
    return refusal(
      409,
      "period_ended",
      "That plan has already ended, so there is no renewal to turn back on. " +
        "You can choose a plan again at any time from the pricing page.",
      before,
    );
  }
  if (before.providerBlockedReason && before.state === "ending") {
    return refusal(503, "provider_unreachable", before.providerBlockedReason, before);
  }
  if (!before.canResume) {
    return refusal(
      409,
      "nothing_to_resume",
      "There is no pending cancellation on this account.",
      before,
    );
  }

  const client = billingClientFor(account, env, fetchImpl);
  let stripeChanged = false;
  if (client.live) {
    const outcome = await client.setCancelAtPeriodEnd(account.stripeSubscriptionId!.trim(), false);
    if (!outcome.ok) {
      return refusal(
        502,
        "stripe_refused",
        `We could not turn the renewal back on yet, so your cancellation still stands and no further payment will be taken. ` +
          `${outcome.message ?? ""} Please try again, or email support@everyonesawinner.uk.`,
        before,
      );
    }
    stripeChanged = true;
  }

  try {
    await updateSubscription(account.email, { status: "active", canceledAt: null });
  } catch (e) {
    console.error(`[subscription] resume: the account write failed for ${account.email}: ${String(e)}`);
    return refusal(
      500,
      "save_failed",
      "We could not save that change, so your cancellation still stands. Please try again in a moment.",
      before,
    );
  }

  const after = await findByEmail(account.email);
  return {
    ok: true,
    status: 200,
    subscription: after ? subscriptionView(after, { nowMs, env, stripeChanged }) : undefined,
  };
}
