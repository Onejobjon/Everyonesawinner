/**
 * ONE SCAN AT A TIME — the single-flight guard that every scan entry point shares.
 *
 * THE DEFECT THIS CLOSES (2026-11-06)
 * -----------------------------------
 * A scan can be started from three places:
 *
 *   1. the scheduled loop — scripts/alert-loop.sh → `bun src/server/alerts.ts --once`
 *   2. the in-process worker — startAlertWorker() in the serving process
 *   3. a page open — /api/instant-wins → ensureScanOnOpen()
 *
 * (2) and (3) shared an in-process promise plus `scan-on-open.lock`; (1) had no
 * guard at all and (2) was a plain `setInterval`. So a scheduled tick that fired
 * while a page-open scan was running started a SECOND scan: two concurrent
 * `getMatches()` sweeps, i.e. the odds provider paid twice for the same fixtures,
 * and two `deliver()` loops over the same opportunities, i.e. the owner could be
 * alerted twice for one green.
 *
 * THE RULE NOW
 * ------------
 * Every scan, whoever asks for it, goes through `tryStartScan()`. It takes ONE
 * atomic lock (`<run dir>/scan.lock`, created with O_EXCL via `flag: "wx"` — the
 * kernel decides the winner, not a read-then-write race). The loser does NOT
 * fetch, does NOT deliver, and logs exactly one line:
 *
 *     [alerts …] skipped: scan already in flight (owner=scheduled pid=…)
 *
 * A lock is abandoned when EITHER of these is true, so a killed scan can never
 * wedge the worker for good:
 *
 *   • the pid that wrote it is dead (checked with kill(pid, 0)) — this is the
 *     normal case, because the loop's scan is its own short-lived process and a
 *     crashed serving process dies with its lock;
 *   • it is older than SCAN_LOCK_TTL_MIN (20 minutes).
 *
 * WHY 20 MINUTES. Measured on this machine (.run/alerts.log, 137 completed
 * scans): a normal scan is 25–40 s, and the slowest ever recorded is 286 s
 * (4.8 min — a cold sports index plus a full 24-sport sweep). 20 minutes is
 * ~4× that worst case, so a genuinely slow scan is never preempted and no two
 * scans can ever overlap; and a lock orphaned by a process that somehow stayed
 * alive would still clear inside one 30-minute cadence tick. The dead-pid check
 * means the common case recovers instantly rather than after 20 minutes.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "./run-dir";

/** The one lock file. Sits beside the worker's other state in `.run/`. */
export const SCAN_LOCK_NAME = "scan.lock";

/**
 * How long a lock may live before it is treated as abandoned. See the header:
 * 4× the slowest scan ever measured (286 s), and well inside one cadence tick.
 */
export const SCAN_LOCK_TTL_MIN = 20;

/** The exact phrase the skip line must contain — asserted by the tests. */
export const SCAN_IN_FLIGHT = "scan already in flight";

export interface ScanLockInfo {
  /** Process that holds the lock. */
  pid: number;
  /** When it took the lock (ISO). */
  startedAt: string;
  /** Which entry point took it: "scheduled" | "on-open" | anything else. */
  owner: string;
}

export function scanLockFile(dir: string = runDir()): string {
  return join(dir, SCAN_LOCK_NAME);
}

/** Read the lock, or null when it is absent/unreadable/half-written. */
export function readScanLock(file: string): ScanLockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      pid?: unknown;
      startedAt?: unknown;
      owner?: unknown;
    };
    const pid = typeof parsed.pid === "number" ? parsed.pid : NaN;
    const startedAt = typeof parsed.startedAt === "string" ? parsed.startedAt : "";
    if (!Number.isFinite(pid) || !startedAt) return null;
    const owner = typeof parsed.owner === "string" ? parsed.owner : "unknown";
    return { pid, startedAt, owner };
  } catch {
    return null;
  }
}

/** Is the process that wrote the lock still alive? */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function minutesBetween(fromIso: string, now: Date): number | null {
  const t = new Date(fromIso).getTime();
  if (!Number.isFinite(t)) return null;
  return (now.getTime() - t) / 60_000;
}

/**
 * Is the lock abandoned? A dead pid, an unreadable file, or one older than the
 * TTL all mean "nobody is scanning" — a crashed scan must never lock the worker
 * off for good (the 4.5-day pidfile outage taught us that one).
 */
export function scanLockIsStale(
  info: ScanLockInfo | null,
  now: Date,
  ttlMin: number = SCAN_LOCK_TTL_MIN,
): boolean {
  if (!info) return true;
  if (!pidAlive(info.pid)) return true;
  const age = minutesBetween(info.startedAt, now);
  if (age == null) return true;
  return age > ttlMin;
}

export interface AcquireOptions {
  /** Run directory override (tests). */
  dir?: string;
  /** "Now" — injectable for tests. */
  now?: Date;
  /** Which entry point is asking ("scheduled", "on-open", …). */
  owner?: string;
  /** The pid to record. Overridable so a test can simulate another process. */
  pid?: number;
  /** TTL override (tests only). */
  ttlMin?: number;
}

export type AcquireResult =
  | { ok: true; file: string; info: ScanLockInfo }
  | { ok: false; file: string; holder: ScanLockInfo | null; reason: string };

