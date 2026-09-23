import { calcLay, formatOdds, matchLayMetrics } from "../lib/odds";
import type { Match } from "../lib/odds-api";

const BACK_STAKE = 20;

function getIcon(name: string, home: string, away: string): string {
  const lower = name.toLowerCase();
  if (lower === home.toLowerCase()) return "⬆️";
  if (lower === away.toLowerCase()) return "⬇️";
  return "➡️";
}

function money(n: number): string {
  return `£${n.toFixed(2)}`;
}

export default function MatchCard({ match }: { match: Match }) {
  const metrics = matchLayMetrics(match.outcomes, BACK_STAKE);
  // A positive best profit means at least one outcome is a value lay.
  const hasValue = metrics.hasLay && metrics.bestProfit > 0;

  return (
    <div
      className={`rounded-xl border-2 p-5 bg-white dark:bg-gray-950 shadow-sm transition-shadow hover:shadow-md ${
        hasValue ? "border-green-500" : "border-gray-200 dark:border-gray-800"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {match.leagueKey === "World Cup" && <span className="text-lg">🏆</span>}
          <span className="font-bold text-lg">
            {match.home} vs {match.away}
          </span>
          <span className="text-xs text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">
            {match.league}
          </span>
        </div>
        <span className="text-xs text-gray-400">{match.time}</span>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-gray-400">
              <th className="pb-2 font-medium">Outcome</th>
              <th className="pb-2 font-medium">Back (bookmaker)</th>
              <th className="pb-2 font-medium">Lay (exchange)</th>
              <th className="pb-2 text-right font-medium">Lay stake</th>
              <th className="pb-2 text-right font-medium">Liability</th>
              <th className="pb-2 text-right font-medium">Est. profit/loss</th>
            </tr>
          </thead>
          <tbody>
            {match.outcomes.map((o, i) => {
              const lay = calcLay(o.odds, o.layOdds, BACK_STAKE);
              return (
                <tr key={i} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="py-2 pr-3">
                    <span className="mr-1">{getIcon(o.name, match.home, match.away)}</span>
                    <span className="font-medium">{o.name}</span>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3">
                    <span className="font-medium">{o.bookmaker}</span>
                    <span className="ml-1 text-gray-500">{formatOdds(o.odds)}</span>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3">
                    {o.layOdds ? (
                      <span>
                        <span className="font-medium">{formatOdds(o.layOdds)}</span>
                        <span className="ml-1 text-gray-500">({o.laySource})</span>
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-right">
                    {lay ? money(lay.layStake) : "—"}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-right">
                    {lay ? money(lay.liability) : "—"}
                  </td>
                  <td className="whitespace-nowrap py-2 text-right">
                    {lay ? (
                      <span
                        className={`font-semibold ${
                          lay.profitLoss >= 0
                            ? "text-green-600 dark:text-green-400"
                            : "text-red-500 dark:text-red-400"
                        }`}
                      >
                        {lay.profitLoss >= 0 ? "+" : "-"}
                        {money(Math.abs(lay.profitLoss))}
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-gray-400">
        Lay = betting <strong>against</strong> this outcome on the exchange (Betfair). Figures use a £20 back stake and include 5% exchange commission.
      </p>

      {match.warning && (
        <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
          ⚠️ {match.warning}
        </div>
      )}
    </div>
  );
}
