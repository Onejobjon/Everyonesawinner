import { useState, useEffect } from "react";
import { calcDutch, calcDutchFreeBet } from "../lib/odds";
import { getMatches, type Match } from "../lib/odds-api";
import FreeBetsOffers from "../components/FreeBetsOffers";
import Paywall from "../components/Paywall";
import PageHeader from "../components/PageHeader";

/**
 * Starting values for the amount box — NOT a fixed stake.
 *
 * Every card on this page is worked out from one number: the free bet in
 * free-bet mode, or the stake on the ⭐ favourite in cash mode. Those used to
 * be invisible defaults of 10 inside calcDutchFreeBet / calcDutch, so the page
 * printed "£10" figures the visitor never typed and could not change. The
 * amount is now a visible input that starts at these values, and whatever is
 * typed is passed straight through: no cap, no rescale (see the note on
 * assertUsableStake in lib/odds.ts — a £200 free bet gets £200-sized stakes).
 */
const DEFAULT_FREE_BET = 10;
const DEFAULT_CASH_STAKE = 10;

/** Parse the amount box; an empty or nonsense box falls back to the default. */
function parseAmount(raw: string, fallback: number): number {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getIcon(name: string, home: string, away: string): string {
  const lower = name.toLowerCase();
  if (lower === home.toLowerCase()) return "⬆️";
  if (lower === away.toLowerCase()) return "⬇️";
  return "➡️";
}

export default function Oddsmatcher() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("All");
  const [freeBetMode, setFreeBetMode] = useState(true);
  const [freeBetInput, setFreeBetInput] = useState(String(DEFAULT_FREE_BET));
  const [cashStakeInput, setCashStakeInput] = useState(String(DEFAULT_CASH_STAKE));

  // The one number every card below is worked out from, exactly as typed.
  const amountInput = freeBetMode ? freeBetInput : cashStakeInput;
  const setAmountInput = freeBetMode ? setFreeBetInput : setCashStakeInput;
  const amount = parseAmount(amountInput, freeBetMode ? DEFAULT_FREE_BET : DEFAULT_CASH_STAKE);

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
  const filtered = filter === "All" ? matches : matches.filter((m) => m.leagueKey === filter);

  return (
    <Paywall title="the odds finder">
      <PageHeader
        title="Best Odds Finder"
        subtitle="Odds updated every 10 minutes."
        note="Prices the feed reports as unavailable (1.00 / 451) are removed before any profit is calculated, and a match missing an outcome is never shown as an opportunity."
      >

          <div className="mt-6 flex flex-wrap gap-2">
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

          {!loading && !error && filtered.length === 0 && (
            <div className="mt-8 rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-500 dark:border-gray-800 dark:bg-gray-950">No matches found for this league. Try a different filter.</div>
          )}

          {!loading && !error && (
            <>
              <div className="mt-6 flex items-center gap-3">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Mode:</span>
                <button
                  onClick={() => setFreeBetMode(true)}
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                    freeBetMode
                      ? "bg-purple-600 text-white"
                      : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-300"
                  }`}
                >
                  🎟️ Free Bet
                </button>
                <button
                  onClick={() => setFreeBetMode(false)}
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                    !freeBetMode
                      ? "bg-indigo-600 text-white"
                      : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-300"
                  }`}
                >
                  💷 All Cash
                </button>
              </div>

              <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
                <label className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    {freeBetMode ? "Free bet amount" : "Stake on the ⭐ favourite"}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    (default £{freeBetMode ? DEFAULT_FREE_BET : DEFAULT_CASH_STAKE} — change it to anything)
                  </span>
                  <span className="ml-auto flex items-center gap-1.5">
                    <span className="text-sm font-semibold text-gray-600 dark:text-gray-300">£</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      aria-label={freeBetMode ? "Free bet amount in pounds" : "Stake on the favourite in pounds"}
                      value={amountInput}
                      onChange={(e) => setAmountInput(e.target.value)}
                      onBlur={() => setAmountInput(String(amount))}
                      className="w-24 rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-700 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
                    />
                  </span>
                </label>
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  {freeBetMode
                    ? `Every figure below is worked out from this £${amount.toFixed(2)} stake-not-returned free bet — the cash stakes, the return if either side wins, and the profit. Nothing is capped or rescaled: a £200 free bet would get £200-sized stakes.`
                    : `Every figure below is worked out from this £${amount.toFixed(2)} cash stake, placed on the ⭐ favourite; the other outcomes are staked to return the same either way. Nothing is capped or rescaled.`}
                </p>
              </div>
              <div className="mt-6 mb-6">
                <FreeBetsOffers />
              </div>
              <div className="mt-6 grid grid-cols-1 gap-4">
              {filtered.map((m) => {
                const oddsArr = m.outcomes.map((o) => o.odds);
                // A match missing outcomes (sentinel prices dropped by the data
                // layer) can't be dutched — any "profit" would just be the
                // missing leg. Show no verdict rather than a fake one.
                const incomplete = (m.outcomesWithheld ?? 0) > 0;
                const dutch = incomplete
                  ? null
                  : freeBetMode
                    ? calcDutchFreeBet(oddsArr, amount)
                    : calcDutch(oddsArr, amount);
                return (
                  <div key={m.matchId}
                    className={`rounded-xl border-2 p-5 bg-white dark:bg-gray-950 shadow-sm transition-shadow hover:shadow-md ${
                      dutch?.isArbitrage ? "border-green-500" : "border-gray-200 dark:border-gray-800"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-lg">{m.home} vs {m.away}</span>
                        <span className="text-xs text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">{m.league}</span>
                      </div>
                      <span className="text-xs text-gray-400">{m.time}</span>
                    </div>

                    <div className="mt-4 space-y-2">
                      {m.outcomes.map((o, i) => (
                        <div key={i} className="flex items-center gap-2 text-sm">
                          <span className="text-lg">{getIcon(o.name, m.home, m.away)}</span>
                          <span className="font-medium">
                            {dutch && freeBetMode && i === (dutch as any).freeBetIndex && <span className="text-purple-500 mr-1">🎟️</span>}
                            {dutch && !freeBetMode && i === (dutch as any).favIndex && <span className="text-amber-500 mr-1">⭐</span>}
                            <strong>{o.name}</strong> at <strong>{o.bookmaker}</strong> ({o.odds.toFixed(2)})
                          </span>
                          <span className="font-medium text-indigo-700 dark:text-indigo-400">
                            {dutch && freeBetMode && i === (dutch as any).freeBetIndex
                              ? <span className="text-purple-600 dark:text-purple-400">— your <strong>£{amount.toFixed(2)}</strong> free bet</span>
                              : dutch
                                ? `— stake £${dutch.stakes[i].toFixed(2)}`
                                : "—"
                            }
                          </span>
                        </div>
                      ))}
                    </div>

                    {dutch ? (
                    <div className="mt-4 flex items-center gap-2">
                      <span className="text-lg">{dutch.isArbitrage ? "💰" : "⚠️"}</span>
                      <span className="text-sm text-gray-700 dark:text-gray-300">
                        {freeBetMode ? (
                          <>Total cash stake: <strong>£{dutch.totalCashStake.toFixed(2)}</strong> — return if both sides settle: <strong>£{dutch.guaranteedReturn.toFixed(2)}</strong> —</>
                        ) : (
                          <>Total stake: <strong>£{dutch.totalStake.toFixed(2)}</strong> — return if both sides settle: <strong>£{dutch.guaranteedReturn.toFixed(2)}</strong> —</>
                        )}
                        {dutch.isArbitrage ? (
                          <span className="text-green-600 dark:text-green-400 font-semibold"> profit <strong>£{dutch.netProfit.toFixed(2)}</strong></span>
                        ) : (
                          <span className="text-red-600 dark:text-red-400 font-semibold"> loss <strong>£{Math.abs(dutch.netProfit).toFixed(2)}</strong></span>
                        )}
                        <span className="text-gray-400 dark:text-gray-500"> (overround: {dutch.overroundPct.toFixed(1)}%)</span>
                      </span>
                    </div>
                    ) : (
                      <div className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                        ⚠️ This match is missing {m.outcomesWithheld} outcome{m.outcomesWithheld === 1 ? "" : "s"} — the feed reported no usable price, so no profit is shown.
                        {(m.backWithheldAsLaySource ?? 0) > 0 && (
                          <> Of those, {m.backWithheldAsLaySource} had only the exchange's own price, which cannot be matched against that same exchange's lay — backing and laying the same exchange can only lose, so it is withheld rather than shown as an opportunity.</>
                        )}
                      </div>
                    )}
                    {m.warning && (
                      <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                        ⚠️ {m.warning}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            </>
          )}
      </PageHeader>
    </Paywall>
  );
}
