import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";

const plans = [
  {
    name: "Starter",
    price: "£9.99",
    period: "/month",
    desc: "Great to get started with matched betting.",
    features: [
      "Full offer database",
      "Unlimited calculator usage",
      "Profit tracker",
      "Email support",
    ],
    link: "https://buy.stripe.com/aFaaEX3i6119e5h93edQQ06",
    popular: false,
  },
  {
    name: "Pro",
    orig: "£19.99",
    price: "£9.99",
    period: "/month",
    desc: "For regular users maximising earnings.",
    features: [
      "Everything in Starter",
      "Unlimited offer alerts",
      "Advanced oddsmatcher",
      "Auto-calculation",
      "Profit dashboard",
      "Priority support",
      "Sign-up guides",
    ],
    link: "https://buy.stripe.com/4gM8wP4ma4dlbX97ZadQQ04",
    popular: true,
  },
  {
    name: "Annual",
    price: "£199",
    period: "/year",
    desc: "Best value — save £40 compared to monthly Pro.",
    features: [
      "Everything in Pro",
      "2 months free",
      "Early access to new features",
      "Priority support",
    ],
    link: "https://buy.stripe.com/fZu9ATdWK1190ergvGdQQ05",
    popular: false,
  },
];

export default function Subscribe() {
  const { user } = useAuth();

  const handleSubscribe = (url: string) => {
    // Open Stripe payment link in new tab
    window.open(url, "_blank", "noopener,noreferrer");
  };

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
            Pick the plan that's right for you. All plans include full access to odds tools and the offer database.
            <br />
            <span className="text-sm">After payment, you'll be redirected to activate your subscription.</span>
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
                {(plan as any).orig ? (
                  <>
                    <span className="text-2xl font-extrabold text-gray-400 line-through">{(plan as any).orig}</span>
                    <span className="text-4xl font-extrabold text-indigo-600">{plan.price}</span>
                  </>
                ) : (
                  <span className="text-4xl font-extrabold">{plan.price}</span>
                )}
                <span className="text-sm text-gray-500">{plan.period}</span>
                {(plan as any).orig && plan.name === "Pro" && (
                  <span className="ml-2 rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700 dark:bg-green-900 dark:text-green-300">
                    50% OFF
                  </span>
                )}
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
                onClick={() => handleSubscribe(plan.link)}
                className={`mt-6 w-full rounded-xl py-3 text-sm font-semibold transition-all ${
                  plan.popular
                    ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/25 hover:bg-indigo-700"
                    : "border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300"
                }`}
              >
                Subscribe - {plan.price}{plan.period}
              </button>
              <p className="mt-2 text-xs text-gray-400 text-center">
                Opens Stripe checkout in a new tab
              </p>
            </div>
          ))}
        </div>

        <div className="mt-12 text-center border-t border-gray-200 dark:border-gray-800 pt-8">
          <p className="text-sm text-gray-500">
            After payment, you'll be sent to <strong>/subscribe/success</strong> to activate your account.
          </p>
          <p className="mt-2 text-sm text-gray-500">
            Questions? <a href="mailto:support@everyonesawinner.uk" className="text-indigo-600 hover:text-indigo-700">Contact support</a>
          </p>
        </div>
      </div>
    </div>
  );
}