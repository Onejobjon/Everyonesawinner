import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  billingReadiness,
  createCheckoutSession,
  resetCheckoutCaches,
} from "../src/server/checkout";
import { CHECKOUT_FLAG, isCheckoutEnabled } from "../src/server/billing-switch";
import { processedEventIds } from "../src/server/processed-events";
import { receiveStripeEvent } from "../src/server/stripe-webhook";
import { findByEmail, registerUser } from "../src/server/users";
import { isEntitled } from "../src/server/entitlement";
import { recentOwnerAlerts } from "../src/server/notify-owner";

/**
 * CHECKOUT + SUBSCRIPTION ENTITLEMENT, PROVEN INERT (2026-11-03).
 *
 * The owner's Stripe account is an EXPRESS account: it cannot create
 * subscriptions, and every live price on it is one-time. Nothing may be charged
 * until he completes the reconnect himself. So the machinery is built now and
 * every path is proven dead while `CHECKOUT_ENABLED` is unset:
 *
 *  A. flag OFF (the default, and the state of production today):
 *       no checkout session can be created — not even with a real-looking secret
 *       key and price ids — and NO webhook can change anyone's access, even a
 *       perfectly signed one.
 *  B. flag ON, still refusing: a one-time Stripe price, an amount or billing
 *       period that disagrees with /subscribe, an unknown plan, a publishable
 *       key, and an account that cannot take subscription payments.
 *  C. flag ON, the lifecycle: signed events grant / renew / grace / cancel /
 *       refund; unsigned, wrong-secret and replayed payloads are rejected; a
 *       duplicate delivery is applied once.
 *
 * NO NETWORK AND NO REAL KEYS: `fetch` is stubbed and every request is inspected,
 * so "never creates a one-time price by accident" is checked as a fact about the
 * bytes we would have sent, not as a promise in a comment.
 */

const DAY = 86_400_000;
const PRICE_STARTER = "price_test_starter";
const PRICE_PRO = "price_test_pro";
const PRICE_ANNUAL = "price_test_annual";
const SECRET = "whsec_test_checkout";
const SK = "sk_test_not_a_real_key";
const SITE = "https://www.everyonesawinner.uk";

let dir: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "USERS_FILE",
  "SESSIONS_FILE",
  "STRIPE_EVENTS_FILE",
  "DATABASE_URL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "STRIPE_PRICE_STARTER",
  "STRIPE_PRICE_PRO",
  "STRIPE_PRICE_ANNUAL",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_GRACE_DAYS",
  CHECKOUT_FLAG,
];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "eaw-checkout-"));
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.USERS_FILE = join(dir, "users.json");
  process.env.SESSIONS_FILE = join(dir, "sessions.json");
  process.env.STRIPE_EVENTS_FILE = join(dir, "stripe-events.json");
  delete process.env.DATABASE_URL;
  // No Telegram in tests: notifyOwner() logs and returns, never dials out.
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  process.env.STRIPE_PRICE_STARTER = PRICE_STARTER;
  process.env.STRIPE_PRICE_PRO = PRICE_PRO;
  process.env.STRIPE_PRICE_ANNUAL = PRICE_ANNUAL;
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  delete process.env.STRIPE_GRACE_DAYS;
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetCheckoutCaches();
  // Every test starts with billing OFF — the production state — and turns it on
  // only if it is testing what happens once the owner flips the switch.
  delete process.env[CHECKOUT_FLAG];
  delete process.env.STRIPE_SECRET_KEY;
});

// ── helpers ─────────────────────────────────────────────────────────────────

const isoIn = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const unixIn = (days: number) => Math.floor((Date.now() + days * DAY) / 1000);

/** Unique ids per event: a duplicate id would (correctly) be skipped. */
let seq = 0;
const nextSeq = () => ++seq;

async function account(email: string) {
  await registerUser(email.split("@")[0]!, email, "CorrectHorse9!");
  return email;
}

