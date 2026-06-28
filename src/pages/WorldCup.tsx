import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { formatOdds } from "../lib/odds";
import { getWorldCupMatches, type Match } from "../lib/odds-api";

const STAKE = 20;

function extractTeam(outcome: string): string {
  return outcome.replace(/\s+to\s+win$/i, "").trim();
}

function vsTeam(outcome: string, home: string, away: string): string {
  const team = extractTeam(outcome);
  if (team.toLowerCase() === home.toLowerCase()) return away;
  if (team.toLowerCase() === away.toLowerCase()) return home;
  return team;
}

export default function WorldCup() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getWorldCupMatches()
      .then((data) => { if (!cancelled) { setMatches(data); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err instanceof Error ? err.message : "Failed"); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const display = showAll ? matches : matches.slice(0, 12);

  return (
    <div className="min-h-dvh page-bg font-['Inter',system-ui,sans-serif]">
      <nav className="border-b border-gray-200 bg-white/90 dark:border-gray-800 dark:bg-gray-950/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2">
            <span className="rounded-lg bg-green-600 p-2 text-white font-bold text-lg">WC</span>
            <span className="text-xl font-bold tracking-tight">Everyone's A Winner</span>
          </Link>
          <Link to="/" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">← Back to Home</Link>
        </div>
      </nav>

      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="flex items-center gap-3 mb-6">
          <span className="text-3xl">🏆</span>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">World Cup 2026</h1>
            <p className="text-gray-600 dark:text-gray-400">Live odds for every World Cup match.</p>
            <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">Live odds refreshed daily. Tap refresh to update.</p>
          </div>
        </div>

        {loading && (
          <div className="flex flex-col items-center justify-center gap-4 py-16">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-green-600 border-t-transparent" />
            <p className="text-sm text-gray-500">Loading World Cup odds...</p>
          </div>
        )}

        {error && !loading && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-900 dark:bg-red-950">
            <p className="text-red-700 dark:text-red-400 font-medium">Couldn't load World Cup odds</p>
            <p className="mt-1 text-sm text-red-500">{error}</p>
            <button onClick={() => { setLoading(true); setError(null); getWorldCupMatches().then((d) => setMatches(d)).catch((e) => setError(e instanceof Error ? e.message : "Failed")).finally(() => setLoading(false)); }}
              className="mt-4 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700">Retry</button>
          </div>
        )}

        {!loading && !error && matches.length === 0 && (
          <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-500 dark:border-gray-800 dark:bg-gray-950">No World Cup matches available right now. Check back closer to kick-off.</div>
        )}

        {!loading && !error && matches.length > 0 && (
          <>
            <div className="grid grid-cols-1 gap-4">
              {display.map((m) => {
                const team = extractTeam(m.best.outcome);
                const vs = vsTeam(m.best.outcome, m.home, m.away);
                const backReturn = STAKE * m.best.backOdds;
                const layReturn = STAKE * m.best.layOdds;
                const minReturn = Math.min(backReturn, layReturn);
                const totalStake = STAKE * 2;
                return (
                  <div key={m.matchId}
                    className="rounded-xl border-2 border-gray-200 dark:border-gray-800 p-5 bg-white dark:bg-gray-950 shadow-sm transition-shadow hover:shadow-md"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-lg">🏆</span>
                        <span className="font-bold text-lg">{m.home} vs {m.away}</span>
                      </div>
                      <span className="text-xs text-gray-400">{m.time}</span>
                    </div>

                    <div className="mt-4 space-y-2">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-lg">⬆️</span>
                        <span><strong>{team}</strong> at <strong>{m.best.bookmaker}</strong> ({formatOdds(m.best.backOdds)})</span>
                        <span className="font-medium text-indigo-700 dark:text-indigo-400">— £{STAKE} returns <strong>£{backReturn.toFixed(2)}</strong></span>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-lg">⬇️</span>
                        <span><strong>{vs}</strong> at <strong>{m.best.exchange}</strong> ({formatOdds(m.best.layOdds)})</span>
                        <span className="font-medium text-indigo-700 dark:text-indigo-400">— £{STAKE} returns <strong>£{layReturn.toFixed(2)}</strong></span>
                      </div>
                    </div>

                    <div className="mt-4 flex items-center gap-2">
                      <span className="text-lg">💰</span>
                      <span className="font-medium text-green-700 dark:text-green-400 text-sm">
                        Bet on both: <strong>minimum return £{minReturn.toFixed(2)}</strong> from £{totalStake.toFixed(2)} stake
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {matches.length > 12 && !showAll && (
              <div className="mt-6 text-center">
                <button onClick={() => setShowAll(true)}
                  className="rounded-lg border border-gray-300 px-6 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900">
                  Show all {matches.length} matches →
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}