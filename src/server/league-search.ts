/**
 * On-demand, league-scoped odds search — the server half of the Lay Bet Finder's
 * Search button.
 *
 * WHY THIS EXISTS (owner, 2026-10-28): the finder must search only when the user
 * presses Search; the automatic scans belong to the alert worker. And the
 * generic `upcoming` endpoint the site used to ask for returns 8–14 events
 * across every sport (a real check: 8 events, all ATP tennis, zero football),
 * while per-competition queries returned EPL 21 / Championship 12 / Champions
 * League 18. So a search asks the provider once per selected competition.
 *
 * CREDIT REALITY, MEASURED (not estimated): the provider bills **1 credit per
 * request, whatever it returns** — a real scan logged `last=1 events=16`. A
 * search over N competitions therefore costs N credits, and this module reports
 * what each request actually cost (from the provider's own `x-requests-last`
 * header) rather than assuming.
 *
 * DELIBERATE TRAITS
 *  • No cache. A search is a fresh read of the feed; the cache is what the
 *    scheduled alert worker uses, and it must not be shared with this path.
 *  • Per-league isolation. One competition failing (provider 429, timeout,
 *    empty payload) never hides the others — it is reported by name and by
 *    reason, so a short list is never presented as a complete one.
 *  • Fail closed on unknown keys. Every key must exist in the generated
 *    catalogue (src/data/sports-catalogue.json); an unrecognised key is
 *    rejected before any request goes out, so a crafted query cannot burn
 *    credits against the provider.
 *
 * The Vercel deployment keeps its own copy of this logic in `api/odds-leagues.ts`
 * (that bundle cannot resolve imports from `src/` — a relative import once took
 * the whole function down at load). If you change a rule here, change it there;
 * `scripts/test-league-search.ts` runs both against the same stubbed feed and
 * fails if they disagree.
 */
import catalogue from "../data/sports-catalogue.json";

export interface CatalogueSport {
  key: string;
  title: string;
  label: string;
  group: string;
}

export interface LeagueResult {
  key: string;
  /** Readable competition name, from the catalogue. */
  label: string;
  ok: boolean;
  /** Fixtures the provider returned for this competition. */
  events: number;
  /** Wall time for this competition's request, in ms. */
  ms: number;
  /** Present only when ok === false — plain language, no error codes alone. */
  error?: string;
}

export interface LeagueSearchResponse {
  ok: boolean;
  /** True when at least one competition succeeded and at least one failed. */
  partial: boolean;
  requested: string[];
  /** Keys that are not in the catalogue and were refused without a request. */
  rejected: string[];
  leagues: LeagueResult[];
  /** Combined raw provider events (each still carries its own `sport_key`). */
  events: unknown[];
  credits: {
    /** What one competition costs — 1 credit per request (measured). */
    perLeague: number;
    /** Credits this search actually spent (provider-measured where possible). */
    spent: number;
    /** Provider-reported credits remaining, when it told us. */
    remaining: number | null;
    /** True when `spent` came from the provider's header, not a request count. */
    measured: boolean;
  };
  fetchedAt: string;
}

/** Hard cap on one search: 8 competitions = 8 credits, never an open-ended bill. */
export const MAX_LEAGUES_PER_SEARCH = 8;
/**
 * Per-competition request timeout. A hung league must not hang the search.
 * `LEAGUE_TIMEOUT_MS` overrides it so a test can prove the timeout path without
 * waiting the real 12 seconds. Production never sets it.
 */
export const LEAGUE_TIMEOUT_MS = Number(process.env.LEAGUE_TIMEOUT_MS || 12_000);
/**
 * Provider host. Overridable ONLY so tests can point the real code path at a
 * local stub (which is how the one-league-fails case is demonstrated without
 * spending credits on a forced error). Production never sets it.
 */
const API_BASE = process.env.ODDS_API_BASE || "https://api.the-odds-api.com";

const CATALOGUE: CatalogueSport[] = (catalogue as { sports: CatalogueSport[] }).sports;
const BY_KEY = new Map(CATALOGUE.map((s) => [s.key, s]));

export function catalogueSport(key: string): CatalogueSport | undefined {
  return BY_KEY.get(key);
}

/** The competitions the finder starts with, straight from the generated file. */
export function defaultLeagueKeys(): string[] {
  const keys = (catalogue as { defaultKeys?: string[] }).defaultKeys ?? [];
  return keys.filter((k) => BY_KEY.has(k));
}

/**
 * Parse the `leagues` query parameter. Accepts repeated params or a
 * comma-separated list. Deduplicated, order preserved, capped.
 */
