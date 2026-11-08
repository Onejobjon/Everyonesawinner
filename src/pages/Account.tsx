/**
 * /account — YOUR OWN PLAN, AND HOW TO STOP IT.
 *
 * WHY THIS PAGE EXISTS (2026-11-08). The terms promise "you can cancel at any
 * time" and "your access continues to the end of the period you have already paid
 * for". Until this page, the only way to cancel was to email the owner, so the
 * promise depended on a human reading an inbox. Cancelling is now one page and one
 * button — as easy as subscribing — and it is reversible until the date access
 * actually ends.
 *
 * THE RULES THIS PAGE FOLLOWS
 *  - Everything shown comes from the SERVER (`GET /api/subscription`), which reads
 *    the one account record. Nothing is computed from a local flag, and the
 *    cancel/resume calls carry only the session token: the server decides whose
 *    subscription it is (src/server/subscription-api.ts).
 *  - The date access ends is shown BEFORE confirming, and again afterwards.
 *  - No guilt copy, no "are you sure you want to lose access", no hidden button.
 *    Cancel and "keep my subscription" are the same size and both say what they do.
 *  - A customer with no paid plan gets a plain explanation, never a broken page.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import { useAuth } from "../lib/auth";

/** The server's answer (src/server/subscription.ts — SubscriptionView). */
interface SubscriptionView {
  email: string;
  state: "none" | "comp" | "owner" | "renewing" | "ending" | "past_due" | "ended";
  plan: "starter" | "pro" | "annual" | null;
  planLabel: string | null;
  pricePence: number | null;
  priceInterval: "month" | "year" | null;
  priceText: string | null;
  renews: boolean;
  entitled: boolean;
  currentPeriodEnd: string | null;
  accessEndsAt: string | null;
  canceledAt: string | null;
  comp: { plan: string; endsAt: string | null; permanent: boolean; note: string | null } | null;
  canResume: boolean;
  canCancel: boolean;
  providerBlockedReason: string | null;
  stripe: { hasSubscription: boolean; configured: boolean; changed: boolean };
}

/** "8 December 2026" — a date a person can act on, in UK time. */
function longDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/London",
  });
}

interface ApiAnswer {
  status: number;
  body: {
    ok?: boolean;
    message?: string;
    error?: string;
    subscription?: SubscriptionView;
  } | null;
}

