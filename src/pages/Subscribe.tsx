import { Link, useSearchParams } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import PlanCheckoutButton, { useBillingReadiness } from "../components/PlanCheckoutButton";
import { useAuth, type Plan } from "../lib/auth";
import { plansForSaleNotice, priceQualifier } from "../lib/checkout-client";

const plans: {
  id: Plan;
  name: string;
  price: string;
  /** "/month" or "/year" — the "(planned)" qualifier is added only while it is true. */
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
    period: "/month",
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
    period: "/month",
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
    period: "/year",
    desc: "Twelve months of Pro at the same tools.",
    features: [
      "Everything in Pro",
      "One payment for the year instead of twelve",
    ],
  },
];

function isPlanId(value: unknown): value is Plan {
  return value === "starter" || value === "pro" || value === "annual";
}

/**
 * /subscribe — the plans, and the one place a plan is chosen.
 *
 * THE BUTTONS ARE REAL NOW (2026-11-05). They used to be `disabled` with
 * "Checkout opens shortly" on every card. Each card now renders
 * <PlanCheckoutButton>, which POSTs to `POST /api/checkout` with that plan and
 * renders the true outcome: a Stripe URL, "sign in first and come back to this
 * plan", or the specific sentence for whatever the endpoint refused with.
 *
 * THE CLAIM IS DERIVED, NOT TYPED. "No plan can be bought yet." and the
 * "(planned)" qualifier beside each price come from `plansForSaleNotice()` /
 * `priceQualifier()`, which read the endpoint's own readiness answer
 * (`GET /api/checkout` → canTakeSubscriptionPayments, the same switch checkout
 * itself reads). The day the flag flips, the sentence and the qualifiers go with
 * it — nobody has to remember to edit this page. The amounts are the owner's and
 * never move.
 */
export default function Subscribe() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const readiness = useBillingReadiness();
  const sale = plansForSaleNotice(readiness);
  const qualifier = priceQualifier(readiness);

  const wanted = searchParams.get("plan");
  const chosenPlan = isPlanId(wanted) ? wanted : null;
  const chosenLabel = chosenPlan ? plans.find((p) => p.id === chosenPlan)?.name ?? null : null;
  const cameBackFromCheckout = searchParams.get("checkout") === "cancelled";

  if (!user) {
    // Keep the plan they picked: /login honours ?redirect= and sends them back to
    // /subscribe?plan=<plan>, where that card is highlighted.
    const back = chosenPlan ? `/subscribe?plan=${chosenPlan}` : "/subscribe";
    return (
      <PageHeader
        title="Sign in to subscribe"
        subtitle={
          chosenLabel
            ? `You picked ${chosenLabel}. Sign in or create an account and you'll come straight back to it.`
            : "Create an account or sign in to choose a plan."
        }
      >
        <div className="text-center">
          <div className="mt-6 flex gap-4 justify-center">
            <Link
              to={`/login?redirect=${encodeURIComponent(back)}`}
              className="rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white"
            >
              Sign in
            </Link>
            <Link
              to={`/signup?redirect=${encodeURIComponent(back)}`}
              className="rounded-lg border border-gray-300 px-6 py-3 text-sm font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-300"
            >
              Create account
            </Link>
          </div>
          <p className="mt-6 text-sm text-gray-500 dark:text-gray-400">
            {sale.headline} {sale.detail}
          </p>
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
          <strong>{sale.headline}</strong> {sale.detail}
          <span className="mt-2 block text-sm">
            Starter includes the oddsmatcher, the calculator and the dashboard. Pro adds the Lay Bet Finder, the Bet Builder and the Same-Match Planner.
          </span>
        </>
      }
    >
        {cameBackFromCheckout && (
          <p className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700 dark:border-gray-800 dark:bg-gray-900/50 dark:text-gray-300">
            You came back from checkout without completing a payment. Nothing was charged and no plan was started —
            you can choose a plan again whenever you like.
          </p>
        )}

        <div className="mt-4 grid grid-cols-1 gap-8 lg:grid-cols-3">
          {plans.map((plan) => {
            const highlighted = chosenPlan === plan.id;
            return (
              <div
                key={plan.id}
                id={`plan-${plan.id}`}
                className={`relative rounded-2xl border-2 p-8 shadow-sm ${
                  plan.badge || highlighted
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
                  <span className="text-sm text-gray-500">
                    {plan.period}
                    {qualifier}
                  </span>
                </div>
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{plan.desc}</p>
                <ul className="mt-6 space-y-3">
                  {plan.features.map((feat) => (
                    <li key={feat} className="flex items-center gap-3 text-sm">
                      <svg className="h-5 w-5 flex-shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      {feat}
                    </li>
                  ))}
                </ul>

                {highlighted && (
                  <p className="mt-4 text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                    The plan you picked.
                  </p>
                )}

                {/* The real control. It reports what actually happened — never a
                    fake success, and never silence. */}
                <PlanCheckoutButton plan={plan.id} name={plan.name} />
              </div>
            );
          })}
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
            {sale.onSale
              ? "A completed payment is confirmed by our server before any tool unlocks — not by this page."
              : "Checkout isn't open yet. When it is, a completed payment will be confirmed by our server before any tool unlocks — not by this page."}
          </p>
          <p className="mt-2 text-sm text-gray-500">
            Questions? <a href="mailto:support@everyonesawinner.uk" className="text-indigo-600 hover:text-indigo-700">Contact support</a>
          </p>
        </div>
    </PageHeader>
  );
}
