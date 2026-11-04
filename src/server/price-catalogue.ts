/**
 * The three plans we sell, what they cost, and which Stripe price id carries each.
 *
 * WHY THIS IS ITS OWN FILE (2026-11-03): checkout has to refuse to sell a price
 * that contradicts the page, and the webhook has to refuse to grant a tier it
 * cannot name. Both need the same table. Two copies of "starter = £19.99/month"
 * is how a £19.99 payment buys Pro.
 *
 * The amounts and intervals here are the OWNER'S decisions (2026-10-28) and they
 * are what /subscribe prints:
 *   Starter £19.99 a month, Pro £29.99 a month, Pro Annual £269.99 a year.
 * Nothing in this file may drift from that page, and checkout REFUSES to create a
 * session whose Stripe price disagrees with it (see checkout.ts). It never
 * silently "corrects" either side.
 */
import type { Plan } from "./entitlement";

export type BillingInterval = "month" | "year";

export interface PublishedPlan {
  plan: Plan;
  /** How the plan is named to a human. */
  label: string;
  /** The price in pence — exactly what /subscribe prints. */
  amountPence: number;
  /** How often that amount is taken. */
  interval: BillingInterval;
  /** The environment variable carrying this plan's Stripe price id. */
  env: string;
}

export const PUBLISHED_PLANS: Readonly<Record<Plan, PublishedPlan>> = {
  starter: {
    plan: "starter",
    label: "Starter",
    amountPence: 1999,
    interval: "month",
    env: "STRIPE_PRICE_STARTER",
  },
  pro: {
    plan: "pro",
    label: "Pro",
    amountPence: 2999,
    interval: "month",
    env: "STRIPE_PRICE_PRO",
  },
  annual: {
    plan: "annual",
    label: "Pro Annual",
    amountPence: 26999,
    interval: "year",
    env: "STRIPE_PRICE_ANNUAL",
  },
};

export const PLAN_ORDER: readonly Plan[] = ["starter", "pro", "annual"];

/**
 * Which plan a Stripe price id is, from the environment and nowhere else.
 *
 * There is deliberately NO default. An earlier version ended in `?? "pro"`, so an
 * unrecognised (or newly created) price silently bought the top tier. A price we
 * cannot name is a price we do not grant.
 */
export function planFromPriceId(priceId: string | null | undefined): Plan | null {
  if (!priceId) return null;
  for (const plan of PLAN_ORDER) {
    const configured = (process.env[PUBLISHED_PLANS[plan].env] || "").trim();
    if (configured && configured === priceId) return plan;
  }
  return null;
}

/** The Stripe price id we sell for this plan, or null when it is not configured. */
export function priceIdForPlan(plan: Plan): string | null {
  const id = (process.env[PUBLISHED_PLANS[plan].env] || "").trim();
  return id || null;
}

/** The price variables that are configured at all (for alert/readiness text). */
export function configuredPriceEnvs(): string[] {
  return PLAN_ORDER.map((p) => PUBLISHED_PLANS[p].env).filter(
    (env) => (process.env[env] || "").trim() !== "",
  );
}

/** £19.99 from 1999 — for messages that quote a real amount. */
export function formatPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}
