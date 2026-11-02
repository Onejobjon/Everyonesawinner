/**
 * Repeatable proof for the Stripe webhook: signature verification and the
 * subscription lifecycle. Run: bun scripts/stripe-webhook-proof.ts
 *
 * Uses a throwaway users file, so it cannot touch real accounts.
 *
 * REWRITTEN 2026-11-02 to match what the code now promises (terms §7–§11):
 *   • a checkout LINKS the account to the Stripe ids but grants nothing — the
 *     tier and the paid period come from the subscription event;
 *   • a live subscription grants access only until the period end it carries;
 *   • a failed renewal leaves access ON until a stored grace date;
 *   • a cancellation ends access without inventing a new end date.
 * The previous version asserted "checkout.session.completed grants pro access",
 * which was the "one payment = Pro for ever" bug.
 */
import { createHmac } from "node:crypto";

const { verifyStripeSignature, handleStripeEvent } = await import("../src/server/stripe-webhook.ts");
const { findByEmail } = await import("../src/server/users.ts");
const ok = (c: boolean, l: string) => console.log(`${c ? "PASS" : "FAIL"}  ${l}`);

process.env.USERS_FILE = `/tmp/wh-users-${Date.now()}.json`;
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_123";
process.env.STRIPE_PRICE_PRO = "price_pro_1";
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const secret = "whsec_test_123";
const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: {} } });
const t = Math.floor(Date.now() / 1000);
const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

ok(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret), "valid signature accepted");
ok(!verifyStripeSignature(body, `t=${t},v1=${"0".repeat(64)}`, secret), "wrong signature rejected");
ok(!verifyStripeSignature(body + "x", `t=${t},v1=${sig}`, secret), "tampered body rejected");
ok(!verifyStripeSignature(body, `t=${t - 400},v1=${sig}`, secret), "stale timestamp (>5min) rejected");
ok(!verifyStripeSignature(body, null, secret), "missing header rejected");

const { registerUser } = await import("../src/server/users.ts");
await registerUser("Buyer", "buyer@example.com", "password-123");
ok((await findByEmail("buyer@example.com"))?.entitled === false, "customer starts with no access");

const periodEnd = Math.floor((Date.now() + 30 * 86_400_000) / 1000);

// 1. Checkout: links the ids, grants nothing yet.
await handleStripeEvent({
  type: "checkout.session.completed",
  data: {
    object: {
      mode: "subscription",
      customer_details: { email: "buyer@example.com" },
      subscription: "sub_1",
      customer: "cus_1",
      metadata: { email: "buyer@example.com" },
    },
  },
} as any);
const linked = await findByEmail("buyer@example.com");
ok(linked?.entitled === false, "checkout alone grants nothing (no period yet)");

// 2. The subscription event carries the tier and the paid period. It has NO
//    email on it — the stored customer id is the link.
await handleStripeEvent({
  type: "customer.subscription.created",
  data: {
    object: {
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      items: { data: [{ price: { id: "price_pro_1" }, current_period_end: periodEnd }] },
    },
  },
} as any);
const active = await findByEmail("buyer@example.com");
ok(active?.entitled === true && active?.plan === "pro", "active subscription grants pro access");
ok(Date.parse(active?.currentPeriodEnd ?? "") > Date.now(), "the paid period end is stored");

// 3. A failed renewal: access stays on, with a grace end date.
await handleStripeEvent({
  type: "invoice.payment_failed",
  data: { object: { id: "in_1", customer: "cus_1", subscription: "sub_1" } },
} as any);
const graced = await findByEmail("buyer@example.com");
ok(graced?.entitled === true, "a failed card does not lock the customer out");
ok(Date.parse(graced?.graceEndsAt ?? "") > Date.now(), "the grace end date is stored for the email");

// 4. A renewal pays: the period extends and grace clears.
await handleStripeEvent({
  type: "invoice.paid",
  data: {
    object: {
      id: "in_2",
      customer: "cus_1",
      subscription: "sub_1",
      lines: { data: [{ price: { id: "price_pro_1" }, period: { end: periodEnd + 30 * 86_400 } }] },
    },
  },
} as any);
const renewed = await findByEmail("buyer@example.com");
ok(Date.parse(renewed?.currentPeriodEnd ?? "") > Date.parse(active?.currentPeriodEnd ?? ""), "a renewal extends the paid period");
ok(renewed?.graceEndsAt === null, "a successful payment clears the grace window");

// 5. Cancellation: status recorded, no invented end date, access off.
await handleStripeEvent({
  type: "customer.subscription.deleted",
  data: { object: { id: "sub_1", customer: "cus_1", status: "canceled", items: { data: [] } } },
} as any);
const cancelled = await findByEmail("buyer@example.com");
ok(cancelled?.subscriptionStatus === "canceled", "cancellation is recorded");
ok(cancelled?.entitled === false, "a cancelled subscription no longer grants access");

process.exit(0);
