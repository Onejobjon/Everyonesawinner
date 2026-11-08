import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import router, { ROUTES, routeSegments } from "../api/router";
import { KNOWN_REFUSAL_CODES, noticeFor, startCheckout } from "../src/lib/checkout-client";

/**
 * ONE FUNCTION FOR EVERY /api ROUTE — REACHED BY REWRITE, NOT BY FILENAME
 * (2026-11-04, second attempt).
 *
 * Vercel Hobby allows 12 serverless functions and `api/` held exactly 12. The
 * 13th (/api/checkout, which the custom domain needs before /subscribe can sell
 * anything) made every deploy fail — and a failed deploy leaves the PREVIOUS
 * build serving, which is how www.everyonesawinner.uk sat on a stale build for
 * hours with no visible error.
 *
 * The FIRST attempt at this consolidation named the file `api/[...path].ts`, the
 * catch-all convention for a FRAMEWORK project. This is a plain project
 * (`framework: "vite"`), so the deploy went through and NOTHING was routed: every
 * /api/* path and /go/<slug> on the live domain started returning the SPA's
 * index.html — a 200 with a web page instead of JSON, and /go/mrq stopped
 * redirecting. The file was never matched, so /api/* fell through to the
 * `/(.*)` → /index.html SPA rewrite.
 *
 * The mechanism that actually works is a rewrite to a single NAMED function:
 *
 *   api/router.ts                                   ← the one function
 *   { "source": "/api/(.*)", "destination": "/api/router?path=$1" }
 *   { "source": "/go/(.*)",  "destination": "/api/router?path=go&slug=$1" }
 *
 * so this file proves, in order:
 *
 *   A. every path that existed before still reaches its own handler, driven the
 *      way the rewrite delivers it (`?path=odds&sport=…`, `?path=go&slug=mrq`);
 *   B. the three delicate cases still behave (odds keyless fallback to
 *      PLATFORM_ODDS_URL, the custom domain's 421 webhook refusal with zero
 *      network calls, /go's bare 302 with nothing appended);
 *   C. the new /api/checkout proxy forwards method, body and Authorization and
 *      passes the upstream status through — and fails closed, never "success";
 *   D. THE DEPLOYMENT CONTRACT ITSELF: vercel.json really does rewrite
 *      /api/(.*) and /go/(.*) to /api/router, the router file really exists, and
 *      the SPA catch-all stays last. D is what stops the bracketed-filename
 *      class of breakage recurring — the code was fine, the wiring was not.
 */

const ROOT = join(import.meta.dir, "..");
const API_FILE = join(ROOT, "api", "router.ts");

const PLATFORM = "https://platform.test";
const ODDS_HOST = "https://odds-fallback.test";
const CHECKOUT_HOST = "https://checkout.test";

/* ── a request/response pair shaped like a Vercel function's ─────────────── */

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    ended: false,
    setHeader(k: string, v: string) {
      res.headers[k.toLowerCase()] = v;
    },
    end(b: string) {
      res.body = b ?? "";
      res.ended = true;
    },
  };
  return res;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let calls: Call[] = [];
let realFetch: typeof globalThis.fetch;
let reply: (call: Call) => Response | Promise<Response>;

/** Default reply: a 200 with an empty JSON object — enough for every proxy. */
const defaultReply = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "PLATFORM_API_URL",
  "PLATFORM_ODDS_URL",
  "PLATFORM_CHECKOUT_URL",
  "ODDS_API_KEY",
  "Oddsapi",
];

beforeAll(() => {
  realFetch = globalThis.fetch;
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const raw = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);
    const call: Call = {
      url: String(input),
      method: String(init?.method ?? "GET"),
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return reply(call);
  }) as typeof globalThis.fetch;
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
  reply = defaultReply;
  process.env.PLATFORM_API_URL = PLATFORM;
  process.env.PLATFORM_ODDS_URL = ODDS_HOST;
  delete process.env.PLATFORM_CHECKOUT_URL;
  delete process.env.ODDS_API_KEY;
  delete process.env.Oddsapi;
});

afterEach(() => {
  reply = defaultReply;
});

