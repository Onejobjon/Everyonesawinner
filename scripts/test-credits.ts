/**
 * Proves the alert worker measures its own odds-API spend.
 *
 * Run:  bun scripts/test-credits.ts     (also run by scripts/test-alerts.ts)
 *
 * What it holds the code to:
 *  • one scan writes exactly ONE `credits:` line, with last, remaining, events
 *    and cache all populated — the line is the measurement;
 *  • a cache hit costs 0 and says so (`cache=hit last=0`), rather than being
 *    silently indistinguishable from a fetch;
 *  • `.run/credits.jsonl` is valid JSONL, one object per scan, with the keys a
 *    `jq` sum needs.
 *
 * No network: fetch is mocked, and the run directory is a temp dir, so this can
 * never spend a credit or pollute the real rollup.
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}

const RUN_DIR = mkdtempSync(join(tmpdir(), "eaw-credits-test-"));
process.env.ALERTS_RUN_DIR = RUN_DIR;
process.env.ODDS_API_KEY = "test-key-not-real";
process.env.ALERT_CHECK_INTERVAL_MIN = "10";
delete process.env.ALERT_WEBHOOK_URL;
delete process.env.ALERT_EMAIL_TO;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

// One well-formed event, so `events=` is a real count rather than a 0.
const EVENT = {
  id: "abc123",
  sport_key: "soccer_epl",
  sport_title: "EPL",
  commence_time: new Date(Date.now() + 6 * 3600_000).toISOString(),
  home_team: "Home FC",
  away_team: "Away FC",
  bookmakers: [
    {
      key: "skybet",
      title: "Sky Bet",
      last_update: new Date().toISOString(),
      markets: [
        {
          key: "h2h",
          last_update: new Date().toISOString(),
          outcomes: [
            { name: "Home FC", price: 2.1 },
            { name: "Away FC", price: 3.4 },
          ],
        },
      ],
    },
  ],
};

let oddsCalls = 0;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/sports/") && url.includes("/odds/")) {
    oddsCalls++;
    return new Response(JSON.stringify([EVENT]), {
      status: 200,
      headers: { "x-requests-last": "1", "x-requests-remaining": "19781", "content-type": "application/json" },
    });
  }
  // Health check and anything else: a harmless empty payload, no credits.
  return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const alerts = await import("../src/server/alerts");
const LOG_FILE = join(RUN_DIR, "alerts.log");
const CREDITS_FILE = join(RUN_DIR, "credits.jsonl");

const creditsLines = (): string[] =>
  existsSync(LOG_FILE)
    ? readFileSync(LOG_FILE, "utf8").split("\n").filter((l) => l.includes("credits:"))
    : [];

console.log("\nscan 1 — cache miss (one request, cost reported by the API)");
await alerts.runAlertCheck();
const afterFirst = creditsLines();
assert(afterFirst.length === 1, `exactly one credits line per scan (got ${afterFirst.length})`);
const shape = /credits: last=(\d+|unknown) remaining=(\d+|unknown) events=(\d+) cache=(hit|miss)$/;
const line = afterFirst[0] || "";
assert(shape.test(line), `line has all four fields populated — ${line.slice(line.indexOf("credits:"))}`);
assert(line.includes("last=1"), "last=1 — the API bills per request, not per event");
assert(line.includes("remaining=19781"), "remaining=19781 comes from the response header");
assert(line.includes("events=1"), "events counts what the request returned");
assert(line.includes("cache=miss"), "cache=miss on the request that actually spent");
assert(oddsCalls === 1, `one odds request made (got ${oddsCalls})`);

console.log("\nscan 2 — cache hit (no request, costs nothing)");
await alerts.runAlertCheck();
const afterSecond = creditsLines();
assert(afterSecond.length === 2, `still one credits line per scan (got ${afterSecond.length})`);
assert(afterSecond[1].includes("cache=hit"), "second scan reports cache=hit");
assert(afterSecond[1].includes("last=0"), "a cache hit records last=0 rather than pretending it fetched");
assert(oddsCalls === 1, `no second odds request was made (got ${oddsCalls})`);

console.log("\nrollup file — append-only JSONL a jq sum can read");
assert(existsSync(CREDITS_FILE), ".run/credits.jsonl exists");
const raw = existsSync(CREDITS_FILE) ? readFileSync(CREDITS_FILE, "utf8") : "";
const rows = raw.split("\n").filter((l) => l.trim());
assert(rows.length === 2, `one row per scan (got ${rows.length})`);
let parsed = 0;
let keysOk = 0;
for (const r of rows) {
  try {
    const o = JSON.parse(r) as Record<string, unknown>;
    parsed++;
    if (
      typeof o.ts === "string" &&
      typeof o.events === "number" &&
      (o.cache === "hit" || o.cache === "miss") &&
      "last" in o &&
      "remaining" in o
    ) {
      keysOk++;
    }
  } catch {
    /* counted by parsed < rows.length */
  }
}
assert(parsed === rows.length, `every line parses as JSON (${parsed}/${rows.length})`);
assert(keysOk === rows.length, `every row carries ts, remaining, last, events, cache (${keysOk}/${rows.length})`);
const first = rows[0] ? (JSON.parse(rows[0]) as Record<string, unknown>) : {};
assert(first.cache === "miss" && first.last === 1 && first.remaining === 19781, "first row records the fetch it observed");

console.log("\nstatus surface");
const status = alerts.alertStatus() as { lastScanCredits?: { last: number | null; cache: string } | null };
assert(Boolean(status.lastScanCredits), "alertStatus exposes the last scan's measured cost");

rmSync(RUN_DIR, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall credit-instrumentation checks passed");
