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
 *            OR the subscription is in the failed-payment grace window and the
 *               grace end date has not passed
 *            OR this is the owner's comped seat (no subscription, no period).
 *
 * A missing or unparseable period end is NOT "forever" — it is not entitled.
 * Fail closed: an account whose paid period we cannot date is an account we
 * cannot say has paid.
 */

export type Plan = "starter" | "pro" | "annual";

/** The plans we actually sell. Anything else on a record grants nothing. */
export const KNOWN_PLANS: readonly Plan[] = ["starter", "pro", "annual"];

/** Stripe statuses that mean "paid up right now". */
export const ACTIVE_STATUSES: readonly string[] = ["active", "trialing"];

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

/** Everything the rule needs — the same shape on the JSON and Postgres paths. */
export interface SubscriptionState {
  plan: Plan | null;
  status: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  /** The owner's comped seat: no subscription, no period, always entitled. */
  ownerSeat?: boolean;
}

/**
 * THE RULE. Pass `nowMs` in tests to move the clock instead of waiting.
 */
export function isEntitled(state: SubscriptionState, nowMs: number = Date.now()): boolean {
  if (state.ownerSeat) return true;
  if (!isKnownPlan(state.plan)) return false;
  if (ACTIVE_STATUSES.includes(state.status ?? "") && isFutureDate(state.currentPeriodEnd, nowMs)) {
    return true;
  }
  if (state.status === GRACE_STATUS && isFutureDate(state.graceEndsAt, nowMs)) {
    return true;
  }
  return false;
}

/** Entitled AND on a plan that unlocks the Pro-only tools. */
export function isProEntitled(state: SubscriptionState, nowMs: number = Date.now()): boolean {
  if (!isEntitled(state, nowMs)) return false;
  return state.plan === "pro" || state.plan === "annual";
}

/** Entitled AND on any paid plan (Starter and above). */
export function isPaidEntitled(state: SubscriptionState, nowMs: number = Date.now()): boolean {
  return isEntitled(state, nowMs) && isKnownPlan(state.plan);
}
