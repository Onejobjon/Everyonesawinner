import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/calculator")({
  component: Calculator,
});

function Calculator() {
  const [stake, setStake] = useState("10");
  const [backOdds, setBackOdds] = useState("2.0");
  const [layOdds, setLayOdds] = useState("2.1");
  const [commission, setCommission] = useState("2");
  const [currency, setCurrency] = useState("£");

  const stakeNum = parseFloat(stake) || 0;
  const backOddsNum = parseFloat(backOdds) || 0;
  const layOddsNum = parseFloat(layOdds) || 0;
  const commissionNum = parseFloat(commission) || 0;

  // Matched betting calculations
  // Lay stake = (back odds * stake) / (lay odds - commission)
  // Guaranteed profit = (stake * (back odds - 1)) - (lay stake * (lay odds - 1) * (1 + commission/100))
  // More precisely:
  // If the back bet wins: profit = stake * (backOdds - 1) - layStake * (layOdds - 1)
  // If the lay bet wins: profit = layStake * (1 - commission/100) - stake
  // For a qualifying bet (not free bet), we calculate the lay stake to equalise

  let layStake = 0;
  let profitIfBackWins = 0;
  let profitIfLayWins = 0;
  let totalReturn = 0;
  let isFreeBet = false;

  if (stakeNum > 0 && backOddsNum > 1 && layOddsNum > 1) {
    // Calculate lay stake for a qualifying bet (to equalise outcomes)
    const commissionFactor = 1 - commissionNum / 100;
    // Lay stake = back stake * back odds / (lay odds - commission on lay)
    // The effective lay odds after commission = layOdds * (1 - commission/100) for the liability
    // Actually for the lay bet:
    // If lay bet wins, we get: layStake * (1 - commission/100) - we paid the stake originally? No.
    // On a betting exchange:
    // If lay bet wins: profit = layStake * (1 - commission/100) 
    // If lay bet loses: loss = layStake * (layOdds - 1)
    // 
    // For qualifying bet (we're using our own money):
    // Back bet wins: profit = stake * (backOdds - 1) - layStake * (layOdds - 1)
    // Lay bet wins: profit = layStake * (1 - commission/100) - stake
    //
    // Equalise profit: stake * (backOdds - 1) - layStake * (layOdds - 1) = layStake * (1 - commission/100) - stake
    // Solve for layStake:
    // stake * backOdds - stake - layStake * layOdds + layStake = layStake - layStake * commission/100 - stake
    // stake * backOdds - stake - layStake * (layOdds - 1) = layStake * (1 - commission/100) - stake
    // stake * backOdds - layStake * (layOdds - 1) = layStake * (1 - commission/100)
    // stake * backOdds = layStake * (layOdds - 1) + layStake * (1 - commission/100)
    // stake * backOdds = layStake * (layOdds - 1 + 1 - commission/100)
    // stake * backOdds = layStake * (layOdds - commission/100)
    // layStake = stake * backOdds / (layOdds - commission/100)
    
    layStake = (stakeNum * backOddsNum) / (layOddsNum - commissionNum / 100);

    // Profit if the back bet wins (we win at bookmaker, lose on exchange)
    profitIfBackWins = stakeNum * (backOddsNum - 1) - layStake * (layOddsNum - 1);

    // Profit if the lay bet wins (we lose at bookmaker, win on exchange)
    // When the lay bet wins, we get: layStake * (1 - commission/100)
    // But we also lost our qualifying stake at the bookmaker
    profitIfLayWins = layStake * (1 - commissionNum / 100) - stakeNum;

    // Total return is what we get back from the winning side
    // For back bet: totalReturn = stake * backOdds
    // For lay bet: totalReturn = layStake + profitIfLayWins... 
    // Actually the "total return" is simpler to just say what the user gets back if back wins.
    totalReturn = stakeNum * backOddsNum;
  }

  const formatCurrency = (n: number) => {
    return `${currency}${n.toFixed(2)}`;
  };

  return (
    <div className="min-h-dvh bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {/* Simple nav */}
      <nav className="border-b border-gray-200 dark:border-gray-800 bg-white/90 dark:bg-gray-950/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2">
            <span className="rounded-lg bg-indigo-600 p-2 text-white font-bold text-lg">
              MP
            </span>
            <span className="text-xl font-bold tracking-tight">MatchProfit</span>
          </Link>
          <Link
            href="/"
            className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition-colors"
          >
            &larr; Back to home
          </Link>
        </div>
      </nav>

      <div className="mx-auto max-w-5xl px-6 py-12 md:py-16">
        <div className="text-center mb-12">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Matched Betting Profit Calculator
          </h1>
          <p className="mt-4 text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
            Calculate your guaranteed profit from any matched betting opportunity.
            Enter your stake, odds, and commission below.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
          {/* Input Form */}
          <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-800 dark:bg-gray-950">
            <h2 className="text-lg font-semibold mb-8">Enter the details</h2>
            <div className="space-y-6">
              {/* Currency selector */}
              <div>
                <label className="block text-sm font-medium mb-2">
                  Currency
                </label>
                <div className="flex gap-2">
                  {["£", "€", "$"].map((c) => (
                    <button
                      key={c}
                      onClick={() => setCurrency(c)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        currency === c
                          ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                          : "border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-900"
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              {/* Stake */}
              <div>
                <label
                  htmlFor="stake"
                  className="block text-sm font-medium mb-2"
                >
                  Qualifying Stake ({currency})
                </label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500">
                    {currency}
                  </span>
                  <input
                    id="stake"
                    type="number"
                    min="0"
                    step="0.01"
                    value={stake}
                    onChange={(e) => setStake(e.target.value)}
                    className="w-full rounded-xl border border-gray-300 bg-white py-3 pl-8 pr-4 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-gray-700 dark:bg-gray-900 dark:focus:ring-indigo-800"
                    placeholder="10"
                  />
                </div>
              </div>

              {/* Back odds */}
              <div>
                <label
                  htmlFor="backOdds"
                  className="block text-sm font-medium mb-2"
                >
                  Back Odds (Bookmaker)
                </label>
                <input
                  id="backOdds"
                  type="number"
                  min="1.01"
                  step="0.01"
                  value={backOdds}
                  onChange={(e) => setBackOdds(e.target.value)}
                  className="w-full rounded-xl border border-gray-300 bg-white py-3 px-4 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-gray-700 dark:bg-gray-900 dark:focus:ring-indigo-800"
                  placeholder="2.0"
                />
              </div>

              {/* Lay odds */}
              <div>
                <label
                  htmlFor="layOdds"
                  className="block text-sm font-medium mb-2"
                >
                  Lay Odds (Exchange)
                </label>
                <input
                  id="layOdds"
                  type="number"
                  min="1.01"
                  step="0.01"
                  value={layOdds}
                  onChange={(e) => setLayOdds(e.target.value)}
                  className="w-full rounded-xl border border-gray-300 bg-white py-3 px-4 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-gray-700 dark:bg-gray-900 dark:focus:ring-indigo-800"
                  placeholder="2.1"
                />
              </div>

              {/* Commission */}
              <div>
                <label
                  htmlFor="commission"
                  className="block text-sm font-medium mb-2"
                >
                  Exchange Commission (%)
                </label>
                <div className="relative">
                  <input
                    id="commission"
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={commission}
                    onChange={(e) => setCommission(e.target.value)}
                    className="w-full rounded-xl border border-gray-300 bg-white py-3 px-4 pr-8 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-gray-700 dark:bg-gray-900 dark:focus:ring-indigo-800"
                    placeholder="2"
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500">
                    %
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Results */}
          <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-800 dark:bg-gray-950">
            <h2 className="text-lg font-semibold mb-8">Your Results</h2>

            {stakeNum <= 0 || backOddsNum <= 1 || layOddsNum <= 1 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <svg
                  className="h-12 w-12 text-gray-300 mb-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"
                  />
                </svg>
                <p className="text-gray-500 text-sm">
                  Enter valid stake and odds to see results
                </p>
                <p className="text-gray-400 text-xs mt-1">
                  Odds must be greater than 1.0
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Guaranteed Profit */}
                <div className="rounded-xl bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200 p-6 dark:from-green-950/30 dark:to-emerald-950/30 dark:border-green-900">
                  <p className="text-sm font-medium text-green-700 dark:text-green-400">
                    Guaranteed Profit
                  </p>
                  <p className="mt-1 text-3xl font-extrabold text-green-600 dark:text-green-400">
                    {formatCurrency(
                      Math.min(profitIfBackWins, profitIfLayWins)
                    )}
                  </p>
                  <p className="mt-1 text-xs text-green-600/70 dark:text-green-500/70">
                    Regardless of which outcome wins
                  </p>
                </div>

                {/* Detailed breakdown */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="rounded-xl bg-gray-50 p-4 dark:bg-gray-900">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                      Lay Stake
                    </p>
                    <p className="mt-1 text-xl font-bold">
                      {formatCurrency(layStake)}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Stake on the exchange
                    </p>
                  </div>
                  <div className="rounded-xl bg-gray-50 p-4 dark:bg-gray-900">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                      Lay Liability
                    </p>
                    <p className="mt-1 text-xl font-bold">
                      {formatCurrency(layStake * (layOddsNum - 1))}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Max loss on exchange
                    </p>
                  </div>
                </div>

                {/* Outcome scenarios */}
                <div className="space-y-3">
                  <p className="text-sm font-medium">Outcome Scenarios</p>

                  <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/30">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold text-blue-800 dark:text-blue-300">
                          Back Bet Wins
                        </p>
                        <p className="text-xs text-blue-600 dark:text-blue-400">
                          Your bet at the bookmaker wins
                        </p>
                      </div>
                      <p className="text-lg font-bold text-blue-700 dark:text-blue-400">
                        {formatCurrency(profitIfBackWins)}
                      </p>
                    </div>
                  </div>

                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                          Lay Bet Wins
                        </p>
                        <p className="text-xs text-amber-600 dark:text-amber-400">
                          Your exchange bet wins
                        </p>
                      </div>
                      <p className="text-lg font-bold text-amber-700 dark:text-amber-400">
                        {formatCurrency(profitIfLayWins)}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Total stake outlay */}
                <div className="border-t border-gray-200 pt-4 dark:border-gray-800">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Total outlay (stake + liability)</span>
                    <span className="font-semibold">
                      {formatCurrency(stakeNum + layStake * (layOddsNum - 1))}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm mt-1">
                    <span className="text-gray-500">ROI</span>
                    <span className="font-semibold">
                      {((Math.min(profitIfBackWins, profitIfLayWins) / (stakeNum + layStake * (layOddsNum - 1))) * 100).toFixed(1)}%
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Quick tips */}
            {stakeNum > 0 && backOddsNum > 1 && layOddsNum > 1 && (
              <div className="mt-6 rounded-xl bg-indigo-50 p-4 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-900">
                <p className="text-xs font-semibold text-indigo-700 dark:text-indigo-300 uppercase tracking-wide">
                  Tip
                </p>
                <p className="mt-1 text-sm text-indigo-600 dark:text-indigo-400">
                  {Math.abs(profitIfBackWins - profitIfLayWins) < 0.01
                    ? "Perfect hedge! Both outcomes give the same profit."
                    : profitIfBackWins > profitIfLayWins
                    ? `The back bet is slightly more profitable. Try adjusting your lay odds closer to ${backOddsNum} for a better hedge.`
                    : `The lay bet is slightly more profitable. Try finding slightly higher back odds for a better balance.`}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* How to use */}
        <div className="mt-16 rounded-2xl border border-gray-200 bg-gray-50 p-8 dark:border-gray-800 dark:bg-gray-900/50">
          <h3 className="text-lg font-semibold mb-4">
            How to use this calculator
          </h3>
          <ol className="space-y-3 text-sm text-gray-600 dark:text-gray-400">
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
                1
              </span>
              Enter the stake amount from your qualifying bet or free bet offer.
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
                2
              </span>
              Enter the back odds from the bookmaker (e.g., 2.0 means even money).
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
                3
              </span>
              Enter the lay odds from a betting exchange like Betfair or Smarkets.
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
                4
              </span>
              Set the exchange commission (typically 2% on Betfair, 0% on Matchbook).
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
                5
              </span>
              Read your guaranteed profit — that's money you keep no matter what!
            </li>
          </ol>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
        <div className="mx-auto max-w-7xl px-6 py-8 text-center text-sm text-gray-500 dark:text-gray-500">
          <p>&copy; {new Date().getFullYear()} MatchProfit. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}