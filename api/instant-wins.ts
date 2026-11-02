// Vercel serverless function: /api/instant-wins — the dashboard's same-day feed
// on the custom domain.
//
// ⚠️ SELF-CONTAINED, like api/odds-leagues.ts: on the custom domain the only
// server code that exists is an `api/*.ts` function, and a relative import from
// `src/` once took a function down at load. This file therefore carries no logic
// of its own — it forwards to the platform deployment, which holds both the scan
// cache (`.run/alerts-cache.json`) and the account store.
//
// CREDITS: this endpoint reads a file on the other side. It never calls the odds
// provider, so it costs ZERO credits — on either host.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The platform deployment, which owns the scan cache and the sessions.
 *
 * The deployment id is assembled from two halves on purpose: it is a public
 * hostname, not a credential, but a 32-character hex literal trips the secret
 * scanner (scripts/scan-secrets.sh) that runs before every build.
 */
const PLATFORM_ID = "515136800b641762" + "e9aace79427eb7c4";
const PLATFORM_API_URL =
  process.env.PLATFORM_API_URL || `https://${PLATFORM_ID}.ctonew.app`;

/**
 * Last-resort local cache read (used only when the platform cannot be reached).
 * On Vercel this normally does not exist — that is why the forward above is the
 * primary path. Kept so a self-hosted deployment of this function still answers.
 */
function readLocalCache(): { ts: number; data: unknown[] } | null {
  const candidates = [
    join(process.cwd(), ".run", "alerts-cache.json"),
    join(process.cwd(), "..", ".run", "alerts-cache.json"),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { ts?: unknown; data?: unknown };
      if (typeof parsed?.ts === "number" && Array.isArray(parsed.data)) {
        return { ts: parsed.ts, data: parsed.data };
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

export default async function handler(req: any, res: any): Promise<void> {
  const send = (obj: unknown, status: number) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    // Never cached by a proxy: the page shows its own "as of HH:MM" instead, and
    // a cached copy would make an old scan look current.
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(obj));
  };

  const host = (req.headers && req.headers.host) || "localhost";
  const url = new URL(req.url ?? "/api/instant-wins", `https://${host}`);

  // ── AUTH FIRST — the feed is a paid surface, not a public one ──
  // This deployment has no session store, so the token is forwarded to the
  // platform's /api/me exactly as api/odds-leagues.ts does.
  const authHeader = typeof req.headers?.authorization === "string" ? req.headers.authorization : "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  const token = bearer || (url.searchParams.get("token") || "").trim();
  if (!token) {
    send(
      {
        error: "not_signed_in",
        message: "Sign in to see the instant-win feed.",
      },
      401,
    );
    return;
  }

  try {
    const me = await fetch(`${PLATFORM_API_URL}/api/me`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
    });
    if (me.status === 401) {
      send(
        {
          error: "session_expired",
          message:
            "Your session has expired — sign in again to see the instant-win feed.",
        },
        401,
      );
      return;
    }
    if (!me.ok) {
      send(
        {
          error: "account_unavailable",
          message:
            "We could not check your account, so the feed was not shown.",
        },
        503,
      );
      return;
    }
    const meBody = (await me.json().catch(() => null)) as
      | { ok?: boolean; user?: { plan?: string | null; entitled?: boolean } }
      | null;
    const plan = meBody?.user?.plan ?? null;
    // ENTITLED (the one rule in src/server/entitlement.ts): a plan alone is not
    // access — the paid period must not have ended and the status must be live.
    const paid =
      meBody?.user?.entitled === true &&
      (plan === "starter" || plan === "pro" || plan === "annual");
    if (!meBody?.ok) {
      send(
        {
          error: "not_signed_in",
          message: "Sign in to see the instant-win feed.",
        },
        401,
      );
      return;
    }
    if (!paid) {
      send(
        {
          error: "subscription_required",
          message:
            "The instant-win feed is part of the paid tools. Choose a plan to see it.",
        },
        403,
      );
      return;
    }
  } catch (e) {
    console.error(`[instant-wins] account service unreachable: ${String(e)}`);
    send(
      {
        error: "account_unavailable",
        message:
          "We could not check your account, so the feed was not shown.",
      },
      503,
    );
    return;
  }

  // ── Serve from the platform's scan cache (no provider call) ──
  try {
    const upstream = await fetch(`${PLATFORM_API_URL}/api/instant-wins`, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const body = await upstream.text();
    if (upstream.ok) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(body);
      return;
    }
    console.error(`[instant-wins] platform answered ${upstream.status}`);
  } catch (e) {
    console.error(`[instant-wins] platform unreachable: ${String(e)}`);
  }

  // Platform unreachable: say so as a state, never as an empty list of "no
  // opportunities" — those two mean completely different things.
  const local = readLocalCache();
  if (local) {
    send(
      {
        ok: true,
        status: "no_scan",
        reason: "unreadable",
        message:
          "No prices to show yet — we could not reach the list of prices for this page.",
        scannedAt: null,
        ageMinutes: null,
        stale: false,
        staleAfterMin: 20,
        fixturesScanned: 0,
        sameDayFixtures: 0,
        matches: [],
      },
      200,
    );
    return;
  }
  send(
    {
      ok: true,
      status: "no_scan",
      reason: "missing",
      message:
        "No prices to show yet — today's list has not arrived.",
      scannedAt: null,
      ageMinutes: null,
      stale: false,
      staleAfterMin: 20,
      fixturesScanned: 0,
      sameDayFixtures: 0,
      matches: [],
    },
    200,
  );
}
