/**
 * THE ACCOUNT PAGE'S ENDPOINTS — see your own plan, stop renewing, undo it.
 *
 *   GET  /api/subscription         — the plan, the price, whether it renews, the
 *                                    date access ends, and any free-access grant
 *   POST /api/subscription/cancel  — stop renewing at the end of the paid period
 *   POST /api/subscription/resume  — undo that, before the period ends
 *
 * SECURITY, IN ONE SENTENCE: the ONLY identifier a caller supplies is their
 * session token. Every one of the three routes runs `requireAccountSession()`
 * first (the same server-side gate family as requireProSession /
 * requirePaidSession / requireOwnerSession in src/server/pro-gate.ts), takes the
 * email from the resolved session, and IGNORES the request body entirely — so
 * naming somebody else's address in the body cancels nothing of theirs. A
 * signed-out request is a 401 before any record is read or written.
 *
 * Nothing here can take money, refund money or end access early: cancelling sets
 * one field (see src/server/subscription.ts) and the date already promised is what
 * ends access.
 */
import { requireAccountSession } from "./pro-gate";
import {
  cancelSubscription,
  resumeSubscription,
  subscriptionView,
  type SubscriptionActionDeps,
} from "./subscription";
import { findByEmail } from "./users";

const NO_STORE = { "cache-control": "no-store" };

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/**
 * `deps` exists for tests only (a stubbed Stripe fetch and a fixed clock). The
 * server calls this with no second argument, so production always uses the real
 * `fetch` and the real environment.
 */
export async function handleSubscriptionApi(
  req: Request,
  url: URL,
  deps: SubscriptionActionDeps = {},
): Promise<Response> {
  // THE GATE, before anything else. 401/503 and nothing touched.
  const gate = await requireAccountSession(req);
  if (!gate.ok) {
    return json(gate.status, { ok: false, error: gate.error, message: gate.message });
  }
  // From here on `email` is the session's account. The body is never read.

  if (url.pathname === "/api/subscription") {
    if (req.method !== "GET") {
      return json(405, { ok: false, error: "method_not_allowed", message: "Method not allowed" });
    }
    try {
      const account = await findByEmail(gate.email);
      if (!account) {
        return json(401, {
          ok: false,
          error: "account_not_found",
          message: "We could not find the account behind that session. Sign in again.",
        });
      }
      return json(200, { ok: true, subscription: subscriptionView(account, deps) });
    } catch (e) {
      console.error(`[subscription] read failed for ${gate.email}: ${String(e)}`);
      return json(503, {
        ok: false,
        error: "account_unavailable",
        message: "We could not read your account just now, so nothing was shown or changed.",
      });
    }
  }

  if (url.pathname === "/api/subscription/cancel" || url.pathname === "/api/subscription/resume") {
    if (req.method !== "POST") {
      return json(405, { ok: false, error: "method_not_allowed", message: "Method not allowed" });
    }
    const action = url.pathname.endsWith("/cancel") ? cancelSubscription : resumeSubscription;
    try {
      const result = await action(gate.email, deps);
      return json(result.status, {
        ok: result.ok,
        ...(result.code ? { error: result.code } : {}),
        ...(result.message ? { message: result.message } : {}),
        ...(result.subscription ? { subscription: result.subscription } : {}),
      });
    } catch (e) {
      // A thrown write must never look like a success: say the change did not
      // happen, because we cannot prove that it did.
      console.error(`[subscription] ${url.pathname} failed for ${gate.email}: ${String(e)}`);
      return json(500, {
        ok: false,
        error: "action_failed",
        message:
          "We could not save that change, so your subscription is unchanged. " +
          "Nothing has been cancelled. Please try again, or email support@everyonesawinner.uk.",
      });
    }
  }

  return json(404, { ok: false, error: "not_found", message: "Not found." });
}
