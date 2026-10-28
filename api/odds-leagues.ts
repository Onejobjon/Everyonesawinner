// Vercel serverless function: /api/odds-leagues — the Lay Bet Finder's
// on-demand, league-scoped search.
//
// ⚠️ WHY THIS FILE IS SELF-CONTAINED. On the custom domain (Vercel) the only
// server code that exists is an `api/*.ts` function, and a relative import from
// `src/` once took the whole function down at load. So this file carries its own
// copy of the search logic instead of importing `src/server/league-search.ts`
// (which is what the platform deployment uses). Both must stay in step:
// `scripts/test-league-search.ts` runs them against the same stubbed feed and
// fails when their output differs.
//
// CREDIT REALITY: the provider bills 1 credit per request whatever it returns
// (measured: `x-requests-last: 1`, `events=16`). A search over N competitions
// costs N credits. `spent` is read from the provider's own header, not assumed.
//
// AUTH (2026-10-28): Pro session required, checked BEFORE any provider work —
// see the gate at the top of the handler. Anonymous → 401, signed in but not
// Pro → 403, cannot verify → 503. A rejected caller spends 0 credits.
//
// NEVER cached here. A search is a fresh read; the 10-minute cache in
// api/odds.ts belongs to the scheduled alert path and must not be shared.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_LEAGUES_PER_SEARCH = 8;
/**
 * The platform deployment, which holds the account/session store. Used for the
 * Pro gate (forward the bearer token to `/api/me`) and for the last-resort
 * search fallback below.
 */
const PLATFORM_API_URL =
  process.env.PLATFORM_API_URL || "https://515136800b641762e9aace79427eb7c4.ctonew.app";
// `LEAGUE_TIMEOUT_MS` lets a test prove the timeout path without waiting 12s.
// Production never sets it.
const LEAGUE_TIMEOUT_MS = Number(process.env.LEAGUE_TIMEOUT_MS || 12_000);
// Provider host. Overridable ONLY so tests can point the real code path at a
// local stub (how the one-league-fails case is demonstrated without spending
// credits on a forced error). Production never sets it.
const API_BASE = process.env.ODDS_API_BASE || "https://api.the-odds-api.com";

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

export default async function handler(req: any, res: any): Promise<void> {
  const send = (obj: unknown, status: number) => {
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
  // 2026-10-28: this endpoint used to answer anyone who asked.
  const authHeader = typeof req.headers?.authorization === "string" ? req.headers.authorization : "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  const token = bearer || (typeof req.query?.token === "string" ? req.query.token : "");
  if (!token) {
    send(
      {
        error: "not_signed_in",
        message: "Sign in to run this search. Nothing was fetched and nothing was charged.",
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
            "Your session has expired — sign in again to run this search. Nothing was fetched and nothing was charged.",
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
            "We could not check your account, so the search did not run. Nothing was fetched and nothing was charged.",
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
          message: "Sign in to run this search. Nothing was fetched and nothing was charged.",
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
            "The Lay Bet Finder search is a Pro tool. Upgrade to Pro to run it. Nothing was fetched and nothing was charged.",
        },
        403,
      );
      return;
    }
  } catch (e) {
    // Fail CLOSED: an unreachable account service must not grant access.
    console.error(`[league-search] account service unreachable: ${String(e)}`);
    send(
      {
        error: "account_unavailable",
        message:
          "We could not check your account, so the search did not run. Nothing was fetched and nothing was charged.",
      },
      503,
    );
    return;
  }

  if (keys.length === 0) {
    send(
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
    const upstreamHost = PLATFORM_API_URL;
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
    send(
      {
        error: "odds_unavailable",
        message:
          "The live odds feed is not configured on this server, so a search cannot run. Nothing was charged.",
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
        `${API_BASE}/v4/sports/${encodeURIComponent(sport.key)}/odds/` +
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

  const seen = new Set<string>();
  const events: unknown[] = [];
  for (const s of settled) {
    for (const ev of s.events) {
      const id = (ev as { id?: string })?.id;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      events.push(ev);
    }
  }

  const costs = settled.map((s) => s.creditsLast);
  const measured = settled.length > 0 && costs.every((c) => c != null);
  const spent = measured ? (costs as number[]).reduce((a, b) => a + b, 0) : settled.length;
  const remainingHit = [...settled].reverse().find((s) => s.creditsRemaining != null);
  const succeeded = leagues.filter((l) => l.ok).length;

  send(
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
