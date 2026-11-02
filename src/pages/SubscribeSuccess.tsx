import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import PageHeader from "../components/PageHeader";
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

  const TITLES = {
    activating: "Checking whether a payment has been confirmed...",
    done: "We haven't received a payment for this account",
    error: "Something went wrong",
  } as const;

  return (
    <PageHeader
      title={TITLES[status]}
      subtitle={
        status === "activating"
          ? "Please wait one moment."
          : status === "done"
            ? "This page does not activate anything — only our server can confirm a payment, and checkout isn't open yet. No payment has been taken."
            : "We couldn't activate your subscription. Try again or contact support."
      }
    >
      {status === "activating" && (
        <div className="flex justify-center py-12">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
        </div>
      )}

      {status === "done" && (
        <div className="mt-8 flex flex-wrap gap-4">
          <Link to="/dashboard" className="rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white">
            Go to Dashboard
          </Link>
          <Link to="/oddsmatcher" className="rounded-lg border border-gray-300 px-6 py-3 text-sm font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-300">
            Start matching
          </Link>
        </div>
      )}

      {status === "error" && (
        <div className="mt-8 flex flex-wrap gap-4">
          <Link to="/subscribe" className="rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white">
            Try again
          </Link>
          <a href="mailto:support@everyonesawinner.uk" className="rounded-lg border border-gray-300 px-6 py-3 text-sm font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-300">
            Contact support
          </a>
        </div>
      )}
    </PageHeader>
  );
}
