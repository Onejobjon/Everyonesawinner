import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  COMMISSION,
  round2,
} from "../lib/odds";
import { sequentialLayPlan, sequentialLayPlanPaid, type AccaPlan } from "../lib/acca";
import {
  getMatches,
  getOddsAgeMs,
  type Match,
  type MatchOutcome,
} from "../lib/odds-api";
import Paywall from "../components/Paywall";
import Markdown from "../components/Markdown";
import accaGuide from "../content/acca-betting-guide.md?raw";
import {
  sportCategory,
  sportLabel,
  isIceHockey,
  getIcon,
  outcomePhrase,
  money,
  formatAge,
} from "../lib/laybets-common";

const DEFAULT_FREE_STAKE = "10"; // free-bet (SNR) stake
const DEFAULT_PAID_STAKE = "20"; // paid (own money) back stake
const TOP_N = 10;
const MAX_MATCHES = 24; // soonest matches considered — bounds the acca search

// Acca leg-quality guard: realistic back odds + a real, close exchange lay price.
const MIN_LEG_ODDS = 1.1;
const MAX_BACK_ODDS = 6.0;
const MIN_LAY_GAP = -0.05;
const MAX_LAY_GAP = 0.2;

const LS_KEY = "eaw_betbuilder_v1";

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

// Draft keeps min-odds as RAW TEXT so the owner can clear and retype it.
interface Draft {
  legs: number;
  category: string;
  bookmaker: string;
  minOdds: string;
}

type BetMode = "free" | "paid";

interface Persisted extends Draft {
  mode: BetMode;
  freeStake: string;
  paidStake: string;
}

const DEFAULT_DRAFT: Draft = { legs: 2, category: "all", bookmaker: "all", minOdds: "1.5" };
const DEFAULT_PERSISTED: Persisted = { ...DEFAULT_DRAFT, mode: "free", freeStake: DEFAULT_FREE_STAKE, paidStake: DEFAULT_PAID_STAKE };

function parseAmount(raw: string, fallback: number): number {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseMinOdds(raw: string): number {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function toFilters(d: Draft): Filters {
  return {
    legs: d.legs,
    category: d.category,
    bookmaker: d.bookmaker,
    minOdds: parseMinOdds(d.minOdds),
  };
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Persisted>;
      return {
        legs: typeof p.legs === "number" && p.legs >= 2 && p.legs <= 4 ? p.legs : DEFAULT_DRAFT.legs,
        category: typeof p.category === "string" ? p.category : "all",
        bookmaker: typeof p.bookmaker === "string" ? p.bookmaker : "all",
        minOdds: typeof p.minOdds === "string" ? p.minOdds : DEFAULT_DRAFT.minOdds,
        mode: p.mode === "paid" ? "paid" : "free",
        freeStake: typeof p.freeStake === "string" && p.freeStake.length > 0 ? p.freeStake : DEFAULT_FREE_STAKE,
        paidStake: typeof p.paidStake === "string" && p.paidStake.length > 0 ? p.paidStake : DEFAULT_PAID_STAKE,
      };
    }
  } catch {
    /* corrupted — fall back to defaults */
  }
  return DEFAULT_PERSISTED;
}

function persist(p: Persisted): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {
    /* non-fatal */
  }
}

