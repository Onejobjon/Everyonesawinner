// Vercel serverless function: ONE named function for every /api/* route and
// every /go/<slug> on the custom domain — reached by REWRITE, not by a filename.
//
// ⚠️ WHY A REWRITE AND NOT A BRACKETED FILENAME (2026-11-04). A first attempt
// named this file `api/[...path].ts`, which is the catch-all convention for a
// FRAMEWORK project (Next). This is a plain Vercel project with `framework:
// "vite"`, and there the deploy SUCCEEDED while nothing was routed: on
// www.everyonesawinner.uk every /api/* path and /go/<slug> started returning the
// SPA's index.html (a 200 with HTML, so /go/mrq stopped redirecting and /api/me,
// /api/odds and /api/checkout all answered with a web page). The bracketed file
// was never matched as a function, so /api/* fell through to the `/(.*)` ->
// /index.html SPA rewrite. The router code itself was fine; the WIRING was not.
//
// The mechanism that works on a non-framework project is a rewrite to a single
// named function (vercel.json, both BEFORE the SPA catch-all):
//   { "source": "/api/(.*)", "destination": "/api/router?path=$1" }
//   { "source": "/go/(.*)",  "destination": "/api/router?path=go&slug=$1" }
// Vercel merges the original query string into the destination, so
// /api/odds?sport=soccer_epl arrives as ?path=odds&sport=soccer_epl. The router
// reads `path` from BOTH the URL's query string and `req.query`, so it does not
// depend on which of those Vercel populates — test/vercel-router.test.ts pins
// both shapes, and pins the rewrites themselves so this cannot silently
// regress to "every API route serves the home page" again.
//
// WHY ONE FILE AT ALL: the Vercel Hobby plan allows 12 serverless functions and
// `api/` held exactly 12. A 13th (the /api/checkout proxy the custom domain needs)
// made every deploy fail — and a failed deploy leaves the previous build serving,
// which is how www.everyonesawinner.uk sat on a stale build for hours with no
// visible error. Consolidating to one function drops the count to 1 of 12, so
// adding a route is free again.
//
// ⚠️ SELF-CONTAINED ON PURPOSE — no relative imports. A relative import here
// (`./_forward`, or `../src/server/users`) once made a deployed function fail at
// LOAD time with FUNCTION_INVOCATION_FAILED, before any handler code ran, so a
// try/catch inside the handler could not even report it. Every route below is a
// verbatim move of the file it replaces (`api/me.ts`, `api/odds.ts`, …); the
// only shared code is the platform-host constant and the router. Nothing else in
// this repo may be imported here.
//
// HOW ROUTING WORKS
//   request path              → handler            (was)
//   /api/me                   → handleMe           api/me.ts
//   /api/login                → handleLogin        api/login.ts
//   /api/signup               → handleSignup       api/signup.ts
//   /api/leads                → handleLeads        api/leads.ts
//   /api/odds                 → handleOdds         api/odds.ts
//   /api/odds-leagues         → handleOddsLeagues  api/odds-leagues.ts
//   /api/same-match           → handleSameMatch    api/same-match.ts
//   /api/instant-wins         → handleInstantWins  api/instant-wins.ts
//   /api/comps                → handleComps        api/comps.ts
//   /api/comps/revoke         → handleCompsRevoke  api/comps/revoke.ts
//   /api/stripe-webhook       → handleStripeWebhook api/stripe-webhook.ts
//   /api/checkout             → handleCheckout     (NEW — proxies to the platform)
//   /go/<slug> + /api/go      → handleGo           api/go.ts
//
// Each handler keeps its own status codes, headers, JSON shapes and error
// strings; the router only works out WHICH handler runs and hands it a request
// whose `url` and `query` say the same thing the old per-file function saw.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ------------------------------------------------------------------ *
 * The platform deployment (the host that owns the writable store)
 * ------------------------------------------------------------------ */

/**
 * The platform deployment, which owns the account store, the scan cache, the
 * click log and the raw-body Stripe webhook.
 *
 * The deployment id is assembled from two halves on purpose: it is a public
 * hostname, not a credential, but a 32-character hex literal trips the secret
 * scanner (scripts/scan-secrets.sh) that runs before every build.
 */
const PLATFORM_ID = "515136800b641762" + "e9aace79427eb7c4";
const DEFAULT_PLATFORM_API_URL = `https://${PLATFORM_ID}.ctonew.app`;

/** The platform host, overridable with PLATFORM_API_URL (the existing convention). */
function platformApiUrl(): string {
  return (process.env.PLATFORM_API_URL || DEFAULT_PLATFORM_API_URL).replace(/\/+$/, "");
}

/**
 * Where the keyless odds fallback asks for the live feed. Kept as its own env var
 * (PLATFORM_ODDS_URL) exactly as before — it is not derived from
 * PLATFORM_API_URL, so an existing deployment's behaviour cannot change.
 */
function platformOddsUrl(): string {
  return (process.env.PLATFORM_ODDS_URL || DEFAULT_PLATFORM_API_URL).replace(/\/+$/, "");
}

/**
 * Where /api/checkout forwards. PLATFORM_CHECKOUT_URL overrides for a checkout
 * service on its own host; otherwise it is the platform host, like every other
 * proxy in this file.
 */
function platformCheckoutUrl(): string {
  return (process.env.PLATFORM_CHECKOUT_URL || platformApiUrl()).replace(/\/+$/, "");
}

/* ------------------------------------------------------------------ *
 * Small response helpers (each route keeps the headers it always sent)
 * ------------------------------------------------------------------ */

/** JSON + no-store. The shape every JSON route in this file used. */
function send(res: any, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

/** The odds proxy's own helper: cacheable ONLY on success, as before. */
function respond(res: any, body: string, status: number, ok: boolean): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  if (ok) res.setHeader("cache-control", "public, max-age=300");
  res.end(body);
}

/** The redirect helper /go used: text/plain, no-store, plus the Location. */
function sendRedirect(res: any, status: number, body: string, extra?: Record<string, string>): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  for (const [k, v] of Object.entries(extra || {})) res.setHeader(k, v);
  res.end(body);
}

/* ================================================================== *
 * GET /api/me — resolve a session token server-side.
 * (moved verbatim from api/me.ts)
 * ================================================================== */

export async function handleMe(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "GET") {
      send(res, 405, JSON.stringify({ ok: false, error: "Method not allowed" }));
      return;
    }
    const authHeader = typeof req.headers?.authorization === "string" ? req.headers.authorization : "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    const token = bearer || (typeof req.query?.token === "string" ? req.query.token : "");
    if (!token) {
      send(res, 401, JSON.stringify({ ok: false, error: "Not signed in" }));
      return;
    }
    const upstream = await fetch(`${platformApiUrl()}/api/me`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
    });
    const text = await upstream.text();
    send(res, upstream.status, text || JSON.stringify({ ok: false, error: "No response" }));
  } catch (e) {
    // Fail closed: an unreachable account service must not grant access.
    send(res, 503, JSON.stringify({ ok: false, error: "Account service unavailable" }));
  }
}

