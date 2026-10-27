// Vercel serverless function: /api/odds proxy.
//
// ⚠️ RULE for anyone adding a server route: on the custom domain (Vercel), the
// ONLY way a server route exists is an `api/*.ts` function like this one. Vercel
// builds the repo with its own auto-detected static builder (vercel.json
// `framework: "vite"` + `outputDirectory: "dist"` + rewrite-all→index.html) —
// it NEVER runs build-vercel.sh or vercel-entry.ts, so render-entry intercepts
// are dead code there. Keep every new domain route in `api/`.
//
// Server-side only — the key never reaches the client bundle.
// SECURITY (2026-10-27): this file used to carry a committed fallback key. The
// repo is PUBLIC, so that value is compromised and was deleted. There is NO key
// in the source tree by design — the function reads ODDS_API_KEY from the
// environment and returns an explicit 503 when it is missing. Never put a
// literal back: scripts/scan-secrets.sh fails the build on a 32-hex string.

// Server-side cache (in-memory per warm instance). TTL 10 min — repeated
// /api/odds hits within that window serve the cached upstream body instead of
// re-fetching the-odds-api.com (protects the monthly credit allowance).
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { body: string; status: number; ok: boolean; ts: number }>();

function respond(res: any, body: string, status: number, ok: boolean): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  if (ok) res.setHeader("cache-control", "public, max-age=300");
  res.end(body);
}

export default async function handler(req: any, res: any): Promise<void> {
  const host = (req.headers && req.headers.host) || "localhost";
  const url = new URL(req.url ?? "/api/odds", `https://${host}`);
  const sport = url.searchParams.get("sport") || "upcoming";
  const key = (process.env.ODDS_API_KEY || "").trim();
  if (!key) {
    // Loud and honest: never a silent empty list.
    console.error("[odds-key] /api/odds refused — ODDS_API_KEY is not set in this environment");
    respond(
      res,
      JSON.stringify({
        error: "odds_unavailable",
        message:
          "Live odds are temporarily unavailable because the odds feed key is not configured on the server.",
      }),
      503,
      false,
    );
    return;
  }
  const target =
    sport === "upcoming"
      ? `https://api.the-odds-api.com/v4/sports/upcoming/odds/?apiKey=${key}&regions=uk&markets=h2h&oddsFormat=decimal`
      : `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sport)}/odds/?apiKey=${key}&regions=uk&markets=h2h&oddsFormat=decimal`;

  const hit = cache.get(target);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    respond(res, hit.body, hit.status, hit.ok);
    return;
  }

  try {
    const upstream = await fetch(target);
    const body = await upstream.text();
    // Only cache successful upstream responses — never pin a transient error.
    if (upstream.ok) {
      cache.set(target, { body, status: upstream.status, ok: true, ts: Date.now() });
    }
    respond(res, body, upstream.status, upstream.ok);
  } catch {
    res.statusCode = 502;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "odds proxy failed" }));
  }
}