function enableBilling() {
  process.env[CHECKOUT_FLAG] = "on";
  process.env.STRIPE_SECRET_KEY = SK;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * A stubbed Stripe: records every request, answers the price lookup and the
 * session creation separately. `undefined` means "never answer this" — the call
 * then throws, which is how a missing request shows up.
 */
function stripeStub(cfg: {
  price?: { status?: number; body?: unknown } | "throw";
  session?: { status?: number; body?: unknown } | "throw";
}) {
  const calls: Call[] = [];
  const impl = (async (input: unknown, init: Record<string, any> = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: (init.method as string) ?? "GET",
      headers: (init.headers as Record<string, string>) ?? {},
      body: typeof init.body === "string" ? init.body : "",
    });
    const isPrice = url.includes("/prices/");
    const choice = isPrice ? cfg.price : cfg.session;
    if (choice === "throw" || choice === undefined) throw new Error("stub: no answer configured");
    return new Response(JSON.stringify(choice.body ?? {}), {
      status: choice.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const goodProPrice = {
  id: PRICE_PRO,
  active: true,
  currency: "gbp",
  unit_amount: 2999,
  recurring: { interval: "month", interval_count: 1 },
};

const goodSession = { id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123" };

function sign(body: string, secret = SECRET, at = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${at}.${body}`).digest("hex");
  return `t=${at},v1=${v1}`;
}

/** Deliver an event through the real HTTP-boundary function, properly signed. */
async function deliver(event: Record<string, any>, opts: { secret?: string } = {}) {
  const body = JSON.stringify(event);
  return receiveStripeEvent(body, sign(body, opts.secret ?? SECRET));
}

/** A subscription.created event with fresh ids, so no test can collide. */
function subscriptionCreated(email: string, over: Record<string, any> = {}) {
  const n = nextSeq();
  return {
    id: `evt_created_${n}`,
    type: "customer.subscription.created",
    data: {
      object: {
        id: `sub_${n}`,
        customer: `cus_${n}`,
        status: "active",
        metadata: { email },
        items: { data: [{ price: { id: PRICE_PRO }, current_period_end: unixIn(30) }] },
        ...over,
      },
    },
  };
}

// ── A. THE SWITCH IS OFF BY DEFAULT, AND OFF MEANS INERT ────────────────────

describe("A. billing is off unless the owner switches it on", () => {
  test("the flag defaults to OFF, and only an explicit on-value enables it", () => {
    expect(isCheckoutEnabled()).toBe(false);
    expect(isCheckoutEnabled({})).toBe(false);
    for (const off of ["", "0", "false", "off", "no", "ture", "enable"]) {
      expect(isCheckoutEnabled({ [CHECKOUT_FLAG]: off })).toBe(false);
    }
    for (const on of ["1", "true", "on", "yes", "enabled", "ON"]) {
      expect(isCheckoutEnabled({ [CHECKOUT_FLAG]: on })).toBe(true);
    }
  });

  test("flag OFF: no checkout session can be created, and Stripe is never called", async () => {
    const email = await account("off-basic@example.com");
    const stub = stripeStub({ price: { body: goodProPrice }, session: { body: goodSession } });

    const result = await createCheckoutSession(
      { email, plan: "pro", origin: SITE },
      { fetchImpl: stub.impl },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
    expect(result.code).toBe("checkout_disabled");
    expect(result.message).toContain(CHECKOUT_FLAG);
    // THE POINT: zero HTTP calls. Nothing reached Stripe at all.
    expect(stub.calls).toEqual([]);
  });

  test("flag OFF: even a fully configured account cannot sell a plan", async () => {
    // Every other input is perfect: price ids, a secret key, a valid plan and a
    // signed-in email. The switch alone stops it.
    process.env.STRIPE_SECRET_KEY = SK;
    const email = await account("off-configured@example.com");
    const stub = stripeStub({ price: { body: goodProPrice }, session: { body: goodSession } });

    const result = await createCheckoutSession(
      { email, plan: "pro", origin: SITE },
      { fetchImpl: stub.impl },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("checkout_disabled");
    expect(stub.calls).toEqual([]);
    expect((await findByEmail(email))?.entitled).toBe(false);
  });

  test("flag OFF: the readiness report says billing cannot take payments", () => {
    const readiness = billingReadiness();
    expect(readiness.enabled).toBe(false);
    expect(readiness.canTakeSubscriptionPayments).toBe(false);
    expect(readiness.blockers[0]).toContain(CHECKOUT_FLAG);
    // The prices the owner decided are reported as published, not invented.
    expect(readiness.plans.map((p) => `${p.label} ${p.price}/${p.interval}`)).toEqual([
      "Starter £19.99/month",
      "Pro £29.99/month",
      "Pro Annual £269.99/year",
    ]);
  });

  test("flag OFF: a PERFECTLY SIGNED webhook cannot grant access", async () => {
    const email = await account("off-webhook@example.com");
    const event = subscriptionCreated(email);
    const res = await deliver(event);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("checkout_disabled");
    const user = await findByEmail(email);
    expect(user?.entitled).toBe(false);
    expect(user?.plan).toBeNull();
    expect(user?.subscriptionStatus).toBeNull();
    // And nothing was recorded as processed: the switch refuses before the ledger.
    expect(await processedEventIds()).not.toContain(event.id);
  });

  test("flag OFF: the webhook cannot revoke either — the switch is master control", async () => {
    const email = await account("off-revoke@example.com");
    enableBilling();
    const created = subscriptionCreated(email);
    expect((await deliver(created)).status).toBe(200);
    expect((await findByEmail(email))?.entitled).toBe(true);

    // Owner switches billing back off: the next event is refused, and the
    // customer's access is exactly as it was.
    delete process.env[CHECKOUT_FLAG];
    const res = await deliver({
      id: "evt_del_after_off",
      type: "customer.subscription.deleted",
      data: {
        object: { id: created.data.object.id, customer: created.data.object.customer, status: "canceled" },
      },
    });
    expect(res.status).toBe(503);
    const user = await findByEmail(email);
    expect(user?.subscriptionStatus).toBe("active");
    expect(user?.entitled).toBe(true);
  });
});

// ── B. FLAG ON, AND STILL REFUSING THE WRONG THING ──────────────────────────

describe("B. with billing on, checkout still refuses what it must", () => {
  beforeEach(() => enableBilling());

  test("a ONE-TIME Stripe price is refused, not repurposed into a one-off payment", async () => {
    const email = await account("onetime@example.com");
    const stub = stripeStub({
      // Exactly what the express account has today: no `recurring` object.
      price: { body: { id: PRICE_PRO, active: true, currency: "gbp", unit_amount: 2999, recurring: null } },
      session: { body: goodSession },
    });

    const result = await createCheckoutSession({ email, plan: "pro", origin: SITE }, { fetchImpl: stub.impl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("price_not_recurring");
    expect(result.message.toLowerCase()).toContain("one-time");
    // ONE call: the price lookup. No session was created, in any mode.
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0]!.url).toContain("/prices/");
  });

  test("a price for the wrong amount is refused — we never charge what the page does not say", async () => {
    const email = await account("wrongamount@example.com");
    const stub = stripeStub({
      price: { body: { ...goodProPrice, unit_amount: 999 } },
      session: { body: goodSession },
    });
    const result = await createCheckoutSession({ email, plan: "pro", origin: SITE }, { fetchImpl: stub.impl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("price_amount_mismatch");
    expect(result.message).toContain("£9.99");
    expect(result.message).toContain("£29.99");
    expect(stub.calls.length).toBe(1);
  });

  test("a monthly price behind the ANNUAL plan is refused (billing period must match the page)", async () => {
    const email = await account("wronginterval@example.com");
    const stub = stripeStub({
      price: {
        body: {
          ...goodProPrice,
          id: PRICE_ANNUAL,
          unit_amount: 26999,
          recurring: { interval: "month", interval_count: 1 },
        },
      },
      session: { body: goodSession },
    });
    const result = await createCheckoutSession({ email, plan: "annual", origin: SITE }, { fetchImpl: stub.impl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("price_interval_mismatch");
    expect(stub.calls.length).toBe(1);
  });

  test("an unknown plan, a bad email and a bad origin are refused before any call", async () => {
    const stub = stripeStub({ price: { body: goodProPrice }, session: { body: goodSession } });
    const base = { email: "someone@example.com", origin: SITE };

    const unknown = await createCheckoutSession({ ...base, plan: "platinum" }, { fetchImpl: stub.impl });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe("unknown_plan");

    const noPlan = await createCheckoutSession({ ...base, plan: undefined }, { fetchImpl: stub.impl });
    expect(noPlan.ok).toBe(false);
    if (!noPlan.ok) expect(noPlan.code).toBe("unknown_plan");

    const badEmail = await createCheckoutSession(
      { ...base, email: "not-an-email", plan: "pro" },
      { fetchImpl: stub.impl },
    );
    expect(badEmail.ok).toBe(false);
    if (!badEmail.ok) expect(badEmail.code).toBe("invalid_email");

    const badOrigin = await createCheckoutSession(
      { ...base, plan: "pro", origin: "javascript:alert(1)" },
      { fetchImpl: stub.impl },
    );
    expect(badOrigin.ok).toBe(false);
    if (!badOrigin.ok) expect(badOrigin.code).toBe("bad_origin");

    expect(stub.calls).toEqual([]);
  });

  test("a plan with no configured price id is refused, and Stripe is not called", async () => {
    delete process.env.STRIPE_PRICE_PRO;
    try {
      const email = await account("noprice@example.com");
      const stub = stripeStub({ price: { body: goodProPrice }, session: { body: goodSession } });
      const result = await createCheckoutSession({ email, plan: "pro", origin: SITE }, { fetchImpl: stub.impl });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("price_not_configured");
      expect(result.message).toContain("STRIPE_PRICE_PRO");
      expect(stub.calls).toEqual([]);
    } finally {
      process.env.STRIPE_PRICE_PRO = PRICE_PRO;
    }
  });

  test("a publishable key is refused: it cannot create a checkout", async () => {
    process.env.STRIPE_SECRET_KEY = "pk_live_looks_like_a_key";
    const email = await account("pk@example.com");
    const stub = stripeStub({ price: { body: goodProPrice }, session: { body: goodSession } });
    const result = await createCheckoutSession({ email, plan: "pro", origin: SITE }, { fetchImpl: stub.impl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("stripe_not_configured");
    expect(stub.calls).toEqual([]);
  });

  test("an EXPRESS account that cannot take subscriptions is refused with a clear message", async () => {
    const email = await account("express@example.com");
    const stub = stripeStub({
      price: { body: goodProPrice },
      session: {
        status: 400,
        body: {
          error: {
            type: "invalid_request_error",
            code: "account_invalid",
            message: "Your account cannot currently make live charges.",
          },
        },
      },
    });

    const result = await createCheckoutSession({ email, plan: "pro", origin: SITE }, { fetchImpl: stub.impl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("account_cannot_subscribe");
    expect(result.message).toContain("no payment was taken");
    expect(result.message).toContain("reconnect");

    // Exactly two calls — the price check and ONE session attempt. There is no
    // retry with mode=payment, because there is no such code path.
    expect(stub.calls.length).toBe(2);
    const sessionCall = stub.calls.find((c) => c.url.endsWith("/checkout/sessions"))!;
    expect(new URLSearchParams(sessionCall.body).get("mode")).toBe("subscription");
  });

  test("the happy path asks Stripe for a SUBSCRIPTION with the account linked on it", async () => {
    const email = await account("happy@example.com");
    const stub = stripeStub({ price: { body: goodProPrice }, session: { body: goodSession } });

    const result = await createCheckoutSession({ email, plan: "pro", origin: SITE }, { fetchImpl: stub.impl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toBe(goodSession.url);
    expect(result.mode).toBe("subscription");
    expect(result.priceId).toBe(PRICE_PRO);

    const sessionCall = stub.calls.find((c) => c.url.endsWith("/checkout/sessions"))!;
    const form = new URLSearchParams(sessionCall.body);
    expect(sessionCall.method).toBe("POST");
    expect(sessionCall.headers.authorization).toBe(`Bearer ${SK}`);
    // THE ONLY MODE. A one-off charge cannot be produced from this function.
    expect(form.get("mode")).toBe("subscription");
    expect(form.get("line_items[0][price]")).toBe(PRICE_PRO);
    expect(form.get("line_items[0][quantity]")).toBe("1");
    // The webhook has no email on a subscription object, so we put it everywhere
    // it can be read from (see stripe-webhook.ts).
    expect(form.get("client_reference_id")).toBe(email);
    expect(form.get("metadata[email]")).toBe(email);
    expect(form.get("subscription_data[metadata][email]")).toBe(email);
    expect(form.get("customer_email")).toBe(email);
    expect(form.get("success_url")).toContain(`${SITE}/subscribe/success`);
    expect(form.get("cancel_url")).toContain(`${SITE}/subscribe`);
    // No caller-supplied price can leak in: the only price in the body is ours.
    expect(form.getAll("line_items[0][price]")).toEqual([PRICE_PRO]);
  });
});

// ── C. FLAG ON: THE LIFECYCLE ───────────────────────────────────────────────

describe("C. the lifecycle: signed events only, applied once", () => {
  beforeEach(() => enableBilling());

  test("a signed valid event grants access", async () => {
    const email = await account("grants@example.com");
    const res = await deliver(subscriptionCreated(email));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const user = await findByEmail(email);
    expect(user?.plan).toBe("pro");
    expect(user?.subscriptionStatus).toBe("active");
    expect(user?.entitled).toBe(true);
    expect(Date.parse(user!.currentPeriodEnd!)).toBeGreaterThan(Date.now());
  });

  test("an UNSIGNED event is rejected and changes nothing", async () => {
    const email = await account("unsigned@example.com");
    const body = JSON.stringify(subscriptionCreated(email));

    const noHeader = await receiveStripeEvent(body, null);
    expect(noHeader.status).toBe(400);
    expect(noHeader.body.code).toBe("bad_signature");
    expect((await findByEmail(email))?.entitled).toBe(false);

    const junk = await receiveStripeEvent(body, "t=1,v1=deadbeef");
    expect(junk.status).toBe(400);
    expect((await findByEmail(email))?.entitled).toBe(false);
  });

  test("an event signed with the WRONG secret is rejected", async () => {
    const email = await account("wrongsecret@example.com");
    const body = JSON.stringify(subscriptionCreated(email));
    const res = await receiveStripeEvent(body, sign(body, "whsec_someone_elses_endpoint"));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("bad_signature");
    expect((await findByEmail(email))?.entitled).toBe(false);
  });

  test("a stale signature (older than 5 minutes) is rejected as a replay", async () => {
    const email = await account("stale@example.com");
    const body = JSON.stringify(subscriptionCreated(email));
    const old = Math.floor(Date.now() / 1000) - 600;
    const res = await receiveStripeEvent(body, sign(body, SECRET, old));
    expect(res.status).toBe(400);
    expect((await findByEmail(email))?.entitled).toBe(false);
  });

  test("no signing secret configured: the endpoint refuses even a signed payload", async () => {
    const res = await receiveStripeEvent("{}", "t=1,v1=abc", { secret: null });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("webhook_not_configured");
  });

  test("the SAME event delivered twice is applied once", async () => {
    const email = await account("duplicate@example.com");
    const event = subscriptionCreated(email);

    const first = await deliver(event);
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBeUndefined();

    // Cancel it, so a replay would be visible if it were applied.
    const cancel = await deliver({
      id: `evt_cancel_${nextSeq()}`,
      type: "customer.subscription.deleted",
      data: {
        object: { id: event.data.object.id, customer: event.data.object.customer, status: "canceled" },
      },
    });
    expect(cancel.status).toBe(200);
    expect((await findByEmail(email))?.subscriptionStatus).toBe("canceled");

    // Stripe redelivers the ORIGINAL creation event (same id, same bytes).
    const replay = await deliver(event);
    expect(replay.status).toBe(200);
    expect(replay.body.duplicate).toBe(true);
    expect(String(replay.body.note)).toContain("already applied");

    // THE POINT: the old event did not resurrect the subscription.
    const user = await findByEmail(email);
    expect(user?.subscriptionStatus).toBe("canceled");
    // And the ledger holds the id exactly once.
    expect((await processedEventIds()).filter((id) => id === event.id).length).toBe(1);
  });

  test("subscription deleted: access runs to the period end already paid for, then stops", async () => {
    const email = await account("cancelend@example.com");
    const created = subscriptionCreated(email);
    await deliver(created);

    const paidTo = unixIn(5);
    const del = await deliver({
      id: `evt_deleted_${nextSeq()}`,
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: created.data.object.id,
          customer: created.data.object.customer,
          status: "canceled",
          items: { data: [] },
          current_period_end: paidTo,
        },
      },
    });
    expect(del.status).toBe(200);

    const user = await findByEmail(email);
    expect(user?.subscriptionStatus).toBe("canceled");
    // Terms §8: cancelling does not end the plan on the spot.
    expect(user?.entitled).toBe(true);

    const state = {
      plan: user!.plan,
      status: user!.subscriptionStatus,
      currentPeriodEnd: user!.currentPeriodEnd,
      graceEndsAt: user!.graceEndsAt,
    };
    const endMs = Date.parse(user!.currentPeriodEnd!);
    expect(isEntitled(state, endMs - 60_000)).toBe(true);
    // One minute later the period that was paid for is over: out.
    expect(isEntitled(state, endMs + 60_000)).toBe(false);
  });

  test("invoice.payment_failed: access continues during grace, and an email is due", async () => {
    const email = await account("graceful@example.com");
    const created = subscriptionCreated(email);
    await deliver(created);

    const before = recentOwnerAlerts().length;
    const failed = await deliver({
      id: `evt_failed_${nextSeq()}`,
      type: "invoice.payment_failed",
      data: {
        object: { id: "in_1", customer: created.data.object.customer, subscription: created.data.object.id },
      },
    });
    expect(failed.status).toBe(200);
    expect(String(failed.body.note)).toContain("email due");

    const user = await findByEmail(email);
    expect(user?.subscriptionStatus).toBe("past_due");
    // THE PROMISE: no instant lock-out.
    expect(user?.entitled).toBe(true);
    expect(Date.parse(user!.graceEndsAt!)).toBeGreaterThan(Date.now());

    // The owner is told, in words that say a customer email is owed.
    const alerts = recentOwnerAlerts().slice(before).map((a) => a.text);
    expect(alerts.some((t) => t.includes("EMAIL DUE") && t.includes(email))).toBe(true);

    // When the grace date passes, the tools lock — the date governs, not the status.
    const state = {
      plan: user!.plan,
      status: user!.subscriptionStatus,
      currentPeriodEnd: user!.currentPeriodEnd,
      graceEndsAt: user!.graceEndsAt,
    };
    expect(isEntitled(state, Date.parse(user!.graceEndsAt!) + 60_000)).toBe(false);
  });

  test("invoice.paid extends the paid period and clears the grace window", async () => {
    const email = await account("renews@example.com");
    const created = subscriptionCreated(email);
    await deliver(created);
    await deliver({
      id: `evt_failed_renew_${nextSeq()}`,
      type: "invoice.payment_failed",
      data: {
        object: { id: "in_fail", customer: created.data.object.customer, subscription: created.data.object.id },
      },
    });
    const beforeRenewal = (await findByEmail(email))!.currentPeriodEnd!;

    const paid = await deliver({
      id: `evt_paid_${nextSeq()}`,
      type: "invoice.paid",
      data: {
        object: {
          id: "in_paid",
          customer: created.data.object.customer,
          subscription: created.data.object.id,
          lines: { data: [{ price: { id: PRICE_PRO }, period: { end: unixIn(60) } }] },
        },
      },
    });
    expect(paid.status).toBe(200);

    const user = await findByEmail(email);
    expect(Date.parse(user!.currentPeriodEnd!)).toBeGreaterThan(Date.parse(beforeRenewal));
    expect(user?.subscriptionStatus).toBe("active");
    expect(user?.graceEndsAt).toBeNull();
    expect(user?.entitled).toBe(true);
  });

  test("a full refund revokes access immediately and clears the plan", async () => {
    const email = await account("refunded@example.com");
    const created = subscriptionCreated(email);
    await deliver(created);
    expect((await findByEmail(email))?.entitled).toBe(true);

    const refund = await deliver({
      id: `evt_refund_${nextSeq()}`,
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          customer: created.data.object.customer,
          amount: 2999,
          amount_refunded: 2999,
          refunded: true,
        },
      },
    });
    expect(refund.status).toBe(200);
    expect(String(refund.body.note)).toContain("revoked");

    const user = await findByEmail(email);
    expect(user?.subscriptionStatus).toBe("refunded");
    expect(user?.plan).toBeNull();
    expect(user?.entitled).toBe(false);
  });

  test("a partial refund does not touch access", async () => {
    const email = await account("partial@example.com");
    const created = subscriptionCreated(email);
    await deliver(created);

    await deliver({
      id: `evt_refund_partial_${nextSeq()}`,
      type: "charge.refunded",
      data: { object: { id: "ch_2", customer: created.data.object.customer, amount: 2999, amount_refunded: 500 } },
    });

    const user = await findByEmail(email);
    expect(user?.entitled).toBe(true);
    expect(user?.plan).toBe("pro");
  });

  test("an event for an account that does not exist never grants anything", async () => {
    const res = await deliver(subscriptionCreated("ghost@example.com"));
    expect(res.status).toBe(200);
    expect(String(res.body.note)).toContain("owner alerted");
    expect(await findByEmail("ghost@example.com")).toBeNull();
  });

  test("the readiness report turns green only when every piece is configured", () => {
    const readiness = billingReadiness();
    expect(readiness.enabled).toBe(true);
    expect(readiness.secretKeyConfigured).toBe(true);
    expect(readiness.webhookSecretConfigured).toBe(true);
    expect(readiness.plans.every((p) => p.priceConfigured)).toBe(true);
    expect(readiness.canTakeSubscriptionPayments).toBe(true);
    expect(readiness.blockers).toEqual([]);
  });

  test("entitlement still fails closed for a plan with no period, whatever the status", async () => {
    const email = await account("nodate@example.com");
    await deliver(subscriptionCreated(email, { items: { data: [{ price: { id: PRICE_PRO } }] } }));
    const user = await findByEmail(email);
    expect(user?.currentPeriodEnd).toBeNull();
    expect(user?.entitled).toBe(false);
    // Sanity: neither cancellation nor grace can rescue an undated plan.
    expect(isEntitled({ plan: "pro", status: "canceled", currentPeriodEnd: null, graceEndsAt: null })).toBe(false);
    expect(isEntitled({ plan: "pro", status: "past_due", currentPeriodEnd: null, graceEndsAt: isoIn(3) })).toBe(true);
  });
});