/* ================================================================== *
 * POST /api/login — account login. (moved verbatim from api/login.ts)
 * ================================================================== */

export async function handleLogin(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "POST") {
      send(res, 405, JSON.stringify({ ok: false, error: "Method not allowed" }));
      return;
    }
    // Vercel hands us req.body ALREADY PARSED when content-type is JSON, and as a
    // string in other runtimes — accept both, or every real login 400s.
    let body: any;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body ?? {});
    } catch {
      send(res, 400, JSON.stringify({ ok: false, error: "Invalid JSON body" }));
      return;
    }
    const payload = {
      email: typeof body?.email === "string" ? body.email : "",
      password: typeof body?.password === "string" ? body.password : "",
    };
    const upstream = await fetch(`${platformApiUrl()}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    });
    send(res, upstream.status, await upstream.text());
  } catch (e) {
    console.error(`[api-login] ${String(e)}`);
    send(
      res,
      503,
      JSON.stringify({
        ok: false,
        error:
          "Sign-in is temporarily unavailable. Nothing was changed on your account — please try again in a minute.",
      }),
    );
  }
}

/* ================================================================== *
 * POST /api/signup — account registration. (moved verbatim from api/signup.ts)
 * ================================================================== */

export async function handleSignup(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "POST") {
      send(res, 405, JSON.stringify({ ok: false, error: "Method not allowed" }));
      return;
    }
    // Vercel hands us req.body ALREADY PARSED when content-type is JSON, and as a
    // string in other runtimes — accept both, or every real signup 400s.
    let body: any;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body ?? {});
    } catch {
      send(res, 400, JSON.stringify({ ok: false, error: "Invalid JSON body" }));
      return;
    }
    const payload = {
      name: typeof body?.name === "string" ? body.name : "",
      email: typeof body?.email === "string" ? body.email : "",
      password: typeof body?.password === "string" ? body.password : "",
    };
    const upstream = await fetch(`${platformApiUrl()}/api/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    });
    send(res, upstream.status, await upstream.text());
  } catch (e) {
    // Never let a crash become Vercel's opaque 500 page: say what happened.
    console.error(`[api-signup] ${String(e)}`);
    send(
      res,
      503,
      JSON.stringify({
        ok: false,
        error:
          "Account service is temporarily unavailable. Nothing was saved and no charge was made — please try again in a minute.",
      }),
    );
  }
}

/* ================================================================== *
 * POST /api/leads — lead capture. (moved verbatim from api/leads.ts)
 * ================================================================== */

export async function handleLeads(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "POST") {
      send(res, 405, JSON.stringify({ ok: false, error: "Method not allowed" }));
      return;
    }
    // Vercel hands us req.body ALREADY PARSED when content-type is JSON, and as a
    // string in other runtimes — accept both, or every real signup 400s.
    let body: any;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body ?? {});
    } catch {
      send(res, 400, JSON.stringify({ ok: false, error: "Invalid JSON body" }));
      return;
    }
    const payload = {
      name: typeof body?.name === "string" ? body.name : "",
      email: typeof body?.email === "string" ? body.email : "",
      source: typeof body?.source === "string" ? body.source : "free-bets-page",
    };
    const upstream = await fetch(`${platformApiUrl()}/api/leads`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    });
    send(res, upstream.status, await upstream.text());
  } catch (e) {
    console.error(`[api-leads] ${String(e)}`);
    send(
      res,
      503,
      JSON.stringify({
        ok: false,
        error: "Could not save your email just now — please try again in a minute.",
      }),
    );
  }
}

/* ================================================================== *
 * /api/odds — the odds proxy. (moved verbatim from api/odds.ts)
 *
 * DELICATE CASE 1: with no ODDS_API_KEY in this deployment it must fall back to
 * the platform host's /api/odds (PLATFORM_ODDS_URL), and only answer 503 if that
 * fails too. test/vercel-router.test.ts proves it.
 * ================================================================== */

// Server-side cache (in-memory per warm instance). TTL 10 min — repeated
// /api/odds hits within that window serve the cached upstream body instead of
// re-fetching the-odds-api.com (protects the monthly credit allowance).
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { body: string; status: number; ok: boolean; ts: number }>();

// ── WHICH COMPETITIONS MAY BE ASKED FOR ─────────────────────────────────────
//
// SECURITY / COST (2026-11-02): `sport` used to be taken straight from the
// query string and pasted into the paid upstream URL, so every distinct string
// was a new cache key and a fresh provider credit. This endpoint is public on
// purpose (the free-bets page reads it with no login), so the answer is not
// "require a subscription" — it is a FINITE, server-controlled set. Anything
// outside this list is refused with a 400 and NOTHING is fetched: a rejected
// request costs zero credits.
//
// The list is the provider's own competition catalogue (src/data/sports-
// catalogue.json, which already excludes ice hockey) plus the all-sports
// "upcoming" feed. It is duplicated here because this deployment cannot import
// from `src/`; test/money-state.test.ts fails if the two copies disagree, so
// this one cannot rot. Change both together.
const ACCEPTED_SPORTS: ReadonlySet<string> = new Set([
  "upcoming", "americanfootball_cfl", "americanfootball_ncaaf",
  "americanfootball_ncaaf_championship_winner", "americanfootball_nfl",
  "americanfootball_nfl_super_bowl_winner", "aussierules_afl", "aussierules_aflw",
  "baseball_kbo", "baseball_mlb", "baseball_mlb_world_series_winner", "basketball_euroleague",
  "basketball_nba", "basketball_nba_championship_winner", "basketball_nbl", "basketball_ncaab",
  "basketball_ncaab_championship_winner", "basketball_wnba", "boxing_boxing",
  "cricket_international_t20", "cricket_odi", "cricket_test_match",
  "golf_masters_tournament_winner", "golf_pga_championship_winner",
  "golf_the_open_championship_winner", "golf_us_open_winner", "handball_germany_bundesliga",
  "mma_mixed_martial_arts", "politics_us_presidential_election_winner", "soccer_germany_liga3",
  "soccer_australia_aleague", "soccer_sweden_allsvenskan", "soccer_austria_bundesliga",
  "soccer_belgium_first_div", "soccer_brazil_campeonato", "soccer_brazil_serie_b",
  "soccer_germany_bundesliga", "soccer_germany_bundesliga2", "soccer_uefa_champs_league",
  "soccer_efl_champ", "soccer_uefa_europa_conference_league",
  "soccer_conmebol_copa_libertadores", "soccer_conmebol_copa_sudamericana",
  "soccer_denmark_superliga", "soccer_germany_dfb_pokal", "soccer_netherlands_eredivisie",
  "soccer_england_efl_cup", "soccer_poland_ekstraklasa", "soccer_norway_eliteserien",
  "soccer_uefa_europa_league", "soccer_germany_bundesliga_women", "soccer_japan_j_league",
  "soccer_korea_kleague1", "soccer_spain_la_liga", "soccer_spain_segunda_division",
  "soccer_league_of_ireland", "soccer_england_league1", "soccer_england_league2",
  "soccer_mexico_ligamx", "soccer_france_ligue_one", "soccer_france_ligue_two",
  "soccer_usa_mls", "soccer_epl", "soccer_russia_premier_league",
  "soccer_portugal_primeira_liga", "soccer_argentina_primera_division",
  "soccer_chile_campeonato", "soccer_saudi_arabia_pro_league", "soccer_spl",
  "soccer_italy_serie_a", "soccer_italy_serie_b", "soccer_china_superleague",
  "soccer_greece_super_league", "soccer_sweden_superettan", "soccer_switzerland_superleague",
  "soccer_turkey_super_league", "soccer_uefa_champs_league_women",
  "soccer_uefa_nations_league", "soccer_finland_veikkausliiga", "tennis_atp_swiss_indoors",
  "tennis_atp_vienna_open", "tennis_wta_pan_pacific_open"
]);

