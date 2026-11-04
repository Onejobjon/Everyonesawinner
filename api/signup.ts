// Vercel serverless function: POST /api/signup — account registration.
//
// SELF-CONTAINED ON PURPOSE (2026-10-27): this file imports NOTHING. A relative
// import here (`./_forward`, or `../src/server/users`) made the deployed
// function fail at load time with FUNCTION_INVOCATION_FAILED — before any
// handler code ran, so a try/catch inside the handler could not even report it.
// Keep every api/*.ts free of relative imports; duplicate the two small helpers
// instead. The rule was proven with a build marker on /api/ping.
//
// Why it forwards: on Vercel the function filesystem is read-only/ephemeral, so
// a JSON-file write throws. Until DATABASE_URL is connected, the platform
// deployment (which has a writable disk) is the single store; this function is a
// thin, honest proxy to it.
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
      name: typeof body?.name === "string" ? body.name : "",
      email: typeof body?.email === "string" ? body.email : "",
      password: typeof body?.password === "string" ? body.password : "",
    };
    const upstream = await fetch(`${PLATFORM_API_URL}/api/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    });
    send(res, upstream.status, await upstream.text());
  } catch (e) {
    // Never let a crash become Vercel's opaque 500 page: say what happened.
    console.error(`[api-signup] ${String(e)}`);
    send(
      res,
      503,
      JSON.stringify({
        ok: false,
        error:
          "Account service is temporarily unavailable. Nothing was saved and no charge was made — please try again in a minute.",
      }),
    );
  }
}
