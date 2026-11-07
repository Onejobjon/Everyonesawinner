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
 *     This used to be two locks: an in-process promise here plus a private
 *     `scan-on-open.lock`. That was NOT enough, because the scheduled loop
 *     (`alerts.ts --once`) and the in-process worker did not take either of them,
 *     so a scheduled tick could run beside a page-open scan — two sweeps, two
 *     credit spends, two sets of alerts. Since 2026-11-06 every entry point takes
 *     the ONE shared atomic lock in src/server/scan-lock.ts (`tryStartScan`), and
 *     the in-process promise below is only a fast path for reporting "refreshing".
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
import { existsSync } from "node:fs";
import { runAlertCheckBody } from "./alerts";
import { runDir } from "./instant-wins";
import {
  SCAN_LOCK_TTL_MIN,
  readScanLock,
  scanLockFile,
  scanLockIsStale,
  tryStartScan,
  type ScanLockInfo,
} from "./scan-lock";

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

/**
 * The lock lives in src/server/scan-lock.ts now, shared with the scheduled loop
 * and the in-process worker — that sharing IS the fix for the 2026-11-06
 * overlapping-scan defect. Re-exported here because this module's tests and the
 * owner's diagnostics reach for these names.
 */
export const LOCK_TTL_MIN = SCAN_LOCK_TTL_MIN;
export { scanLockIsStale as lockIsStale };
export { scanLockFile as lockFile };
export type { ScanLockInfo };

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
// The primitives (atomic create, stale detection, TTL, release-only-if-ours)
// live in src/server/scan-lock.ts so the scheduled loop uses the SAME lock. They
// are re-exported at the top of this file under their old names.

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
    refreshing: false, // handled above for this process; the shared lock covers everyone else
    canScan,
    refreshAfterMin: options.refreshAfterMin,
    cooldownMin: options.cooldownMin,
  });

  if (decision.action !== "start") {
    // Another PROCESS may be scanning — report that honestly rather than "idle".
    if (decision.action === "skip" && existsSync(scanLockFile(dir))) {
      const info = readScanLock(scanLockFile(dir));
      if (!scanLockIsStale(info, now)) {
        return { started: false, refreshing: true, reason: "another process is scanning" };
      }
    }
    return { started: false, refreshing: false, reason: decision.reason };
  }

  const scan = options.scan ?? (() => runAlertCheckBody());

  // THE GUARD. Same lock file as the scheduled loop and the in-process worker, so
  // a page open can never run beside a scheduled tick. Losing the race is normal:
  // we report "refreshing" and keep the snapshot we already have.
  const flight = tryStartScan({
    owner: "on-open",
    dir,
    now,
    scan,
    log: (msg) => console.log(`[alerts ${new Date().toISOString()}] ${msg}`),
  });

  if (!flight.started) {
    return { started: false, refreshing: true, reason: flight.reason };
  }

  state = {
    ...state,
    refreshing: true,
    startedAt: now.toISOString(),
    lastAttemptAt: now.toISOString(),
  };

  inflight = flight.done
    .then((outcome) => {
      if (outcome.status === "failed") {
        // A failed scan is a STATE. The snapshot the user has stays exactly as it
        // is — the feed says the prices may have moved, and the next attempt waits
        // for the cooldown so a broken scan cannot be paid for on every open.
        state = { ...state, refreshing: false, lastError: outcome.error };
      } else {
        state = { ...state, refreshing: false, lastFinishedAt: new Date().toISOString(), lastError: null };
      }
    })
    .then(() => {
      inflight = null;
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
