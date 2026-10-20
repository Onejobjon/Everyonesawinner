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
const DEV_KEY = "7c3d32f19360a9489dd8b5d6a6712d4f";

export default async function handler(req: any, res: any): Promise<void> {
  const host = (req.headers && req.headers.host) || "localhost";
  const url = new URL(req.url ?? "/api/odds", `https://${host}`);
  const sport = url.searchParams.get("sport") || "upcoming";
  const key = process.env.ODDS_API_KEY || DEV_KEY;
  const target =
    sport === "upcoming"
      ? `https://api.the-odds-api.com/v4/sports/upcoming/odds/?apiKey=${key}&regions=uk&markets=h2h,h2h_lay&oddsFormat=decimal`
      : `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sport)}/odds/?apiKey=${key}&regions=uk&markets=h2h,h2h_lay&oddsFormat=decimal`;
  try {
    const upstream = await fetch(target);
    const body = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader("content-type", "application/json");
    if (upstream.ok) res.setHeader("cache-control", "public, max-age=300");
    res.end(body);
  } catch {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: "odds proxy failed" }));
  }
}
