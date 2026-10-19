import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { sequentialLayPlan, type AccaPlan } from "../lib/acca";
import { COMMISSION } from "../lib/odds";
import { getMatches, type Match, type MatchOutcome } from "../lib/odds-api";
import Paywall from "../components/Paywall";
import Markdown from "../components/Markdown";
import guideMarkdown from "../content/acca-betting-guide.md?raw";

const TOP_N = 10;
const MAX_MATCHES = 24; // soonest matches considered — bounds the 4-leg search

// Leg-quality guard. The odds feed occasionally carries error/sentinel prices
// (e.g. 1.0 or 100+) and longshot legs are impractical to lay (huge liability,
// thin exchange liquidity). We only build accas from legs priced realistically.
const MIN_LEG_ODDS = 1.1;
const MAX_BACK_ODDS = 6.0;
// A leg is only "layable" when the exchange lay price is real AND close to the
// back price. Mismatched/error lay data (seen in some minor-league feeds) shows
// up as lay < back (negative gap) or a huge gap — both are excluded.
const MIN_LAY_GAP = -0.05;
const MAX_LAY_GAP = 0.2;

type WindowKey = "today" | "24h" | "weekend";
type OfferType = "snr";

interface LegPick {
  match: Match;
  outcome: MatchOutcome; // guaranteed layOdds != null
}

interface AccaCandidate {
  legs: LegPick[];
  plan: AccaPlan;
}

