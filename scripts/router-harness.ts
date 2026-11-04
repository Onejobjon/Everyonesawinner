/**
 * A REAL-HTTP PROOF OF THE REWRITE CONTRACT (2026-11-04).
 *
 * The unit tests drive the router with fake req/res objects. This harness puts
 * it behind an actual `node:http` server and — crucially — applies the rewrites
 * FROM vercel.json ITSELF, in order, before the router ever sees the request.
 * So it answers the only question that matters after the bracketed-filename
 * failure: does `{"source": "/api/(.*)", "destination": "/api/router?path=$1"}`
 * actually deliver `/api/odds?sport=…` to the router as `?path=odds&sport=…`,
 * with a JSON body and the right status — or does it deliver a web page?
 *
 *   bun run scripts/router-harness.ts
 *
 * A stub "platform" server stands in for the platform host, so every assertion
 * about what a handler forwarded (path, query, method, Authorization, body) is
 * read off a real socket rather than off a mock.
 *
 * Exits non-zero if any route is wrong. Nothing here touches the network.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import router from "../api/router";

const ROOT = join(import.meta.dir, "..");

/* ── the stub platform host ─────────────────────────────────────────────── */

interface Seen {
  method: string;
  path: string;
  query: string;
  auth: string | undefined;
  body: string;
}

const seen: Seen[] = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const platform = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://platform.test");
  const body = await readBody(req);
  seen.push({
    method: req.method ?? "GET",
    path: url.pathname,
    query: url.search,
    auth: req.headers.authorization,
    body,
  });
  // /go/<slug> behaves like the real click log: a bare 302 to the brand.
  if (url.pathname.startsWith("/go/")) {
    res.statusCode = 302;
    res.setHeader("location", "https://www.betfred.com/welcome");
    res.end();
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, from: "stub-platform", path: url.pathname, query: url.search }));
});

/* ── the rewrite engine, read from vercel.json ──────────────────────────── */

interface Rewrite {
  source: string;
  destination: string;
}

const rewrites: Rewrite[] = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")).rewrites;

/** `/api/(.*)` → /^\/api\/(.*)$/ — enough for the patterns this file uses. */
function toRegex(source: string): RegExp {
  const escaped = source.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Apply the first matching rewrite and merge the ORIGINAL query string into the
 * destination, which is what Vercel documents and what this contract relies on.
 */
function applyRewrites(incomingPath: string, incomingQuery: string): string {
  for (const r of rewrites) {
    const m = incomingPath.match(toRegex(r.source));
    if (!m) continue;
    let destination = r.destination;
    for (let i = 1; i < m.length; i += 1) destination = destination.replace(`$${i}`, m[i]!);
    const [destPath, destQuery = ""] = destination.split("?");
    const merged = new URLSearchParams(destQuery);
    for (const [k, v] of new URLSearchParams(incomingQuery)) merged.append(k, v);
    const qs = merged.toString();
    return `${destPath}${qs ? `?${qs}` : ""}`;
  }
  return `${incomingPath}${incomingQuery ? `?${incomingQuery}` : ""}`;
}

/* ── the router behind a real socket, reached only through the rewrites ─── */

const site = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const incoming = new URL(req.url ?? "/", "http://www.everyonesawinner.uk");
  const rewritten = applyRewrites(incoming.pathname, incoming.search.replace(/^\?/, ""));
  const url = new URL(rewritten, "http://www.everyonesawinner.uk");
  const raw = await readBody(req);

  let parsedBody: unknown = raw === "" ? undefined : raw;
  if (raw && (req.headers["content-type"] ?? "").includes("application/json")) {
    try {
      parsedBody = JSON.parse(raw);
    } catch {
      parsedBody = raw;
    }
  }

  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) if (!(k in query)) query[k] = v;

  // A res shaped like a Vercel function's.
  const out = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    setHeader(k: string, v: string) {
      out.headers[k.toLowerCase()] = v;
    },
    end(b: string) {
      out.body = b ?? "";
      res.statusCode = out.statusCode;
      for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
      res.end(out.body);
    },
  };

  await router(
    {
      method: req.method,
      headers: req.headers,
      body: parsedBody,
      // THE POINT OF THE HARNESS: the function sees the rewrite destination,
      // not the URL the visitor typed.
      url: rewritten,
      query,
    } as any,
    out as any,
  );
});

/* ── the run ────────────────────────────────────────────────────────────── */

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

interface Case {
  /** What the visitor types. */
  path: string;
  method?: string;
  body?: string;
  contentType?: string;
  expect: number;
  /** JSON body assertions. */
  error?: string;
  /** Expected upstream (stub) path — proves the route reached the platform. */
  upstream?: string;
  /** Expected upstream query string. */
  upstreamQuery?: string;
  location?: string;
}