/**
 * Drive the real router the way the rewrite delivers it.
 *
 * vercel.json sends `/api/odds?sport=soccer_epl` to
 * `/api/router?path=odds&sport=soccer_epl`, so the function's URL carries BOTH
 * the router's own `path` and the caller's parameters — that merged query string
 * is the whole contract, and this helper reproduces it byte for byte (including
 * the string (not array) type Vercel gives a plain query parameter).
 */
async function hit(pathSegments: string[], over: Record<string, unknown> = {}) {
  const res = fakeRes();
  const incoming = (over.query as Record<string, string>) ?? {};
  const routeKey = pathSegments[0] === "go" ? "go" : pathSegments.join("/");
  const merged = new URLSearchParams();
  merged.set("path", routeKey);
  for (const [k, v] of Object.entries(incoming)) merged.set(k, v);
  const req: any = {
    method: "GET",
    headers: { host: "www.everyonesawinner.uk", ...((over.headers as Record<string, string>) ?? {}) },
    url: `/api/router?${merged.toString()}`,
    query: { ...incoming, path: routeKey },
    ...over,
  };
  if (over.query) req.query = { ...incoming, path: routeKey };
  await router(req, res);
  return res;
}

/* ================================================================== *
 * A. THE ROUTE TABLE — every path that existed before still lands
 * ================================================================== */

