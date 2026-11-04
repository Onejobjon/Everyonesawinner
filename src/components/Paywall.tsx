import { useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import PageHeader from "./PageHeader";
import PlanCheckoutButton, { useBillingReadiness } from "./PlanCheckoutButton";
import { useAuth, isProPlan } from "../lib/auth";
import { plansForSaleNotice, priceQualifier } from "../lib/checkout-client";

interface PaywallProps {
  children: React.ReactNode;
  title?: string;
  /** "any" = any paid tier; "pro" = Pro monthly / Pro Annual only */
  tier?: "any" | "pro";
}

export default function Paywall({ children, title, tier = "any" }: PaywallProps) {
  const { user, sessionStatus, refresh } = useAuth();
  const navigate = useNavigate();
  // The upgrade cards sell plans, so their buttons and their "planned" wording
  // read the same billing switch the checkout endpoint reads. Hooks run before
  // every early return below, as they must.
  const readiness = useBillingReadiness();
  const sale = plansForSaleNotice(readiness);
  const qualifier = priceQualifier(readiness);
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

  // Logged in but NOT ENTITLED → show paywall screen. `entitled` is the server's
  // answer (GET /api/me → src/server/entitlement.ts), not a local flag: it is
  // false when the paid period has ended, when a subscription was cancelled and
  // ran out, and when a failed payment's grace window has closed.
  if (!user?.entitled) {
    return (
      <PageHeader
        title={`Subscribe to access ${title || "this tool"}`}
        subtitle="You're signed in! Choose a plan to unlock the oddsmatcher, the profit calculator and the dashboard."
      >
        <div className="mt-10">
          <Link
            to="/subscribe"
            className="inline-block rounded-xl bg-indigo-600 px-10 py-4 text-lg font-semibold text-white shadow-lg shadow-indigo-600/25 hover:bg-indigo-700 transition-all"
          >
            View plans &amp; subscribe →
          </Link>
        </div>
        {/* This branch only renders for a signed-in account the SERVER says has no
            subscription, so "Already subscribed? Sign in here" was wrong — they are
            signed in. Re-ask the server instead. */}
        <p className="mt-6 text-sm text-gray-500">
          Paid and still seeing this? Your plan is set by our server, not by this page —{" "}
          <button
            onClick={() => void refresh()}
            className="text-indigo-600 hover:text-indigo-700 font-medium underline"
          >
            check your account again
          </button>
          . If it still shows, email{" "}
          <a href="mailto:support@everyonesawinner.uk" className="text-indigo-600 hover:text-indigo-700 font-medium">
            support@everyonesawinner.uk
          </a>
          .
        </p>
      </PageHeader>
    );
  }

  // Pro-only tier: a Starter user (or any non-Pro plan) sees an upgrade screen
  if (tier === "pro" && !isProPlan(user.plan)) {
    // Callers pass titles like "the Lay Bet Finder", so the sentence would start
    // lower-case; capitalise the first letter of whatever we were given.
    const subject = title || "this tool";
    const Subject = subject.charAt(0).toUpperCase() + subject.slice(1);
    return (
      <PageHeader
        title={`Upgrade to Pro for ${title || "this tool"}`}
        subtitle={`${Subject} is a Pro feature. Pro adds the Lay Bet Finder, the Acca Lay Planner and the Same-Match Planner to the oddsmatcher, calculator and dashboard you already get on Starter.`}
      >
        <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 text-left">
          <div className="rounded-2xl border-2 border-indigo-500 bg-white p-8 shadow-sm dark:bg-gray-950">
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-300">{sale.onSale ? "Pro plan" : "Planned plan"}</span>
            <h3 className="mt-3 text-lg font-semibold">Pro Monthly</h3>
            <div className="mt-2 flex items-baseline gap-1">
              <span className="text-3xl font-extrabold text-indigo-600">£29.99</span>
              <span className="text-sm text-gray-500">/mo{qualifier}</span>
            </div>
            <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400">
              <li>• Lay Bet Finder — close single lays</li>
              <li>• Acca Lay Planner — 2–4-leg lay plans</li>
              <li>• Same-Match Planner</li>
              <li>• Oddsmatcher, calculator and dashboard</li>
            </ul>
            {/* The real control: it POSTs the chosen plan to /api/checkout and
                renders the true outcome, including "you can't buy this yet". */}
            <PlanCheckoutButton plan="pro" name="Pro" className="mt-6 block w-full rounded-xl bg-indigo-600 py-3 text-center text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-70" />
          </div>
          <div className="rounded-2xl border-2 border-gray-200 bg-white p-8 shadow-sm dark:border-gray-800 dark:bg-gray-950">
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-300">Best value</span>
            <h3 className="mt-3 text-lg font-semibold">Pro Annual</h3>
            <div className="mt-2 flex items-baseline gap-1">
              <span className="text-3xl font-extrabold">£269.99</span>
              <span className="text-sm text-gray-500">/yr{qualifier}</span>
            </div>
            <p className="mt-1 text-xs text-gray-500">Paid once a year{qualifier}</p>
            <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400">
              <li>• Lay Bet Finder — close single lays</li>
              <li>• Acca Lay Planner — 2–4-leg lay plans</li>
              <li>• Same-Match Planner</li>
              <li>• One payment for the year instead of twelve</li>
            </ul>
            <PlanCheckoutButton plan="annual" name="Pro Annual" className="mt-6 block w-full rounded-xl border border-gray-300 py-3 text-center text-sm font-semibold text-gray-800 transition-colors hover:bg-gray-50 disabled:cursor-wait disabled:opacity-70 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900" />
          </div>
        </div>

        <p className="mt-8 text-sm text-gray-500">
          <strong>{sale.headline}</strong> {sale.detail}
        </p>
      </PageHeader>
    );
  }

  // Logged in AND has the required tier → show children
  return <>{children}</>;
}
