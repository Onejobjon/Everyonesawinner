import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  calcLay,
  calcFreeBetProfit,
  layGap,
  qualifiesForLay,
  round2,
  COMMISSION,
  type LayCalc,
  type FreeBetType,
} from "../lib/odds";
import { sequentialLayPlan, type AccaPlan } from "../lib/acca";
import {
  getMatches,
  getOddsAgeMs,
  type Match,
  type MatchOutcome,
} from "../lib/odds-api";
import Paywall from "../components/Paywall";
import Markdown from "../components/Markdown";
import layGuide from "../content/lay-betting-guide.md?raw";
import accaGuide from "../content/acca-betting-guide.md?raw";

const BACK_STAKE = 20; // cash qualifying back stake (singles' lay stake/liability)
const DEFAULT_FREE_STAKE = "10"; // free-bet stake default (singles + accas)
const TOP_N = 10;
const MAX_MATCHES = 24; // soonest matches considered — bounds the acca search

const LS_FILTERS_KEY = "eaw_laybets_filters_v1";
const LS_FREE_KEY = "eaw_laybets_free_v1";

// Acca leg-quality guard: realistic back odds + a real, close exchange lay price.
const MIN_LEG_ODDS = 1.1;
const MAX_BACK_ODDS = 6.0;
const MIN_LAY_GAP = -0.05;
const MAX_LAY_GAP = 0.2;

// Display labels for sport categories (the prefix of the raw sport_key).
// Anything not listed falls back to a capitalised slug — never invented.
const SPORT_LABELS: Record<string, string> = {
  soccer: "Football",
  baseball: "Baseball",
  basketball: "Basketball",
  cricket: "Cricket",
  icehockey: "Ice Hockey",
  tennis: "Tennis",
  rugby: "Rugby",
  americanfootball: "American Football",
  aussierules: "Aussie Rules",
  golf: "Golf",
};

interface LayOpportunity {
  match: Match;
  outcome: MatchOutcome;
  lay: LayCalc;
  gap: number;
}

interface LegPick {
  match: Match;
  outcome: MatchOutcome;
}

interface AccaCandidate {
  legs: LegPick[];
  plan: AccaPlan;
}

interface MatchWithLegs {
  match: Match;
  outcomes: MatchOutcome[];
}

interface Filters {
  legs: number;
  category: string;
  bookmaker: string;
  minOdds: number;
}

// Draft state keeps min-odds as RAW TEXT (empty allowed) so the owner can clear
// the field and type a fresh number; it is parsed/clamped only on Run or blur.
interface DraftFilters {
  legs: number;
  category: string;
  bookmaker: string;
  minOdds: string;
}

const DEFAULT_FILTERS: DraftFilters = { legs: 1, category: "all", bookmaker: "all", minOdds: "1.5" };

