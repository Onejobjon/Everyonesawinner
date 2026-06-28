import { Link } from "react-router-dom";

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

const bookies = ["Bet365", "William Hill", "Paddy Power", "Sky Bet", "Betfred", "Betfair"];

function genOdds() { return (Math.random() * 4 + 1.5).toFixed(2); }
function genLayOdds(back: number) { return (Number(back) + (Math.random() * 0.3 + 0.05)).toFixed(2); }

const matches = teams.flatMap((group, gi) => {
  const games: any[] = [];
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const home = group[i], away = group[j];
      const odds = bookies.map(() => ({ back: genOdds(), lay: genLayOdds(Number(genOdds())) }));
      const bestBack = Math.max(...odds.map(o => Number(o.back)));
      const bestLay = Math.min(...odds.map(o => Number(o.lay)));
      const profitPct = bestBack > bestLay ? ((bestBack / bestLay - 1) * 100).toFixed(2) : null;
      games.push({ home, away, odds, bestBack, bestLay, profitPct, time: `${Math.floor(Math.random() * 24).toString().padStart(2,'0')}:${Math.floor(Math.random() * 60).toString().padStart(2,'0')}` });
    }
  }
  return games.slice(0, 2);
}).slice(0, 24);

export default function WorldCup() {
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

      <div className="mx-auto max-w-7xl px-6 py-8">
        <div className="flex items-center gap-3 mb-6">
          <span className="text-3xl">🏆</span>
          <div><h1 className="text-3xl font-bold tracking-tight">World Cup 2026</h1><p className="text-gray-600 dark:text-gray-400">Live odds and arbitrage opportunities</p></div>
        </div>

        <div className="grid grid-cols-1 gap-4">
          {matches.map((m, i) => (
            <div key={i} className={`rounded-xl border-2 p-5 bg-white dark:bg-gray-950 shadow-sm ${m.profitPct ? 'border-green-500' : 'border-gray-200 dark:border-gray-800'}`}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-semibold text-gray-500">{m.home} vs {m.away}</span>
                <span className="text-xs text-gray-400">{m.time}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-gray-500"><th className="text-left pb-1">Bookmaker</th><th className="pb-1">Back</th><th className="pb-1">Lay</th></tr></thead>
                  <tbody>{m.odds.map((o: any, j: number) => (
                    <tr key={j} className="border-t border-gray-100 dark:border-gray-800">
                      <td className="py-1.5 text-gray-700 dark:text-gray-300">{bookies[j]}</td>
                      <td className="py-1.5 text-center font-mono">{o.back}</td>
                      <td className="py-1.5 text-center font-mono">{o.lay}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              {m.profitPct && (
                <div className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950/30 dark:text-green-300">
                  ⚡ Arbitrage opportunity: <strong>{m.profitPct}%</strong> profit
                </div>
              )}
              <Link to="/calculator" className="mt-3 inline-block text-xs font-medium text-indigo-600 hover:text-indigo-700">Use Calculator →</Link>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}