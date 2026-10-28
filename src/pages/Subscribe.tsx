import { Link } from "react-router-dom";
import { useAuth, type Plan } from "../lib/auth";

const plans: {
  id: Plan;
  name: string;
  price: string;
  period: string;
  desc: string;
  features: string[];
  popular: boolean;
}[] = [
  {
    id: "starter",
    name: "Starter",
    price: "£19.99",
    period: "/month (planned)",
    desc: "The oddsmatcher and the calculator.",
    features: [
      "Best Odds Finder (oddsmatcher)",
      "Profit calculator with lay stake and liability",
      "The licence-checked free-bets list",
    ],
    popular: false,
  },
  {
    id: "pro",
    name: "Pro",
    price: "£29.99",
    period: "/month (planned)",
    desc: "Adds the two lay tools.",
    features: [
      "Everything in Starter",
      "Lay Bet Finder — close single lays, searched on demand",
      "Acca Lay Planner — 2–4 leg lay plans",
    ],
    popular: true,
  },
  {
    id: "annual",
    name: "Annual",
    price: "£199",
    period: "/year (planned)",
    desc: "Twelve months of Pro at the same tools.",
    features: [
      "Everything in Pro",
      "One payment for the year instead of twelve",
    ],
    popular: false,
  },
];

export default function Subscribe() {
  const { user } = useAuth();


  if (!user) {
    return (
      <div className="min-h-dvh page-bg font-['Inter',system-ui,sans-serif] flex items-center justify-center">
        <div className="text-center">
          <span className="text-5xl">🔒</span>
          <h1 className="mt-4 text-2xl font-bold">Sign in to subscribe</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">Create an account or sign in to choose a plan.</p>
          <div className="mt-6 flex gap-4 justify-center">
            <Link to="/login" className="rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white">Sign in</Link>
            <Link to="/signup" className="rounded-lg border border-gray-300 px-6 py-3 text-sm font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-300">Create account</Link>
          </div>
        </div>
      </div>
    );
  }

  if (user?.subscription) {
    return (
      <div className="min-h-dvh page-bg font-['Inter',system-ui,sans-serif] flex items-center justify-center">
        <div className="text-center">
          <span className="text-5xl">✅</span>
          <h1 className="mt-4 text-2xl font-bold">You're already subscribed!</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">Your plan is active. Head to the dashboard to start using the tools.</p>
          <Link to="/dashboard" className="mt-6 inline-block rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white">Go to Dashboard</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh page-bg font-['Inter',system-ui,sans-serif]">
      <nav className="border-b border-gray-200 bg-white/90 dark:border-gray-800 dark:bg-gray-950/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2">
            <span className="rounded-lg bg-indigo-600 p-2 text-white font-bold text-lg">EAW</span>
            <span className="text-xl font-bold tracking-tight">Everyone's A Winner</span>
          </Link>
          <Link to="/dashboard" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">Dashboard →</Link>
        </div>
      </nav>

      <div className="mx-auto max-w-5xl px-6 py-16">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Choose your plan</h1>
          <p className="mt-4 text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
            These are the plans we intend to offer. Play isn't open yet — we're finishing the payment setup, and nothing can be charged until it does.
            <br />
            <span className="text-sm">Starter includes the oddsmatcher and calculator. Pro adds the Lay Bet Finder and the Acca Lay Planner.</span>
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-8 lg:grid-cols-3">
          {plans.map((plan, i) => (
            <div
              key={i}
              className={`relative rounded-2xl border-2 p-8 shadow-sm ${
                plan.popular
                  ? "border-indigo-500 bg-white shadow-indigo-200 dark:bg-gray-950"
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
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{plan.desc}</p>
              <ul className="mt-6 space-y-3">
                {plan.features.map((feat, j) => (
                  <li key={j} className="flex items-center gap-3 text-sm">
                    <svg className="h-5 w-5 flex-shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    {feat}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                disabled
                aria-disabled="true"
                className="mt-6 w-full cursor-not-allowed rounded-xl border border-gray-300 py-3 text-sm font-semibold text-gray-400 dark:border-gray-700 dark:text-gray-500"
              >
                Checkout opens shortly
              </button>
              <p className="mt-2 text-xs text-gray-400 text-center">
                Nothing can be charged until checkout opens.
              </p>
            </div>
          ))}
        </div>

        <div className="mt-12 text-center border-t border-gray-200 dark:border-gray-800 pt-8">
          <p className="text-sm text-gray-500">
            Checkout isn't open yet. When it is, a completed payment will be confirmed by our server before any tool unlocks — not by this page.
          </p>
          <p className="mt-2 text-sm text-gray-500">
            Questions? <a href="mailto:support@everyonesawinner.uk" className="text-indigo-600 hover:text-indigo-700">Contact support</a>
          </p>
        </div>
      </div>
    </div>
  );
}