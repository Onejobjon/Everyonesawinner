/**
 * THE BROWSER'S SIDE OF CHECKOUT — one contract, one set of sentences.
 *
 * WHY THIS FILE EXISTS (2026-11-05): the plan buttons on /subscribe, the pricing
 * section of the home page and the paywall upgrade screen all said
 * "Checkout opens shortly" and were `disabled`. That is honest but dead: the
 * moment the owner's Stripe keys exist, someone would still have had to build the
 * wiring. So the wiring is here, tested, and pointed at the ONE endpoint that
 * already exists — `POST /api/checkout` (serve-static.ts → src/server/checkout.ts).
 * There is deliberately no second contract: the request body is `{ plan }`, the
 * account email comes from the SESSION on the server, and the refusal codes below
 * are exactly the ones `createCheckoutSession()` can return.
 *
 * THREE RULES THIS FILE KEEPS:
 *   1. NOTHING here ever claims a payment succeeded. A success is a URL to send
 *      the browser to; the only thing that grants access is the server, via the
 *      webhook and `GET /api/me`.
 *   2. Every outcome has a sentence a customer can read. A refusal code is never
 *      shown alone, and an unknown code still gets a plain-English line (with the
 *      code as a support reference, not as the message).
 *   3. The "No plan can be bought yet" claim is a FUNCTION OF THE BILLING SWITCH,
 *      not a sentence typed into a page. It is derived from the same readiness
 *      answer the endpoint gives (`GET /api/checkout` → `canTakeSubscriptionPayments`),
 *      so it cannot survive the day the flag flips.
 *
 * NO SERVER IMPORTS. This module is bundled into the browser; importing
 * src/server/* here would ship Stripe logic to visitors.
 */
import type { Plan } from "./auth";

/* ------------------------------------------------------------------ *
 * The readiness answer: is a plan actually buyable from this page?
 * ------------------------------------------------------------------ */

/**
 *  open    — the endpoint says every blocker is cleared (flag on, keys, prices)
 *  closed  — the endpoint answered and said no (the state today: flag off)
 *  unknown — we could not read the answer at all (endpoint down/unreachable)
 *
 * `unknown` is NOT treated as open anywhere. Failing closed means a visitor is
 * told "you can't buy yet" rather than being walked into a checkout that cannot
 * exist.
 */
export type BillingState = "open" | "closed" | "unknown";

export interface BillingSnapshot {
  state: BillingState;
  /** The flag as the server reports it (false when unknown). */
  enabled: boolean;
  /** The server's blocker list, for the owner; never rendered to customers. */
  blockers: string[];
}

export const UNKNOWN_BILLING: BillingSnapshot = { state: "unknown", enabled: false, blockers: [] };

interface ReadinessDeps {
  fetchImpl?: typeof fetch;
  /** Defaults to same-origin (""), which is what the browser wants. */
  baseUrl?: string;
}

