// Vercel serverless function: GET /go/<slug> — the outbound operator redirect.
//
// SELF-CONTAINED (no relative imports — a relative import crashed a deployed
// function at load time, see api/signup.ts). The brand register, the click log
// and the redirect all live on the platform deployment, so this forwards the
// request and passes the platform's answer straight back: 302 + Location. The
// click is logged there, once, by the server that owns the store.
//
// vercel.json rewrites /go/<slug> to this function (before the SPA catch-all),
// because a Vercel function file only answers /api/go on its own.
const PLATFORM_API_URL =
  process.env.PLATFORM_API_URL || "https://515136800b641762e9aace79427eb7c4.ctonew.app";

function send(res: any, status: number, body: string, extra?: Record<string, string>): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  for (const [k, v] of Object.entries(extra || {})) res.setHeader(k, v);
  res.end(body);
}

export default async function handler(req: any, res: any): Promise<void> {
  try {
    // The slug comes from the rewrite (?slug=) or from the path itself, so this
    // works whether Vercel passes the catch-all through a query or not.
    const fromQuery = typeof req.query?.slug === "string" ? req.query.slug : "";
    const fromPath = String(req.url || "").split("?")[0].replace(/^\/api\/go\/?/, "").replace(/^\/go\/?/, "");
    const slug = (fromQuery || fromPath || "").replace(/\/+$/, "").trim();
    if (!slug) {
      send(res, 302, "", { location: "/free-bets" });
      return;
    }
    const upstream = await fetch(`${PLATFORM_API_URL}/go/${encodeURIComponent(slug)}`, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
    });
    const location = upstream.headers.get("location");
    if (location) {
      send(res, 302, "", { location });
      return;
    }
    // No redirect came back (the platform host is unreachable or refused) —
    // send the visitor to the offers list rather than to a dead end.
    send(res, 302, "", { location: "/free-bets" });
  } catch (e) {
    send(res, 302, "", { location: "/free-bets" });
  }
}
