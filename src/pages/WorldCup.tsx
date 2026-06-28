import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { formatOdds } from "../lib/odds";
import { getWorldCupMatches, type Match } from "../lib/odds-api";

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

  const display = showAll ? matches : matches.slice(0, 12);

  return (
    <div className="min-h-dvh bg-gray-50 dark:bg-gray-950 font-['Inter',system-ui,sans-serif]">
      <nav className="border-b border-gray-200 bg-white/90 dark:border-gray-800 dark:bg-gray-950/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2">
            <span className="rounded-lg bg-green-600 p-2 text-white font-bold text-lg">
              WC
            </span>
            <span className="text-xl font-bold tracking-tight">
              Everyone's A Winner
            </span>
          </Link>
          <Link
            to="/"
            className="text-sm font-medium text-indigo-600 hover:text-indigo-700"
          >
            ← Back to Home
          </Link>
        </div>
      </nav>

      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="flex items-center gap-3 mb-6">
          <span className="text-3xl">🏆</span>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              World Cup 2026
            </h1>
            <p className="text-gray-600 dark:text-gray-400">
              Live odds for every World Cup match. Pick a match, back a team at
              the best price, then cover your bet on the exchange.
            </p>
          </div>
        </div>

        {/* Loading state */}
        {loading && (
          <div className="flex flex-col items-center justify-center gap-4 py-16">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-green-600 border-t-transparent" />
            <p className="text-sm text-gray-500">
              Loading World Cup odds...
            </p>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-900 dark:bg-red-950">
            <p className="text-red-700 dark:text-red-400 font-medium">
              Couldn't load World Cup odds
            </p>
            <p className="mt-1 text-sm text-red-500">{error}</p>
            <button
              onClick={() => {
                setLoading(true);
                setError(null);
                getWorldCupMatches()
                  .then((data) => setMatches(data))
                  .catch((e) =>
                    setError(
                      e instanceof Error ? e.message : "Failed to load odds"
                    )
                  )
                  .finally(() => setLoading(false));
              }}
              className="mt-4 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && matches.length === 0 && (
          <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-500 dark:border-gray-800 dark:bg-gray-950">
            No World Cup matches available right now. Check back closer to
            kick-off.
          </div>
        )}

        {/* Match cards */}
        {!loading && !error && matches.length > 0 && (
          <>
            <div className="grid grid-cols-1 gap-4">
              {display.map((m) => {
                const hasProfit = m.best.profitPct !== null;
                return (
                  <div
                    key={m.matchId}
                    className={`rounded-xl border-2 p-5 bg-white dark:bg-gray-950 shadow-sm transition-shadow hover:shadow-md ${
                      hasProfit && m.best.profitPct! > 1
                        ? "border-green-500"
                        : "border-gray-200 dark:border-gray-800"
                    }`}
                  >
                    {/* Match title */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-lg">🏆</span>
                        <span className="font-bold text-lg">
                          {m.home} vs {m.away}
                        </span>
                      </div>
                      <span className="text-xs text-gray-400">{m.time}</span>
                    </div>

                    {/* Back bet — plain English */}
                    <div className="mt-4 flex items-center gap-2 text-sm">
                      <span className="text-lg">⬆️</span>
                      <span className="font-medium">
                        Bet on <strong>{m.best.outcome}</strong> at{" "}
                        <strong>{m.best.bookmaker}</strong>
                      </span>
                      <span className="font-mono font-bold text-base">
                        ({formatOdds(m.best.backOdds)})
                      </span>
                    </div>

                    {/* Lay bet — plain English */}
                    <div className="mt-2 flex items-center gap-2 text-sm">
                      <span className="text-lg">⬇️</span>
                      <span className="font-medium">
                        Cover it at <strong>{m.best.exchange}</strong> by
                        betting <strong>against {m.home}</strong>
                      </span>
                      <span className="font-mono font-bold text-base">
                        ({formatOdds(m.best.layOdds)})
                      </span>
                    </div>

                    {/* Result */}
                    <div className="mt-4 flex items-center justify-between">
                      {hasProfit ? (
                        <div className="flex items-center gap-2">
                          <span className="text-lg">💰</span>
                          <span className="text-green-700 dark:text-green-400 font-bold">
                            {m.best.profitPct!.toFixed(1)}% profit — whichever
                            team wins
                          </span>
                        </div>
                      ) : (
                        <span className="text-sm text-gray-400">
                          No immediate profit — but still worth covering for the
                          free bet
                        </span>
                      )}
                      <Link
                        to="/calculator"
                        className="text-sm font-medium text-indigo-600 hover:text-indigo-700"
                      >
                        Calculate →
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>

            {matches.length > 12 && !showAll && (
              <div className="mt-6 text-center">
                <button
                  onClick={() => setShowAll(true)}
                  className="rounded-lg border border-gray-300 px-6 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
                >
                  Show all {matches.length} matches →
                </button>
              </div>
            )}
          </>
        )}

        {/* How-to guide */}
        <div className="mt-10 rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
          <h2 className="text-lg font-semibold mb-3">
            How to use this page
          </h2>
          <ol className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
            <li className="flex gap-2">
              <span className="font-bold text-indigo-600">1.</span> Find a
              match with a 💰 profit badge — those are your best opportunities
            </li>
            <li className="flex gap-2">
              <span className="font-bold text-indigo-600">2.</span> ⬆️ Place
              the first bet at the bookmaker (you want them to win)
            </li>
            <li className="flex gap-2">
              <span className="font-bold text-indigo-600">3.</span> ⬇️ Place
              the second bet on the exchange (you want them to{" "}
              <em>not</em> win)
            </li>
            <li className="flex gap-2">
              <span className="font-bold text-indigo-600">4.</span> One bet
              wins, one loses — but you come out ahead either way
            </li>
          </ol>
        </div>
      </div>
    </div>
  );
}