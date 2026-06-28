import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { fetchMatches, formatTime, calculateProfit } from "../lib/odds";
import type { Match } from "../lib/odds";

const getMatches = createServerFn({ method: "GET" }).handler(async () => {
  const data = await fetchMatches(true, true);
  return {
    all: [...data.worldCup, ...data.league].sort(
      (a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime()
    ),
    worldCup: data.worldCup,
    league: data.league,
  };
});

export const Route = createFileRoute("/oddsmatcher")({
  component: Oddsmatcher,
});

function Oddsmatcher() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "worldcup" | "league">("all");
  const [sortBy, setSortBy] = useState<"time" | "profit">("time");

  useState(() => {
    getMatches().then((data) => {
      setMatches(data.all);
      setLoading(false);
    });
  });

  const filtered = matches.filter((m) => {
    if (filter === "worldcup") return m.isWorldCup;
    if (filter === "league") return !m.isWorldCup;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "profit") {
      const aP = a.bestArbitrage?.profitPercent ?? -999;
      const bP = b.bestArbitrage?.profitPercent ?? -999;
      return bP - aP; // highest first
    }
    return new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime();
  });

  return (
    <div className="min-h-dvh bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <nav className="border-b border-gray-200 bg-white/90 backdrop-blur-md dark:border-gray-800 dark:bg-gray-950/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2">
            <span className="rounded-lg bg-indigo-600 p-2 text-white font-bold text-lg">MP</span>
            <span className="text-xl font-bold tracking-tight">MatchProfit</span>
          </Link>
          <div className="flex items-center gap-6">
            <Link href="/world-cup" className="text-sm font-medium text-green-600 hover:text-green-700 font-semibold">World Cup</Link>
            <Link href="/calculator" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100">Calculator</Link>
            <Link href="/login" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100">Log in</Link>
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-6 py-12">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Oddsmatcher</h1>
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              Compare odds across bookmakers and exchanges. Find profitable arbitrage opportunities.
            </p>
          </div>
          <div className="flex gap-2">
            {(["all", "worldcup", "league"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  filter === f
                    ? "bg-indigo-600 text-white"
                    : "border border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-900"
                }`}
              >
                {f === "all" ? "All" : f === "worldcup" ? "World Cup" : "League"}
              </button>
            ))}
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as "time" | "profit")}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
            >
              <option value="time">Sort by time</option>
              <option value="profit">Sort by profit</option>
            </select>
          </div>
        </div>

        {loading ? (
          <div className="mt-12 text-center">
            <div className="animate-pulse text-gray-400">Loading matches...</div>
          </div>
        ) : (
          <div className="mt-8 space-y-3">
            {sorted.map((match) => (
              <MatchCard key={match.id} match={match} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MatchCard({ match }: { match: Match }) {
  const arb = match.bestArbitrage;

  return (
    <div className={`rounded-2xl border-2 p-5 shadow-sm transition-shadow hover:shadow-md ${
      arb?.isProfitable
        ? "border-green-300 bg-green-50/50 dark:border-green-800 dark:bg-green-950/20"
        : match.isWorldCup
        ? "border-amber-200 bg-amber-50/30 dark:border-amber-800 dark:bg-amber-950/10"
        : "border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950"
    }`}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            {match.isWorldCup && (
              <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-700 dark:bg-green-900/50 dark:text-green-400">
                🏆 World Cup
              </span>
            )}
            <span className="text-xs text-gray-500">{formatTime(match.commenceTime)}</span>
          </div>
          <h3 className="mt-1 text-lg font-semibold">
            {match.homeTeam} vs {match.awayTeam}
          </h3>
          <p className="text-sm text-gray-500">{match.league}</p>
        </div>

        <div className="flex items-center gap-4">
          {arb ? (
            <div className="text-right">
              <p className="text-sm text-gray-500">Best arb: {arb.outcomeName}</p>
              <p className="text-lg font-bold">
                <span className={arb.isProfitable ? "text-green-600" : "text-amber-600"}>
                  {arb.profitPercent > 0 ? "+" : ""}{arb.profitPercent}%
                </span>
              </p>
              <p className="text-xs text-gray-500">
                Back: {arb.backBookmaker} &middot; Lay: {arb.layExchange}
              </p>
            </div>
          ) : (
            <span className="text-sm text-gray-400">No arb data</span>
          )}
        </div>
      </div>

      {/* Outcome odds */}
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-2">
        {match.outcomes.slice(0, 3).map((outcome) => {
          const bestBack = outcome.backOdds.reduce((a, b) => (a.odds > b.odds ? a : b));
          return (
            <div key={outcome.name} className="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
              <p className="text-xs font-medium text-gray-500 truncate">{outcome.name}</p>
              <div className="mt-1 flex justify-between items-center">
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {bestBack.odds.toFixed(2)}
                </span>
                <span className="text-xs text-gray-500">{bestBack.bookmaker}</span>
              </div>
              {outcome.layOdds && (
                <div className="mt-0.5 flex justify-between items-center">
                  <span className="text-sm text-gray-600 dark:text-gray-400">
                    {outcome.layOdds.odds.toFixed(2)}
                  </span>
                  <span className="text-xs text-gray-500">{outcome.layOdds.exchange}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}