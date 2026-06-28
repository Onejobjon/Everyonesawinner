import { Link } from "react-router-dom";
import { useState } from "react";

function Nav() {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-gray-200/80 bg-white/90 backdrop-blur-md dark:border-gray-800/80 dark:bg-gray-950/90">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <Link to="/" className="flex items-center gap-2">
          <span className="rounded-lg bg-indigo-600 p-2 text-white font-bold text-lg">EAW</span>
          <span className="text-xl font-bold tracking-tight">Everyone's A Winner</span>
        </Link>
        <div className="hidden md:flex items-center gap-8">
          <a href="#features" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition-colors">Features</a>
          <a href="#how-it-works" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition-colors">How it works</a>
          <a href="#pricing" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition-colors">Pricing</a>
          <a href="#faq" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition-colors">FAQ</a>
          <Link to="/world-cup" className="text-sm font-medium text-amber-600 hover:text-amber-700 dark:text-amber-400 transition-colors">🏆 World Cup</Link>
          <Link to="/calculator" className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 transition-colors">Try the Calculator</Link>
        </div>
        <button onClick={() => setMenuOpen(!menuOpen)} className="md:hidden p-2 text-gray-600 dark:text-gray-400" aria-label="Toggle menu">
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
      </div>
      {menuOpen && (
        <div className="md:hidden border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-6 py-4 flex flex-col gap-4">
          <a href="#features" className="text-sm font-medium text-gray-600 dark:text-gray-400">Features</a>
          <a href="#how-it-works" className="text-sm font-medium text-gray-600 dark:text-gray-400">How it works</a>
          <a href="#pricing" className="text-sm font-medium text-gray-600 dark:text-gray-400">Pricing</a>
          <a href="#faq" className="text-sm font-medium text-gray-600 dark:text-gray-400">FAQ</a>
          <Link to="/world-cup" className="text-sm font-medium text-amber-600 dark:text-amber-400">🏆 World Cup</Link>
          <Link to="/calculator" className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white text-center">Calculator</Link>
        </div>
      )}
    </nav>
  );
}

