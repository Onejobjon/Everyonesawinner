import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  calcLay,
  formatOdds,
  layGap,
  qualifiesForLay,
  round2,
  type LayCalc,
} from "../lib/odds";
import { getMatches, type Match, type MatchOutcome } from "../lib/odds-api";
import Paywall from "../components/Paywall";
import Markdown from "../components/Markdown";
import guideMarkdown from "../content/lay-betting-guide.md?raw";

const BACK_STAKE = 20;

interface LayOpportunity {
  match: Match;
  outcome: MatchOutcome;
  lay: LayCalc;
  gap: number;
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

export default function LayBets() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getMatches()
      .then((data) => { if (!cancelled) { setMatches(data); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err instanceof Error ? err.message : "Failed"); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const opportunities = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows: LayOpportunity[] = [];
    for (const m of matches) {
      if (q) {
        const hay = `${m.home} ${m.away} ${m.league} ${m.leagueKey}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      for (const o of m.outcomes) {
        if (!qualifiesForLay(o.odds, o.layOdds)) continue;
        const lay = calcLay(o.odds, o.layOdds, BACK_STAKE);
        if (!lay) continue;
        rows.push({ match: m, outcome: o, lay, gap: layGap(o.odds, o.layOdds!) });
      }
    }
    // Best expected profit first (positive rows at the top), then smallest gap.
    rows.sort((a, b) => {
      const d = round2(b.lay.profitLoss) - round2(a.lay.profitLoss);
      if (d !== 0) return d;
      return a.gap - b.gap;
    });
    return rows;
  }, [matches, query]);

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

        <div className="mx-auto max-w-6xl px-6 py-8">
          <h1 className="text-3xl font-bold tracking-tight">Lay Bet Finder</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            Back an outcome at the bookmaker, lay the same outcome on the exchange — and lock in the result. Only close, profitable lays are shown.
          </p>

          <div className="mt-6">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search team or league…"
              className="w-full max-w-md rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 placeholder:text-gray-400 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
            />
          </div>

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
              <button onClick={() => { setLoading(true); setError(null); getMatches().then((d) => setMatches(d)).catch((e) => setError(e instanceof Error ? e.message : "Failed")).finally(() => setLoading(false)); }}
                className="mt-4 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700">Retry</button>
            </div>
          )}

          {!loading && !error && opportunities.length === 0 && (
            <div className="mt-8 rounded-xl border border-gray-200 bg-white p-10 text-center dark:border-gray-800 dark:bg-gray-950">
              <span className="text-4xl">🔍</span>
              <p className="mt-4 text-lg font-semibold text-gray-700 dark:text-gray-200">No close lays right now</p>
              <p className="mt-1 text-sm text-gray-500">Odds move constantly — check back soon.</p>
            </div>
          )}

          {!loading && !error && opportunities.length > 0 && (
            <div className="mt-6 overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-gray-400">
                    <th className="pb-2 font-medium">Match</th>
                    <th className="pb-2 font-medium">Outcome</th>
                    <th className="pb-2 font-medium">Back (bookmaker)</th>
                    <th className="pb-2 font-medium">Lay (exchange)</th>
                    <th className="pb-2 text-right font-medium">Lay stake</th>
                    <th className="pb-2 text-right font-medium">Liability</th>
                    <th className="pb-2 text-right font-medium">Est. profit/loss</th>
                  </tr>
                </thead>
                <tbody>
                  {opportunities.map((op, i) => (
                    <tr key={i} className="border-t border-gray-100 dark:border-gray-800 align-top">
                      <td className="py-3 pr-3">
                        <div className="font-medium text-gray-800 dark:text-gray-100">
                          {op.match.home} vs {op.match.away}
                        </div>
                        <div className="text-xs text-gray-400">{op.match.league} · {op.match.time}</div>
                      </td>
                      <td className="py-3 pr-3 whitespace-nowrap">
                        <span className="mr-1">{getIcon(op.outcome.name, op.match.home, op.match.away)}</span>
                        <span className="font-medium">{op.outcome.name}</span>
                      </td>
                      <td className="py-3 pr-3 whitespace-nowrap">
                        <span className="font-semibold">{op.outcome.odds.toFixed(2)}</span>
                        <span className="ml-1 text-gray-500">({formatOdds(op.outcome.odds)})</span>
                        <span className="ml-1 text-gray-500">@ {op.outcome.bookmaker}</span>
                      </td>
                      <td className="py-3 pr-3 whitespace-nowrap">
                        {op.outcome.layOdds ? (
                          <span>
                            <span className="font-semibold">{op.outcome.layOdds.toFixed(2)}</span>
                            <span className="ml-1 text-gray-500">({formatOdds(op.outcome.layOdds)})</span>
                            <span className="ml-1 text-gray-500">({op.outcome.laySource})</span>
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="py-3 pr-3 text-right whitespace-nowrap">{money(op.lay.layStake)}</td>
                      <td className="py-3 pr-3 text-right whitespace-nowrap">{money(op.lay.liability)}</td>
                      <td className="py-3 text-right whitespace-nowrap">
                        <span className={`font-semibold ${op.lay.profitLoss >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}>
                          {op.lay.profitLoss >= 0 ? "+" : "-"}{money(Math.abs(op.lay.profitLoss))}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-gray-400">
                Lay = betting <strong>against</strong> this outcome on the exchange (Betfair). Figures use a £20 back stake and include 5% exchange commission. Only rows with back odds under 2.8 and a lay gap under 0.1 are shown.
              </p>
            </div>
          )}

          <section id="how-lay-works" className="mt-16 border-t border-gray-200 pt-10 dark:border-gray-800">
            <h2 className="text-2xl font-bold tracking-tight">How lay betting works</h2>
            <div className="mt-4">
              <Markdown source={guideMarkdown} />
            </div>
          </section>
        </div>
      </div>
    </Paywall>
  );
}