describe("A. the router maps every previously-existing path to its handler", () => {
  test("the table holds exactly the twelve old routes plus checkout and the subscription routes", () => {
    expect(Object.keys(ROUTES).sort()).toEqual(
      [
        "checkout",
        "comps",
        "comps/revoke",
        "go",
        "instant-wins",
        "leads",
        "login",
        "me",
        "odds",
        "odds-leagues",
        "same-match",
        "signup",
        "stripe-webhook",
        // 2026-11-08: the account page's own endpoints (cancel / resume).
        "subscription",
        "subscription/cancel",
        "subscription/resume",
      ].sort(),
    );
  });

  // One row per file that used to sit in api/. The assertion is what the OLD
  // file did with the same input — so a drifted handler fails here.
  const rows: Array<{
    file: string;
    segments: string[];
    over?: Record<string, unknown>;
    status: number;
    error?: string;
  }> = [
    { file: "api/me.ts", segments: ["me"], status: 401, error: "Not signed in" },
    { file: "api/login.ts", segments: ["login"], over: { method: "GET" }, status: 405, error: "Method not allowed" },
    { file: "api/signup.ts", segments: ["signup"], over: { method: "GET" }, status: 405, error: "Method not allowed" },
    { file: "api/leads.ts", segments: ["leads"], over: { method: "GET" }, status: 405, error: "Method not allowed" },
    // an unsupported competition is refused before any fetch — the free refusal
    { file: "api/odds.ts", segments: ["odds"], over: { query: { sport: "not_a_sport" } }, status: 400, error: "sport_not_supported" },
    { file: "api/odds-leagues.ts", segments: ["odds-leagues"], status: 401, error: "not_signed_in" },
    { file: "api/same-match.ts", segments: ["same-match"], status: 401, error: "not_signed_in" },
    { file: "api/instant-wins.ts", segments: ["instant-wins"], status: 401, error: "not_signed_in" },
    { file: "api/comps.ts", segments: ["comps"], status: 404, error: "not_found" },
    { file: "api/comps/revoke.ts", segments: ["comps", "revoke"], over: { method: "POST" }, status: 404, error: "not_found" },
    { file: "api/stripe-webhook.ts", segments: ["stripe-webhook"], over: { method: "POST" }, status: 421 },
    { file: "api/go.ts", segments: ["go"], status: 302 },
  ];

  for (const row of rows) {
    test(`${row.file} → /api/${row.segments.join("/")} still answers ${row.status}`, async () => {
      const res = await hit(row.segments, row.over ?? {});
      expect(res.statusCode).toBe(row.status);
      if (row.error) expect(JSON.parse(res.body).error).toBe(row.error);
      if (row.status === 302) expect(res.headers.location).toBe("/free-bets");
    });
  }

  test("a path that never existed is a JSON 404, not the SPA's HTML", async () => {
    const res = await hit(["nope", "not-a-route"]);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("not_found");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("the router reads the path from req.url when Vercel's query.path is absent", async () => {
    const res = fakeRes();
    // No `query.path` at all — the fallback parse must still find /api/comps.
    await router({ method: "GET", headers: { host: "x" }, url: "/api/comps" } as any, res);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).message).toBe("Not found.");
  });

  test("routeSegments reads the rewrite's ?path= — plain, percent-encoded, and /go", () => {
    // Exactly what vercel.json's destination produces.
    expect(routeSegments({ url: "/api/router?path=odds&sport=soccer_epl" })).toEqual(["odds"]);
    expect(routeSegments({ url: "/api/router?path=comps/revoke" })).toEqual(["comps", "revoke"]);
    // Vercel may percent-encode the captured path — decode BEFORE splitting.
    expect(routeSegments({ url: "/api/router?path=comps%2Frevoke" })).toEqual(["comps", "revoke"]);
    expect(routeSegments({ url: "/api/router?path=go&slug=mrq" })).toEqual(["go"]);
    // The other shape: only req.query carries it (a string, as Vercel gives it).
    expect(routeSegments({ query: { path: "odds" }, url: "/api/router" })).toEqual(["odds"]);
    // The old bracketed-file shape (string[]) still works.
    expect(routeSegments({ query: { path: ["comps", "revoke"] }, url: "/api/comps/revoke" })).toEqual(["comps", "revoke"]);
    // No rewrite at all: the pathname names the route.
    expect(routeSegments({ url: "/api/odds?sport=x" })).toEqual(["odds"]);
    expect(routeSegments({ url: "/go/betfred" })).toEqual(["go", "betfred"]);
    expect(routeSegments({ url: "/api/go?slug=betfred" })).toEqual(["go"]);
  });

  /* ── THE QUERY-MERGE CONTRACT ──────────────────────────────────────────── *
   * Vercel merges the original query string into the rewrite destination, so
   * `?path=` and the caller's parameters arrive together. That assumption is
   * verified here in all three shapes the runtime could produce, and the
   * router's own `path` parameter must never reach a handler or an upstream.
   * ──────────────────────────────────────────────────────────────────────── */

  test("the merged rewrite query reaches the handler: ?path=odds&sport=soccer_epl", async () => {
    process.env.ODDS_API_KEY = "test-key-not-a-secret";
    reply = () => new Response('[{"id":"evt"}]', { status: 200 });
    // A sport no other test asks for, so the handler's 10-minute cache cannot
    // answer this one without a fetch and hide a routing bug.
    await hit(["odds"], { query: { sport: "americanfootball_nfl" } });
    // The caller's own parameter is what selected the sport…
    expect(calls[0]!.url).toContain("/sports/americanfootball_nfl/odds");
    // …and the router's `path` is nowhere in it.
    expect(calls[0]!.url).not.toContain("path=");
  });

  test("the router's path parameter never reaches the upstream URL", async () => {
    await hit(["odds"], { query: { sport: "soccer_epl" } });
    expect(calls[0]!.url).toBe(`${ODDS_HOST}/api/odds?sport=soccer_epl`);
    expect(calls[0]!.url).not.toContain("path");
  });

  test("it still works if Vercel only puts the path in req.query, not the URL", async () => {
    const res = fakeRes();
    await router(
      {
        method: "GET",
        headers: { host: "www.everyonesawinner.uk" },
        // No ?path= in the URL at all; req.query is the only carrier.
        url: "/api/router?sport=soccer_epl",
        query: { path: "odds", sport: "soccer_epl" },
      } as any,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.url).toBe(`${ODDS_HOST}/api/odds?sport=soccer_epl`);
  });

  test("it still works if the URL carries neither — pathname only (the old shape)", async () => {
    const res = fakeRes();
    await router(
      { method: "GET", headers: { host: "www.everyonesawinner.uk" }, url: "/api/odds?sport=soccer_epl" } as any,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.url).toBe(`${ODDS_HOST}/api/odds?sport=soccer_epl`);
  });

  test("a proxied route still forwards the caller's own query and token", async () => {
    await hit(["me"], { query: { token: "tok_123" } });
    expect(calls[0]!.url).toBe(`${PLATFORM}/api/me`);
    expect(calls[0]!.headers.authorization).toBe("Bearer tok_123");
  });

  test("a POST route still receives the parsed body the old function got", async () => {
    await hit(["login"], { method: "POST", body: { email: "a@b.c", password: "pw" } });
    expect(calls[0]!.url).toBe(`${PLATFORM}/api/login`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ email: "a@b.c", password: "pw" });
  });
});

