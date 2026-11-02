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
  /**
   * ISO time of the OLDEST price in the list — each sport refreshes on its own
   * clock, so "the scan ran a minute ago" is not the same as "these prices are a
   * minute old". Null only when there is no scan.
   */
  oldestPriceAt: string | null;
  /** Whole minutes since that oldest price, or null when there is no scan. */
  priceAgeMinutes: number | null;
  /** True when the scan is older than STALE_AFTER_MIN — the prices may have moved. */
  stale: boolean;
  staleAfterMin: number;
  /** Fixtures the scan looked at (before the same-day filter). */
  fixturesScanned: number;
  /** Distinct sports among those fixtures — the "M sports" of the coverage line. */
  sportsScanned: number;
  /** Fixtures kicking off today in Europe/London that have not started. */
  sameDayFixtures: number;
  /** Distinct sports among the same-day fixtures. */
  sameDaySports: number;
  /** Sports in season at the last free index refresh (0 when unknown). */
  sportsInSeason: number;
  /** Sports that had at least one same-day fixture at that refresh. */
  sportsWithToday: number;
  /** Same-day fixtures the free index saw across every sport — the honest ceiling. */
  fixturesToday: number;
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
    oldestPriceAt: null,
    priceAgeMinutes: null,
    stale: false,
    staleAfterMin: STALE_AFTER_MIN,
    fixturesScanned: 0,
    sportsScanned: 0,
    sameDayFixtures: 0,
    sameDaySports: 0,
    sportsInSeason: 0,
    sportsWithToday: 0,
    fixturesToday: 0,
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

  let parsed: { ts?: unknown; data?: unknown; index?: unknown; perSport?: unknown };
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as {
      ts?: unknown;
      data?: unknown;
      index?: unknown;
      perSport?: unknown;
    };
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
  const sportsOf = (list: Match[]) => new Set(list.map((m) => m.sportKey).filter(Boolean)).size;

  // The free index the sweep kept: how much of today the scan knows about, even
  // for sports whose odds it has not paid for yet.
  const idx = (parsed.index ?? {}) as {
    sportsInSeason?: unknown;
    sportsWithToday?: unknown;
    totalTodayFixtures?: unknown;
  };
  const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  const sameDaySports = sportsOf(sameDay);

  // When was the OLDEST price in this list fetched? Per-sport clocks, because a
  // same-day sweep pays one credit per sport and therefore rotates. Falls back to
  // the scan timestamp for a cache written before per-sport clocks existed.
  const perSport = (parsed.perSport ?? {}) as Record<string, { fetchedAt?: unknown }>;
  const priceTimes = sameDay
    .map((m) => perSport[m.sportKey]?.fetchedAt)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const oldestTs = priceTimes.length > 0 ? Math.min(...priceTimes) : ts;
  const priceAgeMinutes = Math.max(0, Math.floor((now.getTime() - oldestTs) / 60_000));

  return {
    ok: true,
    status: "ok",
    message:
      sameDay.length > 0
        ? `${sameDay.length} fixture${sameDay.length === 1 ? "" : "s"} kicking off today across ` +
          `${sameDaySports} sport${sameDaySports === 1 ? "" : "s"}.`
        : "The last scan found no fixtures kicking off today.",
    scannedAt: new Date(ts).toISOString(),
    ageMinutes,
    oldestPriceAt: new Date(oldestTs).toISOString(),
    priceAgeMinutes,
    // Staleness is about the PRICES, not the scan loop: a sport whose odds were
    // fetched two hours ago is stale even if the scan ran a minute ago.
    stale: priceAgeMinutes > STALE_AFTER_MIN,
    staleAfterMin: STALE_AFTER_MIN,
    fixturesScanned: matches.length,
    sportsScanned: sportsOf(matches),
    sameDayFixtures: sameDay.length,
    sameDaySports,
    sportsInSeason: count(idx.sportsInSeason),
    sportsWithToday: count(idx.sportsWithToday),
    fixturesToday: count(idx.totalTodayFixtures),
    matches: sameDay,
  };
}
