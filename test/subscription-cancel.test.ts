import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSubscriptionApi } from "../src/server/subscription-api";
import { cancelSubscription, resumeSubscription, subscriptionView } from "../src/server/subscription";
import { isEntitled, CANCELED_STATUSES } from "../src/server/entitlement";
import { issueSession } from "../src/server/sessions";
import { findByEmail, registerUser, setComp, stateOf, updateSubscription } from "../src/server/users";
import { ROUTES } from "../api/router";

/**
 * CANCELLING YOUR OWN SUBSCRIPTION (2026-11-08).
 *
 * The terms promise "cancel at any time" and "your access continues to the end of
 * the period you have already paid for". These tests pin the four things that
 * promise actually needs, plus the security property that makes it safe:
 *
 *   1. cancelling sets the end date and KEEPS access until it;
 *   2. access is genuinely refused after that date (the clock is moved, never
 *      waited for);
 *   3. resuming clears the pending cancellation, right up to the end date;
 *   4. a signed-out request is refused, and one customer cannot cancel another's
 *      subscription even by naming them in the request body.
 *
 * NO STRIPE KEY IS NEEDED for any of that: the Stripe call sits behind an
 * interface (src/server/subscription.ts) and is stubbed here with a fetch double.
 * The two tests that do exercise it prove the request is the documented
 * `cancel_at_period_end` POST, and that a refusal from Stripe changes NOTHING —
 * we never tell a customer "you won't be charged" while a card is still due.
 *
 * Everything writes to a temp directory. Nothing here touches the live .run/.
 */

const PASSWORD = "CorrectHorse9!";
const DAY = 24 * 60 * 60 * 1000;

let dir: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["USERS_FILE", "SESSIONS_FILE", "DATABASE_URL", "STRIPE_SECRET_KEY", "OWNER_PASSWORD"];

/** A paid account, on Pro, renewing on a date in the future. */
async function makePayingCustomer(email: string, periodEndMs: number, subscriptionId: string | null = null) {
  await registerUser("Punter", email, PASSWORD);
  await updateSubscription(email, {
    plan: "pro",
    status: "active",
    currentPeriodEnd: new Date(periodEndMs).toISOString(),
    customerId: "cus_test",
    subscriptionId,
    canceledAt: null,
  });
  return issueSession(email);
}

interface Answer {
  status: number;
  body: any;
}

/** Call the real HTTP handler the way the server does (session token only). */
async function call(
  path: string,
  opts: {
    token?: string;
    method?: string;
    body?: unknown;
    deps?: Parameters<typeof handleSubscriptionApi>[2];
  } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const req = new Request(`https://example.test${path}`, {
    method: opts.method ?? "GET",
    headers,
    // A body is sent on purpose in the "cannot cancel another's" test: the
    // handler must ignore it entirely.
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await handleSubscriptionApi(req, new URL(`https://example.test${path}`), opts.deps);
  return { status: res.status, body: await res.json() };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "eaw-cancel-"));
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.USERS_FILE = join(dir, "users.json");
  process.env.SESSIONS_FILE = join(dir, "sessions.json");
  delete process.env.DATABASE_URL;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.OWNER_PASSWORD;
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  // Every test starts from "no Stripe key", which is the state of the business.
  delete process.env.STRIPE_SECRET_KEY;
});

/* ================================================================== *
 * 1. What the page is told
 * ================================================================== */