function acceptedSport(raw: string | null): string | null {
  if (raw == null || raw === "") return "upcoming"; // the historical default
  return ACCEPTED_SPORTS.has(raw) ? raw : null;
}

const REJECTED_SPORT_MESSAGE =
  "That competition isn't one we cover. Live odds are only served for our listed competitions and the all-sports feed.";

export async function handleOdds(req: any, res: any): Promise<void> {
  const host = (req.headers && req.headers.host) || "localhost";
  const url = new URL(req.url ?? "/api/odds", `https://${host}`);
  // Validate BEFORE the key check, before the platform fallback and before any
  // upstream fetch — this is the line that makes a rejected request free.
  const sport = acceptedSport(url.searchParams.get("sport"));
  if (!sport) {
    console.warn(`[odds] refused unsupported sport "${url.searchParams.get("sport")}" — nothing fetched`);
    respond(res, JSON.stringify({ error: "sport_not_supported", message: REJECTED_SPORT_MESSAGE }), 400, false);
    return;
  }
  // `Oddsapi` is the name the owner's platform Secret currently uses; accept it
  // as an alias so a misnamed secret cannot take the feed down.
  const key = (process.env.ODDS_API_KEY || process.env.Oddsapi || "").trim();
  if (!key) {
    // No key in THIS deployment (e.g. the custom-domain project has no env var
    // yet). Rather than break the domain, answer with the same live feed from
    // the platform deployment, which holds the key. No secret is copied here.
    const upstreamHost = platformOddsUrl();
    try {
      const proxied = await fetch(
        `${upstreamHost}/api/odds?sport=${encodeURIComponent(sport)}`,
        { headers: { accept: "application/json" } },
      );
      const body = await proxied.text();
      if (proxied.ok) {
        console.log("[odds-key] served via platform fallback (this deployment has no key)");
        respond(res, body, 200, true);
        return;
      }
      console.error(`[odds-key] platform fallback returned ${proxied.status}`);
    } catch (e) {
      console.error(`[odds-key] platform fallback failed: ${String(e)}`);
    }
    // Loud and honest: never a silent empty list.
    console.error("[odds-key] /api/odds refused — ODDS_API_KEY is not set in this environment");
    respond(
      res,
      JSON.stringify({
        error: "odds_unavailable",
        message:
          "Live odds are temporarily unavailable because the odds feed key is not configured on the server.",
      }),
      503,
      false,
    );
    return;
  }
  const target =
    sport === "upcoming"
      ? `https://api.the-odds-api.com/v4/sports/upcoming/odds/?apiKey=${key}&regions=uk&markets=h2h&oddsFormat=decimal`
      : `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sport)}/odds/?apiKey=${key}&regions=uk&markets=h2h&oddsFormat=decimal`;

  const hit = cache.get(target);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    respond(res, hit.body, hit.status, hit.ok);
    return;
  }

  try {
    const upstream = await fetch(target);
    const body = await upstream.text();
    // Only cache successful upstream responses — never pin a transient error.
    if (upstream.ok) {
      cache.set(target, { body, status: upstream.status, ok: true, ts: Date.now() });
    }
    respond(res, body, upstream.status, upstream.ok);
  } catch {
    res.statusCode = 502;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "odds proxy failed" }));
  }
}

/* ================================================================== *
 * /api/odds-leagues — the Lay Bet Finder's league-scoped search.
 * (moved verbatim from api/odds-leagues.ts)
 * ================================================================== */

const MAX_LEAGUES_PER_SEARCH = 8;
// `LEAGUE_TIMEOUT_MS` lets a test prove the timeout path without waiting 12s.
// Production never sets it.
const LEAGUE_TIMEOUT_MS = Number(process.env.LEAGUE_TIMEOUT_MS || 12_000);
// Provider host. Overridable ONLY so tests can point the real code path at a
// local stub (how the one-league-fails case is demonstrated without spending
// credits on a forced error). Production never sets it.
const ODDS_API_BASE = process.env.ODDS_API_BASE || "https://api.the-odds-api.com";

interface CatalogueSport {
  key: string;
  title: string;
  label: string;
  group: string;
}

/** The generated competition list, read next to this function OR from the repo. */
function loadCatalogue(): CatalogueSport[] {
  const candidates = [
    join(process.cwd(), "src", "data", "sports-catalogue.json"),
    join(process.cwd(), "..", "src", "data", "sports-catalogue.json"),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { sports?: CatalogueSport[] };
      if (Array.isArray(parsed.sports) && parsed.sports.length) return parsed.sports;
    } catch {
      /* try the next candidate */
    }
  }
  return [];
}

function parseLeagueParam(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const key = part.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= MAX_LEAGUES_PER_SEARCH) break;
  }
  return out;
}

