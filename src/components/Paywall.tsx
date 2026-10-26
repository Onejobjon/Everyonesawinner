import { useEffect } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useAuth, isProPlan } from "../lib/auth";

interface PaywallProps {
  children: React.ReactNode;
  title?: string;
  /** "any" = any paid tier; "pro" = Pro monthly / Pro Annual only */
  tier?: "any" | "pro";
}

const PRO_LINK = "https://buy.stripe.com/4gM8wP4ma4dlbX97ZadQQ04";
const ANNUAL_LINK = "https://buy.stripe.com/fZu9ATdWK1190ergvGdQQ05";

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
  const { user, checkAuth } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Preview bypass: ?preview=1 skips all auth/subscription checks
  const isPreview = searchParams.get("preview") === "1";

  if (isPreview) {
    return <>{children}</>;
  }

  // Not logged in → redirect to /login
  useEffect(() => {
    if (!checkAuth()) {
      navigate("/login?redirect=" + encodeURIComponent(window.location.pathname), { replace: true });
    }
  }, []);

  if (!checkAuth()) {
    return null; // will redirect
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
              <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700 dark:bg-green-900 dark:text-green-300">50% OFF first month</span>
              <h3 className="mt-3 text-lg font-semibold">Pro Monthly</h3>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-sm font-bold text-gray-400 line-through">£19.99</span>
                <span className="text-3xl font-extrabold text-indigo-600">£9.99</span>
                <span className="text-sm text-gray-500">/mo</span>
              </div>
              <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400">
                <li>• Lay Bet Finder — close single lays</li>
                <li>• Bet Builder — 2–4-leg lay plans</li>
                <li>• Everything in Starter</li>
                <li>• Advanced oddsmatcher</li>
              </ul>
              <a href={PRO_LINK} target="_blank" rel="noopener noreferrer" className="mt-6 block w-full rounded-xl bg-indigo-600 py-3 text-center text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 hover:bg-indigo-700 transition-all">
                Upgrade — £9.99/mo
              </a>
            </div>
            <div className="rounded-2xl border-2 border-gray-200 bg-white p-8 shadow-sm dark:border-gray-800 dark:bg-gray-950">
              <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-300">Best value</span>
              <h3 className="mt-3 text-lg font-semibold">Pro Annual</h3>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-3xl font-extrabold">£199</span>
                <span className="text-sm text-gray-500">/yr</span>
              </div>
              <p className="mt-1 text-xs text-gray-500">Save £40 vs monthly</p>
              <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400">
                <li>• Lay Bet Finder — close single lays</li>
                <li>• Bet Builder — 2–4-leg lay plans</li>
                <li>• Everything in Pro</li>
                <li>• 2 months free</li>
              </ul>
              <a href={ANNUAL_LINK} target="_blank" rel="noopener noreferrer" className="mt-6 block w-full rounded-xl border border-gray-300 py-3 text-center text-sm font-semibold text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900 transition-all">
                Upgrade — £199/yr
              </a>
            </div>
          </div>

          <p className="mt-8 text-sm text-gray-500">
            After payment you'll be redirected to activate — then the Lay Bet Finder unlocks automatically.
          </p>
        </div>
      </div>
    );
  }

  // Logged in AND has the required tier → show children
  return <>{children}</>;
}
