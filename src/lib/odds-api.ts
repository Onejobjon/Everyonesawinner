/**
 * The Odds API integration — fetches live odds from the-odds-api.com
 * and transforms them into our Match format for display.
 *
 * API Key stored here for MVP; will be secured behind a backend proxy later.
 */

const API_KEY = "7c3d32f19360a9489dd8b5d6a6712d4f";
const BASE = "https://api.the-odds-api.com/v4";
const BOOKMAKERS = "bet365,skybet,paddypower,williamhill,betfred";
const REGIONS = "uk";
const MARKETS = "h2h";

// Free tier: 500 requests/month. Cache aggressively to stay well under.
// Cache in memory (per session) + localStorage (across page loads).
// Update frequency: once per 24h per browser. More frequent updates waste quota.
const CACHE_TTL_MS = 600_000; // 10 minute in-memory cache (for page refreshes in same session)
const LS_KEY = "eaw_odds_cache";
const LS_TTL_MS = 86_400_000; // 24 hours in localStorage (across sessions)

let cachedResponse: ApiMatch[] | null = null;
let cacheTimestamp = 0;

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

export interface MatchBest {
  outcome: string;
  bookmaker: string;
  backOdds: number;
  exchange: string;
  layOdds: number;
  profitPct: number | null;
}

export interface Match {
  matchId: string;
  home: string;
  away: string;
  league: string;
  leagueKey: string;
  time: string;
  best: MatchBest;
}

// ── Fetch ──────────────────────────────────────────────────────────────────

/**
 * Fetch upcoming odds from the API. Returns raw API JSON.
 * Uses a simple in-memory cache to avoid hammering the API on re-render.
 */
function loadFromLS(): ApiMatch[] | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.ts > LS_TTL_MS) {
      localStorage.removeItem(LS_KEY);
      return null;
    }
    return parsed.data as ApiMatch[];
  } catch {
    return null;
  }
}

function saveToLS(data: ApiMatch[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch { /* localStorage full or unavailable — ignore */ }
}

async function fetchOdds(): Promise<ApiMatch[]> {
  const now = Date.now();

  // 1. Check in-memory cache first (fastest)
  if (cachedResponse && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedResponse;
  }

  // 2. Check localStorage cache (survives page navigations)
  const lsData = loadFromLS();
  if (lsData) {
    cachedResponse = lsData;
    cacheTimestamp = now;
    return lsData;
  }

  // 3. Fetch from API (expensive — uses quota)
  const url = `${BASE}/sports/upcoming/odds/?apiKey=${API_KEY}&regions=${REGIONS}&markets=${MARKETS}&bookmakers=${BOOKMAKERS}&oddsFormat=decimal`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Odds API error: ${res.status} ${res.statusText}`);
  }

  const data: ApiMatch[] = await res.json();
  cachedResponse = data;
  cacheTimestamp = now;
  saveToLS(data);
  return data;
}

// ── Transform ──────────────────────────────────────────────────────────────

function pickBestBookmaker(
  outcomeName: string,
  bookmakers: ApiBookmaker[]
): { bookmaker: string; odds: number } | null {
  let best: { bookmaker: string; odds: number } | null = null;

  for (const bm of bookmakers) {
    const market = bm.markets.find((m) => m.key === "h2h");
    if (!market) continue;
    const outcome = market.outcomes.find(
      (o) => o.name.toLowerCase() === outcomeName.toLowerCase()
    );
    if (!outcome) continue;
    if (!best || outcome.price > best.odds) {
      best = { bookmaker: bm.title, odds: outcome.price };
    }
  }

  return best;
}

/**
 * Find the best (highest) back odds for each distinct outcome across all
 * bookmakers. Returns an array of { outcomeName, back, bookmakerTitle }.
 */
function bestOddsPerOutcome(
  outcomes: ApiOutcome[],
  bookmakers: ApiBookmaker[]
): { outcome: string; backOdds: number; bookmaker: string }[] {
  // Collect distinct outcome names
  const outcomeNames = [...new Set(outcomes.map((o) => o.name))];
  return outcomeNames
    .map((name) => {
      const best = pickBestBookmaker(name, bookmakers);
      if (!best) return null;
      return { outcome: name, backOdds: best.odds, bookmaker: best.bookmaker };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
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
 * Get all matches with live odds from the API.
 * Returns transformed Match[] ready for the UI.
 */
export async function getMatches(): Promise<Match[]> {
  const data = await fetchOdds();

  const results: Match[] = [];

  for (const apiMatch of data) {
    // Skip matches with no bookmaker data
    if (!apiMatch.bookmakers || apiMatch.bookmakers.length === 0) continue;

    // Collect all outcomes across all bookmakers' h2h markets
    const allOutcomes: ApiOutcome[] = [];
    for (const bm of apiMatch.bookmakers) {
      const market = bm.markets.find((m) => m.key === "h2h");
      if (market) {
        for (const outcome of market.outcomes) {
          // Avoid duplicates
          if (!allOutcomes.some((o) => o.name === outcome.name)) {
            allOutcomes.push(outcome);
          }
        }
      }
    }

    if (allOutcomes.length === 0) continue;

    // For each outcome, find the best bookmaker odds
    const perOutcome = bestOddsPerOutcome(allOutcomes, apiMatch.bookmakers);
    if (perOutcome.length === 0) continue;

    // Pick the featured outcome (highest odds team outcome)
    const featured = pickFeaturedOutcome(
      perOutcome,
      apiMatch.home_team,
      apiMatch.away_team
    );
    if (!featured) continue;

    const layOdds = Math.round(featured.backOdds * EXCHANGE_MULTIPLIER * 100) / 100;

    results.push({
      matchId: apiMatch.id,
      home: apiMatch.home_team,
      away: apiMatch.away_team,
      league: apiMatch.sport_title,
      leagueKey: getLeagueKey(apiMatch.sport_key),
      time: formatTime(apiMatch.commence_time),
      best: {
        outcome: `${featured.outcome} to win`,
        bookmaker: featured.bookmaker,
        backOdds: featured.backOdds,
        exchange: EXCHANGE_NAME,
        layOdds,
        profitPct: calcProfitPct(featured.backOdds, layOdds),
      },
    });
  }

  return results;
}

/**
 * Get only World Cup matches.
 */
export async function getWorldCupMatches(): Promise<Match[]> {
  const all = await getMatches();
  return all.filter(
    (m) =>
      m.leagueKey === "World Cup" ||
      m.league.toLowerCase().includes("world cup")
  );
}

/**
 * Clear all caches (memory + localStorage) so the next fetch hits the API.
 * Call this when the user taps "Refresh" to get fresh odds.
 */
export function clearCache(): void {
  cachedResponse = null;
  cacheTimestamp = 0;
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}