/** Outcomes usable as a leg (real, close lay price within the guard). */
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
  mode: BetMode,
  stake: number
): AccaCandidate[] {
  const out: AccaCandidate[] = [];
  const current: LegPick[] = [];

  function recurse(startIdx: number) {
    if (current.length === legCount) {
      const legs = current.map((l) => ({ backOdds: l.outcome.odds, layOdds: l.outcome.layOdds! }));
      const plan = mode === "paid" ? sequentialLayPlanPaid(legs, stake) : sequentialLayPlan(legs, stake);
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

export default function BetBuilder() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState<Draft>(() => {
    const p = loadPersisted();
    return { legs: p.legs, category: p.category, bookmaker: p.bookmaker, minOdds: p.minOdds };
  });
  const [filters, setFilters] = useState<Filters>(() => toFilters({ ...loadPersisted() }));
  const [mode, setMode] = useState<BetMode>(() => loadPersisted().mode);
  const [freeStake, setFreeStake] = useState<string>(() => loadPersisted().freeStake);
  const [paidStake, setPaidStake] = useState<string>(() => loadPersisted().paidStake);
  const freeStakeVal = parseAmount(freeStake, 10);
  const paidStakeVal = parseAmount(paidStake, 20);
  const activeStakeVal = mode === "paid" ? paidStakeVal : freeStakeVal;

  const apply = (next: Draft) => {
    setDraft(next);
    setFilters(toFilters(next));
  };

  const run = () => {
    apply({ ...draft, minOdds: String(parseMinOdds(draft.minOdds)) });
  };

  useEffect(() => {
    persist({ ...draft, mode, freeStake, paidStake });
  }, [draft, mode, freeStake, paidStake]);

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

  const oddsAgeMs = useMemo(() => getOddsAgeMs("upcoming"), [matches]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const m of matches) if (!isIceHockey(m.sportKey)) set.add(sportCategory(m.sportKey));
    return [...set].sort();
  }, [matches]);

  const bookmakers = useMemo(() => {
    const set = new Set<string>();
    for (const m of matches) if (!isIceHockey(m.sportKey)) for (const o of m.outcomes) set.add(o.bookmaker);
    return [...set].sort();
  }, [matches]);

  const results = useMemo(() => {
    if (!filters || matches.length === 0) {
      return {
        accas: [] as AccaCandidate[],
        considered: 0,
        total: 0,
        feedMatches: matches.length,
        qualifiedOutcomes: 0,
        qualifiedFixtures: 0,
        noLayExcluded: 0,
      };
    }

    const byCategory = (m: Match) =>
      filters.category === "all" || sportCategory(m.sportKey) === filters.category;
    const byBookmaker = (o: MatchOutcome) =>
      filters.bookmaker === "all" || o.bookmaker === filters.bookmaker;

    const sorted = [...matches].sort(
      (a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime()
    );

    const matchesWithLegs: MatchWithLegs[] = [];
    let legOutcomes = 0;
    let noLayExcluded = 0;
    for (const m of sorted) {
      if (isIceHockey(m.sportKey)) continue; // regulation-time back vs overtime lay mismatch
      if (!byCategory(m)) continue;
      for (const o of m.outcomes) {
        if (byBookmaker(o) && (o.layOdds == null || o.layOdds <= COMMISSION)) {
          noLayExcluded += 1;
        }
      }
      const outcomes = usableLegs(m)
        .filter(byBookmaker)
        .filter((o) => o.odds >= filters.minOdds);
      if (outcomes.length > 0) {
        matchesWithLegs.push({ match: m, outcomes });
        legOutcomes += outcomes.length;
      }
      if (matchesWithLegs.length >= MAX_MATCHES) break;
    }

    const all = buildAccas(matchesWithLegs, filters.legs, mode, activeStakeVal);
    all.sort((a, b) => b.plan.retainedProfit - a.plan.retainedProfit);
    return {
      accas: all.slice(0, TOP_N),
      considered: matchesWithLegs.length,
      total: all.length,
      feedMatches: matches.length,
      qualifiedOutcomes: legOutcomes,
      qualifiedFixtures: matchesWithLegs.length,
      noLayExcluded,
    };
  }, [matches, filters, mode, activeStakeVal]);

  const controlClass =
    "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200";

  return (
    <Paywall tier="pro" title="the Bet Builder">
      <div className="min-h-dvh page-bg font-['Inter',system-ui,sans-serif]">
        <nav className="border-b border-gray-200 bg-white/90 dark:border-gray-800 dark:bg-gray-950/90">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
            <Link to="/" className="flex items-center gap-2">
              <span className="rounded-lg bg-purple-600 p-2 text-white font-bold text-lg">EAW</span>
              <span className="text-xl font-bold tracking-tight">Everyone's A Winner</span>
            </Link>
            <div className="flex items-center gap-4">
              <Link to="/lay-bets" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400">⚡ Lay Bets</Link>
              <Link to="/oddsmatcher" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400">Best Odds</Link>
              <Link to="/dashboard" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">Dashboard →</Link>
            </div>
          </div>
        </nav>

        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <h1 className="text-3xl font-bold tracking-tight">Bet Builder</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            Combine 2–4 legs from different matches into one bet, with a done-for-you sequential lay plan that locks in the same profit whether the bet wins or any leg loses.
          </p>

          {/* Bet mode toggle: free bet (SNR) or paid (own money) */}
          <div className="mt-5 rounded-xl border border-purple-200 bg-purple-50 p-4 dark:border-purple-900 dark:bg-purple-950/30">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex rounded-lg bg-white p-1 shadow-sm dark:bg-gray-900">
                <button
                  type="button"
                  onClick={() => setMode("free")}
                  className={`rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${mode === "free" ? "bg-purple-600 text-white" : "text-gray-600 hover:text-gray-900 dark:text-gray-400"}`}
                >
                  🎁 Free bet
                </button>
                <button
                  type="button"
                  onClick={() => setMode("paid")}
                  className={`rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${mode === "paid" ? "bg-purple-600 text-white" : "text-gray-600 hover:text-gray-900 dark:text-gray-400"}`}
                >
                  💰 Paid bet
                </button>
              </div>
              <label className="ml-auto flex items-center gap-2">
                <span className="text-xs font-medium text-gray-500">{mode === "paid" ? "Back stake" : "Free-bet stake"}</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold text-gray-600 dark:text-gray-300">£</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={mode === "paid" ? paidStake : freeStake}
                    onChange={(e) => (mode === "paid" ? setPaidStake(e.target.value) : setFreeStake(e.target.value))}
                    onBlur={() => (mode === "paid" ? setPaidStake(String(parseAmount(paidStake, 20))) : setFreeStake(String(parseAmount(freeStake, 10))))}
                    className="w-20 rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-700 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
                  />
                </div>
              </label>
            </div>
            <p className="mt-2 text-xs text-purple-600/80 dark:text-purple-400/80">
              {mode === "paid"
                ? "Paid mode: your own money is at risk, so the plan locks in a qualifying profit/loss (usually a small cost). 5% exchange commission included."
                : "Free-bet mode: figures use a stake-not-returned free bet and 5% exchange commission."}
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
              <span className="text-xs font-medium text-gray-500">Minimum leg odds</span>
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
            Multi-leg bets always combine legs from different matches — same-game bet builders can't be laid on the exchange, so they're excluded. Legs are limited to back odds of 1.10–6.00 and a close exchange lay price (within 0.20); ice hockey is excluded (regulation-time back vs overtime lay). {mode === "paid" ? <>Figures use your £{paidStakeVal} back stake (your own money) and 5% exchange commission — a small locked-in loss is the normal qualifying cost, never a guaranteed profit.</> : <>Figures use a £{freeStakeVal} stake-not-returned free bet and 5% exchange commission.</>} Run searches the freshest cached odds — it never costs an API call.
          </p>
          <p className="mt-1 text-xs text-gray-400">Pre-match odds — refresh every 10 minutes.</p>

          {oddsAgeMs != null && (
            <p className="mt-1 text-xs font-medium text-gray-500">🕒 Odds updated {formatAge(oddsAgeMs)}</p>
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

          {!loading && !error && results.accas.length === 0 && (
            <div className="mt-8 rounded-xl border border-gray-200 bg-white p-8 text-left dark:border-gray-800 dark:bg-gray-950">
              <div className="flex items-start gap-3">
                <span className="text-4xl">🔍</span>
                <div>
                  <p className="text-lg font-semibold text-gray-700 dark:text-gray-200">No multi-leg bets match these settings</p>
                  <p className="mt-1 text-sm text-gray-500">
                    The cached feed holds <strong>{results.feedMatches}</strong> match{results.feedMatches === 1 ? "" : "es"}. <strong>{results.qualifiedFixtures}</strong> fixture{results.qualifiedFixtures === 1 ? "" : "s"} have a qualifying leg (of {results.qualifiedOutcomes} total qualifying legs), but {filters.legs} legs need {filters.legs} different matches.
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

          {!loading && !error && results.accas.length > 0 && (
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
                      <div className="flex items-baseline justify-between gap-2">
                        <div>
                          <div className="text-sm font-semibold text-gray-500">{filters.legs}-leg · combined odds</div>
                          <div className="text-3xl font-extrabold text-gray-900 dark:text-white">{p.combinedBackOdds.toFixed(2)}</div>
                        </div>
                        <div className="shrink-0 rounded-lg bg-purple-50 px-2.5 py-1.5 text-right text-xs leading-5 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300">
                          <div className="font-semibold">{mode === "paid" ? "Paid bet" : "Free bet"} £{mode === "paid" ? paidStakeVal : freeStakeVal}</div>
                          <div className="text-purple-500/80 dark:text-purple-400/80">{mode === "paid" ? "your own money" : "stake not returned"}</div>
                        </div>
                      </div>

                      {/* Per-leg rows */}
                      <div className="mt-4">
                        <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Legs — lay in this order</div>
                        <div className="mt-2 space-y-2">
                          {c.legs.map((leg, i) => {
                            const lp = p.legs[i];
                            const phrase = outcomePhrase(leg.outcome.name, leg.match.home, leg.match.away);
                            return (
                              <div key={i} className="rounded-lg border border-gray-200 bg-gray-50/50 p-3 dark:border-gray-700 dark:bg-gray-900/60">
                                <div className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
                                  <span className="text-gray-400">{i + 1}.</span>
                                  <span>{phrase}</span>
                                </div>
                                <div className="mt-0.5 truncate text-xs text-gray-400">
                                  {getIcon(leg.outcome.name, leg.match.home, leg.match.away)} {leg.match.home} v {leg.match.away} · {leg.match.time}
                                </div>
                                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                                  <div className="rounded-md bg-white px-2 py-1.5 dark:bg-gray-900">
                                    <div className="text-gray-400">Back <span className="font-semibold text-gray-800 dark:text-gray-100">{leg.outcome.odds.toFixed(2)}</span></div>
                                    <div className="truncate text-gray-400">@ {leg.outcome.bookmaker}</div>
                                  </div>
                                  <div className="rounded-md bg-purple-50 px-2 py-1.5 dark:bg-purple-950/40">
                                    <div className="text-purple-500">Lay <span className="font-semibold text-purple-700 dark:text-purple-300">{lp.layOdds.toFixed(2)}</span></div>
                                    <div className="truncate text-purple-500">@ {leg.outcome.laySource ?? "exchange"}</div>
                                  </div>
                                </div>
                                <div className="mt-2 flex justify-between text-xs text-gray-500 dark:text-gray-400">
                                  <span>Lay stake <span className="font-semibold text-gray-700 dark:text-gray-200">{money(lp.layStake)}</span></span>
                                  <span>Liability <span className="font-semibold text-gray-700 dark:text-gray-200">{money(lp.liability)}</span></span>
                                </div>
                                <div className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                                  If {phrase.toLowerCase()} fails: exchange lay wins {money(lp.layWin)}, bookmaker bet dead — {mode === "paid" ? "locked in" : "retained"} {mode === "paid" ? (p.retainedProfit < 0 ? "−" : "+") : ""}{money(Math.abs(p.retainedProfit))}.
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {/* Roll-up */}
                      <div className={`mt-4 rounded-xl p-3 ${mode === "paid" ? "bg-amber-50 dark:bg-amber-950/30" : "bg-green-50 dark:bg-green-950/30"}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className={`text-[11px] font-medium uppercase tracking-wide ${mode === "paid" ? "text-amber-600 dark:text-amber-400" : "text-green-600 dark:text-green-400"}`}>
                              {mode === "paid" ? "Locked-in profit / loss" : "Guaranteed retained profit"}
                            </div>
                            <div className={`text-2xl font-extrabold ${mode === "paid" ? "text-amber-700 dark:text-amber-300" : "text-green-700 dark:text-green-300"}`}>
                              {p.retainedProfit < 0 ? "−" : "+"}{money(Math.abs(p.retainedProfit))}
                            </div>
                            <div className={`text-xs ${mode === "paid" ? "text-amber-600/80 dark:text-amber-400/80" : "text-green-600/80 dark:text-green-400/80"}`}>
                              Same if the bet wins or any leg loses{mode === "paid" ? " — a loss is your qualifying cost" : ""}
                            </div>
                          </div>
                          {mode === "free" && (
                            <div className="rounded-md bg-green-100 px-2 py-1 text-xs font-semibold text-green-700 dark:bg-green-900/50 dark:text-green-300">
                              Retain {retentionPct}%
                            </div>
                          )}
                        </div>
                        <div className="mt-2 grid grid-cols-3 gap-2 border-t border-gray-100 pt-2 dark:border-gray-800">
                          <div>
                            <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Bet return</div>
                            <div className="mt-0.5 font-semibold text-gray-800 dark:text-gray-200">{money(p.grossReturn)}</div>
                          </div>
                          <div>
                            <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Total liability</div>
                            <div className="mt-0.5 font-semibold text-gray-800 dark:text-gray-200">{money(p.totalLiability)}</div>
                          </div>
                          <div>
                            <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Lay leg 1</div>
                            <div className="mt-0.5 font-semibold text-gray-800 dark:text-gray-200">{money(p.legs[0].layStake)}</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-4 text-xs text-gray-400">
                Showing the top {results.accas.length} of {results.total} matching multi-leg bets (from {results.considered} fixtures with exchange lay prices), ranked by guaranteed retained profit. Lay each leg <strong>in order</strong>, only after the previous leg settles.
                {results.noLayExcluded > 0 && (
                  <> {results.noLayExcluded} outcome{results.noLayExcluded === 1 ? "" : "s"} skipped — no exchange lay price.</>
                )}
              </p>
            </>
          )}

          <section className="mt-16 border-t border-gray-200 pt-10 dark:border-gray-800">
            <details open className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
                <h2 className="text-2xl font-bold tracking-tight">How multi-leg bets and lay plans work</h2>
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
