import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import router from "../api/router";
import {
  ALLOWED_RETURN_ORIGINS,
  RETURN_ORIGIN_HEADER,
  isAllowedReturnOrigin,
  normalizeOrigin,
  resolveReturnOrigin,
} from "../src/server/return-origin";
import { createCheckoutSession, resetCheckoutCaches } from "../src/server/checkout";
import { CHECKOUT_FLAG } from "../src/server/billing-switch";

/**
 * A CUSTOMER WHO PAYS ON www.everyonesawinner.uk COMES BACK TO
 * www.everyonesawinner.uk (2026-11-04).
 *
 * THE DEFECT. `createCheckoutSession()` builds success_url/cancel_url from the
 * origin the checkout request arrived on. The custom domain is a different
 * deployment whose /api/checkout PROXIES to the platform host, so the platform
 * only ever saw its own origin — and a customer who had just paid was returned to
 * a different hostname at the worst possible moment.
 *
 * THE FIX, in two halves that are proved separately and then together:
 *   1. the proxy (api/router.ts) says which origin the BROWSER was on, in a
 *      request header (`x-eaw-return-origin`) — built by the proxy from the
 *      request itself, never copied from an inbound header of the same name;
 *   2. the platform (serve-static.ts) honours that claim ONLY when it is one of
 *      our own origins, and otherwise keeps the origin the request arrived on —
 *      which is exactly the behaviour that existed before the header.
 *
 * WHAT MUST NOT REGRESS: the platform host keeps behaving as it does today, and
 * a claim of `https://evil.example` can never reach success_url. D proves the
 * second end to end: the router's own output is fed into the platform's
 * resolver and then into the real session builder, and the URL Stripe would be
 * sent is inspected.
 */

const CUSTOM_DOMAIN = "https://www.everyonesawinner.uk";
const APEX = "https://everyonesawinner.uk";
/** The platform host, as the platform itself sees its own requests. */
const PLATFORM = "https://515136800b641762" + "e9aace79427eb7c4.cto.site";

const ROOT = join(import.meta.dir, "..");

/* ================================================================== *
 * A. THE ALLOW-LIST
 * ================================================================== */

describe("A. only our own origins are allowed to be a return address", () => {
  test("the custom domain, with and without www", () => {
    expect(ALLOWED_RETURN_ORIGINS).toContain(CUSTOM_DOMAIN);
    expect(ALLOWED_RETURN_ORIGINS).toContain(APEX);
    expect(isAllowedReturnOrigin(CUSTOM_DOMAIN)).toBe(true);
    expect(isAllowedReturnOrigin(APEX)).toBe(true);
  });

  test("the platform hostnames this same build is served on", () => {
    expect(isAllowedReturnOrigin(PLATFORM)).toBe(true);
    expect(isAllowedReturnOrigin("https://515136800b641762" + "e9aace79427eb7c4.ctonew.app")).toBe(true);
    expect(isAllowedReturnOrigin("https://515136800b641762" + "e9aace79427eb7c4-dev.cto.site")).toBe(true);
  });

  test("the local dev server, on loopback and any port", () => {
    expect(isAllowedReturnOrigin("http://localhost:3000")).toBe(true);
    expect(isAllowedReturnOrigin("http://127.0.0.1:5173")).toBe(true);
  });

  test("someone else's host is refused — including every lookalike", () => {
    for (const claimed of [
      "https://evil.example",
      // the trick: reads as our host to a human, resolves to evil.example
      "https://www.everyonesawinner.uk@evil.example",
      // suffix and prefix lookalikes
      "https://www.everyonesawinner.uk.evil.example",
      "https://evil-everyonesawinner.uk",
      "https://everyonesawinner.uk.evil.example",
      // a different port is a different origin
      "https://www.everyonesawinner.uk:8443",
      // plain http to our own domain is not our origin
      "http://www.everyonesawinner.uk",
      // not an http(s) origin at all
      "javascript:alert(1)",
      "//www.everyonesawinner.uk",
      "www.everyonesawinner.uk",
      "",
      "   ",
      "not a url",
    ]) {
      expect({ claimed, allowed: isAllowedReturnOrigin(claimed) }).toEqual({ claimed, allowed: false });
    }
    // …and a value that is not a string at all
    expect(isAllowedReturnOrigin(undefined)).toBe(false);
    expect(isAllowedReturnOrigin(null)).toBe(false);
    expect(isAllowedReturnOrigin(42)).toBe(false);
  });

  test("no wildcard is used: another tenant under the same host suffix is outside the list", () => {
    // *.cto.site belongs to the hosting platform, not to us.
    expect(isAllowedReturnOrigin("https://someone-else.cto.site")).toBe(false);
    expect(ALLOWED_RETURN_ORIGINS.every((o) => !o.includes("*"))).toBe(true);
  });

  test("a claim is reduced to a bare origin, so no path or query can be smuggled in", () => {
    expect(normalizeOrigin(`${CUSTOM_DOMAIN}/subscribe/success?plan=pro&next=//evil.example`)).toBe(CUSTOM_DOMAIN);
    expect(normalizeOrigin(`${CUSTOM_DOMAIN}/`)).toBe(CUSTOM_DOMAIN);
    expect(normalizeOrigin("https://evil.example/?x=www.everyonesawinner.uk")).toBe("https://evil.example");
  });
});

