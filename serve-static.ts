// Minimal static server for the platform publisher ("npm start").
// The site is a client-side SPA (vite build → dist/), so every unknown
// path falls back to dist/index.html — the same behaviour as the
// rewrites in vercel.json. Binds 0.0.0.0:3000, pinned like the old
// serve.ts, because the platform gateway reverse-proxies that port.
import { join, extname } from "node:path";

const PORT = 3000;
const HOST = "0.0.0.0";
const DIST = join(import.meta.dir, "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

// Free port 3000 if a previous server (any user) still holds it.
const freePort =
  `for _ in $(seq 1 25); do ` +
  `pids=$(lsof -t -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null || true); ` +
  `if [ -z "$pids" ]; then exit 0; fi; ` +
  `kill $pids 2>/dev/null || true; sleep 0.2; ` +
  `done`;
Bun.spawnSync(["bash", "-c", freePort]);

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith("/")) path += "index.html";

    const file = Bun.file(join(DIST, path));
    if (path !== "/" && (await file.exists())) {
      return new Response(file, {
        headers: { "content-type": MIME[extname(path)] ?? "application/octet-stream", "cache-control": "public, max-age=3600" },
      });
    }

    // SPA fallback
    const index = Bun.file(join(DIST, "index.html"));
    return new Response(index, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  },
});

console.log(`Serving dist/ on http://${HOST}:${PORT}`);
