// Vercel serverless function: POST /api/signup — account registration.
//
// Mirrors the Bun server's `/api/signup` route and reuses `registerUser`.
// Storage caveat is the same as api/leads.ts: on Vercel the function filesystem
// is ephemeral, so a JSON-file write is NOT durable across cold starts — the
// platform URL (Bun server) is durable via `.run/users.json`. Production-grade
// Vercel auth needs a Postgres `users` table (src/db.ts) once DATABASE_URL is
// connected.
import { registerUser } from "../src/server/users";

function respond(res: any, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

export default async function handler(req: any, res: any): Promise<void> {
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
  const { name, email, password } = (body ?? {}) as {
    name?: unknown;
    email?: unknown;
    password?: unknown;
  };
  try {
    const user = registerUser(
      typeof name === "string" ? name : "",
      typeof email === "string" ? email : "",
      typeof password === "string" ? password : "",
    );
    respond(res, 200, { ok: true, user });
  } catch (e) {
    respond(res, 400, {
      ok: false,
      error: e instanceof Error ? e.message : "Could not create account",
    });
  }
}
