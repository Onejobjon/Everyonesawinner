import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [faqOpen, setFaqOpen] = useState<number | null>(null);

  const scrollTo = (id: string) => {
    setMobileMenuOpen(false);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="min-h-dvh bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-gray-200/80 bg-white/90 backdrop-blur-md dark:border-gray-800/80 dark:bg-gray-950/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <a href="/" className="flex items-center gap-2">
            <span className="rounded-lg bg-indigo-600 p-2 text-white font-bold text-lg">
              MP
            </span>
            <span className="text-xl font-bold tracking-tight">
              EveryoneMatchProfit#39;s A Winner
            </span>
          </a>

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-8">
            <a
              href="/world-cup"
              className="text-sm font-semibold text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300 transition-colors"
            >
              🏆 World Cup
            </a>
            <button
              onClick={() => scrollTo("features")}
              className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition-colors"
            >
              Features
            </button>
            <button
              onClick={() => scrollTo("how-it-works")}
              className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition-colors"
            >
              How it works
            </button>
            <button
              onClick={() => scrollTo("pricing")}
              className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition-colors"
            >
              Pricing
            </button>
            <button
              onClick={() => scrollTo("faq")}
              className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition-colors"
            >
              FAQ
            </button>
            <a
              href="/calculator"
              className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 transition-colors"
            >
              Try the Calculator
            </a>
          </div>

          {/* Mobile hamburger */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden p-2 text-gray-600 dark:text-gray-400"
            aria-label="Toggle menu"
          >
            <svg
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              {mobileMenuOpen ? (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              ) : (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 6h16M4 12h16M4 18h16"
                />
              )}
            </svg>
          </button>
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-6 pb-4 pt-2 space-y-2">
            <a
              href="/world-cup"
              className="block w-full text-left py-2 text-sm font-semibold text-green-600 hover:text-green-700 dark:text-green-400"
            >
              🏆 World Cup 2026
            </a>
            <button
              onClick={() => scrollTo("features")}
              className="block w-full text-left py-2 text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
            >
              Features
            </button>
            <button
              onClick={() => scrollTo("how-it-works")}
              className="block w-full text-left py-2 text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
            >
              How it works
            </button>
            <button
              onClick={() => scrollTo("pricing")}
              className="block w-full text-left py-2 text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
            >
              Pricing
            </button>
            <button
              onClick={() => scrollTo("faq")}
              className="block w-full text-left py-2 text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
            >
              FAQ
            </button>
            <a
              href="/calculator"
              className="block text-center rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Try the Calculator
            </a>
          </div>
        )}
      </nav>

      {/* Hero Section */}
      <section className="relative overflow-hidden pt-32 pb-20 md:pt-40 md:pb-28">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(45%_40%_at_50%_60%,rgba(99,102,241,0.12),transparent)]" />
        <div className="mx-auto max-w-7xl px-6 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-4 py-1.5 text-sm font-medium text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-300 mb-8">
            <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
            Legal &bull; Low-risk &bull; Tax-free
          </div>
          <h1 className="mx-auto max-w-4xl text-4xl font-extrabold tracking-tight sm:text-6xl lg:text-7xl">
            Turn{" "}
            <span className="bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
              Free Bets
            </span>{" "}
            Into Guaranteed Profit
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-gray-600 dark:text-gray-400 sm:text-xl">
            EveryoneMatchProfit#39;s A Winner finds and executes matched betting opportunities
            automatically. No gambling, no risk — just consistent, tax-free income
            from promotional offers.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href="/calculator"
              className="rounded-xl bg-indigo-600 px-8 py-3.5 text-base font-semibold text-white shadow-lg shadow-indigo-600/25 hover:bg-indigo-700 transition-all hover:shadow-xl hover:shadow-indigo-600/30"
            >
              Try the Profit Calculator
            </a>
            <button
              onClick={() => scrollTo("how-it-works")}
              className="rounded-xl border border-gray-300 px-8 py-3.5 text-base font-semibold text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900 transition-colors"
            >
              How it works
            </button>
          </div>

          {/* Stats */}
          <div className="mt-16 grid grid-cols-1 gap-8 sm:grid-cols-3 border-y border-gray-200 dark:border-gray-800 py-8">
            <div>
              <p className="text-3xl font-bold text-indigo-600">£500+</p>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                Average monthly profit per user
              </p>
            </div>
            <div>
              <p className="text-3xl font-bold text-indigo-600">50,000+</p>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                Offers matched monthly
              </p>
            </div>
            <div>
              <p className="text-3xl font-bold text-indigo-600">99.8%</p>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                Success rate on matched bets
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="py-20 md:py-28 bg-gray-50 dark:bg-gray-900/50">
        <div className="mx-auto max-w-7xl px-6">
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Everything you need to profit
            </h2>
            <p className="mt-4 text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
              Our platform handles the complex maths so you can focus on collecting
              your earnings.
            </p>
          </div>
          <div className="mt-16 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                title: "Oddsmatcher",
                desc: "Instantly compare back and lay odds across 50+ bookmakers and exchanges to find the best arbitrage opportunities.",
                icon: (
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                ),
              },
              {
                title: "Profit Calculator",
                desc: "Enter stake, odds and commission to instantly calculate guaranteed profit, lay stake and total return for any matched bet.",
                icon: (
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                ),
              },
              {
                title: "Offer Alerts",
                desc: "Get notified the moment new profitable offers go live. Never miss a sign-up bonus, free bet, or enhanced odds promotion.",
                icon: (
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                  </svg>
                ),
              },
              {
                title: "Auto Calculation",
                desc: "Enter your back and lay odds once and our tool calculates the exact lay stake and qualifying loss — optimised for maximum profit.",
                icon: (
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                ),
              },
              {
                title: "Sign-Up Journey",
                desc: "Guided walkthroughs for every bookmaker sign-up offer. Know exactly which accounts to open and in what order to maximise value.",
                icon: (
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                ),
              },
              {
                title: "Profit Tracking",
                desc: "Dashboard showing your total earnings, active bets, and monthly profit trends. Know exactly how much you're making at a glance.",
                icon: (
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 8v8m-4-5v5m-4-2v2m-2 4h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                ),
              },
            ].map((feature) => (
              <div
                key={feature.title}
                className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm hover:shadow-md transition-shadow dark:border-gray-800 dark:bg-gray-950"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400">
                  {feature.icon}
                </div>
                <h3 className="mt-6 text-lg font-semibold">{feature.title}</h3>
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                  {feature.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="py-20 md:py-28">
        <div className="mx-auto max-w-7xl px-6">
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              How matched betting works
            </h2>
            <p className="mt-4 text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
              It's simpler than you think. Here's the four-step formula to
              risk-free profits.
            </p>
          </div>
          <div className="mt-16 grid grid-cols-1 gap-8 md:grid-cols-4">
            {[
              {
                step: "01",
                title: "Sign up",
                desc: "Create accounts at bookmakers through our curated sign-up links. Many offer free bets just for joining.",
              },
              {
                step: "02",
                title: "Place your back bet",
                desc: "Use the free bet or qualifying offer at the bookmaker on a selection with good odds.",
              },
              {
                step: "03",
                title: "Place your lay bet",
                desc: "Bet against the same outcome on a betting exchange. Our calculator tells you exactly how much to stake.",
              },
              {
                step: "04",
                title: "Collect your profit",
                desc: "One outcome wins, the other loses — but you've hedged so perfectly that you profit either way.",
              },
            ].map((item) => (
              <div key={item.step} className="relative text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 text-xl font-bold text-white shadow-lg shadow-indigo-500/25">
                  {item.step}
                </div>
                <h3 className="mt-6 text-lg font-semibold">{item.title}</h3>
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                  {item.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-20 md:py-28 bg-gray-50 dark:bg-gray-900/50">
        <div className="mx-auto max-w-7xl px-6">
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Simple, transparent pricing
            </h2>
            <p className="mt-4 text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
              Start making money today. All plans include a 7-day free trial.
            </p>
          </div>
          <div className="mt-16 grid grid-cols-1 gap-8 lg:grid-cols-3 max-w-5xl mx-auto">
            {[
              {
                name: "Starter",
                price: "£9.99",
                period: "/month",
                desc: "Perfect for beginners getting started with matched betting.",
                features: [
                  "Profit calculator",
                  "10 offer alerts/month",
                  "Basic oddsmatcher",
                  "Email support",
                  "Guides & tutorials",
                ],
                cta: "Start free trial",
                popular: false,
              },
              {
                name: "Pro",
                price: "£19.99",
                period: "/month",
                desc: "For regular users maximising their monthly earnings.",
                features: [
                  "Everything in Starter",
                  "Unlimited offer alerts",
                  "Advanced oddsmatcher",
                  "Auto-calculation",
                  "Profit dashboard",
                  "Priority email support",
                  "Sign-up journey guides",
                ],
                cta: "Start free trial",
                popular: true,
              },
              {
                name: "Annual",
                price: "£199",
                period: "/year",
                desc: "Best value. Save £40 compared to monthly Pro.",
                features: [
                  "Everything in Pro",
                  "2 months free",
                  "Early access to new features",
                  "Priority support",
                ],
                cta: "Start free trial",
                popular: false,
              },
            ].map((plan) => (
              <div
                key={plan.name}
                className={`relative rounded-2xl border-2 p-8 shadow-sm ${
                  plan.popular
                    ? "border-indigo-500 bg-white shadow-indigo-200 dark:bg-gray-950 dark:shadow-indigo-950"
                    : "border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950"
                }`}
              >
                {plan.popular && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-indigo-600 px-4 py-1 text-xs font-semibold text-white">
                    Most popular
                  </span>
                )}
                <h3 className="text-lg font-semibold">{plan.name}</h3>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="text-4xl font-extrabold">{plan.price}</span>
                  <span className="text-sm text-gray-500">{plan.period}</span>
                </div>
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                  {plan.desc}
                </p>
                <ul className="mt-8 space-y-3">
                  {plan.features.map((feat) => (
                    <li key={feat} className="flex items-center gap-3 text-sm">
                      <svg
                        className="h-5 w-5 flex-shrink-0 text-green-500"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                      {feat}
                    </li>
                  ))}
                </ul>
                <button
                  className={`mt-8 w-full rounded-xl py-3 text-sm font-semibold transition-all ${
                    plan.popular
                      ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/25 hover:bg-indigo-700 hover:shadow-xl hover:shadow-indigo-600/30"
                      : "border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
                  }`}
                >
                  {plan.cta}
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="py-20 md:py-28">
        <div className="mx-auto max-w-3xl px-6">
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Frequently asked questions
            </h2>
            <p className="mt-4 text-lg text-gray-600 dark:text-gray-400">
              Everything you need to know about matched betting.
            </p>
          </div>
          <div className="mt-12 space-y-4">
            {[
              {
                q: "Is matched betting legal?",
                a: "Yes, matched betting is completely legal in the UK and Ireland. You're simply taking advantage of promotional offers that bookmakers choose to provide. It's not gambling — every outcome is mathematically hedged.",
              },
              {
                q: "How much money can I make?",
                a: "Most users earn £300-£800 per month in their first few months. Experienced users can earn £1,000+ monthly by cycling through reload offers across multiple bookmakers.",
              },
              {
                q: "Do I need any experience?",
                a: "Not at all. Our platform is designed for absolute beginners. The calculators do all the maths, and our guides walk you through every step of your first matched bet.",
              },
              {
                q: "Is the profit really tax-free?",
                a: "In the UK and Ireland, gambling winnings are not subject to income tax. Since matched betting is classified as gambling for tax purposes, your profits are completely tax-free — no HMRC reporting required.",
              },
              {
                q: "How much money do I need to start?",
                a: "We recommend starting with £100-£200. This gives you enough capital to work through sign-up offers. You'll see that initial stake returned as profit within your first few bets.",
              },
              {
                q: "What is the difference between back and lay bets?",
                a: "A back bet is a traditional bet — you're betting on something to happen. A lay bet is betting on something NOT to happen, placed on a betting exchange like Betfair. Combined correctly, they guarantee profit regardless of outcome.",
              },
            ].map((faq, i) => (
              <div
                key={i}
                className="rounded-xl border border-gray-200 overflow-hidden dark:border-gray-800"
              >
                <button
                  onClick={() => setFaqOpen(faqOpen === i ? null : i)}
                  className="flex w-full items-center justify-between px-6 py-4 text-left text-sm font-semibold hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors"
                >
                  {faq.q}
                  <svg
                    className={`h-5 w-5 flex-shrink-0 text-gray-500 transition-transform ${
                      faqOpen === i ? "rotate-180" : ""
                    }`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </button>
                {faqOpen === i && (
                  <div className="px-6 pb-4 text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                    {faq.a}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 md:py-28 bg-gradient-to-br from-indigo-600 to-purple-700">
        <div className="mx-auto max-w-3xl px-6 text-center">
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Start turning free bets into profit today
          </h2>
          <p className="mt-4 text-lg text-indigo-100">
            Join thousands of users who make consistent, tax-free income with
            EveryoneMatchProfit#39;s A Winner. Your first 7 days are on us.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href="/calculator"
              className="rounded-xl bg-white px-8 py-3.5 text-base font-semibold text-indigo-700 shadow-lg hover:bg-indigo-50 transition-all"
            >
              Try the Calculator — Free
            </a>
            <button
              onClick={() => scrollTo("how-it-works")}
              className="rounded-xl border border-white/30 px-8 py-3.5 text-base font-semibold text-white hover:bg-white/10 transition-colors"
            >
              Learn more
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/50">
        <div className="mx-auto max-w-7xl px-6 py-12">
          <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
            <div className="col-span-2 md:col-span-1">
              <div className="flex items-center gap-2">
                <span className="rounded-lg bg-indigo-600 p-1.5 text-white font-bold text-sm">
                  MP
                </span>
                <span className="text-lg font-bold tracking-tight">
                  EveryoneMatchProfit#39;s A Winner
                </span>
              </div>
              <p className="mt-3 text-sm text-gray-600 dark:text-gray-400 max-w-xs">
                Turn free bets into guaranteed, tax-free profit. Matched betting
                made simple.
              </p>
            </div>
            <div>
              <h4 className="text-sm font-semibold">Product</h4>
              <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400">
                <li>
                  <button onClick={() => scrollTo("features")} className="hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
                    Features
                  </button>
                </li>
                <li>
                  <button onClick={() => scrollTo("pricing")} className="hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
                    Pricing
                  </button>
                </li>
                <li>
                  <a href="/world-cup" className="hover:text-green-600 dark:hover:text-green-400 transition-colors font-semibold text-green-600 dark:text-green-400">
                    🏆 World Cup
                  </a>
                </li>
                <li>
                  <a href="/calculator" className="hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
                    Calculator
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="text-sm font-semibold">Learn</h4>
              <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400">
                <li>
                  <button onClick={() => scrollTo("how-it-works")} className="hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
                    How it works
                  </button>
                </li>
                <li>
                  <button onClick={() => scrollTo("faq")} className="hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
                    FAQ
                  </button>
                </li>
                <li>
                  <span className="cursor-default">Guides (coming soon)</span>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="text-sm font-semibold">Company</h4>
              <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400">
                <li>
                  <span className="cursor-default">About</span>
                </li>
                <li>
                  <span className="cursor-default">Contact</span>
                </li>
                <li>
                  <span className="cursor-default">Privacy</span>
                </li>
                <li>
                  <span className="cursor-default">Terms</span>
                </li>
              </ul>
            </div>
          </div>
          <div className="mt-12 border-t border-gray-200 pt-8 text-center text-sm text-gray-500 dark:border-gray-800 dark:text-gray-500">
            <p>&copy; {new Date().getFullYear()} EveryoneMatchProfit#39;s A Winner. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}