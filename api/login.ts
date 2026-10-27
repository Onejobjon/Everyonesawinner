// Vercel serverless function: POST /api/login — account login.
// Mirrors the Bun server's `/api/login` route and reuses `authenticateUser`.
// Local store is imported lazily: a static import of ../src/** broke the
// deployed function at load time (opaque 500 before any handler code ran).
import { needsPlatformForward, forwardToPlatform, send, withErrorJson } from "./_forward";

function respond(res: any, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

async function handlerInner(req: any, res: any): Promise<void> {
  if (req.method !== "POST") {
    respond(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(req.body || "{}");
  } catch {
    respond(res, 400, { ok: false, error: "Invalid JSON body" });
    return;
  }
  const { email, password } = (body ?? {}) as {
    email?: unknown;
    password?: unknown;
  };
  try {
    if (needsPlatformForward()) {
      const out = await forwardToPlatform("/api/login", "POST", JSON.stringify({ email, password }));
      send(res, out.status, out.body, out.contentType);
      return;
    }
    const { authenticateUser } = await import("../src/server/users");
    const user = authenticateUser(
      typeof email === "string" ? email : "",
      typeof password === "string" ? password : "",
    );
    respond(res, 200, { ok: true, user });
  } catch (e) {
    respond(res, 401, {
      ok: false,
      error: e instanceof Error ? e.message : "Invalid credentials",
    });
  }
}

export default withErrorJson(handlerInner);