/* ================================================================== *
 * B. THE PLATFORM'S DECISION
 * ================================================================== */

describe("B. the platform honours an allowed claim and ignores everything else", () => {
  test("an allowed claim wins — the customer goes back to the domain they started on", () => {
    expect(resolveReturnOrigin(CUSTOM_DOMAIN, PLATFORM)).toBe(CUSTOM_DOMAIN);
  });

  test("no claim at all → the origin the request arrived on, exactly as before", () => {
    expect(resolveReturnOrigin(null, PLATFORM)).toBe(PLATFORM);
    expect(resolveReturnOrigin(undefined, PLATFORM)).toBe(PLATFORM);
    expect(resolveReturnOrigin("", PLATFORM)).toBe(PLATFORM);
  });

  test("a forged claim falls back instead of being used", () => {
    expect(resolveReturnOrigin("https://evil.example", PLATFORM)).toBe(PLATFORM);
    expect(resolveReturnOrigin("https://www.everyonesawinner.uk@evil.example", PLATFORM)).toBe(PLATFORM);
    expect(resolveReturnOrigin("javascript:alert(1)", PLATFORM)).toBe(PLATFORM);
  });

  test("the platform host's own request is unchanged whether or not it is claimed", () => {
    // A browser on the platform host claims the platform host: same answer.
    expect(resolveReturnOrigin(PLATFORM, PLATFORM)).toBe(PLATFORM);
  });
});

/* ================================================================== *
 * C. THE PROXY SAYS WHICH ORIGIN THE BROWSER IS ON
 * ================================================================== */

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let calls: Call[] = [];
let realFetch: typeof globalThis.fetch;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["PLATFORM_API_URL", "PLATFORM_CHECKOUT_URL", CHECKOUT_FLAG, "STRIPE_SECRET_KEY", "STRIPE_PRICE_PRO"];

beforeAll(() => {
  realFetch = globalThis.fetch;
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  calls = [];
  resetCheckoutCaches();
  process.env.PLATFORM_API_URL = PLATFORM;
  delete process.env.PLATFORM_CHECKOUT_URL;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    calls.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
});

function fakeRes() {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    ended: false,
    setHeader(k: string, v: string) {
      res.headers[k.toLowerCase()] = v;
    },
    end(chunk?: string) {
      res.body = chunk ?? "";
      res.ended = true;
    },
  };
  return res;
}

/** Drive the real router the way the rewrite delivers it. */
async function hit(over: Record<string, unknown> = {}) {
  const res = fakeRes();
  const req: any = {
    method: "POST",
    headers: { host: "www.everyonesawinner.uk" },
    url: "/api/router?path=checkout",
    query: { path: "checkout" },
    body: { plan: "pro" },
    ...over,
  };
  await router(req, res);
  return res;
}

