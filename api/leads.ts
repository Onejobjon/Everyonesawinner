// Vercel serverless function: POST /api/leads — lead capture.
//
// ⚠️ RULE (locked in after the 2026-10-20 domain incident): on the custom domain
// (Vercel), the ONLY way a server route exists is an `api/*.ts` function like
// this one. Keep every new domain route in `api/`.
//
// Storage note: this mirrors the Bun server's `/api/leads` route and reuses the
// same `storeLead` module. On Vercel the function filesystem is ephemeral, so a
// file write is NOT durable across cold starts — production-grade Vercel lead
// capture needs a Postgres `leads` table (src/db.ts) once DATABASE_URL is
// connected. The platform URL (Bun server, serve-static.ts) uses the same module
// and IS durable (its `.run/leads.json` lives on the shared site disk).
import { storeLead } from "../src/server/leads";

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

  const { name, email, source } = (body ?? {}) as {
    name?: unknown;
    email?: unknown;
    source?: unknown;
  };

  try {
    const record = storeLead({
      name: typeof name === "string" ? name : "",
      email: typeof email === "string" ? email : "",
      source: typeof source === "string" ? source : "free-bets-page",
    });
    respond(res, 200, { ok: true, record });
  } catch (e) {
    respond(res, 400, { ok: false, error: e instanceof Error ? e.message : "Invalid lead" });
  }
}
