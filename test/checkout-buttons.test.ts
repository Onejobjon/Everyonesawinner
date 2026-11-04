import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FREE_ACCESS_NOTE,
  KNOWN_REFUSAL_CODES,
  NOT_FOR_SALE_HEADLINE,
  noticeFor,
  plansForSaleNotice,
  priceQualifier,
  readBillingReadiness,
  signInPathForPlan,
  startCheckout,
  type BillingSnapshot,
  type CheckoutStart,
} from "../src/lib/checkout-client";
import { CheckoutNoticePanel } from "../src/components/PlanCheckoutButton";
import { CHECKOUT_DISABLED_CODE, CHECKOUT_DISABLED_MESSAGE } from "../src/server/billing-switch";

/**
 * THE PLAN BUTTONS ARE WIRED, AND THEY TELL THE TRUTH (2026-11-05).
 *
 * Before this: /subscribe, the paywall's upgrade screen and the home page's
 * pricing section each rendered `disabled` buttons reading "Checkout opens
 * shortly". Honest, but dead — and the day the owner's Stripe keys arrive,
 * nothing would have happened. Now every one of those buttons POSTs the chosen
 * plan to the endpoint that already exists and renders what really came back.
 *
 * WHAT THESE TESTS PROVE, with `fetch` stubbed and no keys anywhere:
 *   A. each plan posts THAT plan, to /api/checkout, with the session token;
 *   B. the flag-off refusal renders "No plan can be bought yet / no payment has
 *      been taken" and does NOT redirect anywhere (no fake success, no fake
 *      navigation);
 *   C. a real session URL redirects the browser to it, and nothing else does;
 *   D. an unknown refusal code still renders a readable sentence (the code is a
 *      support reference, never the message);
 *   E. not signed in → /login?redirect=/subscribe?plan=<plan>, so they come back
 *      to the plan they picked;
 *   F. a network failure offers a retry and says nothing was charged;
 *   G. the claim "No plan can be bought yet." is derived from the billing switch,
 *      so it cannot outlive the flag being turned on;
 *   H. the client knows every refusal code the server can emit (a drift guard).
 */

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/**
 * The code of a file with its comments removed. These assertions are about what
 * a customer is SHOWN, and the comments in these files deliberately quote the
 * old copy ("Checkout opens shortly", "No plan can be bought yet.") to explain
 * what was removed — a comment cannot render.
 */
const codeOf = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const TOKEN = "sess_test_token";

type Call = { url: string; init: RequestInit | undefined };

/** A stubbed fetch that records what the client sent. */
function stubFetch(reply: () => Response | Promise<Response>): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return reply();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Render the panel exactly as the page would, and return the text a customer sees. */
function renderNotice(result: Exclude<CheckoutStart, { kind: "redirect" }>): { html: string; text: string } {
  const html = renderToStaticMarkup(createElement(CheckoutNoticePanel, { notice: noticeFor(result) }));
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return { html, text };
}

const PLANS = ["starter", "pro", "annual"] as const;

describe("A. every plan button posts its own plan to the real endpoint", () => {
  for (const plan of PLANS) {
    test(`${plan}: POST /api/checkout { plan: "${plan}" } with the session token`, async () => {
      const { calls, fetchImpl } = stubFetch(() =>
        json({ ok: false, code: CHECKOUT_DISABLED_CODE, message: CHECKOUT_DISABLED_MESSAGE }, 503),
      );
      await startCheckout({ plan, token: TOKEN, fetchImpl });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("/api/checkout");
      expect(calls[0].init?.method).toBe("POST");
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(headers["content-type"]).toBe("application/json");
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ plan });
    });
  }

  test("the three pages call the shared control with a plan each", () => {
    const subscribe = read("src/pages/Subscribe.tsx");
    const home = read("src/pages/Home.tsx");
    const paywall = read("src/components/Paywall.tsx");
    // /subscribe and the home page render one button per plan, from their data.
    expect(subscribe).toContain("<PlanCheckoutButton plan={plan.id}");
    expect(home).toContain("<PlanCheckoutButton plan={plan.id}");
    // The paywall upgrade screen sells exactly two.
    expect(paywall).toContain('<PlanCheckoutButton plan="pro"');
    expect(paywall).toContain('<PlanCheckoutButton plan="annual"');
  });
});

