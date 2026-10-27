// Vercel serverless function: POST /api/leads — lead capture (funnel email list).
//
// SELF-CONTAINED: no relative imports (see api/signup.ts). On Vercel the
// filesystem is read-only, so this forwards to the platform deployment, which
// owns the durable lead store — the funnel's email capture was silently broken
// by the same file-write crash.
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
    if (req.method !== "POST") {
      send(res, 405, JSON.stringify({ ok: false, error: "Method not allowed" }));
      return;
    }
    let body: any;
    try {
      body = JSON.parse(req.body || "{}");
    } catch {
      send(res, 400, JSON.stringify({ ok: false, error: "Invalid JSON body" }));
      return;
    }
    const payload = {
      name: typeof body?.name === "string" ? body.name : "",
      email: typeof body?.email === "string" ? body.email : "",
      source: typeof body?.source === "string" ? body.source : "free-bets-page",
    };
    const upstream = await fetch(`${PLATFORM_API_URL}/api/leads`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    });
    send(res, upstream.status, await upstream.text());
  } catch (e) {
    console.error(`[api-leads] ${String(e)}`);
    send(
      res,
      503,
      JSON.stringify({
        ok: false,
        error: "Could not save your email just now — please try again in a minute.",
      }),
    );
  }
}
