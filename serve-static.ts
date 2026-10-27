// Minimal static server for the platform publisher ("npm start").
// The site is a client-side SPA (vite build → dist/), so every unknown
// path falls back to dist/index.html — the same behaviour as the
// rewrites in vercel.json. Binds 0.0.0.0:3000, pinned like the old
// serve.ts, because the platform gateway reverse-proxies that port.
import { join, extname } from "node:path";
import { startAlertWorker, runAlertCheck, alertStatus } from "./src/server/alerts";
import { ODDS_API_KEY } from "./src/server/odds-key";
import { storeLead } from "./src/server/leads";
import { registerUser, authenticateUser } from "./src/server/users";

// Port is configurable: the platform now runs its own dev server on 3000, so
// the alert host runs alongside it on PORT (default 3000 for the VPS recipe).
const PORT = Number(process.env.PORT || 3000);
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

// Server-side odds cache (in-memory, TTL 10 min). Mirrors api/odds.ts so the
// platform URL and the Vercel domain behave the same: repeated /api/odds hits
// within the window serve the cached upstream body instead of re-fetching
// the-odds-api.com (protects the monthly credit allowance).
const ODDS_CACHE_TTL_MS = 10 * 60 * 1000;
const oddsCache = new Map<string, { body: string; status: number; ok: boolean; ts: number }>();

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

    // Odds proxy — fetches live odds server-side so the API key never ships
    // to the client. Query: ?sport=<sportKey> (default "upcoming").
    if (url.pathname === "/api/odds") {
      const sport = url.searchParams.get("sport") || "upcoming";
      const target =
        sport === "upcoming"
          ? `https://api.the-odds-api.com/v4/sports/upcoming/odds/?apiKey=${ODDS_API_KEY}&regions=uk&markets=h2h&oddsFormat=decimal`
          : `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sport)}/odds/?apiKey=${ODDS_API_KEY}&regions=uk&markets=h2h&oddsFormat=decimal`;

      const hit = oddsCache.get(target);
      if (hit && Date.now() - hit.ts < ODDS_CACHE_TTL_MS) {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (hit.ok) headers["cache-control"] = "public, max-age=300";
        return new Response(hit.body, { status: hit.status, headers });
      }

      try {
        const upstream = await fetch(target);
        const body = await upstream.text();
        // Only cache successful upstream responses — never pin a transient error.
        if (upstream.ok) {
          oddsCache.set(target, { body, status: upstream.status, ok: true, ts: Date.now() });
        }
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (upstream.ok) headers["cache-control"] = "public, max-age=300";
        return new Response(body, { status: upstream.status, headers });
      } catch (e) {
        return Response.json({ error: "odds proxy failed" }, { status: 502 });
      }
    }

    // Non-secret alert-config status (channel presence + schedule only).
    if (url.pathname === "/api/alert-status") {
      return Response.json(alertStatus());
    }

    // Lead capture — persists name/email/source/date to a durable JSON file
    // (src/server/leads.ts). POST only; body { name, email, source }.
    if (url.pathname === "/api/leads") {
      if (req.method !== "POST") {
        return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
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
        return Response.json({ ok: true, record });
      } catch (e) {
        return Response.json(
          { ok: false, error: e instanceof Error ? e.message : "Invalid lead" },
          { status: 400 },
        );
      }
    }

    // Account signup — persists name/email + scrypt-hashed password to a
    // durable JSON file (src/server/users.ts). POST { name, email, password }.
    if (url.pathname === "/api/signup") {
      if (req.method !== "POST") {
        return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
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
        return Response.json({ ok: true, user });
      } catch (e) {
        return Response.json(
          { ok: false, error: e instanceof Error ? e.message : "Could not create account" },
          { status: 400 },
        );
      }
    }

    // Account login — verifies credentials against the users store.
    // POST { email, password }.
    if (url.pathname === "/api/login") {
      if (req.method !== "POST") {
        return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
      }
      const { email, password } = (body ?? {}) as {
        email?: unknown;
        password?: unknown;
      };
      try {
        const user = authenticateUser(
          typeof email === "string" ? email : "",
          typeof password === "string" ? password : "",
        );
        return Response.json({ ok: true, user });
      } catch (e) {
        return Response.json(
          { ok: false, error: e instanceof Error ? e.message : "Invalid credentials" },
          { status: 401 },
        );
      }
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
// The alert worker normally runs INSIDE this server (state/health endpoint on
// the same process). When this instance is started purely as the port-3100
// status/health host for a separate scan loop, set ALERT_WORKER_DISABLED=1 so
// we don't scan twice.
if (process.env.ALERT_WORKER_DISABLED !== "1") startAlertWorker();