describe("GET /api/subscription — the plan, the price, the date", () => {
  test("a paying customer sees their plan, its price, and that it renews", async () => {
    const periodEnd = Date.now() + 20 * DAY;
    const token = await makePayingCustomer("renewing@example.com", periodEnd);

    const { status, body } = await call("/api/subscription", { token });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const view = body.subscription;
    expect(view.state).toBe("renewing");
    expect(view.plan).toBe("pro");
    expect(view.planLabel).toBe("Pro");
    // Exactly what /subscribe prints — no second copy of the price.
    expect(view.priceText).toBe("£29.99 a month");
    expect(view.pricePence).toBe(2999);
    expect(view.renews).toBe(true);
    expect(view.entitled).toBe(true);
    expect(view.accessEndsAt).toBe(new Date(periodEnd).toISOString());
    expect(view.canCancel).toBe(true);
    expect(view.canResume).toBe(false);
  });

  test("an account with no plan gets a plain explanation, not an error", async () => {
    await registerUser("Free", "free@example.com", PASSWORD);
    const token = await issueSession("free@example.com");

    const { status, body } = await call("/api/subscription", { token });
    expect(status).toBe(200);
    expect(body.subscription.state).toBe("none");
    expect(body.subscription.plan).toBeNull();
    expect(body.subscription.canCancel).toBe(false);
    expect(body.subscription.entitled).toBe(false);
  });

  test("free access is shown as free access, with its own end date", async () => {
    const endsAt = new Date(Date.now() + 10 * DAY).toISOString();
    await registerUser("Comp", "comp@example.com", PASSWORD);
    await setComp("comp@example.com", { plan: "pro", endsAt, note: "Reviewer" });
    const token = await issueSession("comp@example.com");

    const { body } = await call("/api/subscription", { token });
    expect(body.subscription.state).toBe("comp");
    expect(body.subscription.comp.plan).toBe("pro");
    expect(body.subscription.comp.endsAt).toBe(endsAt);
    expect(body.subscription.renews).toBe(false);
    expect(body.subscription.canCancel).toBe(false);
    expect(body.subscription.entitled).toBe(true);
  });
});

/* ================================================================== *
 * 2. Security: the session is the only identifier
 * ================================================================== */

describe("the endpoints are gated server-side", () => {
  test("a signed-out request is refused and changes nothing", async () => {
    const periodEnd = Date.now() + 20 * DAY;
    await makePayingCustomer("signedout@example.com", periodEnd);

    const get = await call("/api/subscription");
    expect(get.status).toBe(401);
    expect(get.body.error).toBe("not_signed_in");

    const cancel = await call("/api/subscription/cancel", { method: "POST" });
    expect(cancel.status).toBe(401);
    expect(cancel.body.error).toBe("not_signed_in");

    const resume = await call("/api/subscription/resume", { method: "POST" });
    expect(resume.status).toBe(401);

    // Untouched: still renewing.
    const account = await findByEmail("signedout@example.com");
    expect(account?.subscriptionStatus).toBe("active");
    expect(account?.entitled).toBe(true);
  });

  test("a made-up token is refused, not treated as a customer", async () => {
    const { status } = await call("/api/subscription", { token: "not-a-real-token" });
    expect(status).toBe(401);
  });

  test("one customer cannot cancel another's subscription, even by naming them", async () => {
    const periodEnd = Date.now() + 20 * DAY;
    const victimToken = await makePayingCustomer("victim@example.com", periodEnd);
    const attackerToken = await makePayingCustomer("attacker@example.com", periodEnd);
    expect(victimToken).not.toBe(attackerToken);

    // The attacker cancels, and puts the victim's address in the body.
    const { status, body } = await call("/api/subscription/cancel", {
      token: attackerToken,
      method: "POST",
      body: { email: "victim@example.com", token: victimToken },
    });
    expect(status).toBe(200);
    expect(body.subscription.email).toBe("attacker@example.com");
    expect(body.subscription.state).toBe("ending");

    // The victim is untouched.
    const victim = await findByEmail("victim@example.com");
    expect(victim?.subscriptionStatus).toBe("active");
    expect(victim?.entitled).toBe(true);
    expect(victim?.canceledAt ?? null).toBeNull();
  });
});

/* ================================================================== *
 * 3. Cancel: the end date is set, access is kept until it
 * ================================================================== */

