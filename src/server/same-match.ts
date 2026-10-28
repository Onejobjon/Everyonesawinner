/**
 * One-event, on-demand market fetch for /same-match.
 *
 * WHY THIS EXISTS. The bulk endpoint the site calls for the oddsmatcher
 * (`/v4/sports/{sport}/odds`) refuses `btts` with 422 INVALID_MARKET and carries
 * `h2h` only. The PER-EVENT endpoint serves btts, totals, team_totals and
 * correct_score — but it bills **1 credit per event per market per region**
 * (measured, see /home/team/shared/data-source-findings-2026-10-28.md), so a
 * season-wide sweep is out of the question: 21 EPL events × 4 markets = 84
 * credits for one pass. It must be one match at a time, on an explicit click,
 * with the cost stated before the click.
 *
 * WHAT THIS FILE DOES NOT DO
 *  • No cache. A fetch is an explicit paid read; serving a stale copy would let
 *    the page say "fetched" while showing another hour's prices.
 *  • No scheduled or background use. Nothing calls this except a user's click.
 *  • No shaping of the payload. It answers with the provider's own JSON and the
 *    SHARED parser in src/lib/same-match.ts reads it, so the platform host and
 *    the custom domain cannot drift apart on how a price is attributed.
 *  • No arbitrary market strings. `markets` is checked against an allow-list, so
 *    a crafted query cannot burn credits on a market we do not use.
 *
 * The Vercel deployment cannot import from `src/` (a relative import once took a
 * whole function down at load), so `api/same-match.ts` carries its own copy of
 * this request. If you change the market list or the URL shape here, change it
 * there.
 */
import catalogue from "../data/sports-catalogue.json";

/**
 * The only markets this endpoint will ever request. `correct_score` is the
 * reference-price market (an optional extra credit); the rest are the legs.
 */
export const ALLOWED_MARKETS = ["h2h", "btts", "totals", "team_totals", "correct_score"] as const;
export type AllowedMarket = (typeof ALLOWED_MARKETS)[number];

/** Default set: the legs, with no reference price (which is opt-in). */
export const DEFAULT_MARKETS: AllowedMarket[] = ["h2h", "btts", "totals"];

const API_BASE = process.env.ODDS_API_BASE || "https://api.the-odds-api.com";
const EVENT_TIMEOUT_MS = Number(process.env.SAME_MATCH_TIMEOUT_MS || 12_000);

interface CatalogueSport {
  key: string;
}

const CATALOGUE = (catalogue as { sports: CatalogueSport[] }).sports ?? [];
const KEY_SET = new Set(CATALOGUE.map((s) => s.key));

/** Fail closed: an unknown competition key never reaches the provider. */
export function isCatalogueSport(key: string): boolean {
  return KEY_SET.has(key);
}

/**
 * Parse the `markets` parameter against the allow-list. Unknown or duplicate
 * entries are dropped rather than passed through, and the result is capped so
 * one click cannot cost an unbounded number of credits.
 */
export function parseMarkets(raw: string | null | undefined): AllowedMarket[] {
  if (!raw) return [...DEFAULT_MARKETS];
  const out: AllowedMarket[] = [];
  for (const part of raw.split(",")) {
    const key = part.trim() as AllowedMarket;
    if (!key) continue;
    if (!ALLOWED_MARKETS.includes(key)) continue;
    if (out.includes(key)) continue;
    out.push(key);
    if (out.length >= ALLOWED_MARKETS.length) break;
  }
  return out.length > 0 ? out : [...DEFAULT_MARKETS];
}

export interface EventFetchResult {
  ok: boolean;
  /** The provider's own JSON for this event, passed through untouched. */
  event: unknown;
  markets: AllowedMarket[];
  credits: {
    /** Credits per market per event (the provider's billing unit). */
    perMarket: number;
    spent: number;
    remaining: number | null;
    /** True when `spent` came from the provider's header, not market count. */
    measured: boolean;
  };
  fetchedAt: string;
  /** Present only when ok === false — plain language, no bare error codes. */
  error?: string;
}

function readHeader(headers: Headers | undefined, name: string): number | null {
  const raw = headers?.get(name);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch ONE event's odds for the given markets. Exactly one provider request,
 * whatever the market count — the provider bills per market, not per request.
 */
export async function runEventFetch(opts: {
  sport: string;
  eventId: string;
  markets: AllowedMarket[];
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<EventFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? EVENT_TIMEOUT_MS;
  const markets = opts.markets.length > 0 ? opts.markets : [...DEFAULT_MARKETS];
  const url =
    `${API_BASE}/v4/sports/${encodeURIComponent(opts.sport)}/events/` +
    `${encodeURIComponent(opts.eventId)}/odds?apiKey=${opts.apiKey}` +
    `&regions=uk&markets=${markets.join(",")}&oddsFormat=decimal`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: controller.signal });
    const creditsLast = readHeader(res.headers, "x-requests-last");
    const creditsRemaining = readHeader(res.headers, "x-requests-remaining");
    const body = await res.text();

    if (!res.ok) {
      let detail = body.slice(0, 180).replace(/\s+/g, " ").trim();
      try {
        const parsed = JSON.parse(body) as { message?: string };
        if (parsed?.message) detail = parsed.message;
      } catch {
        /* keep the truncated text */
      }
      return {
        ok: false,
        event: null,
        markets,
        credits: {
          perMarket: 1,
          spent: creditsLast ?? 0,
          remaining: creditsRemaining,
          measured: creditsLast != null,
        },
        fetchedAt: new Date().toISOString(),
        error: `the odds provider answered ${res.status}${detail ? ` — ${detail}` : ""}`,
      };
    }

    let event: unknown = null;
    try {
      event = JSON.parse(body);
    } catch {
      return {
        ok: false,
        event: null,
        markets,
        credits: {
          perMarket: 1,
          spent: creditsLast ?? 0,
          remaining: creditsRemaining,
          measured: creditsLast != null,
        },
        fetchedAt: new Date().toISOString(),
        error: "the odds provider sent a response we could not read",
      };
    }

    return {
      ok: true,
      event,
      markets,
      credits: {
        perMarket: 1,
        // Conservative: one credit per market requested, unless the provider
        // told us what it actually charged.
        spent: creditsLast ?? markets.length,
        remaining: creditsRemaining,
        measured: creditsLast != null,
      },
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    const reason =
      (e as Error)?.name === "AbortError"
        ? `it did not answer within ${Math.round(timeoutMs / 1000)}s`
        : String((e as Error)?.message ?? e);
    return {
      ok: false,
      event: null,
      markets,
      credits: { perMarket: 1, spent: 0, remaining: null, measured: false },
      fetchedAt: new Date().toISOString(),
      error: `the request failed — ${reason}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
