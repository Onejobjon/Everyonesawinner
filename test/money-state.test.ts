import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transformMatches } from "../src/lib/odds-api";
import {
  graceEndFrom,
  graceDays,
  isEntitled,
  isProEntitled,
  type SubscriptionState,
} from "../src/server/entitlement";
import {
  findEmailByStripeIds,
  findByEmail,
  registerUser,
  updateSubscription,
} from "../src/server/users";
import { handleStripeEvent, planFromPriceId } from "../src/server/stripe-webhook";
import { recentOwnerAlerts } from "../src/server/notify-owner";
import oddsHandler from "../api/odds";
import { CATALOGUE_SPORT_KEYS, resolveSportParam } from "../src/lib/sport-params";

/**
 * THE MONEY-STATE HOLES (2026-11-02).
 *
 * Each test below pins one way this code could cost the owner money or break a
 * promise the terms now make in writing:
 *
 *  1. Smarkets must never be a lay source — their API terms forbid exactly the
 *     use we were putting their prices to.
 *  2. An unknown `?sport=` on the public /api/odds must cost ZERO credits.
 *  3. Entitlement must EXPIRE: a plan with no end date, or one that has ended,
 *     is not access. One payment must not buy Pro for ever.
 *  4. An unrecognised Stripe price must grant NOTHING (it used to grant Pro).
 *  5. Subscription events must actually land, a renewal must extend the period,
 *     and a failed card must leave access ON with a grace end date.
 *  6. The Stripe ids must be persisted on the account, so a payer whose Stripe
 *     email differs from their account email still gets what they paid for.
 */

const DAY = 24 * 60 * 60 * 1000;
const PRICE_STARTER = "price_test_starter";
const PRICE_PRO = "price_test_pro";
const PRICE_ANNUAL = "price_test_annual";

let dir: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "eaw-money-state-"));
  for (const key of [
    "USERS_FILE",
    "SESSIONS_FILE",
    "DATABASE_URL",
    "ODDS_API_KEY",
    "Oddsapi",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "STRIPE_PRICE_STARTER",
    "STRIPE_PRICE_PRO",
    "STRIPE_PRICE_ANNUAL",
    "STRIPE_GRACE_DAYS",
  ]) {
    saved[key] = process.env[key];
  }
  process.env.USERS_FILE = join(dir, "users.json");
  process.env.SESSIONS_FILE = join(dir, "sessions.json");
  delete process.env.DATABASE_URL;
  // No Telegram in tests: notifyOwner() then logs and returns, never dials out.
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  process.env.STRIPE_PRICE_STARTER = PRICE_STARTER;
  process.env.STRIPE_PRICE_PRO = PRICE_PRO;
  process.env.STRIPE_PRICE_ANNUAL = PRICE_ANNUAL;
  delete process.env.STRIPE_GRACE_DAYS;
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const isoIn = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const isoAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const unixIn = (days: number) => Math.floor((Date.now() + days * DAY) / 1000);

// ── ITEM 1 — Smarkets is never a lay source ─────────────────────────────────

