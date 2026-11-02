/**
 * SCAN ON OPEN — a fresh scan when somebody opens the feed and what we hold is
 * older than a few minutes.
 *
 * OWNER DIRECTIVE (2026-11-03): "Scan every 30mins and on open." The 30-minute
 * sweep is scripts/alert-loop.sh (see src/lib/cadence.ts). This module is the
 * other half: a page open that finds stale prices asks for a scan rather than
 * waiting up to half an hour for the next scheduled one.
 *
 * THE THREE RULES, and why each one exists:
 *
 *  1. SINGLE FLIGHT. Ten page opens in a minute must not start ten scans — every
 *     scan costs real provider credits (measured: 3 per scan, see
 *     .run/credits.jsonl), so a burst of traffic must cost ONE scan, not ten.
 *     Two locks do this:
 *       • an in-process promise — the common case, since one server process
 *         answers every request on a host;
 *       • a lock file in `.run/` — because the same machine can run more than one
 *         server process (the status host on ALERT_PORT and a full one on 3000),
 *         and they do not share memory.
 *     Everyone who arrives while a scan is running is told "refreshing: true" and
 *     keeps the snapshot they already have. Nobody waits for it.
 *
 *  2. NEVER HANG THE PAGE. The scan is started and NOT awaited: the request
 *     returns the snapshot we already hold, immediately, with a flag saying a
 *     refresh is under way. The page re-checks once, ~30 s later (client side).
 *
 *  3. NEVER BLANK THE PAGE. A scan that fails leaves the old snapshot exactly
 *     where it was and records the error; the feed then says the prices may have
 *     moved. There is no path here that empties what the user can see.
 *
 * The scan itself is `runAlertCheck()` — the SAME function the scheduled loop
 * runs, so an on-open scan goes through the identical pipeline: shared transform
 * and sanity rules, greens history, Telegram, and the push to the published host
 * (src/server/scan-bridge.ts). There is deliberately no second, "light" scan.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAlertCheck } from "./alerts";
import { runDir } from "./instant-wins";

/**
 * How old the newest scan may be before an open triggers a new one. Five
 * minutes: long enough that a person clicking around the dashboard does not
 * start a scan per click, short enough that prices are fresh when someone looks.
 */
export const REFRESH_AFTER_MIN = 5;

/**
 * Hard floor between two on-open attempts, whatever happens to them. This is the
 * credit guard: without it a scan that keeps FAILING would be retried by every
 * page open, and each retry is paid for. Success is already self-limiting (a
 * finished scan makes the data fresh again); failure is not.
 */
export const REFRESH_COOLDOWN_MIN = 5;

/** A lock older than this is treated as abandoned (a scan takes well under it). */
export const LOCK_TTL_MIN = 15;

const LOCK_NAME = "scan-on-open.lock";

export interface ScanOnOpenState {
  /** A scan started by a page open is running right now. */
  refreshing: boolean;
  /** When the current/last on-open scan started (ISO). */
  startedAt: string | null;
  /** When the last on-open scan attempt was made (ISO) — success or failure. */
  lastAttemptAt: string | null;
  /** When the last on-open scan finished cleanly (ISO). */
  lastFinishedAt: string | null;
  /** Why the last on-open scan failed, if it did. */
  lastError: string | null;
}

const EMPTY_STATE: ScanOnOpenState = {
  refreshing: false,
  startedAt: null,
  lastAttemptAt: null,
  lastFinishedAt: null,
  lastError: null,
};

/** The live state of the on-open path, for the owner's diagnostics endpoint. */
let state: ScanOnOpenState = { ...EMPTY_STATE };

export function scanOnOpenState(): ScanOnOpenState {
  return { ...state };
}

/** Test hook: forget the in-memory state. */
export function resetScanOnOpenState(): void {
  state = { ...EMPTY_STATE };
  inflight = null;
}

// ── The decision (pure, so it can be tested without a provider) ─────────────

