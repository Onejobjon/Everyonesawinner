import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { formatOdds } from "../lib/odds";
import { getMatches, type Match } from "../lib/odds-api";

const BACK_STAKE = 20;

function calcBet(backOdds: number, layOdds: number) {
  const backReturn = BACK_STAKE * backOdds;
  const backProfit = backReturn - BACK_STAKE;
  const layStake = (BACK_STAKE * backOdds) / layOdds;
  const layReturn = layStake * layOdds;
  const guaranteedProfit = backReturn - BACK_STAKE - layStake;
  return { backReturn, backProfit, layStake, layReturn, guaranteedProfit };
}

export default function Oddsmatcher() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("All");

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
          setError(err instanceof Error ? err.message : "Failed to load odds");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const leagueKeys = [...new Set(matches.map((m) => m.leagueKey))].sort();
  const filterOptions = ["All", ...leagueKeys];

  const filtered =
    filter === "All"
      ? matches
      : matches.filter((m) => m.leagueKey === filter);

  return (
    <div className="min-h-dvh bg-gray-50 dark:bg-gray-950 font-['Inter',system-ui,sans-serif]">
      <nav className="border-b border-gray-200 bg-white/90 dark:border-gray-800 dark:bg-gray-950/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2">
            <span className="rounded-lg bg-indigo-600 p-2 text-white font-bold text-lg">EAW</span>
            <span className="text-xl font-bold tracking-tight">Everyone's A Winner</span>
          </Link>
          <Link to="/" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">← Back to Home</Link>
        </div>
      </nav>

      <div className="mx-auto max-w-5xl px-6 py-8">
        <h1 className="text-3xl font-bold tracking-tight">Best Odds Finder</h1>
        <p className="mt-2 text-gray-600 dark:text-gray-400">Live odds from top UK bookmakers.</p>

        <div className="mt-6 flex flex-wrap gap-2">
          {filterOptions.map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                filter === f ? "bg-indigo-600 text-white" : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-300"
              }`}>{f}</button>
          ))}
        </div>

        {loading && (
          <div className="mt-12 flex flex-col items-center justify-center gap-4">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
            <p className="text-sm text-gray-500">Loading live odds...</p>
          </div>
        )}

        {error && !loading && (
          <div className="mt-8 rounded-xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-900 dark:bg-red-950">
            <p className="text-red-700 dark:text-red-400 font-medium">Couldn't load odds</p>
            <p className="mt-1 text-sm text-red-500">{error}</p>
            <button onClick={() => { setLoading(true); setError(null); getMatches().then((d) => setMatches(d)).catch((e) => setError(e instanceof Error ? e.message : "Failed")).finally(() => setLoading(false)); }}
              className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">Retry</button>
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="mt-8 rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-500 dark:border-gray-800 dark:bg-gray-950">
            No matches found for this league. Try a different filter.
          </div>
        )}

        {!loading && !error && (
          <div className="mt-6 grid grid-cols-1 gap-4">
            {filtered.map((m) => {
              const { best } = m;
              const { backReturn, backProfit, layStake, guaranteedProfit } = calcBet(best.backOdds, best.layOdds);
              const isPositive = guaranteedProfit > 0;
              return (
                <div key={m.matchId}
                  className={`rounded-xl border-2 p-5 bg-white dark:bg-gray-950 shadow-sm transition-shadow hover:shadow-md ${
                    isPositive ? "border-green-500" : "border-gray-200 dark:border-gray-800"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {m.leagueKey === "World Cup" && <span className="text-lg">🏆</span>}
                      <span className="font-bold text-lg">{m.home} vs {m.away}</span>
                      <span className="text-xs text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">{m.league}</span>
                    </div>
                    <span className="text-xs text-gray-400">{m.time}</span>
                  </div>

                  {/* Back bet */}
                  <div className="mt-4">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-lg">⬆️</span>
                      <span className="font-medium">
                        Back <strong>{best.outcome}</strong> at <strong>{best.bookmaker}</strong>
                      </span>
                      <span className="font-mono font-bold text-base">({formatOdds(best.backOdds)})</span>
                    </div>
                    <div className="mt-1 ml-8 text-sm text-gray-600 dark:text-gray-400">
                      Bet <strong>£{BACK_STAKE}</strong> → you get <strong>£{backReturn.toFixed(2)}</strong> <span className="text-green-600 dark:text-green-400">(£{backProfit.toFixed(2)} profit)</span>
                    </div>
                  </div>

                  {/* Lay bet */}
                  <div className="mt-3">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-lg">⬇️</span>
                      <span className="font-medium">
                        VS — Lay this outcome at <strong>{best.exchange}</strong>
                      </span>
                      <span className="font-mono font-bold text-base">({formatOdds(best.layOdds)})</span>
                    </div>
                    <div className="mt-1 ml-8 text-sm text-gray-600 dark:text-gray-400">
                      Bet <strong>£{layStake.toFixed(2)}</strong> → covers your back bet
                    </div>
                  </div>

                  {/* Profit line */}
                  <div className="mt-4 flex items-center gap-2">
                    <span className="text-lg">{isPositive ? "💰" : "⚖️"}</span>
                    {isPositive ? (
                      <span className="text-green-700 dark:text-green-400 font-bold text-sm">
                        Guaranteed profit: <span className="text-base">£{guaranteedProfit.toFixed(2)}</span>
                      </span>
                    ) : (
                      <span className="text-sm text-gray-400">
                        Near match — £{Math.abs(guaranteedProfit).toFixed(2)} difference (use free bets here)
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}