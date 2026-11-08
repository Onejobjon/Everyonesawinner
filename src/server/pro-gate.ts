/**
 * The Pro gate for DATA endpoints — the ones that cost real money to answer.
 *
 * WHY THIS EXISTS (2026-10-28, found by an outside curl): `/api/odds-leagues`
 * answered anyone. The page was behind the Paywall, but the endpoint behind it
 * was not, so `curl .../api/odds-leagues?leagues=soccer_epl` returned 21
 * fixtures with no cookie and no token — and every such call spends a real Odds
 * API credit. The gate was UI-only, which is not a gate.
 *
 * RULES, in this order:
 *  1. No token                → 401. Nothing is read, nothing is fetched.
 *  2. Unresolvable session    → 401. (A token that is not in the server-side
 *                               session store is not a session.)
 *  3. Signed in, not Pro      → 403.
 *  4. Account store unreachable → 503, i.e. FAIL CLOSED. We never guess.
 * Only after 1–4 do we reach the catalogue read or any provider request, so a
 * rejected caller costs ZERO credits.
 *
 * "Pro" means ENTITLED (src/server/entitlement.ts — known plan, active status,
 * paid period not ended, or inside the failed-payment grace window) AND plan
 * `pro` or `annual`. Being on a plan is no longer enough on its own: a plan with
 * no paid period, or a period that has ended, is not access. The owner seat is
 * entitled by identity (src/server/users.ts), so it passes without a special
 * case here.
 *
 * The Vercel deployment cannot import from `src/` (a relative import once took
 * a function down at load), so `api/odds-leagues.ts` carries its own copy of the
 * same rule: forward the bearer token to this server's `/api/me` and require
 * `ok` plus a Pro plan. Change one, change the other.
 */
import { resolveSession } from "./sessions";
import { findByEmail, ownerEmails } from "./users";

export type ProGate =
  | { ok: true; email: string }
  | {
      ok: false;
      /**
       * 401 = not signed in / expired, 403 = signed in but not Pro, 503 = cannot
       * verify, 404 = not for you (used by owner-only surfaces, which must not
       * even confirm they exist).
       */
      status: 401 | 403 | 404 | 503;
      error: string;
      /** Plain language for the page; never an error code on its own. */
      message: string;
    };

/** Plans that unlock the Pro tools (mirrors isProPlan() in src/lib/auth.tsx). */
export function isProPlanValue(plan: unknown): boolean {
  return plan === "pro" || plan === "annual";
}

/** The bearer token on a request (header first, `?token=` as the fallback). */
export function bearerToken(req: Request): string {
  const header = req.headers.get("authorization") || "";
  const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  let fromQuery = "";
  try {
    fromQuery = new URL(req.url).searchParams.get("token") || "";
  } catch {
    /* malformed URL — the header is the only source then */
  }
  return (bearer || fromQuery).trim();
}

/**
 * Verify that this request comes from a signed-in account — ANY account.
 *
 * WHY THIS EXISTS (2026-11-08). `/api/subscription` and its cancel/resume actions
 * are the customer's own billing record. They must not be behind the paid gate:
 * somebody whose plan has ended, whose card failed, or who never subscribed at all
 * has the strongest claim to see their account and to stop a renewal. They must,
 * however, be behind the SAME kind of server-side check as every other data
 * endpoint — a real session in the server-side session store, resolved here, with
 * the email taken from that session and never from the request body.
 *
 * That is the whole security property of cancellation: the only identifier the
 * caller supplies is their token, so one customer cannot act on another's
 * subscription even if they name them in the body (the body is ignored).
 *
 * Fails CLOSED: no token or an unverifiable session is a 401, and an unreachable
 * account store is a 503. Nothing is read, written or cancelled on a guess.
 */
export async function requireAccountSession(
  req: Request,
  what = "your account",
): Promise<ProGate> {
  const token = bearerToken(req);
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: "not_signed_in",
      message: `Sign in to see ${what}.`,
    };
  }
  try {
    const session = await resolveSession(token);
    if (!session) {
      return {
        ok: false,
        status: 401,
        error: "session_expired",
        message: `Your session has expired — sign in again to see ${what}.`,
      };
    }
    const user = await findByEmail(session.email);
    if (!user) {
      return {
        ok: false,
        status: 401,
        error: "account_not_found",
        message: `We could not find the account behind that session. Sign in again to see ${what}. Nothing was changed.`,
      };
    }
    return { ok: true, email: user.email };
  } catch (e) {
    console.error(`[account-gate] account store unavailable: ${String(e)}`);
    return {
      ok: false,
      status: 503,
      error: "account_unavailable",
      message: "We could not check your account, so nothing was shown or changed.",
    };
  }
}

/**
 * Verify that this request comes from a signed-in Pro account.
 *
 * `what` is used in the message ("this search") so the page can say exactly
 * which tool did not run.
 */
