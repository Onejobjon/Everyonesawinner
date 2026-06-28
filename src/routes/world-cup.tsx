import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { fetchMatches, formatTime, calculateProfit } from "../lib/odds";
import type { Match } from "../lib/odds";

const getWcMatches = createServerFn({ method: "GET" }).handler(async () => {
  const data = await fetchMatches(true, false);
  return data.worldCup.sort(
    (a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime()
  );
});

export const Route = createFileRoute("/world-cup")({
  component: WorldCup,
});

const OFFER_TYPES = [
  { name: "Enhanced Odds / Price Boosts", profit: "£3–£15", freq: "Daily (multiple)", icon: "🎯" },
  { name: "Bet Insurance / Money Back", profit: "£5–£10", freq: "Per matchday", icon: "🛡️" },
  { name: "Acca Boosts", profit: "£5–£20", freq: "Daily", icon: "🔄" },
  { name: "Free Bets on Matches", profit: "£3–£8", freq: "Per matchday", icon: "🆓" },
  { name: "In-Play Offers", profit: "£3–£6", freq: "Per match", icon: "📺" },
  { name: "Two-Up Offers", profit: "£5–£15", freq: "Group stage", icon: "🥇" },
];

const FAQS = [
  {
    q: "Can I really make money during the World Cup without gambling?",
    a: "Yes. Matched betting mathematically eliminates risk. The profit comes from promotional offers, not from guessing match outcomes.",
  },
  {
    q: "How much bankroll do I need?",
    a: "£100–£200 is enough to get started. £500 lets you capitalise on every opportunity without missing out.",
  },
  {
    q: "Do I need to watch the matches?",
    a: "No. The bets are placed before the matches. You can check results later to settle your positions.",
  },
  {
    q: "Is matched betting legal during the World Cup?",
    a: "Absolutely. The UK Gambling Commission and Irish authorities regulate bookmakers, not matched bettors.",
  },
  {
    q: "How quickly can I start?",
    a: "You can sign up, connect to our offer feed, and place your first World Cup bet in under 30 minutes.",
  },
];

function WorldCup() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [faqOpen, setFaqOpen] = useState<number | null>(null);
  const [urgencyDismissed, setUrgencyDismissed] = useState(false);

  useState(() => {
    getWcMatches().then((data) => {
      setMatches(data);
      setLoading(false);
    });
  });

  return (
    <div className="min-h-dvh bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {/* Urgency bar */}
      {!urgencyDismissed && (
        <div className="bg-gradient-to-r from-green-600 to-emerald-600 text-white">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-2.5">
            <p className="text-sm font-medium">
              ⚽ <strong>World Cup 2026 is live.</strong> UK bookmakers are releasing new offers daily. Start profiting now.
            </p>
            <div className="flex items-center gap-3">
              <Link
                href="/signup"
                className="rounded-lg bg-white px-4 py-1.5 text-xs font-bold text-green-700 hover:bg-green-50 transition-colors"
              >
                Free Trial →
              </Link>
              <button
                onClick={() => setUrgencyDismissed(true)}
                className="text-white/70 hover:text-white text-sm"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Navigation */}
      <nav className="border-b border-gray-200 bg-white/90 backdrop-blur-md dark:border-gray-800 dark:bg-gray-950/90 sticky top-0 z-50">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2">
            <span className="rounded-lg bg-green-600 p-2 text-white font-bold text-lg">WC</span>
            <span className="text-xl font-bold tracking-tight">MatchProfit</span>
          </Link>
          <div className="hidden md:flex items-center gap-6">
            <a href="#matches" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100">Matches</a>
            <a href="#offers" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100">Offers</a>
            <a href="#how-it-works" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100">How it works</a>
            <a href="#faq" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100">FAQ</a>
            <Link href="/oddsmatcher" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100">Oddsmatcher</Link>
            <Link href="/calculator" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100">Calculator</Link>
            <Link href="/signup" className="rounded-lg bg-green-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-green-700 transition-colors">
              Free Trial
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden pt-20 pb-16 md:pt-28 md:pb-20 bg-gradient-to-br from-green-700 via-emerald-600 to-teal-700">
        <div className="absolute inset-0 -z-10 opacity-10">
          <div className="absolute -top-24 -right-24 h-96 w-96 rounded-full bg-white blur-3xl" />
          <div className="absolute -bottom-24 -left-24 h-96 w-96 rounded-full bg-yellow-300 blur-3xl" />
        </div>
        <div className="mx-auto max-w-7xl px-6 text-center">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/20 px-4 py-1.5 text-sm font-medium text-white backdrop-blur-sm mb-6">
            <span className="h-2 w-2 rounded-full bg-green-300 animate-pulse" />
            World Cup 2026 — Now Live
          </div>
          <h1 className="mx-auto max-w-3xl text-4xl font-extrabold tracking-tight text-white sm:text-5xl lg:text-6xl">
            The World Cup is Here. <span className="text-yellow-300">Time to Profit.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-green-100 sm:text-xl">
            Bookmakers are giving away millions in World Cup promotions. Bet insurance, enhanced odds,
            acca boosts — MatchProfit finds them all and shows you exactly how to cash in.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/signup"
              className="rounded-xl bg-white px-8 py-3.5 text-base font-semibold text-green-700 shadow-lg hover:bg-green-50 transition-all"
            >
              Start Your Free Trial →
            </Link>
            <a
              href="#matches"
              className="rounded-xl border border-white/30 px-8 py-3.5 text-base font-semibold text-white hover:bg-white/10 transition-colors"
            >
              View WC Matches
            </a>
          </div>
          <p className="mt-4 text-sm text-green-200">⭐ Already used by 1,000+ matched bettors</p>
        </div>
      </section>

      {/* Opportunity Stats */}
      <section className="py-12 border-b border-gray-200 dark:border-gray-800">
        <div className="mx-auto max-w-7xl px-6">
          <div className="text-center mb-8">
            <h2 className="text-2xl font-bold">£250–£500+ in Risk-Free Profit</h2>
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              The World Cup is the single most lucrative event of the year for matched betting.
            </p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {[
              { value: "64", label: "Matches → 64+ profit opportunities" },
              { value: "£250–£500", label: "Estimated profit for active users" },
              { value: "£100", label: "Minimum bankroll to start" },
              { value: "Tax-free", label: "Keep every penny" },
            ].map((stat) => (
              <div key={stat.label} className="text-center">
                <p className="text-2xl font-bold text-green-600">{stat.value}</p>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Live Matches */}
      <section id="matches" className="py-16">
        <div className="mx-auto max-w-7xl px-6">
          <h2 className="text-2xl font-bold">🏆 World Cup Matches & Odds</h2>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            Live odds from major bookmakers. Arbitrage opportunities highlighted.
          </p>

          {loading ? (
            <div className="mt-8 text-center animate-pulse text-gray-400">Loading World Cup matches...</div>
          ) : matches.length === 0 ? (
            <div className="mt-8 rounded-2xl border border-gray-200 bg-gray-50 p-12 text-center dark:border-gray-800 dark:bg-gray-900/50">
              <p className="text-lg font-semibold">No upcoming World Cup matches right now</p>
              <p className="mt-2 text-gray-500">Check back closer to match days for live odds.</p>
            </div>
          ) : (
            <div className="mt-8 space-y-3">
              {matches.map((match) => {
                const arb = match.bestArbitrage;
                return (
                  <div
                    key={match.id}
                    className={`rounded-2xl border-2 p-5 shadow-sm transition-shadow hover:shadow-md ${
                      arb?.isProfitable
                        ? "border-green-300 bg-green-50/50 dark:border-green-800 dark:bg-green-950/20"
                        : "border-amber-200 bg-amber-50/30 dark:border-amber-800 dark:bg-amber-950/10"
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-700 dark:bg-green-900/50 dark:text-green-400">
                            🏆 World Cup
                          </span>
                          <span className="text-xs text-gray-500">{formatTime(match.commenceTime)}</span>
                        </div>
                        <h3 className="mt-1 text-lg font-semibold">
                          {match.homeTeam} vs {match.awayTeam}
                        </h3>
                      </div>

                      {arb && (
                        <div className="text-right">
                          <p className="text-sm text-gray-500">Best: {arb.outcomeName}</p>
                          <p className={`text-lg font-bold ${arb.isProfitable ? "text-green-600" : "text-amber-600"}`}>
                            {arb.profitPercent > 0 ? "+" : ""}{arb.profitPercent}%
                          </p>
                          <p className="text-xs text-gray-500">{arb.backBookmaker} → {arb.layExchange}</p>
                        </div>
                      )}
                    </div>

                    {/* Odds grid */}
                    <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-2">
                      {match.outcomes.slice(0, 3).map((outcome) => {
                        const bestBack = outcome.backOdds.reduce((a, b) => (a.odds > b.odds ? a : b));
                        return (
                          <div key={outcome.name} className="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
                            <p className="text-xs font-medium text-gray-500 truncate">{outcome.name}</p>
                            <div className="mt-1 flex items-center justify-between">
                              <span className="text-sm font-bold text-gray-900 dark:text-gray-100">{bestBack.odds.toFixed(2)}</span>
                              <span className="text-xs text-gray-500">{bestBack.bookmaker}</span>
                            </div>
                            {outcome.layOdds && (
                              <div className="mt-0.5 flex items-center justify-between">
                                <span className="text-sm text-gray-600 dark:text-gray-400">{outcome.layOdds.odds.toFixed(2)}</span>
                                <span className="text-xs text-gray-500">{outcome.layOdds.exchange}</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    <Link
                      href={`/calculator?stake=10&back=${encodeURIComponent(String(match.outcomes[0]?.backOdds[0]?.odds || 2))}&lay=${encodeURIComponent(String(match.outcomes[0]?.layOdds?.odds || 2))}`}
                      className="mt-3 inline-block text-sm font-medium text-indigo-600 hover:text-indigo-700"
                    >
                      Calculate profit for this match →
                    </Link>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Offer Types */}
      <section id="offers" className="py-16 bg-gray-50 dark:bg-gray-900/50">
        <div className="mx-auto max-w-7xl px-6">
          <h2 className="text-2xl font-bold text-center">World Cup Offer Types We Cover</h2>
          <p className="mt-2 text-center text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
            Every type of World Cup promotion tracked and calculated for you.
          </p>
          <div className="mt-10 overflow-x-auto">
            <table className="w-full max-w-3xl mx-auto">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-800">
                  <th className="pb-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">Offer Type</th>
                  <th className="pb-3 text-right text-sm font-semibold text-gray-900 dark:text-gray-100">Profit Per Offer</th>
                  <th className="pb-3 text-right text-sm font-semibold text-gray-900 dark:text-gray-100">Frequency</th>
                </tr>
              </thead>
              <tbody>
                {OFFER_TYPES.map((offer) => (
                  <tr key={offer.name} className="border-b border-gray-100 dark:border-gray-800">
                    <td className="py-3 text-sm">{offer.icon} {offer.name}</td>
                    <td className="py-3 text-right text-sm font-semibold text-green-600">{offer.profit}</td>
                    <td className="py-3 text-right text-sm text-gray-500">{offer.freq}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="py-16">
        <div className="mx-auto max-w-7xl px-6">
          <h2 className="text-2xl font-bold text-center">How World Cup Matched Betting Works</h2>
          <div className="mt-12 grid grid-cols-1 gap-8 md:grid-cols-3">
            <div className="text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-green-500 to-emerald-600 text-2xl font-bold text-white shadow-lg">
                1
              </div>
              <h3 className="mt-6 text-lg font-semibold">See Every World Cup Offer</h3>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                Our live offer scanner monitors 20+ bookmakers for World Cup promotions.
              </p>
            </div>
            <div className="text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-green-500 to-emerald-600 text-2xl font-bold text-white shadow-lg">
                2
              </div>
              <h3 className="mt-6 text-lg font-semibold">Follow the Calculator</h3>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                Pre-calculated stakes for every offer. Enter odds, get exact back and lay amounts.
              </p>
            </div>
            <div className="text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-green-500 to-emerald-600 text-2xl font-bold text-white shadow-lg">
                3
              </div>
              <h3 className="mt-6 text-lg font-semibold">Collect Your Winnings</h3>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                Matched positions cancel out and profit lands in your account. Up to £500 by the final.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Why MatchProfit */}
      <section className="py-16 bg-gradient-to-br from-green-700 to-emerald-700 text-white">
        <div className="mx-auto max-w-7xl px-6">
          <h2 className="text-2xl font-bold text-center">Why MatchProfit for the World Cup?</h2>
          <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { title: "Real-Time Offer Alerts", desc: "Get notified the moment a profitable World Cup offer goes live." },
              { title: "Automatic Calculator", desc: "Handles enhanced odds, acca boosts, each-way, and in-play offers." },
              { title: "Profit Tracker", desc: "Track every World Cup offer you've completed in one dashboard." },
              { title: "Beginner-Friendly", desc: "If you can follow a recipe, you can do this. Guides for every offer type." },
              { title: "UK & Ireland Focused", desc: "All offers from UK/IE bookmakers. Tax-free for both countries." },
              { title: "Live Oddsmatcher", desc: "Compare odds across bookmakers and exchanges in real time." },
            ].map((item) => (
              <div key={item.title} className="rounded-xl bg-white/10 p-6 backdrop-blur-sm">
                <h3 className="font-semibold">{item.title}</h3>
                <p className="mt-2 text-sm text-green-100">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="py-16">
        <div className="mx-auto max-w-3xl px-6">
          <h2 className="text-2xl font-bold text-center">FAQ — World Cup Matched Betting</h2>
          <div className="mt-8 space-y-3">
            {FAQS.map((faq, i) => (
              <div key={i} className="rounded-xl border border-gray-200 overflow-hidden dark:border-gray-800">
                <button
                  onClick={() => setFaqOpen(faqOpen === i ? null : i)}
                  className="flex w-full items-center justify-between px-6 py-4 text-left text-sm font-semibold hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors"
                >
                  {faq.q}
                  <svg className={`h-5 w-5 flex-shrink-0 text-gray-500 transition-transform ${faqOpen === i ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {faqOpen === i && (
                  <div className="px-6 pb-4 text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{faq.a}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 bg-gradient-to-br from-green-600 to-emerald-700">
        <div className="mx-auto max-w-3xl px-6 text-center">
          <h2 className="text-3xl font-bold text-white sm:text-4xl">
            The World Cup Only Happens Every Four Years. Don't Miss Out.
          </h2>
          <p className="mt-4 text-lg text-green-100">
            Join hundreds of matched bettors who'll be profiting from every matchday. First 7 days free.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/signup"
              className="rounded-xl bg-white px-8 py-3.5 text-base font-semibold text-green-700 shadow-lg hover:bg-green-50 transition-all"
            >
              Start Your Free Trial →
            </Link>
            <Link
              href="/oddsmatcher"
              className="rounded-xl border border-white/30 px-8 py-3.5 text-base font-semibold text-white hover:bg-white/10 transition-colors"
            >
              View All Matches
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
        <div className="mx-auto max-w-7xl px-6 py-8 text-center text-sm text-gray-500">
          <p>&copy; {new Date().getFullYear()} MatchProfit. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}