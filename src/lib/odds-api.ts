/**
 * The Odds API integration — fetches live odds from the-odds-api.com
 * (via our server-side /api/odds proxy, which holds the API key) and
 * transforms them into our Match format for display.
 */

import { calcDutchFreeBet } from "./odds";

// The Odds API key is held server-side only (src/server/odds-key.ts) and is
// never shipped in the client bundle. The client fetches through our own
// /api/odds proxy, which attaches the key + fixed params (regions/markets).

// Exchange sources for lay odds, in order of preference.
const LAY_SOURCES = ["betfair_ex_uk", "smarkets"];

// Paid tier (20K credits/mo). Cache to keep the burn predictable.
// Cache in memory (per session) + localStorage (across page loads).
const CACHE_TTL_MS = 600_000; // 10 minute in-memory cache (for page refreshes in same session)
const LS_TTL_MS = 600_000; // 10 min in localStorage (matches the server-side refresh)

// Separate caches per sport endpoint
const caches: Record<string, { data: ApiMatch[]; ts: number }> = {};

// When each sport's odds were actually last fetched from the API (network),
// per sport. Distinct from the in-memory TTL `ts` — this drives the
// "Odds updated Xm ago" stamp.
const fetchedAt: Record<string, number> = {};

// ── Types ──────────────────────────────────────────────────────────────────

interface ApiOutcome {
  name: string;
  price: number;
}

interface ApiMarket {
  key: string;
  last_update: string;
  outcomes: ApiOutcome[];
}

interface ApiBookmaker {
  key: string;
  title: string;
  last_update: string;
  markets: ApiMarket[];
}

interface ApiMatch {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: ApiBookmaker[];
}

/** One bookmaker's back odds for a single outcome. */
export interface OutcomeBookmakerOdds {
  /** Bookmaker key (e.g. "williamhill", "bet365") — used for 2up eligibility */
  key: string;
  /** Display title (e.g. "William Hill") */
  title: string;
  /** Decimal back odds */
  odds: number;
}

export interface MatchOutcome {
  /** Display name (team name or "Draw") */
  name: string;
  /** Best bookmaker offering these odds */
  bookmaker: string;
  /** Best decimal odds found */
  odds: number;
  /** What £20 returns (£20 × odds) */
  return20: number;
  /** Exchange lay odds (decimal) — null when no exchange lay price exists */
  layOdds: number | null;
  /** Source of the lay odds ("Betfair" or "Smarkets") — null when no lay data */
  laySource: string | null;
  /** Exchange bookmaker key providing the lay odds ("betfair_ex_uk" | "smarkets") — null when no lay data */
  layBookmakerKey: string | null;
  /** ISO last_update of the back bookmaker's h2h market — null when unknown */
  backLastUpdate: string | null;
  /** ISO last_update of the exchange lay bookmaker's h2h_lay market — null when no lay */
  layLastUpdate: string | null;
  /** Full per-bookmaker back-odds matrix for this outcome (for 2up and similar) */
  bookmakerOdds: OutcomeBookmakerOdds[];
}

export interface Match {
  matchId: string;
  home: string;
  away: string;
  league: string;
  leagueKey: string;
  /** Raw The Odds API sport_key (e.g. "soccer_epl") — for the sport-category filter. */
  sportKey: string;
  /** Kick-off time, HH:MM (local) */
  time: string;
  /** Full ISO commence time for accurate sorting */
  commenceTime: string;
  /** All available outcomes (2 for most sports, 3 for soccer) */
  outcomes: MatchOutcome[];
  /** Whether this match's league has genuine exchange lay coverage (Betfair/Smarkets quoting h2h_lay) */
  hasLayCoverage: boolean;
  /** Warning message if bookmaker availability is limited */
  warning?: string;
}

// ── Fetch ──────────────────────────────────────────────────────────────────

function lsKey(sport: string): string {
  // v2 prefix — data shape changed (lay odds added), so stale v1 caches
  // must not be read as if they had the new shape.
  return `eaw_odds_cache_v2_${sport}`;
}

function loadFromLS(sport: string): { data: ApiMatch[]; ts: number } | null {
  try {
    const key = lsKey(sport);
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.ts > LS_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return { data: parsed.data as ApiMatch[], ts: parsed.ts };
  } catch {
    return null;
  }
}

function saveToLS(sport: string, data: ApiMatch[]): void {
  try {
    localStorage.setItem(lsKey(sport), JSON.stringify({ ts: Date.now(), data }));
  } catch { /* ignore */ }
}

