import { useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth, isProPlan } from "../lib/auth";

interface PaywallProps {
  children: React.ReactNode;
  title?: string;
  /** "any" = any paid tier; "pro" = Pro monthly / Pro Annual only */
  tier?: "any" | "pro";
}


function Nav() {
  return (
    <nav className="border-b border-gray-200 bg-white/90 dark:border-gray-800 dark:bg-gray-950/90">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <Link to="/" className="flex items-center gap-2">
          <span className="rounded-lg bg-indigo-600 p-2 text-white font-bold text-lg">EAW</span>
          <span className="text-xl font-bold tracking-tight">Everyone's A Winner</span>
        </Link>
        <Link to="/" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">← Back to Home</Link>
      </div>
    </nav>
  );
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
  useEffect(() => {
    if (sessionStatus === "anon") {
      navigate("/login?redirect=" + encodeURIComponent(window.location.pathname), { replace: true });
    }
  }, [sessionStatus, navigate]);

  if (sessionStatus === "checking") {
    return (
      <div className="min-h-dvh page-bg font-['Inter',system-ui,sans-serif]">
        <Nav />
        <div className="mx-auto max-w-3xl px-6 py-24 text-center text-gray-500">Checking your account…</div>
      </div>
    );
  }

  if (sessionStatus === "error") {
    return (
      <div className="min-h-dvh page-bg font-['Inter',system-ui,sans-serif]">
        <Nav />
        <div className="mx-auto max-w-3xl px-6 py-24 text-center">
          <span className="text-6xl">🔒</span>
          <h1 className="mt-6 text-3xl font-bold tracking-tight sm:text-4xl">We couldn't verify your account</h1>
          <p className="mt-4 text-lg text-gray-600 dark:text-gray-400 max-w-xl mx-auto">
            The account service isn't responding, so the tools stay locked rather than let anyone in
            unchecked. Nothing is wrong with your subscription — please try again in a moment.
          </p>
          <button
            onClick={() => void refresh()}
            className="mt-8 rounded-xl bg-indigo-600 px-8 py-3 font-semibold text-white hover:bg-indigo-700"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (sessionStatus === "anon" || !user) {
    return null; // redirecting to /login
  }

  // Logged in but no subscription → show paywall screen
  if (!user?.subscription) {
    return (
      <div className="min-h-dvh page-bg font-['Inter',system-ui,sans-serif]">
        <Nav />
        <div className="mx-auto max-w-3xl px-6 py-24 text-center">
          <span className="text-6xl">🔒</span>
          <h1 className="mt-6 text-3xl font-bold tracking-tight sm:text-4xl">Subscribe to access {title || "this tool"}</h1>
          <p className="mt-4 text-lg text-gray-600 dark:text-gray-400 max-w-xl mx-auto">
            You're signed in! Choose a plan to unlock the odds finder, profit calculator, and all premium features.
          </p>
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
        </div>
      </div>
    );
  }

  // Pro-only tier: a Starter user (or any non-Pro plan) sees an upgrade screen
  if (tier === "pro" && !isProPlan(user.plan)) {
    return (
      <div className="min-h-dvh page-bg font-['Inter',system-ui,sans-serif]">
        <Nav />
        <div className="mx-auto max-w-4xl px-6 py-16 text-center">
          <span className="text-6xl">⚡</span>
          <h1 className="mt-6 text-3xl font-bold tracking-tight sm:text-4xl">Upgrade to Pro for {title || "this tool"}</h1>
          <p className="mt-4 text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
            {title || "This tool"} is a Pro feature. Upgrade to unlock it alongside the Lay Bet Finder, the advanced oddsmatcher, and everything in Starter.
          </p>

          <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 max-w-3xl mx-auto text-left">
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
                <span className="text-3xl font-extrabold">£199</span>
                <span className="text-sm text-gray-500">/yr</span>
              </div>
              <p className="mt-1 text-xs text-gray-500">Billed once a year (planned)</p>
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
            Checkout isn't open yet — we're finishing the payment setup, and nothing can be charged until it does. These are the plans we intend to offer, not prices you can buy today.
          </p>
        </div>
      </div>
    );
  }

  // Logged in AND has the required tier → show children
  return <>{children}</>;
}
