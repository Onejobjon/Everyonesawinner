import { useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import PageHeader from "./PageHeader";
import { useAuth, isProPlan } from "../lib/auth";

interface PaywallProps {
  children: React.ReactNode;
  title?: string;
  /** "any" = any paid tier; "pro" = Pro monthly / Pro Annual only */
  tier?: "any" | "pro";
}

export default function Paywall({ children, title, tier = "any" }: PaywallProps) {
  const { user, sessionStatus, refresh } = useAuth();
  const navigate = useNavigate();
  // SECURITY (2026-10-27):
  //  - No query-string bypass: `?preview=1` used to render every Pro tool with
  //    all auth checks skipped. /preview is marketing copy only now.
  //  - The session is verified by the SERVER (GET /api/me). A hand-written
  //    localStorage object with an invented token resolves to nothing, so it
  //    gets the subscribe screen instead of the tool.
  //  - Fails CLOSED: no/expired session → /login; account service unreachable →
  //    "we can't verify you", never the paid tool.
  //
  // LAYOUT (2026-11-05): every state below renders through the SAME PageHeader
  // the tools use, so a paywall is never a different-looking site.
  useEffect(() => {
    if (sessionStatus === "anon") {
      navigate("/login?redirect=" + encodeURIComponent(window.location.pathname), { replace: true });
    }
  }, [sessionStatus, navigate]);

  if (sessionStatus === "checking") {
    return (
      <PageHeader title="Checking your account…">
        <div className="flex justify-center py-16">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
        </div>
      </PageHeader>
    );
  }

  if (sessionStatus === "error") {
    return (
      <PageHeader
        title="We couldn't verify your account"
        subtitle="The account service isn't responding, so the tools stay locked rather than let anyone in unchecked. Nothing is wrong with your subscription — please try again in a moment."
      >
        <button
          onClick={() => void refresh()}
          className="mt-8 rounded-xl bg-indigo-600 px-8 py-3 font-semibold text-white hover:bg-indigo-700"
        >
          Try again
        </button>
      </PageHeader>
    );
  }

  if (sessionStatus === "anon" || !user) {
    return null; // redirecting to /login
  }

  // Logged in but no subscription → show paywall screen
  if (!user?.subscription) {
    return (
      <PageHeader
        title={`Subscribe to access ${title || "this tool"}`}
        subtitle="You're signed in! Choose a plan to unlock the odds finder, profit calculator, and all premium features."
      >
        <div className="mt-10">
          <Link
            to="/subscribe"
            className="inline-block rounded-xl bg-indigo-600 px-10 py-4 text-lg font-semibold text-white shadow-lg shadow-indigo-600/25 hover:bg-indigo-700 transition-all"
          >
            View plans &amp; subscribe →
          </Link>
        </div>
        <p className="mt-6 text-sm text-gray-500">
          Already subscribed? <Link to="/login" className="text-indigo-600 hover:text-indigo-700 font-medium">Sign in here</Link>
        </p>
      </PageHeader>
    );
  }

  // Pro-only tier: a Starter user (or any non-Pro plan) sees an upgrade screen
  if (tier === "pro" && !isProPlan(user.plan)) {
    return (
      <PageHeader
        title={`Upgrade to Pro for ${title || "this tool"}`}
        subtitle={`${title || "This tool"} is a Pro feature. Upgrade to unlock it alongside the Lay Bet Finder, the advanced oddsmatcher, and everything in Starter.`}
      >
        <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 text-left">
          <div className="rounded-2xl border-2 border-indigo-500 bg-white p-8 shadow-sm dark:bg-gray-950">
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-300">Planned plan</span>
            <h3 className="mt-3 text-lg font-semibold">Pro Monthly</h3>
            <div className="mt-2 flex items-baseline gap-1">
              <span className="text-3xl font-extrabold text-indigo-600">£29.99</span>
              <span className="text-sm text-gray-500">/mo (planned)</span>
            </div>
            <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400">
              <li>• Lay Bet Finder — close single lays</li>
              <li>• Acca Lay Planner — 2–4-leg lay plans</li>
              <li>• Oddsmatcher and calculator</li>
            </ul>
            <button type="button" disabled aria-disabled="true" className="mt-6 block w-full cursor-not-allowed rounded-xl border border-gray-300 py-3 text-center text-sm font-semibold text-gray-400 dark:border-gray-700 dark:text-gray-500">
              Checkout opens shortly
            </button>
          </div>
          <div className="rounded-2xl border-2 border-gray-200 bg-white p-8 shadow-sm dark:border-gray-800 dark:bg-gray-950">
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-300">Best value</span>
            <h3 className="mt-3 text-lg font-semibold">Pro Annual</h3>
            <div className="mt-2 flex items-baseline gap-1">
              <span className="text-3xl font-extrabold">£269.99</span>
              <span className="text-sm text-gray-500">/yr</span>
            </div>
            <p className="mt-1 text-xs text-gray-500">Paid once a year (planned)</p>
            <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400">
              <li>• Lay Bet Finder — close single lays</li>
              <li>• Acca Lay Planner — 2–4-leg lay plans</li>
              <li>• Everything in Pro</li>
              <li>• One payment for the year</li>
            </ul>
            <button type="button" disabled aria-disabled="true" className="mt-6 block w-full cursor-not-allowed rounded-xl border border-gray-300 py-3 text-center text-sm font-semibold text-gray-400 dark:border-gray-700 dark:text-gray-500">
              Checkout opens shortly
            </button>
          </div>
        </div>

        <p className="mt-8 text-sm text-gray-500">
          Checkout isn't open yet — we're finishing the payment setup, and no payment can be taken until it does. These are the plans we intend to offer, not prices you can buy today.
        </p>
      </PageHeader>
    );
  }

  // Logged in AND has the required tier → show children
  return <>{children}</>;
}