async function fetchOdds(sportKey = "upcoming"): Promise<ApiMatch[]> {
  const now = Date.now();
  const cache = caches[sportKey];

  // 1. Check in-memory cache
  if (cache && now - cache.ts < CACHE_TTL_MS) {
    return cache.data;
  }

  // 2. Check localStorage
  const lsData = loadFromLS(sportKey);
  if (lsData) {
    caches[sportKey] = { data: lsData.data, ts: now };
    fetchedAt[sportKey] = lsData.ts;
    return lsData.data;
  }

  // 3. Fetch from our server proxy (the API key is server-side, never in the client).
  const url = `/api/odds?sport=${encodeURIComponent(sportKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const msg = res.status === 429
      ? "Too many requests — please wait and try again shortly"
      : `Unable to fetch live odds (${res.status}). Please try again.`;
    throw new Error(msg);
  }

  const data: ApiMatch[] = await res.json();
  caches[sportKey] = { data, ts: now };
  fetchedAt[sportKey] = now;
  saveToLS(sportKey, data);
  return data;
}

/**
 * Age in milliseconds of the odds currently cached for a sport — i.e. how long
 * ago they were last fetched from the API. Returns null when we haven't fetched
 * (or loaded a cache entry) for that sport yet.
 */
export function getOddsAgeMs(sportKey = "upcoming"): number | null {
  const t = fetchedAt[sportKey];
  return t == null ? null : Date.now() - t;
}

// ── Transform ──────────────────────────────────────────────────────────────

/**
 * For a given fixture, find the optimal assignment of bookmakers to outcomes
 * where each outcome gets a different bookmaker. Uses brute-force over all
 * valid permutations (max 5 bookmakers × 3 outcomes = 60 permutations).
 *
 * Scores each combination by running through calcDutchFreeBet and picks the
 * one with the highest net profit.
 */
function bestUniqueBookmakerOdds(
  outcomes: ApiOutcome[],
  bookmakers: ApiBookmaker[]
): { outcome: string; backOdds: number; bookmaker: string; warning?: string }[] {
  // Collect distinct outcome names
  const outcomeNames = [...new Set(outcomes.map((o) => o.name))];

  // Build a matrix: for each outcome, list all (bookmaker, odds) pairs
  const matrix: { outcome: string; options: { bookmaker: string; odds: number }[] }[] =
    outcomeNames.map((name) => {
      const options: { bookmaker: string; odds: number }[] = [];
      for (const bm of bookmakers) {
        const market = bm.markets.find((m) => m.key === "h2h");
        if (!market) continue;
        const outcome = market.outcomes.find(
          (o) => o.name.toLowerCase() === name.toLowerCase()
        );
        if (!outcome) continue;
        options.push({ bookmaker: bm.title, odds: outcome.price });
      }
      return { outcome: name, options };
    });

  // Filter out outcomes that have no bookmaker coverage
  const validMatrix = matrix.filter((m) => m.options.length > 0);
  if (validMatrix.length === 0) return [];

  // Count unique bookmakers available
  const uniqueBookmakers = new Set<string>();
  for (const m of validMatrix) {
    for (const opt of m.options) {
      uniqueBookmakers.add(opt.bookmaker);
    }
  }

  // If not enough bookmakers for unique assignment, use best-per-outcome with warning
  if (uniqueBookmakers.size < validMatrix.length) {
    return validMatrix.map((m) => {
      const best = m.options.reduce((a, b) => (a.odds > b.odds ? a : b));
      return { outcome: m.outcome, backOdds: best.odds, bookmaker: best.bookmaker, warning: "Bookmaker availability limited" };
    });
  }

  // Generate all valid permutations of bookmaker assignments
  // Each outcome gets one bookmaker, no bookmaker reused
  let bestAssignment: { outcome: string; backOdds: number; bookmaker: string; warning?: string }[] | null = null;
  let bestProfit = -Infinity;

  function generatePermutations(
    idx: number,
    usedBookmakers: Set<string>,
    current: { outcome: string; backOdds: number; bookmaker: string }[]
  ) {
    if (idx === validMatrix.length) {
      const oddsArr = current.map((a) => a.backOdds);
      if (oddsArr.length < 2) return;
      const result = calcDutchFreeBet(oddsArr);
      if (result.netProfit > bestProfit) {
        bestProfit = result.netProfit;
        bestAssignment = current.map((a) => ({ ...a }));
      }
      return;
    }

    const entry = validMatrix[idx];
    for (const opt of entry.options) {
      if (usedBookmakers.has(opt.bookmaker)) continue;
      usedBookmakers.add(opt.bookmaker);
      current.push({ outcome: entry.outcome, backOdds: opt.odds, bookmaker: opt.bookmaker });
      generatePermutations(idx + 1, usedBookmakers, current);
      current.pop();
      usedBookmakers.delete(opt.bookmaker);
    }
  }

  generatePermutations(0, new Set(), []);

  // No valid unique assignment found — fallback to best-per-outcome with warning
  if (!bestAssignment) {
    return validMatrix.map((m) => {
      const best = m.options.reduce((a, b) => (a.odds > b.odds ? a : b));
      return { outcome: m.outcome, backOdds: best.odds, bookmaker: best.bookmaker, warning: "Bookmaker availability limited" };
    });
  }

  return bestAssignment;
}

/**
 * Pick the single most interesting outcome from a match to feature.
 * Currently picks the outcome with the highest back odds (best value).
 */
function pickFeaturedOutcome(
  outcomes: { outcome: string; backOdds: number; bookmaker: string }[],
  homeTeam: string,
  awayTeam: string
): { outcome: string; bookmaker: string; backOdds: number } | null {
  if (outcomes.length === 0) return null;

  // Prefer team outcomes over "Draw" for matched betting (you can't lay a draw easily)
  const teamOutcomes = outcomes.filter(
    (o) =>
      o.outcome.toLowerCase() !== "draw" &&
      o.outcome.toLowerCase() !== "tie"
  );

  const candidates = teamOutcomes.length > 0 ? teamOutcomes : outcomes;
  candidates.sort((a, b) => b.backOdds - a.backOdds); // highest odds first
  return candidates[0];
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function getLeagueKey(sportKey: string): string {
  // Map common sports to filterable league keys
  const map: Record<string, string> = {
    soccer_epl: "Premier League",
    soccer_spain_la_liga: "La Liga",
    soccer_germany_bundesliga: "Bundesliga",
    soccer_italy_serie_a: "Serie A",
    soccer_france_ligue_one: "Ligue 1",
  };
  return map[sportKey] || sportKey.replace(/_/g, " ");
}

/**
 * Find real exchange lay odds for an outcome. Prefers Betfair, falls back to
 * Smarkets. Returns null (never a fabricated number) when no lay price exists.
 */
function findLayOdds(
  outcomeName: string,
  bookmakers: ApiBookmaker[]
): {
  layOdds: number;
  laySource: string;
  layBookmakerKey: string;
  layLastUpdate: string | null;
} | null {
  for (const key of LAY_SOURCES) {
    const bm = bookmakers.find((b) => b.key === key);
    if (!bm) continue;
    const market = bm.markets.find((m) => m.key === "h2h_lay");
    if (!market) continue;
    const outcome = market.outcomes.find(
      (o) => o.name.toLowerCase() === outcomeName.toLowerCase()
    );
    if (outcome && outcome.price > 0) {
      return {
        layOdds: outcome.price,
        laySource: bm.title,
        layBookmakerKey: bm.key,
        layLastUpdate: market.last_update || bm.last_update || null,
      };
    }
  }
  return null;
}

/**
 * The back bookmaker's h2h market last_update (falls back to the bookmaker-level
 * timestamp). Used by the alert worker's free-bet freshness guard to detect
 * stale/mismatched back-vs-lay data. Returns null when the bookmaker is unknown.
 */
function getBackLastUpdate(
  bookmakerTitle: string,
  bookmakers: ApiBookmaker[]
): string | null {
  const bm = bookmakers.find((b) => b.title === bookmakerTitle);
  if (!bm) return null;
  const market = bm.markets.find((m) => m.key === "h2h");
  return market?.last_update || bm.last_update || null;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Transform raw API matches into our Match format.
 */
export function transformMatches(data: ApiMatch[], sportKey?: string): Match[] {
  const results: Match[] = [];

  // First pass: which leagues (sport_keys) have genuine exchange lay coverage —
  // Betfair or Smarkets quoting an h2h_lay market with a usable price for at
  // least one match. The alert worker uses this to skip sparse-coverage leagues
  // outright for the free-bet rule (a lone stale quote is not real coverage).
  const layCoveredLeagues = new Set<string>();
  for (const apiMatch of data) {
    if (
      apiMatch.bookmakers?.some((bm) =>
        LAY_SOURCES.includes(bm.key) &&
        bm.markets.some((m) => m.key === "h2h_lay" && m.outcomes.some((o) => o.price > 0))
      )
    ) {
      layCoveredLeagues.add(apiMatch.sport_key);
    }
  }

  for (const apiMatch of data) {
    if (!apiMatch.bookmakers || apiMatch.bookmakers.length === 0) continue;

    const allOutcomes: ApiOutcome[] = [];
    for (const bm of apiMatch.bookmakers) {
      const market = bm.markets.find((m) => m.key === "h2h");
      if (market) {
        for (const outcome of market.outcomes) {
          if (!allOutcomes.some((o) => o.name === outcome.name)) {
            allOutcomes.push(outcome);
          }
        }
      }
    }

    if (allOutcomes.length === 0) continue;

    // Build the full per-outcome bookmaker back-odds matrix (kept for the
    // 2up feature and other offer-eligibility lookups downstream).
    const matrix = new Map<string, OutcomeBookmakerOdds[]>();
    for (const bm of apiMatch.bookmakers) {
      const market = bm.markets.find((m) => m.key === "h2h");
      if (!market) continue;
      for (const outcome of market.outcomes) {
        const key = outcome.name.toLowerCase();
        if (!matrix.has(key)) matrix.set(key, []);
        matrix.get(key)!.push({ key: bm.key, title: bm.title, odds: outcome.price });
      }
    }

    const perOutcome = bestUniqueBookmakerOdds(allOutcomes, apiMatch.bookmakers);
    if (perOutcome.length === 0) continue;

    // Check if any outcome has a warning (duplicate bookmaker fallback)
    const hasWarning = perOutcome.some((o) => o.warning);

    const sorted = perOutcome.sort((a, b) => {
      const aIsHome = a.outcome.toLowerCase() === apiMatch.home_team.toLowerCase();
      const bIsHome = b.outcome.toLowerCase() === apiMatch.home_team.toLowerCase();
      const aIsDraw = a.outcome.toLowerCase() === "draw";
      const bIsDraw = b.outcome.toLowerCase() === "draw";
      if (aIsHome) return -1;
      if (bIsHome) return 1;
      if (aIsDraw) return -1;
      if (bIsDraw) return 1;
      return 0;
    });

    results.push({
      matchId: apiMatch.id,
      home: apiMatch.home_team,
      away: apiMatch.away_team,
      league: apiMatch.sport_title,
      leagueKey: getLeagueKey(apiMatch.sport_key),
      sportKey: apiMatch.sport_key,
      time: formatTime(apiMatch.commence_time),
      commenceTime: apiMatch.commence_time,
      hasLayCoverage: layCoveredLeagues.has(apiMatch.sport_key),
      outcomes: sorted.map((o) => {
        const lay = findLayOdds(o.outcome, apiMatch.bookmakers);
        return {
          name: o.outcome,
          bookmaker: o.bookmaker,
          odds: o.backOdds,
          return20: Math.round(20 * o.backOdds * 100) / 100,
          layOdds: lay ? lay.layOdds : null,
          laySource: lay ? lay.laySource : null,
          layBookmakerKey: lay ? lay.layBookmakerKey : null,
          backLastUpdate: getBackLastUpdate(o.bookmaker, apiMatch.bookmakers),
          layLastUpdate: lay ? lay.layLastUpdate : null,
          bookmakerOdds: matrix.get(o.outcome.toLowerCase()) || [],
        };
      }),
      ...(hasWarning ? { warning: "Bookmaker availability limited — some outcomes may share the same bookmaker" } : {}),
    });
  }

  return results;
}

/**
 * Get all matches with live odds from the API (upcoming sports).
 */
export async function getMatches(): Promise<Match[]> {
  const data = await fetchOdds("upcoming");
  return transformMatches(data);
}

/**
 * Get matches for a specific sport from its dedicated endpoint.
 * Use this for sport-specific pages. Cache is per-sport to avoid quota waste.
 * Supported sport keys: soccer_epl, soccer_fifa_world_cup, soccer_spain_la_liga,
 * soccer_germany_bundesliga, soccer_italy_serie_a, soccer_france_ligue_one,
 * baseball_mlb, basketball_nba, cricket_international_t20, etc.
 */
export async function getSportMatches(sportKey: string): Promise<Match[]> {
  const data = await fetchOdds(sportKey);
  return transformMatches(data, sportKey);
}

/**
 * Clear all caches (memory + localStorage) so the next fetch hits the API.
 * Call this when the user taps "Refresh" to get fresh odds.
 */
export function clearCache(sportKey?: string): void {
  if (sportKey) {
    delete caches[sportKey];
    try { localStorage.removeItem(lsKey(sportKey)); } catch { /* ignore */ }
  } else {
    // Clear all caches
    Object.keys(caches).forEach((k) => delete caches[k]);
    // Clear localStorage entries (both v1 and v2 prefixes)
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("eaw_odds_cache_")) {
        try { localStorage.removeItem(key); } catch { /* ignore */ }
      }
    }
  }
}