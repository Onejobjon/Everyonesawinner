// Vercel Build Output API function entry.
// (2026-10-20: trivial bump to force a fresh Vercel deploy+promotion cycle.)
//
// The Build Output Node launcher invokes the default export as a classic Node
// `(req, res)` handler — NOT a web handler. TanStack Start emits a portable web
// fetch handler (dist/server/server.js), so we adapt: Node IncomingMessage → web
// Request, run the fetch handler, stream the web Response back onto ServerResponse.
// Node 22 has global Request/Response/Headers/ReadableStream.
//
// Bundled (with its deps + the SSR handler's dynamic ./assets chunks) into
// .vercel/output/functions/render.func/index.mjs by build-vercel.sh.
import type { IncomingMessage, ServerResponse } from "node:http";

import handler from "./dist/server/server.js";
import { ODDS_API_KEY } from "./src/server/odds-key";

// ── Odds proxy (parity with serve-static.ts) ────────────────────────────────
// The client fetches /api/odds?sport=… — a server-side proxy that attaches the
// key. Without this route on Vercel, the request falls through to the SPA and
// the client gets HTML back, so the custom domain shows NO odds (the platform
// URL was unaffected because serve-static implements the route there).
const oddsProxy = async (url: URL): Promise<Response> => {
  const sport = url.searchParams.get("sport") || "upcoming";
  const target =
    sport === "upcoming"
      ? `https://api.the-odds-api.com/v4/sports/upcoming/odds/?apiKey=${ODDS_API_KEY}&regions=uk&markets=h2h,h2h_lay&oddsFormat=decimal`
      : `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sport)}/odds/?apiKey=${ODDS_API_KEY}&regions=uk&markets=h2h,h2h_lay&oddsFormat=decimal`;
  try {
    const upstream = await fetch(target);
    const body = await upstream.text();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (upstream.ok) headers["cache-control"] = "public, max-age=300";
    return new Response(body, { status: upstream.status, headers });
  } catch {
    return Response.json({ error: "odds proxy failed" }, { status: 502 });
  }
};

const sendWebRes = async (res: ServerResponse, webRes: Response): Promise<void> => {
  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => res.setHeader(key, value));
  if (webRes.body) {
    const reader = webRes.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
};

const fetchHandler = handler as {
  fetch: (request: Request) => Response | Promise<Response>;
};

const toWebRequest = (req: IncomingMessage): Request => {
  const host = req.headers.host ?? "localhost";
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const url = `${proto}://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else if (value !== undefined) headers.set(key, value);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    ...(hasBody ? { body: req as unknown as ReadableStream, duplex: "half" } : {}),
  } as RequestInit);
};

export default async function vercelHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    // Intercept the odds proxy before the SSR handoff (SSR app has no
    // /api/odds route — see comment above). Parse with a base so this works
    // whether the launcher passes a path ("/api/odds?…") or an absolute URL
    // ("https://host/api/odds?…").
    const rawUrl = req.url ?? "/";
    const parsed = new URL(rawUrl, `https://${req.headers.host ?? "localhost"}`);
    if (parsed.pathname === "/api/odds") {
      const webRes = await oddsProxy(parsed);
      await sendWebRes(res, webRes);
      return;
    }
    const webRes = await fetchHandler.fetch(toWebRequest(req));
    await sendWebRes(res, webRes);
  } catch (error) {
    // Log the detail server-side (captured by the host's function logs); never
    // return a stack trace to the public visitor of the site.
    console.error("[team-site] SSR request failed", error);
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain");
    res.end("Internal Server Error");
  }
}
