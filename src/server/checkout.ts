/**
 * CHECKOUT — the one place a plan is sold.
 *
 * WHY THIS FILE IS BUILT BEFORE IT CAN BE USED (2026-11-03): the owner's blocker
 * is that nothing can be charged. When he completes the Stripe reconnect we want
 * billing to switch on, not to start. So the machinery exists, fully guarded, and
 * every refusal below is a sentence the owner can act on.
 *
 * THE REFUSAL LADDER (checked in this order; nothing is created at any step):
 *   1. CHECKOUT_ENABLED is off            → 503 checkout_disabled
 *   2. no durable database (DATABASE_URL unset)
 *                                        → 503 storage_not_durable
 *   3. the plan is not one we sell        → 400 unknown_plan
 *   4. the email is not an email          → 400 invalid_email
 *   5. the return origin is not a URL     → 400 bad_origin
 *   6. no Stripe price id for that plan   → 503 price_not_configured
 *   7. no secret key / a publishable one  → 503 stripe_not_configured
 *   8. the Stripe price is not recurring  → 400 price_not_recurring
 *   9. the Stripe price is inactive       → 400 price_inactive
 *  10. the Stripe price is not in GBP     → 400 price_currency_mismatch
 *  11. the amount disagrees with /subscribe → 400 price_amount_mismatch
 *  12. the interval disagrees with /subscribe → 400 price_interval_mismatch
 *  13. Stripe cannot take subscription payments (the EXPRESS account today)
 *                                        → 503 account_cannot_subscribe
 *  14. any other Stripe error            → 502 stripe_error
 *
 * STEP 2 IS A MONEY BLOCKER, NOT A WARNING (2026-11-07). Customer accounts and
 * the Stripe event ledger are files on the hosting disk, and a publish replaces
 * that disk — proven, not inferred: an account created on the live site could not
 * be found after the next publish. Charging a customer whose login the next deploy
 * deletes is worse than refusing to charge them, so `DATABASE_URL` is part of the
 * same gate as the switch and the keys. Everything that is NOT taking money —
 * browsing, signup, sign-in, comps, free access — keeps working on the file
 * driver exactly as before.
 *
 * THERE IS NO FALLBACK. Not to `mode: "payment"`, not to another price, not to a
 * default tier. The express account's live prices are one-time prices; falling
 * back to one would take a customer's money for a purchase that buys no
 * subscription, which is the "one payment = permanent access" bug wearing a
 * checkout button. A one-time price is REFUSED (step 7), not repurposed.
 *
 * WHAT A SUCCESSFUL SESSION CARRIES, so the webhook can find the account later
 * (Stripe does not put our email on a subscription object — see
 * src/server/stripe-webhook.ts):
 *   • client_reference_id = the account email
 *   • metadata[email] = the account email
 *   • subscription_data[metadata][email] and [plan] = the same
 *   • customer_email = the account email (pre-fills Stripe's own form)
 *
 * NO STRIPE SDK. Two HTTPS calls with `fetch`, so a test can stub the network and
 * prove exactly what was and was not sent.
 */
import { isCheckoutEnabled, CHECKOUT_DISABLED_CODE, CHECKOUT_DISABLED_MESSAGE } from "./billing-switch";
import {
  PLAN_ORDER,
  PUBLISHED_PLANS,
  configuredPriceEnvs,
  formatPence,
  priceIdForPlan,
} from "./price-catalogue";
import { isKnownPlan, type Plan } from "./entitlement";
import { storageStatus, type StorageStatus } from "./storage";

export const STRIPE_API_BASE = "https://api.stripe.com/v1";

/** How long a verified price is trusted before we look again. */
const PRICE_CACHE_TTL_MS = 10 * 60 * 1000;

type PriceVerdict = { ok: true } | { ok: false; code: string; message: string };

const priceCache = new Map<string, { at: number; verdict: PriceVerdict }>();

/** Tests (and a config change) can forget what we learned about a price. */
export function resetCheckoutCaches(): void {
  priceCache.clear();
}