describe("B. the flag-off refusal is honest and does not redirect", () => {
  test("a 503 checkout_disabled is a refusal, never a redirect", async () => {
    const { fetchImpl } = stubFetch(() =>
      json({ ok: false, code: CHECKOUT_DISABLED_CODE, message: CHECKOUT_DISABLED_MESSAGE }, 503),
    );
    const result = await startCheckout({ plan: "pro", token: TOKEN, fetchImpl });
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.code).toBe("checkout_disabled");
    expect(result.kind === "refused" && result.status).toBe(503);
    // No URL anywhere in the result: there is nothing to navigate to.
    expect(JSON.stringify(result)).not.toContain("http");
  });

  test("the panel says plans cannot be bought and that no payment was taken", async () => {
    const { fetchImpl } = stubFetch(() =>
      json({ ok: false, code: CHECKOUT_DISABLED_CODE, message: CHECKOUT_DISABLED_MESSAGE }, 503),
    );
    const result = await startCheckout({ plan: "pro", token: TOKEN, fetchImpl });
    if (result.kind === "redirect") throw new Error("must not redirect");
    const notice = noticeFor(result);

    expect(notice.title).toBe("No plan can be bought yet");
    expect(notice.body).toContain("no payment has been taken");
    expect(notice.freeAccess).toBe(true);
    expect(notice.retry).toBe(false);

    const { text, html } = renderNotice(result);
    expect(text).toContain("No plan can be bought yet");
    expect(text).toContain("no payment has been taken");
    // The free-access route is offered, with a way to use it.
    expect(text).toContain(FREE_ACCESS_NOTE);
    expect(html).toContain("mailto:support@everyonesawinner.uk");
    // And nothing that reads like a success.
    expect(text.toLowerCase()).not.toContain("payment successful");
    expect(text.toLowerCase()).not.toContain("you're subscribed");
  });

  test("a missing secret key / price is the same honest state, not a stack trace", async () => {
    for (const code of ["stripe_not_configured", "price_not_configured", "price_inactive", "account_cannot_subscribe"]) {
      const { fetchImpl } = stubFetch(() => json({ ok: false, code, message: "server detail" }, 503));
      const result = await startCheckout({ plan: "annual", token: TOKEN, fetchImpl });
      if (result.kind === "redirect") throw new Error("must not redirect");
      const { text } = renderNotice(result);
      expect(text).toContain("no payment has been taken");
      expect(text).not.toContain("STRIPE_SECRET_KEY"); // no config variable names at a customer
      expect(text).not.toContain("server detail"); // and no raw server message
      // Either the free-access route is offered, or the body already gives the
      // address to write to — never neither.
      const notice = noticeFor(result);
      expect(notice.freeAccess || notice.body.includes("support@everyonesawinner.uk")).toBe(true);
    }
  });
});

describe("C. a real session URL redirects, and nothing else does", () => {
  test("a 200 with a Stripe url becomes a redirect to exactly that url", async () => {
    const url = "https://checkout.stripe.com/c/pay/cs_live_a1B2c3#fidkdWxOYHwnPyd1blpx";
    const { fetchImpl } = stubFetch(() =>
      json({ ok: true, url, sessionId: "cs_live_a1B2c3", plan: "pro", mode: "subscription" }),
    );
    const result = await startCheckout({ plan: "pro", token: TOKEN, fetchImpl });
    expect(result).toEqual({ kind: "redirect", plan: "pro", url });
  });

  test("a 200 with no address is not a success — it is a refusal we can explain", async () => {
    const { fetchImpl } = stubFetch(() => json({ ok: true, plan: "pro", mode: "subscription" }));
    const result = await startCheckout({ plan: "pro", token: TOKEN, fetchImpl });
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("no_redirect");
    expect(renderNotice(result).text).toContain("no payment has been taken");
  });

  test("a non-URL string in `url` is refused, not navigated to", async () => {
    const { fetchImpl } = stubFetch(() => json({ ok: true, url: "javascript:alert(1)" }));
    const result = await startCheckout({ plan: "starter", token: TOKEN, fetchImpl });
    expect(result.kind).toBe("refused");
  });
});

describe("D. an unknown refusal code still renders a readable message", () => {
  test("a code we have never seen gets a sentence, with the code as a reference only", async () => {
    const { fetchImpl } = stubFetch(() =>
      json({ ok: false, code: "quantum_flux_42", message: "upstream said no" }, 402),
    );
    const result = await startCheckout({ plan: "starter", token: TOKEN, fetchImpl });
    if (result.kind === "redirect") throw new Error("must not redirect");
    const notice = noticeFor(result);

    // A sentence a customer can act on, not a code and not a stack trace.
    expect(notice.title).toBe("We couldn't start the checkout");
    expect(notice.body.length).toBeGreaterThan(60);
    expect(notice.body).toContain("no payment has been taken");
    expect(notice.body).not.toBe("quantum_flux_42");
    expect(notice.retry).toBe(true);
    expect(notice.reference).toBe("quantum_flux_42");

    const { text } = renderNotice(result);
    expect(text).toContain("We couldn't start the checkout");
    expect(text).toContain("Try again");
    expect(text).toContain("Reference for support: quantum_flux_42");
    expect(text).not.toContain("upstream said no"); // the raw provider message is not the customer's message
  });
});

