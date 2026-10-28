// Vercel serverless function: /api/same-match — one fixture's markets, on demand,
// for the /same-match scoreline-pinning planner.
//
// ⚠️ WHY THIS FILE IS SELF-CONTAINED. On the custom domain (Vercel) the only
// server code that exists is an `api/*.ts` function, and a relative import from
// `src/` once took a whole function down at load. So the request shape lives
// here as well as in `src/server/same-match.ts` (which is what the platform
// deployment uses). The PAYLOAD SHAPING is deliberately NOT duplicated: this
// function returns the provider's own JSON and the shared, tested parser in
// `src/lib/same-match.ts` reads it, so the two hosts cannot disagree about which
// side of a market a price belongs to.
//
// CREDIT REALITY: the per-event endpoint bills 1 credit per event per market per
// region (measured), so ONE match with h2h + btts + totals costs 3 credits and
// adding correct score costs a 4th. That is why this endpoint serves exactly one
// event and refuses anything else: no sweeps, no background use.
//
// AUTH (same rule as /api/odds-leagues): Pro session required, checked BEFORE
// any provider work — anonymous → 401, signed in but not Pro → 403, cannot
// verify → 503. A rejected caller spends 0 credits.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The only markets this endpoint will ever request. */
const ALLOWED_MARKETS = ["h2h", "btts", "totals", "team_totals", "correct_score"];
const DEFAULT_MARKETS = ["h2h", "btts", "totals"];

const PLATFORM_API_URL =
  process.env.PLATFORM_API_URL || "https://515136800b641762e9aace79427eb7c4.ctonew.app";
const API_BASE = process.env.ODDS_API_BASE || "https://api.the-odds-api.com";
const EVENT_TIMEOUT_MS = Number(process.env.SAME_MATCH_TIMEOUT_MS || 12_000);

function loadCatalogue(): string[] {
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

export default async function handler(req: any, res: any): Promise<void> {
  const send = (obj: unknown, status: number) => {
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
    send(
      {
        error: "not_signed_in",
        message: "Sign in to fetch this match's markets. Nothing was fetched and nothing was charged.",
      },
      401,
    );
    return;
  }
  try {
    const me = await fetch(`${PLATFORM_API_URL}/api/me`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
    });
    if (me.status === 401) {
      send(
        {
          error: "session_expired",
          message:
            "Your session has expired — sign in again to fetch markets. Nothing was fetched and nothing was charged.",
        },
        401,
      );
      return;
    }
    if (!me.ok) {
      send(
        {
          error: "account_unavailable",
          message:
            "We could not check your account, so nothing was fetched. Nothing was charged.",
        },
        503,
      );
      return;
    }
    const meBody = (await me.json().catch(() => null)) as
      | { ok?: boolean; user?: { plan?: string | null } }
      | null;
    const plan = meBody?.user?.plan ?? null;
    if (!meBody?.ok) {
      send(
        {
          error: "not_signed_in",
          message: "Sign in to fetch this match's markets. Nothing was fetched and nothing was charged.",
        },
        401,
      );
      return;
    }
    if (plan !== "pro" && plan !== "annual") {
      send(
        {
          error: "pro_required",
          message:
            "The Same-Match Planner is a Pro tool. Upgrade to Pro to use it. Nothing was fetched and nothing was charged.",
        },
        403,
      );
      return;
    }
  } catch (e) {
    // Fail CLOSED: an unreachable account service must not grant access.
    console.error(`[same-match] account service unreachable: ${String(e)}`);
    send(
      {
        error: "account_unavailable",
        message: "We could not check your account, so nothing was fetched. Nothing was charged.",
      },
      503,
    );
    return;
  }

  if (!eventId || !sport) {
    send(
      {
        error: "no_event",
        message: "Pick one fixture first — this fetch covers exactly one match.",
      },
      400,
    );
    return;
  }

  const key = (process.env.ODDS_API_KEY || process.env.Oddsapi || "").trim();
  const catalogue = loadCatalogue();
  if (!key || catalogue.length === 0) {
    // Answer from the platform deployment, which holds both the key and the
    // competition list — but only for this ONE event, never as a search.
    try {
      const proxied = await fetch(
        `${PLATFORM_API_URL}/api/same-match?event=${encodeURIComponent(eventId)}` +
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
    send(
      {
        error: "odds_unavailable",
        message:
          "The live odds feed is not configured on this server, so this match cannot be fetched. Nothing was charged.",
      },
      503,
    );
    return;
  }

  // Fail closed on an unknown competition key: a crafted `sport` must not be
  // able to spend credits against the provider.
  if (!catalogue.includes(sport)) {
    send(
      {
        error: "unknown_competition",
        message: "That competition is not in our list, so nothing was requested. Nothing was charged.",
      },
      400,
    );
    return;
  }

  const target =
    `${API_BASE}/v4/sports/${encodeURIComponent(sport)}/events/${encodeURIComponent(eventId)}/odds` +
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
      send(
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
      send(
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
    send(
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
    send(
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
