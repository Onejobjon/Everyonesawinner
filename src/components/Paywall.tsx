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

  // Logged in AND has subscription → show children
  return <>{children}</>;
}