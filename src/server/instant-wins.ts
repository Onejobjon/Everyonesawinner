/**
 * Server side of the Instant Wins feed — reads the scan's own cache and nothing
 * else.
 *
 * THE CREDIT GUARANTEE LIVES HERE. This module performs no `fetch` and imports
 * no provider client: its only input is `.run/alerts-cache.json`, the file the
 * scheduled scan writes after it has already paid for its odds (src/server/alerts.ts,
 * `getMatches()` → `writeFileSync(CACHE_FILE, …)`). Reading it therefore costs
 * ZERO credits and can be repeated as often as the page likes.
 *
 * MISSING IS NOT EMPTY. A missing or unreadable cache returns
 * `status: "no_scan"` with an explicit message, never `rows: []` — an empty list
 * would read as "we looked and found nothing", which would be a lie.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Match } from "../lib/odds-api";
import { STALE_AFTER_MIN, selectSameDayMatches } from "../lib/instant-wins";

export type InstantWinsStatus = "ok" | "no_scan";

export interface InstantWinsPayload {
  ok: true;
  status: InstantWinsStatus;
  /** Plain-language explanation of `status`, always present. */
  message: string;
  /** ISO time the scan finished (its own clock), or null when there is no scan. */
  scannedAt: string | null;
  /** Whole minutes since that scan, or null when there is no scan. */
  ageMinutes: number | null;
  /** True when the scan is older than STALE_AFTER_MIN — the prices may have moved. */
  stale: boolean;
  staleAfterMin: number;
  /** Fixtures the scan looked at (before the same-day filter). */
  fixturesScanned: number;
  /** Fixtures kicking off today in Europe/London that have not started. */
  sameDayFixtures: number;
  /**
   * The same-day fixtures, already passed through the shared transform's sanity
   * rules. The page builds its rows from these with the shared calcLay at the
   * user's own stake and commission.
   */
  matches: Match[];
  /** Why there is no scan, when there is none. */
  reason?: "missing" | "unreadable";
}

/** Same override the alert worker uses, so a test can point at a temp dir. */
export function runDir(): string {
  return process.env.ALERTS_RUN_DIR || join(import.meta.dir, "../../.run");
}

export function cacheFile(): string {
  return join(runDir(), "alerts-cache.json");
}

export interface ReadInstantWinsOptions {
  /** Explicit cache path (tests). */
  file?: string;
  /** "Now" — injectable so the day boundary and staleness are testable. */
  now?: Date;
}

function noScan(message: string, reason: "missing" | "unreadable"): InstantWinsPayload {
  return {
    ok: true,
    status: "no_scan",
    message,
    scannedAt: null,
    ageMinutes: null,
    stale: false,
    staleAfterMin: STALE_AFTER_MIN,
    fixturesScanned: 0,
    sameDayFixtures: 0,
    matches: [],
    reason,
  };
}

/**
 * Read the last scan and return the same-day slice of it.
 *
 * Never throws: a broken cache is a state the page has to be able to show.
 */
export function readInstantWins(options: ReadInstantWinsOptions = {}): InstantWinsPayload {
  const file = options.file ?? cacheFile();
  const now = options.now ?? new Date();

  if (!existsSync(file)) {
    return noScan(
      "No scan data yet — the scheduled scan has not completed a run on this machine, so there is nothing to show. Nothing was fetched to fill the gap.",
      "missing",
    );
  }

  let parsed: { ts?: unknown; data?: unknown };
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as { ts?: unknown; data?: unknown };
  } catch {
    return noScan(
      "No scan data yet — the last scan's file could not be read, so there is nothing to show. Nothing was fetched to fill the gap.",
      "unreadable",
    );
  }

  const ts = typeof parsed?.ts === "number" && Number.isFinite(parsed.ts) ? parsed.ts : null;
  const matches = Array.isArray(parsed?.data) ? (parsed.data as Match[]) : null;
  if (ts == null || matches == null) {
    return noScan(
      "No scan data yet — the last scan's file is not in a shape we can read, so there is nothing to show. Nothing was fetched to fill the gap.",
      "unreadable",
    );
  }

  const ageMs = Math.max(0, now.getTime() - ts);
  const ageMinutes = Math.floor(ageMs / 60_000);
  const sameDay = selectSameDayMatches(matches, now);

  return {
    ok: true,
    status: "ok",
    message:
      sameDay.length > 0
        ? `${sameDay.length} fixture${sameDay.length === 1 ? "" : "s"} kicking off today.`
        : "The last scan found no fixtures kicking off today.",
    scannedAt: new Date(ts).toISOString(),
    ageMinutes,
    stale: ageMinutes > STALE_AFTER_MIN,
    staleAfterMin: STALE_AFTER_MIN,
    fixturesScanned: matches.length,
    sameDayFixtures: sameDay.length,
    matches: sameDay,
  };
}
