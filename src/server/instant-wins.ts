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
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Match } from "../lib/odds-api";
import { STALE_AFTER_MIN, selectSameDayMatches } from "../lib/instant-wins";
import { readGreenHistory, type GreenHistorySummary } from "./green-history";
import { bridgeSecret, lastPush, pushTargets, readRememberedSnapshot } from "./scan-bridge";

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
  /**
   * Why there is no scan, when there is none.
   *
   * `unreachable` is the one that matters on the published host: there IS a
   * healthy scanner, this server simply cannot see its files. Saying "no scan
   * data yet" for that would blame the scanner for the server's blindness.
   */
  reason?: "missing" | "unreadable" | "unreachable";
  /**
   * Where this answer came from: the scan's own file on this machine, or a
   * snapshot the scan pushed here. Diagnostic only — never a reason to change
   * what the page says about the prices themselves.
   */
  source?: "scan-file" | "pushed-snapshot";
  /** Greens found in the last 30 days — the proof of value under the feed. */
  greens30d?: GreenHistorySummary;
}

/** Same override the alert worker uses, so a test can point at a temp dir. */
export function runDir(): string {
  return process.env.ALERTS_RUN_DIR || join(import.meta.dir, "../../.run");
}

/**
 * Every path the feed will look for a scan file in, most specific first.
 *
 * WHY MORE THAN ONE: the published copy of the site runs the same code from a
 * different directory, and the alert worker runs as its own process. A single
 * `import.meta.dir` guess is exactly how the feed went blind on 2026-11-02 —
 * `.run/` resolved inside a directory the serving process was not using. These
 * are the plausible layouts; the newest readable one wins, so a mismatch
 * self-heals instead of silently showing "no scan data yet".
 */
export function candidateCacheFiles(): string[] {
  const out: string[] = [];
  const push = (p: string) => {
    if (p && !out.includes(p)) out.push(p);
  };
  const envDir = process.env.ALERTS_RUN_DIR?.trim();
  if (envDir) push(join(envDir, "alerts-cache.json"));
  push(join(import.meta.dir, "../../.run", "alerts-cache.json"));
  push(join(process.cwd(), ".run", "alerts-cache.json"));
  push(join(process.cwd(), "..", ".run", "alerts-cache.json"));
  return out;
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

function noScan(
  message: string,
  reason: "missing" | "unreadable" | "unreachable",
  greens?: GreenHistorySummary,
): InstantWinsPayload {
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
    greens30d: greens,
  };
}

/** One thing the feed can read: a file, or the snapshot pushed to this process. */
interface Source {
  kind: "scan-file" | "pushed-snapshot";
  where: string;
  ts: number;
  data: Match[];
  index?: unknown;
  perSport?: Record<string, { fetchedAt?: unknown }>;
  greens?: GreenHistorySummary | null;
}

function asSource(
  raw: unknown,
  kind: Source["kind"],
  where: string,
): { source: Source } | { problem: string } {
  const parsed = (raw ?? {}) as {
    ts?: unknown;
    data?: unknown;
    index?: unknown;
    perSport?: unknown;
    greens?: unknown;
  };
  const ts = typeof parsed.ts === "number" && Number.isFinite(parsed.ts) ? parsed.ts : null;
  const data = Array.isArray(parsed.data) ? (parsed.data as Match[]) : null;
  if (ts == null || data == null) return { problem: "shape" };
  return {
    source: {
      kind,
      where,
      ts,
      data,
      index: parsed.index,
      perSport: (parsed.perSport ?? {}) as Record<string, { fetchedAt?: unknown }>,
      greens: (parsed.greens ?? null) as GreenHistorySummary | null,
    },
  };
}

/**
 * Read the last scan and return the same-day slice of it.
 *
 * TWO SOURCES, NEWEST WINS:
 *  1. the snapshot the scan pushed to this process (works on the published host,
 *     whose filesystem is not the scanner's), and
 *  2. any scan file reachable from here (candidateCacheFiles()).
 *
 * Never throws: a broken cache is a state the page has to be able to show.
 */