export interface ScanDecisionInput {
  now: Date;
  /** ISO time of the newest scan we can see, or null when there is none. */
  newestScanAt: string | null;
  /** ISO time of the last on-open attempt, or null. */
  lastAttemptAt: string | null;
  /** A scan is already running (in this process or another). */
  refreshing: boolean;
  /** Can this host scan at all? (No odds key → it cannot, and must not claim to.) */
  canScan: boolean;
  /** Overrides for tests. */
  refreshAfterMin?: number;
  cooldownMin?: number;
}

export type ScanDecision =
  | { action: "start"; reason: string }
  | { action: "skip"; reason: string }
  | { action: "busy"; reason: string };

function minutesBetween(fromIso: string, now: Date): number | null {
  const t = new Date(fromIso).getTime();
  if (!Number.isFinite(t)) return null;
  return (now.getTime() - t) / 60_000;
}

/**
 * Start, skip, or stand aside — and say why. Pure: no clock, no disk, no network.
 *
 * Order matters. "Busy" comes first because a running scan is the answer the page
 * needs ("refreshing: true"), and because starting a second one is the one thing
 * this module exists to prevent.
 */
export function decideScanOnOpen(input: ScanDecisionInput): ScanDecision {
  const refreshAfter = input.refreshAfterMin ?? REFRESH_AFTER_MIN;
  const cooldown = input.cooldownMin ?? REFRESH_COOLDOWN_MIN;

  if (input.refreshing) {
    return { action: "busy", reason: "a scan is already running — this open reuses it" };
  }
  if (!input.canScan) {
    return { action: "skip", reason: "this server has no odds feed configured, so it cannot scan" };
  }
  if (input.lastAttemptAt) {
    const sinceAttempt = minutesBetween(input.lastAttemptAt, input.now);
    if (sinceAttempt != null && sinceAttempt < cooldown) {
      return {
        action: "skip",
        reason: `an on-open scan was started ${Math.round(sinceAttempt * 10) / 10} min ago — waiting ${cooldown} min before another`,
      };
    }
  }
  if (!input.newestScanAt) {
    return { action: "start", reason: "there is no scan to show yet" };
  }
  const age = minutesBetween(input.newestScanAt, input.now);
  if (age == null) {
    return { action: "start", reason: "the last scan's time could not be read" };
  }
  if (age <= refreshAfter) {
    return {
      action: "skip",
      reason: `the newest scan is ${Math.round(age * 10) / 10} min old — fresher than ${refreshAfter} min`,
    };
  }
  return { action: "start", reason: `the newest scan is ${Math.round(age)} min old` };
}

// ── The lock ───────────────────────────────────────────────────────────────

export function lockFile(dir: string = runDir()): string {
  return join(dir, LOCK_NAME);
}

interface LockInfo {
  pid: number;
  startedAt: string;
}

function readLock(file: string): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; startedAt?: unknown };
    const pid = typeof parsed.pid === "number" ? parsed.pid : NaN;
    const startedAt = typeof parsed.startedAt === "string" ? parsed.startedAt : "";
    if (!Number.isFinite(pid) || !startedAt) return null;
    return { pid, startedAt };
  } catch {
    return null;
  }
}

/** Is the process that wrote the lock still alive? */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is the lock abandoned? A dead PID, an unreadable file, or one older than
 * LOCK_TTL_MIN all mean "nobody is scanning" — a crashed scan must never lock the
 * feature off for good (the 4.5-day pidfile outage taught us that one).
 */
export function lockIsStale(info: LockInfo | null, now: Date, ttlMin: number = LOCK_TTL_MIN): boolean {
  if (!info) return true;
  if (!pidAlive(info.pid)) return true;
  const age = minutesBetween(info.startedAt, now);
  if (age == null) return true;
  return age > ttlMin;
}

function tryLock(dir: string, now: Date): boolean {
  const file = lockFile(dir);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* the write below will fail if it really cannot be created */
  }
  const existing = existsSync(file) ? readLock(file) : null;
  if (existsSync(file) && !lockIsStale(existing, now)) return false;
  if (existsSync(file)) {
    try {
      unlinkSync(file);
    } catch {
      /* someone else cleared it first */
    }
  }
  try {
    writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: now.toISOString() }), {
      encoding: "utf8",
      flag: "wx", // atomic create — two processes cannot both win this
    });
    return true;
  } catch {
    return false; // lost the race
  }
}