describe("cancelling stops the renewal and keeps the days already paid for", () => {
  test("cancel sets the period end and access continues until then", async () => {
    const periodEnd = Date.now() + 20 * DAY;
    const token = await makePayingCustomer("cancelme@example.com", periodEnd);

    const { status, body } = await call("/api/subscription/cancel", { token, method: "POST" });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    const view = body.subscription;
    expect(view.state).toBe("ending");
    expect(view.renews).toBe(false);
    // The date the customer was promised — unchanged by cancelling.
    expect(view.accessEndsAt).toBe(new Date(periodEnd).toISOString());
    expect(view.canceledAt).toBeTruthy();
    expect(view.canResume).toBe(true);

    // The record: one field decides it, and entitlement keeps access.
    const account = await findByEmail("cancelme@example.com");
    expect(account?.subscriptionStatus).toBe("canceled_at_period_end");
    expect(CANCELED_STATUSES).toContain(account?.subscriptionStatus);
    expect(account?.currentPeriodEnd).toBe(new Date(periodEnd).toISOString());
    expect(account?.entitled).toBe(true);
  });

  test("access is actually refused once that date passes", async () => {
    const periodEnd = Date.now() + 20 * DAY;
    const token = await makePayingCustomer("runsout@example.com", periodEnd);
    await call("/api/subscription/cancel", { token, method: "POST" });

    const account = await findByEmail("runsout@example.com");
    const record = stateOf({
      name: "Punter",
      email: "runsout@example.com",
      salt: "x",
      passwordHash: "x",
      plan: account!.plan,
      subscriptionStatus: account!.subscriptionStatus,
      currentPeriodEnd: account!.currentPeriodEnd,
      graceEndsAt: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      createdAt: new Date().toISOString(),
    });

    // One second before the end: still entitled.
    expect(isEntitled(record, periodEnd - 1000)).toBe(true);
    // One second after: NOT entitled. The date is what governs.
    expect(isEntitled(record, periodEnd + 1000)).toBe(false);
  });

  test("the API agrees after the date has passed: ended, not entitled, nothing to resume", async () => {
    const periodEnd = Date.now() + 5 * DAY;
    const token = await makePayingCustomer("past@example.com", periodEnd);
    await call("/api/subscription/cancel", { token, method: "POST" });

    // Move the end date into the past — the clock is never waited for.
    await updateSubscription("past@example.com", {
      currentPeriodEnd: new Date(Date.now() - DAY).toISOString(),
    });

    const { body } = await call("/api/subscription", { token });
    expect(body.subscription.state).toBe("ended");
    expect(body.subscription.entitled).toBe(false);
    expect(body.subscription.canResume).toBe(false);
    expect(body.subscription.accessEndsAt).toBeNull();

    const resume = await call("/api/subscription/resume", { token, method: "POST" });
    expect(resume.status).toBe(409);
    expect(resume.body.error).toBe("period_ended");

    const account = await findByEmail("past@example.com");
    expect(account?.entitled).toBe(false);
  });

  test("cancelling twice is idempotent and says the date both times", async () => {
    const periodEnd = Date.now() + 20 * DAY;
    const token = await makePayingCustomer("twice@example.com", periodEnd);

    const first = await call("/api/subscription/cancel", { token, method: "POST" });
    const second = await call("/api/subscription/cancel", { token, method: "POST" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.subscription.state).toBe("ending");
    expect(second.body.subscription.accessEndsAt).toBe(first.body.subscription.accessEndsAt);
  });
});

/* ================================================================== *
 * 4. Resume: reversible before the end date
 * ================================================================== */

describe("resuming clears the pending cancellation", () => {
  test("resume turns the renewal back on and clears the cancel date", async () => {
    const periodEnd = Date.now() + 20 * DAY;
    const token = await makePayingCustomer("resume@example.com", periodEnd);
    await call("/api/subscription/cancel", { token, method: "POST" });

    const { status, body } = await call("/api/subscription/resume", { token, method: "POST" });
    expect(status).toBe(200);
    expect(body.subscription.state).toBe("renewing");
    expect(body.subscription.renews).toBe(true);
    expect(body.subscription.canceledAt).toBeNull();
    expect(body.subscription.canCancel).toBe(true);

    const account = await findByEmail("resume@example.com");
    expect(account?.subscriptionStatus).toBe("active");
    expect(account?.canceledAt ?? null).toBeNull();
    expect(account?.entitled).toBe(true);
    expect(account?.currentPeriodEnd).toBe(new Date(periodEnd).toISOString());
  });

  test("resuming something that was never cancelled is a no-op, not an error", async () => {
    const token = await makePayingCustomer("noop@example.com", Date.now() + 20 * DAY);
    const { status, body } = await call("/api/subscription/resume", { token, method: "POST" });
    expect(status).toBe(200);
    expect(body.subscription.state).toBe("renewing");
  });

  test("there is nothing to cancel (or resume) without a paid plan", async () => {
    await registerUser("Nothing", "nothing@example.com", PASSWORD);
    const token = await issueSession("nothing@example.com");

    const cancel = await call("/api/subscription/cancel", { token, method: "POST" });
    expect(cancel.status).toBe(409);
    expect(cancel.body.error).toBe("nothing_to_cancel");

    const resume = await call("/api/subscription/resume", { token, method: "POST" });
    expect(resume.status).toBe(409);
    expect(resume.body.error).toBe("nothing_to_resume");
  });

  test("free access is not a subscription: cancelling it is refused in plain words", async () => {
    await registerUser("Comped", "comped2@example.com", PASSWORD);
    await setComp("comped2@example.com", { plan: "pro", endsAt: new Date(Date.now() + 9 * DAY).toISOString() });
    const token = await issueSession("comped2@example.com");

    const { status, body } = await call("/api/subscription/cancel", { token, method: "POST" });
    expect(status).toBe(409);
    expect(body.error).toBe("nothing_to_cancel");
    expect(body.message).toContain("free access");

    const account = await findByEmail("comped2@example.com");
    expect(account?.entitled).toBe(true); // the grant is untouched
  });
});

/* ================================================================== *
 * 5. The Stripe call behind the interface
 * ================================================================== */

interface Call {
  url: string;
  method: string;
  body: string | undefined;
  authorization: string;
}

/** A fetch double that records what was sent and replies with `status`. */
function stripeDouble(replies: Array<{ status: number; body: unknown }> = [{ status: 200, body: {} }]) {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      body: typeof init?.body === "string" ? init.body : undefined,
      authorization: headers.authorization ?? "",
    });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("the real Stripe call sits behind one interface", () => {
  test("with a key and a subscription id, cancel POSTs cancel_at_period_end=true", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    const periodEnd = Date.now() + 20 * DAY;
    const token = await makePayingCustomer("stripe@example.com", periodEnd, "sub_123");
    const { fetchImpl, calls } = stripeDouble();

    const { status, body } = await call("/api/subscription/cancel", {
      token,
      method: "POST",
      deps: { fetchImpl },
    });

    expect(status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://api.stripe.com/v1/subscriptions/sub_123");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toBe("cancel_at_period_end=true");
    expect(calls[0].authorization).toBe("Bearer sk_test_123");
    expect(body.subscription.stripe.changed).toBe(true);
    expect(body.subscription.state).toBe("ending");
    // Access is still kept — the Stripe call stops the RENEWAL, not the period.
    expect(body.subscription.entitled).toBe(true);
    expect(body.subscription.accessEndsAt).toBe(new Date(periodEnd).toISOString());
  });

  test("resume sends cancel_at_period_end=false", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    const token = await makePayingCustomer("stripe-resume@example.com", Date.now() + 20 * DAY, "sub_456");
    const first = stripeDouble();
    await call("/api/subscription/cancel", { token, method: "POST", deps: { fetchImpl: first.fetchImpl } });

    const second = stripeDouble();
    const { body } = await call("/api/subscription/resume", {
      token,
      method: "POST",
      deps: { fetchImpl: second.fetchImpl },
    });
    expect(second.calls[0].url).toBe("https://api.stripe.com/v1/subscriptions/sub_456");
    expect(second.calls[0].body).toBe("cancel_at_period_end=false");
    expect(body.subscription.state).toBe("renewing");
  });

  test("a Stripe refusal changes NOTHING and says so", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    const token = await makePayingCustomer("refused@example.com", Date.now() + 20 * DAY, "sub_789");
    const { fetchImpl } = stripeDouble([
      { status: 402, body: { error: { message: "Your card was declined.", code: "card_declined" } } },
    ]);

    const { status, body } = await call("/api/subscription/cancel", {
      token,
      method: "POST",
      deps: { fetchImpl },
    });

    expect(status).toBe(502);
    expect(body.error).toBe("stripe_refused");
    expect(body.message).toContain("Your card was declined");
    expect(body.message).toContain("unchanged");

    // Nothing was written: it still renews, and access is untouched.
    const account = await findByEmail("refused@example.com");
    expect(account?.subscriptionStatus).toBe("active");
    expect(account?.canceledAt ?? null).toBeNull();
    expect(account?.entitled).toBe(true);
  });

  test("a Stripe subscription with NO key is refused rather than cancelled on paper", async () => {
    // The dangerous state: a real Stripe subscription we cannot talk to. Recording
    // a cancellation here would promise "no further payment" while Stripe renews.
    delete process.env.STRIPE_SECRET_KEY;
    const token = await makePayingCustomer("blocked@example.com", Date.now() + 20 * DAY, "sub_live_1");

    const view = await call("/api/subscription", { token });
    expect(view.body.subscription.canCancel).toBe(false);
    expect(view.body.subscription.providerBlockedReason).toContain("support@everyonesawinner.uk");

    const { status, body } = await call("/api/subscription/cancel", { token, method: "POST" });
    expect(status).toBe(503);
    expect(body.error).toBe("provider_unreachable");

    const account = await findByEmail("blocked@example.com");
    expect(account?.subscriptionStatus).toBe("active");
  });

  test("with no key at all (today's deployment) cancelling still works on the record", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const token = await makePayingCustomer("nokey@example.com", Date.now() + 20 * DAY);
    const { fetchImpl, calls } = stripeDouble();

    const { status, body } = await call("/api/subscription/cancel", {
      token,
      method: "POST",
      deps: { fetchImpl },
    });
    expect(status).toBe(200);
    expect(calls.length).toBe(0); // nothing invented, nothing called
    expect(body.subscription.stripe.changed).toBe(false);
    expect(body.subscription.state).toBe("ending");
  });
});

