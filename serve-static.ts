// Minimal static server for the platform publisher ("npm start").
// The site is a client-side SPA (vite build → dist/), so every unknown
// path falls back to dist/index.html — the same behaviour as the
// rewrites in vercel.json. Binds 0.0.0.0:3000, pinned like the old
// serve.ts, because the platform gateway reverse-proxies that port.
import { join, extname } from "node:path";
import { startAlertWorker, runAlertCheck, alertStatus } from "./src/server/alerts";
import { ODDS_API_KEY, oddsKeyProblem, logOddsKeyState } from "./src/server/odds-key";
import { runLeagueSearch, parseLeagueParam } from "./src/server/league-search";
import { runEventFetch, parseMarkets, isCatalogueSport } from "./src/server/same-match";
import { storeLead } from "./src/server/leads";
import { registerUser, authenticateUser, findByEmail } from "./src/server/users";
import { resolveSession, revokeSession } from "./src/server/sessions";
import { requireProSession, requirePaidSession, requireOwnerSession } from "./src/server/pro-gate";
import { readInstantWins, feedDiagnostics, candidateCacheFiles } from "./src/server/instant-wins";
import { ensureScanOnOpen, scanOnOpenState } from "./src/server/scan-on-open";
import { readGreenHistory } from "./src/server/green-history";
import { pushSnapshot, rememberSnapshot, SNAPSHOT_HEADER, verifyBridgeToken } from "./src/server/scan-bridge";
import { handleStripeEvent, verifyStripeSignature } from "./src/server/stripe-webhook";
import { resolveSportParam, REJECTED_SPORT_MESSAGE } from "./src/lib/sport-params";

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
    //
    // OWNER ONLY (2026-11-02): it lists the environment's variable names, which
    // is reconnaissance for anyone else — and it is machinery, not a customer
    // feature. Same 404 as everything else the owner keeps to himself.
    if (url.pathname === "/api/git-sync-status") {
      const gate = await requireOwnerSession(req);
      if (!gate.ok) {
        return Response.json(
          { error: "not_found", message: "Not found." },
          { status: gate.status, headers: { "cache-control": "no-store" } },
        );
      }
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
      // WHICH COMPETITIONS MAY BE ASKED FOR — checked BEFORE the key check and
      // before any provider request. The query string used to be pasted straight
      // into the paid upstream URL, so every new value was a fresh cache key and
      // a fresh credit; an anonymous caller could burn the month's allowance one
      // loop at a time. Anything outside the catalogue is refused here, which
      // costs zero credits. (api/odds.ts carries the same rule — change both.)
      const sport = resolveSportParam(url.searchParams.get("sport"));
      if (!sport) {
        return Response.json(
          { error: "sport_not_supported", message: REJECTED_SPORT_MESSAGE },
          { status: 400, headers: { "cache-control": "no-store" } },
        );
      }
      // No key anywhere → say so out loud (503 + log), never a silent empty list.
      if (!ODDS_API_KEY) {
        console.error(`[odds-key] /api/odds refused — ${oddsKeyProblem()}`);
        return Response.json(
          {
            error: "odds_unavailable",
            message:
              "Live odds are temporarily unavailable because the odds feed key is not configured on the server.",
          },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
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

    // On-demand, league-scoped odds search — the Lay Bet Finder's Search button
    // (src/server/league-search.ts). Query: ?leagues=soccer_epl,soccer_efl_champ
    //
    // Deliberately SEPARATE from /api/odds above:
    //  • it never reads the 10-minute cache (a search is a fresh read), and
    //  • it never writes it, so a user's search can neither serve stale numbers
    //    as "fresh" nor disturb what the scheduled alert worker sees.
    if (url.pathname === "/api/odds-leagues") {
      // AUTH FIRST — before the catalogue read and before any provider fetch.
      // This endpoint answers a paid data source: an anonymous caller must cost
      // ZERO credits, so the gate sits above everything else in this branch.
      // (2026-10-28: it used to answer anyone; the Paywall was the only gate
      // and a Paywall is UI, not a lock.)
      const gate = await requireProSession(req, "this search");
      if (!gate.ok) {
        console.warn(`[league-search] refused ${url.pathname} — ${gate.error}`);
        return Response.json(
          { error: gate.error, message: gate.message },
          { status: gate.status, headers: { "cache-control": "no-store" } },
        );
      }
      const keys = parseLeagueParam(url.searchParams.get("leagues"));
      if (keys.length === 0) {
        return Response.json(
          {
            error: "no_leagues",
            message: "Pick at least one competition — a search only runs over the competitions you select.",
          },
          { status: 400, headers: { "cache-control": "no-store" } },
        );
      }
      if (!ODDS_API_KEY) {
        console.error(`[league-search] refused — ${oddsKeyProblem()}`);
        return Response.json(
          {
            error: "odds_unavailable",
            message:
              "The live odds feed is not configured on this server, so a search cannot run.",
          },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
      try {
        const result = await runLeagueSearch(keys, { apiKey: ODDS_API_KEY });
        const spent = result.credits.measured ? `${result.credits.spent} requests` : `~${result.credits.spent} requests (estimated)`;
        console.log(
          `[league-search] ${result.leagues.filter((l) => l.ok).length}/${result.leagues.length} leagues, ` +
            `${result.events.length} events, ${spent}${result.credits.remaining != null ? `, ${result.credits.remaining} left` : ""}` +
            (result.rejected.length ? `, rejected: ${result.rejected.join("|")}` : ""),
        );
        for (const l of result.leagues) {
          if (!l.ok) console.error(`[league-search] league failed: ${l.key} — ${l.error}`);
        }
        return Response.json(result, { headers: { "cache-control": "no-store" } });
      } catch (e) {
        console.error(`[league-search] search failed: ${String(e)}`);
        return Response.json(
          { error: "search_failed", message: "The search could not run — please try again." },
          { status: 502, headers: { "cache-control": "no-store" } },
        );
      }
    }

    // ONE fixture's markets, on demand — the Same-Match Planner's paid step.
    //
    // The per-event endpoint bills 1 credit per event per market per region
    // (measured), so this serves exactly one event and never sweeps. Auth is
    // checked first (same order as /api/odds-leagues): an anonymous or non-Pro
    // caller costs ZERO credits, because nothing calls the provider until the
    // gate has passed.
    if (url.pathname === "/api/same-match") {
      const gate = await requireProSession(req, "this fetch");
      if (!gate.ok) {
        console.warn(`[same-match] refused ${url.pathname} — ${gate.error}`);
        return Response.json(
          { error: gate.error, message: gate.message },
          { status: gate.status, headers: { "cache-control": "no-store" } },
        );
      }
      const eventId = (url.searchParams.get("event") || "").trim();
      const sport = (url.searchParams.get("sport") || "").trim();
      const markets = parseMarkets(url.searchParams.get("markets"));
      if (!eventId || !sport) {
        return Response.json(
          {
            error: "no_event",
            message: "Pick one fixture first — this fetch covers exactly one match.",
          },
          { status: 400, headers: { "cache-control": "no-store" } },
        );
      }
      if (!isCatalogueSport(sport)) {
        return Response.json(
          {
            error: "unknown_competition",
            message: "That competition is not in our list, so nothing was requested.",
          },
          { status: 400, headers: { "cache-control": "no-store" } },
        );
      }
      if (!ODDS_API_KEY) {
        console.error(`[same-match] refused — ${oddsKeyProblem()}`);
        return Response.json(
          {
            error: "odds_unavailable",
            message:
              "The live odds feed is not configured on this server, so this match cannot be fetched.",
          },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
      const result = await runEventFetch({ sport, eventId, markets, apiKey: ODDS_API_KEY });
      if (!result.ok) {
        console.error(`[same-match] ${sport}/${eventId} failed — ${result.error}`);
        return Response.json(
          { ...result, error: "fetch_failed", message: result.error },
          { status: 502, headers: { "cache-control": "no-store" } },
        );
      }
      const spent = result.credits.measured
        ? `${result.credits.spent} requests`
        : `~${result.credits.spent} requests (estimated)`;
      console.log(
        `[same-match] ${sport}/${eventId} markets=${result.markets.join(",")} ${spent}` +
          (result.credits.remaining != null ? `, ${result.credits.remaining} left` : ""),
      );
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    }

    // INSTANT WINS — the same-day feed the dashboard loads on open.
    //
    // SCAN ON OPEN (owner directive 2026-11-03: "scan every 30mins and on open"):
    // if the newest scan we can see is more than ~5 minutes old, this request asks
    // for a new one — through the SAME pipeline the scheduled loop uses
    // (runAlertCheck: transform, greens history, Telegram, push to the published
    // host). Three rules, all in src/server/scan-on-open.ts:
    //   • single flight — an in-process promise plus a lock file, so ten opens in a
    //     minute cost one scan, not ten;
    //   • the page is never made to wait — the scan is started and NOT awaited, and
    //     the answer below is the snapshot we already hold plus `refreshing: true`;
    //   • a failed scan changes nothing the user can see, and says so.
    //
    // Paid-tier gate (Starter and above) — it is not a Pro tool, but it is not
    // public either. The gate runs before the file read.
    if (url.pathname === "/api/instant-wins") {
      const gate = await requirePaidSession(req, "the instant-win feed");
      if (!gate.ok) {
        console.warn(`[instant-wins] refused ${url.pathname} — ${gate.error}`);
        return Response.json(
          { error: gate.error, message: gate.message },
          { status: gate.status, headers: { "cache-control": "no-store" } },
        );
      }
      try {
        const payload = readInstantWins();
        // Fire-and-forget: this returns a decision, never a wait.
        let refreshing = false;
        let refreshNote = "";
        try {
          const decision = ensureScanOnOpen({
            newestScanAt: payload.scannedAt,
            canScan: Boolean(ODDS_API_KEY),
          });
          refreshing = decision.refreshing;
          refreshNote = `${decision.started ? "started" : "no-start"}: ${decision.reason}`;
        } catch (e) {
          // The feed must answer even if the refresh path is broken.
          console.error(`[instant-wins] scan-on-open failed: ${String(e)}`);
          refreshNote = `error: ${String(e)}`;
        }
        console.log(
          `[instant-wins] status=${payload.status} age=${payload.ageMinutes ?? "-"}m stale=${payload.stale} ` +
            `fixtures=${payload.fixturesScanned} sameDay=${payload.sameDayFixtures} ` +
            `refreshing=${refreshing} (${refreshNote})`,
        );
        const onOpen = scanOnOpenState();
        return Response.json(
          {
            ...payload,
            refreshing,
            refreshStartedAt: onOpen.startedAt,
            // If the last on-open scan failed, the page says the prices may have
            // moved. It never blanks: the rows above are still the last real ones.
            refreshFailed: onOpen.lastError != null && !refreshing,
          },
          { headers: { "cache-control": "no-store" } },
        );
      } catch (e) {
        // A read failure is a STATE, not a 500: the page says "no scan data yet".
        console.error(`[instant-wins] read failed: ${String(e)}`);
        return Response.json(
          {
            ok: true,
            status: "no_scan",
            reason: "unreadable",
            message:
              "No prices to show yet — the last list we received could not be read, so there is nothing to display.",
            scannedAt: null,
            ageMinutes: null,
            stale: false,
            staleAfterMin: 20,
            fixturesScanned: 0,
            sameDayFixtures: 0,
            matches: [],
            refreshing: false,
          },
          { headers: { "cache-control": "no-store" } },
        );
      }
    }

    // OPERATIONS STATUS — OWNER ONLY (2026-11-02).
    //
    // This used to answer anyone on the public internet: when the scanner last
    // ran, whether Telegram is configured, the schedule, the credit state. The
    // owner's instruction: that is his information, not a customer feature.
    //
    // The gate is the OWNER identity (ownerEmails() + a real server session),
    // not "any paid" and not "any Pro". Everyone else gets the same 404 the SPA
    // fallback would give for a path that does not exist, with no schedule or
    // channel detail in the body.
    if (url.pathname === "/api/alert-status") {
      const gate = await requireOwnerSession(req);
      if (!gate.ok) {
        console.warn(`[alert-status] refused — ${gate.error}`);
        return Response.json(
          { error: "not_found", message: "Not found." },
          { status: gate.status, headers: { "cache-control": "no-store" } },
        );
      }
      return Response.json(alertStatus(), { headers: { "cache-control": "no-store" } });
    }

    // FEED DIAGNOSTICS — OWNER ONLY. What this process can actually see: the
    // paths it resolves, whether each one exists and reads, the last snapshot it
    // was pushed, and the last push attempt. Built after the published host
    // answered "no scan data yet" while the scanner was healthy, with no way to
    // tell from outside which path it had resolved.
    if (url.pathname === "/api/feed-diagnostics") {
      const gate = await requireOwnerSession(req);
      if (!gate.ok) {
        return Response.json(
          { error: "not_found", message: "Not found." },
          { status: gate.status, headers: { "cache-control": "no-store" } },
        );
      }
      return Response.json(
        { ...feedDiagnostics(), scanOnOpen: scanOnOpenState() },
        { headers: { "cache-control": "no-store" } },
      );
    }

    // SCAN SNAPSHOT — the receiving end of the bridge (src/server/scan-bridge.ts).
    //
    // The scan runs on the machine that writes `.run/`, and the published copy of
    // this site cannot read that machine's disk. So after every scan the machine
    // that did the work POSTs the snapshot here; this process keeps it in memory
    // (and best-effort on disk) and `/api/instant-wins` serves from it.
    //
    // Auth: an HMAC derived from the shared owner secret — never the secret
    // itself. ZERO credits: this endpoint only stores what it was given.
    if (url.pathname === "/api/scan-snapshot") {
      if (req.method !== "POST") {
        return Response.json({ error: "method_not_allowed" }, { status: 405 });
      }
      const presented = req.headers.get(SNAPSHOT_HEADER);
      if (!verifyBridgeToken(presented)) {
        console.warn("[scan-snapshot] refused — bad or missing bridge token");
        return Response.json({ error: "not_found", message: "Not found." }, { status: 404 });
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid_json" }, { status: 400 });
      }
      const parsed = (body ?? {}) as { cache?: { ts?: unknown; data?: unknown }; greens?: unknown; pushedAt?: unknown };
      if (
        typeof parsed.cache?.ts !== "number" ||
        !Array.isArray(parsed.cache?.data)
      ) {
        return Response.json({ error: "invalid_snapshot" }, { status: 400 });
      }
      const snapshot = {
        cache: parsed.cache,
        greens: parsed.greens ?? null,
        pushedAt: typeof parsed.pushedAt === "string" ? parsed.pushedAt : new Date().toISOString(),
      };
      rememberSnapshot(snapshot);
      // Best effort on disk: some deployments are read-only, and memory above is
      // the store the feed actually depends on.
      let persisted = false;
      try {
        const target = candidateCacheFiles()[0];
        const { mkdirSync, writeFileSync } = await import("node:fs");
        const { dirname } = await import("node:path");
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, JSON.stringify(parsed.cache));
        persisted = true;
      } catch (e) {
        console.warn(`[scan-snapshot] could not persist to disk: ${String(e)}`);
      }
      const fixtures = (parsed.cache.data as unknown[]).length;
      console.log(
        `[scan-snapshot] accepted ${fixtures} fixtures, scan ${new Date(parsed.cache.ts).toISOString()} (disk=${persisted}, no provider call)`,
      );
      return Response.json(
        { ok: true, fixtures, persisted, receivedAt: new Date().toISOString() },
        { headers: { "cache-control": "no-store" } },
      );
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
        const record = await storeLead({
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
        const user = await registerUser(
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
        const user = await authenticateUser(
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

    // Stripe webhook — the ONLY way a customer's plan changes.
    // Fails closed: with no STRIPE_WEBHOOK_SECRET we refuse the request (503)
    // rather than trust an unauthenticated caller to grant a paid plan.
    if (url.pathname === "/api/stripe-webhook") {
      if (req.method !== "POST") {
        return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
      }
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!secret) {
        console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set — refusing the event");
        return Response.json({ ok: false, error: "Webhook not configured" }, { status: 503 });
      }
      const raw = await req.text();
      if (!verifyStripeSignature(raw, req.headers.get("stripe-signature"), secret)) {
        return Response.json({ ok: false, error: "Bad signature" }, { status: 400 });
      }
      try {
        const event = JSON.parse(raw);
        const note = await handleStripeEvent(event);
        console.log(`[stripe-webhook] ${note}`);
        return Response.json({ ok: true, note });
      } catch (e) {
        console.error(`[stripe-webhook] failed: ${String(e)}`);
        return Response.json({ ok: false, error: "Could not apply event" }, { status: 500 });
      }
    }
    // Session check — the ONLY source of truth for the paywall.
    // GET /api/me with `Authorization: Bearer <token>`.
    // 200 { ok, user } | 401 unknown/expired token | 503 account service down.
    // A hand-written localStorage session cannot pass this: the token has to
    // exist in the server-side session store (src/server/sessions.ts).
    if (url.pathname === "/api/me") {
      if (req.method !== "GET") {
        return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
      }
      const authHeader = req.headers.get("authorization") || "";
      const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1] || "";
      const token = (bearer || url.searchParams.get("token") || "").trim();
      if (!token) {
        return Response.json({ ok: false, error: "Not signed in" }, { status: 401 });
      }
      try {
        const session = await resolveSession(token);
        if (!session) {
          return Response.json({ ok: false, error: "Session expired" }, { status: 401 });
        }
        const found = await findByEmail(session.email);
        if (!found) {
          return Response.json({ ok: false, error: "Account not found" }, { status: 401 });
        }
        // THE ENTITLEMENT ANSWER, from the one rule in src/server/entitlement.ts
        // (via findByEmail → toPublic). `entitled` replaced a stored
        // `subscription` boolean that could disagree with the server gates and
        // never expired. The dates are here so the page can tell a customer when
        // their access ends — and so the grace email can quote a real date.
        return Response.json({
          ok: true,
          user: {
            name: found.name,
            email: found.email,
            entitled: found.entitled,
            // DEPRECATED alias, same value: a browser still running the previous
            // bundle reads `subscription`, and during the few minutes between a
            // server restart and the next publish the two must not disagree.
            // Remove once the `entitled` client is the only one in the wild.
            subscription: found.entitled,
            plan: found.plan,
            subscriptionStatus: found.subscriptionStatus,
            currentPeriodEnd: found.currentPeriodEnd,
            graceEndsAt: found.graceEndsAt,
            token,
          },
        });
      } catch (e) {
        // Fail CLOSED: if we cannot verify the account, nobody gets the tools.
        console.error(`[api/me] account store unavailable: ${String(e)}`);
        return Response.json(
          { ok: false, error: "Account service unavailable" },
          { status: 503 },
        );
      }
    }
    // Logout — revoke the server-side session so a copied token stops working.
    if (url.pathname === "/api/logout") {
      if (req.method !== "POST") {
        return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
      }
      const authHeader = req.headers.get("authorization") || "";
      const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1] || "";
      let token = (bearer || url.searchParams.get("token") || "").trim();
      if (!token) {
        try {
          const body = (await req.json()) as { token?: unknown };
          if (typeof body?.token === "string") token = body.token;
        } catch {
          /* no body */
        }
      }
      await revokeSession(token);
      return Response.json({ ok: true });
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
logOddsKeyState("serve-static boot");

/**
 * Push the scan we hold to the published host(s) — the sending end of the bridge
 * (src/server/scan-bridge.ts).
 *
 * Called after every scan (src/server/alerts.ts) and once on boot, so a restart
 * of THIS machine repopulates the published feed without waiting for a scan.
 * ZERO credits: it copies a file the scan already paid for.
 */
async function pushCurrentSnapshot(reason: string): Promise<void> {
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    const file = candidateCacheFiles().find((f) => existsSync(f));
    if (!file) {
      console.log(`[scan-snapshot] nothing to push (${reason}): no scan file here`);
      return;
    }
    const cache = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const report = await pushSnapshot(
      { cache, greens: readGreenHistory(), pushedAt: new Date().toISOString() },
      {},
    );
    console.log(
      `[scan-snapshot] push (${reason}): ${report.delivered ? "delivered" : "FAILED"} ` +
        `${report.fixtures} fixtures` +
        (report.skipped ? ` — ${report.skipped}` : ` — ${report.attempts.map((a) => `${a.url} ${a.status ?? a.detail}`).join("; ")}`),
    );
  } catch (e) {
    console.warn(`[scan-snapshot] push (${reason}) failed: ${String(e)}`);
  }
}

if (process.env.SCAN_PUSH_DISABLED !== "1") {
  void pushCurrentSnapshot("boot");
}

// Start the opportunity alert worker (no-op unless a channel is configured).
// The alert worker normally runs INSIDE this server (state/health endpoint on
// the same process). When this instance is started purely as the port-3100
// status/health host for a separate scan loop, set ALERT_WORKER_DISABLED=1 so
// we don't scan twice.
if (process.env.ALERT_WORKER_DISABLED !== "1") startAlertWorker();