export function parseLeagueParam(raw: string | null | undefined): string[] {
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

interface UpstreamOdds {
  ok: boolean;
  status: number;
  events: unknown[];
  error?: string;
  creditsLast: number | null;
  creditsRemaining: number | null;
  ms: number;
}

function readCredits(headers: Headers | undefined, name: string): number | null {
  const raw = headers?.get(name);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function fetchLeague(
  key: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<UpstreamOdds> {
  const started = Date.now();
  const url =
    `${API_BASE}/v4/sports/${encodeURIComponent(key)}/odds/` +
    `?apiKey=${apiKey}&regions=uk&markets=h2h&oddsFormat=decimal`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const creditsLast = readCredits(res.headers, "x-requests-last");
    const creditsRemaining = readCredits(res.headers, "x-requests-remaining");
    const body = await res.text();
    if (!res.ok) {
      let detail = body.slice(0, 180).replace(/\s+/g, " ").trim();
      try {
        const parsed = JSON.parse(body) as { message?: string; error_code?: string };
        if (parsed?.message) detail = parsed.message;
      } catch {
        /* non-JSON error body — keep the truncated text */
      }
      return {
        ok: false,
        status: res.status,
        events: [],
        error: `the odds provider answered ${res.status}${detail ? ` — ${detail}` : ""}`,
        creditsLast,
        creditsRemaining,
        ms: Date.now() - started,
      };
    }
    let events: unknown[] = [];
    try {
      const parsed = JSON.parse(body);
      events = Array.isArray(parsed) ? parsed : [];
    } catch {
      return {
        ok: false,
        status: res.status,
        events: [],
        error: "the odds provider sent a response we could not read",
        creditsLast,
        creditsRemaining,
        ms: Date.now() - started,
      };
    }
    return { ok: true, status: res.status, events, creditsLast, creditsRemaining, ms: Date.now() - started };
  } catch (e) {
    const reason =
      (e as Error)?.name === "AbortError"
        ? `it did not answer within ${Math.round(timeoutMs / 1000)}s`
        : String((e as Error)?.message ?? e);
    return {
      ok: false,
      status: 0,
      events: [],
      error: `the request failed — ${reason}`,
      creditsLast: null,
      creditsRemaining: null,
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch every requested competition once and combine the results.
 *
 * Requests run concurrently so a 3-league search takes about as long as the
 * slowest league, not the sum. Each league's failure is contained: the others
 * still come back, and the response says exactly which failed and why.
 */
export async function runLeagueSearch(
  requestedKeys: string[],
  opts: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<LeagueSearchResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? LEAGUE_TIMEOUT_MS;
  const keys = parseLeagueParam(requestedKeys.join(","));

  const rejected: string[] = [];
  const accepted: CatalogueSport[] = [];
  for (const key of keys) {
    const sport = BY_KEY.get(key);
    if (sport) accepted.push(sport);
    else rejected.push(key);
  }

  const settled = await Promise.all(
    accepted.map(async (sport) => ({ sport, result: await fetchLeague(sport.key, opts.apiKey, fetchImpl, timeoutMs) })),
  );

  const leagues: LeagueResult[] = settled.map(({ sport, result }) => ({
    key: sport.key,
    label: sport.label,
    ok: result.ok,
    events: result.events.length,
    ms: result.ms,
    ...(result.ok ? {} : { error: result.error ?? "the request failed" }),
  }));

  // Combine, de-duplicating by event id: a fixture must never appear twice just
  // because two competitions were asked for.
  const seen = new Set<string>();
  const events: unknown[] = [];
  for (const { result } of settled) {
    for (const ev of result.events) {
      const id = (ev as { id?: string })?.id;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      events.push(ev);
    }
  }

  const costs = settled.map((s) => s.result.creditsLast);
  const measured = settled.length > 0 && costs.every((c) => c != null);
  const spent = measured
    ? (costs as number[]).reduce((a, b) => a + b, 0)
    : settled.length; // conservative: one credit per request attempted
  const remainingRaw = [...settled].reverse().find((s) => s.result.creditsRemaining != null);
  const succeeded = leagues.filter((l) => l.ok).length;

  return {
    ok: succeeded > 0,
    partial: succeeded > 0 && succeeded < leagues.length,
    requested: keys,
    rejected,
    leagues,
    events,
    credits: {
      perLeague: 1,
      spent,
      remaining: remainingRaw ? remainingRaw.result.creditsRemaining : null,
      measured,
    },
    fetchedAt: new Date().toISOString(),
  };
}