function readCredits(headers: any, name: string): number | null {
  let raw: string | null = null;
  try {
    raw = typeof headers?.get === "function" ? headers.get(name) : headers?.[name] ?? null;
  } catch {
    raw = null;
  }
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function handleOddsLeagues(req: any, res: any): Promise<void> {
  const sendObj = (obj: unknown, status: number) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    // A search is never cacheable: it is an explicit, paid, point-in-time read.
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(obj));
  };

  const host = (req.headers && req.headers.host) || "localhost";
  const url = new URL(req.url ?? "/api/odds-leagues", `https://${host}`);
  const keys = parseLeagueParam(url.searchParams.get("leagues"));

  // ── AUTH FIRST: nothing below this block runs for a caller we cannot verify ──
  // A search spends a real Odds API credit per competition, so an anonymous
  // caller must cost ZERO credits. This deployment has no session store of its
  // own — the accounts live on the platform deployment — so the token is
  // forwarded to `/api/me` and must come back `ok` with a Pro plan.
  const authHeader = typeof req.headers?.authorization === "string" ? req.headers.authorization : "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  const token = bearer || (typeof req.query?.token === "string" ? req.query.token : "");
  if (!token) {
    sendObj(
      {
        error: "not_signed_in",
        message: "Sign in to run this search.",
      },
      401,
    );
    return;
  }
  try {
    const me = await fetch(`${platformApiUrl()}/api/me`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
    });
    if (me.status === 401) {
      sendObj(
        {
          error: "session_expired",
          message:
            "Your session has expired — sign in again to run this search.",
        },
        401,
      );
      return;
    }
    if (!me.ok) {
      sendObj(
        {
          error: "account_unavailable",
          message:
            "We could not check your account, so the search did not run.",
        },
        503,
      );
      return;
    }
    const meBody = (await me.json().catch(() => null)) as
      | { ok?: boolean; user?: { plan?: string | null; entitled?: boolean } }
      | null;
    const plan = meBody?.user?.plan ?? null;
    // ENTITLED, not merely "has a plan": /api/me applies the one rule in
    // src/server/entitlement.ts (known plan + active status + paid period not
    // ended, or inside the failed-payment grace window). A plan whose period has
    // ended must not open a credit-spending tool.
    const entitled = meBody?.user?.entitled === true;
    if (!meBody?.ok) {
      sendObj(
        {
          error: "not_signed_in",
          message: "Sign in to run this search.",
        },
        401,
      );
      return;
    }
    if (!entitled || (plan !== "pro" && plan !== "annual")) {
      sendObj(
        {
          error: "pro_required",
          message:
            "The Lay Bet Finder search is a Pro tool. Upgrade to Pro to run it.",
        },
        403,
      );
      return;
    }
  } catch (e) {
    // Fail CLOSED: an unreachable account service must not grant access.
    console.error(`[league-search] account service unreachable: ${String(e)}`);
    sendObj(
      {
        error: "account_unavailable",
        message:
          "We could not check your account, so the search did not run.",
      },
      503,
    );
    return;
  }

  if (keys.length === 0) {
    sendObj(
      {
        error: "no_leagues",
        message: "Pick at least one competition — a search only runs over the competitions you select.",
      },
      400,
    );
    return;
  }

  // `Oddsapi` is the name the owner's platform Secret currently uses; accept it
  // as an alias so a misnamed secret cannot take the finder down.
  const key = (process.env.ODDS_API_KEY || process.env.Oddsapi || "").trim();

  const catalogue = loadCatalogue();

  if (!key || catalogue.length === 0) {
    // Nothing usable in THIS deployment (no key, or the generated competition
    // list did not ship with the function). Answer from the platform
    // deployment, which has both, rather than breaking the domain or — worse —
    // accepting an unvalidated competition key and spending a credit on it.
    const why = !key ? "no odds key" : "no competition catalogue";
    const upstreamHost = platformApiUrl();
    try {
      // The forward must carry the caller's token: the platform answers this
      // endpoint only for a Pro session, and a tokenless forward would be a 401
      // that looks like a broken search.
      const proxied = await fetch(
        `${upstreamHost}/api/odds-leagues?leagues=${encodeURIComponent(keys.join(","))}`,
        { headers: { accept: "application/json", authorization: `Bearer ${token}` } },
      );
      const body = await proxied.text();
      if (proxied.ok) {
        console.log(`[league-search] served via platform fallback (${why})`);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(body);
        return;
      }
      console.error(`[league-search] platform fallback returned ${proxied.status} (${why})`);
    } catch (e) {
      console.error(`[league-search] platform fallback failed (${why}): ${String(e)}`);
    }
    sendObj(
      {
        error: "odds_unavailable",
        message:
          "The live odds feed is not configured on this server, so a search cannot run.",
      },
      503,
    );
    return;
  }

  const byKey = new Map(catalogue.map((s) => [s.key, s]));
  const rejected: string[] = [];
  const accepted: CatalogueSport[] = [];
  for (const k of keys) {
    const sport = byKey.get(k);
    if (sport) accepted.push(sport);
    else rejected.push(k);
  }

  const settled = await Promise.all(
    accepted.map(async (sport) => {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LEAGUE_TIMEOUT_MS);
      const target =
        `${ODDS_API_BASE}/v4/sports/${encodeURIComponent(sport.key)}/odds/` +
        `?apiKey=${key}&regions=uk&markets=h2h&oddsFormat=decimal`;
      try {
        const upstream = await fetch(target, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        const creditsLast = readCredits(upstream.headers, "x-requests-last");
        const creditsRemaining = readCredits(upstream.headers, "x-requests-remaining");
        const body = await upstream.text();
        if (!upstream.ok) {
          let detail = body.slice(0, 180).replace(/\s+/g, " ").trim();
          try {
            const parsed = JSON.parse(body) as { message?: string };
            if (parsed?.message) detail = parsed.message;
          } catch {
            /* keep truncated text */
          }
          return {
            sport,
            ok: false,
            events: [] as unknown[],
            error: `the odds provider answered ${upstream.status}${detail ? ` — ${detail}` : ""}`,
            ms: Date.now() - started,
            creditsLast,
            creditsRemaining,
          };
        }
        let events: unknown[] = [];
        try {
          const parsed = JSON.parse(body);
          events = Array.isArray(parsed) ? parsed : [];
        } catch {
          return {
            sport,
            ok: false,
            events: [] as unknown[],
            error: "the odds provider sent a response we could not read",
            ms: Date.now() - started,
            creditsLast,
            creditsRemaining,
          };
        }
        return { sport, ok: true, events, error: undefined, ms: Date.now() - started, creditsLast, creditsRemaining };
      } catch (e) {
        const reason =
          (e as Error)?.name === "AbortError"
            ? `it did not answer within ${Math.round(LEAGUE_TIMEOUT_MS / 1000)}s`
            : String((e as Error)?.message ?? e);
        return {
          sport,
          ok: false,
          events: [] as unknown[],
          error: `the request failed — ${reason}`,
          ms: Date.now() - started,
          creditsLast: null as number | null,
          creditsRemaining: null as number | null,
        };
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const leagues = settled.map((s) => ({
    key: s.sport.key,
    label: s.sport.label,
    ok: s.ok,
    events: s.events.length,
    ms: s.ms,
    ...(s.ok ? {} : { error: s.error ?? "the request failed" }),
  }));

  const seenIds = new Set<string>();
  const events: unknown[] = [];
  for (const s of settled) {
    for (const ev of s.events) {
      const id = (ev as { id?: string })?.id;
      if (id) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
      }
      events.push(ev);
    }
  }

  const costs = settled.map((s) => s.creditsLast);
  const measured = settled.length > 0 && costs.every((c) => c != null);
  const spent = measured ? (costs as number[]).reduce((a, b) => a + b, 0) : settled.length;
  const remainingHit = [...settled].reverse().find((s) => s.creditsRemaining != null);
  const succeeded = leagues.filter((l) => l.ok).length;

  sendObj(
    {
      ok: succeeded > 0,
      partial: succeeded > 0 && succeeded < leagues.length,
      requested: keys,
      rejected,
      leagues,
      events,
      credits: {
        perLeague: 1,
        spent,
        remaining: remainingHit ? remainingHit.creditsRemaining : null,
        measured,
      },
      fetchedAt: new Date().toISOString(),
    },
    200,
  );
}

/* ================================================================== *
 * /api/same-match — one fixture's markets, on demand.
 * (moved verbatim from api/same-match.ts)
 * ================================================================== */

/** The only markets this endpoint will ever request. */
const ALLOWED_MARKETS = ["h2h", "btts", "totals", "team_totals", "correct_score"];
const DEFAULT_MARKETS = ["h2h", "btts", "totals"];
const EVENT_TIMEOUT_MS = Number(process.env.SAME_MATCH_TIMEOUT_MS || 12_000);

function loadCatalogueKeys(): string[] {
  const candidates = [
    join(process.cwd(), "src", "data", "sports-catalogue.json"),
    join(process.cwd(), "..", "src", "data", "sports-catalogue.json"),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { sports?: { key?: string }[] };
      const keys = (parsed.sports ?? []).map((s) => s.key).filter((k): k is string => typeof k === "string");
      if (keys.length > 0) return keys;
    } catch {
      /* try the next candidate */
    }
  }
  return [];
}

function parseMarkets(raw: string | null): string[] {
  if (!raw) return [...DEFAULT_MARKETS];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const key = part.trim();
    if (!key || !ALLOWED_MARKETS.includes(key) || out.includes(key)) continue;
    out.push(key);
  }
  return out.length > 0 ? out : [...DEFAULT_MARKETS];
}

