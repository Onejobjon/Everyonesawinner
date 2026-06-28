import { useState } from "react";
import { Link } from "react-router-dom";

const matches = [
  { home: "Liverpool", away: "Arsenal", league: "Premier League", time: "15:00", odds: { back: 2.10, lay: 2.14 }, profit: 1.2 },
  { home: "Man City", away: "Chelsea", league: "Premier League", time: "17:30", odds: { back: 1.80, lay: 1.83 }, profit: 0.8 },
  { home: "Real Madrid", away: "Barcelona", league: "La Liga", time: "20:00", odds: { back: 2.50, lay: 2.55 }, profit: null },
  { home: "Bayern Munich", away: "Dortmund", league: "Bundesliga", time: "14:30", odds: { back: 1.65, lay: 1.68 }, profit: 1.5 },
  { home: "PSG", away: "Marseille", league: "Ligue 1", time: "20:45", odds: { back: 1.90, lay: 1.93 }, profit: 0.5 },
  { home: "Juventus", away: "Milan", league: "Serie A", time: "19:45", odds: { back: 2.30, lay: 2.34 }, profit: null },
  { home: "Brazil", away: "Argentina", league: "World Cup", time: "21:00", odds: { back: 2.80, lay: 2.85 }, profit: 2.1 },
  { home: "France", away: "England", league: "World Cup", time: "16:00", odds: { back: 2.20, lay: 2.24 }, profit: 1.8 },
  { home: "Germany", away: "Spain", league: "World Cup", time: "18:00", odds: { back: 2.40, lay: 2.45 }, profit: null },
  { home: "Portugal", away: "Netherlands", league: "World Cup", time: "20:00", odds: { back: 2.15, lay: 2.19 }, profit: 0.9 },
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
        <h1 className="text-3xl font-bold tracking-tight">Oddsmatcher</h1>
        <p className="mt-2 text-gray-600 dark:text-gray-400">Compare back and lay odds across bookmakers and exchanges.</p>

        <div className="mt-6 flex gap-2">
          {["All", "Premier League", "La Liga", "Bundesliga", "World Cup"].map(f => (
            <button key={f} onClick={() => setFilter(f)} className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${filter === f ? "bg-indigo-600 text-white" : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-300"}`}>{f}</button>
          ))}
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4">
          {filtered.map((m, i) => (
            <div key={i} className={`rounded-xl border-2 p-5 bg-white dark:bg-gray-950 shadow-sm ${m.profit ? 'border-green-500' : 'border-gray-200 dark:border-gray-800'} ${m.league === "World Cup" ? 'border-amber-400' : ''}`}>
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-semibold">{m.home} vs {m.away}</span>
                  <span className="ml-3 text-xs text-gray-500">{m.league}</span>
                </div>
                <span className="text-xs text-gray-400">{m.time}</span>
              </div>
              <div className="mt-3 flex items-center gap-6 text-sm">
                <div><span className="text-gray-500">Back:</span> <span className="font-mono font-semibold">{m.odds.back.toFixed(2)}</span></div>
                <div><span className="text-gray-500">Lay:</span> <span className="font-mono font-semibold">{m.odds.lay.toFixed(2)}</span></div>
                {m.profit ? (
                  <div className="ml-auto rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700 dark:bg-green-950/30 dark:text-green-300">{m.profit.toFixed(1)}% profit</div>
                ) : (
                  <div className="ml-auto rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-500 dark:bg-gray-800">No arb</div>
                )}
              </div>
              <Link to="/calculator" className="mt-3 inline-block text-xs font-medium text-indigo-600 hover:text-indigo-700">Calculate profit →</Link>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}