/* ================================================================== *
 * 6. The custom domain can reach them
 * ================================================================== */

describe("the custom domain's router forwards the three routes", () => {
  test("the route table holds them", () => {
    expect(Object.keys(ROUTES)).toContain("subscription");
    expect(Object.keys(ROUTES)).toContain("subscription/cancel");
    expect(Object.keys(ROUTES)).toContain("subscription/resume");
  });

  test("a signed-out call is a 401 with no network call at all", async () => {
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      const res: any = {
        statusCode: 0,
        headers: {} as Record<string, string>,
        body: "",
        setHeader(k: string, v: string) {
          this.headers[k.toLowerCase()] = v;
        },
        end(b: string) {
          this.body = b ?? "";
        },
      };
      await ROUTES["subscription/cancel"](
        { method: "POST", headers: { host: "www.everyonesawinner.uk" }, url: "/api/subscription/cancel" },
        res,
      );
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toBe("not_signed_in");
      expect(called).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/* ================================================================== *
 * 7. The view itself, without HTTP
 * ================================================================== */

describe("subscriptionView reads the one record and invents nothing", () => {
  test("an expired period is 'ended' even though the status still says active", () => {
    const now = Date.now();
    const view = subscriptionView(
      {
        name: "P",
        email: "p@example.com",
        entitled: false,
        plan: "pro",
        subscriptionStatus: "active",
        currentPeriodEnd: new Date(now - DAY).toISOString(),
        graceEndsAt: null,
        comp: null,
        token: "t",
      },
      { nowMs: now },
    );
    expect(view.state).toBe("ended");
    expect(view.renews).toBe(false);
    expect(view.canCancel).toBe(false);
  });

  test("the owner seat is never billed and never cancellable", () => {
    const view = subscriptionView(
      {
        name: "Owner",
        email: "owner@everyonesawinner.uk",
        entitled: true,
        plan: "pro",
        subscriptionStatus: null,
        currentPeriodEnd: null,
        graceEndsAt: null,
        comp: null,
        owner: true,
        token: "t",
      },
      { nowMs: Date.now() },
    );
    expect(view.state).toBe("owner");
    expect(view.canCancel).toBe(false);
    expect(view.canResume).toBe(false);
  });

  test("a failed card keeps access to the grace date and can still be cancelled", () => {
    const now = Date.now();
    const view = subscriptionView(
      {
        name: "P",
        email: "pastdue@example.com",
        entitled: true,
        plan: "pro",
        subscriptionStatus: "past_due",
        currentPeriodEnd: new Date(now - DAY).toISOString(),
        graceEndsAt: new Date(now + 3 * DAY).toISOString(),
        comp: null,
        token: "t",
      },
      { nowMs: now },
    );
    expect(view.state).toBe("past_due");
    expect(view.accessEndsAt).toBe(new Date(now + 3 * DAY).toISOString());
    expect(view.canCancel).toBe(true);
  });

  test("cancelSubscription on an account that does not exist is a 404, not a crash", async () => {
    const result = await cancelSubscription("nobody@example.com", { env: {} as NodeJS.ProcessEnv });
    expect(result.status).toBe(404);
    expect(result.code).toBe("account_not_found");
    const resumed = await resumeSubscription("nobody@example.com", { env: {} as NodeJS.ProcessEnv });
    expect(resumed.status).toBe(404);
  });
});
