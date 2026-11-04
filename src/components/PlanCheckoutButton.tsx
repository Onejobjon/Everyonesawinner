import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth, type Plan } from "../lib/auth";
import {
  FREE_ACCESS_NOTE,
  UNKNOWN_BILLING,
  noticeFor,
  plansForSaleNotice,
  readBillingReadiness,
  rememberChosenPlan,
  signInPathForPlan,
  startCheckout,
  type BillingSnapshot,
  type CheckoutNotice,
} from "../lib/checkout-client";

/**
 * THE PLAN BUTTON — one control, used everywhere a plan is offered.
 *
 * It replaced four `disabled` placeholders that all said "Checkout opens
 * shortly": three on /subscribe, two on the paywall's upgrade screen and one per
 * plan in the home page's pricing section. A dead button tells a visitor nothing
 * they can act on; this one POSTs to the endpoint that already exists
 * (`POST /api/checkout`, see src/lib/checkout-client.ts) and renders whatever
 * really happened:
 *
 *   • a session URL  → the browser goes to Stripe;
 *   • not signed in  → /login?redirect=/subscribe?plan=<plan>, so they come back
 *                      to the plan they picked;
 *   • a refusal      → the sentence for that exact code, plus "Try again" when
 *                      retrying could work, plus the free-access route when the
 *                      reason is our side not being ready;
 *   • no answer      → "nothing was sent, no payment was taken", with a retry.
 *
 * It is never `disabled` into silence: while billing is off the button still
 * works, and pressing it shows the specific, honest explanation instead of a
 * grey rectangle. The only time it is disabled is the half-second a request is
 * in flight, so a double-click cannot start two checkouts.
 */

const SUPPORT_EMAIL = "support@everyonesawinner.uk";

/**
 * The panel a refusal renders. Kept as its own pure component so a test can
 * render it with `react-dom/server` and read the actual markup a customer gets —
 * not a description of it.
 */
export function CheckoutNoticePanel({
  notice,
  pending = false,
  onRetry,
}: {
  notice: CheckoutNotice;
  pending?: boolean;
  onRetry?: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`mt-3 rounded-xl border p-4 text-left ${
        notice.tone === "warn"
          ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
          : "border-gray-300 bg-gray-50 text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
      }`}
    >
      <p className="text-sm font-semibold">{notice.title}</p>
      <p className="mt-1 text-sm leading-6">{notice.body}</p>

      {notice.freeAccess && (
        <p className="mt-2 text-sm leading-6">
          {FREE_ACCESS_NOTE}{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}?subject=Free%20access%20to%20Everyone%27s%20A%20Winner`}
            className="underline font-medium"
          >
            Email {SUPPORT_EMAIL}
          </a>
          .
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {notice.retry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={pending}
            className="rounded-lg border border-gray-400 px-3 py-1.5 text-sm font-semibold hover:bg-white/60 disabled:opacity-60 dark:border-gray-600 dark:hover:bg-gray-800"
          >
            {pending ? "Trying…" : "Try again"}
          </button>
        )}
        {notice.reference && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            Reference for support: <code>{notice.reference}</code>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * ONE readiness request per page load, shared by every button and every price
 * label on the page (the home page alone renders three buttons). The answer is
 * the endpoint's own `canTakeSubscriptionPayments`, so the "No plan can be bought
 * yet" claim and the buttons cannot disagree with the billing switch.
 */
let readinessPromise: Promise<BillingSnapshot> | null = null;

export function useBillingReadiness(): BillingSnapshot {
  const [snapshot, setSnapshot] = useState<BillingSnapshot | null>(null);
  useEffect(() => {
    let alive = true;
    readinessPromise ??= readBillingReadiness();
    void readinessPromise.then((s) => {
      if (alive) setSnapshot(s);
    });
    return () => {
      alive = false;
    };
  }, []);
  // Before the answer arrives we fail closed: "not for sale" is the safe claim.
  return snapshot ?? UNKNOWN_BILLING;
}

export interface PlanCheckoutButtonProps {
  plan: Plan;
  /** How the plan is named in the button — "Starter", "Pro", "Pro Annual". */
  name: string;
  className?: string;
  /** Where the notice panel sits. "card" is the default, inside a plan card. */
  align?: "card" | "wide";
}

export default function PlanCheckoutButton({ plan, name, className, align = "card" }: PlanCheckoutButtonProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const readiness = useBillingReadiness();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<CheckoutNotice | null>(null);

  const statusId = `checkout-status-${plan}`;
  const sale = plansForSaleNotice(readiness);

  async function begin() {
    setNotice(null);
    // Signed out: send them to sign in and straight back to this plan. We do not
    // call the endpoint first — it would only answer 401.
    if (!user?.token) {
      navigate(signInPathForPlan(plan));
      return;
    }
    setPending(true);
    try {
      const result = await startCheckout({ plan, token: user.token });
      if (result.kind === "redirect") {
        rememberChosenPlan(plan);
        window.location.assign(result.url);
        return;
      }
      if (result.kind === "sign_in") {
        navigate(signInPathForPlan(plan));
        return;
      }
      setNotice(noticeFor(result));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={align === "wide" ? "" : "mt-6"}>
      <button
        type="button"
        onClick={() => void begin()}
        disabled={pending}
        aria-describedby={statusId}
        className={
          className ??
          "w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-70"
        }
      >
        {pending ? `Opening checkout for ${name}…` : `Choose ${name}`}
      </button>

      <p id={statusId} className="mt-2 text-xs leading-5 text-center text-gray-500 dark:text-gray-400">
        {sale.onSale
          ? "You'll be taken to our payment provider to pay by card."
          : readiness.state === "closed"
            ? "No payment can be taken — choosing a plan shows you exactly why."
            : "We can't confirm checkout is available right now — choosing a plan will tell you."}
      </p>

      {notice && <CheckoutNoticePanel notice={notice} pending={pending} onRetry={() => void begin()} />}
    </div>
  );
}
