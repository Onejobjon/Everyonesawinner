import { useState } from "react";
import { Link } from "react-router-dom";
import { formatOdds } from "../lib/odds";

const teams = [
  ["Brazil", "Argentina", "France", "England"],
  ["Spain", "Portugal", "Netherlands", "Germany"],
  ["Italy", "Belgium", "Croatia", "Uruguay"],
  ["Senegal", "Morocco", "Japan", "South Korea"],
  ["USA", "Mexico", "Nigeria", "Cameroon"],
  ["Australia", "Switzerland", "Denmark", "Poland"],
  ["Serbia", "Ghana", "Ecuador", "Saudi Arabia"],
  ["Iran", "Tunisia", "Costa Rica", "Wales"],
];

const bookmakers = ["Bet365", "William Hill", "Paddy Power", "Sky Bet", "Betfred"];
const exchanges = ["Betfair", "Smarkets", "Matchbook"];

function rand(min: number, max: number) {
  return Math.round((min + Math.random() * (max - min)) * 100) / 100;
}

type Match = {
  home: string;
  away: string;
  time: string;
  best: {
    outcome: string;
    bookmaker: string;
    backOdds: number;
    exchange: string;
    layOdds: number;
    profitPct: number | null;
  };
};

function generateMatches(): Match[] {
  const results: Match[] = [];
  for (const group of teams) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const home = group[i], away = group[j];
        const backOdds = rand(1.5, 6.0);
        const layOdds = backOdds + rand(0.03, 0.25);
        const profitPct = backOdds > layOdds * 1.02
          ? Math.round(((backOdds / (layOdds * 1.02) - 1) * 100) * 10) / 10
          : null;
        results.push({
          home, away,
          time: `${String(rand(10, 22)).padStart(2, "0")}:${String(rand(0, 59)).padStart(2, "0")}`,
          best: {
            outcome: `${home} to win`,
            bookmaker: bookmakers[Math.floor(Math.random() * bookmakers.length)],
            backOdds,
            exchange: exchanges[Math.floor(Math.random() * exchanges.length)],
            layOdds,
            profitPct,
          },
        });
      }
    }
  }
  return results.sort(() => Math.random() - 0.5).slice(0, 32);
}

const allMatches = generateMatches();

export default function WorldCup() {
  const [showAll, setShowAll] = useState(false);
  const display = showAll ? allMatches : allMatches.slice(0, 12);

  return (
    <div className="min-h-dvh bg-gray-50 dark:bg-gray-950 font-['Inter',system-ui,sans-serif]">
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
            <p className="text-gray-600 dark:text-gray-400">Pick a match, back a team at the best price, then cover your bet on the exchange. Simple.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4">
          {display.map((m, i) => {
            const hasProfit = m.best.profitPct !== null;
            return (
              <div key={i} className={`rounded-xl border-2 p-5 bg-white dark:bg-gray-950 shadow-sm transition-shadow hover:shadow-md ${
                hasProfit && m.best.profitPct! > 1 ? 'border-green-500' : 'border-gray-200 dark:border-gray-800'
              }`}>
                {/* Match title */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">🏆</span>
                    <span className="font-bold text-lg">{m.home} vs {m.away}</span>
                  </div>
                  <span className="text-xs text-gray-400">{m.time}</span>
                </div>

                {/* Back bet — plain English */}
                <div className="mt-4 flex items-center gap-2 text-sm">
                  <span className="text-lg">⬆️</span>
                  <span className="font-medium">Bet on <strong>{m.best.outcome}</strong> at <strong>{m.best.bookmaker}</strong></span>
                  <span className="font-mono font-bold text-base">({formatOdds(m.best.backOdds)})</span>
                </div>

                {/* Lay bet — plain English */}
                <div className="mt-2 flex items-center gap-2 text-sm">
                  <span className="text-lg">⬇️</span>
                  <span className="font-medium">Cover it at <strong>{m.best.exchange}</strong> by betting <strong>against {m.home}</strong></span>
                  <span className="font-mono font-bold text-base">({formatOdds(m.best.layOdds)})</span>
                </div>

                {/* Result */}
                <div className="mt-4 flex items-center justify-between">
                  {hasProfit ? (
                    <div className="flex items-center gap-2">
                      <span className="text-lg">💰</span>
                      <span className="text-green-700 dark:text-green-400 font-bold">
                        {m.best.profitPct!.toFixed(1)}% profit — whichever team wins
                      </span>
                    </div>
                  ) : (
                    <span className="text-sm text-gray-400">No immediate profit — but still worth covering for the free bet</span>
                  )}
                  <Link to="/calculator" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">
                    Calculate →
                  </Link>
                </div>
              </div>
            );
          })}
        </div>

        {allMatches.length > 12 && !showAll && (
          <div className="mt-6 text-center">
            <button onClick={() => setShowAll(true)}
              className="rounded-lg border border-gray-300 px-6 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900">
              Show all {allMatches.length} matches →
            </button>
          </div>
        )}

        <div className="mt-10 rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
          <h2 className="text-lg font-semibold mb-3">How to use this page</h2>
          <ol className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
            <li className="flex gap-2"><span className="font-bold text-indigo-600">1.</span> Find a match with a 💰 profit badge — those are your best opportunities</li>
            <li className="flex gap-2"><span className="font-bold text-indigo-600">2.</span> ⬆️ Place the first bet at the bookmaker (you want them to win)</li>
            <li className="flex gap-2"><span className="font-bold text-indigo-600">3.</span> ⬇️ Place the second bet on the exchange (you want them to <em>not</em> win)</li>
            <li className="flex gap-2"><span className="font-bold text-indigo-600">4.</span> One bet wins, one loses — but you come out ahead either way</li>
          </ol>
        </div>
      </div>
    </div>
  );
}