describe("E. not signed in sends them to sign in and back to the plan they picked", () => {
  test("no token: the endpoint is not even called, and the plan is remembered in the return path", async () => {
    const { calls, fetchImpl } = stubFetch(() => json({ ok: false }, 401));
    const result = await startCheckout({ plan: "annual", token: null, fetchImpl });
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ kind: "sign_in", plan: "annual", reason: "no_session" });
    expect(signInPathForPlan("annual")).toBe("/login?redirect=%2Fsubscribe%3Fplan%3Dannual");
  });

  test("an expired session (401) is a sign-in, not a scary error", async () => {
    const { fetchImpl } = stubFetch(() =>
      json({ ok: false, code: "not_signed_in", message: "Sign in first" }, 401),
    );
    const result = await startCheckout({ plan: "pro", token: TOKEN, fetchImpl });
    expect(result).toEqual({ kind: "sign_in", plan: "pro", reason: "session_expired" });
    const { text } = renderNotice(result as Exclude<CheckoutStart, { kind: "redirect" }>);
    expect(text).toContain("no payment has been taken");
  });

  test("a deleted account (401 account_not_found) says so and sends them to sign in", async () => {
    const { fetchImpl } = stubFetch(() =>
      json({ ok: false, code: "account_not_found", message: "gone" }, 401),
    );
    const result = await startCheckout({ plan: "pro", token: TOKEN, fetchImpl });
    expect(result).toEqual({ kind: "sign_in", plan: "pro", reason: "account_missing" });
  });
});

describe("F. a network failure offers a retry and never goes silent", () => {
  test("fetch throwing is a retryable network state", async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const result = await startCheckout({ plan: "pro", token: TOKEN, fetchImpl });
    expect(result.kind).toBe("network");
    const notice = noticeFor(result as Exclude<CheckoutStart, { kind: "redirect" }>);
    expect(notice.retry).toBe(true);
    expect(notice.body).toContain("no payment has been taken");
    const { text } = renderNotice(result as Exclude<CheckoutStart, { kind: "redirect" }>);
    expect(text).toContain("Try again");
  });

  test("a non-JSON answer (a proxy error page) is a network state, not a success", async () => {
    // This is exactly what the working (dev) environment returns today:
    // 503 text/plain "Sandbox unavailable".
    const { fetchImpl } = stubFetch(() => new Response("Sandbox unavailable", { status: 503 }));
    const result = await startCheckout({ plan: "starter", token: TOKEN, fetchImpl });
    expect(result.kind).toBe("network");
    const { text } = renderNotice(result as Exclude<CheckoutStart, { kind: "redirect" }>);
    expect(text).toContain("no payment has been taken");
    expect(text).toContain("Try again");
  });
});

