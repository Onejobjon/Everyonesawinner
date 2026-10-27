import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  calcLay,
  layGap,
  round2,
  qualifiesForLay,
  type LayCalc,
} from "../lib/odds";
import {
  getMatches,
  getOddsAgeMs,
  type Match,
  type MatchOutcome,
} from "../lib/odds-api";
import Paywall from "../components/Paywall";
import Markdown from "../components/Markdown";
import layGuide from "../content/lay-betting-guide.md?raw";
import {
  sportCategory,
  sportLabel,
  isIceHockey,
  getIcon,
  money,
  formatAge,
} from "../lib/laybets-common";

const DEFAULT_STAKE = "20"; // cash qualifying back stake (user-editable)

const LS_KEY = "eaw_laybets_singles_v1";

interface LayOpportunity {
  match: Match;
  outcome: MatchOutcome;
  lay: LayCalc;
  gap: number;
}

interface Filters {
  category: string;
  minOdds: number;
}

// Draft keeps min-odds as RAW TEXT so the owner can clear it and type a fresh
// number; it is parsed/clamped only on Run or blur.
interface Draft {
  category: string;
  minOdds: string;
}

interface Persisted extends Draft {
  stake: string;
}

const DEFAULT_DRAFT: Draft = { category: "all", minOdds: "1.5" };
const DEFAULT_PERSISTED: Persisted = { ...DEFAULT_DRAFT, stake: DEFAULT_STAKE };

/** Parse a positive stake amount (empty/invalid → fallback). */
function parseAmount(raw: string, fallback: number): number {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Parse the min-odds text, clamping to ≥ 1.0 (empty/invalid → 1). */
function parseMinOdds(raw: string): number {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function toFilters(d: Draft): Filters {
  return {
    category: d.category,
    minOdds: parseMinOdds(d.minOdds),
  };
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Persisted>;
      return {
        category: typeof p.category === "string" ? p.category : "all",
        minOdds: typeof p.minOdds === "string" ? p.minOdds : DEFAULT_DRAFT.minOdds,
        stake: typeof p.stake === "string" && p.stake.length > 0 ? p.stake : DEFAULT_STAKE,
      };
    }
  } catch {
    /* corrupted/stale — fall back to defaults */
  }
  return DEFAULT_PERSISTED;
}

function persist(p: Persisted): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {
    /* localStorage can throw in private mode — non-fatal */
  }
}

