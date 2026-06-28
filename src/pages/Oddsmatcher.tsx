import { useState } from "react";
import { Link } from "react-router-dom";
import { formatOdds } from "../lib/odds";

interface Match {
  home: string;
  away: string;
  league: string;
  time: string;
  best: { outcome: string; bookmaker: string; backOdds: number; exchange: string; layOdds: number; profitPct: number | null };
}

const matches: Match[] = [
  { home: "Liverpool", away: "Arsenal", league: "Premier League", time: "15:00", best: { outcome: "Arsenal to win", bookmaker: "Bet365", backOdds: 2.10, exchange: "Betfair", layOdds: 2.14, profitPct: 1.2 } },
  { home: "Man City", away: "Chelsea", league: "Premier League", time: "17:30", best: { outcome: "Man City to win", bookmaker: "William Hill", backOdds: 1.80, exchange: "Betfair", layOdds: 1.83, profitPct: 0.8 } },
  { home: "Real Madrid", away: "Barcelona", league: "La Liga", time: "20:00", best: { outcome: "Barcelona to win", bookmaker: "Paddy Power", backOdds: 2.50, exchange: "Smarkets", layOdds: 2.55, profitPct: null } },
  { home: "Bayern Munich", away: "Dortmund", league: "Bundesliga", time: "14:30", best: { outcome: "Bayern to win", bookmaker: "Bet365", backOdds: 1.65, exchange: "Betfair", layOdds: 1.68, profitPct: 1.5 } },
  { home: "PSG", away: "Marseille", league: "Ligue 1", time: "20:45", best: { outcome: "PSG to win", bookmaker: "Sky Bet", backOdds: 1.90, exchange: "Smarkets", layOdds: 1.93, profitPct: 0.5 } },
  { home: "Juventus", away: "Milan", league: "Serie A", time: "19:45", best: { outcome: "Juventus to win", bookmaker: "William Hill", backOdds: 2.30, exchange: "Betfair", layOdds: 2.34, profitPct: null } },
  { home: "Brazil", away: "Argentina", league: "World Cup", time: "21:00", best: { outcome: "Brazil to win", bookmaker: "Bet365", backOdds: 2.80, exchange: "Betfair", layOdds: 2.85, profitPct: 2.1 } },
  { home: "France", away: "England", league: "World Cup", time: "16:00", best: { outcome: "France to win", bookmaker: "Paddy Power", backOdds: 2.20, exchange: "Smarkets", layOdds: 2.24, profitPct: 1.8 } },
  { home: "Germany", away: "Spain", league: "World Cup", time: "18:00", best: { outcome: "Germany to win", bookmaker: "Sky Bet", backOdds: 2.40, exchange: "Betfair", layOdds: 2.45, profitPct: null } },
  { home: "Portugal", away: "Netherlands", league: "World Cup", time: "20:00", best: { outcome: "Portugal to win", bookmaker: "Bet365", backOdds: 2.15, exchange: "Betfair", layOdds: 2.19, profitPct: 0.9 } },
];

export default function Oddsmatcher() {
  const [filter, setFilter] = useState("All");
  const filtered = filter === "All" ? matches : matches.filter(m => m.league === filter);

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
        <p className="mt-2 text-gray-600 dark:text-gray-400">See which bets pay the most — pick a match, choose the best bookmaker price, then cover yourself on the exchange.</p>

        <div className="mt-6 flex flex-wrap gap-2">
          {["All", "Premier League", "La Liga", "Bundesliga", "World Cup"].map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                filter === f ? "bg-indigo-600 text-white" : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-300"
              }`}>{f}</button>
          ))}
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4">
          {filtered.length === 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-500 dark:border-gray-800 dark:bg-gray-950">
              No matches found for this league. Try a different filter.
            </div>
          )}
          {filtered.map((m, i) => {
            const { best } = m;
            const hasProfit = best.profitPct !== null;
            return (
              <div key={i} className={`rounded-xl border-2 p-5 bg-white dark:bg-gray-950 shadow-sm transition-shadow hover:shadow-md ${
                hasProfit && best.profitPct! > 1 ? 'border-green-500' : 'border-gray-200 dark:border-gray-800'
              }`}>
                {/* Match title */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {m.league === "World Cup" && <span className="text-lg">🏆</span>}
                    <span className="font-bold text-lg">{m.home} vs {m.away}</span>
                    <span className="text-xs text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">{m.league}</span>
                  </div>
                  <span className="text-xs text-gray-400">{m.time}</span>
                </div>

                {/* Plain English: the "bet on" side */}
                <div className="mt-4 flex items-center gap-2 text-sm">
                  <span className="text-lg">⬆️</span>
                  <span className="font-medium">Place a bet on <strong>{best.outcome}</strong> at <strong>{best.bookmaker}</strong></span>
                  <span className="font-mono font-bold text-base">({formatOdds(best.backOdds)})</span>
                </div>

                {/* Plain English: the "cover" side */}
                <div className="mt-2 flex items-center gap-2 text-sm">
                  <span className="text-lg">⬇️</span>
                  <span className="font-medium">Cover yourself at <strong>{best.exchange}</strong> by betting <strong>against</strong> this outcome</span>
                  <span className="font-mono font-bold text-base">({formatOdds(best.layOdds)})</span>
                </div>

                {/* Result */}
                <div className="mt-4 flex items-center justify-between">
                  {hasProfit ? (
                    <div className="flex items-center gap-2">
                      <span className="text-lg">💰</span>
                      <span className="text-green-700 dark:text-green-400 font-bold">
                        You'll make a {best.profitPct!.toFixed(1)}% profit either way
                      </span>
                    </div>
                  ) : (
                    <span className="text-sm text-gray-400">Standard odds — no immediate profit opportunity</span>
                  )}
                  <Link to="/calculator" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">
                    Calculate →
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}