interface MatchWithLegs {
  match: Match;
  outcomes: MatchOutcome[]; // outcomes that have a usable lay price
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

function matchesInWindow(matches: Match[], win: WindowKey): Match[] {
  const now = Date.now();
  return matches.filter((m) => {
    const t = new Date(m.commenceTime).getTime();
    if (isNaN(t) || t <= now) return false;
    if (win === "24h") return t - now <= 24 * 3600_000;
    if (win === "today") {
      return new Date(t).toDateString() === new Date(now).toDateString();
    }
    const day = new Date(t).getDay();
    return day === 0 || day === 6; // weekend
  });
}

function buildAccas(
  matchesWithLegs: MatchWithLegs[],
  legCount: number,
  minOdds: number,
  stake: number
): AccaCandidate[] {
  const out: AccaCandidate[] = [];
  const current: LegPick[] = [];

  function recurse(startIdx: number) {
    if (current.length === legCount) {
      const plan = sequentialLayPlan(
        current.map((l) => ({ backOdds: l.outcome.odds, layOdds: l.outcome.layOdds! })),
        stake
      );
      if (plan && plan.combinedBackOdds >= minOdds) {
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

export default function AccaFinder() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [legs, setLegs] = useState(3);
  const [stake, setStake] = useState(10);
  const [offerType, setOfferType] = useState<OfferType>("snr");
  const [minOdds, setMinOdds] = useState(3.0);
  const [windowKey, setWindowKey] = useState<WindowKey>("24h");

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

  const results = useMemo(() => {
    if (matches.length === 0) return { accas: [] as AccaCandidate[], considered: 0, total: 0 };
    const sorted = [...matches].sort(
      (a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime()
    );
    const inWin = matchesInWindow(sorted, windowKey);

    const matchesWithLegs: MatchWithLegs[] = [];
    for (const m of inWin) {
      const outcomes = m.outcomes.filter((o) => {
        if (o.layOdds == null || o.layOdds <= COMMISSION) return false;
        if (o.odds < MIN_LEG_ODDS || o.odds > MAX_BACK_ODDS) return false;
        const gap = o.layOdds - o.odds;
        return gap >= MIN_LAY_GAP && gap <= MAX_LAY_GAP;
      });
      if (outcomes.length > 0) matchesWithLegs.push({ match: m, outcomes });
      if (matchesWithLegs.length >= MAX_MATCHES) break;
    }

    const all = buildAccas(matchesWithLegs, legs, minOdds, stake);
    all.sort((a, b) => b.plan.retainedProfit - a.plan.retainedProfit);
    return {
      accas: all.slice(0, TOP_N),
      considered: matchesWithLegs.length,
      total: all.length,
    };
  }, [matches, legs, stake, minOdds, windowKey]);

  const bestProfit =
    results.accas.length > 0 ? results.accas[0].plan.retainedProfit : 0;

  return (
    <Paywall tier="pro" title="the Acca Finder">
      <div className="min-h-dvh page-bg font-['Inter',system-ui,sans-serif]">
        <nav className="border-b border-gray-200 bg-white/90 dark:border-gray-800 dark:bg-gray-950/90">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
            <Link to="/" className="flex items-center gap-2">
              <span className="rounded-lg bg-purple-600 p-2 text-white font-bold text-lg">EAW</span>
              <span className="text-xl font-bold tracking-tight">Everyone's A Winner</span>
            </Link>
            <div className="flex items-center gap-4">
              <Link to="/lay-bets" className="text-sm font-medium text-purple-600 hover:text-purple-700 dark:text-purple-400">⚡ Lay Bets</Link>
              <Link to="/dashboard" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">Dashboard →</Link>
            </div>
          </div>
        </nav>

        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <h1 className="text-3xl font-bold tracking-tight">Acca Finder</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            Turn a free bet into a near-certain profit. Build a 2/3/4-leg acca from different matches, then lay each leg in order — the plan and the guaranteed retained profit are done for you.
          </p>

          {/* Controls */}
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <label className="block">
              <span className="text-xs font-medium text-gray-500">Legs</span>
              <select
                value={legs}
                onChange={(e) => setLegs(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
              >
                <option value={2}>2 legs</option>
                <option value={3}>3 legs</option>
                <option value={4}>4 legs</option>
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-500">Free bet stake</span>
              <input
                type="number"
                min={1}
                step={1}
                value={stake}
                onChange={(e) => setStake(Math.max(1, Number(e.target.value) || 1))}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-500">Offer type</span>
              <select
                value={offerType}
                onChange={(e) => setOfferType(e.target.value as OfferType)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
              >
                <option value="snr">Free bet if acca wins</option>
                <option value="insurance" disabled>Acca insurance (coming soon)</option>
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-500">Min combined odds</span>
              <select
                value={minOdds}
                onChange={(e) => setMinOdds(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
              >
                {[2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 8.0].map((o) => (
                  <option key={o} value={o}>{o.toFixed(1)}+</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-500">Kick-off window</span>
              <select
                value={windowKey}
                onChange={(e) => setWindowKey(e.target.value as WindowKey)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
              >
                <option value="24h">Next 24 hours</option>
                <option value="today">Today</option>
                <option value="weekend">Weekend</option>
              </select>
            </label>
          </div>

          <p className="mt-3 text-xs text-gray-400">
            Accas always combine legs from <strong>different matches</strong> — same-game bet builders can't be laid on the exchange, so they're excluded. Legs are limited to back odds of 1.10–6.00 and a close exchange lay price (within 0.20 of the back odds) — longer prices or mismatched lay data are excluded. Figures use the free-bet stake, stake-not-returned (SNR) and 5% exchange commission.
          </p>

          {loading && (
            <div className="mt-12 flex flex-col items-center justify-center gap-4">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-purple-600 border-t-transparent" />
              <p className="text-sm text-gray-500">Loading live odds...</p>
            </div>
          )}

          {error && !loading && (
            <div className="mt-8 rounded-xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-900 dark:bg-red-950">
              <p className="font-medium text-red-700 dark:text-red-400">Couldn't load odds</p>
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
            <div className="mt-8 rounded-xl border border-gray-200 bg-white p-10 text-center dark:border-gray-800 dark:bg-gray-950">
              <span className="text-4xl">🔍</span>
              <p className="mt-4 text-lg font-semibold text-gray-700 dark:text-gray-200">No accas match these settings</p>
              <p className="mt-1 text-sm text-gray-500">
                Try lowering the minimum combined odds, widening the kick-off window, or dropping a leg. No combinations of the required size have exchange lay prices right now.
              </p>
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
                        <span className="absolute -top-3 right-4 rounded-full bg-green-600 px-3 py-1 text-xs font-bold text-white shadow-sm">
                          ★ Best
                        </span>
                      )}

                      {/* Header */}
                      <div>
                        <div className="pr-14 text-sm font-semibold text-gray-500">
                          {legs}-leg acca · combined odds
                        </div>
                        <div className="mt-0.5 text-3xl font-extrabold text-gray-900 dark:text-white">
                          {p.combinedBackOdds.toFixed(2)}
                        </div>
                      </div>

                      {/* Guaranteed retained profit */}
                      <div className="mt-3 rounded-xl bg-green-50 p-3 dark:bg-green-950/30">
                        <div className="text-[11px] font-medium uppercase tracking-wide text-green-600 dark:text-green-400">
                          Guaranteed retained profit
                        </div>
                        <div className="mt-0.5 text-2xl font-extrabold text-green-700 dark:text-green-300">
                          +{money(p.retainedProfit)}
                        </div>
                        <div className="text-xs text-green-600/80 dark:text-green-400/80">
                          Same if the acca wins or any leg loses
                        </div>
                      </div>

                      {/* Legs */}
                      <div className="mt-3">
                        <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                          Legs — lay in this order
                        </div>
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
                                    <div className="text-gray-600 dark:text-gray-300">
                                      Back <span className="font-semibold">{leg.outcome.odds.toFixed(2)}</span>
                                    </div>
                                    <div className="text-purple-600 dark:text-purple-400">
                                      Lay <span className="font-semibold">{lp.layOdds.toFixed(2)}</span>
                                    </div>
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

                      {/* Footer metrics */}
                      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-gray-100 pt-3 dark:border-gray-800">
                        <div>
                          <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Acca return</div>
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
                Showing the top {results.accas.length} of {results.total} matching accas (from {results.considered} fixtures with exchange lay prices). Ranked by guaranteed retained profit. Lay each leg <strong>in order</strong>, only after the previous leg settles.
              </p>
            </>
          )}

          <section className="mt-16 border-t border-gray-200 pt-10 dark:border-gray-800">
            <details open className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
                <h2 className="text-2xl font-bold tracking-tight">How accas and lay plans work</h2>
                <svg className="h-5 w-5 flex-shrink-0 text-gray-400 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </summary>
              <div className="mt-4">
                <Markdown source={guideMarkdown} />
              </div>
            </details>
          </section>
        </div>
      </div>
    </Paywall>
  );
}