describe("C. /api/checkout tells the platform which origin the browser is on", () => {
  test("the browser's Origin header is forwarded as x-eaw-return-origin", async () => {
    await hit({ headers: { host: "www.everyonesawinner.uk", origin: CUSTOM_DOMAIN } });
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(`${PLATFORM}/api/checkout`);
    expect(calls[0]!.headers[RETURN_ORIGIN_HEADER]).toBe(CUSTOM_DOMAIN);
  });

  test("with no Origin header it is rebuilt from the host the request was addressed to", async () => {
    await hit({ headers: { host: "www.everyonesawinner.uk" } });
    expect(calls[0]!.headers[RETURN_ORIGIN_HEADER]).toBe(CUSTOM_DOMAIN);
  });

  test("x-forwarded-proto/host are honoured, so a proxied hop cannot invent https", async () => {
    await hit({ headers: { host: "internal:3000", "x-forwarded-host": "www.everyonesawinner.uk", "x-forwarded-proto": "https" } });
    expect(calls[0]!.headers[RETURN_ORIGIN_HEADER]).toBe(CUSTOM_DOMAIN);
  });

  test("an inbound x-eaw-return-origin is NOT copied through — the proxy builds its own", async () => {
    await hit({ headers: { host: "www.everyonesawinner.uk", [RETURN_ORIGIN_HEADER]: "https://evil.example" } });
    expect(calls[0]!.headers[RETURN_ORIGIN_HEADER]).toBe(CUSTOM_DOMAIN);
  });

  test("method, body and Authorization are still forwarded verbatim", async () => {
    await hit({ body: '{"plan":"starter"}', headers: { host: "www.everyonesawinner.uk", authorization: "Bearer sess_1" } });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toBe('{"plan":"starter"}');
    expect(calls[0]!.headers.authorization).toBe("Bearer sess_1");
  });
});

/* ================================================================== *
 * D. THE OPEN-REDIRECT PROOF, END TO END
 * ================================================================== */

/**
 * A stubbed Stripe that answers the price lookup and the session creation, so
 * the real `createCheckoutSession()` can run and we can read the form it would
 * POST — which is where success_url and cancel_url live.
 */