/* ================================================================== *
 * B. THE THREE DELICATE CASES
 * ================================================================== */

describe("B1. the odds proxy still falls back to PLATFORM_ODDS_URL with no key", () => {
  test("no ODDS_API_KEY → the platform host is asked, and its body is served as 200", async () => {
    reply = () => new Response('[{"id":"evt-from-platform"}]', { status: 200, headers: { "content-type": "application/json" } });
    const res = await hit(["odds"], { query: { sport: "soccer_epl" } });
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(`${ODDS_HOST}/api/odds?sport=soccer_epl`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('[{"id":"evt-from-platform"}]');
  });

  test("PLATFORM_ODDS_URL is the override — not PLATFORM_API_URL", async () => {
    process.env.PLATFORM_API_URL = "https://somewhere-else.test";
    await hit(["odds"], { query: { sport: "soccer_epl" } });
    expect(calls[0]!.url).toBe(`${ODDS_HOST}/api/odds?sport=soccer_epl`);
  });

  test("the keyless fallback failing is a loud 503, never an empty list", async () => {
    reply = () => new Response("upstream exploded", { status: 500 });
    const res = await hit(["odds"], { query: { sport: "soccer_epl" } });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toBe("odds_unavailable");
  });

  test("with a key the provider is called directly, and the platform is not", async () => {
    process.env.ODDS_API_KEY = "test-key-not-a-secret";
    reply = () => new Response('[{"id":"evt"}]', { status: 200, headers: { "content-type": "application/json" } });
    const res = await hit(["odds"], { query: { sport: "basketball_nba" } });
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("api.the-odds-api.com");
    expect(calls[0]!.url).toContain("/sports/basketball_nba/odds");
    expect(res.statusCode).toBe(200);
  });
});

describe("B2. the custom domain still refuses the Stripe webhook, with its reason", () => {
  test("POST /api/stripe-webhook is a 421 that names the raw-body problem", async () => {
    const res = await hit(["stripe-webhook"], { method: "POST", body: { id: "evt_1" } });
    expect(res.statusCode).toBe(421);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Stripe events are received on the platform host, not this domain");
    expect(body.why).toBe(
      "the signature is checked against the raw request body, which a function on this host cannot see",
    );
    expect(body.use).toBe(`${PLATFORM}/api/stripe-webhook`);
    expect(body.method).toBe("POST");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("it refuses without forwarding anything anywhere", async () => {
    await hit(["stripe-webhook"], { method: "POST", body: { id: "evt_1" } });
    // THE POINT: re-posting an already-parsed body would break the signature, so
    // this route must never reach the network.
    expect(calls).toEqual([]);
  });

  test("a GET is refused the same way — this route has no other behaviour", async () => {
    const res = await hit(["stripe-webhook"], { method: "GET" });
    expect(res.statusCode).toBe(421);
    expect(JSON.parse(res.body).method).toBe("GET");
  });
});

describe("B3. /go/<slug> is still a 302 with no query string appended", () => {
  test("the upstream Location is passed through byte for byte", async () => {
    reply = () => new Response(null, { status: 302, headers: { location: "https://www.betfred.com/welcome" } });
    const res = await hit(["go"], { query: { slug: "betfred" } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://www.betfred.com/welcome");
    expect(calls[0]!.url).toBe(`${PLATFORM}/go/betfred`);
  });

  test("an incoming query string is not stapled onto the destination", async () => {
    reply = () => new Response(null, { status: 302, headers: { location: "https://www.mrq.com/promo?code=ABC" } });
    // The rewrite shape: /go/mrq?utm_source=free-bets → ?path=go&slug=mrq&utm_source=free-bets
    const res = await hit(["go"], { query: { slug: "mrq", utm_source: "free-bets" } });
    // Exactly the brand's destination: no &utm_source, no ?slug, nothing added.
    expect(res.headers.location).toBe("https://www.mrq.com/promo?code=ABC");
    // And the click log is asked for the slug alone, never the tracking params.
    expect(calls[0]!.url).toBe(`${PLATFORM}/go/mrq`);
  });

  test("the /go rewrite's own query is what supplies the slug", async () => {
    reply = () => new Response(null, { status: 302, headers: { location: "https://www.mrq.com/join" } });
    const res = fakeRes();
    // ?path=go&slug=mrq with NO req.query — the URL alone must be enough.
    await router({ method: "GET", headers: { host: "www.everyonesawinner.uk" }, url: "/api/router?path=go&slug=mrq" } as any, res);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://www.mrq.com/join");
    expect(calls[0]!.url).toBe(`${PLATFORM}/go/mrq`);
  });

  test("/go/<slug> reached without the rewrite still redirects to the brand", async () => {
    reply = () => new Response(null, { status: 302, headers: { location: "https://www.leovegas.com/join" } });
    const res = fakeRes();
    await router({ method: "GET", headers: { host: "www.everyonesawinner.uk" }, url: "/go/leovegas" } as any, res);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://www.leovegas.com/join");
    expect(calls[0]!.url).toBe(`${PLATFORM}/go/leovegas`);
  });

  test("an unreachable platform still redirects the visitor somewhere real", async () => {
    reply = () => {
      throw new Error("network down");
    };
    const res = await hit(["go"], { query: { slug: "betfred" } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/free-bets");
  });

  test("no slug at all goes to the offers list, not a dead end", async () => {
    const res = await hit(["go"]);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/free-bets");
  });
});

/* ================================================================== *
 * C. THE NEW /api/checkout PROXY
 * ================================================================== */

describe("C. /api/checkout proxies to the platform host", () => {
  test("GET forwards the method and passes the readiness answer through unchanged", async () => {
    const readiness = JSON.stringify({ ok: true, billing: { enabled: false, canTakeSubscriptionPayments: false, blockers: ["CHECKOUT_ENABLED"] } });
    reply = () => new Response(readiness, { status: 200, headers: { "content-type": "application/json" } });
    const res = await hit(["checkout"]);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(`${PLATFORM}/api/checkout`);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.body).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(readiness);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("POST forwards the body verbatim AND the Authorization header", async () => {
    reply = () => new Response(JSON.stringify({ ok: true, url: "https://checkout.stripe.com/c/pay/x" }), { status: 200 });
    const res = await hit(["checkout"], {
      method: "POST",
      body: { plan: "pro" },
      headers: { authorization: "Bearer sess_abc" },
    });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${PLATFORM}/api/checkout`);
    expect(calls[0]!.headers.authorization).toBe("Bearer sess_abc");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ plan: "pro" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).url).toBe("https://checkout.stripe.com/c/pay/x");
  });

  test("a raw string body is forwarded untouched (no re-serialisation)", async () => {
    await hit(["checkout"], { method: "POST", body: '{"plan":"starter"}' });
    expect(calls[0]!.body).toBe('{"plan":"starter"}');
  });

  test("the upstream STATUS is passed through — a refusal stays a refusal", async () => {
    const refusal = JSON.stringify({ ok: false, code: "checkout_disabled", message: "No plan can be bought yet." });
    reply = () => new Response(refusal, { status: 503 });
    const res = await hit(["checkout"], { method: "POST", body: { plan: "pro" }, headers: { authorization: "Bearer t" } });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe(refusal);
  });

  test("a 401 from the platform stays a 401 (the client turns it into 'sign in')", async () => {
    reply = () => new Response(JSON.stringify({ ok: false, code: "not_signed_in", message: "Sign in first." }), { status: 401 });
    const res = await hit(["checkout"], { method: "POST", body: { plan: "pro" } });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).code).toBe("not_signed_in");
  });

  test("PLATFORM_CHECKOUT_URL overrides where the checkout is asked for", async () => {
    process.env.PLATFORM_CHECKOUT_URL = CHECKOUT_HOST;
    await hit(["checkout"]);
    expect(calls[0]!.url).toBe(`${CHECKOUT_HOST}/api/checkout`);
  });

  test("anything other than GET or POST is a 405 and never reaches the network", async () => {
    const res = await hit(["checkout"], { method: "PUT" });
    expect(res.statusCode).toBe(405);
    expect(JSON.parse(res.body).error).toBe("Method not allowed");
    expect(calls).toEqual([]);
  });
});

describe("C. the checkout proxy FAILS CLOSED — it can never invent a success", () => {
  test("an unreachable platform is a 502 with the code the client already understands", async () => {
    reply = () => {
      throw new Error("ECONNREFUSED");
    };
    const res = await hit(["checkout"], { method: "POST", body: { plan: "pro" }, headers: { authorization: "Bearer t" } });
    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("stripe_unreachable");
    expect(body.url).toBeUndefined();
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("an empty upstream body is still a failure, never a blank 200 success", async () => {
    reply = () => new Response("", { status: 200 });
    const res = await hit(["checkout"], { method: "POST", body: { plan: "pro" } });
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("stripe_unreachable");
    expect(body.url).toBeUndefined();
  });

  test("the client renders that exact answer as 'we couldn't reach the checkout'", async () => {
    // The real proxy output, fed to the real client — the two must agree.
    reply = () => {
      throw new Error("ECONNREFUSED");
    };
    const res = await hit(["checkout"], { method: "POST", body: { plan: "pro" }, headers: { authorization: "Bearer t" } });
    const result = await startCheckout({
      plan: "pro",
      token: "t",
      fetchImpl: (async () => new Response(res.body, { status: res.statusCode })) as unknown as typeof fetch,
    });
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("stripe_unreachable");
    expect(KNOWN_REFUSAL_CODES).toContain(result.code);
    const notice = noticeFor(result);
    expect(notice.tone).toBe("warn");
    expect(notice.body).toContain("nothing was created and no payment has been taken");
    expect(notice.retry).toBe(true);
  });
});

/* ================================================================== *
 * D. THE DEPLOYMENT CONTRACT — the REWRITES do the routing, not a filename
 * ================================================================== */

/**
 * The twelve files this router replaces. They are still on disk in this commit
 * ON PURPOSE: with them present Vercel counts 13 functions, one over the Hobby
 * ceiling, so the deploy FAILS and the working build keeps serving. That is the
 * safe order — prove the router locally, then delete the twelve in their own
 * revertable commit. Both states are accepted below; nothing in between is.
 */
const LEGACY_FUNCTIONS = [
  "comps.ts",
  "comps/revoke.ts",
  "go.ts",
  "instant-wins.ts",
  "leads.ts",
  "login.ts",
  "me.ts",
  "odds-leagues.ts",
  "odds.ts",
  "same-match.ts",
  "signup.ts",
  "stripe-webhook.ts",
].sort();

/** Every .ts under api/, nested ones included — i.e. Vercel's function count. */
function apiFunctionFiles(): string[] {
  const dir = join(ROOT, "api");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      files.push(...readdirSync(abs).filter((f) => f.endsWith(".ts")).map((f) => `${entry}/${f}`));
    }
  }
  return files.sort();
}

function vercelRewrites(): Array<{ source: string; destination: string }> {
  return JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")).rewrites;
}

describe("D. the deployment contract: two rewrites to api/router, SPA catch-all last", () => {
  test("vercel.json rewrites /api/(.*) to /api/router?path=$1", () => {
    const api = vercelRewrites().filter((r) => r.source === "/api/(.*)");
    expect(api.length).toBe(1);
    expect(api[0]!.destination).toBe("/api/router?path=$1");
  });

  test("vercel.json rewrites /go/(.*) to /api/router?path=go&slug=$1", () => {
    const go = vercelRewrites().filter((r) => r.source === "/go/(.*)");
    expect(go.length).toBe(1);
    expect(go[0]!.destination).toBe("/api/router?path=go&slug=$1");
  });

  test("the function both rewrites point at really exists", () => {
    // A rewrite to a file that is not there is the silent version of the
    // bracketed-filename failure: 404 or the SPA, never a JSON error.
    expect(existsSync(join(ROOT, "api", "router.ts"))).toBe(true);
    for (const r of vercelRewrites()) {
      if (r.destination.startsWith("/api/router")) expect(existsSync(join(ROOT, "api", "router.ts"))).toBe(true);
    }
  });

  test("nothing but those two rewrites can claim /api or /go", () => {
    // THE FAILURE THIS PINS. With no /api rewrite, `/(.*)` → /index.html is what
    // answered /api/me, /api/odds and /go/mrq on the live domain: a 200 with a
    // web page instead of JSON, and no redirect at all.
    const claiming = vercelRewrites()
      .filter((r) => /^\/(api|go)(\/|$)/.test(r.source))
      .map((r) => r.source)
      .sort();
    expect(claiming).toEqual(["/api/(.*)", "/go/(.*)"]);
  });

  test("both API rewrites sit ABOVE the SPA catch-all, which is last", () => {
    const rewrites = vercelRewrites();
    const spa = rewrites.findIndex((r) => r.destination === "/index.html");
    expect(spa).toBe(rewrites.length - 1);
    for (const source of ["/api/(.*)", "/go/(.*)"]) {
      expect(rewrites.findIndex((r) => r.source === source)).toBeLessThan(spa);
    }
  });

  test("the SPA fallback still serves /subscribe and /free-bets", () => {
    const config = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8"));
    const rewrites = config.rewrites as Array<{ source: string; destination: string }>;
    // A catch-all rewrite to index.html is the only thing that makes a client
    // route work on a static host: /subscribe and /free-bets are not files.
    expect(rewrites[rewrites.length - 1]).toEqual({ source: "/(.*)", destination: "/index.html" });
    expect(config.outputDirectory).toBe("dist");
    expect(config.framework).toBe("vite");
  });

  test("no api file uses the bracketed catch-all name that failed on this project", () => {
    // `api/[...path].ts` is a FRAMEWORK-project convention. Here it deployed and
    // routed nothing. A bracket in this directory is a bug, not a shortcut.
    for (const f of apiFunctionFiles()) expect(f).not.toContain("[");
  });

  test("the router is self-contained: no relative imports to fail at load", () => {
    const source = readFileSync(API_FILE, "utf8");
    const relativeImports = source.match(/^\s*import[^;]*from\s+["']\./gm) ?? [];
    expect(relativeImports).toEqual([]);
    // Only node builtins are imported.
    const froms = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const f of froms) expect(f.startsWith("node:")).toBe(true);
  });

  test("api/ is either the one router, or the router beside exactly the twelve it replaces", () => {
    const files = apiFunctionFiles();
    expect(files).toContain("router.ts");
    const consolidated = files.length === 1 && files[0] === "router.ts";
    if (!consolidated) {
      // The deliberate interim state: 13 functions, one OVER Vercel's ceiling,
      // so the deploy fails and the working build keeps serving. Nothing else
      // may appear here — the follow-up commit deletes exactly these twelve.
      expect(files).toEqual(["router.ts", ...LEGACY_FUNCTIONS].sort());
      expect(files.length).toBe(13);
      expect(files.length).toBeGreaterThan(12);
    }
  });

  test("every client route the plan lists is a page file (so the fallback has something to boot)", () => {
    const pages = readdirSync(join(ROOT, "src", "pages")).map((f) => f.replace(/\.tsx$/, ""));
    // The files are PascalCase; the ROUTES are not. These are the pages behind
    // /, /subscribe, /free-bets, /how-we-check-offers, /oddsmatcher and /lay-bets.
    for (const page of ["Home", "Subscribe", "FreeBets", "HowWeCheckOffers", "Oddsmatcher", "LayBets"]) {
      expect(pages).toContain(page);
    }
  });
});