export default function LayBets() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Instant-on-open: load last-used controls and apply immediately (zero clicks).
  const [draft, setDraft] = useState<Draft>(() => {
    const p = loadPersisted();
    return { category: p.category, minOdds: p.minOdds };
  });
  const [filters, setFilters] = useState<Filters>(() => toFilters({ ...loadPersisted() }));
  const [stake, setStake] = useState<string>(() => loadPersisted().stake);
  const stakeVal = parseAmount(stake, 20);

  const apply = (next: Draft) => {
    setDraft(next);
    setFilters(toFilters(next));
  };

  const run = () => {
    apply({ ...draft, minOdds: String(parseMinOdds(draft.minOdds)) });
  };

  // Persist last-used controls across visits.
  useEffect(() => {
    persist({ ...draft, stake });
  }, [draft, stake]);

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

  // Sport dropdown excludes ice hockey (its lay odds are nulled at the data
  // layer, so it could never produce a row).
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const m of matches) if (!isIceHockey(m.sportKey)) set.add(sportCategory(m.sportKey));
    return [...set].sort();
  }, [matches]);

  const results = useMemo(() => {
    if (!filters || matches.length === 0) {
      return {
        singles: [] as LayOpportunity[],
        feedMatches: matches.length,
        withheld: 0,
      };
    }

    const byCategory = (m: Match) =>
      filters.category === "all" || sportCategory(m.sportKey) === filters.category;

    const sorted = [...matches].sort(
      (a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime()
    );

    const rows: LayOpportunity[] = [];
    // Rows where the feed quoted a lay price but the back/lay sanity check
    // withheld it (sentinel value, or a lay >10% below the back = two different
    // markets). Counted so the page can say so instead of silently hiding them.
    let withheld = 0;
    for (const m of sorted) {
      if (!byCategory(m)) continue;
      for (const o of m.outcomes) {
        if (o.odds < filters.minOdds) continue;
        if (o.laySuspect) withheld++;
        // All odds with a lay gap < 0.2 (no back-odds ceiling). Ice hockey is
        // already excluded at the data layer (layOdds = null), so qualifiesForLay
        // returns false for it automatically.
        if (!qualifiesForLay(o.odds, o.layOdds)) continue;
        const lay = calcLay(o.odds, o.layOdds, stakeVal);
        if (!lay) continue;
        rows.push({ match: m, outcome: o, lay, gap: layGap(o.odds, o.layOdds!) });
      }
    }
    rows.sort((a, b) => {
      const d = round2(b.lay.profitLoss) - round2(a.lay.profitLoss);
      if (d !== 0) return d;
      return a.gap - b.gap;
    });
    return { singles: rows, feedMatches: matches.length, withheld };
  }, [matches, filters, stakeVal]);

  const bestProfit =
    results.singles.length > 0 ? round2(results.singles[0].lay.profitLoss) : 0;

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
              <Link to="/bet-builder" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400">🧮 Bet Builder</Link>
              <Link to="/oddsmatcher" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400">Best Odds</Link>
              <Link to="/dashboard" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">Dashboard →</Link>
            </div>
          </div>
        </nav>

        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <h1 className="text-3xl font-bold tracking-tight">Lay Bet Finder</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            Back an outcome at the bookmaker, lay it on the exchange — and lock in the result. Every close single lay, ranked by what it returns on your stake.
          </p>

          {/* Controls: stake / sport / min odds / run */}
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="block">
              <span className="text-xs font-medium text-gray-500">Stake</span>
              <div className="mt-1 flex items-center gap-1.5">
                <span className="text-sm font-semibold text-gray-600 dark:text-gray-300">£</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={stake}
                  onChange={(e) => setStake(e.target.value)}
                  onBlur={() => setStake(String(parseAmount(stake, 20)))}
                  className={controlClass}
                />
              </div>
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
              <span className="text-xs font-medium text-gray-500">Minimum back odds</span>
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
            Singles show every outcome with a lay gap under 0.20 (negative gap = better than break-even), on your £{stakeVal} cash back stake, including 5% exchange commission. Ice hockey is excluded — bookmaker back odds are regulation-time but exchange lays include overtime, so they never match. Run searches the freshest cached odds — it never costs an API call.
          </p>
          <p className="mt-1 text-xs text-gray-400">
            Pre-match odds — refresh every 10 minutes. Prices the feed reports as unavailable (1.00 / 451) are removed, and a lay price more than 10% below the bookmaker price is withheld — those rows are two different markets, not an opportunity.
          </p>

          {results.withheld > 0 && (
            <p className="mt-1 text-xs font-medium text-amber-600 dark:text-amber-400">
              ⚠️ {results.withheld} row{results.withheld === 1 ? "" : "s"} hidden — the exchange lay price was more than 10% below the bookmaker price, so it can't be matched. That gap nearly always means two different markets, not free money. See “Why you'll sometimes see fewer matches” in the guide below.
            </p>
          )}

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

          {!loading && !error && results.singles.length === 0 && (
            <div className="mt-8 rounded-xl border border-gray-200 bg-white p-8 text-left dark:border-gray-800 dark:bg-gray-950">
              <div className="flex items-start gap-3">
                <span className="text-4xl">🔍</span>
                <div>
                  <p className="text-lg font-semibold text-gray-700 dark:text-gray-200">No close lays match these settings</p>
                  <p className="mt-1 text-sm text-gray-500">
                    The cached feed holds <strong>{results.feedMatches}</strong> match{results.feedMatches === 1 ? "" : "es"}.
                  </p>
                  <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-gray-500">
                    {filters.minOdds > 1 && <li>Lower the minimum odds.</li>}
                    {filters.category !== "all" && <li>Set Sport back to “All sports”.</li>}
                    <li>Odds refresh about every 10 minutes — check back later.</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {!loading && !error && results.singles.length > 0 && (
            <>
              <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {results.singles.map((op) => {
                  const profitable = op.lay.profitLoss >= 0;
                  const isBest = profitable && round2(op.lay.profitLoss) === bestProfit;
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
                    </div>
                  );
                })}
              </div>
              <p className="mt-4 text-xs text-gray-400">
                Showing {results.singles.length} close-lay opportunities. Lay = betting <strong>against</strong> the outcome on the exchange (Betfair). Figures use your £{stakeVal} back stake and include 5% exchange commission.
              </p>
            </>
          )}

          <div className="mt-10 rounded-xl border border-gray-200 bg-gray-50 p-6 text-center dark:border-gray-800 dark:bg-gray-900/50">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Want to combine two or more legs into one bet with a done-for-you lay plan?
            </p>
            <Link
              to="/bet-builder"
              className="mt-3 inline-block rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 transition-colors"
            >
              Open the Bet Builder →
            </Link>
          </div>

          <section className="mt-16 border-t border-gray-200 pt-10 dark:border-gray-800">
            <details open className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
                <h2 className="text-2xl font-bold tracking-tight">How lay betting works</h2>
                <svg className="h-5 w-5 flex-shrink-0 text-gray-400 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              </summary>
              <div className="mt-4"><Markdown source={layGuide} /></div>
            </details>
          </section>
        </div>
      </div>
    </Paywall>
  );
}