function stripeStub() {
  const forms: URLSearchParams[] = [];
  const impl = (async (input: unknown, init: Record<string, any> = {}) => {
    const url = String(input);
    if (url.includes("/prices/")) {
      return new Response(
        JSON.stringify({
          id: "price_test_return_origin",
          active: true,
          currency: "gbp",
          unit_amount: 2999,
          recurring: { interval: "month", interval_count: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    forms.push(new URLSearchParams(String(init.body ?? "")));
    return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, forms };
}

function enableBilling() {
  process.env[CHECKOUT_FLAG] = "on";
  process.env.STRIPE_SECRET_KEY = "sk_test_return_origin";
  process.env.STRIPE_PRICE_PRO = "price_test_return_origin";
}

/** Run one checkout for `origin` and return the form Stripe would have received. */
async function formFor(origin: string): Promise<URLSearchParams> {
  resetCheckoutCaches();
  const stripe = stripeStub();
  const result = await createCheckoutSession(
    { email: "someone@example.com", plan: "pro", origin },
    { fetchImpl: stripe.impl },
  );
  if (!result.ok) throw new Error(`checkout refused: ${result.code}`);
  expect(stripe.forms.length).toBe(1);
  return stripe.forms[0]!;
}

describe("D. a forged origin cannot move the return URL off our own hosts", () => {
  test("a request claiming https://evil.example produces NO success_url or cancel_url on that host", async () => {
    enableBilling();
    // 1. A caller sets the Origin header to their own site and POSTs to the proxy.
    await hit({ headers: { host: "www.everyonesawinner.uk", origin: "https://evil.example" } });
    const claim = calls[0]!.headers[RETURN_ORIGIN_HEADER]!;
    expect(claim).toBe("https://evil.example");

    // 2. The platform refuses the claim and keeps its own origin.
    const origin = resolveReturnOrigin(claim, PLATFORM);
    expect(origin).toBe(PLATFORM);

    // 3. The URL Stripe would actually be given carries no trace of evil.example.
    const form = await formFor(origin);
    const successUrl = form.get("success_url")!;
    const cancelUrl = form.get("cancel_url")!;
    expect(successUrl).toBe(`${PLATFORM}/subscribe/success?session_id={CHECKOUT_SESSION_ID}&plan=pro`);
    expect(cancelUrl).toBe(`${PLATFORM}/subscribe?checkout=cancelled&plan=pro`);
    expect(successUrl).not.toContain("evil.example");
    expect(cancelUrl).not.toContain("evil.example");
  });

  test("a customer on the custom domain gets success_url and cancel_url on the custom domain", async () => {
    enableBilling();
    await hit({ headers: { host: "www.everyonesawinner.uk", origin: CUSTOM_DOMAIN } });
    const origin = resolveReturnOrigin(calls[0]!.headers[RETURN_ORIGIN_HEADER], PLATFORM);
    expect(origin).toBe(CUSTOM_DOMAIN);

    const form = await formFor(origin);
    expect(form.get("success_url")).toBe(
      `${CUSTOM_DOMAIN}/subscribe/success?session_id={CHECKOUT_SESSION_ID}&plan=pro`,
    );
    expect(form.get("cancel_url")).toBe(`${CUSTOM_DOMAIN}/subscribe?checkout=cancelled&plan=pro`);
  });

  test("the platform host behaves exactly as before: no claim, same URLs as today", async () => {
    enableBilling();
    const form = await formFor(resolveReturnOrigin(null, PLATFORM));
    expect(form.get("success_url")).toBe(`${PLATFORM}/subscribe/success?session_id={CHECKOUT_SESSION_ID}&plan=pro`);
    expect(form.get("cancel_url")).toBe(`${PLATFORM}/subscribe?checkout=cancelled&plan=pro`);
  });
});

/* ================================================================== *
 * E. THE SUCCESS PAGE MAKES NO CLAIM THE SYSTEM CANNOT BACK
 * ================================================================== */

/** The page's code with comments stripped: a comment cannot render. */
const codeOf = (p: string) =>
  readFileSync(join(ROOT, p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("E. /subscribe/success does not tell a customer their plan is active before it is", () => {
  const page = codeOf("src/pages/SubscribeSuccess.tsx");

  test("'You're subscribed' is behind the server's own answer, and appears nowhere else", () => {
    // The claim exists…
    expect(page).toContain("You're subscribed");
    // …exactly once…
    expect(page.split("You're subscribed").length - 1).toBe(1);
    // …inside `if (active)`, and `active` is the server's `entitled`, not a hope.
    expect(page).toContain('const active = sessionStatus === "authed" && !!user?.entitled;');
    expect(page.indexOf("if (active)")).toBeLessThan(page.indexOf("You're subscribed"));
    expect(page.indexOf("if (active)")).toBeGreaterThan(page.indexOf("const active"));
  });

  test("it says access is granted by the server when the payment provider confirms — not by this page", () => {
    expect(page).toContain("Access is switched on by our server when the payment provider's confirmation reaches it");
    expect(page).toContain("Nothing on this page can unlock your account");
    expect(page).toContain("It isn't active until our server confirms the payment.");
  });

  test("it does not promise a timeframe we cannot keep", () => {
    // The old copy: "this is usually a minute or two, occasionally a little
    // longer." Nothing in this codebase can support that, so it is gone — and
    // the page says so instead of quietly leaving a gap.
    expect(page).not.toMatch(/minute or two/i);
    expect(page).not.toMatch(/usually/i);
    expect(page).not.toMatch(/ten minutes/i);
    expect(page).toContain("We can't say how long that will take");
  });

  test("it offers a way to ask again, and an escalation that costs nothing", () => {
    expect(page).toContain("Check again");
    expect(page).toContain("Still showing this later on?");
    expect(page).toContain("you will not be left paying for something you can't use");
  });

  test("a comped account is not told it is subscribed, and is not told it renews", () => {
    // A comp writes the same entitlement record as a subscription, so the active
    // branch has to look at `comp` before claiming a payment or a renewal.
    expect(page).toContain("const comped = !!user?.comp;");
    expect(page).toContain("Your free access is active");
    expect(page.indexOf("const comped")).toBeLessThan(page.indexOf("Your plan renews automatically until you cancel"));
  });
});
