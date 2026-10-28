import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../lib/auth";

export default function SubscribeSuccess() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [status, setStatus] = useState<"activating" | "done" | "error">("activating");
  const [countdown, setCountdown] = useState(3);

  useEffect(() => {
    if (!user) {
      navigate("/login?redirect=/subscribe/success", { replace: true });
      return;
    }

    try {
      // No payment has been received, so there is nothing to activate here.
      // Only the server can grant a plan; we just clear the leftover hint the
      // /subscribe page wrote before it opened checkout.
      localStorage.removeItem("eaw_pending_plan");
      setStatus("done");

      // Redirect to dashboard after 3 seconds
      const timer = setInterval(() => {
        setCountdown((c) => {
          if (c <= 1) {
            clearInterval(timer);
            navigate("/dashboard", { replace: true });
            return 0;
          }
          return c - 1;
        });
      }, 1000);
    } catch {
      setStatus("error");
    }
  }, []);

  return (
    <div className="min-h-dvh page-bg font-['Inter',system-ui,sans-serif] flex items-center justify-center">
      <div className="max-w-md px-6 text-center">
        {status === "activating" && (
          <>
            <div className="h-12 w-12 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent mx-auto" />
            <h1 className="mt-6 text-2xl font-bold">Checking whether a payment has been confirmed...</h1>
            <p className="mt-2 text-gray-600 dark:text-gray-400">Please wait one moment.</p>
          </>
        )}

        {status === "done" && (
          <>
            <span className="text-6xl">ℹ️</span>
            <h1 className="mt-6 text-2xl font-bold">We haven't received a payment for this account</h1>
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              This page does not activate anything — only our server can confirm a payment, and checkout isn't open yet. Nothing has been charged.
            </p>
            <div className="mt-8 flex gap-4 justify-center">
              <Link to="/dashboard" className="rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white">
                Go to Dashboard
              </Link>
              <Link to="/oddsmatcher" className="rounded-lg border border-gray-300 px-6 py-3 text-sm font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-300">
                Start matching
              </Link>
            </div>
          </>
        )}

        {status === "error" && (
          <>
            <span className="text-6xl">❌</span>
            <h1 className="mt-6 text-2xl font-bold">Something went wrong</h1>
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              We couldn't activate your subscription. Try again or contact support.
            </p>
            <div className="mt-8 flex gap-4 justify-center">
              <Link to="/subscribe" className="rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white">
                Try again
              </Link>
              <a href="mailto:support@everyonesawinner.uk" className="rounded-lg border border-gray-300 px-6 py-3 text-sm font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-300">
                Contact support
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}