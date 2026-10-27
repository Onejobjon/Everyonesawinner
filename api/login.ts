// Vercel serverless function: POST /api/login — account login.
//
// SELF-CONTAINED: no relative imports (see the note in api/signup.ts — a
// relative import crashed the deployed function at load time). On Vercel the
// filesystem is read-only, so this forwards to the platform deployment, which
// holds the account store, and returns its exact status and body (a wrong
// password must come back as a clean 401, never a 500).
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
    // Vercel hands us req.body ALREADY PARSED when content-type is JSON, and as a
    // string in other runtimes — accept both, or every real signup 400s.
    let body: any;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body ?? {});
    } catch {
      send(res, 400, JSON.stringify({ ok: false, error: "Invalid JSON body" }));
      return;
    }
    const payload = {
      email: typeof body?.email === "string" ? body.email : "",
      password: typeof body?.password === "string" ? body.password : "",
    };
    const upstream = await fetch(`${PLATFORM_API_URL}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    });
    send(res, upstream.status, await upstream.text());
  } catch (e) {
    console.error(`[api-login] ${String(e)}`);
    send(
      res,
      503,
      JSON.stringify({
        ok: false,
        error:
          "Sign-in is temporarily unavailable. Nothing was changed on your account — please try again in a minute.",
      }),
    );
  }
}
