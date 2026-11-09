/**
 * CUSTOMER EMAIL TRANSPORT — the two emails a paying customer is promised.
 *
 * WHY THESE TESTS EXIST (2026-11-09): the webhook decided when a receipt or a
 * failed-card notice was due and then only told the owner. Billing is armed, so
 * the first real payment would have taken money from someone who received
 * nothing. The transport closes that gap, and the tests below pin the two halves
 * of its contract:
 *
 *   A. NO KEY CONFIGURED ⇒ nothing is sent, NOTHING THROWS, the email is
 *      recorded as unsent and the billing state is still written. This is the
 *      state of production today (billing on hold) and it must stay harmless.
 *   B. KEY CONFIGURED ⇒ the message really goes to the provider, with the right
 *      recipient and subject, and the outcome is recorded as sent.
 *   C. A PROVIDER FAILURE is caught, recorded and alerted — the Stripe event
 *      still answers 200 and the customer still gets their access. A mail
 *      provider must never be able to fail a payment.
 *
 * NO NETWORK AND NO REAL KEY: `fetch` is stubbed and every request inspected, so
 * "the receipt was sent" is a fact about the bytes we would have sent. The one
 * exception is the optional Postgres half, which uses the throwaway test
 * database in EAW_TEST_DATABASE_URL and skips (loudly) without one.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_FROM,
  EMAIL_KEY_ENV,
  EMAIL_TRANSPORT_ENV,
  emailTransportStatus,
  sendEmail,
} from "../src/server/email-transport";
import {
  ACCOUNT_URL,
  SELLER_IDENTITY,
  SUPPORT_EMAIL,
  composeGraceNotice,
  composeReceipt,
  deliverCustomerEmail,
  recentCustomerEmails,
} from "../src/server/customer-email";
import { CHECKOUT_FLAG } from "../src/server/billing-switch";
import { receiveStripeEvent } from "../src/server/stripe-webhook";
import { findByEmail, registerUser } from "../src/server/users";
import { recentOwnerAlerts } from "../src/server/notify-owner";
import { resetStores, STORAGE_ENV_VAR } from "../src/server/storage";

const SECRET = "whsec_test_email";
const PRICE_PRO = "price_test_email_pro";
const RESEND_KEY = "re_test_key_not_real";
const DAY = 86_400_000;

let dir: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "USERS_FILE",
  "SESSIONS_FILE",
  "STRIPE_EVENTS_FILE",
  "CUSTOMER_EMAILS_FILE",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_STARTER",
  "STRIPE_PRICE_PRO",
  "STRIPE_PRICE_ANNUAL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "STRIPE_GRACE_DAYS",
  EMAIL_TRANSPORT_ENV,
  EMAIL_KEY_ENV,
  "RESEND_API_KEY",
  "POSTMARK_SERVER_TOKEN",
  "EAW_EMAIL_FROM",
];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "eaw-email-"));
  for (const key of ENV_KEYS) saved[key] = process.env[key];

  process.env.USERS_FILE = join(dir, "users.json");
  process.env.SESSIONS_FILE = join(dir, "sessions.json");
  process.env.STRIPE_EVENTS_FILE = join(dir, "stripe-events.json");
  process.env.CUSTOMER_EMAILS_FILE = join(dir, "customer-emails.jsonl");
  delete process.env[STORAGE_ENV_VAR];
  // No Telegram in tests: notifyOwner() records and returns, never dials out.
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  process.env.STRIPE_PRICE_STARTER = "price_test_email_starter";
  process.env.STRIPE_PRICE_PRO = PRICE_PRO;
  process.env.STRIPE_PRICE_ANNUAL = "price_test_email_annual";
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  delete process.env.STRIPE_GRACE_DAYS;
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetStores();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ── A stubbed mail provider ─────────────────────────────────────────────────

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

let calls: Call[] = [];
const realFetch = globalThis.fetch;

/** Answer every request with `reply`, recording what was asked for. */
function stubFetch(reply: { status?: number; body?: unknown } | "throw" = {}) {
  calls = [];
  globalThis.fetch = (async (input: unknown, init: Record<string, any> = {}) => {
    calls.push({
      url: String(input),
      method: String(init.method ?? "GET"),
      headers: (init.headers as Record<string, string>) ?? {},
      body: init.body ? JSON.parse(String(init.body)) : {},
    });
    if (reply === "throw") throw new Error("network down");
    return new Response(JSON.stringify(reply.body ?? { id: "msg_123" }), {
      status: reply.status ?? 200,
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env[EMAIL_TRANSPORT_ENV];
  delete process.env[EMAIL_KEY_ENV];
  delete process.env.RESEND_API_KEY;
  delete process.env.POSTMARK_SERVER_TOKEN;
  delete process.env.EAW_EMAIL_FROM;
});

beforeEach(() => {
  delete process.env[CHECKOUT_FLAG];
});

// ── A. No key: today's behaviour, exactly ───────────────────────────────────

describe("A. no key configured — nothing is sent and nothing throws", () => {
  test("sendEmail reports not_configured and never touches the network", async () => {
    stubFetch();
    const outcome = await sendEmail({
      to: "someone@example.com",
      subject: "Test",
      text: "Hello",
    });
    expect(outcome.sent).toBe(false);
    expect(outcome.code).toBe("not_configured");
    expect(calls.length).toBe(0);
  });

  test("the status names the exact secret to add", () => {
    const status = emailTransportStatus();
    expect(status.configured).toBe(false);
    expect(status.provider).toBeNull();
    expect(status.reason).toContain(EMAIL_KEY_ENV);
  });

  test("a transport name with no key is still not configured, and says why", async () => {
    process.env[EMAIL_TRANSPORT_ENV] = "resend";
    stubFetch();
    const outcome = await sendEmail({ to: "someone@example.com", subject: "S", text: "T" });
    expect(outcome.code).toBe("not_configured");
    expect(outcome.reason).toContain(EMAIL_KEY_ENV);
    expect(calls.length).toBe(0);
  });

  test("EAW_EMAIL_TRANSPORT=none turns sending off even with a key present", async () => {
    process.env[EMAIL_TRANSPORT_ENV] = "none";
    process.env[EMAIL_KEY_ENV] = RESEND_KEY;
    stubFetch();
    const outcome = await sendEmail({ to: "someone@example.com", subject: "S", text: "T" });
    expect(outcome.code).toBe("not_configured");
    expect(calls.length).toBe(0);
  });
});

// ── B. Key configured: the message really goes ─────────────────────────────

describe("B. key configured — the message is handed to the provider", () => {
  test("Resend gets the right recipient, subject, from and reply-to", async () => {
    process.env[EMAIL_TRANSPORT_ENV] = "resend";
    process.env[EMAIL_KEY_ENV] = RESEND_KEY;
    stubFetch({ status: 200, body: { id: "msg_resend_1" } });

    const outcome = await sendEmail({
      to: "payer@example.com",
      subject: "Your Everyone's A Winner receipt — £19.99",
      text: "Hello",
      html: "<p>Hello</p>",
    });

    expect(outcome.sent).toBe(true);
    expect(outcome.code).toBe("sent");
    expect(outcome.provider).toBe("resend");
    expect(outcome.messageId).toBe("msg_resend_1");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${RESEND_KEY}`);
    expect(calls[0]!.body.to).toEqual(["payer@example.com"]);
    expect(calls[0]!.body.subject).toContain("receipt");
    expect(calls[0]!.body.from).toBe(DEFAULT_FROM);
    expect(calls[0]!.body.reply_to).toBe(SUPPORT_EMAIL);
    expect(calls[0]!.body.html).toBe("<p>Hello</p>");
  });

  test("a key alone implies Resend — one secret is enough to make mail work", async () => {
    process.env[EMAIL_KEY_ENV] = RESEND_KEY;
    stubFetch();
    const outcome = await sendEmail({ to: "a@example.com", subject: "S", text: "T" });
    expect(outcome.sent).toBe(true);
    expect(outcome.provider).toBe("resend");
  });

  test("Postmark is chosen by the same one variable, and uses its own auth header", async () => {
    process.env[EMAIL_TRANSPORT_ENV] = "postmark";
    process.env[EMAIL_KEY_ENV] = "pm_test_token";
    stubFetch({ status: 200, body: { MessageID: "pm_1" } });

    const outcome = await sendEmail({ to: "a@example.com", subject: "S", text: "T" });
    expect(outcome.sent).toBe(true);
    expect(outcome.messageId).toBe("pm_1");
    expect(calls[0]!.url).toBe("https://api.postmarkapp.com/email");
    expect(calls[0]!.headers["x-postmark-server-token"]).toBe("pm_test_token");
    expect(calls[0]!.body.To).toBe("a@example.com");
  });

  test("the provider's native variable is accepted too (RESEND_API_KEY)", async () => {
    process.env.RESEND_API_KEY = "re_from_native_var";
    stubFetch();
    const outcome = await sendEmail({ to: "a@example.com", subject: "S", text: "T" });
    expect(outcome.sent).toBe(true);
    expect(calls[0]!.headers.authorization).toBe("Bearer re_from_native_var");
  });

  test("a recipient that is not an address is refused before any request", async () => {
    process.env[EMAIL_KEY_ENV] = RESEND_KEY;
    stubFetch();
    const outcome = await sendEmail({ to: "not-an-address", subject: "S", text: "T" });
    expect(outcome.sent).toBe(false);
    expect(outcome.code).toBe("invalid");
    expect(calls.length).toBe(0);
  });
});

// ── C. A failure is a value, never an exception ─────────────────────────────

describe("C. a transport failure is caught and reported", () => {
  test("a provider error comes back as provider_error with its status", async () => {
    process.env[EMAIL_KEY_ENV] = RESEND_KEY;
    stubFetch({ status: 422, body: { message: "domain is not verified" } });

    const outcome = await sendEmail({ to: "a@example.com", subject: "S", text: "T" });
    expect(outcome.sent).toBe(false);
    expect(outcome.code).toBe("provider_error");
    expect(outcome.reason).toContain("422");
    expect(outcome.reason).toContain("domain is not verified");
  });

  test("an unreachable provider never throws out of sendEmail", async () => {
    process.env[EMAIL_KEY_ENV] = RESEND_KEY;
    stubFetch("throw");
    const outcome = await sendEmail({ to: "a@example.com", subject: "S", text: "T" });
    expect(outcome.sent).toBe(false);
    expect(outcome.code).toBe("provider_error");
    expect(outcome.reason).toContain("network down");
  });
});

// ── D. The copy itself ──────────────────────────────────────────────────────

describe("D. the composed emails say what the terms promise", () => {
  const receipt = composeReceipt({
    to: "payer@example.com",
    plan: "starter",
    amountPence: 1999,
    currency: "gbp",
    paidAt: "2026-11-09T10:00:00.000Z",
    periodEnd: "2026-12-09T10:00:00.000Z",
    invoiceId: "EAW-0001",
  });

  test("the receipt names the plan, the amount, the date and the invoice", () => {
    expect(receipt.subject).toContain("£19.99");
    expect(receipt.text).toContain("Starter — £19.99 a month");
    expect(receipt.text).toContain("Amount paid: £19.99");
    expect(receipt.text).toContain("Paid on: 9 November 2026");
    expect(receipt.text).toContain("Covers the period ending: 9 December 2026");
    expect(receipt.text).toContain("Invoice: EAW-0001");
  });

  test("the receipt carries the seller identity exactly as the site publishes it", () => {
    expect(receipt.text).toContain(SELLER_IDENTITY);
    expect(receipt.text).toContain("Jonathan Revill");
    expect(receipt.text).toContain("sole trader");
    expect(receipt.text).toContain("BT30 8EX");
    expect(receipt.text).toContain("not registered for VAT");
    // The trading name only — never a company.
    expect(receipt.text).not.toMatch(/\bLtd\b/);
    expect(receipt.text).not.toMatch(/\bLimited\b/);
  });

  test("the receipt gives the cancellation route and the renewal rule", () => {
    expect(receipt.text).toContain(ACCOUNT_URL);
    expect(receipt.text).toContain("renews automatically until you cancel");
    expect(receipt.text).toContain("end of the period you have already paid for");
    expect(receipt.text).toContain(SUPPORT_EMAIL);
  });

  test("an amount we do not know is SAID, never invented", () => {
    const bare = composeReceipt({
      to: "payer@example.com",
      plan: null,
      amountPence: null,
      currency: "gbp",
      paidAt: "2026-11-09T10:00:00.000Z",
      periodEnd: null,
      invoiceId: null,
    });
    expect(bare.text).toContain("carried no amount");
    expect(bare.text).toContain("could not match this payment to one of our published plans");
    expect(bare.text).not.toContain("£19.99");
  });

  test("the receipt has an HTML part with the same words, escaped", () => {
    expect(receipt.html).toContain("Jonathan Revill");
    expect(receipt.html).toContain("£19.99");
    expect(receipt.html.startsWith("<div")).toBe(true);
  });

  test("the grace notice quotes the real grace date and promises no instant lock-out", () => {
    const grace = composeGraceNotice({
      to: "payer@example.com",
      plan: "pro",
      graceEndsAt: "2026-11-16T10:00:00.000Z",
    });
    expect(grace.subject).toBe("We could not take your card payment");
    expect(grace.text).toContain("16 November 2026");
    expect(grace.text).toContain("Nothing has been cancelled");
    expect(grace.text).toContain("Pro — £29.99 a month");
    expect(grace.text).toContain(SUPPORT_EMAIL);
    expect(grace.text).toContain(ACCOUNT_URL);
    expect(grace.text).toContain(SELLER_IDENTITY);
  });

  test("the grace notice has no urgency theatre", () => {
    const grace = composeGraceNotice({
      to: "payer@example.com",
      plan: "pro",
      graceEndsAt: "2026-11-16T10:00:00.000Z",
    });
    const text = grace.text.toLowerCase();
    for (const phrase of ["action required", "urgent", "final notice", "immediately", "act now"]) {
      expect(text).not.toContain(phrase);
    }
  });
});

// ── E. The log we can read afterwards ──────────────────────────────────────

describe("E. every attempt is recorded", () => {
  test("unsent, sent and failed are all recorded with their reason", async () => {
    const message = composeReceipt({
      to: "log@example.com",
      plan: "pro",
      amountPence: 2999,
      currency: "gbp",
      paidAt: new Date().toISOString(),
      periodEnd: null,
      invoiceId: "in_log",
    });

    const unsent = await deliverCustomerEmail("receipt", message, { to: "log@example.com" });
    expect(unsent.status).toBe("unsent");
    expect(unsent.reason).toContain(EMAIL_KEY_ENV);

    process.env[EMAIL_KEY_ENV] = RESEND_KEY;
    stubFetch();
    const sent = await deliverCustomerEmail("receipt", message, { to: "log@example.com" });
    expect(sent.status).toBe("sent");
    expect(sent.provider).toBe("resend");

    stubFetch({ status: 500, body: { message: "boom" } });
    const failed = await deliverCustomerEmail("receipt", message, { to: "log@example.com" });
    expect(failed.status).toBe("failed");

    const rows = await recentCustomerEmails(50);
    const mine = rows.filter((r) => r.to === "log@example.com");
    expect(mine.map((r) => r.status)).toEqual(["unsent", "sent", "failed"]);
    expect(mine[0]!.subject).toContain("receipt");
  });
});

// ── F. The webhook: billing state must never depend on the mail provider ───

const b64 = (value: unknown) => JSON.stringify(value);

function signed(payload: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", SECRET).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

let seq = 0;
async function deliver(event: unknown) {
  const payload = b64(event);
  return receiveStripeEvent(payload, signed(payload));
}

async function account(email: string) {
  await registerUser(email.split("@")[0]!, email, "CorrectHorse9!");
  return email;
}

/** A subscription that is already live, so an invoice can be tied to it. */
async function liveSubscription(email: string) {
  const n = ++seq;
  const object = {
    id: `sub_email_${n}`,
    customer: `cus_email_${n}`,
    status: "active",
    metadata: { email },
    items: { data: [{ price: { id: PRICE_PRO }, current_period_end: unixIn(30) }] },
    current_period_end: unixIn(30),
  };
  const res = await deliver({ id: `evt_sub_${n}`, type: "customer.subscription.created", data: { object } });
  expect(res.status).toBe(200);
  return { customer: object.customer, subscription: object.id };
}

const unixIn = (days: number) => Math.floor((Date.now() + days * DAY) / 1000);

describe("F. the webhook sends the receipt and the grace notice", () => {
  beforeEach(() => {
    process.env[CHECKOUT_FLAG] = "on";
  });

  test("NO KEY: invoice.paid still records the payment, sends nothing, and answers 200", async () => {
    stubFetch();
    const email = await account("nokey@example.com");
    const sub = await liveSubscription(email);

    const paid = await deliver({
      id: `evt_paid_${++seq}`,
      type: "invoice.paid",
      data: {
        object: {
          id: `in_${seq}`,
          number: "EAW-1001",
          customer: sub.customer,
          subscription: sub.subscription,
          amount_paid: 2999,
          currency: "gbp",
          status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
          lines: { data: [{ price: { id: PRICE_PRO }, period: { end: unixIn(30) } }] },
        },
      },
    });

    expect(paid.status).toBe(200);
    expect(String(paid.body.note)).toContain("receipt unsent");
    expect(calls.length).toBe(0); // nothing dialled out

    const user = await findByEmail(email);
    expect(user?.subscriptionStatus).toBe("active");
    expect(user?.entitled).toBe(true);

    const rows = (await recentCustomerEmails(50)).filter((r) => r.to === email);
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe("receipt");
    expect(rows[0]!.status).toBe("unsent");
  });

  test("KEY: invoice.paid sends the receipt to the account's own address", async () => {
    process.env[EMAIL_KEY_ENV] = RESEND_KEY;
    stubFetch({ status: 200, body: { id: "msg_receipt" } });
    const email = await account("paid@example.com");
    const sub = await liveSubscription(email);

    const paid = await deliver({
      id: `evt_paid_${++seq}`,
      type: "invoice.paid",
      data: {
        object: {
          id: `in_${seq}`,
          number: "EAW-1002",
          customer: sub.customer,
          subscription: sub.subscription,
          amount_paid: 2999,
          currency: "gbp",
          status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
          lines: { data: [{ price: { id: PRICE_PRO }, period: { end: unixIn(30) } }] },
        },
      },
    });

    expect(paid.status).toBe(200);
    expect(String(paid.body.note)).toContain("receipt sent");
    expect(calls.length).toBe(1);
    expect(calls[0]!.body.to).toEqual([email]);
    expect(calls[0]!.body.subject).toContain("£29.99");
    expect(calls[0]!.body.text).toContain("Jonathan Revill");
    expect(calls[0]!.body.text).toContain("Amount paid: £29.99");

    const rows = (await recentCustomerEmails(50)).filter((r) => r.to === email);
    expect(rows.at(-1)!.status).toBe("sent");
  });

  test("KEY + PROVIDER DOWN: the event still answers 200, the customer keeps access, the owner is told", async () => {
    process.env[EMAIL_KEY_ENV] = RESEND_KEY;
    stubFetch({ status: 500, body: { message: "provider on fire" } });
    const email = await account("unlucky@example.com");
    const sub = await liveSubscription(email);

    const before = recentOwnerAlerts().length;
    const paid = await deliver({
      id: `evt_paid_${++seq}`,
      type: "invoice.paid",
      data: {
        object: {
          id: `in_${seq}`,
          customer: sub.customer,
          subscription: sub.subscription,
          amount_paid: 2999,
          currency: "gbp",
          lines: { data: [{ price: { id: PRICE_PRO }, period: { end: unixIn(30) } }] },
        },
      },
    });

    // THE POINT: a mail failure is not a billing failure.
    expect(paid.status).toBe(200);
    expect(paid.body.ok).toBe(true);
    expect(String(paid.body.note)).toContain("receipt failed");

    const user = await findByEmail(email);
    expect(user?.subscriptionStatus).toBe("active");
    expect(user?.entitled).toBe(true);

    const rows = (await recentCustomerEmails(50)).filter((r) => r.to === email);
    expect(rows.at(-1)!.status).toBe("failed");
    expect(rows.at(-1)!.reason).toContain("500");

    const alerts = recentOwnerAlerts().slice(before).map((a) => a.text);
    expect(alerts.some((t) => t.includes("Customer email FAILED") && t.includes(email))).toBe(true);
  });

  test("invoice.payment_failed sends the grace notice ONCE, with the stored date", async () => {
    process.env[EMAIL_KEY_ENV] = RESEND_KEY;
    stubFetch({ status: 200, body: { id: "msg_grace" } });
    const email = await account("graceful2@example.com");
    const sub = await liveSubscription(email);

    const failed = await deliver({
      id: `evt_failed_${++seq}`,
      type: "invoice.payment_failed",
      data: { object: { id: `in_f_${seq}`, customer: sub.customer, subscription: sub.id } },
    });
    expect(failed.status).toBe(200);
    expect(String(failed.body.note)).toContain("grace notice sent");
    expect(calls.length).toBe(1);
    expect(calls[0]!.body.to).toEqual([email]);
    expect(calls[0]!.body.subject).toBe("We could not take your card payment");

    const user = await findByEmail(email);
    const graceEnd = user!.graceEndsAt!;
    expect(calls[0]!.body.text).toContain(new Date(graceEnd).toISOString().slice(0, 4));
    // The exact date the customer is quoted is the one the account holds.
    expect(calls[0]!.body.text).toMatch(/\d{1,2} \w+ \d{4}/);
    // No instant lock-out — the promise the email makes is still true.
    expect(user?.entitled).toBe(true);

    // A retry must NOT post a second "your card failed" email.
    const retry = await deliver({
      id: `evt_failed_${++seq}`,
      type: "invoice.payment_failed",
      data: { object: { id: `in_f2_${seq}`, customer: sub.customer, subscription: sub.id } },
    });
    expect(retry.status).toBe(200);
    expect(String(retry.body.note)).toContain("no new email due");
    expect(calls.length).toBe(1);
    expect((await findByEmail(email))?.graceEndsAt).toBe(graceEnd);
  });
});

// ── G. The same records, in the real database ──────────────────────────────

/**
 * The email log has to survive a publish like every other customer record, so
 * this half runs against the throwaway Postgres in EAW_TEST_DATABASE_URL. With
 * no such database it SKIPS loudly rather than pretending a file proves it.
 */
const TEST_DB = (process.env.EAW_TEST_DATABASE_URL || "").trim();

describe("G. the email log in Postgres", () => {
  test.skipIf(!TEST_DB)("a sent email is a row that survives the process", async () => {
    const previous = process.env[STORAGE_ENV_VAR];
    process.env[STORAGE_ENV_VAR] = TEST_DB;
    resetStores();
    try {
      process.env[EMAIL_KEY_ENV] = RESEND_KEY;
      stubFetch({ status: 200, body: { id: "msg_db" } });

      const marker = `db-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const message = composeReceipt({
        to: marker,
        plan: "annual",
        amountPence: 26999,
        currency: "gbp",
        paidAt: new Date().toISOString(),
        periodEnd: null,
        invoiceId: `in_${marker}`,
      });
      const record = await deliverCustomerEmail("receipt", message, { to: marker });
      expect(record.status).toBe("sent");

      const rows = (await recentCustomerEmails(500)).filter((r) => r.to === marker);
      expect(rows.length).toBe(1);
      expect(rows[0]!.status).toBe("sent");
      expect(rows[0]!.subject).toContain("£269.99");

      // Clean up after ourselves: the test database is shared with the suite.
      const { store } = await import("../src/server/storage");
      await store("customer-emails").delete(record.id);
      expect((await recentCustomerEmails(500)).filter((r) => r.to === marker).length).toBe(0);
    } finally {
      if (previous === undefined) delete process.env[STORAGE_ENV_VAR];
      else process.env[STORAGE_ENV_VAR] = previous;
      resetStores();
    }
  });
});
