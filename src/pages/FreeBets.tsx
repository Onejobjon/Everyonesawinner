import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getMatches, type Match } from "../lib/odds-api";
import { calcDutchFreeBet } from "../lib/odds";
import EmailCapture from "../components/EmailCapture";
import offersData from "../content/free-bets-offers.json";

// ── URL policy ─────────────────────────────────────────────────────────────
// Live re-check of the 17 `urlVerified:false` offers (2026-10-21 curl sweep):
//   • DROPPED — no longer resolve (404 / DNS timeout). Removed entirely.
//   • UNLINKED — respond but are geo/bot-blocked or redirect away from UK/IE.
//     Offer kept (bookmaker is known) but shown WITHOUT a link + a "verify
//     directly" note, so we never send users to a dead or wrong-region page.
//   • Everything else stays linked. Black Type / Cobbler / CasinoDaddy
//     re-verified HTTP 200 and remain linked.
const DROPPED = new Set([
  "BetBull", // DNS timeout — gone
  "FansBet", // 404 — gone
  "SportNation", // DNS timeout — gone
  "RedZone", // DNS timeout — gone
  "WeBringTheFun", // DNS timeout — gone
]);
const UNLINKED = new Set([
  "Vegas Land (WH)", // 403 blocked
  "MansionBet", // 406 blocked
  "Megapari", // 203 → geo-block
  "EnergyBet", // 403 blocked
  "BetMGM", // 200 → redirects to US (nj.betmgm.com), not UK-relevant
  "1xBet", // 203 → geo-block
  "22Bet", // 203 blocked
  "Betwinner", // 203 → geo-block
  "Rabona", // 403 blocked
]);

interface Offer {
  bookmaker: string;
  section: "uk" | "global";
  jurisdiction: string;
  offer: string;
  headlineValue: string;
  minStake: string;
  minOdds: string;
  freeBetTokens: string;
  freeBetExpiry: string;
  estProfit: string;
  ukGbp: string;
  keyTerms: string[];
  notes: string;
  url: string;
  urlVerified: boolean;
}

const meta = offersData.meta as {
  name: string;
  lastVerified: string;
  source: string;
  totalOffers: number;
  ukIeCount: number;
  globalCount: number;
  disclaimer: string;
};

const ALL_OFFERS = (offersData.offers as Offer[]).filter(
  (o) => !DROPPED.has(o.bookmaker),
);

// ── Nav ────────────────────────────────────────────────────────────────────
function Nav() {
  return (
    <nav className="border-b border-gray-200 bg-white/90 dark:border-gray-800 dark:bg-gray-950/90">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <Link to="/" className="flex items-center gap-2">
          <span className="rounded-lg bg-indigo-600 p-2 text-white font-bold text-lg">EAW</span>
          <span className="text-xl font-bold tracking-tight">Everyone's A Winner</span>
        </Link>
        <div className="flex items-center gap-4">
          <Link to="/signup" className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 transition-colors">
            Get Started
          </Link>
        </div>
      </div>
    </nav>
  );
}

