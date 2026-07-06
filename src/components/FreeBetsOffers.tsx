import { useState } from "react";

interface Offer {
  bookmaker: string;
  offer: string;
  minStake: string;
  freeBetValue: string;
  tokens: string;
  estProfit: string;
}

const offers: Offer[] = [
  { bookmaker: "Bet365", offer: "Bet £10, get £30 in free bets", minStake: "£10", freeBetValue: "£30", tokens: "3 × £10", estProfit: "£20–£25" },
  { bookmaker: "Sky Bet", offer: "Bet £5, get £20 in free bets", minStake: "£5", freeBetValue: "£20", tokens: "4 × £5", estProfit: "£14–£17" },
  { bookmaker: "William Hill", offer: "Bet £10, get £30 in free bets", minStake: "£10", freeBetValue: "£30", tokens: "3 × £10", estProfit: "£20–£25" },
  { bookmaker: "Paddy Power", offer: "Bet £10, get £20 in free bets", minStake: "£10", freeBetValue: "£20", tokens: "2 × £10", estProfit: "£14–£17" },
  { bookmaker: "Betfair Sportsbook", offer: "Bet £10, get £20 in free bets", minStake: "£10", freeBetValue: "£20", tokens: "2 × £10", estProfit: "£14–£17" },
  { bookmaker: "Betfred", offer: "Bet £10, get £30 in free bets", minStake: "£10", freeBetValue: "£30", tokens: "3 × £10", estProfit: "£20–£25" },
  { bookmaker: "Ladbrokes", offer: "Bet £5, get £20 in free bets", minStake: "£5", freeBetValue: "£20", tokens: "4 × £5", estProfit: "£14–£17" },
  { bookmaker: "Coral", offer: "Bet £5, get £20 in free bets", minStake: "£5", freeBetValue: "£20", tokens: "4 × £5", estProfit: "£14–£17" },
  { bookmaker: "Unibet", offer: "Bet £10, get £20 + £10 casino", minStake: "£10", freeBetValue: "£30 total", tokens: "2 × £10", estProfit: "£15–£18" },
  { bookmaker: "BetVictor", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8" },
  { bookmaker: "SpreadEx", offer: "Bet £20, get £20 in free bets", minStake: "£20", freeBetValue: "£20", tokens: "2 × £10", estProfit: "£13–£16" },
  { bookmaker: "Boylesports (IE)", offer: "Bet €10, get €20 in free bets", minStake: "€10", freeBetValue: "€20", tokens: "2 × €10", estProfit: "€14–€17" },
];

export default function FreeBetsOffers() {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-950">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-6 py-4 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-900"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">🎁</span>
          <span className="text-base font-semibold">Free Bet Offers</span>
          <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300">
            {offers.length} available
          </span>
        </div>
        <svg
          className={`h-5 w-5 text-gray-500 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-gray-200 dark:border-gray-800">
          <div className="px-6 py-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Latest UK & Ireland welcome offers. Use one free bet per match for guaranteed profit.
            </p>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {offers.map((o, i) => (
              <a
                key={i}
                href="#"
                className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-6 py-3 text-sm transition-colors hover:bg-gray-50 dark:hover:bg-gray-900 items-center"
              >
                <div>
                  <span className="font-semibold text-gray-900 dark:text-gray-100">{o.bookmaker}</span>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{o.offer}</p>
                </div>
                <div className="text-right">
                  <span className="text-xs text-gray-400">Min</span>
                  <p className="font-medium text-gray-700 dark:text-gray-300">{o.minStake}</p>
                </div>
                <div className="text-right">
                  <span className="text-xs text-gray-400">Tokens</span>
                  <p className="font-medium text-purple-600 dark:text-purple-400">{o.tokens}</p>
                </div>
                <div className="text-right">
                  <span className="text-xs text-gray-400">Free bet</span>
                  <p className="font-medium text-green-600 dark:text-green-400">{o.freeBetValue}</p>
                </div>
                <div className="text-right">
                  <span className="text-xs text-gray-400">Profit</span>
                  <p className="font-semibold text-indigo-600 dark:text-indigo-400">{o.estProfit}</p>
                </div>
              </a>
            ))}
          </div>
          <div className="px-6 py-3 border-t border-gray-100 dark:border-gray-800">
            <p className="text-xs text-gray-400 text-center">
              Use one free bet per match. Switch to 🎟️ Free Bet mode above to see profits. Offers subject to change.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}