const CASES: Case[] = [
  { path: "/api/me", expect: 401, error: "Not signed in" },
  { path: "/api/login", expect: 405, error: "Method not allowed" },
  { path: "/api/signup", expect: 405, error: "Method not allowed" },
  { path: "/api/leads", expect: 405, error: "Method not allowed" },
  { path: "/api/odds?sport=not_a_sport", expect: 400, error: "sport_not_supported" },
  { path: "/api/odds?sport=soccer_epl", expect: 200, upstream: "/api/odds", upstreamQuery: "?sport=soccer_epl" },
  { path: "/api/odds-leagues", expect: 401, error: "not_signed_in" },
  { path: "/api/same-match", expect: 401, error: "not_signed_in" },
  { path: "/api/instant-wins", expect: 401, error: "not_signed_in" },
  { path: "/api/comps", expect: 404, error: "not_found" },
  { path: "/api/comps/revoke", method: "POST", body: "{}", contentType: "application/json", expect: 404, error: "not_found" },
  { path: "/api/stripe-webhook", method: "POST", body: '{"id":"evt_1"}', contentType: "application/json", expect: 421 },
  { path: "/api/checkout", expect: 200, upstream: "/api/checkout" },
  { path: "/go/mrq", expect: 302, location: "https://www.betfred.com/welcome", upstream: "/go/mrq" },
  { path: "/api/nope", expect: 404, error: "not_found" },
];

async function main() {
  const platformPort = await listen(platform);
  const platformUrl = `http://127.0.0.1:${platformPort}`;
  process.env.PLATFORM_API_URL = platformUrl;
  process.env.PLATFORM_ODDS_URL = platformUrl;
  delete process.env.PLATFORM_CHECKOUT_URL;
  delete process.env.ODDS_API_KEY; // force the keyless fallback, as the domain has
  delete process.env.Oddsapi;

  const sitePort = await listen(site);
  const base = `http://127.0.0.1:${sitePort}`;

  let failures = 0;
  const rows: string[] = [];
  for (const c of CASES) {
    seen.length = 0;
    const res = await fetch(`${base}${c.path}`, {
      method: c.method ?? "GET",
      body: c.body,
      headers: c.contentType ? { "content-type": c.contentType } : undefined,
      redirect: "manual",
    });
    const text = await res.text();
    const type = res.headers.get("content-type") ?? "";
    const problems: string[] = [];

    if (res.status !== c.expect) problems.push(`status ${res.status} != ${c.expect}`);
    // THE REGRESSION THIS HARNESS EXISTS FOR: a web page where JSON belongs.
    if (c.expect !== 302 && !type.includes("application/json")) problems.push(`content-type "${type}" is not JSON`);
    if (text.trim().startsWith("<")) problems.push("body is HTML");

    if (c.error) {
      try {
        const body = JSON.parse(text);
        if (body.error !== c.error) problems.push(`error "${body.error}" != "${c.error}"`);
      } catch {
        problems.push("body is not JSON");
      }
    }
    if (c.location && res.headers.get("location") !== c.location) {
      problems.push(`location "${res.headers.get("location")}" != "${c.location}"`);
    }
    if (c.upstream) {
      const call = seen.find((s) => s.path === c.upstream);
      if (!call) problems.push(`platform never saw ${c.upstream} (saw ${seen.map((s) => s.path).join(", ") || "nothing"})`);
      if (c.upstreamQuery && call && call.query !== c.upstreamQuery) {
        problems.push(`upstream query "${call.query}" != "${c.upstreamQuery}"`);
      }
    }
    if (c.path === "/api/stripe-webhook" && seen.length !== 0) problems.push("the webhook forwarded to the platform");

    if (problems.length) failures += 1;
    rows.push(
      `${problems.length ? "FAIL" : "ok  "} ${(c.method ?? "GET").padEnd(4)} ${c.path.padEnd(34)} ${String(res.status).padEnd(4)} ${
        problems.length ? problems.join("; ") : `${type.split(";")[0]}`
      }`,
    );
  }

  console.log(rows.join("\n"));
  console.log(
    `\n${CASES.length - failures}/${CASES.length} routes correct through the vercel.json rewrites` +
      ` (13 routes incl. checkout; ${rewrites.length} rewrites applied: ${rewrites.map((r) => r.source).join(" ")} )`,
  );
  site.close();
  platform.close();
  if (failures) process.exitCode = 1;
}

await main();