// ── Free oddsmatcher preview (blurred profits, cached odds only) ───────────
function OddsPreview() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMatches()
      .then((data) => {
        if (cancelled) return;
        const scored = data.map((m) => ({
          match: m,
          dutch: calcDutchFreeBet(m.outcomes.map((o) => o.odds)),
        }));
        scored.sort((a, b) => b.dutch.netProfit - a.dutch.netProfit);
        setMatches(scored.slice(0, 4).map((x) => x.match));
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="py-16 md:py-20">
      <div className="mx-auto max-w-7xl px-6">
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Today's matches, at a glance</h2>
          <p className="mt-4 text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
            Real odds from UK bookmakers, refreshed every 10 minutes. Unlock every match and the exact profit.
          </p>
        </div>

        {loading && (
          <p className="mt-12 text-center text-sm text-gray-400">Loading live odds…</p>
        )}
        {error && (
          <p className="mt-12 text-center text-sm text-gray-400">
            Live odds are temporarily unavailable — please check back shortly.
          </p>
        )}

        {!loading && !error && matches.length > 0 && (
          <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {matches.map((m) => {
              const dutch = calcDutchFreeBet(m.outcomes.map((o) => o.odds));
              return (
                <div
                  key={m.matchId}
                  className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-950"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">{m.league}</span>
                  </div>
                  <p className="mt-3 font-bold">{m.home} vs {m.away}</p>
                  <div className="mt-3 space-y-1 text-sm text-gray-600 dark:text-gray-400">
                    {m.outcomes.slice(0, 2).map((o, i) => (
                      <div key={i} className="flex justify-between">
                        <span>{o.name}</span>
                        <span className="font-mono text-indigo-600 dark:text-indigo-400">{o.odds.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-800">
                    <span className="text-xs font-medium text-purple-600 dark:text-purple-400">🎟️ Free-bet profit</span>
                    <div className="relative mt-1">
                      <span className="text-sm font-semibold text-green-600 dark:text-green-400 blur-sm select-none">
                        {dutch.netProfit > 0 ? `£${dutch.netProfit.toFixed(2)}` : `£0.00`}
                      </span>
                      <span className="absolute inset-0 flex items-center">
                        <span className="text-xs font-medium text-gray-500">🔒 Unlock with a plan</span>
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-10 text-center">
          <Link
            to="/signup"
            className="inline-block rounded-xl bg-indigo-600 px-8 py-3.5 text-base font-semibold text-white shadow-lg shadow-indigo-600/25 hover:bg-indigo-700 transition-all"
          >
            See every match — from £4.99
          </Link>
          <p className="mt-3 text-xs text-gray-500">50% off your first month · cancel anytime</p>
        </div>
      </div>
    </section>
  );
}

// ── Offers page ────────────────────────────────────────────────────────────
export default function FreeBets() {
  const [search, setSearch] = useState("");
  const [section, setSection] = useState<"all" | "uk" | "global">("all");

  const ukCount = ALL_OFFERS.filter((o) => o.section === "uk").length;
  const globalCount = ALL_OFFERS.filter((o) => o.section === "global").length;

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return ALL_OFFERS.filter((o) => {
      if (section !== "all" && o.section !== section) return false;
      if (!q) return true;
      return (
        o.bookmaker.toLowerCase().includes(q) ||
        o.offer.toLowerCase().includes(q) ||
        o.headlineValue.toLowerCase().includes(q)
      );
    });
  }, [search, section]);

  return (
    <div className="min-h-dvh page-bg text-gray-900 dark:text-gray-100 font-['Inter',system-ui,sans-serif]">
      <Nav />

      {/* Hero */}
      <section className="py-16 md:py-20">
        <div className="mx-auto max-w-7xl px-6 text-center">
          <h1 className="mx-auto max-w-3xl text-4xl font-extrabold tracking-tight sm:text-5xl">
            Free bet offers, all in one place
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-gray-600 dark:text-gray-400">
            {ALL_OFFERS.length} current UK, Irish &amp; global welcome offers — with the maths done so you know exactly what each one is worth.
          </p>
          <div className="mt-8 mx-auto max-w-3xl rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-left text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
            <p>{meta.disclaimer}</p>
            <p className="mt-2 text-amber-700 dark:text-amber-300">
              Last verified: {meta.lastVerified}. A small number of previously listed operators were removed after failing a live link check.
            </p>
          </div>
        </div>
      </section>

      {/* Offers table */}
      <section className="pb-16 md:pb-20">
        <div className="mx-auto max-w-7xl px-6">
          {/* Search + filters */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative sm:w-80">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search bookmakers or offers…"
                className="w-full rounded-lg border border-gray-300 bg-white py-2.5 pl-10 pr-4 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
            <div className="flex gap-1">
              {(
                [
                  ["all", `All (${ALL_OFFERS.length})`],
                  ["uk", `🇬🇧 UK/IE (${ukCount})`],
                  ["global", `🌍 Global (${globalCount})`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setSection(key)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                    section === key
                      ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
                      : "bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Results */}
          <div className="mt-6 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-950">
            {filtered.length === 0 ? (
              <div className="px-6 py-12 text-center text-sm text-gray-400">No offers match your search.</div>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-gray-800">
                {filtered.map((o) => {
                  const unlinked = UNLINKED.has(o.bookmaker);
                  const inner = (
                    <div className="grid grid-cols-1 gap-3 px-6 py-4 sm:grid-cols-[1.6fr_0.7fr_0.8fr_0.8fr_0.8fr] sm:items-center">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-gray-900 dark:text-gray-100">{o.bookmaker}</span>
                          <span className="text-xs">{o.ukGbp === "✅" ? "✅" : "⚠️"}</span>
                          {unlinked && (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                              verify directly
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{o.offer}</p>
                        <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">{o.headlineValue}</p>
                      </div>
                      <div className="text-sm">
                        <span className="block text-xs text-gray-400">Min stake</span>
                        <span className="font-medium text-gray-700 dark:text-gray-300">{o.minStake}</span>
                        <span className="block text-[11px] text-gray-400">@ {o.minOdds}</span>
                      </div>
                      <div className="text-sm">
                        <span className="block text-xs text-gray-400">Free bets</span>
                        <span className="font-medium text-purple-600 dark:text-purple-400">{o.freeBetTokens}</span>
                        <span className="block text-[11px] text-gray-400">{o.freeBetExpiry}</span>
                      </div>
                      <div className="text-sm">
                        <span className="block text-xs text-gray-400">Est. profit</span>
                        <span className="font-semibold text-indigo-600 dark:text-indigo-400">{o.estProfit}</span>
                      </div>
                      <div className="text-sm text-right">
                        {unlinked ? (
                          <span className="text-xs text-amber-600 dark:text-amber-400">Check with bookmaker</span>
                        ) : (
                          <a
                            href={o.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-block rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 transition-colors"
                          >
                            Claim →
                          </a>
                        )}
                      </div>
                    </div>
                  );
                  return <div key={o.bookmaker}>{inner}</div>;
                })}
              </div>
            )}
          </div>

          <p className="mt-4 text-center text-xs text-gray-400">
            ✅ = UK licensed &amp; GBP accepted · ⚠️ = verify UK/GBP eligibility before signing up · 18+ · begambleaware.org
          </p>
        </div>
      </section>

      <OddsPreview />
      <EmailCapture source="free-bets-page" />

      <footer className="border-t border-gray-200 py-10 text-center text-sm text-gray-500 dark:border-gray-800">
        <p>© {new Date().getFullYear()} Everyone's A Winner. All rights reserved.</p>
      </footer>
    </div>
  );
}
