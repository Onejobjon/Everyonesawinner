/**
 * The Odds API integration — fetches live odds from the-odds-api.com
 * (via our server-side /api/odds proxy, which holds the API key) and
 * transforms them into our Match format for display.
 */

import { calcDutchFreeBet } from "./odds";
import {
  checkBackLayPair,
  excludeLaySource,
  isPlausiblePrice,
} from "./odds-sanity";

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
  /**
   * A fixed reference figure (£20 × odds), kept because the row shape is
   * persisted in caches. It is NOT a cap and NOT what the UI shows: every page
   * takes the user's own stake and multiplies by the odds itself.
   */
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
  /**
   * True when the feed DID quote a lay price for this outcome but it failed the
   * back/lay sanity check (sentinel value, or so far below the back price that
   * the two are describing different markets). `layOdds` is withheld (null) so
   * no surface can present it as an opportunity — this flag exists only so the
   * UI can say honestly that a price was withheld.
   */
  laySuspect?: boolean;
  /** Why the lay price was withheld — shown in the UI / written to logs. */
  laySuspectReason?: string;
  /**
   * Feed key of the bookmaker behind `odds` (e.g. "williamhill"). Optional so a
   * hand-built row still type-checks; the transform always sets it, and the
   * "same exchange on both sides" rule compares it with `layBookmakerKey`.
   */
  bookmakerKey?: string | null;
  /**
   * True when the exchange that supplies this row's lay price ALSO quoted the
   * best back price, and was set aside: `bookmaker`/`odds` above are the best
   * genuine bookmaker price. Backing and laying the same exchange cannot profit,
   * so the exchange's own price never becomes the back side (see odds-sanity.ts).
   */
  backSourceExcluded?: boolean;
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
  /**
   * How many outcomes were dropped because no bookmaker quoted a usable back
   * price (sentinel/absurd prices only — see odds-sanity.ts). When > 0 the
   * back market is incomplete, so a dutching/arb profit calculated across the
   * remaining outcomes is meaningless and must not be shown.
   */
  outcomesWithheld?: number;
  /** How many outcome rows had a lay price withheld by the sanity check. */
  laysWithheld?: number;
  /**
   * How many outcomes were dropped because the ONLY back price quoted for them
   * came from the exchange that supplies the lay price. Backing and laying the
   * same exchange is a guaranteed loss, so those rows cannot be shown at all —
   * counted here so the UI can say why rather than silently showing less.
   * Included in `outcomesWithheld`.
   */
  backWithheldAsLaySource?: number;
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
 * One outcome's chosen back price: the bookmaker, its feed key, and the price.
 */
interface BackPick {
  outcome: string;
  backOdds: number;
  bookmaker: string;
  bookmakerKey: string;
  warning?: string;
}

/**
 * For a given fixture, find the optimal assignment of bookmakers to outcomes
 * where each outcome gets a different bookmaker. Uses brute-force over all
 * valid permutations (max 5 bookmakers × 3 outcomes = 60 permutations).
 *
 * Scores each combination by running through calcDutchFreeBet and picks the
 * one with the highest net profit.
 *
 * `excludeBackFor` maps an outcome name (lowercase) to the exchange key that
 * supplies THAT outcome's lay price. That exchange's back price is removed from
 * the candidates — backing and laying the same exchange is a guaranteed loss,
 * not an opportunity (see odds-sanity.ts). Two outcomes are reported back so the
 * caller can be honest about it:
 *   • `backFromLaySourceSetAside` — the exchange did quote the best price and
 *     was set aside for a genuine bookmaker price (the row still has a back price).
 *   • `droppedAsLaySource` — it was the ONLY quoted price, so the row has no
 *     usable back side at all and must be withheld. Never fall back to it.
 */