export function readInstantWins(options: ReadInstantWinsOptions = {}): InstantWinsPayload {
  const now = options.now ?? new Date();
  const greensForNoScan = options.file ? undefined : safeGreens();

  const sources: Source[] = [];
  let sawFile = false;
  let sawUnreadable = false;

  if (!options.file) {
    const remembered = readRememberedSnapshot();
    if (remembered) {
      const parsed = asSource(remembered.body?.cache, "pushed-snapshot", "pushed snapshot");
      if ("source" in parsed) {
        // The greens summary travels with the snapshot: the receiving host has
        // no greens file of its own.
        if (!parsed.source.greens) parsed.source.greens = (remembered.body?.greens ?? null) as GreenHistorySummary | null;
        sources.push(parsed.source);
      }
    }
  }

  const files = options.file ? [options.file] : candidateCacheFiles();
  for (const file of files) {
    if (!existsSync(file)) continue;
    sawFile = true;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      sawUnreadable = true;
      continue;
    }
    const parsed = asSource(raw, "scan-file", file);
    if ("source" in parsed) sources.push(parsed.source);
    else sawUnreadable = true;
  }

  if (sources.length === 0) {
    if (sawUnreadable) {
      return noScan(
        "No prices to show yet — the last list we received could not be read, so there is nothing to display. Nothing was charged for this page.",
        "unreadable",
        greensForNoScan,
      );
    }
    // An EXPLICIT path that is not there is simply "no scan yet": the caller
    // asked about one file, and it has not been written.
    if (options.file) {
      return noScan(
        "No prices to show yet — today's list has not arrived, so there is nothing to display. Nothing was charged for this page.",
        "missing",
        greensForNoScan,
      );
    }
    // NO FILE AND NO SNAPSHOT ANYWHERE. The scanner may well be healthy — on the
    // published host it almost certainly is — so do not blame it. Say what is
    // true: this server cannot see the scan.
    //
    // WRITTEN FOR A CUSTOMER (2026-11-02): the previous wording explained our
    // machinery ("the scan runs on the machine that writes its results … no scan
    // file or snapshot is reachable here"). A subscriber is not owed an account
    // of how the plumbing failed; they are owed the truth in their own terms —
    // there are no prices here yet, and it cost them nothing.
    return noScan(
      "No prices to show yet — today's list has not reached this page. Nothing was charged for this page. Check back in a few minutes.",
      "unreachable",
      greensForNoScan,
    );
  }

  // Newest wins: a fresh push beats a file left behind by an older run.
  sources.sort((a, b) => b.ts - a.ts);
  const chosen = sources[0];
  const ts = chosen.ts;
  const matches = chosen.data;

  if (ts == null || matches == null) {
    return noScan(
      "No prices to show yet — the list we received could not be read, so there is nothing to display. Nothing was charged for this page.",
      "unreadable",
      greensForNoScan,
    );
  }

  const ageMs = Math.max(0, now.getTime() - ts);
  const ageMinutes = Math.floor(ageMs / 60_000);
  const sameDay = selectSameDayMatches(matches, now);
  const sportsOf = (list: Match[]) => new Set(list.map((m) => m.sportKey).filter(Boolean)).size;

  // The free index the sweep kept: how much of today the scan knows about, even
  // for sports whose odds it has not paid for yet.
  const idx = (chosen.index ?? {}) as {
    sportsInSeason?: unknown;
    sportsWithToday?: unknown;
    totalTodayFixtures?: unknown;
  };
  const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  const sameDaySports = sportsOf(sameDay);

  // When was the OLDEST price in this list fetched? Per-sport clocks, because a
  // same-day sweep pays one credit per sport and therefore rotates. Falls back to
  // the scan timestamp for a cache written before per-sport clocks existed.
  const perSport = (chosen.perSport ?? {}) as Record<string, { fetchedAt?: unknown }>;
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
    source: chosen.kind,
    // Greens found in the last 30 days. On the scanner's own host this is read
    // from `.run/greens.jsonl`; on the published host it arrived with the pushed
    // snapshot, because that host has no history file of its own.
    greens30d: chosen.greens ?? greensForNoScan,
  };
}

/**
 * The greens history, or undefined when it cannot be read here. Never throws:
 * a missing history must not take the feed down with it.
 */
function safeGreens(): GreenHistorySummary | undefined {
  try {
    return readGreenHistory();
  } catch {
    return undefined;
  }
}

/**
 * What this process can actually see — the evidence, not a guess.
 *
 * Served to the OWNER ONLY (`GET /api/feed-diagnostics`). It exists because on
 * 2026-11-02 the published feed said "no scan data yet" while a healthy scan was
 * running, and there was no way to tell from outside which path the deployed
 * process had resolved. This answers that question in the deployed environment
 * itself.
 */
export function feedDiagnostics(now: Date = new Date()) {
  const remembered = readRememberedSnapshot();
  const files = candidateCacheFiles().map((path) => {
    const info: { path: string; exists: boolean; bytes: number | null; modifiedAt: string | null; reads: boolean } = {
      path,
      exists: existsSync(path),
      bytes: null,
      modifiedAt: null,
      reads: false,
    };
    if (info.exists) {
      try {
        const st = statSync(path);
        info.bytes = st.size;
        info.modifiedAt = new Date(st.mtimeMs).toISOString();
      } catch {
        /* keep nulls */
      }
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { ts?: unknown; data?: unknown };
        info.reads = typeof parsed?.ts === "number" && Array.isArray(parsed.data);
      } catch {
        info.reads = false;
      }
    }
    return info;
  });
  return {
    ok: true as const,
    checkedAt: now.toISOString(),
    runDir: runDir(),
    moduleDir: import.meta.dir,
    cwd: process.cwd(),
    alertsRunDirEnv: process.env.ALERTS_RUN_DIR ?? null,
    files,
    anyFileReads: files.some((f) => f.reads),
    pushedSnapshot: remembered
      ? {
          receivedAt: remembered.receivedAt,
          scanTs: (() => {
            const ts = (remembered.body?.cache as { ts?: unknown })?.ts;
            return typeof ts === "number" ? new Date(ts).toISOString() : null;
          })(),
          fixtures: Array.isArray((remembered.body?.cache as { data?: unknown })?.data)
            ? ((remembered.body?.cache as { data: unknown[] }).data.length as number)
            : 0,
        }
      : null,
    lastPush: lastPush(),
    bridge: {
      secretPresent: Boolean(bridgeSecret()),
      targets: pushTargets(),
    },
  };
}