/** Parse the min-odds text, clamping to ≥ 1.0 (empty/invalid → 1). */
function parseMinOdds(raw: string): number {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Parse the free-bet stake text (empty/invalid → default £10). */
function parseStake(raw: string): number {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

/** Convert a draft (raw min-odds text) into applied filters. */
function toFilters(d: DraftFilters): Filters {
  return {
    legs: d.legs,
    category: d.category,
    bookmaker: d.bookmaker,
    minOdds: parseMinOdds(d.minOdds),
  };
}

/** Last-used controls, so the page can auto-run on open (zero-click). */
function loadFilters(): DraftFilters {
  try {
    const raw = localStorage.getItem(LS_FILTERS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<DraftFilters>;
      if (p && typeof p.legs === "number") {
        return {
          legs: p.legs,
          category: typeof p.category === "string" ? p.category : "all",
          bookmaker: typeof p.bookmaker === "string" ? p.bookmaker : "all",
          minOdds: typeof p.minOdds === "string" ? p.minOdds : DEFAULT_FILTERS.minOdds,
        };
      }
    }
  } catch {
    /* corrupted/stale — fall back to defaults */
  }
  return DEFAULT_FILTERS;
}

function persistFilters(d: DraftFilters): void {
  try {
    localStorage.setItem(LS_FILTERS_KEY, JSON.stringify(d));
  } catch {
    /* localStorage can throw in private mode — non-fatal */
  }
}

/** Last-used free-bet stake + type. */
function loadFree(): { stake: string; type: FreeBetType } {
  try {
    const raw = localStorage.getItem(LS_FREE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { stake?: string; type?: FreeBetType };
      return {
        stake: typeof p.stake === "string" && p.stake.length > 0 ? p.stake : DEFAULT_FREE_STAKE,
        type: p.type === "sr" ? "sr" : "snr",
      };
    }
  } catch {
    /* fall through */
  }
  return { stake: DEFAULT_FREE_STAKE, type: "snr" };
}

function persistFree(v: { stake: string; type: FreeBetType }): void {
  try {
    localStorage.setItem(LS_FREE_KEY, JSON.stringify(v));
  } catch {
    /* non-fatal */
  }
}

function sportCategory(sportKey: string): string {
  return sportKey.split("_")[0];
}

function sportLabel(cat: string): string {
  return SPORT_LABELS[cat] || cat.charAt(0).toUpperCase() + cat.slice(1);
}

function getIcon(name: string, home: string, away: string): string {
  const lower = name.toLowerCase();
  if (lower === home.toLowerCase()) return "⬆️";
  if (lower === away.toLowerCase()) return "⬇️";
  return "➡️";
}

function money(n: number): string {
  return `£${n.toFixed(2)}`;
}

function formatAge(ms: number): string {
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

/** Outcomes usable as an acca leg (real, close lay price within the guard). */
function usableLegs(m: Match): MatchOutcome[] {
  return m.outcomes.filter((o) => {
    if (o.layOdds == null || o.layOdds <= COMMISSION) return false;
    if (o.odds < MIN_LEG_ODDS || o.odds > MAX_BACK_ODDS) return false;
    const gap = o.layOdds - o.odds;
    return gap >= MIN_LAY_GAP && gap <= MAX_LAY_GAP;
  });
}

/** Build cross-match multi-leg bets (each leg from a different match, laid in order). */
function buildAccas(
  matchesWithLegs: MatchWithLegs[],
  legCount: number,
  freeStake: number
): AccaCandidate[] {
  const out: AccaCandidate[] = [];
  const current: LegPick[] = [];

  function recurse(startIdx: number) {
    if (current.length === legCount) {
      const plan = sequentialLayPlan(
        current.map((l) => ({ backOdds: l.outcome.odds, layOdds: l.outcome.layOdds! })),
        freeStake
      );
      if (plan) {
        out.push({ legs: [...current], plan });
      }
      return;
    }
    const remaining = legCount - current.length;
    for (let i = startIdx; i <= matchesWithLegs.length - remaining; i++) {
      const mwl = matchesWithLegs[i];
      for (const oc of mwl.outcomes) {
        current.push({ match: mwl.match, outcome: oc });
        recurse(i + 1);
        current.pop();
      }
    }
  }

  recurse(0);
  return out;
}

export default function LayBets() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Instant-on-open: load last-used controls and apply them immediately so
  // results are visible with zero clicks (once the cached odds arrive).
  const [draft, setDraft] = useState<DraftFilters>(loadFilters);
  const [filters, setFilters] = useState<Filters>(() => toFilters(loadFilters()));

  // Free-bet mode: stake (£) + type. Singles use both; accas switch their stake
  // to this value (always SNR — the sequential-lay engine is SNR-only).
  const [free, setFree] = useState<{ stake: string; type: FreeBetType }>(loadFree);
  const stakeVal = parseStake(free.stake);

  // Apply a draft as the active filters (parsing the min-odds text) and persist
  // it — used by control changes so the power flow auto-re-runs (no API cost).
  const apply = (next: DraftFilters) => {
    setDraft(next);
    setFilters(toFilters(next));
  };

  // Run button: normalise the min-odds text, then apply.
  const run = () => {
    apply({ ...draft, minOdds: String(parseMinOdds(draft.minOdds)) });
  };

  // Persist last-used controls + free-bet settings across visits.
  useEffect(() => {
    persistFilters(draft);
  }, [draft]);
  useEffect(() => {
    persistFree(free);
  }, [free]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getMatches()
      .then((data) => {
        if (!cancelled) {
          setMatches(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Age of the cached odds, for the "Odds updated Xm ago" stamp.
  const oddsAgeMs = useMemo(() => getOddsAgeMs("upcoming"), [matches]);

  // Categories + bookmakers actually present in the loaded data (never invented).
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const m of matches) set.add(sportCategory(m.sportKey));
    return [...set].sort();
  }, [matches]);

  const bookmakers = useMemo(() => {
    const set = new Set<string>();
    for (const m of matches) for (const o of m.outcomes) set.add(o.bookmaker);
    return [...set].sort();
  }, [matches]);

  const results = useMemo(() => {
    const empty = {
      singles: [] as LayOpportunity[],
      accas: [] as AccaCandidate[],
      considered: 0,
      total: 0,
      feedMatches: matches.length,
      qualifiedOutcomes: 0,
      qualifiedFixtures: 0,
    };
    if (!filters || matches.length === 0) return empty;

    const byCategory = (m: Match) =>
      filters.category === "all" || sportCategory(m.sportKey) === filters.category;
    const byBookmaker = (o: MatchOutcome) =>
      filters.bookmaker === "all" || o.bookmaker === filters.bookmaker;

    const sorted = [...matches].sort(
      (a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime()
    );

    // ── Singles (legs = 1): today's/upcoming close-lay opportunities ──
    if (filters.legs === 1) {
      const rows: LayOpportunity[] = [];
      for (const m of sorted) {
        if (!byCategory(m)) continue;
        for (const o of m.outcomes) {
          if (!byBookmaker(o)) continue;
          if (o.odds < filters.minOdds) continue;
          if (!qualifiesForLay(o.odds, o.layOdds)) continue;
          const lay = calcLay(o.odds, o.layOdds, BACK_STAKE);
          if (!lay) continue;
          rows.push({ match: m, outcome: o, lay, gap: layGap(o.odds, o.layOdds!) });
        }
      }
      rows.sort((a, b) => {
        const d = round2(b.lay.profitLoss) - round2(a.lay.profitLoss);
        if (d !== 0) return d;
        return a.gap - b.gap;
      });
      return {
        singles: rows,
        accas: [],
        considered: rows.length,
        total: rows.length,
        feedMatches: matches.length,
        qualifiedOutcomes: rows.length,
        qualifiedFixtures: rows.length,
      };
    }

    // ── Multi-leg bets (legs = 2–4): cross-match, laid leg-by-leg ──
    const matchesWithLegs: MatchWithLegs[] = [];
    let legOutcomes = 0;
    for (const m of sorted) {
      if (!byCategory(m)) continue;
      const outcomes = usableLegs(m)
        .filter(byBookmaker)
        .filter((o) => o.odds >= filters.minOdds);
      if (outcomes.length > 0) {
        matchesWithLegs.push({ match: m, outcomes });
        legOutcomes += outcomes.length;
      }
      if (matchesWithLegs.length >= MAX_MATCHES) break;
    }
    const all = buildAccas(matchesWithLegs, filters.legs, stakeVal);
    all.sort((a, b) => b.plan.retainedProfit - a.plan.retainedProfit);
    return {
      singles: [],
      accas: all.slice(0, TOP_N),
      considered: matchesWithLegs.length,
      total: all.length,
      feedMatches: matches.length,
      qualifiedOutcomes: legOutcomes,
      qualifiedFixtures: matchesWithLegs.length,
    };
  }, [matches, filters, stakeVal]);

  const bestProfit =
    filters?.legs === 1 && results.singles.length > 0
      ? round2(results.singles[0].lay.profitLoss)
      : 0;

  const controlClass =
    "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200";

  return (
    <Paywall tier="pro" title="the Lay Bet Finder">
      <div className="min-h-dvh page-bg font-['Inter',system-ui,sans-serif]">
        <nav className="border-b border-gray-200 bg-white/90 dark:border-gray-800 dark:bg-gray-950/90">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
            <Link to="/" className="flex items-center gap-2">
              <span className="rounded-lg bg-purple-600 p-2 text-white font-bold text-lg">EAW</span>
              <span className="text-xl font-bold tracking-tight">Everyone's A Winner</span>
            </Link>
            <div className="flex items-center gap-4">
              <Link to="/oddsmatcher" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400">Best Odds</Link>
              <Link to="/dashboard" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">Dashboard →</Link>
            </div>
          </div>
        </nav>

        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <h1 className="text-3xl font-bold tracking-tight">Lay Bet Finder</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            Back an outcome at the bookmaker, lay it on the exchange — and lock in the result. Find close, profitable single lays or build a 2–4-leg bet with a done-for-you lay plan.
          </p>

          {/* Free-bet mode (power user): stake + type, persisted across visits */}
          <div className="mt-5 flex flex-wrap items-end gap-4 rounded-xl border border-purple-200 bg-purple-50 p-4 dark:border-purple-900 dark:bg-purple-950/30">
            <div className="text-sm font-semibold text-purple-700 dark:text-purple-300">🎁 Free bet</div>
            <label className="block">
              <span className="text-xs font-medium text-gray-500">Stake</span>
              <div className="mt-1 flex items-center gap-1.5">
                <span className="text-sm font-semibold text-gray-600 dark:text-gray-300">£</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={free.stake}
                  onChange={(e) => setFree({ ...free, stake: e.target.value })}
                  onBlur={() => setFree({ ...free, stake: String(parseStake(free.stake)) })}
                  className="w-20 rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-700 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
                />
              </div>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-500">Type</span>
              <select
                value={free.type}
                onChange={(e) => setFree({ ...free, type: e.target.value as FreeBetType })}
                className="mt-1 rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-700 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
              >
                <option value="snr">SNR — stake not returned</option>
                <option value="sr">Stake returned</option>
              </select>
            </label>
            <p className="min-w-0 flex-1 text-xs text-purple-600/80 dark:text-purple-400/80">
              Singles show what this free bet retains; multi-leg bets use this stake (SNR). Last-used stake is remembered.
            </p>
          </div>

          {/* Controls */}
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <label className="block">
              <span className="text-xs font-medium text-gray-500">Legs</span>
              <select
                value={draft.legs}
                onChange={(e) => apply({ ...draft, legs: Number(e.target.value) })}
                className={controlClass}
              >
                <option value={1}>1 leg — singles</option>
                <option value={2}>2 legs</option>
                <option value={3}>3 legs</option>
                <option value={4}>4 legs</option>
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-500">Sport</span>
              <select
                value={draft.category}
                onChange={(e) => apply({ ...draft, category: e.target.value })}
                className={controlClass}
              >
                <option value="all">All sports</option>
                {categories.map((c) => (
                  <option key={c} value={c}>{sportLabel(c)}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-500">Bookmaker</span>
              <select
                value={draft.bookmaker}
                onChange={(e) => apply({ ...draft, bookmaker: e.target.value })}
                className={controlClass}
              >
                <option value="all">All bookmakers</option>
                {bookmakers.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-500">
                {draft.legs === 1 ? "Minimum back odds" : "Minimum leg odds"}
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={draft.minOdds}
                onChange={(e) => setDraft({ ...draft, minOdds: e.target.value })}
                onBlur={() => apply({ ...draft, minOdds: String(parseMinOdds(draft.minOdds)) })}
                className={controlClass}
              />
            </label>

            <div className="flex items-end">
              <button
                onClick={run}
                disabled={loading}
                className="w-full rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-purple-700 disabled:opacity-50"
              >
                Run
              </button>
            </div>
          </div>

          {/* Honesty rails + freshness */}
          <p className="mt-3 text-xs text-gray-400">
            {draft.legs === 1
              ? `Singles show only rows with back odds under 2.8 and a lay gap under 0.1, on a £20 cash back stake, including 5% exchange commission. The free-bet line uses your entered stake (£${stakeVal}) and type.`
              : `Multi-leg bets always combine legs from different matches — same-game bet builders can't be laid on the exchange, so they're excluded. Legs are limited to back odds of 1.10–6.00 and a close exchange lay price (within 0.20). Figures use a £${stakeVal} stake-not-returned free bet and 5% exchange commission.`}
            {" "}Run searches the freshest cached odds — it never costs an API call.
          </p>

          <p className="mt-1 text-xs text-gray-400">Pre-match odds — refresh every 10 minutes.</p>

          {oddsAgeMs != null && (
            <p className="mt-1 text-xs font-medium text-gray-500">
              🕒 Odds updated {formatAge(oddsAgeMs)}
            </p>
          )}

          {loading && (
            <div className="mt-12 flex flex-col items-center justify-center gap-4">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-purple-600 border-t-transparent" />
              <p className="text-sm text-gray-500">Loading live lay odds...</p>
            </div>
          )}

          {error && !loading && (
            <div className="mt-8 rounded-xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-900 dark:bg-red-950">
              <p className="text-red-700 dark:text-red-400 font-medium">Couldn't load odds</p>
              <p className="mt-1 text-sm text-red-500">{error}</p>
              <button
                onClick={() => {
                  setLoading(true);
                  setError(null);
                  getMatches().then((d) => setMatches(d)).catch((e) => setError(e instanceof Error ? e.message : "Failed")).finally(() => setLoading(false));
                }}
                className="mt-4 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !error && results.singles.length === 0 && results.accas.length === 0 && (
            <div className="mt-8 rounded-xl border border-gray-200 bg-white p-8 text-left dark:border-gray-800 dark:bg-gray-950">
              <div className="flex items-start gap-3">
                <span className="text-4xl">🔍</span>
                <div>
                  <p className="text-lg font-semibold text-gray-700 dark:text-gray-200">
                    {filters.legs === 1 ? "No close lays match these settings" : "No multi-leg bets match these settings"}
                  </p>
                  <p className="mt-1 text-sm text-gray-500">
                    The cached feed holds <strong>{results.feedMatches}</strong> match{results.feedMatches === 1 ? "" : "es"}.
                    {filters.legs === 1 ? (
                      <> <strong>{results.qualifiedOutcomes}</strong> outcome{results.qualifiedOutcomes === 1 ? "" : "s"} passed the close-lay guard at these settings.</>
                    ) : (
                      <> <strong>{results.qualifiedFixtures}</strong> fixture{results.qualifiedFixtures === 1 ? "" : "s"} have a qualifying leg (of {results.qualifiedOutcomes} total qualifying legs), but {filters.legs} legs need {filters.legs} different matches.</>
                    )}
                  </p>
                  <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-gray-500">
                    {filters.legs > 2 && <li>Try fewer legs (e.g. 2 legs).</li>}
                    {filters.minOdds > 1 && <li>Lower the minimum odds.</li>}
                    {filters.category !== "all" && <li>Set Sport back to “All sports”.</li>}
                    {filters.bookmaker !== "all" && <li>Set Bookmaker back to “All bookmakers”.</li>}
                    <li>Odds refresh about every 10 minutes — check back later.</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Singles results */}
          {!loading && !error && filters?.legs === 1 && results.singles.length > 0 && (
            <>
              <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {results.singles.map((op) => {
                  const profitable = op.lay.profitLoss >= 0;
                  const isBest = profitable && round2(op.lay.profitLoss) === bestProfit;
                  const freeBetProfit = calcFreeBetProfit(op.outcome.odds, op.outcome.layOdds, stakeVal, COMMISSION, free.type);
                  const retentionPct = freeBetProfit != null ? Math.round((freeBetProfit / stakeVal) * 100) : 0;
                  return (
                    <div
                      key={`${op.match.matchId}-${op.outcome.name}`}
                      className={`relative rounded-2xl border-2 bg-white p-5 shadow-sm transition-shadow hover:shadow-md dark:bg-gray-950 ${
                        profitable ? "border-green-300 dark:border-green-800" : "border-gray-200 dark:border-gray-800"
                      }`}
                    >
                      {isBest && (
                        <span className="absolute -top-3 right-4 rounded-full bg-green-600 px-3 py-1 text-xs font-bold text-white shadow-sm">★ Best</span>
                      )}
                      <div>
                        <div className="pr-16 text-lg font-bold leading-tight text-gray-900 dark:text-gray-100">
                          {op.match.home} <span className="font-normal text-gray-400">vs</span> {op.match.away}
                        </div>
                        <div className="mt-1 text-xs text-gray-400">{op.match.league} · {op.match.time}</div>
                      </div>
                      <div className="mt-3 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                        <span className="text-lg">{getIcon(op.outcome.name, op.match.home, op.match.away)}</span>
                        <span className="font-semibold">{op.outcome.name}</span>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-3">
                        <div className="rounded-xl bg-gray-50 p-3 dark:bg-gray-900">
                          <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Back</div>
                          <div className="mt-1 text-2xl font-extrabold text-gray-900 dark:text-white">{op.outcome.odds.toFixed(2)}</div>
                          <div className="mt-0.5 truncate text-xs text-gray-500">@ {op.outcome.bookmaker}</div>
                        </div>
                        <div className="rounded-xl bg-purple-50 p-3 dark:bg-purple-950/40">
                          <div className="text-[11px] font-medium uppercase tracking-wide text-purple-500">Lay</div>
                          <div className="mt-1 text-2xl font-extrabold text-purple-700 dark:text-purple-300">{op.outcome.layOdds!.toFixed(2)}</div>
                          <div className="mt-0.5 truncate text-xs text-purple-500">@ {op.outcome.laySource}</div>
                        </div>
                      </div>
                      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-gray-100 pt-3 dark:border-gray-800">
                        <div>
                          <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Lay stake</div>
                          <div className="mt-0.5 font-semibold text-gray-800 dark:text-gray-100">{money(op.lay.layStake)}</div>
                        </div>
                        <div>
                          <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Liability</div>
                          <div className="mt-0.5 font-semibold text-gray-800 dark:text-gray-100">{money(op.lay.liability)}</div>
                        </div>
                        <div>
                          <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Profit/Loss</div>
                          <div className={`mt-0.5 font-semibold ${profitable ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}>
                            {profitable ? "+" : "-"}{money(Math.abs(op.lay.profitLoss))}
                          </div>
                        </div>
                      </div>
                      {freeBetProfit != null && (
                        <div className={`mt-3 rounded-lg px-3 py-1.5 text-xs ${freeBetProfit > stakeVal ? "bg-green-50 font-semibold text-green-700 dark:bg-green-950/40 dark:text-green-300" : "bg-gray-50 text-gray-500 dark:bg-gray-900 dark:text-gray-400"}`}>
                          Free bet £{stakeVal} ({free.type === "sr" ? "stake returned" : "SNR"}) → {money(freeBetProfit)} ({retentionPct}%)
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="mt-4 text-xs text-gray-400">
                Showing {results.singles.length} close-lay opportunities. Lay = betting <strong>against</strong> the outcome on the exchange (Betfair). Figures use a £20 back stake and include 5% exchange commission. The free-bet line shows what your entered free bet (£{stakeVal}, {free.type === "sr" ? "stake returned" : "stake not returned"}) on that outcome would retain — not a claim you hold one.
              </p>
            </>
          )}

          {/* Acca results */}
          {!loading && !error && filters && filters.legs >= 2 && results.accas.length > 0 && (
            <>
              <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {results.accas.map((c, idx) => {
                  const p = c.plan;
                  const retentionPct = Math.round(p.retention * 100);
                  const isBest = idx === 0;
                  return (
                    <div
                      key={c.legs.map((l) => l.match.matchId + l.outcome.name).join("|")}
                      className="relative rounded-2xl border-2 border-green-300 bg-white p-5 shadow-sm transition-shadow hover:shadow-md dark:border-green-800 dark:bg-gray-950"
                    >
                      {isBest && (
                        <span className="absolute -top-3 right-4 rounded-full bg-green-600 px-3 py-1 text-xs font-bold text-white shadow-sm">★ Best</span>
                      )}
                      <div>
                        <div className="pr-14 text-sm font-semibold text-gray-500">{filters.legs}-leg · combined odds</div>
                        <div className="mt-0.5 text-3xl font-extrabold text-gray-900 dark:text-white">{p.combinedBackOdds.toFixed(2)}</div>
                      </div>
                      <div className="mt-3 rounded-xl bg-green-50 p-3 dark:bg-green-950/30">
                        <div className="text-[11px] font-medium uppercase tracking-wide text-green-600 dark:text-green-400">Guaranteed retained profit</div>
                        <div className="mt-0.5 text-2xl font-extrabold text-green-700 dark:text-green-300">+{money(p.retainedProfit)}</div>
                        <div className="text-xs text-green-600/80 dark:text-green-400/80">Same if the bet wins or any leg loses</div>
                      </div>
                      <div className="mt-3">
                        <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Legs — lay in this order</div>
                        <div className="mt-2 space-y-2">
                          {c.legs.map((leg, i) => {
                            const lp = p.legs[i];
                            return (
                              <div key={i} className="rounded-lg border border-gray-100 p-2.5 dark:border-gray-800">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="truncate text-xs text-gray-500">
                                      <span className="font-semibold text-gray-400">{i + 1}.</span> {leg.match.home} v {leg.match.away}
                                    </div>
                                    <div className="mt-0.5 flex items-center gap-1.5 text-sm">
                                      <span>{getIcon(leg.outcome.name, leg.match.home, leg.match.away)}</span>
                                      <span className="font-semibold text-gray-800 dark:text-gray-100">{leg.outcome.name}</span>
                                    </div>
                                  </div>
                                  <div className="shrink-0 text-right text-xs leading-5">
                                    <div className="text-gray-600 dark:text-gray-300">Back <span className="font-semibold">{leg.outcome.odds.toFixed(2)}</span></div>
                                    <div className="text-purple-600 dark:text-purple-400">Lay <span className="font-semibold">{lp.layOdds.toFixed(2)}</span></div>
                                  </div>
                                </div>
                                <div className="mt-1.5 flex justify-between border-t border-gray-50 pt-1.5 text-xs text-gray-500 dark:border-gray-800">
                                  <span>Lay stake {money(lp.layStake)}</span>
                                  <span>Liability {money(lp.liability)}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-gray-100 pt-3 dark:border-gray-800">
                        <div>
                          <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Bet return</div>
                          <div className="mt-0.5 font-semibold text-gray-800 dark:text-gray-100">{money(p.grossReturn)}</div>
                        </div>
                        <div>
                          <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Liability</div>
                          <div className="mt-0.5 font-semibold text-gray-800 dark:text-gray-100">{money(p.totalLiability)}</div>
                        </div>
                        <div>
                          <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Retain</div>
                          <div className="mt-0.5 font-semibold text-green-600 dark:text-green-400">{retentionPct}%</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-4 text-xs text-gray-400">
                Showing the top {results.accas.length} of {results.total} matching multi-leg bets (from {results.considered} fixtures with exchange lay prices). Ranked by guaranteed retained profit. Lay each leg <strong>in order</strong>, only after the previous leg settles.
              </p>
            </>
          )}

          <section className="mt-16 border-t border-gray-200 pt-10 dark:border-gray-800">
            <details open className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
                <h2 className="text-2xl font-bold tracking-tight">How lay betting works</h2>
                <svg className="h-5 w-5 flex-shrink-0 text-gray-400 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              </summary>
              <div className="mt-4"><Markdown source={layGuide} /></div>
            </details>
          </section>

          <section className="mt-10 border-t border-gray-200 pt-10 dark:border-gray-800">
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
                <h2 className="text-2xl font-bold tracking-tight">How accas and lay plans work</h2>
                <svg className="h-5 w-5 flex-shrink-0 text-gray-400 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              </summary>
              <div className="mt-4"><Markdown source={accaGuide} /></div>
            </details>
          </section>
        </div>
      </div>
    </Paywall>
  );
}