function bestUniqueBookmakerOdds(
  outcomes: ApiOutcome[],
  bookmakers: ApiBookmaker[],
  excludeBackFor?: Map<string, string>
): {
  picks: BackPick[];
  droppedAsLaySource: string[];
  backFromLaySourceSetAside: string[];
} {
  // Collect distinct outcome names
  const outcomeNames = [...new Set(outcomes.map((o) => o.name))];

  type Candidate = { key: string; bookmaker: string; odds: number };

  // Build a matrix: for each outcome, list all (bookmaker, odds) pairs, minus
  // the exchange that lays that same outcome.
  const matrix: {
    outcome: string;
    options: Candidate[];
    /** The lay source quoted a price here and was set aside — a bookmaker won. */
    setAside: boolean;
    /** The lay source was the ONLY quote here — no usable back price remains. */
    emptied: boolean;
  }[] = outcomeNames.map((name) => {
    const candidates: Candidate[] = [];
    for (const bm of bookmakers) {
      const market = bm.markets.find((m) => m.key === "h2h");
      if (!market) continue;
      const outcome = market.outcomes.find(
        (o) => o.name.toLowerCase() === name.toLowerCase()
      );
      if (!outcome) continue;
      // Sentinel ("no price") / absurd prices must never be treated as the
      // best available back price — a 1.00 or 451 here would poison the
      // dutching maths on this match. See odds-sanity.ts.
      if (!isPlausiblePrice(outcome.price)) continue;
      candidates.push({ key: bm.key, bookmaker: bm.title, odds: outcome.price });
    }
    // The lay-source key comes from the row's own lay price, never a guess.
    const { kept, excluded } = excludeLaySource(
      candidates,
      excludeBackFor?.get(name.toLowerCase())
    );
    return {
      outcome: name,
      options: kept,
      setAside: excluded.length > 0 && kept.length > 0,
      emptied: excluded.length > 0 && kept.length === 0,
    };
  });

  const droppedAsLaySource = matrix.filter((m) => m.emptied).map((m) => m.outcome);
  const backFromLaySourceSetAside = matrix
    .filter((m) => m.setAside)
    .map((m) => m.outcome);

  // Filter out outcomes that have no bookmaker coverage left
  const validMatrix = matrix.filter((m) => m.options.length > 0);
  if (validMatrix.length === 0) {
    return { picks: [], droppedAsLaySource, backFromLaySourceSetAside };
  }

  // Count unique bookmakers available
  const uniqueBookmakers = new Set<string>();
  for (const m of validMatrix) {
    for (const opt of m.options) {
      uniqueBookmakers.add(opt.key);
    }
  }

  const bestPerOutcome = (): BackPick[] =>
    validMatrix.map((m) => {
      const best = m.options.reduce((a, b) => (a.odds > b.odds ? a : b));
      return {
        outcome: m.outcome,
        backOdds: best.odds,
        bookmaker: best.bookmaker,
        bookmakerKey: best.key,
        warning: "Bookmaker availability limited",
      };
    });

  // If not enough bookmakers for unique assignment, use best-per-outcome with warning
  if (uniqueBookmakers.size < validMatrix.length) {
    return {
      picks: bestPerOutcome(),
      droppedAsLaySource,
      backFromLaySourceSetAside,
    };
  }

  // Generate all valid permutations of bookmaker assignments
  // Each outcome gets one bookmaker, no bookmaker reused
  let bestAssignment: BackPick[] | null = null;
  let bestProfit = -Infinity;

  function generatePermutations(
    idx: number,
    usedBookmakers: Set<string>,
    current: BackPick[]
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
      if (usedBookmakers.has(opt.key)) continue;
      usedBookmakers.add(opt.key);
      current.push({
        outcome: entry.outcome,
        backOdds: opt.odds,
        bookmaker: opt.bookmaker,
        bookmakerKey: opt.key,
      });
      generatePermutations(idx + 1, usedBookmakers, current);
      current.pop();
      usedBookmakers.delete(opt.key);
    }
  }

  generatePermutations(0, new Set(), []);

  // No valid unique assignment found — fallback to best-per-outcome with warning
  if (!bestAssignment) {
    return {
      picks: bestPerOutcome(),
      droppedAsLaySource,
      backFromLaySourceSetAside,
    };
  }

  return {
    picks: bestAssignment,
    droppedAsLaySource,
    backFromLaySourceSetAside,
  };
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
    if (outcome && isPlausiblePrice(outcome.price)) {
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
  // Pre-match only (owner's "nothing in-play" directive): drop any match whose
  // commence_time is already in the past. Applied by the site and alert worker
  // alike — a started match must never show or alert.
  const now = Date.now();

  // First pass: which leagues (sport_keys) have genuine exchange lay coverage —
  // Betfair or Smarkets quoting an h2h_lay market with a usable price for at
  // least one match. The alert worker uses this to skip sparse-coverage leagues
  // outright for the free-bet rule (a lone stale quote is not real coverage).
  const layCoveredLeagues = new Set<string>();
  for (const apiMatch of data) {
    if (
      apiMatch.bookmakers?.some((bm) =>
        LAY_SOURCES.includes(bm.key) &&
        bm.markets.some((m) => m.key === "h2h_lay" && m.outcomes.some((o) => isPlausiblePrice(o.price)))
      )
    ) {
      layCoveredLeagues.add(apiMatch.sport_key);
    }
  }

  for (const apiMatch of data) {
    // Drop already-kicked-off matches (see `now` above). NaN (unparseable
    // commence_time) is treated as "unknown" and kept, not silently dropped.
    if (new Date(apiMatch.commence_time).getTime() <= now) continue;
    if (!apiMatch.bookmakers || apiMatch.bookmakers.length === 0) continue;

    // Ice hockey is excluded from lay data entirely: bookmaker back odds are
    // regulation-time while exchange lay odds are overtime-inclusive, so the
    // two never settle on the same result. Nulling layOdds makes BOTH the
    // Lay Bet Finder and the alert worker skip it automatically.
    const isIceHockeyMatch = apiMatch.sport_key.startsWith("icehockey");

    // Count of rows on this match whose lay price was withheld by the sanity check.
    let laysWithheld = 0;

    const allOutcomes: ApiOutcome[] = [];
    const allOutcomeNames = new Set<string>();
    for (const bm of apiMatch.bookmakers) {
      const market = bm.markets.find((m) => m.key === "h2h");
      if (!market) continue;
      for (const outcome of market.outcomes) {
        allOutcomeNames.add(outcome.name.toLowerCase());
        // Sentinel / absurd back prices are not odds — skip them so they can
        // never win "best price" and invent a profit. See odds-sanity.ts.
        if (!isPlausiblePrice(outcome.price)) continue;
        if (!allOutcomes.some((o) => o.name === outcome.name)) {
          allOutcomes.push(outcome);
        }
      }
    }

    if (allOutcomes.length === 0) continue;
    // A market showing fewer than two outcomes can't be dutched or laid as a
    // pair — drop the fixture rather than show half a market.
    if (allOutcomes.length < 2) continue;

    // Lay prices are resolved BEFORE the back side is chosen, because the
    // exchange that supplies a lay must be excluded from that outcome's back
    // candidates (see odds-sanity.ts): backing and laying the same exchange is
    // a guaranteed loss, and it used to win "best back price" on 2 of 7 rows.
    const layByOutcome = new Map<
      string,
      ReturnType<typeof findLayOdds>
    >();
    const excludeBackFor = new Map<string, string>();
    for (const o of allOutcomes) {
      const key = o.name.toLowerCase();
      const lay = isIceHockeyMatch ? null : findLayOdds(o.name, apiMatch.bookmakers);
      layByOutcome.set(key, lay);
      if (lay) excludeBackFor.set(key, lay.layBookmakerKey);
    }

    const {
      picks: perOutcome,
      droppedAsLaySource,
      backFromLaySourceSetAside,
    } = bestUniqueBookmakerOdds(allOutcomes, apiMatch.bookmakers, excludeBackFor);
    if (perOutcome.length === 0) continue;

    // Outcomes whose only back price was the lay exchange are unusable — drop
    // them entirely rather than reuse the exchange price. They are reported as
    // withheld so the UI can explain the gap instead of hiding it.
    const droppedKeys = new Set(droppedAsLaySource.map((n) => n.toLowerCase()));
    const keptOutcomes = allOutcomes.filter((o) => !droppedKeys.has(o.name.toLowerCase()));
    if (keptOutcomes.length < 2) continue;
    const setAsideKeys = new Set(
      backFromLaySourceSetAside.map((n) => n.toLowerCase())
    );

    // Outcomes the feed listed but for which nobody quoted a usable back price,
    // plus the ones withheld above because the exchange was the only quoter.
    const outcomesWithheld = [...allOutcomeNames].filter(
      (n) => !keptOutcomes.some((o) => o.name.toLowerCase() === n)
    ).length;

    // Build the full per-outcome bookmaker back-odds matrix (kept for the
    // 2up feature and other offer-eligibility lookups downstream). Sentinel
    // prices are excluded here too — a 451 must never surface as a back price.
    const matrix = new Map<string, OutcomeBookmakerOdds[]>();
    for (const bm of apiMatch.bookmakers) {
      const market = bm.markets.find((m) => m.key === "h2h");
      if (!market) continue;
      for (const outcome of market.outcomes) {
        if (!isPlausiblePrice(outcome.price)) continue;
        const key = outcome.name.toLowerCase();
        if (!matrix.has(key)) matrix.set(key, []);
        matrix.get(key)!.push({ key: bm.key, title: bm.title, odds: outcome.price });
      }
    }

    // Check if any outcome has a warning (duplicate bookmaker fallback)
    const hasWarning = perOutcome.some((o) => o.warning);

    const perOutcomeSorted = perOutcome.sort((a, b) => {
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
      outcomes: perOutcomeSorted.map((o) => {
        const lay = layByOutcome.get(o.outcome.toLowerCase()) ?? null;
        // Back/lay sanity check (see odds-sanity.ts). A lay price that is a
        // feed sentinel, or that sits far below the bookmaker's back price,
        // describes a different market — withhold it so no surface (Lay Bet
        // Finder, Bet Builder, alerts) can present it as an opportunity, and
        // mark the row so the UI can be honest about the omission.
        //
        // The bookmaker keys are passed too: even if selection ever let the lay
        // exchange through as the back price, the pair is rejected here.
        const pair = checkBackLayPair(
          o.backOdds,
          lay ? lay.layOdds : null,
          o.bookmakerKey,
          lay ? lay.layBookmakerKey : null
        );
        const layWithheld = Boolean(lay) && pair.suspect;
        if (layWithheld) laysWithheld++;
        return {
          name: o.outcome,
          bookmaker: o.bookmaker,
          bookmakerKey: o.bookmakerKey,
          odds: o.backOdds,
          // A fixed reference column only — the UI never prints it, and stakes
          // are whatever the user enters (there is no £20 assumption anywhere).
          return20: Math.round(20 * o.backOdds * 100) / 100,
          layOdds: lay && !pair.suspect ? lay.layOdds : null,
          laySource: lay && !pair.suspect ? lay.laySource : null,
          layBookmakerKey: lay && !pair.suspect ? lay.layBookmakerKey : null,
          backLastUpdate: getBackLastUpdate(o.bookmaker, apiMatch.bookmakers),
          layLastUpdate: lay && !pair.suspect ? lay.layLastUpdate : null,
          bookmakerOdds: matrix.get(o.outcome.toLowerCase()) || [],
          ...(setAsideKeys.has(o.outcome.toLowerCase())
            ? { backSourceExcluded: true }
            : {}),
          ...(layWithheld
            ? { laySuspect: true, laySuspectReason: pair.reason ?? undefined }
            : {}),
        };
      }),
      ...(hasWarning ? { warning: "Bookmaker availability limited — some outcomes may share the same bookmaker" } : {}),
      ...(outcomesWithheld > 0 ? { outcomesWithheld } : {}),
      ...(laysWithheld > 0 ? { laysWithheld } : {}),
      ...(droppedAsLaySource.length > 0
        ? { backWithheldAsLaySource: droppedAsLaySource.length }
        : {}),
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
// ── On-demand, league-scoped search (Lay Bet Finder) ────────────────────────
//
// DELIBERATELY SEPARATE from fetchOdds() above, which reads a 10-minute cache:
// a search is a fresh read of the feed, performed only when the user presses
// Search. Nothing here reads or writes the odds caches, in memory or in
// localStorage — otherwise the button could serve yesterday's prices and call
// them fresh, and a search would silently become "free" while claiming to be
// a live read.

/** One competition covered by a search: what came back, and how it went. */
export interface SearchedLeague {
  key: string;
  /** Readable competition name, from the generated catalogue. */
  label: string;
  ok: boolean;
  /** Fixtures the provider returned for this competition. */
  events: number;
  /** Wall time for this competition's request, in ms. */
  ms: number;
  /** Plain-language reason, present only when ok is false. */
  error?: string;
}

export interface LeagueSearchResult {
  /** Combined, sanity-checked matches from every competition that answered. */
  matches: Match[];
  /** Per-competition outcome, in the order requested. */
  leagues: SearchedLeague[];
  /** Keys the server refused (not in the competition catalogue) — never fetched. */
  rejected: string[];
  credits: {
    perLeague: number;
    spent: number;
    remaining: number | null;
    measured: boolean;
  };
  /** Fixtures the provider returned across every competition (before filtering). */
  fixtures: number;
  elapsedMs: number;
  fetchedAt: string;
}

interface LeagueSearchPayload {
  ok?: boolean;
  partial?: boolean;
  requested?: string[];
  rejected?: string[];
  leagues?: SearchedLeague[];
  events?: unknown[];
  credits?: { perLeague?: number; spent?: number; remaining?: number | null; measured?: boolean };
  fetchedAt?: string;
  error?: string;
  message?: string;
}

/**
 * The session token this browser holds, for endpoints that must identify the
 * caller. A search is a Pro tool and the server checks the token itself (it
 * does not trust the copy in localStorage) — this is only how the token gets
 * there. Returns "" when there is no usable stored session.
 */
function sessionToken(): string {
  try {
    const stored = localStorage.getItem("eaw_session");
    if (!stored) return "";
    const parsed = JSON.parse(stored) as { token?: unknown };
    return typeof parsed?.token === "string" ? parsed.token : "";
  } catch {
    return "";
  }
}

/**
 * Run a real, fresh search over the given competitions.
 *
 * Throws only when the search itself could not run (no competition returned,
 * network failure, server misconfigured). A single competition failing is NOT
 * an error: it comes back in `leagues` with ok:false and a reason, so the page
 * can show the others and say which one is missing.
 */
export async function searchLeagues(leagueKeys: string[]): Promise<LeagueSearchResult> {
  const started = Date.now();
  const keys = leagueKeys.filter((k) => typeof k === "string" && k.length > 0);
  if (keys.length === 0) {
    throw new Error("Pick at least one competition to search.");
  }
  const url = `/api/odds-leagues?leagues=${encodeURIComponent(keys.join(","))}`;
  // The endpoint is Pro-gated server-side (401 anonymous / 403 not Pro), so the
  // session token has to travel with the request. Without this the search would
  // be refused for the very users the page is designed for.
  const token = sessionToken();
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, cache: "no-store" });
  let payload: LeagueSearchPayload | null = null;
  try {
    payload = (await res.json()) as LeagueSearchPayload;
  } catch {
    payload = null;
  }
  if (!res.ok || !payload) {
    throw new Error(
      payload?.message ||
        (res.status === 429
          ? "Too many searches just now — wait a moment and try again."
          : `The search could not run (${res.status}). Please try again.`),
    );
  }
  const leagues = Array.isArray(payload.leagues) ? payload.leagues : [];
  const answered = leagues.filter((l) => l.ok);
  if (answered.length === 0) {
    const reasons = leagues.map((l) => `${l.label}: ${l.error ?? "no result"}`).join("; ");
    throw new Error(
      reasons ? `No competition answered — ${reasons}` : "No competition answered. Please try again.",
    );
  }

  // Group the combined events by competition so each one is transformed with its
  // own sport key: that is what applies the shared odds-sanity rules
  // (sentinel prices dropped, a lay >10% below the back withheld) and the
  // ice-hockey exclusion. No transform is re-implemented here.
  const byKey = new Map<string, ApiMatch[]>();
  for (const ev of payload.events ?? []) {
    const match = ev as ApiMatch;
    if (!match || typeof match.sport_key !== "string") continue;
    const bucket = byKey.get(match.sport_key);
    if (bucket) bucket.push(match);
    else byKey.set(match.sport_key, [match]);
  }
  const matches: Match[] = [];
  for (const [sportKey, events] of byKey) {
    matches.push(...transformMatches(events, sportKey));
  }

  const credits = payload.credits ?? {};
  return {
    matches,
    leagues,
    rejected: Array.isArray(payload.rejected) ? payload.rejected : [],
    credits: {
      perLeague: typeof credits.perLeague === "number" ? credits.perLeague : 1,
      spent: typeof credits.spent === "number" ? credits.spent : keys.length,
      remaining: typeof credits.remaining === "number" ? credits.remaining : null,
      measured: Boolean(credits.measured),
    },
    fixtures: Array.isArray(payload.events) ? payload.events.length : 0,
    elapsedMs: Date.now() - started,
    fetchedAt: payload.fetchedAt ?? new Date().toISOString(),
  };
}
