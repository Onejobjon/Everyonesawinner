import { useState } from "react";
import { Link } from "react-router-dom";
import Paywall from "../components/Paywall";
import { CommissionControl, CommissionNote, useExchangeCommission } from "../components/CommissionControl";

export function calcProfit(stake: number, backOdds: number, layOdds: number, comm: number) {
  // Commission-aware lay stake — the SAME formula as calcLay in lib/odds.ts,
  // so the calculator and the Lay Bet Finder can never quote different numbers
  // for the same bet. (The old formula had no commission term, so both outcomes
  // did not balance and it printed ~22p more loss than the finder did.)
  const layStake = (stake * backOdds) / (layOdds - comm / 100);
  const liability = layStake * (layOdds - 1);
  const backWin = stake * (backOdds - 1) - liability;
  const layWin = layStake * (1 - comm / 100) - stake;
  return {
    layStake: Math.round(layStake * 100) / 100,
    liability: Math.round(liability * 100) / 100,
    // Honest headline: the WORSE of the two outcomes, because that is the
    // only figure guaranteed whichever way the bet goes.
    profit: Math.round(Math.min(backWin, layWin) * 100) / 100,
    backWin: Math.round(backWin * 100) / 100,
    layWin: Math.round(layWin * 100) / 100,
    backOdds,
    layOdds,
  };
}

export default function Calculator() {
  const [stake, setStake] = useState(10);
  const [backOdds, setBackOdds] = useState(3.0);
  const [layOdds, setLayOdds] = useState(3.1);
  // ONE shared commission, persisted across pages (2% by default, adjustable —
  // Betfair charges per market, so a fixed rate would misstate the profit).
  const { pct: commPct, label: commLabel, setPct: setCommPct } = useExchangeCommission();
  const result = calcProfit(stake, backOdds, layOdds, commPct);

  return (
    <Paywall title="the profit calculator">
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

        <div className="mx-auto max-w-3xl px-6 py-12">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Profit Calculator</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">Enter your stake and odds. We'll show the lay stake, the liability, and what you're left with if the back bet wins or the lay does.</p>

          <div className="mt-8 rounded-2xl border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-800 dark:bg-gray-950">
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium mb-1">Your Stake (£)</label>
                <input type="number" value={stake} onChange={(e) => setStake(Number(e.target.value))}
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm dark:border-gray-700 dark:bg-gray-900" min={1} step={1} />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Bookmaker Odds</label>
                <input type="number" value={backOdds} onChange={(e) => setBackOdds(Number(e.target.value))}
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm dark:border-gray-700 dark:bg-gray-900" min={1.01} step={0.01} />
                <p className="text-xs text-gray-400 mt-0.5">Decimal odds (e.g. 2.50)</p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Exchange Odds</label>
                <input type="number" value={layOdds} onChange={(e) => setLayOdds(Number(e.target.value))}
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm dark:border-gray-700 dark:bg-gray-900" min={1.01} step={0.01} />
                <p className="text-xs text-gray-400 mt-0.5">Decimal odds (e.g. 2.55)</p>
              </div>
              <div>
                <CommissionControl pct={commPct} onChange={setCommPct} />
              </div>
            </div>

            <div className="mt-8 rounded-xl bg-indigo-50 p-6 dark:bg-indigo-950/50">
              <h3 className="text-lg font-semibold text-indigo-700 dark:text-indigo-300">You keep, whichever way it goes</h3>
              <p className="mt-2 text-4xl font-extrabold text-indigo-600">
                £{result.profit.toFixed(2)}
              </p>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                The lower of the two figures below — that is the one you can count on.
              </p>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                <CommissionNote pct={commPct} className="font-medium" /> — figures use {commLabel} exchange
                commission, adjustable above.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4 text-sm">
                <div>
                  <span className="text-gray-500 dark:text-gray-400">Exchange Stake</span>
                  <p className="font-semibold">£{result.layStake.toFixed(2)}</p>
                </div>
                <div>
                  <span className="text-gray-500 dark:text-gray-400">Amount at Risk</span>
                  <p className="font-semibold">£{result.liability.toFixed(2)}</p>
                </div>
                <div>
                  <span className="text-gray-500 dark:text-gray-400">If Back Bet Wins</span>
                  <p className={`font-semibold ${result.backWin >= 0 ? "text-green-600" : "text-red-600"}`}>
                    £{result.backWin.toFixed(2)}
                  </p>
                </div>
                <div>
                  <span className="text-gray-500 dark:text-gray-400">If Lay Bet Wins</span>
                  <p className={`font-semibold ${result.layWin >= 0 ? "text-green-600" : "text-red-600"}`}>
                    £{result.layWin.toFixed(2)}
                  </p>
                </div>
              </div>

              <div className="mt-4 flex gap-4 text-xs text-gray-500">
                <span>Bookmaker: {result.backOdds.toFixed(2)}</span>
                <span>Exchange: {result.layOdds.toFixed(2)}</span>
              </div>
            </div>

            <div className="mt-6 rounded-lg bg-amber-50 p-4 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
              <strong>💡 Tip:</strong> The closer the odds are together, the more you'll keep. Try to pick matches where the bookmaker and exchange prices are nearly the same.
            </div>
          </div>
        </div>
      </div>
    </Paywall>
  );
}