function Footer() {
  return (
    <footer className="border-t border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/50">
      <div className="mx-auto max-w-7xl px-6 py-12">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          <div className="col-span-2 md:col-span-1">
            <Link to="/" className="flex items-center gap-2">
              <span className="rounded-lg bg-indigo-600 p-1.5 text-white font-bold text-sm">EAW</span>
              <span className="text-lg font-bold tracking-tight">Everyone's A Winner</span>
            </Link>
            <p className="mt-3 text-sm text-gray-600 dark:text-gray-400 max-w-xs">Turn free bets into guaranteed, tax-free profit. Made simple for everyone.</p>
          </div>
          <div>
            <h4 className="text-sm font-semibold">Product</h4>
            <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400">
              <li><a href="#features" className="hover:text-gray-900 dark:hover:text-gray-100 transition-colors">Features</a></li>
              <li><a href="#pricing" className="hover:text-gray-900 dark:hover:text-gray-100 transition-colors">Pricing</a></li>
              <li><Link to="/calculator" className="hover:text-gray-900 dark:hover:text-gray-100 transition-colors">Calculator</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-semibold">Learn</h4>
            <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400">
              <li><a href="#how-it-works" className="hover:text-gray-900 dark:hover:text-gray-100 transition-colors">How it works</a></li>
              <li><a href="#faq" className="hover:text-gray-900 dark:hover:text-gray-100 transition-colors">FAQ</a></li>
              <li><Link to="/world-cup" className="hover:text-gray-900 dark:hover:text-gray-100 transition-colors">World Cup</Link></li>
              <li><Link to="/oddsmatcher" className="hover:text-gray-900 dark:hover:text-gray-100 transition-colors">Best Odds Finder</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-semibold">Company</h4>
            <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400">
              <li><span className="cursor-default">About</span></li>
              <li><span className="cursor-default">Privacy</span></li>
              <li><span className="cursor-default">Terms</span></li>
            </ul>
          </div>
        </div>
        <div className="mt-12 border-t border-gray-200 pt-8 text-center text-sm text-gray-500 dark:border-gray-800 dark:text-gray-500">
          <p>© {new Date().getFullYear()} Everyone's A Winner. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}

export default function Home() {
  return (
    <div className="min-h-dvh page-bg text-gray-900 dark:text-gray-100 font-['Inter',system-ui,sans-serif]">
      <Nav />
      
      {/* Hero */}
      <section className="relative overflow-hidden pt-32 pb-20 md:pt-40 md:pb-28">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(45%_40%_at_50%_60%,rgba(99,102,241,0.12),transparent)]"></div>
        <div className="mx-auto max-w-7xl px-6 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-4 py-1.5 text-sm font-medium text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-300 mb-8">
            <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse"></span>
            Legal • Low-risk • Tax-free
          </div>
          <h1 className="mx-auto max-w-4xl text-4xl font-extrabold tracking-tight sm:text-6xl lg:text-7xl">
            Turn <span className="bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">Free Bets</span> Into Guaranteed Profit
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-gray-600 dark:text-gray-400 sm:text-xl">
            Everyone's A Winner finds free bet offers and shows you exactly how to turn them into cash. No gambling, no risk — just consistent, tax-free earnings from promotions that bookmakers give away.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link to="/calculator" className="rounded-xl bg-indigo-600 px-8 py-3.5 text-base font-semibold text-white shadow-lg shadow-indigo-600/25 hover:bg-indigo-700 transition-all">Try the Profit Calculator</Link>
            <a href="#how-it-works" className="rounded-xl border border-gray-300 px-8 py-3.5 text-base font-semibold text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900 transition-colors">How it works</a>
          </div>
          <div className="mt-16 grid grid-cols-1 gap-8 sm:grid-cols-3 border-y border-gray-200 dark:border-gray-800 py-8">
            <div><p className="text-3xl font-bold text-indigo-600">£500+</p><p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Average monthly profit per user</p></div>
            <div><p className="text-3xl font-bold text-indigo-600">50,000+</p><p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Offers matched monthly</p></div>
            <div><p className="text-3xl font-bold text-indigo-600">99.8%</p><p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Success rate on matched bets</p></div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-20 md:py-28 bg-gray-50 dark:bg-gray-900/50">
        <div className="mx-auto max-w-7xl px-6">
          <div className="text-center"><h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Everything you need to profit</h2><p className="mt-4 text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">We handle the maths so you can focus on collecting your earnings.</p></div>
          <div className="mt-16 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { icon: "📊", title: "Best Odds Finder", desc: "See the best prices across bookmakers and exchanges at a glance. Find profitable opportunities in seconds." },
              { icon: "💰", title: "Profit Calculator", desc: "Enter your stake and odds to instantly work out your guaranteed profit, exchange stake and total return." },
              { icon: "🔔", title: "Offer Alerts", desc: "Get notified the moment new profitable offers go live. Never miss a sign-up bonus or free bet." },
              { icon: "🧮", title: "Auto Calculation", desc: "Enter your odds once and our tool calculates exactly how much to stake for maximum profit." },
              { icon: "⚡", title: "Sign-Up Journey", desc: "Guided walkthroughs for every bookmaker offer. Know which accounts to open and in what order." },
              { icon: "📈", title: "Profit Tracking", desc: "Dashboard showing your total earnings, active offers, and monthly profit trends at a glance." },
            ].map((f, i) => (
              <div key={i} className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm hover:shadow-md transition-shadow dark:border-gray-800 dark:bg-gray-950">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-100 text-2xl dark:bg-indigo-950">{f.icon}</div>
                <h3 className="mt-6 text-lg font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="py-20 md:py-28">
        <div className="mx-auto max-w-7xl px-6">
          <div className="text-center"><h2 className="text-3xl font-bold tracking-tight sm:text-4xl">How it works</h2><p className="mt-4 text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">It's simpler than you think. Here's how to turn free bets into profit.</p></div>
          <div className="mt-16 grid grid-cols-1 gap-8 md:grid-cols-4">
            {[{n:"01",t:"Sign up",d:"Create an account with a bookmaker through our easy links. Many give you a free bet just for joining."},{n:"02",t:"Place your bet",d:"Use your stake (or free bet) at the bookmaker on a team or outcome with good odds."},{n:"03",t:"Cover your bet",d:"Place a second bet on a betting exchange that balances the first one. Our calculator tells you the exact amount."},{n:"04",t:"Collect your profit",d:"One bet wins, the other loses — but they're balanced so perfectly that you make money either way."}].map((s,i) => (
              <div key={i} className="relative text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 text-xl font-bold text-white shadow-lg shadow-indigo-500/25">{s.n}</div>
                <h3 className="mt-6 text-lg font-semibold">{s.t}</h3>
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{s.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-20 md:py-28 bg-gray-50 dark:bg-gray-900/50">
        <div className="mx-auto max-w-7xl px-6">
          <div className="text-center"><h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Simple, transparent pricing</h2><p className="mt-4 text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">Start making money today. All plans include a 7-day free trial.</p></div>
          <div className="mt-16 grid grid-cols-1 gap-8 lg:grid-cols-3 max-w-5xl mx-auto">
            {[
              {n:"Starter",p:"£9.99",pr:"/month",d:"Perfect for beginners.",f:["Profit calculator","10 offer alerts/month","Best odds finder","Email support","Guides & tutorials"],pop:false},
              {n:"Pro",p:"£19.99",pr:"/month",d:"For regular users maximising earnings.",f:["Everything in Starter","Unlimited offer alerts","Advanced odds finder","Auto-calculation","Profit dashboard","Priority support","Sign-up guides"],pop:true},
              {n:"Annual",p:"£199",pr:"/year",d:"Best value. Save £40.",f:["Everything in Pro","2 months free","Early access","Priority support"],pop:false},
            ].map((plan,i) => (
              <div key={i} className={`relative rounded-2xl border-2 p-8 shadow-sm ${plan.popular ? "border-indigo-500 bg-white shadow-indigo-200 dark:bg-gray-950" : "border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950"}`}>
                {plan.popular && <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-indigo-600 px-4 py-1 text-xs font-semibold text-white">Most popular</span>}
                <h3 className="text-lg font-semibold">{plan.n}</h3>
                <div className="mt-4 flex items-baseline gap-1"><span className="text-4xl font-extrabold">{plan.p}</span><span className="text-sm text-gray-500">{plan.pr}</span></div>
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{plan.d}</p>
                <ul className="mt-8 space-y-3">{plan.f.map((feat,j) => (<li key={j} className="flex items-center gap-3 text-sm"><svg className="h-5 w-5 flex-shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>{feat}</li>))}</ul>
                <a href="https://buy.stripe.com/5kQ7sLf0OdNV7GTenydQQ00" target="_blank" rel="noopener noreferrer" className={`mt-8 w-full rounded-xl py-3 text-sm font-semibold transition-all block text-center ${plan.popular ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/25 hover:bg-indigo-700" : "border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300"}`}>Subscribe - {plan.p}{plan.pr}</a>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="py-20 md:py-28">
        <div className="mx-auto max-w-3xl px-6">
          <div className="text-center"><h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Frequently asked questions</h2><p className="mt-4 text-lg text-gray-600 dark:text-gray-400">Everything you need to know about earning from free bets.</p></div>
          <div className="mt-12 space-y-4">
            {["Is earning from free bets legal?","How much money can I make?","Do I need any experience?","Is the profit really tax-free?","How much money do I need to start?"].map((q,i) => (
              <details key={i} className="rounded-xl border border-gray-200 dark:border-gray-800">
                <summary className="flex cursor-pointer items-center justify-between px-6 py-4 text-sm font-semibold hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors">{q}<svg className="h-5 w-5 flex-shrink-0 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg></summary>
                <div className="px-6 pb-4 text-sm text-gray-600 dark:text-gray-400">{["Yes, it's completely legal in the UK and Ireland. You're simply using promotional offers that bookmakers willingly provide.","Active users average £300-£500/month from welcome offers and £100-£300/month ongoing from daily promotions.","None! You don't need to know anything about sports. Our calculator does all the work for you.","Yes! Gambling winnings in the UK and Ireland are tax-free — no income tax or capital gains tax.","As little as £100-£200. Most offers require only £5-£10 to get started."][i]}</div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 md:py-28 bg-gradient-to-br from-indigo-600 to-purple-700">
        <div className="mx-auto max-w-3xl px-6 text-center">
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">Start turning free bets into profit today</h2>
          <p className="mt-4 text-lg text-indigo-100">Join thousands of users who make consistent, tax-free income with Everyone's A Winner.</p>
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link to="/calculator" className="rounded-xl bg-white px-8 py-3.5 text-base font-semibold text-indigo-700 shadow-lg hover:bg-indigo-50 transition-all">Try the Calculator — Free</Link>
            <a href="#how-it-works" className="rounded-xl border border-white/30 px-8 py-3.5 text-base font-semibold text-white hover:bg-white/10 transition-colors">Learn more</a>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}