function unlock(dir: string): void {
  try {
    const file = lockFile(dir);
    const info = readLock(file);
    // Only remove OUR lock: if it timed out and another process took over, that
    // process's lock must survive this one finishing.
    if (info && info.pid === process.pid) unlinkSync(file);
  } catch {
    /* nothing to release */
  }
}

// ── The entry point ────────────────────────────────────────────────────────

/** The in-process single-flight handle. Non-null while a scan is running. */
let inflight: Promise<void> | null = null;

/** True while a scan started by a page open is running in THIS process. */
export function isRefreshing(): boolean {
  return inflight != null;
}

export interface EnsureScanOptions {
  /** "Now" — injectable for tests. */
  now?: Date;
  /** The newest scan this server can see (the payload's `scannedAt`). */
  newestScanAt: string | null;
  /** The scan itself. Defaults to the real, scheduled-loop scan. Tests stub it. */
  scan?: () => Promise<unknown>;
  /** Run directory override (tests). */
  dir?: string;
  /** Can this host scan? Defaults to "yes if an odds key is configured". */
  canScan?: boolean;
  refreshAfterMin?: number;
  cooldownMin?: number;
}

export interface EnsureScanResult {
  /** True only for the caller that actually started the scan. */
  started: boolean;
  /** True whenever a scan is running — started by this call or by somebody else. */
  refreshing: boolean;
  reason: string;
}

/**
 * Start a scan if one is due, and return immediately either way.
 *
 * The returned promise of the scan is deliberately not awaited here: the caller is
 * an HTTP request that must answer with the snapshot it already has.
 */
export function ensureScanOnOpen(options: EnsureScanOptions): EnsureScanResult {
  const now = options.now ?? new Date();
  const dir = options.dir ?? runDir();
  const canScan = options.canScan ?? true;

  if (inflight) {
    return { started: false, refreshing: true, reason: "a scan is already running in this process" };
  }

  const decision = decideScanOnOpen({
    now,
    newestScanAt: options.newestScanAt,
    lastAttemptAt: state.lastAttemptAt,
    refreshing: false, // handled above for this process; the file lock covers others
    canScan,
    refreshAfterMin: options.refreshAfterMin,
    cooldownMin: options.cooldownMin,
  });

  if (decision.action !== "start") {
    // Another PROCESS may be scanning — report that honestly rather than "idle".
    if (decision.action === "skip" && existsSync(lockFile(dir))) {
      const info = readLock(lockFile(dir));
      if (!lockIsStale(info, now)) {
        return { started: false, refreshing: true, reason: "another process is scanning" };
      }
    }
    return { started: false, refreshing: false, reason: decision.reason };
  }

  if (!tryLock(dir, now)) {
    return { started: false, refreshing: true, reason: "another process is scanning" };
  }

  const scan = options.scan ?? (() => runAlertCheck());
  state = {
    ...state,
    refreshing: true,
    startedAt: now.toISOString(),
    lastAttemptAt: now.toISOString(),
  };

  inflight = Promise.resolve()
    .then(scan)
    .then(
      () => {
        state = { ...state, refreshing: false, lastFinishedAt: new Date().toISOString(), lastError: null };
      },
      (e: unknown) => {
        // A failed scan is a STATE. The snapshot the user has stays exactly as it
        // is — the feed says the prices may have moved, and the next attempt waits
        // for the cooldown so a broken scan cannot be paid for on every open.
        state = {
          ...state,
          refreshing: false,
          lastError: e instanceof Error ? e.message : String(e),
        };
      },
    )
    .finally(() => {
      inflight = null;
      unlock(dir);
    });

  return { started: true, refreshing: true, reason: decision.reason };
}

/**
 * Wait for any in-flight scan to finish. Only used by tests and by the CLI — the
 * HTTP path must never await this.
 */
export function awaitInflight(): Promise<void> {
  return inflight ?? Promise.resolve();
}
