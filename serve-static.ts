// Minimal static server for the platform publisher ("npm start").
// The site is a client-side SPA (vite build → dist/), so every unknown
// path falls back to dist/index.html — the same behaviour as the
// rewrites in vercel.json. Binds 0.0.0.0:3000, pinned like the old
// serve.ts, because the platform gateway reverse-proxies that port.
import { join, extname } from "node:path";
import { startAlertWorker, runAlertCheck, alertStatus } from "./src/server/alerts";

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

// Sync committed code to GitHub before serving, when GITHUB_TOKEN is
// available in this environment (owner secrets reach the site runtime).
// Idempotent — skips when remote already matches HEAD. Never blocks on
// failure: the sync script always exits 0 and logs to .run/git-sync.log.
const sync = Bun.spawnSync(["bun", join(import.meta.dir, "scripts/sync-git.mjs")], {
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
});
if (sync.stdout.length) console.log(new TextDecoder().decode(sync.stdout).trim());
if (sync.stderr.length) console.log(new TextDecoder().decode(sync.stderr).trim());

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    // Diagnostic: does this runtime hold GITHUB_TOKEN? Boolean + env key
    // NAMES only (values are never exposed).
    if (url.pathname === "/api/git-sync-status") {
      const names = Object.keys(process.env).filter((k) =>
        /TOKEN|SECRET|KEY|GITHUB|VERCEL/i.test(k),
      );
      const allNames = Object.keys(process.env).filter((k) => !/^(_|[A-Z_]+$)/.test(k) || /GIT|TOKEN|SECRET|KEY|PAT/i.test(k));
      return Response.json({
        token: Boolean(
          process.env.GITHUB_TOKEN || process.env.GitHubtoken || process.env.github2,
        ),
        key: Boolean(process.env.GIT_SYNC_KEY),
        envNames: names,
        allNames,
      });
    }

    // Non-secret alert-config status (channel presence + schedule only).
    if (url.pathname === "/api/alert-status") {
      return Response.json(alertStatus());
    }

    // Guarded one-shot alert check: runs the lay-bets scanner and delivers
    // any new opportunities, if the caller knows GIT_SYNC_KEY. Useful for
    // verifying end-to-end delivery without waiting for the schedule.
    if (url.pathname === "/api/alert-run") {
      const key = process.env.GIT_SYNC_KEY;
      if (!key) return Response.json({ ok: false, error: "key not configured" }, { status: 403 });
      if (url.searchParams.get("key") !== key) {
        return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
      }
      try {
        const r = await runAlertCheck();
        return Response.json({ ok: true, ...r });
      } catch (e) {
        return Response.json({ ok: false, error: String(e) }, { status: 500 });
      }
    }

    // Guarded one-shot sync: runs the git-sync script if the caller knows
    // GIT_SYNC_KEY. Effect is idempotent (pushes HEAD; no-op when synced).
    if (url.pathname === "/api/git-sync") {
      const key = process.env.GIT_SYNC_KEY;
      if (!key) return Response.json({ ok: false, error: "key not configured" }, { status: 403 });
      if (url.searchParams.get("key") !== key) {
        return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
      }
      const r = Bun.spawnSync(
        ["bun", join(import.meta.dir, "scripts/sync-git.mjs")],
        { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      );
      const out = new TextDecoder().decode(r.stdout).trim();
      const err = new TextDecoder().decode(r.stderr).trim();
      return Response.json({ ok: true, out: out.slice(0, 500), err: err.slice(0, 300) });
    }

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

// Start the opportunity alert worker (no-op unless a channel is configured).
startAlertWorker();
