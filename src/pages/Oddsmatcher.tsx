import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { matchLayMetrics } from "../lib/odds";
import { getMatches, type Match } from "../lib/odds-api";
import FreeBetsOffers from "../components/FreeBetsOffers";
import MatchCard from "../components/MatchCard";
import Paywall from "../components/Paywall";

const BACK_STAKE = 20;

type SortKey = "kickoff" | "closest" | "profit";

export default function Oddsmatcher() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("All");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("kickoff");

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

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = matches.filter((m) => {
      if (filter !== "All" && m.leagueKey !== filter) return false;
      if (!q) return true;
      return (
        m.home.toLowerCase().includes(q) ||
        m.away.toLowerCase().includes(q) ||
        m.league.toLowerCase().includes(q) ||
        m.leagueKey.toLowerCase().includes(q)
      );
    });

    list = [...list].sort((a, b) => {
      if (sort === "kickoff") {
        return a.commenceTime.localeCompare(b.commenceTime);
      }
      const am = matchLayMetrics(a.outcomes, BACK_STAKE);
      const bm = matchLayMetrics(b.outcomes, BACK_STAKE);
      if (sort === "closest") {
        return am.closestLoss - bm.closestLoss;
      }
      return bm.bestProfit - am.bestProfit;
    });

    return list;
  }, [matches, filter, query, sort]);

  return (
    <Paywall title="the odds finder">
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
          <h1 className="text-3xl font-bold tracking-tight">Matched Betting Finder</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            Back an outcome at the bookmaker, lay the same outcome on the exchange — and lock in the result. Odds updated daily.
          </p>

          {/* Search + sort */}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search team or league…"
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
            />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
            >
              <option value="kickoff">Sort: Kick-off time</option>
              <option value="closest">Sort: Closest match</option>
              <option value="profit">Sort: Best profit</option>
            </select>
          </div>

          {/* League filter */}
          <div className="mt-4 flex flex-wrap gap-2">
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

          {!loading && !error && visible.length === 0 && (
            <div className="mt-8 rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-500 dark:border-gray-800 dark:bg-gray-950">No matches found. Try a different search or filter.</div>
          )}

          {!loading && !error && visible.length > 0 && (
            <>
              <div className="mt-6 mb-6">
                <FreeBetsOffers />
              </div>
              <div className="mt-6 grid grid-cols-1 gap-4">
                {visible.map((m) => (
                  <MatchCard key={m.matchId} match={m} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </Paywall>
  );
}
