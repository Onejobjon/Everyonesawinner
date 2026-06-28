import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { formatOdds } from "../lib/odds";
import { getMatches, type Match } from "../lib/odds-api";

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

  // Derive unique league keys from the data for filter buttons
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
            <span className="rounded-lg bg-indigo-600 p-2 text-white font-bold text-lg">
              EAW
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
        <h1 className="text-3xl font-bold tracking-tight">
          Best Odds Finder
        </h1>
        <p className="mt-2 text-gray-600 dark:text-gray-400">
          Live odds from top UK bookmakers. Pick a match, back the best price,
          then cover yourself on the exchange.
        </p>

        <div className="mt-6 flex flex-wrap gap-2">
          {filterOptions.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                filter === f
                  ? "bg-indigo-600 text-white"
                  : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-300"
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Loading state */}
        {loading && (
          <div className="mt-12 flex flex-col items-center justify-center gap-4">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
            <p className="text-sm text-gray-500">Loading live odds...</p>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="mt-8 rounded-xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-900 dark:bg-red-950">
            <p className="text-red-700 dark:text-red-400 font-medium">
              Couldn't load odds
            </p>
            <p className="mt-1 text-sm text-red-500">{error}</p>
            <button
              onClick={() => {
                setLoading(true);
                setError(null);
                getMatches()
                  .then((data) => setMatches(data))
                  .catch((e) =>
                    setError(
                      e instanceof Error ? e.message : "Failed to load odds"
                    )
                  )
                  .finally(() => setLoading(false));
              }}
              className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && filtered.length === 0 && (
          <div className="mt-8 rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-500 dark:border-gray-800 dark:bg-gray-950">
            No matches found for this league. Try a different filter.
          </div>
        )}

        {/* Match cards */}
        {!loading && !error && (
          <div className="mt-6 grid grid-cols-1 gap-4">
            {filtered.map((m) => {
              const { best } = m;
              const hasProfit = best.profitPct !== null;
              return (
                <div
                  key={m.matchId}
                  className={`rounded-xl border-2 p-5 bg-white dark:bg-gray-950 shadow-sm transition-shadow hover:shadow-md ${
                    hasProfit && best.profitPct! > 1
                      ? "border-green-500"
                      : "border-gray-200 dark:border-gray-800"
                  }`}
                >
                  {/* Match title */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {m.leagueKey === "World Cup" && (
                        <span className="text-lg">🏆</span>
                      )}
                      <span className="font-bold text-lg">
                        {m.home} vs {m.away}
                      </span>
                      <span className="text-xs text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">
                        {m.league}
                      </span>
                    </div>
                    <span className="text-xs text-gray-400">{m.time}</span>
                  </div>

                  {/* Back bet — plain English */}
                  <div className="mt-4 flex items-center gap-2 text-sm">
                    <span className="text-lg">⬆️</span>
                    <span className="font-medium">
                      Place a bet on <strong>{best.outcome}</strong> at{" "}
                      <strong>{best.bookmaker}</strong>
                    </span>
                    <span className="font-mono font-bold text-base">
                      ({formatOdds(best.backOdds)})
                    </span>
                  </div>

                  {/* Lay bet — plain English */}
                  <div className="mt-2 flex items-center gap-2 text-sm">
                    <span className="text-lg">⬇️</span>
                    <span className="font-medium">
                      Cover yourself at <strong>{best.exchange}</strong> by
                      betting <strong>against</strong> this outcome
                    </span>
                    <span className="font-mono font-bold text-base">
                      ({formatOdds(best.layOdds)})
                    </span>
                  </div>

                  {/* Result */}
                  <div className="mt-4 flex items-center justify-between">
                    {hasProfit ? (
                      <div className="flex items-center gap-2">
                        <span className="text-lg">💰</span>
                        <span className="text-green-700 dark:text-green-400 font-bold">
                          You'll make a {best.profitPct!.toFixed(1)}% profit
                          either way
                        </span>
                      </div>
                    ) : (
                      <span className="text-sm text-gray-400">
                        Standard odds — no immediate profit opportunity
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
        )}
      </div>
    </div>
  );
}