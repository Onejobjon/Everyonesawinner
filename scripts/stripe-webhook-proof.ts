/**
 * Repeatable proof for the Stripe webhook: signature verification and the
 * subscription lifecycle. Run: bun scripts/stripe-webhook-proof.ts
 *
 * Uses a throwaway users file, so it cannot touch real accounts.
 */
import { createHmac } from "node:crypto";
const { verifyStripeSignature, handleStripeEvent } = await import("../src/server/stripe-webhook.ts");
const { findByEmail } = await import("../src/server/users.ts");
const ok = (c: boolean, l: string) => console.log(`${c ? "PASS" : "FAIL"}  ${l}`);

process.env.USERS_FILE = `/tmp/wh-users-${Date.now()}.json`;
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_123";
process.env.STRIPE_PRICE_PRO = "price_pro_1";

const secret = "whsec_test_123";
const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: {} } });
const t = Math.floor(Date.now() / 1000);
const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

ok(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret), "valid signature accepted");
ok(!verifyStripeSignature(body, `t=${t},v1=${"0".repeat(64)}`, secret), "wrong signature rejected");
ok(!verifyStripeSignature(body + "x", `t=${t},v1=${sig}`, secret), "tampered body rejected");
ok(!verifyStripeSignature(body, `t=${t - 400},v1=${sig}`, secret), "stale timestamp (>5min) rejected");
ok(!verifyStripeSignature(body, null, secret), "missing header rejected");

// A paying customer must end up with access.
process.env.OWNER_PASSWORD = "owner-secret-123";
const { registerUser } = await import("../src/server/users.ts");
await registerUser("Buyer", "buyer@example.com", "password-123");
const before = await findByEmail("buyer@example.com");
ok(before?.subscription === false, "customer starts with no access");

await handleStripeEvent({
  type: "checkout.session.completed",
  data: { object: { customer_details: { email: "buyer@example.com" }, subscription: "sub_1", customer: "cus_1", metadata: { price_id: "price_pro_1" } } },
} as any);
const after = await findByEmail("buyer@example.com");
ok(after?.subscription === true && after?.plan === "pro", "checkout.session.completed grants pro access");

await handleStripeEvent({
  type: "customer.subscription.deleted",
  data: { object: { id: "sub_1", customer: "cus_1", status: "canceled", metadata: { email: "buyer@example.com" }, items: { data: [{ price: { id: "price_pro_1" } }] } } },
} as any);
const revoked = await findByEmail("buyer@example.com");
ok(revoked?.subscription === false, "cancelled subscription revokes access");

await handleStripeEvent({
  type: "customer.subscription.updated",
  data: { object: { id: "sub_1", customer: "cus_1", status: "active", metadata: { email: "buyer@example.com" }, items: { data: [{ price: { id: "price_pro_1" } }] } } },
} as any);
const restored = await findByEmail("buyer@example.com");
ok(restored?.subscription === true && restored?.plan === "pro", "reactivated subscription restores pro access");
process.exit(0);