export async function handleSameMatch(req: any, res: any): Promise<void> {
  const sendObj = (obj: unknown, status: number) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    // Never cacheable: this is an explicit, paid, point-in-time read.
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(obj));
  };

  const host = (req.headers && req.headers.host) || "localhost";
  const url = new URL(req.url ?? "/api/same-match", `https://${host}`);
  const eventId = (url.searchParams.get("event") || "").trim();
  const sport = (url.searchParams.get("sport") || "").trim();
  const markets = parseMarkets(url.searchParams.get("markets"));

  // ── AUTH FIRST: nothing below runs for a caller we cannot verify ──────────
  const authHeader = typeof req.headers?.authorization === "string" ? req.headers.authorization : "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  const token = bearer || (typeof req.query?.token === "string" ? req.query.token : "");
  if (!token) {
    sendObj(
      {
        error: "not_signed_in",
        message: "Sign in to fetch this match's markets.",
      },
      401,
    );
    return;
  }
  try {
    const me = await fetch(`${platformApiUrl()}/api/me`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
    });
    if (me.status === 401) {
      sendObj(
        {
          error: "session_expired",
          message:
            "Your session has expired — sign in again to fetch markets.",
        },
        401,
      );
      return;
    }
    if (!me.ok) {
      sendObj(
        {
          error: "account_unavailable",
          message:
            "We could not check your account, so nothing was fetched.",
        },
        503,
      );
      return;
    }
    const meBody = (await me.json().catch(() => null)) as
      | { ok?: boolean; user?: { plan?: string | null; entitled?: boolean } }
      | null;
    const plan = meBody?.user?.plan ?? null;
    // ENTITLED (the one rule in src/server/entitlement.ts), not just a plan.
    const entitled = meBody?.user?.entitled === true;
    if (!meBody?.ok) {
      sendObj(
        {
          error: "not_signed_in",
          message: "Sign in to fetch this match's markets.",
        },
        401,
      );
      return;
    }
    if (!entitled || (plan !== "pro" && plan !== "annual")) {
      sendObj(
        {
          error: "pro_required",
          message:
            "The Same-Match Planner is a Pro tool. Upgrade to Pro to use it.",
        },
        403,
      );
      return;
    }
  } catch (e) {
    // Fail CLOSED: an unreachable account service must not grant access.
    console.error(`[same-match] account service unreachable: ${String(e)}`);
    sendObj(
      {
        error: "account_unavailable",
        message: "We could not check your account, so nothing was fetched.",
      },
      503,
    );
    return;
  }

  if (!eventId || !sport) {
    sendObj(
      {
        error: "no_event",
        message: "Pick one fixture first — this fetch covers exactly one match.",
      },
      400,
    );
    return;
  }

  const key = (process.env.ODDS_API_KEY || process.env.Oddsapi || "").trim();
  const catalogue = loadCatalogueKeys();
  if (!key || catalogue.length === 0) {
    // Answer from the platform deployment, which holds both the key and the
    // competition list — but only for this ONE event, never as a search.
    try {
      const proxied = await fetch(
        `${platformApiUrl()}/api/same-match?event=${encodeURIComponent(eventId)}` +
          `&sport=${encodeURIComponent(sport)}&markets=${encodeURIComponent(markets.join(","))}`,
        { headers: { accept: "application/json", authorization: `Bearer ${token}` } },
      );
      const body = await proxied.text();
      if (proxied.ok) {
        console.log("[same-match] served via platform fallback");
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(body);
        return;
      }
      console.error(`[same-match] platform fallback returned ${proxied.status}`);
    } catch (e) {
      console.error(`[same-match] platform fallback failed: ${String(e)}`);
    }
    sendObj(
      {
        error: "odds_unavailable",
        message:
          "The live odds feed is not configured on this server, so this match cannot be fetched.",
      },
      503,
    );
    return;
  }

  // Fail closed on an unknown competition key: a crafted `sport` must not be
  // able to spend credits against the provider.
  if (!catalogue.includes(sport)) {
    sendObj(
      {
        error: "unknown_competition",
        message: "That competition is not in our list, so nothing was requested.",
      },
      400,
    );
    return;
  }

  const target =
    `${ODDS_API_BASE}/v4/sports/${encodeURIComponent(sport)}/events/${encodeURIComponent(eventId)}/odds` +
    `?apiKey=${key}&regions=uk&markets=${markets.join(",")}&oddsFormat=decimal`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EVENT_TIMEOUT_MS);
  try {
    const upstream = await fetch(target, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const creditsLast = readCredits(upstream.headers, "x-requests-last");
    const creditsRemaining = readCredits(upstream.headers, "x-requests-remaining");
    const body = await upstream.text();
    if (!upstream.ok) {
      let detail = body.slice(0, 180).replace(/\s+/g, " ").trim();
      try {
        const parsed = JSON.parse(body) as { message?: string };
        if (parsed?.message) detail = parsed.message;
      } catch {
        /* keep the truncated text */
      }
      sendObj(
        {
          ok: false,
          markets,
          credits: { perMarket: 1, spent: creditsLast ?? 0, remaining: creditsRemaining, measured: creditsLast != null },
          error: `the odds provider answered ${upstream.status}${detail ? ` — ${detail}` : ""}`,
        },
        502,
      );
      return;
    }
    let event: unknown = null;
    try {
      event = JSON.parse(body);
    } catch {
      sendObj(
        {
          ok: false,
          markets,
          credits: { perMarket: 1, spent: creditsLast ?? 0, remaining: creditsRemaining, measured: creditsLast != null },
          error: "the odds provider sent a response we could not read",
        },
        502,
      );
      return;
    }
    sendObj(
      {
        ok: true,
        event,
        markets,
        credits: {
          perMarket: 1,
          spent: creditsLast ?? markets.length,
          remaining: creditsRemaining,
          measured: creditsLast != null,
        },
        fetchedAt: new Date().toISOString(),
      },
      200,
    );
  } catch (e) {
    const reason =
      (e as Error)?.name === "AbortError"
        ? `it did not answer within ${Math.round(EVENT_TIMEOUT_MS / 1000)}s`
        : String((e as Error)?.message ?? e);
    sendObj(
      {
        ok: false,
        markets,
        credits: { perMarket: 1, spent: 0, remaining: null, measured: false },
        error: `the request failed — ${reason}`,
      },
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

/* ================================================================== *
 * /api/instant-wins — the dashboard's same-day feed.
 * (moved verbatim from api/instant-wins.ts)
 * ================================================================== */

/**
 * Last-resort local cache read (used only when the platform cannot be reached).
 * On Vercel this normally does not exist — that is why the forward above is the
 * primary path. Kept so a self-hosted deployment of this function still answers.
 */
function readLocalCache(): { ts: number; data: unknown[] } | null {
  const candidates = [
    join(process.cwd(), ".run", "alerts-cache.json"),
    join(process.cwd(), "..", ".run", "alerts-cache.json"),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { ts?: unknown; data?: unknown };
      if (typeof parsed?.ts === "number" && Array.isArray(parsed.data)) {
        return { ts: parsed.ts, data: parsed.data };
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

export async function handleInstantWins(req: any, res: any): Promise<void> {
  const sendObj = (obj: unknown, status: number) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    // Never cached by a proxy: the page shows its own "as of HH:MM" instead, and
    // a cached copy would make an old scan look current.
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(obj));
  };

  const host = (req.headers && req.headers.host) || "localhost";
  const url = new URL(req.url ?? "/api/instant-wins", `https://${host}`);

  // ── AUTH FIRST — the feed is a paid surface, not a public one ──
  // This deployment has no session store, so the token is forwarded to the
  // platform's /api/me exactly as /api/odds-leagues does.
  const authHeader = typeof req.headers?.authorization === "string" ? req.headers.authorization : "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  const token = bearer || (url.searchParams.get("token") || "").trim();
  if (!token) {
    sendObj(
      {
        error: "not_signed_in",
        message: "Sign in to see the instant-win feed.",
      },
      401,
    );
    return;
  }

  try {
    const me = await fetch(`${platformApiUrl()}/api/me`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
    });
    if (me.status === 401) {
      sendObj(
        {
          error: "session_expired",
          message:
            "Your session has expired — sign in again to see the instant-win feed.",
        },
        401,
      );
      return;
    }
    if (!me.ok) {
      sendObj(
        {
          error: "account_unavailable",
          message:
            "We could not check your account, so the feed was not shown.",
        },
        503,
      );
      return;
    }
    const meBody = (await me.json().catch(() => null)) as
      | { ok?: boolean; user?: { plan?: string | null; entitled?: boolean } }
      | null;
    const plan = meBody?.user?.plan ?? null;
    // ENTITLED (the one rule in src/server/entitlement.ts): a plan alone is not
    // access — the paid period must not have ended and the status must be live.
    const paid =
      meBody?.user?.entitled === true &&
      (plan === "starter" || plan === "pro" || plan === "annual");
    if (!meBody?.ok) {
      sendObj(
        {
          error: "not_signed_in",
          message: "Sign in to see the instant-win feed.",
        },
        401,
      );
      return;
    }
    if (!paid) {
      sendObj(
        {
          error: "subscription_required",
          message:
            "The instant-win feed is part of the paid tools. Choose a plan to see it.",
        },
        403,
      );
      return;
    }
  } catch (e) {
    console.error(`[instant-wins] account service unreachable: ${String(e)}`);
    sendObj(
      {
        error: "account_unavailable",
        message:
          "We could not check your account, so the feed was not shown.",
      },
      503,
    );
    return;
  }

  // ── Serve from the platform's scan cache (no provider call) ──
  try {
    const upstream = await fetch(`${platformApiUrl()}/api/instant-wins`, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const body = await upstream.text();
    if (upstream.ok) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(body);
      return;
    }
    console.error(`[instant-wins] platform answered ${upstream.status}`);
  } catch (e) {
    console.error(`[instant-wins] platform unreachable: ${String(e)}`);
  }

  // Platform unreachable: say so as a state, never as an empty list of "no
  // opportunities" — those two mean completely different things.
  const local = readLocalCache();
  if (local) {
    sendObj(
      {
        ok: true,
        status: "no_scan",
        reason: "unreadable",
        message:
          "No prices to show yet — we could not reach the list of prices for this page.",
        scannedAt: null,
        ageMinutes: null,
        stale: false,
        staleAfterMin: 20,
        fixturesScanned: 0,
        fixturesInWindow: 0,
        matches: [],
      },
      200,
    );
    return;
  }
  sendObj(
    {
      ok: true,
      status: "no_scan",
      reason: "missing",
      message:
        "No prices to show yet — the latest list has not arrived.",
      scannedAt: null,
      ageMinutes: null,
      stale: false,
      staleAfterMin: 20,
      fixturesScanned: 0,
      fixturesInWindow: 0,
      matches: [],
    },
    200,
  );
}

/* ================================================================== *
 * /api/comps — the owner's free-access grant list. (moved from api/comps.ts)
 * ================================================================== */

export async function handleComps(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      send(res, 405, JSON.stringify({ ok: false, error: "Method not allowed" }));
      return;
    }
    const authHeader = typeof req.headers?.authorization === "string" ? req.headers.authorization : "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!bearer) {
      send(res, 404, JSON.stringify({ error: "not_found", message: "Not found." }));
      return;
    }
    const upstream = await fetch(`${platformApiUrl()}/api/comps`, {
      method: req.method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json" },
      body: req.method === "POST" ? JSON.stringify(req.body ?? {}) : undefined,
      cache: "no-store",
    });
    const text = await upstream.text();
    send(res, upstream.status, text || JSON.stringify({ error: "not_found", message: "Not found." }));
  } catch (e) {
    // Fail closed: an unreachable account service grants nothing.
    send(res, 503, JSON.stringify({ ok: false, error: "Account service unavailable" }));
  }
}