/** Ask the endpoint whether a plan can be bought. Never throws. */
export async function readBillingReadiness(deps: ReadinessDeps = {}): Promise<BillingSnapshot> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = deps.baseUrl ?? "";
  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/checkout`, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    return UNKNOWN_BILLING;
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // A non-JSON answer (a proxy error page, a static host with no API) is not a
    // readiness answer. Fail closed.
    return UNKNOWN_BILLING;
  }
  const billing = (body as { billing?: Record<string, unknown> } | null)?.billing;
  if (!billing || typeof billing !== "object" || typeof billing.canTakeSubscriptionPayments !== "boolean") {
    return UNKNOWN_BILLING;
  }
  const blockers = Array.isArray(billing.blockers)
    ? billing.blockers.filter((b): b is string => typeof b === "string")
    : [];
  return {
    state: billing.canTakeSubscriptionPayments ? "open" : "closed",
    enabled: billing.enabled === true,
    blockers,
  };
}

/* ------------------------------------------------------------------ *
 * The claim, driven by the switch
 * ------------------------------------------------------------------ */

/** The owner's claim while checkout genuinely cannot take money. */
export const NOT_FOR_SALE_HEADLINE = "No plan can be bought yet.";

export interface PlansForSaleNotice {
  /** The headline claim. Derived, never typed into a page. */
  headline: string;
  /** One or two sentences of detail under it. */
  detail: string;
  /** True only when the endpoint says a plan can be bought right now. */
  onSale: boolean;
}

/**
 * What to say about whether plans are on sale.
 *
 * `open` drops the "planned"/"can't buy" wording because it has stopped being
 * true; everything else keeps it, because from this visitor's seat nothing can be
 * bought and no payment can be taken.
 */
export function plansForSaleNotice(snapshot: BillingSnapshot): PlansForSaleNotice {
  if (snapshot.state === "open") {
    return {
      onSale: true,
      headline: "You can buy a plan now.",
      detail:
        "Choosing a plan takes you to our payment provider to pay by card. Nothing unlocks until our server confirms the payment.",
    };
  }
  if (snapshot.state === "closed") {
    return {
      onSale: false,
      headline: NOT_FOR_SALE_HEADLINE,
      detail:
        "Checkout opens shortly — we're finishing the payment setup, and no payment can be taken until it does.",
    };
  }
  return {
    onSale: false,
    headline: NOT_FOR_SALE_HEADLINE,
    detail:
      "We can't reach our checkout service from this page, so nothing can be bought and no payment can be taken. Try again in a moment.",
  };
}

/**
 * The "(planned)" qualifier next to a printed price.
 *
 * The AMOUNT is the owner's decision and never changes here; only the qualifier
 * follows the switch. Empty string when plans are genuinely on sale.
 */
export function priceQualifier(snapshot: BillingSnapshot): string {
  return snapshot.state === "open" ? "" : " (planned)";
}

/* ------------------------------------------------------------------ *
 * Starting a checkout
 * ------------------------------------------------------------------ */

/** Every refusal code `POST /api/checkout` can return, plus two of our own. */
export const KNOWN_REFUSAL_CODES = [
  // src/server/checkout.ts, the refusal ladder
  "checkout_disabled",
  "unknown_plan",
  "invalid_email",
  "bad_origin",
  "price_not_configured",
  "stripe_not_configured",
  "price_not_recurring",
  "price_inactive",
  "price_currency_mismatch",
  "price_amount_mismatch",
  "price_interval_mismatch",
  "account_cannot_subscribe",
  "stripe_error",
  "stripe_unreachable",
  "stripe_key_rejected",
  // serve-static.ts, before the ladder
  "not_signed_in",
  "account_not_found",
  // client-side: a 200 that carried no address to send the browser to
  "no_redirect",
] as const;

export type CheckoutStart =
  /** A real Stripe Checkout session: send the browser to `url`. */
  | { kind: "redirect"; plan: Plan; url: string }
  /** No usable session: sign in, then come back to the plan they picked. */
  | { kind: "sign_in"; plan: Plan; reason: "no_session" | "session_expired" | "account_missing" }
  /** The endpoint refused, and said why. `code` is for support, never the message. */
  | { kind: "refused"; plan: Plan; status: number; code: string; serverMessage: string | null }
  /** We never got an answer: nothing was created and nothing was charged. */
  | { kind: "network"; plan: Plan; detail: string };

export interface StartCheckoutInput {
  plan: Plan;
  /** The session token from `useAuth()`. Without it we do not even call. */
  token?: string | null;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/** Where a signed-out visitor is sent, so they come back to the same plan. */
export function signInPathForPlan(plan: Plan): string {
  return `/login?redirect=${encodeURIComponent(`/subscribe?plan=${plan}`)}`;
}

/**
 * Start a checkout for one plan.
 *
 * Never throws, never invents a success. The only success is a URL the server
 * gave us; anything else is a state the page must render honestly.
 */
export async function startCheckout(input: StartCheckoutInput): Promise<CheckoutStart> {
  const { plan } = input;
  const token = (input.token ?? "").trim();
  if (!token) return { kind: "sign_in", plan, reason: "no_session" };

  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.baseUrl ?? "";

  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/checkout`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ plan }),
    });
  } catch (e) {
    return { kind: "network", plan, detail: String(e) };
  }

  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }

  if (!body) {
    // A non-JSON answer means we cannot know what happened, so we say exactly
    // that: nothing was created, no payment was taken.
    return { kind: "network", plan, detail: `HTTP ${res.status} with no readable answer` };
  }

  const code = typeof body.code === "string" ? body.code : "";
  const message = typeof body.message === "string" ? body.message : null;

  if (res.status === 401) {
    if (code === "account_not_found") return { kind: "sign_in", plan, reason: "account_missing" };
    return { kind: "sign_in", plan, reason: "session_expired" };
  }

  if (body.ok === true) {
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (/^https?:\/\//i.test(url)) return { kind: "redirect", plan, url };
    // A 200 with no address is not a success we can act on.
    return { kind: "refused", plan, status: res.status, code: "no_redirect", serverMessage: message };
  }

  return {
    kind: "refused",
    plan,
    status: res.status,
    code: code || `http_${res.status}`,
    serverMessage: message,
  };
}

/* ------------------------------------------------------------------ *
 * What the customer reads
 * ------------------------------------------------------------------ */

export interface CheckoutNotice {
  /** "info" = this is how it works; "warn" = something stopped it. */
  tone: "info" | "warn";
  title: string;
  body: string;
  /** Offer "Try again" — only when trying again could plausibly work. */
  retry: boolean;
  /** Offer the free-access route (the owner can grant a named account access). */
  freeAccess: boolean;
  /** Technical reference for support. Never the whole message. */
  reference?: string;
}

const SUPPORT_EMAIL = "support@everyonesawinner.uk";

