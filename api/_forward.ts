/**
 * Shared helper for the Vercel `api/*` functions.
 *
 * WHY THIS EXISTS (2026-10-27): on Vercel the function filesystem is read-only /
 * ephemeral, so any `writeFileSync` on the request path throws and the whole
 * invocation dies with FUNCTION_INVOCATION_FAILED — which is exactly what made
 * signup and login return 500 on www.everyonesawinner.uk while the identical
 * code worked on the platform URL. Until a database is connected
 * (`DATABASE_URL`), these functions must not write files on Vercel: they forward
 * the request to the platform deployment, which runs the same handlers on a
 * writable disk. No secret is involved and there is no data duplication —
 * there is one store, on the platform.
 *
 * Order of preference inside each function:
 *   1. DATABASE_URL present  → Postgres path (durable, the end state)
 *   2. running on Vercel     → forward to PLATFORM_API_URL (this module)
 *   3. anywhere else          → local JSON store (Bun server, dev machine)
 */
export const PLATFORM_API_URL =
  process.env.PLATFORM_API_URL || "https://515136800b641762e9aace79427eb7c4.ctonew.app";

/** True when this deployment cannot write to disk and has no database. */
export function needsPlatformForward(): boolean {
  return !process.env.DATABASE_URL && Boolean(process.env.VERCEL);
}

export interface ProxiedResponse {
  status: number;
  body: string;
  contentType: string;
}

/**
 * Forward a JSON API call to the platform deployment. Never throws: a network
 * failure comes back as a 503 so the caller can answer honestly instead of
 * crashing the function.
 */
export async function forwardToPlatform(
  path: string,
  method: string,
  body: string,
): Promise<ProxiedResponse> {
  const url = `${PLATFORM_API_URL}${path}`;
  try {
    const upstream = await fetch(url, {
      method,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: method === "GET" || method === "HEAD" ? undefined : body,
    });
    const text = await upstream.text();
    return {
      status: upstream.status,
      body: text,
      contentType: upstream.headers.get("content-type") || "application/json",
    };
  } catch (e) {
    console.error(`[api-forward] ${method} ${path} failed: ${String(e)}`);
    return {
      status: 503,
      body: JSON.stringify({
        ok: false,
        error:
          "Account service is temporarily unavailable. Please try again in a minute — nothing was saved and no charge was made.",
      }),
      contentType: "application/json",
    };
  }
}

/** Send a forwarded (or locally produced) JSON result. */
export function send(res: any, status: number, body: string, contentType = "application/json"): void {
  res.statusCode = status;
  res.setHeader("content-type", contentType);
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

/**
 * Wrap a handler so an unexpected exception answers with a JSON error instead of
 * Vercel's opaque `FUNCTION_INVOCATION_FAILED` page. Without this, a crash on the
 * domain is undiagnosable from outside — which is exactly how the signup outage
 * stayed invisible for days.
 */
export function withErrorJson(
  fn: (req: any, res: any) => Promise<void>,
): (req: any, res: any) => Promise<void> {
  return async (req: any, res: any) => {
    try {
      await fn(req, res);
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.error(`[api-error] ${req?.method} ${req?.url}: ${msg}`);
      if (!res.headersSent && !res.writableEnded) {
        send(res, 500, JSON.stringify({ ok: false, error: "Server error", detail: msg }));
      }
    }
  };
}
