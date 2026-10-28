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
 * "Pro" means plan `pro` or `annual` (Pro monthly / Pro Annual), matching
 * `isProPlan()` in src/lib/auth.tsx. The owner seat is stored with plan `pro`
 * (src/server/users.ts), so it passes without a special case here.
 *
 * The Vercel deployment cannot import from `src/` (a relative import once took
 * a function down at load), so `api/odds-leagues.ts` carries its own copy of the
 * same rule: forward the bearer token to this server's `/api/me` and require
 * `ok` plus a Pro plan. Change one, change the other.
 */
import { resolveSession } from "./sessions";
import { findByEmail } from "./users";

export type ProGate =
  | { ok: true; email: string }
  | {
      ok: false;
      /** 401 = not signed in / expired, 403 = signed in but not Pro, 503 = cannot verify. */
      status: 401 | 403 | 503;
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
      message: `Sign in to run ${what}. Nothing was fetched and nothing was charged.`,
    };
  }

  let email: string;
  let plan: unknown;
  try {
    const session = await resolveSession(token);
    if (!session) {
      return {
        ok: false,
        status: 401,
        error: "session_expired",
        message: `Your session has expired — sign in again to run ${what}. Nothing was fetched and nothing was charged.`,
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
  } catch (e) {
    // Fail CLOSED: if we cannot verify the caller, nobody gets the paid data.
    console.error(`[pro-gate] account store unavailable: ${String(e)}`);
    return {
      ok: false,
      status: 503,
      error: "account_unavailable",
      message:
        "We could not check your account, so the search did not run. Nothing was fetched and nothing was charged.",
    };
  }

  if (!isProPlanValue(plan)) {
    return {
      ok: false,
      status: 403,
      error: "pro_required",
      message: `${what[0].toUpperCase()}${what.slice(1)} is a Pro tool. Upgrade to Pro to run it. Nothing was fetched and nothing was charged.`,
    };
  }

  return { ok: true, email };
}
