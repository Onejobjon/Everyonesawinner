// Vercel serverless function: /api/comps — the owner's free-access grant list.
//
// SELF-CONTAINED (no relative imports — a relative import once crashed a
// deployed function at load time, see api/signup.ts). The account store and the
// owner seat check live on the platform deployment, so this forwards the request
// verbatim and returns its exact status and body. A non-owner gets the platform's
// bare 404 through unchanged.
const PLATFORM_API_URL =
  process.env.PLATFORM_API_URL || "https://515136800b641762e9aace79427eb7c4.ctonew.app";

function send(res: any, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

export default async function handler(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      send(res, 405, JSON.stringify({ ok: false, error: "Method not allowed" }));
      return;
    }
    const authHeader = typeof req.headers?.authorization === "string" ? req.headers.authorization : "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!bearer) {
      send(res, 404, JSON.stringify({ error: "not_found", message: "Not found." }));
      return;
    }
    const upstream = await fetch(`${PLATFORM_API_URL}/api/comps`, {
      method: req.method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json" },
      body: req.method === "POST" ? JSON.stringify(req.body ?? {}) : undefined,
      cache: "no-store",
    });
    const text = await upstream.text();
    send(res, upstream.status, text || JSON.stringify({ error: "not_found", message: "Not found." }));
  } catch (e) {
    // Fail closed: an unreachable account service grants nothing.
    send(res, 503, JSON.stringify({ ok: false, error: "Account service unavailable" }));
  }
}
