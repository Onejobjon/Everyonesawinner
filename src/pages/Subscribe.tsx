import { Link } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import { useAuth, type Plan } from "../lib/auth";

const plans: {
  id: Plan;
  name: string;
  price: string;
  period: string;
  desc: string;
  features: string[];
  /** A reason for the highlight, never a popularity claim — we have zero customers. */
  badge?: string;
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
      "Dashboard with the instant-wins feed and your greens history",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: "£29.99",
    period: "/month (planned)",
    desc: "Adds the three Pro-only tools.",
    features: [
      "Everything in Starter",
      "Lay Bet Finder — close single lays, searched on demand",
      "Acca Lay Planner — 2–4 leg lay plans",
    ],
    badge: "Best value for the tools you get",
  },
  {
    id: "annual",
    name: "Annual",
    price: "£269.99",
    period: "/year (planned)",
    desc: "Twelve months of Pro at the same tools.",
    features: [
      "Everything in Pro",
      "One payment for the year instead of twelve",
    ],
  },
];

export default function Subscribe() {
  const { user } = useAuth();


  if (!user) {
    return (
      <PageHeader title="Sign in to subscribe" subtitle="Create an account or sign in to choose a plan.">
        <div className="text-center">
          <div className="mt-6 flex gap-4 justify-center">
            <Link to="/login" className="rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white">Sign in</Link>
            <Link to="/signup" className="rounded-lg border border-gray-300 px-6 py-3 text-sm font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-300">Create account</Link>
          </div>
        </div>
      </PageHeader>
    );
  }

  if (user?.entitled) {
    return (
      <PageHeader title="You're already subscribed!" subtitle="Your plan is active. Head to the dashboard to start using the tools.">
        <Link to="/dashboard" className="mt-6 inline-block rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white">Go to Dashboard</Link>
      </PageHeader>
    );
  }

  return (
    <PageHeader
      title="Choose your plan"
      subtitle={
        <>
          These are the plans we intend to offer. Play isn't open yet — we're finishing the payment setup, and no payment can be taken until it does.
          <span className="mt-2 block text-sm">
            Starter includes the oddsmatcher, the calculator and the dashboard. Pro adds the Lay Bet Finder, the Bet Builder and the Same-Match Planner.
          </span>
        </>
      }
    >
        <div className="mt-4 grid grid-cols-1 gap-8 lg:grid-cols-3">
          {plans.map((plan, i) => (
            <div
              key={i}
              className={`relative rounded-2xl border-2 p-8 shadow-sm ${
                plan.badge
                  ? "border-indigo-500 bg-white shadow-indigo-200 dark:bg-gray-950"
                  : "border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950"
              }`}
            >
              {plan.badge && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-indigo-600 px-4 py-1 text-xs font-semibold text-white">
                  {plan.badge}
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
                No payment can be taken until checkout opens.
              </p>
            </div>
          ))}
        </div>

        {/* How to cancel, at the point of sale. The old terms promised this
            would be here before anyone paid; it is here now. Cancellation is by
            EMAIL because there is no self-serve cancel route in the code, and
            nothing here claims otherwise. */}
        <div className="mt-12 rounded-2xl border border-gray-200 bg-gray-50 p-6 text-left dark:border-gray-800 dark:bg-gray-900/50">
          <h2 className="text-lg font-semibold">How to cancel</h2>
          <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-400">
            Every plan renews automatically until you cancel it. To cancel, email{" "}
            <a href="mailto:support@everyonesawinner.uk" className="text-indigo-600 underline hover:text-indigo-700">
              support@everyonesawinner.uk
            </a>{" "}
            from the address on your account. There is no cancel button in the account area yet, so email is how it
            is done — a clear message is enough, and you don't have to give a reason.
          </p>
          <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-400">
            Cancelling stops future billing. Your access continues to the end of the period you've already paid for.
          </p>
          <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-400">
            You also have a 14-day right to cancel a new subscription. Our{" "}
            <Link to="/terms" className="text-indigo-600 underline hover:text-indigo-700">
              terms of use
            </Link>{" "}
            set out that right, what happens if a payment fails, and what we do and don't refund.
          </p>
        </div>

        {/* Trader identity at the point of sale: the Consumer Contracts
            Regulations require the trader's name and a geographic address
            before anyone can order, and the prices must be honest about VAT. */}
        <div className="mt-8 rounded-2xl border border-gray-200 bg-white p-6 text-left dark:border-gray-800 dark:bg-gray-900/40">
          <h2 className="text-lg font-semibold">Who you would be paying</h2>
          <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-400">
            Everyone's A Winner is the trading name of Jonathan Revill, a sole trader, of 3
            Clanmaghery Grove, Ballykinler, Downpatrick, BT30 8EX, in the United Kingdom. We are not
            a registered company, so there is no company number. We are not registered for VAT, so
            no VAT is added to any price shown on this page — the price you see is the whole price.
          </p>
        </div>

        <div className="mt-8 text-center border-t border-gray-200 dark:border-gray-800 pt-8">
          <p className="text-sm text-gray-500">
            Checkout isn't open yet. When it is, a completed payment will be confirmed by our server before any tool unlocks — not by this page.
          </p>
          <p className="mt-2 text-sm text-gray-500">
            Questions? <a href="mailto:support@everyonesawinner.uk" className="text-indigo-600 hover:text-indigo-700">Contact support</a>
          </p>
        </div>
    </PageHeader>
  );
}