/** One call to the server, always with the session token and never an email. */
async function callApi(path: string, token: string, method: "GET" | "POST"): Promise<ApiAnswer> {
  try {
    const res = await fetch(path, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
    });
    let body: ApiAnswer["body"] = null;
    try {
      body = (await res.json()) as ApiAnswer["body"];
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

export default function Account() {
  const { user, sessionStatus, refresh } = useAuth();
  const navigate = useNavigate();
  const [view, setView] = useState<SubscriptionView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"cancel" | "resume" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const token = user?.token ?? "";

  // Not signed in → the sign-in page, which brings them straight back here.
  useEffect(() => {
    if (sessionStatus === "anon") {
      navigate("/login?redirect=" + encodeURIComponent("/account"), { replace: true });
    }
  }, [sessionStatus, navigate]);

  const load = useCallback(async () => {
    if (!token) return;
    const answer = await callApi("/api/subscription", token, "GET");
    if (answer.status === 200 && answer.body?.subscription) {
      setView(answer.body.subscription);
      setLoadError(null);
      return;
    }
    setLoadError(
      answer.body?.message ||
        "We couldn't load your plan just now. Nothing has changed — try again in a moment.",
    );
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: "cancel" | "resume") => {
    if (!token) return;
    setBusy(action);
    setActionError(null);
    setNotice(null);
    const answer = await callApi(`/api/subscription/${action}`, token, "POST");
    setBusy(null);
    if (answer.body?.subscription) setView(answer.body.subscription);
    if (answer.status >= 200 && answer.status < 300 && answer.body?.ok) {
      setConfirming(false);
      setNotice(
        answer.body.message ||
          (action === "cancel"
            ? "Done — your subscription will not renew."
            : "Done — your subscription will renew as before."),
      );
      // The rest of the site reads /api/me, so let it hear the new answer too.
      void refresh();
      return;
    }
    setActionError(
      answer.body?.message ||
        "We couldn't save that change, so your subscription is unchanged. Please try again in a moment.",
    );
  };

  if (sessionStatus === "checking" || (sessionStatus === "authed" && !view && !loadError)) {
    return (
      <PageHeader title="Your account" subtitle="Checking your plan…">
        <div className="flex justify-center py-16">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
        </div>
      </PageHeader>
    );
  }

  if (sessionStatus === "error") {
    return (
      <PageHeader
        title="We couldn't check your account"
        subtitle="The account service isn't responding, so we won't show or change anything unchecked. Nothing has happened to your subscription — please try again in a moment."
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

  if (sessionStatus === "anon" || !user) return null; // redirecting to /login

  return (
    <PageHeader title="Your account" subtitle={`Signed in as ${user.email}`}>
      <div className="mx-auto mt-8 max-w-2xl space-y-6">
        {loadError ? (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <p>{loadError}</p>
            <button onClick={() => void load()} className="mt-3 font-semibold underline">
              Try again
            </button>
          </div>
        ) : null}

        {notice ? (
          <div
            role="status"
            className="rounded-xl border border-emerald-300 bg-emerald-50 p-5 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
          >
            {notice}
          </div>
        ) : null}

        {actionError ? (
          <div
            role="alert"
            className="rounded-xl border border-red-300 bg-red-50 p-5 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
          >
            {actionError}
          </div>
        ) : null}

        {view ? (
          <>
            <PlanCard view={view} />

            {confirming && view.canCancel ? (
              <div className="rounded-xl border border-gray-300 bg-gray-50 p-6 dark:border-gray-700 dark:bg-gray-900">
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Cancel your subscription?
                </p>
                <p className="mt-2 text-sm leading-6 text-gray-700 dark:text-gray-300">
                  Your access ends on <strong>{longDate(view.accessEndsAt)}</strong>. Until that date
                  nothing changes: you keep every tool your plan includes. No further payment will
                  be taken, and you can undo this any time before{" "}
                  <strong>{longDate(view.accessEndsAt)}</strong>.
                </p>
                <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                  <button
                    onClick={() => void act("cancel")}
                    disabled={busy !== null}
                    className="flex-1 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-70"
                  >
                    {busy === "cancel" ? "Cancelling…" : "Yes, cancel at the end of the period"}
                  </button>
                  <button
                    onClick={() => setConfirming(false)}
                    disabled={busy !== null}
                    className="flex-1 rounded-xl border border-gray-300 px-4 py-3 text-sm font-semibold text-gray-800 hover:bg-white disabled:opacity-70 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-950"
                  >
                    Keep my subscription
                  </button>
                </div>
              </div>
            ) : null}

            {view.canCancel && !confirming ? (
              <div className="rounded-xl border border-gray-200 p-6 dark:border-gray-800">
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                  Cancel your subscription
                </h2>
                <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-400">
                  Cancel any time. Your access runs to the end of the period you have already paid
                  for — <strong>{longDate(view.accessEndsAt)}</strong> — and no further payment will
                  be taken. You can change your mind before then.
                </p>
                <button
                  onClick={() => {
                    setActionError(null);
                    setNotice(null);
                    setConfirming(true);
                  }}
                  className="mt-4 rounded-xl border border-gray-300 px-5 py-3 text-sm font-semibold text-gray-800 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
                >
                  Cancel subscription
                </button>
              </div>
            ) : null}

            {view.canResume ? (
              <div className="rounded-xl border border-gray-200 p-6 dark:border-gray-800">
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                  Keep my subscription
                </h2>
                <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-400">
                  Changed your mind? Turn the renewal back on and your plan carries on as before —
                  nothing was cancelled on the spot and nothing needs setting up again.
                </p>
                <button
                  onClick={() => void act("resume")}
                  disabled={busy !== null}
                  className="mt-4 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-70"
                >
                  {busy === "resume" ? "Turning it back on…" : "Keep my subscription"}
                </button>
              </div>
            ) : null}

            {view.providerBlockedReason ? (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                {view.providerBlockedReason}
              </div>
            ) : null}

            <PaymentProviderNote view={view} />
          </>
        ) : null}
      </div>
    </PageHeader>
  );
}

/** What the plan is, what it costs, and when it ends. One card, no jargon. */
function PlanCard({ view }: { view: SubscriptionView }) {
  const price = view.priceText ? `${view.planLabel} — ${view.priceText}` : null;

  return (
    <div className="rounded-2xl border border-gray-200 p-6 shadow-sm dark:border-gray-800">
      {view.state === "renewing" ? (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
            Active
          </p>
          <h2 className="mt-2 text-xl font-bold text-gray-900 dark:text-gray-100">{price}</h2>
          <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-400">
            Your plan renews automatically on <strong>{longDate(view.currentPeriodEnd)}</strong>. You
            can cancel at any time — access continues to the end of the period you have paid for.
          </p>
        </>
      ) : null}

      {view.state === "ending" ? (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
            Ending
          </p>
          <h2 className="mt-2 text-xl font-bold text-gray-900 dark:text-gray-100">{price}</h2>
          <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-400">
            Your plan will not renew. Your access ends on{" "}
            <strong>{longDate(view.accessEndsAt)}</strong> — you keep every tool until then, and no
            further payment will be taken.
          </p>
          {view.canceledAt ? (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              You cancelled on {longDate(view.canceledAt)}.
            </p>
          ) : null}
        </>
      ) : null}

      {view.state === "past_due" ? (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
            Payment problem
          </p>
          <h2 className="mt-2 text-xl font-bold text-gray-900 dark:text-gray-100">{price}</h2>
          <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-400">
            Your last payment didn't go through. Your access continues until{" "}
            <strong>{longDate(view.accessEndsAt)}</strong> while we retry the card — nothing has been
            cut off. If you would rather stop here, cancel below and nothing more will be attempted.
          </p>
        </>
      ) : null}

      {view.state === "comp" && view.comp ? (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-400">
            Free access
          </p>
          <h2 className="mt-2 text-xl font-bold text-gray-900 dark:text-gray-100">
            {view.comp.plan === "pro" || view.comp.plan === "annual"
              ? "Pro"
              : view.comp.plan === "starter"
                ? "Starter"
                : view.comp.plan}{" "}
            — free
          </h2>
          <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-400">
            {view.comp.permanent
              ? "You have free access with no end date. You are not paying anything."
              : `You have free access until ${longDate(view.comp.endsAt)}. You are not paying anything.`}
          </p>
          {view.comp.note ? (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{view.comp.note}</p>
          ) : null}
        </>
      ) : null}

      {view.state === "owner" ? (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-400">
            Owner seat
          </p>
          <h2 className="mt-2 text-xl font-bold text-gray-900 dark:text-gray-100">
            Full access — no payments
          </h2>
          <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-400">
            This is the owner's own account. There is no subscription and nothing to cancel.
          </p>
        </>
      ) : null}

      {view.state === "ended" ? (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
            Ended
          </p>
          <h2 className="mt-2 text-xl font-bold text-gray-900 dark:text-gray-100">
            Your plan has ended
          </h2>
          <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-400">
            {view.currentPeriodEnd
              ? `Access ran to ${longDate(view.currentPeriodEnd)} and has now stopped. `
              : "There is no active period on this account. "}
            No further payment will be taken. You can start a plan again whenever you like.
          </p>
          <Link
            to="/subscribe"
            className="mt-4 inline-block rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            See the plans
          </Link>
        </>
      ) : null}

      {view.state === "none" ? (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
            No paid plan
          </p>
          <h2 className="mt-2 text-xl font-bold text-gray-900 dark:text-gray-100">
            You don't have a subscription
          </h2>
          <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-400">
            There is nothing to cancel and you have not paid anything. The free pages — the offers
            list, the guide and the calculator explainer — stay free. The oddsmatcher, calculator
            and dashboard come with a plan.
          </p>
          <Link
            to="/subscribe"
            className="mt-4 inline-block rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            See the plans
          </Link>
        </>
      ) : null}
    </div>
  );
}

/**
 * The honest line about how the plan is paid for — the bit that says whether a card
 * is involved at all. Never claims a payment provider was told something unless
 * it was (view.stripe.changed).
 */
function PaymentProviderNote({ view }: { view: SubscriptionView }) {
  if (view.state === "comp" || view.state === "owner" || view.state === "none") return null;
  const text = view.stripe.hasSubscription
    ? view.stripe.configured
      ? "Your plan is paid by card. Cancelling tells our payment provider to stop the renewal, so no further payment is taken."
      : "Your plan is linked to a subscription at our payment provider."
    : "This plan was set up by hand rather than by card, so there is no card on this account and nothing will be taken. We still record your decision and your access ends on the date shown.";
  return <p className="px-1 text-xs leading-5 text-gray-500 dark:text-gray-400">{text}</p>;
}
