import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { formatOdds } from "../lib/odds";
import { getMatches, type Match } from "../lib/odds-api";

const STAKE = 20;

function getIcon(name: string, home: string, away: string): string {
  const lower = name.toLowerCase();
  if (lower === home.toLowerCase()) return "⬆️";
  if (lower === away.toLowerCase()) return "⬇️";
  return "➡️";
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
      .then((data) => { if (!cancelled) { setMatches(data); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err instanceof Error ? err.message : "Failed"); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const leagueKeys = [...new Set(matches.map((m) => m.leagueKey))].sort();
  const filterOptions = ["All", ...leagueKeys];
  const filtered = filter === "All" ? matches : matches.filter((m) => m.leagueKey === filter);

  return (
    <div className="min-h-dvh page-bg font-['Inter',system-ui,sans-serif]">
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
        <p className="mt-2 text-gray-600 dark:text-gray-400">Odds updated daily.</p>

        <div className="mt-6 flex flex-wrap gap-2">
          {filterOptions.map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${filter === f ? "bg-indigo-600 text-white" : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-300"}`}>{f}</button>
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
          <div className="mt-8 rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-500 dark:border-gray-800 dark:bg-gray-950">No matches found for this league. Try a different filter.</div>
        )}

        {!loading && !error && (
          <div className="mt-6 grid grid-cols-1 gap-4">
            {filtered.map((m) => {
              const totalStake = m.outcomes.length * STAKE;
              const returns = m.outcomes.map((o) => o.return20);
              const minReturn = Math.min(...returns);
              return (
                <div key={m.matchId}
                  className="rounded-xl border-2 border-gray-200 dark:border-gray-800 p-5 bg-white dark:bg-gray-950 shadow-sm transition-shadow hover:shadow-md"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {m.leagueKey === "World Cup" && <span className="text-lg">🏆</span>}
                      <span className="font-bold text-lg">{m.home} vs {m.away}</span>
                      <span className="text-xs text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">{m.league}</span>
                    </div>
                    <span className="text-xs text-gray-400">{m.time}</span>
                  </div>

                  <div className="mt-4 space-y-2">
                    {m.outcomes.map((o, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        <span className="text-lg">{getIcon(o.name, m.home, m.away)}</span>
                        <span className="font-medium"><strong>{o.name}</strong> at <strong>{o.bookmaker}</strong> ({formatOdds(o.odds)})</span>
                        <span className="font-medium text-indigo-700 dark:text-indigo-400">— £{STAKE} returns <strong>£{o.return20.toFixed(2)}</strong></span>
                      </div>
                    ))}
                  </div>

                  <div className="mt-4 flex items-center gap-2">
                    <span className="text-lg">💰</span>
                    <span className="text-sm text-gray-700 dark:text-gray-300">
                      Bet <strong>£{totalStake}</strong> across all outcomes — minimum return <strong>£{minReturn.toFixed(2)}</strong>
                    </span>
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