/** Human sentences for every refusal the endpoint can produce. */
export function noticeFor(result: Exclude<CheckoutStart, { kind: "redirect" }>): CheckoutNotice {
  if (result.kind === "network") {
    return {
      tone: "warn",
      title: "We couldn't reach our checkout",
      body:
        "Nothing was sent to our payment provider, so no payment has been taken. " +
        "This is usually a moment's trouble — try again.",
      retry: true,
      freeAccess: false,
    };
  }

  if (result.kind === "sign_in") {
    return {
      tone: "info",
      title: result.reason === "account_missing" ? "That account no longer exists" : "Please sign in again",
      body:
        result.reason === "account_missing"
          ? "We couldn't find the account this session belongs to, so no checkout was started and no payment has been taken. Sign in again and choose your plan."
          : "Your sign-in has expired, so no checkout was started and no payment has been taken. Sign in again and choose your plan.",
      retry: false,
      freeAccess: false,
    };
  }

  switch (result.code) {
    case "checkout_disabled":
      return {
        tone: "warn",
        title: "No plan can be bought yet",
        body:
          "Checkout is switched off on this site, so nothing was sent to our payment provider and no payment has been taken. " +
          "Plans aren't on sale yet — this isn't something you did wrong.",
        retry: false,
        freeAccess: true,
        reference: result.code,
      };

    case "stripe_not_configured":
    case "price_not_configured":
    case "price_inactive":
      return {
        tone: "warn",
        title: "Checkout isn't ready yet",
        body:
          "We can't take a card payment for this plan yet because our payment setup is incomplete. " +
          "Nothing was created and no payment has been taken. This one is ours to finish.",
        retry: false,
        freeAccess: true,
        reference: result.code,
      };

    case "account_cannot_subscribe":
      return {
        tone: "warn",
        title: "Our payment provider can't take this subscription yet",
        body:
          "Nothing was created and no payment has been taken. This is our side to fix, not yours — " +
          `email ${SUPPORT_EMAIL} and we'll sort your access out in the meantime.`,
        // The body already names the address, so the free-access line would repeat it.
        retry: false,
        freeAccess: false,
        reference: result.code,
      };

    case "price_not_recurring":
    case "price_currency_mismatch":
    case "price_amount_mismatch":
    case "price_interval_mismatch":
      return {
        tone: "warn",
        title: "We stopped this checkout",
        body:
          "The payment details behind this plan don't match what this page shows you, so we won't take your money for it. " +
          "Nothing was charged. This is our mistake, not yours — " +
          `email ${SUPPORT_EMAIL} and we'll fix it and get you set up.`,
        retry: false,
        freeAccess: false,
        reference: result.code,
      };

    case "stripe_unreachable":
    case "stripe_error":
    case "stripe_key_rejected":
      return {
        tone: "warn",
        title: "Our payment provider didn't answer",
        body:
          "We couldn't reach the payment provider, so nothing was created and no payment has been taken. " +
          "Try again in a moment.",
        retry: true,
        freeAccess: false,
        reference: result.code,
      };

    case "unknown_plan":
      return {
        tone: "warn",
        title: "That isn't a plan we sell",
        body:
          "No checkout was started and no payment has been taken. Choose one of the plans on this page.",
        retry: false,
        freeAccess: false,
        reference: result.code,
      };

    case "invalid_email":
      return {
        tone: "warn",
        title: "We need a working email on your account",
        body:
          "The email on this account doesn't look like a working address, so we can't start a checkout. " +
          "No payment has been taken. Update it, or email us and we'll fix it.",
        retry: false,
        freeAccess: false,
        reference: result.code,
      };

    case "bad_origin":
    case "no_redirect":
      return {
        tone: "warn",
        title: "We couldn't finish starting the checkout",
        body:
          "Nothing was created and no payment has been taken. Try again, and if it keeps happening, email us — " +
          "it is our side that needs fixing.",
        retry: true,
        freeAccess: true,
        reference: result.code,
      };

    default:
      // An unknown code still gets a readable sentence. The code itself is only a
      // reference for support — it is never the message a customer is left with.
      return {
        tone: "warn",
        title: "We couldn't start the checkout",
        body:
          "The payment provider refused this request, so nothing was created and no payment has been taken. " +
          `Try again, and if it still fails email ${SUPPORT_EMAIL} and quote the reference below.`,
        retry: true,
        freeAccess: true,
        reference: result.code || "unknown",
      };
  }
}

/** The free-access sentence, kept in one place so it cannot drift per page. */
export const FREE_ACCESS_NOTE =
  "You don't have to wait: the owner can grant your account free access while checkout is closed — email us from the address on this account.";

/** Remember the chosen plan for /subscribe/success — a display hint, not proof. */
export function rememberChosenPlan(plan: Plan): void {
  try {
    localStorage.setItem("eaw_pending_plan", plan);
  } catch {
    /* private mode / storage disabled — the success page still works */
  }
}
