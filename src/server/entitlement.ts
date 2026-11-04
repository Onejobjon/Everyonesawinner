/**
 * THE ONE ENTITLEMENT RULE.
 *
 * WHY THIS FILE EXISTS (2026-11-02). Entitlement used to be `plan` on the user
 * record, with no end date stored anywhere. That meant a single payment — or a
 * Stripe event replayed a year later — granted Pro for ever, and the terms now
 * promise the opposite: a plan auto-renews until cancelled, a cancelled plan
 * runs to the end of the period already paid for, and a failed card gets a
 * grace window before anything locks. A boolean cannot express any of that.
 *
 * So there is exactly one function, `isEntitled()`, and every gate uses it:
 *   • `GET /api/me` (serve-static.ts) — what the browser is told;
 *   • `requireProSession()` / `requirePaidSession()` (pro-gate.ts) — the
 *     server-side locks on the credit-spending endpoints.
 * The browser never decides: it renders what /api/me says (src/lib/auth.tsx).
 *
 * THE RULE, in words:
 *   entitled = the plan is one we sell
 *              AND the subscription is active (or trialing)
 *              AND the paid period has not ended
 *            OR the subscription was cancelled and the period already paid for
 *               has not ended (terms §8: cancelling does not end the plan on the
 *               spot)
 *            OR the subscription is in the failed-payment grace window and the
 *               grace end date has not passed
 *            OR this is the owner's comped seat (no subscription, no period).
 *
 * A missing or unparseable period end is NOT "forever" — it is not entitled.
 * Fail closed: an account whose paid period we cannot date is an account we
 * cannot say has paid.
 *
 * FREE-ACCESS COMPS (owner request, 2026-11-02: "How can I give someone free use
 * of the site? I need to get feedback from a human new to match betting."). A
 * named person can be granted a plan without paying — a trialist, a reviewer, a
 * friend. The grant is a `CompState` on the account record and it follows the
 * same discipline as a paid period:
 *   • it is DATED — access ends when the end date passes;
 *   • an UNDATED comp must say so explicitly (`permanent: true`), so "no end
 *     date" is a decision somebody made, never a field somebody forgot;
 *   • it is REVOCABLE — clearing the comp removes access on the next request;
 *   • an unknown plan, or a comp we cannot date, grants nothing.
 * Everything else still fails closed.
 */

export type Plan = "starter" | "pro" | "annual";

/** The plans we actually sell. Anything else on a record grants nothing. */
export const KNOWN_PLANS: readonly Plan[] = ["starter", "pro", "annual"];

/** Stripe statuses that mean "paid up right now". */
export const ACTIVE_STATUSES: readonly string[] = ["active", "trialing"];

/**
 * Statuses that still have access UNTIL THE PERIOD ALREADY PAID FOR ENDS.
 *
 * WHY (2026-11-03): terms §8 promises that cancelling "does not end the plan on
 * the spot: your access continues to the end of the period you have already paid
 * for". Before this, any `canceled` status was an instant lock-out, so a customer
 * who cancelled on day 2 of a month lost 28 days they had paid for — the code
 * contradicted the page. The date is what governs: once `currentPeriodEnd` has
 * passed, the same status grants nothing.
 *
 * A REFUND is not in this list: `charge.refunded` clears the plan and the period,
 * because money that has gone back must not keep buying days.
 */
export const CANCELED_STATUSES: readonly string[] = ["canceled", "canceled_at_period_end"];

/** Status used while a failed renewal is being retried (see GRACE below). */
export const GRACE_STATUS = "past_due";

/**
 * How long access survives a failed renewal. The terms (§9) promise a grace
 * period and that the email we send quotes the date it ends; they do not print
 * a number, so this is the number. `STRIPE_GRACE_DAYS` overrides it (1–30).
 */
export function graceDays(): number {
  const raw = Number(process.env.STRIPE_GRACE_DAYS);
  if (!Number.isFinite(raw) || raw <= 0) return 7;
  return Math.min(30, Math.max(1, Math.floor(raw)));
}