export async function requireProSession(
  req: Request,
  what = "this search",
): Promise<ProGate> {
  const token = bearerToken(req);
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: "not_signed_in",
      message: `Sign in to run ${what}.`,
    };
  }

  let email: string;
  let plan: unknown;
  let entitled = false;
  try {
    const session = await resolveSession(token);
    if (!session) {
      return {
        ok: false,
        status: 401,
        error: "session_expired",
        message: `Your session has expired — sign in again to run ${what}.`,
      };
    }
    const user = await findByEmail(session.email);
    if (!user) {
      return {
        ok: false,
        status: 401,
        error: "account_not_found",
        message: `We could not find the account behind that session. Sign in again to run ${what}. Nothing was fetched.`,
      };
    }
    email = user.email;
    plan = user.plan;
    // The ONE rule (src/server/entitlement.ts), computed from the account record.
    entitled = user.entitled;
  } catch (e) {
    // Fail CLOSED: if we cannot verify the caller, nobody gets the paid data.
    console.error(`[pro-gate] account store unavailable: ${String(e)}`);
    return {
      ok: false,
      status: 503,
      error: "account_unavailable",
      message:
        "We could not check your account, so the search did not run.",
    };
  }

  if (!entitled || !isProPlanValue(plan)) {
    return {
      ok: false,
      status: 403,
      error: "pro_required",
      message: `${what[0].toUpperCase()}${what.slice(1)} is a Pro tool. Upgrade to Pro to run it.`,
    };
  }

  return { ok: true, email };
}

/** Plans that unlock the any-tier (paid, not Pro-only) tools. */
export function isPaidPlanValue(plan: unknown): boolean {
  return plan === "starter" || plan === "pro" || plan === "annual";
}

/**
 * Verify that this request comes from ANY paid account (Starter or above).
 *
 * Used by the Instant Wins feed: it is not a Pro tool — the pre-loaded list never
 * was — but it is still a paid surface, so the endpoint checks the session itself
 * instead of trusting the Paywall, which is UI and not a lock.
 *
 * Costs nothing to refuse: this gate runs before the cache file is read, and the
 * feed never spends a credit either way.
 */
export async function requirePaidSession(
  req: Request,
  what = "this page",
): Promise<ProGate> {
  const token = bearerToken(req);
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: "not_signed_in",
      message: `Sign in to see ${what}.`,
    };
  }
  let email: string;
  let plan: unknown;
  let entitled = false;
  try {
    const session = await resolveSession(token);
    if (!session) {
      return {
        ok: false,
        status: 401,
        error: "session_expired",
        message: `Your session has expired — sign in again to see ${what}.`,
      };
    }
    const user = await findByEmail(session.email);
    if (!user) {
      return {
        ok: false,
        status: 401,
        error: "account_not_found",
        message: `We could not find the account behind that session. Sign in again to see ${what}. Nothing was fetched.`,
      };
    }
    email = user.email;
    plan = user.plan;
    // Same single rule as requireProSession — see src/server/entitlement.ts.
    entitled = user.entitled;
  } catch (e) {
    // Fail CLOSED: an unverifiable caller gets nothing.
    console.error(`[paid-gate] account store unavailable: ${String(e)}`);
    return {
      ok: false,
      status: 503,
      error: "account_unavailable",
      message:
        "We could not check your account, so nothing was shown.",
    };
  }

  if (!entitled || !isPaidPlanValue(plan)) {
    return {
      ok: false,
      status: 403,
      error: "subscription_required",
      message: `${what[0].toUpperCase()}${what.slice(1)} is part of the paid tools. Choose a plan to see it.`,
    };
  }

  return { ok: true, email };
}

/**
 * Verify that this request comes from the OWNER — not merely a paid or Pro
 * account.
 *
 * WHY (owner instruction, 2026-11-02): `/api/alert-status` answered anyone with
 * when the scanner last ran, whether Telegram is configured and on what schedule.
 * That is the owner's operations information, not a customer feature, and it was
 * on the public internet. Being a subscriber must not be enough to read it.
 *
 * "Owner" means the identity the owner logs in with: an address in
 * `ownerEmails()` (src/server/users.ts) resolved from a real server-side session,
 * with `OWNER_PASSWORD` set. If the secret is unset the seat fails CLOSED — the
 * same rule authenticateUserJson() uses, so an unconfigured environment cannot
 * hand out operations data.
 *
 * A refusal is a 404 whose body says nothing: a stranger should not learn that
 * the endpoint exists, let alone what it reports.
 */
export async function requireOwnerSession(req: Request): Promise<ProGate> {
  const notFound: ProGate = {
    ok: false,
    status: 404,
    error: "not_found",
    message: "Not found.",
  };
  const token = bearerToken(req);
  if (!token) return notFound;
  if (!process.env.OWNER_PASSWORD?.trim()) return notFound;

  let email: string;
  try {
    const session = await resolveSession(token);
    if (!session) return notFound;
    const user = await findByEmail(session.email);
    if (!user) return notFound;
    email = user.email;
  } catch (e) {
    // Cannot verify => say nothing. An owner-only surface never falls open.
    console.error(`[owner-gate] account store unavailable: ${String(e)}`);
    return notFound;
  }
  if (!ownerEmails().includes(email.trim().toLowerCase())) return notFound;
  return { ok: true, email };
}