describe("ITEM 1: a Smarkets lay price never becomes a lay quote", () => {
  const kickoff = () => isoIn(0.25);

  const bookmaker = (
    key: string,
    title: string,
    markets: Array<{ key: string; outcomes: Array<{ name: string; price: number }> }>,
  ) => ({ key, title, last_update: isoIn(0), markets: markets.map((m) => ({ ...m, last_update: isoIn(0) })) });

  const payload = (bookmakers: unknown[]) => [
    {
      id: "evt-1",
      sport_key: "soccer_epl",
      sport_title: "Premier League",
      commence_time: kickoff(),
      home_team: "Home FC",
      away_team: "Away FC",
      bookmakers,
    },
  ];

  const h2h = (home: number, away: number) => ({
    key: "h2h",
    outcomes: [
      { name: "Home FC", price: home },
      { name: "Away FC", price: away },
    ],
  });
  const h2hLay = (home: number, away: number) => ({
    key: "h2h_lay",
    outcomes: [
      { name: "Home FC", price: home },
      { name: "Away FC", price: away },
    ],
  });

  test("a payload with ONLY Smarkets lay prices produces NO lay quote at all", () => {
    const matches = transformMatches(
      payload([
        bookmaker("williamhill", "William Hill", [h2h(2.5, 3.0)]),
        bookmaker("smarkets", "Smarkets", [h2hLay(2.6, 3.1)]),
      ]) as never,
    );
    expect(matches.length).toBe(1);
    for (const outcome of matches[0]!.outcomes) {
      expect(outcome.layOdds).toBeNull();
      expect(outcome.laySource).toBeNull();
      expect(outcome.layBookmakerKey).toBeNull();
    }
    // And the league is not advertised as having exchange lay coverage.
    expect(matches[0]!.hasLayCoverage).toBe(false);
  });

  test("the same payload WITH Betfair still produces a Betfair lay quote", () => {
    const matches = transformMatches(
      payload([
        bookmaker("williamhill", "William Hill", [h2h(2.5, 3.0)]),
        bookmaker("smarkets", "Smarkets", [h2hLay(2.6, 3.1)]),
        bookmaker("betfair_ex_uk", "Betfair", [h2hLay(2.7, 3.2)]),
      ]) as never,
    );
    const home = matches[0]!.outcomes.find((o) => o.name === "Home FC")!;
    expect(home.layOdds).toBe(2.7);
    expect(home.layBookmakerKey).toBe("betfair_ex_uk");
    expect(matches[0]!.hasLayCoverage).toBe(true);
  });
});

// ── ITEM 2 — an unknown sport costs nothing ─────────────────────────────────