/** The grace end date for a failure noticed now (ISO 8601, UTC). */
export function graceEndFrom(nowMs: number = Date.now()): string {
  return new Date(nowMs + graceDays() * 24 * 60 * 60 * 1000).toISOString();
}

export function isKnownPlan(value: unknown): value is Plan {
  return typeof value === "string" && (KNOWN_PLANS as readonly string[]).includes(value);
}

/** True only for a date we can parse that is strictly in the future. */
export function isFutureDate(value: unknown, nowMs: number = Date.now()): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  const t = Date.parse(value);
  return Number.isFinite(t) && t > nowMs;
}

/**
 * A free-access grant ("comp") on an account — no payment, no subscription.
 *
 * `endsAt` is the date access stops. `permanent` is the ONLY way to say "no end
 * date": an undated comp with `permanent` absent grants NOTHING, because a
 * missing field is not a decision. Both are checked by compGrants() below.
 */
export interface CompState {
  /** The plan this grant unlocks (pro => the Pro-only tools too). */
  plan: Plan;
  /** When the free access stops (ISO 8601). null only with `permanent: true`. */
  endsAt: string | null;
  /** Explicit "runs until it is revoked" — required when endsAt is null. */
  permanent?: boolean;
  /** Why this person has it, in the owner's words. */
  note?: string;
  /** Which owner account granted it. */
  grantedBy?: string;
  /** When it was granted (ISO 8601). */
  grantedAt?: string;
}

/**
 * Does this comp grant access right now? Fail closed: an unknown plan, a comp
 * that is missing, or an undated comp that was not explicitly made permanent
 * all answer NO.
 */
export function compGrants(comp: CompState | null | undefined, nowMs: number = Date.now()): boolean {
  if (!comp || !isKnownPlan(comp.plan)) return false;
  if (comp.permanent === true) return true;
  return isFutureDate(comp.endsAt, nowMs);
}

/** Everything the rule needs — the same shape on the JSON and Postgres paths. */
export interface SubscriptionState {
  plan: Plan | null;
  status: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  /** The owner's comped seat: no subscription, no period, always entitled. */
  ownerSeat?: boolean;
  /** A named person's free-access grant, if any (see CompState). */
  comp?: CompState | null;
}

/**
 * THE RULE. Pass `nowMs` in tests to move the clock instead of waiting.
 */
export function isEntitled(state: SubscriptionState, nowMs: number = Date.now()): boolean {
  if (state.ownerSeat) return true;
  // A free-access grant is checked on its own terms (see compGrants): dated, or
  // explicitly undated. It is not a "plan with no period", which would fail.
  if (compGrants(state.comp, nowMs)) return true;
  if (!isKnownPlan(state.plan)) return false;
  const status = state.status ?? "";
  if (ACTIVE_STATUSES.includes(status) && isFutureDate(state.currentPeriodEnd, nowMs)) {
    return true;
  }
  // Cancelled, but inside the period that was already paid for (terms §8).
  if (CANCELED_STATUSES.includes(status) && isFutureDate(state.currentPeriodEnd, nowMs)) {
    return true;
  }
  if (status === GRACE_STATUS && isFutureDate(state.graceEndsAt, nowMs)) {
    return true;
  }
  return false;
}

/** Entitled AND on a plan that unlocks the Pro-only tools. */
export function isProEntitled(state: SubscriptionState, nowMs: number = Date.now()): boolean {
  if (!isEntitled(state, nowMs)) return false;
  if (state.plan === "pro" || state.plan === "annual") return true;
  // A live comp on a Pro plan unlocks the Pro tools even if the record's own
  // plan field says otherwise (a comped Pro on top of an old Starter plan).
  return compGrants(state.comp, nowMs) && (state.comp?.plan === "pro" || state.comp?.plan === "annual");
}

/** Entitled AND on any paid plan (Starter and above). */
export function isPaidEntitled(state: SubscriptionState, nowMs: number = Date.now()): boolean {
  return isEntitled(state, nowMs) && isKnownPlan(state.plan);
}
