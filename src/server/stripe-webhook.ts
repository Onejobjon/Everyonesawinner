/**
 * Stripe webhook → per-user subscription status.
 *
 * Without this every paying customer stays subscription:false and the paywall
 * blocks people who have paid — the worst failure mode a subscription business
 * can have. This verifies Stripe's signature and then writes the plan onto the
 * account with setPlan().
 *
 * Required secrets: STRIPE_WEBHOOK_SECRET (from the Stripe dashboard endpoint).
 * Optional: STRIPE_PRICE_STARTER / STRIPE_PRICE_PRO / STRIPE_PRICE_ANNUAL to map
 * price ids to tiers; otherwise the price's metadata.plan is used, then "pro".
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { setPlan } from "./users";

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

function planFromPriceId(priceId: string | undefined): "starter" | "pro" | "annual" | null {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_STARTER) return "starter";
  if (priceId === process.env.STRIPE_PRICE_ANNUAL) return "annual";
  if (priceId === process.env.STRIPE_PRICE_PRO) return "pro";
  return null;
}

interface StripeEvent {
  type: string;
  data: { object: Record<string, any> };
}

/** Apply one verified Stripe event. Returns a short description for the log. */
export async function handleStripeEvent(event: StripeEvent): Promise<string> {
  const obj = event.data?.object ?? {};
  switch (event.type) {
    case "checkout.session.completed": {
      const email = (obj.customer_details?.email || obj.customer_email || "").toLowerCase();
      const subscriptionId = typeof obj.subscription === "string" ? obj.subscription : null;
      const plan = planFromPriceId(obj.metadata?.price_id) ?? (obj.metadata?.plan as never) ?? "pro";
      if (!email) return "checkout.session.completed: no email, ignored";
      await setPlan(email, plan, subscriptionId ? "active" : null, {
        customerId: typeof obj.customer === "string" ? obj.customer : null,
        subscriptionId,
      });
      return `checkout.session.completed: ${email} → ${plan}`;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const email = (obj.metadata?.email || obj.customer_email || "").toLowerCase();
      const priceId = obj.items?.data?.[0]?.price?.id;
      const plan = planFromPriceId(priceId) ?? (obj.metadata?.plan as never) ?? "pro";
      const status = typeof obj.status === "string" ? obj.status : event.type === "customer.subscription.deleted" ? "canceled" : null;
      if (!email) return `${event.type}: no email on subscription, ignored`;
      // A canceled/deleted subscription revokes access; the record stays.
      const effectivePlan = status === "canceled" || status === "past_due" ? null : plan;
      await setPlan(email, effectivePlan as never, status, {
        customerId: typeof obj.customer === "string" ? obj.customer : null,
        subscriptionId: typeof obj.id === "string" ? obj.id : null,
      });
      return `${event.type}: ${email} → ${effectivePlan ?? "no access"} (${status})`;
    }
    default:
      return `${event.type}: ignored`;
  }
}