describe("ITEM 2: /api/odds refuses an unknown sport without spending a credit", () => {
  const calls: string[] = [];
  let realFetch: typeof globalThis.fetch;

  function fakeRes() {
    const res = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: "",
      setHeader(k: string, v: string) {
        res.headers[k] = v;
      },
      end(b: string) {
        res.body = b;
      },
    };
    return res;
  }

  beforeAll(() => {
    realFetch = globalThis.fetch;
    process.env.ODDS_API_KEY = "test-key-not-a-secret";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify([{ id: "evt-1" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (saved.ODDS_API_KEY === undefined) delete process.env.ODDS_API_KEY;
    else process.env.ODDS_API_KEY = saved.ODDS_API_KEY;
  });

  test("an invented sport key is a 400 and the upstream is never called", async () => {
    calls.length = 0;
    const res = fakeRes();
    await oddsHandler({ url: "/api/odds?sport=my_own_invented_league", headers: { host: "x" } }, res);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("sport_not_supported");
    // THE POINT: zero upstream requests, therefore zero credits.
    expect(calls).toEqual([]);
  });

  test("a plausible-but-unlisted key is refused too (no prefix guessing)", async () => {
    calls.length = 0;
    const res = fakeRes();
    await oddsHandler({ url: "/api/odds?sport=soccer_england_premier_league", headers: { host: "x" } }, res);
    expect(res.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  test("a catalogue competition still works, and is the only thing that reaches the upstream", async () => {
    calls.length = 0;
    const res = fakeRes();
    await oddsHandler({ url: "/api/odds?sport=soccer_epl", headers: { host: "x" } }, res);
    expect(res.statusCode).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("/sports/soccer_epl/odds");
  });

  test("no sport at all still means the all-sports feed", async () => {
    calls.length = 0;
    const res = fakeRes();
    await oddsHandler({ url: "/api/odds", headers: { host: "x" } }, res);
    expect(res.statusCode).toBe(200);
    expect(calls[0]).toContain("/sports/upcoming/odds");
  });

  test("the accepted set is the catalogue, and both servers carry the same one", () => {
    expect(resolveSportParam(null)).toBe("upcoming");
    expect(resolveSportParam("")).toBe("upcoming");
    expect(resolveSportParam("soccer_epl")).toBe("soccer_epl");
    expect(resolveSportParam("nonsense")).toBeNull();

    // api/odds.ts cannot import from src/, so it carries a copy. If the two ever
    // disagree this fails — the copy cannot rot silently.
    const source = readFileSync(join(import.meta.dir, "..", "api", "odds.ts"), "utf8");
    const listBody = source.split("new Set([")[1]?.split("])")[0] ?? "";
    const apiSports = new Set<string>();
    for (const m of listBody.matchAll(/"([a-z0-9_]+)"/g) as Iterable<RegExpExecArray>) {
      apiSports.add(m[1]!);
    }
    const expected = new Set(["upcoming", ...CATALOGUE_SPORT_KEYS]);
    expect(Array.from(apiSports).sort()).toEqual(Array.from(expected).sort());
  });
});

// ── ITEM 3 — the one entitlement rule, and it expires ───────────────────────

describe("ITEM 3: entitlement is one rule, and a paid period that has passed is not access", () => {
  const base = (over: Partial<SubscriptionState> = {}): SubscriptionState => ({
    plan: "pro",
    status: "active",
    currentPeriodEnd: isoIn(10),
    graceEndsAt: null,
    ...over,
  });

  test("an active plan whose period has ENDED is not entitled", () => {
    expect(isEntitled(base({ currentPeriodEnd: isoAgo(1) }))).toBe(false);
    expect(isEntitled(base({ currentPeriodEnd: isoIn(1) }))).toBe(true);
  });

  test("a plan with no period end is not entitled — one payment cannot buy for ever", () => {
    expect(isEntitled(base({ currentPeriodEnd: null }))).toBe(false);
    expect(isEntitled(base({ currentPeriodEnd: "not-a-date" }))).toBe(false);
  });

  test("a plan we do not sell grants nothing, whatever the status says", () => {
    expect(isEntitled(base({ plan: "platinum" as never }))).toBe(false);
    expect(isEntitled(base({ plan: null }))).toBe(false);
    // Cancelled INSIDE a period that was already paid for keeps access to the end
    // of that period (terms §8), and no further. Refunded/unpaid do not.
    expect(isEntitled(base({ status: "canceled" }))).toBe(true);
    expect(isEntitled(base({ status: "canceled", currentPeriodEnd: isoAgo(1) }))).toBe(false);
    expect(isEntitled(base({ status: "refunded" }))).toBe(false);
    expect(isEntitled(base({ status: "unpaid" }))).toBe(false);
  });

  test("the failed-payment grace window keeps access, and its end date closes it", () => {
    const inGrace = base({ status: "past_due", currentPeriodEnd: isoAgo(1), graceEndsAt: isoIn(3) });
    expect(isEntitled(inGrace)).toBe(true);
    expect(isEntitled({ ...inGrace, graceEndsAt: isoAgo(1) })).toBe(false);
    expect(isEntitled({ ...inGrace, graceEndsAt: null })).toBe(false);
  });

  test("the owner's comped seat needs no subscription and no dates", () => {
    expect(
      isEntitled({ plan: "pro", status: null, currentPeriodEnd: null, graceEndsAt: null, ownerSeat: true }),
    ).toBe(true);
  });

  test("Pro-only tools need a Pro plan AND entitlement", () => {
    expect(isProEntitled(base())).toBe(true);
    expect(isProEntitled(base({ plan: "starter" }))).toBe(false);
    expect(isProEntitled(base({ currentPeriodEnd: isoAgo(1) }))).toBe(false);
  });

  test("the grace window has a real, quotable end date", () => {
    const end = graceEndFrom();
    const days = (Date.parse(end) - Date.now()) / DAY;
    expect(days).toBeGreaterThan(graceDays() - 1);
    expect(days).toBeLessThanOrEqual(graceDays() + 0.01);
  });
});

// ── ITEMS 4, 5, 6 — the Stripe events ───────────────────────────────────────

describe("ITEMS 4–6: Stripe events grant, renew, grace and link correctly", () => {
  const password = "CorrectHorse9!";

  async function account(email: string) {
    await registerUser(email.split("@")[0]!, email, password);
    return email;
  }

  /** The raw stored record — proves what actually reached the disk. */
  function storedRecord(email: string): Record<string, any> | null {
    const all = JSON.parse(readFileSync(process.env.USERS_FILE!, "utf8")) as Record<string, any>;
    return all[email] ?? null;
  }

  const subscriptionEvent = (type: string, obj: Record<string, any>) => ({ type, data: { object: obj } });

  test("ITEM 4: a Starter price buys Starter — never Pro", async () => {
    const email = await account("starter@example.com");
    expect(planFromPriceId(PRICE_STARTER)).toBe("starter");
    expect(planFromPriceId(PRICE_PRO)).toBe("pro");
    expect(planFromPriceId(PRICE_ANNUAL)).toBe("annual");
    expect(planFromPriceId("price_someone_else_made")).toBeNull();
    expect(planFromPriceId(undefined)).toBeNull();

    await handleStripeEvent(
      subscriptionEvent("customer.subscription.created", {
        id: "sub_starter_1",
        customer: "cus_starter_1",
        status: "active",
        metadata: { email },
        items: { data: [{ price: { id: PRICE_STARTER }, current_period_end: unixIn(30) }] },
      }),
    );

    const user = await findByEmail(email);
    expect(user?.plan).toBe("starter");
    expect(user?.entitled).toBe(true);
    // The Pro tools stay locked: this is the tier they paid for.
    expect(isProEntitled({ plan: user!.plan, status: "active", currentPeriodEnd: user!.currentPeriodEnd, graceEndsAt: null })).toBe(false);
  });

  test("ITEM 4: an unrecognised price grants NOTHING and alerts the owner", async () => {
    const email = await account("unrecognised@example.com");
    const before = recentOwnerAlerts().length;

    const note = await handleStripeEvent(
      subscriptionEvent("customer.subscription.created", {
        id: "sub_unknown_1",
        customer: "cus_unknown_1",
        status: "active",
        metadata: { email },
        items: { data: [{ price: { id: "price_we_never_configured" }, current_period_end: unixIn(30) }] },
      }),
    );

    const user = await findByEmail(email);
    expect(user?.plan).toBeNull(); // no guessed tier
    expect(user?.entitled).toBe(false); // and therefore no access
    expect(note).toContain("plan unchanged");

    const alerts = recentOwnerAlerts().slice(before);
    expect(alerts.some((a) => a.text.includes("unrecognised price id price_we_never_configured"))).toBe(true);
  });

  test("ITEM 5 + 6: checkout stores the Stripe ids, and a later event finds the account by them", async () => {
    const email = await account("linked@example.com");

    // Checkout: the only event that carries the email. It links, and grants
    // nothing yet — the tier and the dates come from the subscription.
    await handleStripeEvent({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          mode: "subscription",
          customer: "cus_linked_1",
          subscription: "sub_linked_1",
          metadata: { email },
          customer_details: { email },
        },
      },
    });

    const record = storedRecord(email)!;
    expect(record.stripeCustomerId).toBe("cus_linked_1");
    expect(record.stripeSubscriptionId).toBe("sub_linked_1");
    expect(await findEmailByStripeIds({ customerId: "cus_linked_1" })).toBe(email);
    expect(await findEmailByStripeIds({ subscriptionId: "sub_linked_1" })).toBe(email);
    // Ids alone are not access.
    expect((await findByEmail(email))?.entitled).toBe(false);

    // Stripe does NOT put our email on the subscription object. The stored
    // customer id is what makes this event land.
    const note = await handleStripeEvent(
      subscriptionEvent("customer.subscription.created", {
        id: "sub_linked_1",
        customer: "cus_linked_1",
        status: "active",
        items: { data: [{ price: { id: PRICE_PRO }, current_period_end: unixIn(30) }] },
      }),
    );
    expect(note).toContain("linked@example.com");

    const user = await findByEmail(email);
    expect(user?.plan).toBe("pro");
    expect(user?.entitled).toBe(true);
    expect(Date.parse(user!.currentPeriodEnd!)).toBeGreaterThan(Date.now());
  });

  test("ITEM 5: a renewal extends the paid period", async () => {
    const email = await account("renewing@example.com");
    await updateSubscription(email, {
      plan: "pro",
      status: "active",
      currentPeriodEnd: isoIn(2),
      customerId: "cus_renewing_1",
      subscriptionId: "sub_renewing_1",
    });

    await handleStripeEvent({
      type: "invoice.paid",
      data: {
        object: {
          id: "in_renewal_1",
          customer: "cus_renewing_1",
          subscription: "sub_renewing_1",
          lines: { data: [{ price: { id: PRICE_PRO }, period: { end: unixIn(32) } }] },
        },
      },
    });

    const user = await findByEmail(email);
    expect(user?.entitled).toBe(true);
    expect(Date.parse(user!.currentPeriodEnd!)).toBeGreaterThan(Date.now() + 30 * DAY);
  });

  test("ITEM 5: a failed card leaves access ON and records the date the email will quote", async () => {
    const email = await account("failing@example.com");
    await handleStripeEvent(
      subscriptionEvent("customer.subscription.created", {
        id: "sub_failing_1",
        customer: "cus_failing_1",
        status: "active",
        metadata: { email },
        items: { data: [{ price: { id: PRICE_PRO }, current_period_end: unixIn(0.5) }] },
      }),
    );
    expect((await findByEmail(email))?.entitled).toBe(true);

    const before = recentOwnerAlerts().length;
    const note = await handleStripeEvent({
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_failed_1",
          customer: "cus_failing_1",
          subscription: "sub_failing_1",
          lines: { data: [{ price: { id: PRICE_PRO } }] },
        },
      },
    });
    expect(note).toContain("in grace until");

    const user = await findByEmail(email);
    // THE PROMISE: no instant lock-out.
    expect(user?.entitled).toBe(true);
    expect(user?.subscriptionStatus).toBe("past_due");
    expect(user?.graceEndsAt).toBeTruthy();
    expect(Date.parse(user!.graceEndsAt!)).toBeGreaterThan(Date.now());
    // The owner is told, and the date is in the record for the customer email.
    expect(recentOwnerAlerts().slice(before).some((a) => a.text.includes("grace until"))).toBe(true);

    // A second failure must not move the date the customer was told.
    const firstGraceEnd = user!.graceEndsAt;
    await handleStripeEvent({
      type: "invoice.payment_failed",
      data: { object: { id: "in_failed_2", customer: "cus_failing_1", subscription: "sub_failing_1" } },
    });
    expect((await findByEmail(email))?.graceEndsAt).toBe(firstGraceEnd);

    // When the grace date passes, access ends — the date governs, not the status.
    await updateSubscription(email, { graceEndsAt: isoAgo(0.1) });
    expect((await findByEmail(email))?.entitled).toBe(false);
  });

  test("ITEM 5: a cancellation records the status without inventing a new end date", async () => {
    const email = await account("cancelled@example.com");
    const paidTo = isoIn(5);
    await updateSubscription(email, {
      plan: "pro",
      status: "active",
      currentPeriodEnd: paidTo,
      customerId: "cus_cancelled_1",
      subscriptionId: "sub_cancelled_1",
    });

    await handleStripeEvent(
      subscriptionEvent("customer.subscription.deleted", {
        id: "sub_cancelled_1",
        customer: "cus_cancelled_1",
        status: "canceled",
        items: { data: [] },
      }),
    );

    const user = await findByEmail(email);
    expect(user?.subscriptionStatus).toBe("canceled");
    expect(user?.currentPeriodEnd).toBe(paidTo); // not rewritten
    // Terms §8: cancelling stops future billing but does NOT end the plan on the
    // spot — access runs to the end of the period already paid for (2026-11-03;
    // this used to be an instant lock-out, which contradicted the terms page).
    expect(user?.entitled).toBe(true);
    const state = {
      plan: user!.plan,
      status: user!.subscriptionStatus,
      currentPeriodEnd: user!.currentPeriodEnd,
      graceEndsAt: user!.graceEndsAt,
    };
    expect(isEntitled(state, Date.parse(paidTo) - 60_000)).toBe(true);
    expect(isEntitled(state, Date.parse(paidTo) + 60_000)).toBe(false);
  });

  test("ITEM 6: an event for an account that does not exist is loud, not silent", async () => {
    const before = recentOwnerAlerts().length;
    const note = await handleStripeEvent(
      subscriptionEvent("customer.subscription.created", {
        id: "sub_ghost_1",
        customer: "cus_ghost_1",
        status: "active",
        metadata: { email: "nobody@example.com" },
        items: { data: [{ price: { id: PRICE_PRO }, current_period_end: unixIn(30) }] },
      }),
    );
    expect(note).toContain("owner alerted");
    const alerts = recentOwnerAlerts().slice(before);
    expect(alerts.some((a) => a.text.includes("could not tie subscription sub_ghost_1"))).toBe(true);
  });

  test("an event type we do not handle is ignored, and does not throw", async () => {
    const note = await handleStripeEvent({ type: "customer.updated", data: { object: {} } });
    expect(note).toBe("customer.updated: ignored");
  });
});