/**
 * Take the scan lock, atomically, or report who has it.
 *
 * The stale path is deliberately careful: we read the lock, decide it is
 * abandoned, unlink it, then CREATE with `wx`. Two processes doing that at once
 * both unlink (one may lose) and exactly one wins the exclusive create, so the
 * guard cannot be defeated by the cleanup itself.
 */
export function acquireScanLock(options: AcquireOptions = {}): AcquireResult {
  const dir = options.dir ?? runDir();
  const now = options.now ?? new Date();
  const owner = options.owner ?? "unknown";
  const pid = options.pid ?? process.pid;
  const file = scanLockFile(dir);

  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* the write below fails if it really cannot be created */
  }

  const existing = existsSync(file) ? readScanLock(file) : null;
  if (existsSync(file)) {
    if (!scanLockIsStale(existing, now, options.ttlMin)) {
      return { ok: false, file, holder: existing, reason: SCAN_IN_FLIGHT };
    }
    try {
      unlinkSync(file);
    } catch {
      /* another process cleared the abandoned lock first — fine */
    }
  }

  const info: ScanLockInfo = { pid, startedAt: now.toISOString(), owner };
  try {
    writeFileSync(file, JSON.stringify(info), { encoding: "utf8", flag: "wx" });
  } catch {
    // Lost the race: somebody created the lock between our unlink and our create.
    return { ok: false, file, holder: readScanLock(file), reason: SCAN_IN_FLIGHT };
  }
  return { ok: true, file, info };
}

/**
 * Release the lock — but only if it is still OURS. A lock that timed out and was
 * taken over by another process must survive this one finishing.
 */
export function releaseScanLock(file: string, pid: number = process.pid): boolean {
  try {
    const info = readScanLock(file);
    if (info && info.pid === pid) {
      unlinkSync(file);
      return true;
    }
  } catch {
    /* nothing to release */
  }
  return false;
}

/** Human-readable holder, for the one skip line. */
function describeHolder(holder: ScanLockInfo | null): string {
  if (!holder) return "holder unreadable";
  return `owner=${holder.owner} pid=${holder.pid} since ${holder.startedAt}`;
}

// ── The single flight ──────────────────────────────────────────────────────

export interface StartScanOptions<T> {
  /** Which entry point is asking: "scheduled" | "on-open" | … */
  owner: string;
  /** The work. Only ever called by the caller that wins the lock. */
  scan: () => Promise<T>;
  dir?: string;
  now?: Date;
  pid?: number;
  ttlMin?: number;
  /** Where the skip/finish lines go. Defaults to a timestamped console line. */
  log?: (msg: string) => void;
}

/**
 * How a scan attempt ended. A discriminated union rather than "value or null",
 * because the three endings need three different reactions from the caller:
 * a skipped scan is normal (no fetch, no alerts, no failure), while a failed one
 * must still make `alerts.ts --once` exit non-zero so the loop retries in 15 s
 * instead of sleeping 30 minutes on a broken scan.
 */
export type ScanOutcome<T> =
  | { status: "started"; value: T }
  | { status: "failed"; error: string }
  | { status: "skipped"; reason: string };

export interface StartedScan<T> {
  /** True only for the caller that actually runs the scan. */
  started: boolean;
  /** "started: …" or "skipped: scan already in flight (…)". */
  reason: string;
  /**
   * Settles when the scan finishes. Never rejects — a fire-and-forget caller
   * (the page-open path) must not leak an unhandled rejection.
   */
  done: Promise<ScanOutcome<T>>;
}

/**
 * Run `scan` if and only if no other scan is in flight — across processes.
 *
 * This is the ONLY way a scan should be started. The scheduled loop, the
 * in-process worker and the page-open path all come through here, which is what
 * makes the guard complete rather than per-path.
 */
export function tryStartScan<T>(options: StartScanOptions<T>): StartedScan<T> {
  const log = options.log ?? ((msg: string) => console.log(`[scan-lock] ${msg}`));
  const now = options.now ?? new Date();

  const lock = acquireScanLock({
    dir: options.dir,
    now,
    owner: options.owner,
    pid: options.pid,
    ttlMin: options.ttlMin,
  });

  if (!lock.ok) {
    // ONE line, saying it was skipped and why. No fetch, no alerts.
    const reason = `skipped: ${SCAN_IN_FLIGHT} (${describeHolder(lock.holder)}) — ${options.owner} did not fetch`;
    log(reason);
    return { started: false, reason, done: Promise.resolve<ScanOutcome<T>>({ status: "skipped", reason }) };
  }

  const file = lock.file;
  const startedAt = Date.now();
  const done: Promise<ScanOutcome<T>> = Promise.resolve()
    .then(options.scan)
    .then(
      (value): ScanOutcome<T> => ({ status: "started", value }),
      (e: unknown): ScanOutcome<T> => {
        const error = e instanceof Error ? e.message : String(e);
        log(`scan failed (${options.owner}): ${error}`);
        return { status: "failed", error };
      },
    )
    .finally(() => {
      releaseScanLock(file, lock.info.pid);
      const took = Math.round((Date.now() - startedAt) / 1000);
      log(`scan released the lock (${options.owner}, ${took}s)`);
    });

  return { started: true, reason: `started: ${options.owner} holds the scan lock`, done };
}