export type CheckoutRefusal = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export type CheckoutSuccess = {
  ok: true;
  /** Where to send the customer: Stripe's hosted checkout page. */
  url: string;
  sessionId: string | null;
  plan: Plan;
  /** The Stripe price id sold. Never a caller-supplied one. */
  priceId: string;
  /** Always "subscription" — the only mode this function can produce. */
  mode: "subscription";
};

export type CheckoutResult = CheckoutSuccess | CheckoutRefusal;

export interface CheckoutInput {
  /** The signed-in account's email. Comes from the session, never the body. */
  email: string;
  /** "starter" | "pro" | "annual" — validated against the catalogue. */
  plan: unknown;
  /** The site origin to return to (https://www.everyonesawinner.uk). */
  origin: string;
}

export interface CheckoutDeps {
  /** Stubbed in tests. */
  fetchImpl?: typeof fetch;
  /** Injected clock for the price cache. */
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Refused because there is nowhere durable to keep the account being paid for. */
export const STORAGE_NOT_DURABLE_CODE = "storage_not_durable";

/**
 * The one sentence for "no database, so no money".
 *
 * It is the same text in the refusal and in `blockers` on purpose: an owner who
 * reads either one must get the same instruction, and the reason has to name the
 * consequence (a lost login), not just the missing variable.
 */
export function storageNotDurableMessage(status: StorageStatus = storageStatus()): string {
  return (
    `No database is configured (${status.envVar} is not set), so every customer account and Stripe ledger entry is ` +
    `a file that the next publish deletes. A paying customer would lose their login. ` +
    `Set ${status.envVar} to a Postgres connection string before taking any payment.`
  );
}

function refuse(status: number, code: string, message: string): CheckoutRefusal {
  return { ok: false, status, code, message };
}

/** Read a Stripe error body into {code,message} without throwing on junk. */
function stripeError(body: unknown): { code: string | null; message: string | null; param: string | null } {
  const err = (body as { error?: Record<string, unknown> } | null)?.error;
  if (!err || typeof err !== "object") return { code: null, message: null, param: null };
  const asString = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return { code: asString(err.code), message: asString(err.message), param: asString(err.param) };
}

/**
 * Does this Stripe error mean "this account cannot sell subscriptions"?
 *
 * The express account answers a subscription-mode session with a message about
 * capabilities, activation or live charges. We match the message because Stripe
 * has used several codes for it over the years, and we would rather explain the
 * real cause than print a raw API error at the owner.
 */
function looksLikeAccountCannotSubscribe(message: string | null, code: string | null): boolean {
  const haystack = `${code ?? ""} ${message ?? ""}`.toLowerCase();
  if (!haystack.trim()) return false;
  return [
    "cannot currently make live charges",
    "cannot make live charges",
    "cannot create subscriptions",
    "not activated",
    "not yet activated",
    "capabilit",
    "express",
    "platform_account",
    "account_invalid",
    "subscription mode is not supported",
    "your account cannot",
    "requires an active account",
  ].some((needle) => haystack.includes(needle));
}

/**
 * Verify that the configured Stripe price is the plan /subscribe prints.
 *
 * This is the guard that makes "never creates a one-time price by accident" true:
 * a price with no `recurring` object is a one-off charge, and a subscription
 * session cannot be built from it. We refuse instead of letting Stripe decide.
 */
async function verifyPrice(
  priceId: string,
  plan: Plan,
  fetchImpl: typeof fetch,
  secretKey: string,
  nowMs: number,
): Promise<PriceVerdict> {
  const cached = priceCache.get(priceId);
  if (cached && nowMs - cached.at < PRICE_CACHE_TTL_MS) return cached.verdict;

  const published = PUBLISHED_PLANS[plan];
  let res: Response;
  try {
    res = await fetchImpl(`${STRIPE_API_BASE}/prices/${encodeURIComponent(priceId)}`, {
      method: "GET",
      headers: { authorization: `Bearer ${secretKey}` },
    });
  } catch (e) {
    return {
      ok: false,
      code: "stripe_unreachable",
      message:
        `Could not reach Stripe to check the ${published.label} price (${String(e)}). ` +
        `Nothing was created and no payment was taken.`,
    };
  }

  let body: Record<string, any> = {};
  try {
    body = (await res.json()) as Record<string, any>;
  } catch {
    body = {};
  }

  if (!res.ok) {
    const err = stripeError(body);
    const code = looksLikeAccountCannotSubscribe(err.message, err.code)
      ? "account_cannot_subscribe"
      : "stripe_key_rejected";
    return {
      ok: false,
      code,
      message:
        code === "account_cannot_subscribe"
          ? `${published.label}: Stripe says this account cannot sell subscriptions (${err.message ?? res.status}). ` +
            `Nothing was created. The owner needs to complete the Stripe reconnect so the account can take subscription payments.`
          : `Stripe refused the price lookup for ${published.label} (${err.message ?? `HTTP ${res.status}`}). ` +
            `Nothing was created. Check STRIPE_SECRET_KEY.`,
    };
  }

  const price = body ?? {};
  const recurring = price.recurring as { interval?: string; interval_count?: number } | null | undefined;

  if (!recurring || typeof recurring !== "object") {
    return {
      ok: false,
      code: "price_not_recurring",
      message:
        `The Stripe price configured for ${published.label} (${priceId}) is a ONE-TIME price, not a subscription price. ` +
        `A subscription cannot be sold with it, and it will not be repurposed into a one-off payment — that would take ` +
        `money for something that buys no recurring plan. Nothing was created. Create a recurring price at ` +
        `${formatPence(published.amountPence)} / ${published.interval} and set ${published.env}.`,
    };
  }
  if (price.active === false) {
    return {
      ok: false,
      code: "price_inactive",
      message: `The Stripe price configured for ${published.label} (${priceId}) is archived/inactive. Nothing was created. Set ${published.env} to an active price.`,
    };
  }
  if (typeof price.currency === "string" && price.currency.toLowerCase() !== "gbp") {
    return {
      ok: false,
      code: "price_currency_mismatch",
      message:
        `The Stripe price for ${published.label} is in ${String(price.currency).toUpperCase()}, but every price we print is in ` +
        `pounds sterling. Nothing was created — a customer must not be charged in a currency we did not show them.`,
    };
  }
  if (typeof price.unit_amount === "number" && price.unit_amount !== published.amountPence) {
    return {
      ok: false,
      code: "price_amount_mismatch",
      message:
        `The Stripe price for ${published.label} is ${formatPence(price.unit_amount)} but the site advertises ` +
        `${formatPence(published.amountPence)}. Nothing was created: we do not charge an amount that differs from the page. ` +
        `Either set ${published.env} to the ${formatPence(published.amountPence)} price, or change the published price deliberately.`,
    };
  }
  if (typeof recurring.interval === "string" && recurring.interval !== published.interval) {
    return {
      ok: false,
      code: "price_interval_mismatch",
      message:
        `The Stripe price for ${published.label} bills every ${recurring.interval}, but the site says ${published.interval}ly. ` +
        `Nothing was created. Set ${published.env} to the price whose billing period matches the page.`,
    };
  }
  if (typeof recurring.interval_count === "number" && recurring.interval_count !== 1) {
    return {
      ok: false,
      code: "price_interval_mismatch",
      message:
        `The Stripe price for ${published.label} bills every ${recurring.interval_count} ${recurring.interval}s, but the site says ` +
        `every ${published.interval}. Nothing was created.`,
    };
  }

  const verdict: PriceVerdict = { ok: true };
  priceCache.set(priceId, { at: nowMs, verdict });
  return verdict;
}

/**
 * Create a Stripe Checkout session for one plan.
 *
 * Returns a refusal object — never throws, never half-creates. The caller (the
 * HTTP route) turns it into a status code and a sentence.
 */
export async function createCheckoutSession(
  input: CheckoutInput,
  deps: CheckoutDeps = {},
): Promise<CheckoutResult> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const nowMs = deps.nowMs ?? Date.now();

