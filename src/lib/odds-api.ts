/**
 * The Odds API integration — fetches live odds from the-odds-api.com
 * and transforms them into our Match format for display.
 *
 * API Key stored here for MVP; will be secured behind a backend proxy later.
 */

import { calcDutchFreeBet } from "./odds";

const API_KEY = "7c3d32f19360a9489dd8b5d6a6712d4f";
const BASE = "https://api.the-odds-api.com/v4";
const REGIONS = "uk";
const MARKETS = "h2h";

// Free tier: 500 requests/month. Cache aggressively to stay well under.
// Cache in memory (per session) + localStorage (across page loads).
const CACHE_TTL_MS = 600_000; // 10 minute in-memory cache (for page refreshes in same session)
const LS_TTL_MS = 7_200_000; // 2 hours in localStorage (across sessions)

// Separate caches per sport endpoint
const caches: Record<string, { data: ApiMatch[]; ts: number }> = {};

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

export interface MatchOutcome {
  /** Display name (team name or "Draw") */
  name: string;
  /** Best bookmaker offering these odds */
  bookmaker: string;
  /** Best decimal odds found */
  odds: number;
  /** What £20 returns (£20 × odds) */
  return20: number;
}

export interface Match {
  matchId: string;
  home: string;
  away: string;
  league: string;
  leagueKey: string;
  time: string;
  /** All available outcomes (2 for most sports, 3 for soccer) */
  outcomes: MatchOutcome[];
  /** Warning message if bookmaker availability is limited */
  warning?: string;
}

// ── Fetch ──────────────────────────────────────────────────────────────────

function lsKey(sport: string): string {
  return `eaw_odds_cache_${sport}`;
}

function loadFromLS(sport: string): ApiMatch[] | null {
  try {
    const key = lsKey(sport);
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.ts > LS_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed.data as ApiMatch[];
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
    caches[sportKey] = { data: lsData, ts: now };
    return lsData;
  }

  // 3. Fetch from API
  const url = sportKey === "upcoming"
    ? `${BASE}/sports/upcoming/odds/?apiKey=${API_KEY}&regions=${REGIONS}&markets=${MARKETS}&oddsFormat=decimal`
    : `${BASE}/sports/${sportKey}/odds/?apiKey=${API_KEY}&regions=${REGIONS}&markets=${MARKETS}&oddsFormat=decimal`;

  const res = await fetch(url);
  if (!res.ok) {
    const msg = res.status === 429
      ? "Too many requests — please wait and try again shortly"
      : `Unable to fetch live odds (${res.status}). Please try again.`;
    throw new Error(msg);
  }

  const data: ApiMatch[] = await res.json();
  caches[sportKey] = { data, ts: now };
  saveToLS(sportKey, data);
  return data;
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
    soccer_fifa_world_cup: "World Cup",
    soccer_italy_serie_a: "Serie A",
    soccer_france_ligue_one: "Ligue 1",
  };
  return map[sportKey] || sportKey.replace(/_/g, " ");
}

/**
 * Calculate profit percentage from back and lay odds.
 * Formula: (backOdds / layOdds - 1) * 100
 * Only returns a non-null value if there's a real profit (>= 0.1%).
 */
function calcProfitPct(backOdds: number, layOdds: number): number | null {
  const pct = (backOdds / layOdds - 1) * 100;
  return pct >= 0.1 ? Math.round(pct * 10) / 10 : null;
}

// ── Public API ─────────────────────────────────────────────────────────────

export const EXCHANGE_MULTIPLIER = 1.02;
export const EXCHANGE_NAME = "Betfair"; // placeholder name for the exchange side

/**
 * Get only World Cup matches from the dedicated sport endpoint.
 */
export async function getWorldCupMatches(): Promise<Match[]> {
  const data = await fetchOdds("soccer_fifa_world_cup");
  return transformMatches(data, "soccer_fifa_world_cup");
}

/**
 * Transform raw API matches into our Match format.
 */
function transformMatches(data: ApiMatch[], sportKey?: string): Match[] {
  const results: Match[] = [];

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
      time: formatTime(apiMatch.commence_time),
      outcomes: sorted.map((o) => ({
        name: o.outcome,
        bookmaker: o.bookmaker,
        odds: o.backOdds,
        return20: Math.round(20 * o.backOdds * 100) / 100,
      })),
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
    // Clear localStorage entries
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("eaw_odds_cache_")) {
        try { localStorage.removeItem(key); } catch { /* ignore */ }
      }
    }
  }
}