describe("G. the claim is derived from the billing switch", () => {
  const closed: BillingSnapshot = { state: "closed", enabled: false, blockers: ["Billing is off."] };
  const open: BillingSnapshot = { state: "open", enabled: true, blockers: [] };
  const unknown: BillingSnapshot = { state: "unknown", enabled: false, blockers: [] };

  test("while the flag is off the claim is exactly the owner's sentence", () => {
    expect(NOT_FOR_SALE_HEADLINE).toBe("No plan can be bought yet.");
    const notice = plansForSaleNotice(closed);
    expect(notice.onSale).toBe(false);
    expect(notice.headline).toBe("No plan can be bought yet.");
    expect(notice.detail).toContain("no payment can be taken");
    expect(priceQualifier(closed)).toBe(" (planned)");
  });

  test("the day the flag flips, the claim goes with it — no page needs editing", () => {
    const notice = plansForSaleNotice(open);
    expect(notice.onSale).toBe(true);
    expect(notice.headline).not.toBe(NOT_FOR_SALE_HEADLINE);
    expect(notice.headline).not.toContain("can't");
    expect(priceQualifier(open)).toBe("");
  });

  test("an unreachable readiness answer fails closed: still not for sale", () => {
    const notice = plansForSaleNotice(unknown);
    expect(notice.onSale).toBe(false);
    expect(notice.headline).toBe(NOT_FOR_SALE_HEADLINE);
    expect(priceQualifier(unknown)).toBe(" (planned)");
  });

  test("readiness comes from GET /api/checkout and reports all three states", async () => {
    const openFetch = stubFetch(() =>
      json({ ok: true, billing: { enabled: true, canTakeSubscriptionPayments: true, blockers: [] } }),
    );
    expect((await readBillingReadiness({ fetchImpl: openFetch.fetchImpl })).state).toBe("open");
    expect(openFetch.calls[0].url).toBe("/api/checkout");
    expect(openFetch.calls[0].init?.method).toBe("GET");

    const closedFetch = stubFetch(() =>
      json({ ok: true, billing: { enabled: false, canTakeSubscriptionPayments: false, blockers: ["Billing is off."] } }),
    );
    const closedSnap = await readBillingReadiness({ fetchImpl: closedFetch.fetchImpl });
    expect(closedSnap.state).toBe("closed");
    expect(closedSnap.enabled).toBe(false);
    expect(closedSnap.blockers).toEqual(["Billing is off."]);

    const brokenFetch = stubFetch(() => new Response("Sandbox unavailable", { status: 503 }));
    expect((await readBillingReadiness({ fetchImpl: brokenFetch.fetchImpl })).state).toBe("unknown");

    const throwing = stubFetch(() => {
      throw new Error("offline");
    });
    expect((await readBillingReadiness({ fetchImpl: throwing.fetchImpl })).state).toBe("unknown");
  });

  test("no page types the claim itself any more — it can only come from the switch", () => {
    for (const page of ["src/pages/Subscribe.tsx", "src/pages/Home.tsx", "src/components/Paywall.tsx"]) {
      const src = codeOf(page);
      expect(src).not.toContain("No plan can be bought yet");
      expect(src).toContain("plansForSaleNotice");
      expect(src).toContain("priceQualifier");
    }
    // The one place the sentence lives.
    expect(read("src/lib/checkout-client.ts")).toContain('export const NOT_FOR_SALE_HEADLINE = "No plan can be bought yet.";');
  });
});

describe("H. the client knows every code the endpoint can emit", () => {
  test("no refusal in src/server/checkout.ts is missing from KNOWN_REFUSAL_CODES", () => {
    const server = read("src/server/checkout.ts");
    const emitted = [...server.matchAll(/refuse\(\s*\d+,\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(emitted.length).toBeGreaterThan(5);
    for (const code of emitted) {
      expect(KNOWN_REFUSAL_CODES as readonly string[]).toContain(code);
      // …and each one has its own sentence, not the generic fallback.
      expect(noticeFor({ kind: "refused", plan: "pro", status: 400, code, serverMessage: null }).body)
        .not.toContain("quote the reference below");
    }
    // The flag-off code comes from billing-switch, and is covered too.
    expect(KNOWN_REFUSAL_CODES as readonly string[]).toContain(CHECKOUT_DISABLED_CODE);
  });

  test("the endpoint's own before-the-ladder codes are covered", () => {
    const route = read("serve-static.ts");
    expect(route).toContain('code: "not_signed_in"');
    expect(route).toContain('code: "account_not_found"');
    expect(KNOWN_REFUSAL_CODES as readonly string[]).toContain("not_signed_in");
    expect(KNOWN_REFUSAL_CODES as readonly string[]).toContain("account_not_found");
  });
});

describe("the dead placeholders are gone", () => {
  test("no page says 'Checkout opens shortly' as a dead button label any more", () => {
    // The sentence survives in exactly one place — as the closed-state detail in
    // checkout-client.ts, which is what a visitor reads under the claim. What is
    // gone is a `disabled` button whose only content was that label.
    const files = [
      "src/pages/Subscribe.tsx",
      "src/pages/Home.tsx",
      "src/components/Paywall.tsx",
      "src/components/PlanCheckoutButton.tsx",
    ];
    for (const f of files) expect(codeOf(f)).not.toContain("Checkout opens shortly");
  });

  test("the button is only disabled while a request is in flight, never into silence", () => {
    const button = read("src/components/PlanCheckoutButton.tsx");
    expect(button).toContain("disabled={pending}");
    expect(button).not.toContain("aria-disabled=\"true\"");
    expect(button).toContain("window.location.assign(result.url)");
    expect(button).toContain("rememberChosenPlan(plan)");
    // Never a success state of its own.
    expect(button).not.toContain("Payment successful");
    expect(button).not.toContain("You're subscribed");
  });

  test("the chosen plan survives the sign-in round trip", () => {
    expect(read("src/pages/Login.tsx")).toContain("navigate(redirect)");
    const signup = read("src/pages/Signup.tsx");
    expect(signup).toContain('searchParams.get("redirect")');
    expect(signup).toContain("navigate(redirect)");
    expect(read("src/pages/Subscribe.tsx")).toContain("searchParams.get(\"plan\")");
  });
});