  // 1. THE SWITCH. Off by default; nothing below runs while it is off.
  if (!isCheckoutEnabled(env)) {
    return refuse(503, CHECKOUT_DISABLED_CODE, CHECKOUT_DISABLED_MESSAGE);
  }

  // 2. A DURABLE PLACE TO KEEP THE ACCOUNT. Without a database the customer's
  //    login is a file on a disk that the next publish replaces (proven
  //    2026-11-07), so a subscription sold today is an account lost tomorrow.
  //    This blocks only the taking of money: signup, sign-in, comps and free
  //    access all keep working on the file driver.
  const storage = storageStatus(env);
  if (!storage.durable) {
    return refuse(503, STORAGE_NOT_DURABLE_CODE, storageNotDurableMessage(storage));
  }

  // 3. The plan has to be one of ours — the client cannot name a price.
  if (!isKnownPlan(input.plan)) {
    return refuse(
      400,
      "unknown_plan",
      `"${String(input.plan)}" is not a plan we sell. Choose one of: ${PLAN_ORDER.join(", ")}.`,
    );
  }
  const plan = input.plan;
  const published = PUBLISHED_PLANS[plan];

  // 4. The email comes from the session, and has to look like one.
  const email = (input.email || "").trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return refuse(400, "invalid_email", "A signed-in account email is required to start a checkout.");
  }

  // 5. The return origin must be a plain http(s) URL — it cannot be `javascript:`
  //    or a relative path. WHICH http(s) origin is allowed is decided by the
  //    caller, because it depends on the hosts this build is served on: see
  //    src/server/return-origin.ts, which serve-static.ts uses to turn the
  //    proxy's claim into an allow-listed origin (or the request's own origin).
  const origin = (input.origin || "").trim().replace(/\/+$/, "");
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return refuse(400, "bad_origin", "Checkout needs a valid return address for the site.");
  }
  if (originUrl.protocol !== "https:" && originUrl.protocol !== "http:") {
    return refuse(400, "bad_origin", "Checkout needs a valid return address for the site.");
  }

  // 6. The price id for that plan, from the environment only.
  const priceId = priceIdForPlan(plan);
  if (!priceId) {
    return refuse(
      503,
      "price_not_configured",
      `No Stripe price is configured for ${published.label}. Set ${published.env} to the recurring price id for ` +
        `${formatPence(published.amountPence)} / ${published.interval}. Nothing was created.`,
    );
  }

  // 7. A secret key that can actually talk to Stripe.
  const secretKey = (env.STRIPE_SECRET_KEY || "").trim();
  if (!secretKey) {
    return refuse(
      503,
      "stripe_not_configured",
      "STRIPE_SECRET_KEY is not set, so no checkout can be created. Nothing was created and no payment was taken.",
    );
  }
  if (!/^(sk|rk)_(test|live)_/.test(secretKey)) {
    return refuse(
      503,
      "stripe_not_configured",
      "STRIPE_SECRET_KEY does not look like a Stripe secret or restricted key (it should start sk_ or rk_). " +
        "A publishable key cannot create a checkout. Nothing was created.",
    );
  }

  // 8–12. The Stripe price must be the recurring price the page advertises.
  const verdict = await verifyPrice(priceId, plan, fetchImpl, secretKey, nowMs);
  if (!verdict.ok) return refuse(400, verdict.code, verdict.message);

  // 13. Create the session. mode is a literal: there is no code path that can
  //     send "payment", so a one-off charge cannot be created from here.
  const successUrl = `${origin}/subscribe/success?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`;
  const cancelUrl = `${origin}/subscribe?checkout=cancelled&plan=${plan}`;
  const form = new URLSearchParams();
  form.set("mode", "subscription");
  form.set("line_items[0][price]", priceId);
  form.set("line_items[0][quantity]", "1");
  form.set("success_url", successUrl);
  form.set("cancel_url", cancelUrl);
  form.set("customer_email", email);
  form.set("client_reference_id", email);
  form.set("metadata[email]", email);
  form.set("metadata[plan]", plan);
  form.set("subscription_data[metadata][email]", email);
  form.set("subscription_data[metadata][plan]", plan);
  form.set("allow_promotion_codes", "false");

  let res: Response;
  try {
    res = await fetchImpl(`${STRIPE_API_BASE}/checkout/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (e) {
    return refuse(
      502,
      "stripe_unreachable",
      `Could not reach Stripe to create the checkout (${String(e)}). No payment was taken — please try again.`,
    );
  }

  let body: Record<string, any> = {};
  try {
    body = (await res.json()) as Record<string, any>;
  } catch {
    body = {};
  }

  if (!res.ok) {
    const err = stripeError(body);
    if (looksLikeAccountCannotSubscribe(err.message, err.code)) {
      return refuse(
        503,
        "account_cannot_subscribe",
        "Stripe says this account cannot take subscription payments yet, so no checkout was created and no payment " +
          "was taken. The owner completes the Stripe reconnect to fix this — a one-off payment is not offered instead, " +
          "because it would not buy a subscription.",
      );
    }
    return refuse(
      502,
      "stripe_error",
      `Stripe refused to create the checkout${err.message ? `: ${err.message}` : ""}. Nothing was created and no payment was taken.`,
    );
  }

  const url = typeof body.url === "string" ? body.url : "";
  if (!url) {
    return refuse(
      502,
      "stripe_error",
      "Stripe created a checkout but returned no address to send the customer to. Nothing has been charged — check Stripe.",
    );
  }

  return {
    ok: true,
    url,
    sessionId: typeof body.id === "string" ? body.id : null,
    plan,
    priceId,
    mode: "subscription",
  };
}

/** What is configured, in words the owner can act on. No secrets, booleans only. */
export interface BillingReadiness {
  flag: string;
  enabled: boolean;
  secretKeyConfigured: boolean;
  webhookSecretConfigured: boolean;
  plans: Array<{
    plan: Plan;
    label: string;
    price: string;
    interval: string;
    env: string;
    priceConfigured: boolean;
  }>;
  /** True only when every refusal in the ladder above is satisfied. */
  canTakeSubscriptionPayments: boolean;
  blockers: string[];
  /**
   * WHERE CUSTOMER RECORDS LIVE (2026-11-07).
   *
   * `durable: false` means every account, session and Stripe ledger entry is a
   * file that the next publish replaces — proven, not inferred: a test account
   * created on the live site could not be found after the next publish.
   *
   * It is reported here AND folded into `blockers` (and therefore into
   * `canTakeSubscriptionPayments`), because taking money for an account the next
   * deploy deletes is not a caveat on selling — it is a reason not to sell. The
   * full status stays on the object so the owner can see the backend and the
   * instruction in one place.
   */
  storage: StorageStatus;
}

export function billingReadiness(env: NodeJS.ProcessEnv = process.env): BillingReadiness {
  const enabled = isCheckoutEnabled(env);
  const secretKey = (env.STRIPE_SECRET_KEY || "").trim();
  const secretKeyConfigured = /^(sk|rk)_(test|live)_/.test(secretKey);
  const webhookSecretConfigured = (env.STRIPE_WEBHOOK_SECRET || "").trim() !== "";
  const plans = PLAN_ORDER.map((plan) => {
    const published = PUBLISHED_PLANS[plan];
    return {
      plan,
      label: published.label,
      price: formatPence(published.amountPence),
      interval: published.interval,
      env: published.env,
      priceConfigured: priceIdForPlan(plan) !== null,
    };
  });

  const storage = storageStatus(env);

  const blockers: string[] = [];
  if (!enabled) blockers.push(`Billing is off. Set ${"CHECKOUT_ENABLED"}=on to switch it on.`);
  // Where the account lives is part of "can we take money", not a separate note:
  // without a database the paying customer's login is deleted by the next publish.
  if (!storage.durable) blockers.push(storageNotDurableMessage(storage));
  if (!secretKeyConfigured) blockers.push("STRIPE_SECRET_KEY is missing or is not a secret/restricted key.");
  if (!webhookSecretConfigured) blockers.push("STRIPE_WEBHOOK_SECRET is missing, so no event can be verified.");
  for (const p of plans) {
    if (!p.priceConfigured) blockers.push(`${p.env} is not set (${p.label}, ${p.price} / ${p.interval}).`);
  }
  if (configuredPriceEnvs().length === 0) {
    blockers.push("No Stripe price ids are configured at all, so no plan could be sold.");
  }

  return {
    flag: "CHECKOUT_ENABLED",
    enabled,
    secretKeyConfigured,
    webhookSecretConfigured,
    plans,
    canTakeSubscriptionPayments: blockers.length === 0,
    blockers,
    storage,
  };
}
