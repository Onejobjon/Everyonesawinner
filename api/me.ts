// Vercel serverless function: GET /api/me — resolve a session token server-side.
//
// SELF-CONTAINED (no relative imports — a relative import crashed the deployed
// function at load time, see api/signup.ts). The account/session store lives on
// the platform deployment, so this forwards the token and returns its exact
// status and body. 401 = unknown/expired, 503 = store unreachable; the client
// treats both as "no access".
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
    if (req.method !== "GET") {
      send(res, 405, JSON.stringify({ ok: false, error: "Method not allowed" }));
      return;
    }
    const authHeader = typeof req.headers?.authorization === "string" ? req.headers.authorization : "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    const token = bearer || (typeof req.query?.token === "string" ? req.query.token : "");
    if (!token) {
      send(res, 401, JSON.stringify({ ok: false, error: "Not signed in" }));
      return;
    }
    const upstream = await fetch(`${PLATFORM_API_URL}/api/me`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
    });
    const text = await upstream.text();
    send(res, upstream.status, text || JSON.stringify({ ok: false, error: "No response" }));
  } catch (e) {
    // Fail closed: an unreachable account service must not grant access.
    send(res, 503, JSON.stringify({ ok: false, error: "Account service unavailable" }));
  }
}
