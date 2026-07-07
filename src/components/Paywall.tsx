import { useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../lib/auth";

interface PaywallProps {
  children: React.ReactNode;
  title?: string;
}

export default function Paywall({ children, title }: PaywallProps) {
  const { user, checkAuth } = useAuth();
  const navigate = useNavigate();

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
        <nav className="border-b border-gray-200 bg-white/90 dark:border-gray-800 dark:bg-gray-950/90">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
            <Link to="/" className="flex items-center gap-2">
              <span className="rounded-lg bg-indigo-600 p-2 text-white font-bold text-lg">EAW</span>
              <span className="text-xl font-bold tracking-tight">Everyone's A Winner</span>
            </Link>
            <Link to="/" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">← Back to Home</Link>
          </div>
        </nav>

        <div className="mx-auto max-w-3xl px-6 py-16 text-center">
          <span className="text-5xl">🔒</span>
          <h1 className="mt-6 text-3xl font-bold tracking-tight sm:text-4xl">Subscribe to access {title || "this tool"}</h1>
          <p className="mt-4 text-lg text-gray-600 dark:text-gray-400 max-w-xl mx-auto">
            You're signed in! Choose a plan below to unlock the odds finder, profit calculator, and all premium features.
          </p>

          {/* Pricing */}
          <div className="mt-12 grid grid-cols-1 gap-6 lg:grid-cols-3 text-left">
            {[
              { n: "Starter", orig: "£9.99", disc: "£4.99", period: "/month", desc: "Great to get started.", f: ["Full offer database", "Unlimited calculator usage", "Profit tracker", "Email support"], link: "https://buy.stripe.com/9B6eVd5qebFN5yL7ZadQQ03", pop: false },
              { n: "Pro", orig: "£19.99", disc: "£9.99", period: "/month", desc: "For regular users maximising earnings.", f: ["Everything in Starter", "Unlimited offer alerts", "Advanced oddsmatcher", "Auto-calculation", "Profit dashboard", "Priority support", "Sign-up guides"], link: "https://buy.stripe.com/4gM8wP4ma4dlbX97ZadQQ04", pop: true },
              { n: "Annual", orig: "", disc: "£199", period: "/year", desc: "Best value — save £40.", f: ["Everything in Pro", "2 months free", "Early access", "Priority support"], link: "https://buy.stripe.com/fZu9ATdWK1190ergvGdQQ05", pop: false },
            ].map((plan, i) => (
              <div key={i} className={`relative rounded-2xl border-2 p-8 shadow-sm ${plan.pop ? "border-indigo-500 bg-white shadow-indigo-200 dark:bg-gray-950" : "border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950"}`}>
                {plan.pop && <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-indigo-600 px-4 py-1 text-xs font-semibold text-white">Most popular</span>}
                <h3 className="text-lg font-semibold">{plan.n}</h3>
                <div className="mt-4 flex items-baseline gap-1">
                  {plan.orig ? (
                    <>
                      <span className="text-2xl font-extrabold text-gray-400 line-through">{plan.orig}</span>
                      <span className="text-4xl font-extrabold text-indigo-600">{plan.disc}</span>
                    </>
                  ) : (
                    <span className="text-4xl font-extrabold">{plan.disc}</span>
                  )}
                  <span className="text-sm text-gray-500">{plan.period}</span>
                  {plan.orig && (
                    <span className="ml-2 rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700 dark:bg-green-900 dark:text-green-300">50% OFF</span>
                  )}
                </div>
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{plan.desc}</p>
                <ul className="mt-6 space-y-3">
                  {plan.f.map((feat, j) => (
                    <li key={j} className="flex items-center gap-3 text-sm">
                      <svg className="h-5 w-5 flex-shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                      {feat}
                    </li>
                  ))}
                </ul>
                <a
                  href={plan.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`mt-6 w-full rounded-xl py-3 text-sm font-semibold transition-all block text-center ${
                    plan.pop
                      ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/25 hover:bg-indigo-700"
                      : "border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300"
                  }`}
                >
                  Subscribe - {plan.disc}{plan.period}
                </a>
              </div>
            ))}
          </div>

          <p className="mt-8 text-sm text-gray-500">
            Already subscribed? <Link to="/login" className="text-indigo-600 hover:text-indigo-700 font-medium">Sign in here</Link>
          </p>
        </div>
      </div>
    );
  }

  // Logged in AND has subscription → show children
  return <>{children}</>;
}