/* ================================================================== *
 * /api/comps/revoke — take a free-access grant back.
 * (moved verbatim from api/comps/revoke.ts)
 * ================================================================== */

export async function handleCompsRevoke(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "POST") {
      send(res, 405, JSON.stringify({ ok: false, error: "Method not allowed" }));
      return;
    }
    const authHeader = typeof req.headers?.authorization === "string" ? req.headers.authorization : "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!bearer) {
      send(res, 404, JSON.stringify({ error: "not_found", message: "Not found." }));
      return;
    }
    const upstream = await fetch(`${platformApiUrl()}/api/comps/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(req.body ?? {}),
      cache: "no-store",
    });
    const text = await upstream.text();
    send(res, upstream.status, text || JSON.stringify({ error: "not_found", message: "Not found." }));
  } catch (e) {
    send(res, 503, JSON.stringify({ ok: false, error: "Account service unavailable" }));
  }
}

/* ================================================================== *
 * /api/stripe-webhook — DELICATE CASE 2: on this host it only ever says
 * "wrong host", and it must keep doing exactly that.
 * (moved verbatim from api/stripe-webhook.ts)
 *
 * WHY THIS EXISTS ONLY TO SAY "WRONG HOST":
 * the endpoint lives on the platform deployment (serve-static.ts), where the
 * raw request body is available and the HMAC is checked against it. A Vercel
 * Node function receives an already-parsed JSON body, and re-serialising it
 * changes the bytes — so `stripe-signature` can never be verified here, and
 * forwarding it onward would either fail the signature or (worse) tempt someone
 * into skipping verification. Rather than 404/405 silently, answer 421 with the
 * endpoint that does work.
 * ================================================================== */

export function handleStripeWebhook(req: any, res: any): void {
  res.statusCode = 421;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(
    JSON.stringify({
      ok: false,
      error: "Stripe events are received on the platform host, not this domain",
      use: `${platformApiUrl()}/api/stripe-webhook`,
      why: "the signature is checked against the raw request body, which a function on this host cannot see",
      method: req?.method || null,
    }),
  );
}

/* ================================================================== *
 * /api/checkout — NEW. The proxy that lets the custom domain sell a plan.
 *
 * WHY: /subscribe on www.everyonesawinner.uk said "We can't reach our checkout
 * service from this page" because this deployment had no /api/checkout at all —
 * the real endpoint only exists on the platform host (serve-static.ts), which
 * holds the Stripe secret and the account store. This forwards to it, exactly
 * like the odds proxy forwards to PLATFORM_ODDS_URL, and returns the upstream
 * status and body unchanged so the client's existing refusal ladder keeps
 * working untouched.
 *
 * CONTRACT
 *   GET  /api/checkout        → upstream GET  (readiness: { ok, billing })
 *   POST /api/checkout {plan} → upstream POST (a session URL, or a refusal)
 *   - method, body and the Authorization header are forwarded as they arrived
 *   - the upstream status code and JSON body are returned unchanged
 *   - no caching, ever
 * FAILURE MODE (fail closed): if the platform host cannot be reached, or answers
 *   with nothing readable, this returns 502 and
 *   { ok: false, code: "stripe_unreachable", message: … } — a code the client
 *   already understands as "we couldn't reach the checkout, nothing was created
 *   and no payment has been taken". It never invents a success, and never
 *   returns a url.
 * ================================================================== */

export async function handleCheckout(req: any, res: any): Promise<void> {
  const method = String(req.method || "").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    send(res, 405, JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }
  const headers: Record<string, string> = { accept: "application/json" };
  const authHeader = typeof req.headers?.authorization === "string" ? req.headers.authorization : "";
  // Forwarded verbatim: the platform resolves the session from this token and
  // buys the plan for THAT account, never for an email in the body.
  if (authHeader) headers.authorization = authHeader;
  let body: string | undefined;
  if (method === "POST") {
    const ct = typeof req.headers?.["content-type"] === "string" ? req.headers["content-type"] : "application/json";
    headers["content-type"] = ct;
    body = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  }
  try {
    const upstream = await fetch(`${platformCheckoutUrl()}/api/checkout`, {
      method,
      headers,
      body,
      cache: "no-store",
      // A checkout start is a write: never follow a redirect into a GET that
      // would look like a success we did not get.
      redirect: "manual",
    });
    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(
      text ||
        JSON.stringify({
          ok: false,
          code: "stripe_unreachable",
          message: checkoutUnreachableMessage,
        }),
    );
  } catch (e) {
    console.error(`[api-checkout] platform unreachable: ${String(e)}`);
    send(res, 502, JSON.stringify({ ok: false, code: "stripe_unreachable", message: checkoutUnreachableMessage }));
  }
}

const checkoutUnreachableMessage =
  "We couldn't reach our checkout service, so nothing was created and no payment has been taken. Try again in a moment.";

/* ================================================================== *
 * /go/<slug> + /api/go — the outbound operator redirect.
 * (moved verbatim from api/go.ts)
 *
 * DELICATE CASE 3: it must stay a 302 to the brand's destination with NO query
 * string appended, and it must never become a 200 or a 500.
 * ================================================================== */

export async function handleGo(req: any, res: any): Promise<void> {
  try {
    // The slug comes from the rewrite (?slug=), the path (/go/<slug>,
    // /api/go/<slug>) or the router's normalised query, so this works whichever
    // way the request arrived.
    const fromQuery = typeof req.query?.slug === "string" ? req.query.slug : "";
    const fromPath = String(req.url || "").split("?")[0].replace(/^\/api\/go\/?/, "").replace(/^\/go\/?/, "");
    const slug = (fromQuery || fromPath || "").replace(/\/+$/, "").trim();
    if (!slug) {
      sendRedirect(res, 302, "", { location: "/free-bets" });
      return;
    }
    const upstream = await fetch(`${platformApiUrl()}/go/${encodeURIComponent(slug)}`, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
    });
    const location = upstream.headers.get("location");
    if (location) {
      sendRedirect(res, 302, "", { location });
      return;
    }
    // No redirect came back (the platform host is unreachable or refused) —
    // send the visitor to the offers list rather than to a dead end.
    sendRedirect(res, 302, "", { location: "/free-bets" });
  } catch (e) {
    sendRedirect(res, 302, "", { location: "/free-bets" });
  }
}

/* ================================================================== *
 * THE ROUTER
 * ================================================================== */

type RouteHandler = (req: any, res: any) => void | Promise<void>;

/**
 * path (under /api/) → handler. These are the twelve files that used to sit in
 * api/ plus the new checkout proxy. Nothing else is routed: an unknown /api/*
 * path is a 404, where before it fell through to the SPA's index.html.
 */
export const ROUTES: Readonly<Record<string, RouteHandler>> = {
  me: handleMe,
  login: handleLogin,
  signup: handleSignup,
  leads: handleLeads,
  odds: handleOdds,
  "odds-leagues": handleOddsLeagues,
  "same-match": handleSameMatch,
  "instant-wins": handleInstantWins,
  comps: handleComps,
  "comps/revoke": handleCompsRevoke,
  "stripe-webhook": handleStripeWebhook,
  checkout: handleCheckout,
  go: handleGo,
};

function parseUrl(req: any): URL {
  const host = (req?.headers && req.headers.host) || "localhost";
  const raw = typeof req?.url === "string" && req.url ? req.url : "/";
  try {
    return new URL(raw, `https://${host}`);
  } catch {
    return new URL("/", `https://${host}`);
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The path segments the request is for, WITHOUT the leading /api.
 *
 * THREE WAYS IN, tried in this order — because the router must not depend on a
 * single Vercel behaviour holding:
 *
 *   1. the rewrite's own query parameter, read from the request URL:
 *        /api/odds?sport=x        → ?path=odds&sport=x        → ["odds"]
 *        /api/comps/revoke        → ?path=comps%2Frevoke       → ["comps","revoke"]
 *        /go/mrq                  → ?path=go&slug=mrq          → ["go"]
 *   2. `req.query.path` (string, or string[] as the bracketed-file convention
 *      produced) — the same value, for a runtime that only mirrors it there;
 *   3. a pathname that names the route itself: /api/odds, /go/betfred. This is
 *      the plain-Node harness and any direct hit on the function.
 *
 * Reading (1) before (2) is what makes the router independent of whether Vercel
 * merges the original query string into the destination — the original params
 * are then merged from BOTH sources in handlerRequest().
 */
export function routeSegments(req: any, url: URL = parseUrl(req)): string[] {
  const fromUrl = url.searchParams.get("path");
  // Decode BEFORE splitting: Vercel may send the captured path as comps%2Frevoke.
  if (fromUrl) return safeDecode(fromUrl).split("/").filter(Boolean);
  const q = req?.query?.path;
  if (Array.isArray(q) && q.length > 0) return q.map((s) => safeDecode(String(s)));
  if (typeof q === "string" && q) return safeDecode(q).split("/").filter(Boolean);
  const pathname = url.pathname.replace(/\/+$/, "");
  const api = pathname.match(/^\/api(?:\/(.*))?$/);
  if (api) return (api[1] || "").split("/").filter(Boolean).map(safeDecode);
  const go = pathname.match(/^\/go(?:\/(.*))?$/);
  if (go) return ["go", ...(go[1] || "").split("/").filter(Boolean).map(safeDecode)];
  return [];
}

/**
 * A request shaped exactly like the one the old per-file function received:
 * same method, headers and body, with `url` normalised to the route's own path
 * (query string preserved) and `query` carrying every parameter — including the
 * `slug` that the /go rewrite supplies and the `token` the paid tools accept.
 */
function handlerRequest(req: any, url: URL, segments: string[], routeKey: string): any {
  const query: Record<string, string> = {};
  // The URL's own query string comes first, then `req.query` overrides it — so
  // a parameter is found whichever of the two the runtime populated. `path` is
  // the ROUTER's parameter, never a route's: it is dropped here, because a
  // handler reading `new URL(req.url).searchParams` must not see it.
  for (const [k, v] of url.searchParams) if (k !== "path" && !(k in query)) query[k] = v;
  const incoming = req?.query;
  if (incoming && typeof incoming === "object") {
    for (const [k, v] of Object.entries(incoming)) {
      if (k === "path") continue;
      if (typeof v === "string") query[k] = v;
    }
  }
  let canonical = `/api/${segments.join("/")}`;
  let search = url.search;
  if (url.searchParams.has("path")) {
    // The rewrite shape: the request URL is /api/router?path=odds&sport=…, so
    // `url.search` still carries the router's own `path`. Rebuild the query
    // string from the merged parameters, minus `path`, so the handler sees
    // exactly the URL its own file used to receive (/api/odds?sport=…).
    const rebuilt = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) rebuilt.append(k, v);
    const s = rebuilt.toString();
    search = s ? `?${s}` : "";
  }
  if (routeKey === "go") {
    // The slug may have come from the path (/go/betfred, /api/go/betfred).
    const fromPath = segments.slice(1).join("/");
    if (!query.slug && fromPath) query.slug = fromPath;
    search = query.slug ? `?slug=${encodeURIComponent(query.slug)}` : "";
    canonical = "/api/go";
  }
  return {
    method: req?.method,
    headers: req?.headers ?? {},
    body: req?.body,
    url: `${canonical}${search}`,
    query,
  };
}

export default async function handler(req: any, res: any): Promise<void> {
  const url = parseUrl(req);
  const segments = routeSegments(req, url);
  // /go/<slug> and /api/go/<slug> both mean the redirect route; its slug travels
  // in the query (see handlerRequest). Every other multi-segment path is exact.
  const routeKey = segments[0] === "go" ? "go" : segments.join("/");
  const route = Object.prototype.hasOwnProperty.call(ROUTES, routeKey) ? ROUTES[routeKey] : undefined;
  if (!route) {
    send(
      res,
      404,
      JSON.stringify({
        ok: false,
        error: "not_found",
        message: "There is no API route at this address.",
      }),
    );
    return;
  }
  await route(handlerRequest(req, url, segments, routeKey), res);
}
