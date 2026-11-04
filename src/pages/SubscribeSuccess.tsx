import { useEffect, useRef, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import { useAuth, type Plan } from "../lib/auth";

/**
 * /subscribe/success — where the payment provider returns a customer after checkout.
 *
 * THE ONE RULE THIS PAGE KEEPS: it cannot grant a plan. Only `GET /api/me`
 * (src/server/pro-gate.ts) decides whether an account is subscribed, and this
 * page only asks it and reports the answer. That is why every sentence below is
 * phrased as "our server says", never as "payment received" on this page's own
 * authority.
 *
 * Two things were wrong with the previous version, both fixed here:
 *   - It told a paying customer "We haven't received a payment for this
 *     account" and "No payment has been taken" — the first thing they read
 *     after paying.
 *   - It redirected them away after 3 seconds, before they could read it, and
 *     offered /oddsmatcher — which bounces into the paywall whenever the
 *     webhook is a moment behind. There is now no auto-redirect at all: the
 *     page waits, offers "Check again", and only links into a paid tool once
 *     the server has actually confirmed the plan.
 */

const PLAN_LABEL: Record<Plan, { name: string; price: string }> = {
  starter: { name: "Starter", price: "£19.99 a month" },
  pro: { name: "Pro", price: "£29.99 a month" },
  annual: { name: "Pro Annual", price: "£269.99 a year" },
};

function isPlan(value: unknown): value is Plan {
  return value === "starter" || value === "pro" || value === "annual";
}

export default function SubscribeSuccess() {
  const navigate = useNavigate();
  const { user, sessionStatus, refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  /** The plan the customer picked on /subscribe, for display only. Never proof of payment. */
  const [chosenPlan, setChosenPlan] = useState<Plan | null>(null);
  const askedOnce = useRef(false);

  // The hint /subscribe leaves behind before it hands off to checkout. Read it
  // for display, then drop it: it is a UI hint, never evidence of a payment.
  useEffect(() => {
    try {
      const raw = localStorage.getItem("eaw_pending_plan");
      if (isPlan(raw)) setChosenPlan(raw);
      localStorage.removeItem("eaw_pending_plan");
    } catch {
      /* private mode / storage disabled — the page still works */
    }
  }, []);

  useEffect(() => {
    if (sessionStatus === "anon") {
      navigate("/login?redirect=/subscribe/success", { replace: true });
    }
  }, [sessionStatus, navigate]);

  // Ask the server once, unprompted: the confirmation may already have landed.
  useEffect(() => {
    if (sessionStatus !== "authed" || askedOnce.current) return;
    askedOnce.current = true;
    void refresh();
  }, [sessionStatus, refresh]);

  const checking = sessionStatus === "checking" || (sessionStatus === "authed" && !user);
  // The server's answer, not the browser's hope: `entitled` comes from /api/me.
  const active = sessionStatus === "authed" && !!user?.entitled;
  const serverUnreachable = sessionStatus === "error";

  async function checkAgain() {
    setBusy(true);
    try {
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const confirmedPlan = user?.plan ? PLAN_LABEL[user.plan] : null;
  const shownPlan = confirmedPlan ?? (chosenPlan ? PLAN_LABEL[chosenPlan] : null);

  if (checking) {
    return (
      <PageHeader
        title="Confirming your subscription…"
        subtitle="We're asking our server whether the payment has come through. This takes a moment."
      >
        <div className="flex justify-center py-12">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
        </div>
      </PageHeader>
    );
  }

  if (active) {
    // Access is real (the server said so), but WHY it is real is not always a
    // payment: a comped account writes the same entitlement record. Saying
    // "you're subscribed" to someone the owner comped would be a small lie, and
    // saying "renews automatically" to them would be a worse one.
    const comped = !!user?.comp;
    return (
      <PageHeader
        title={comped ? "Your free access is active" : "You're subscribed"}
        subtitle={
          comped
            ? "Our server has granted this account free access. There is nothing to pay and no card on file."
            : "Our server has confirmed your subscription on this account. Everything you've paid for is unlocked now."
        }
      >
        <div className="mx-auto mt-8 max-w-xl rounded-2xl border border-gray-200 bg-white p-6 text-left shadow-sm dark:border-gray-800 dark:bg-gray-950">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-lg font-semibold">{confirmedPlan?.name ?? "Your plan"}</h2>
            {confirmedPlan && (
              <span className="text-sm text-gray-600 dark:text-gray-400">
                {comped ? "free access" : confirmedPlan.price}
              </span>
            )}
          </div>
          {comped ? (
            <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-400">
              {user?.comp?.permanent
                ? "This free access has no end date. It stays until the owner changes it."
                : user?.comp?.endsAt
                  ? `This free access runs until ${new Date(user.comp.endsAt).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                    })}. Nothing renews and no payment is taken.`
                  : "Nothing renews and no payment is taken."}
            </p>
          ) : (
            <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-400">
              Your plan renews automatically until you cancel. To cancel, email{" "}
              <a href="mailto:support@everyonesawinner.uk" className="text-indigo-600 underline hover:text-indigo-700">
                support@everyonesawinner.uk
              </a>{" "}
              from the address on this account — cancelling stops future billing and your access runs to the end of
              the period you've already paid for.
            </p>
          )}
          {!comped && (
            <p className="mt-3 text-sm leading-6 text-gray-500 dark:text-gray-400">
              The full payment terms, including your 14-day right to cancel, are in our{" "}
              <Link to="/terms" className="text-indigo-600 underline hover:text-indigo-700">
                terms of use
              </Link>
              .
            </p>
          )}
        </div>

        <p className="mx-auto mt-4 max-w-xl text-xs leading-5 text-gray-500 dark:text-gray-400">
          This page didn't unlock anything — access is granted by our server, which is what just confirmed your
          plan.
        </p>

        <div className="mt-8 flex flex-wrap justify-center gap-4">
          <Link to="/dashboard" className="rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white">
            Go to your dashboard
          </Link>
          <Link
            to="/free-bets"
            className="rounded-lg border border-gray-300 px-6 py-3 text-sm font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-300"
          >
            See the free-bet offers
          </Link>
        </div>
      </PageHeader>
    );
  }

  if (serverUnreachable) {
    return (
      <PageHeader
        title="We couldn't reach our server to confirm your subscription"
        subtitle="This says nothing either way about your payment — we simply couldn't ask. Try again in a moment, and if it keeps failing, email us."
      >
        <div className="mt-8 flex flex-wrap justify-center gap-4">
          <button
            onClick={() => void checkAgain()}
            disabled={busy}
            className="rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white disabled:opacity-60"
          >
            {busy ? "Checking…" : "Try again"}
          </button>
          <a
            href="mailto:support@everyonesawinner.uk"
            className="rounded-lg border border-gray-300 px-6 py-3 text-sm font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-300"
          >
            Email support
          </a>
        </div>
      </PageHeader>
    );
  }

  // Signed in, but the server has not confirmed a subscription (yet).
  //
  // THE HONEST VERSION (2026-11-04). Access is granted by the Stripe webhook
  // (src/server/stripe-webhook.ts → src/server/entitlement.ts), which is a
  // SEPARATE message from the browser coming back here: Stripe sends it when it
  // is ready, so this page can load before the account has been switched on. The
  // old subtitle promised "usually a minute or two" — a timing claim about our
  // own machinery that nothing in this codebase can support, and one a customer
  // would rightly hold us to. So: say what grants access, say we cannot promise
  // when it lands, and offer a button that asks again.
  return (
    <PageHeader
      title="Waiting for our server to confirm your payment"
      subtitle="You're signed in. Access is switched on by our server when the payment provider's confirmation reaches it — that confirmation is a separate message from this page, so it can arrive before or after you land here."
    >
      {shownPlan && (
        <div className="mx-auto mt-8 max-w-xl rounded-2xl border border-gray-200 bg-white p-6 text-left shadow-sm dark:border-gray-800 dark:bg-gray-950">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-lg font-semibold">{shownPlan.name}</h2>
            <span className="text-sm text-gray-600 dark:text-gray-400">{shownPlan.price}</span>
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {confirmedPlan
              ? "The plan on this account."
              : "The plan you chose at checkout. It isn't active until our server confirms the payment."}
          </p>
        </div>
      )}

      <p className="mx-auto mt-6 max-w-xl text-sm leading-6 text-gray-600 dark:text-gray-400">
        Nothing on this page can unlock your account — only our server can, and it does so when that confirmation
        arrives. We can't say how long that will take, and we'd rather tell you that than give you a number we
        can't keep. You don't need to stay here: the plan is attached to your account, so you can close this page
        and sign in again later.
      </p>

      <div className="mt-8 flex flex-wrap justify-center gap-4">
        <button
          onClick={() => void checkAgain()}
          disabled={busy}
          className="rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white disabled:opacity-60"
        >
          {busy ? "Checking…" : "Check again"}
        </button>
        <Link
          to="/free-bets"
          className="rounded-lg border border-gray-300 px-6 py-3 text-sm font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-300"
        >
          Browse the free-bet offers
        </Link>
      </div>

      <p className="mx-auto mt-6 max-w-xl text-sm leading-6 text-gray-500 dark:text-gray-400">
        Still showing this later on? Email{" "}
        <a href="mailto:support@everyonesawinner.uk" className="text-indigo-600 underline hover:text-indigo-700">
          support@everyonesawinner.uk
        </a>{" "}
        with the time you paid and we'll sort it out — you will not be left paying for something you can't use.
      </p>
    </PageHeader>
  );
}
