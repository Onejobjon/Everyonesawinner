/**
 * How much odds-API quota is left, and how long that lasts — in one command.
 *
 * Run:  bun scripts/credits.ts
 *
 * Two rules make this trustworthy:
 *
 *  1. It reads remaining quota from `GET /v4/sports/`, which The Odds API
 *     documents as a **0-credit** endpoint and which still echoes
 *     `x-requests-remaining`. Instrumenting spend must never spend.
 *  2. The burn rate is not an estimate: it is the mean of the `last` values the
 *     worker recorded per scan in `.run/credits.jsonl` (one row per scan, cache
 *     hits recorded as 0). Nothing here is typed in by hand.
 *
 * If there is no rollup yet, or the measured average is zero, it says
 * "not enough data" rather than dividing by zero or guessing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ODDS_API_KEY, oddsKeyProblem } from "../src/server/odds-key";

const BASE = "https://api.the-odds-api.com/v4";
// Same default cadence as the worker; overridable so a projection can be tested
// against a proposed cadence without changing anything.
const INTERVAL_MIN = Number(process.env.ALERT_CHECK_INTERVAL_MIN) > 0
  ? Number(process.env.ALERT_CHECK_INTERVAL_MIN)
  : 10;
const TTL_MIN = Number(process.env.ALERT_CACHE_TTL_MIN) > 0
  ? Number(process.env.ALERT_CACHE_TTL_MIN)
  : 10;
const RUN_DIR = process.env.ALERTS_RUN_DIR || join(import.meta.dir, "../.run");
const CREDITS_FILE = join(RUN_DIR, "credits.jsonl");
const MONTHLY_ALLOWANCE = Number(process.env.ODDS_MONTHLY_ALLOWANCE) > 0
  ? Number(process.env.ODDS_MONTHLY_ALLOWANCE)
  : 20_000;

interface RollupRow {
  ts: string;
  remaining: number | null;
  last: number | null;
  events: number;
  cache: "hit" | "miss";
}

function readRollup(): RollupRow[] {
  if (!existsSync(CREDITS_FILE)) return [];
  return readFileSync(CREDITS_FILE, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as RollupRow;
      } catch {
        return null;
      }
    })
    .filter((r): r is RollupRow => r !== null);
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3);
}

async function main(): Promise<void> {
  if (!ODDS_API_KEY) {
    console.error(`no odds API key: ${oddsKeyProblem() || "ODDS_API_KEY missing"}`);
    process.exit(1);
  }

  // 0-credit endpoint: it reports the quota without drawing on it.
  const res = await fetch(`${BASE}/sports/?apiKey=${ODDS_API_KEY}`);
  if (!res.ok) {
    console.error(`sports endpoint returned HTTP ${res.status} — remaining quota unknown`);
    process.exit(1);
  }
  // Drain the body so the connection is reusable.
  await res.json().catch(() => undefined);
  const remainingHdr = res.headers.get("x-requests-remaining");
  const remaining = remainingHdr != null && !Number.isNaN(Number(remainingHdr)) ? Number(remainingHdr) : null;

  console.log("odds API quota");
  console.log(`  remaining: ${remaining == null ? "not reported by the API" : fmt(remaining)}`);

  const rows = readRollup();
  const withCost = rows.filter((r) => typeof r.last === "number");
  const scans = withCost.length;
  const total = withCost.reduce((a, r) => a + (r.last as number), 0);
  const avgPerScan = scans > 0 ? total / scans : 0;
  const misses = withCost.filter((r) => r.cache === "miss");
  const avgPerFetch = misses.length > 0
    ? misses.reduce((a, r) => a + (r.last as number), 0) / misses.length
    : 0;
  const lastRow = withCost[withCost.length - 1];

  console.log("measured from .run/credits.jsonl (not an estimate)");
  console.log(`  scans recorded: ${scans}${scans ? ` (${misses.length} fetch, ${scans - misses.length} cache hit)` : ""}`);
  if (lastRow) {
    console.log(`  most recent: last=${lastRow.last} events=${lastRow.events} cache=${lastRow.cache} at ${lastRow.ts}`);
  }

  if (scans === 0) {
    console.log("  average per scan: not enough data (no scan has been recorded yet)");
    console.log("\nprojection: not enough data — run the worker at least once, then re-run this.");
    return;
  }
  console.log(`  measured cost per request: ${misses.length ? `${fmt(avgPerFetch)} credits (${misses.length} observed)` : "not enough data"}`);
  console.log(`  average per scan so far: ${fmt(avgPerScan)} credits — includes cache hits, so a burst of nearby scans understates a day's burn; the per-request figure is the one to project with.`);

  if (remaining == null) {
    console.log("\nprojection: not enough data — the API did not report remaining quota.");
    return;
  }
  if (misses.length === 0 || avgPerFetch <= 0) {
    console.log("\nprojection: not enough data — no request has been observed yet, so the cost of one is unknown.");
    return;
  }

  // Scans only cost when the cache is cold, i.e. once per max(cadence, TTL).
  const fetchesPerDay = (intervalMin: number) => 1440 / Math.max(intervalMin, TTL_MIN);
  const perDay = (intervalMin: number) => fetchesPerDay(intervalMin) * avgPerFetch;
  const daysAt = (intervalMin: number) => remaining / perDay(intervalMin);
  const monthlyAt = (intervalMin: number) => perDay(intervalMin) * 30;

  const label = (m: number) => (m < 60 ? `${fmt(m)} minutes` : `${fmt(m / 60)} hours`);
  console.log(`\nmodel: ${fmt(avgPerFetch)} credits per fetch, cache TTL ${fmt(TTL_MIN)} min, ${fmt(fetchesPerDay(INTERVAL_MIN))} fetches/day at a ${fmt(INTERVAL_MIN)}-minute cadence`);
  console.log(`\nheadroom at ${INTERVAL_MIN}-minute cadence (${fmt(fetchesPerDay(INTERVAL_MIN))} fetches/day, ${fmt(monthlyAt(INTERVAL_MIN))}/month):`);
  console.log(`  ${fmt(daysAt(INTERVAL_MIN))} days (${label(daysAt(INTERVAL_MIN) * 1440)}) at ${fmt(perDay(INTERVAL_MIN))} credits/day`);
  console.log(`\nheadroom at hourly cadence (${fmt(fetchesPerDay(60))} fetches/day):`);
  console.log(`  ${fmt(daysAt(60))} days (${label(daysAt(60) * 1440)}) at ${fmt(perDay(60))} credits/day`);
  console.log(`\nmonthly allowance assumed: ${fmt(MONTHLY_ALLOWANCE)}`);
}

await main();
