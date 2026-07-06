import { useState, useMemo } from "react";

interface Offer {
  bookmaker: string;
  offer: string;
  minStake: string;
  freeBetValue: string;
  tokens: string;
  estProfit: string;
  ukGbp: "✅" | "⚠️";
  section: "uk" | "global" | "exchange";
  url: string;
}

const offers: Offer[] = [
  // ── UK/IE Licensed Bookmakers (1–41) ──
  { bookmaker: "Bet365", offer: "Bet £10, get £30 in free bets", minStake: "£10", freeBetValue: "£30", tokens: "3 × £10", estProfit: "£20–£25", ukGbp: "✅", section: "uk", url: "https://www.bet365.com" },
  { bookmaker: "Sky Bet", offer: "Bet £5, get £20 in free bets", minStake: "£5", freeBetValue: "£20", tokens: "4 × £5", estProfit: "£14–£17", ukGbp: "✅", section: "uk", url: "https://www.skybet.com" },
  { bookmaker: "William Hill", offer: "Bet £10, get £30 in free bets", minStake: "£10", freeBetValue: "£30", tokens: "3 × £10", estProfit: "£20–£25", ukGbp: "✅", section: "uk", url: "https://www.williamhill.com" },
  { bookmaker: "Paddy Power", offer: "Bet £10, get £20 in free bets", minStake: "£10", freeBetValue: "£20", tokens: "2 × £10", estProfit: "£14–£17", ukGbp: "✅", section: "uk", url: "https://www.paddypower.com" },
  { bookmaker: "Betfair Sportsbook", offer: "Bet £10, get £20 in free bets", minStake: "£10", freeBetValue: "£20", tokens: "2 × £10", estProfit: "£14–£17", ukGbp: "✅", section: "uk", url: "https://www.betfair.com/sport" },
  { bookmaker: "Betfred", offer: "Bet £10, get £30 in free bets", minStake: "£10", freeBetValue: "£30", tokens: "3 × £10", estProfit: "£20–£25", ukGbp: "✅", section: "uk", url: "https://www.betfred.com" },
  { bookmaker: "Ladbrokes", offer: "Bet £5, get £20 in free bets", minStake: "£5", freeBetValue: "£20", tokens: "4 × £5", estProfit: "£14–£17", ukGbp: "✅", section: "uk", url: "https://www.ladbrokes.com" },
  { bookmaker: "Coral", offer: "Bet £5, get £20 in free bets", minStake: "£5", freeBetValue: "£20", tokens: "4 × £5", estProfit: "£14–£17", ukGbp: "✅", section: "uk", url: "https://www.coral.co.uk" },
  { bookmaker: "Unibet", offer: "Bet £10, get £20 + £10 casino", minStake: "£10", freeBetValue: "£30 total", tokens: "2 × £10", estProfit: "£15–£18", ukGbp: "✅", section: "uk", url: "https://www.unibet.co.uk" },
  { bookmaker: "BetVictor", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.betvictor.com" },
  { bookmaker: "SpreadEx", offer: "Bet £20, get £20 in free bets", minStake: "£20", freeBetValue: "£20", tokens: "2 × £10", estProfit: "£13–£16", ukGbp: "✅", section: "uk", url: "https://www.spreadex.com" },
  { bookmaker: "Boylesports (IE)", offer: "Bet €10, get €20 in free bets", minStake: "€10", freeBetValue: "€20", tokens: "2 × €10", estProfit: "€14–€17", ukGbp: "✅", section: "uk", url: "https://www.boylesports.com" },
  { bookmaker: "888sport", offer: "Bet £10, get £10 + £10 casino", minStake: "£10", freeBetValue: "£20 total", tokens: "1 × £10", estProfit: "£7–£9", ukGbp: "✅", section: "uk", url: "https://www.888sport.com" },
  { bookmaker: "Betway", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.betway.com" },
  { bookmaker: "10Bet", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.10bet.com" },
  { bookmaker: "BetUK", offer: "Bet £10, get £30 in free bets", minStake: "£10", freeBetValue: "£30", tokens: "3 × £10", estProfit: "£20–£24", ukGbp: "✅", section: "uk", url: "https://www.betuk.com" },
  { bookmaker: "BetZone", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.betzone.co.uk" },
  { bookmaker: "Kwiff", offer: "Bet £10, get £10 boosted bet", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£5–£7", ukGbp: "✅", section: "uk", url: "https://www.kwiff.com" },
  { bookmaker: "NetBet", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.netbet.co.uk" },
  { bookmaker: "Luckster", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.luckster.com" },
  { bookmaker: "CopyBet", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.copybet.com" },
  { bookmaker: "Hollywood Bets", offer: "Bet £10, get £30 in free bets", minStake: "£10", freeBetValue: "£30", tokens: "3 × £10", estProfit: "£20–£24", ukGbp: "✅", section: "uk", url: "https://www.hollywoodbets.co.uk" },
  { bookmaker: "Vegas Land (WH)", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.vegasland.com" },
  { bookmaker: "MansionBet", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.mansionbet.com" },
  { bookmaker: "BetBull", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.betbull.com" },
  { bookmaker: "Megapari", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.megapari.com" },
  { bookmaker: "VBet", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.vbet.co.uk" },
  { bookmaker: "FansBet", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.fansbet.com" },
  { bookmaker: "Mr Green", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.mrgreen.com" },
  { bookmaker: "Casumo", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.casumo.com" },
  { bookmaker: "LeoVegas Sport", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.leovegas.com" },
  { bookmaker: "LiveScore Bet", offer: "Bet £10, get £20 in free bets", minStake: "£10", freeBetValue: "£20", tokens: "2 × £10", estProfit: "£14–£16", ukGbp: "✅", section: "uk", url: "https://www.livescorebet.com" },
  { bookmaker: "SportNation", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.sportnation.com" },
  { bookmaker: "EnergyBet", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.energybet.com" },
  { bookmaker: "RedZone", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.redzone.bet" },
  { bookmaker: "BetMGM", offer: "Bet £10, get £20 in free bets", minStake: "£10", freeBetValue: "£20", tokens: "2 × £10", estProfit: "£14–£16", ukGbp: "✅", section: "uk", url: "https://www.betmgm.com" },
  { bookmaker: "Fitzdares", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.fitzdares.com" },
  { bookmaker: "Virgin Bet", offer: "Bet £10, get £20 in free bets", minStake: "£10", freeBetValue: "£20", tokens: "2 × £10", estProfit: "£14–£16", ukGbp: "✅", section: "uk", url: "https://www.virginbet.com" },
  { bookmaker: "Black Type", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.blacktype.com" },
  { bookmaker: "Cobbler", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.cobbler.com" },
  { bookmaker: "WeBringTheFun", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "uk", url: "https://www.webringthefun.com" },

  // ── Global/European Bookmakers (42–60) ──
  { bookmaker: "Bwin", offer: "Bet £10, get £20 in free bets", minStake: "£10", freeBetValue: "£20", tokens: "2 × £10", estProfit: "£14–£16", ukGbp: "✅", section: "global", url: "https://www.bwin.com" },
  { bookmaker: "Sportingbet", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "global", url: "https://www.sportingbet.com" },
  { bookmaker: "Betsson", offer: "Bet £10, get £20 in free bets", minStake: "£10", freeBetValue: "£20", tokens: "2 × £10", estProfit: "£14–£16", ukGbp: "✅", section: "global", url: "https://www.betsson.com" },
  { bookmaker: "Betsafe", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "global", url: "https://www.betsafe.com" },
  { bookmaker: "Tipico", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "⚠️", section: "global", url: "https://www.tipico.com" },
  { bookmaker: "QuinnBet", offer: "Bet €10, get €20 in free bets", minStake: "€10", freeBetValue: "€20", tokens: "2 × €10", estProfit: "€14–€16", ukGbp: "✅", section: "global", url: "https://www.quinnbet.com" },
  { bookmaker: "Matchbook", offer: "£10 free bet on first deposit", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "global", url: "https://www.matchbook.com" },
  { bookmaker: "PokerStars Sports", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "global", url: "https://www.pokerstars.com/sports" },
  { bookmaker: "RaceBets", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "global", url: "https://www.racebets.com" },
  { bookmaker: "Dafabet", offer: "Bet £10, get £20 in free bets", minStake: "£10", freeBetValue: "£20", tokens: "2 × £10", estProfit: "£14–£16", ukGbp: "⚠️", section: "global", url: "https://www.dafabet.com" },
  { bookmaker: "1xBet", offer: "Bet £10, get £30 in free bets", minStake: "£10", freeBetValue: "£30", tokens: "3 × £10", estProfit: "£20–£24", ukGbp: "⚠️", section: "global", url: "https://www.1xbet.com" },
  { bookmaker: "22Bet", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "⚠️", section: "global", url: "https://www.22bet.com" },
  { bookmaker: "SportPesa", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "⚠️", section: "global", url: "https://www.sportpesa.com" },
  { bookmaker: "Bet-at-home", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "⚠️", section: "global", url: "https://www.bet-at-home.com" },
  { bookmaker: "Betwinner", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "⚠️", section: "global", url: "https://www.betwinner.com" },
  { bookmaker: "ComeOn", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "global", url: "https://www.comeon.com" },
  { bookmaker: "Mobilebet", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "✅", section: "global", url: "https://www.mobilebet.com" },
  { bookmaker: "Neo.bet", offer: "Bet £10, get £15 in free bets", minStake: "£10", freeBetValue: "£15", tokens: "1 × £15", estProfit: "£10–£12", ukGbp: "⚠️", section: "global", url: "https://www.neo.bet" },
  { bookmaker: "CasinoDaddy", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "⚠️", section: "global", url: "https://www.casinodaddy.com" },
  { bookmaker: "Rabona", offer: "Bet £10, get £10 in free bets", minStake: "£10", freeBetValue: "£10", tokens: "1 × £10", estProfit: "£7–£8", ukGbp: "⚠️", section: "global", url: "https://www.rabona.com" },
];

export default function FreeBetsOffers() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [section, setSection] = useState<"all" | "uk" | "global">("all");

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return offers.filter((o) => {
      if (section !== "all" && o.section !== section) return false;
      if (!q) return true;
      return (
        o.bookmaker.toLowerCase().includes(q) ||
        o.offer.toLowerCase().includes(q)
      );
    });
  }, [search, section]);

  const ukCount = offers.filter((o) => o.section === "uk").length;
  const globalCount = offers.filter((o) => o.section === "global").length;

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
          {/* Guidance note */}
          <div className="px-6 py-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Latest UK, Irish &amp; global welcome offers. Use one free bet per match for guaranteed profit. 
              Total estimated one-time profit: <strong className="text-gray-700 dark:text-gray-300">~£570–£800</strong>
            </p>
          </div>

          {/* Search bar */}
          <div className="px-6 pb-3">
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search bookmakers or offers..."
                className="w-full rounded-lg border border-gray-300 bg-gray-50 py-2 pl-10 pr-4 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500 dark:focus:border-indigo-500"
              />
            </div>
          </div>

          {/* Section filter tabs */}
          <div className="flex gap-1 px-6 pb-3">
            <button
              onClick={() => setSection("all")}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                section === "all"
                  ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
                  : "bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
              }`}
            >
              All ({offers.length})
            </button>
            <button
              onClick={() => setSection("uk")}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                section === "uk"
                  ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
                  : "bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
              }`}
            >
              🇬🇧 UK/IE ({ukCount})
            </button>
            <button
              onClick={() => setSection("global")}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                section === "global"
                  ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
                  : "bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
              }`}
            >
              🌍 Global ({globalCount})
            </button>
            {search && (
              <button
                onClick={() => setSearch("")}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
              >
                ✕ Clear
              </button>
            )}
          </div>

          {/* Results */}
          <div className="divide-y divide-gray-100 dark:divide-gray-800 max-h-[500px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-6 py-8 text-center text-sm text-gray-400">
                No bookmakers match your search.
              </div>
            ) : (
              filtered.map((o, i) => (
                <a
                  key={i}
                  href={o.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-3 px-6 py-3 text-sm transition-colors hover:bg-gray-50 dark:hover:bg-gray-900 items-center"
                >
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-gray-900 dark:text-gray-100">{o.bookmaker}</span>
                      <span className="text-xs">{o.ukGbp}</span>
                    </div>
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
                  <div className="text-right">
                    <span className="text-xs text-gray-400">UK/GBP</span>
                    <p className="font-medium">{o.ukGbp}</p>
                  </div>
                </a>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-gray-100 px-6 py-3 dark:border-gray-800">
            <p className="text-xs text-gray-400 text-center">
              ✅ = UK licensed &amp; GBP accepted &nbsp;|&nbsp; ⚠️ = Verify UK/GBP eligibility before signing up
            </p>
            <p className="text-xs text-gray-400 text-center mt-1">
              Use one free bet per match. Switch to 🎟️ Free Bet mode above to see profits. Offers subject to change.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}