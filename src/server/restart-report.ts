/**
 * RESTART REPORT — the one message the owner gets when the machine comes back
 * from being off.
 *
 * WHY THIS EXISTS (owner, 2026-11-06): "no Telegram updates, again coincides
 * with cto credits running out, no stall alerts or anything." The machine was
 * replaced on 2026-11-06 at 14:33 UTC after being down since about 2026-11-04
 * 11:00 — roughly two days of total silence. Every piece of machinery that
 * reports trouble (scripts/alert-gap-alarm.ts, scripts/alert-keepalive.sh)
 * runs ON this machine. A machine that is off cannot report its own death, so
 * the owner got nothing: not an error, not an alarm, just silence that looked
 * exactly like a quiet market.
 *
 * THE HONEST LIMIT, STATED IN THE CODE AND IN THE MESSAGE: no alarm that runs
 * here can fire while this machine is off. There are only two things this
 * repo can do about that, and it now does both:
 *   1. report the outage the moment the machine comes back (this module), and
 *   2. send a daily heartbeat at 09:00 Europe/London (src/server/heartbeat.ts)
 *      so that the ABSENCE of a message is itself the alarm — a human notices
 *      a missing message even when no process here is alive to send one.
 * A genuinely external dead-man's switch (a scheduled check that lives
 * somewhere other than this box) is the real fix and is not something this
 * repo can provide on its own; see the note in scripts/alert-heartbeat.ts.
 *
 * THE RULE:
 *   • last completed scan less than 45 minutes old → say NOTHING. A routine
 *     restart (a deploy, a crashed loop, a reboot that lands mid-cadence) must
 *     stay quiet, or the message becomes noise and stops being read.
 *   • last completed scan older than 45 minutes → ONE message, once per gap.
 *     The gap's identity is the last scan's timestamp, so two restarts during
 *     the same outage cannot produce two messages.
 *
 * 45 minutes = 1.5 scan cycles (src/lib/cadence.ts, SCAN_INTERVAL_MIN = 30), so
 * a single missed cycle alone does not trigger it — the same reasoning as the
 * 75-minute stall alarm, but tighter here because a restart is a known event:
 * by the time the loop is running again, anything older than a cycle and a half
 * genuinely did not scan.
 *
 * Pure functions only — no file system, no network — so the threshold and the
 * wording can be proven in tests. The runner is scripts/alert-restart-report.ts.
 */
import { londonTimeLabel } from "../lib/london-day";
import { SCAN_INTERVAL_MIN } from "../lib/cadence";
import { scanStampLabel } from "./gap-alarm";

/**
 * How stale the last completed scan must be, at the moment the scan loop
 * starts, before the restart is reported. 1.5 scan cycles — see the header.
 */
export const RESTART_GAP_MIN = Math.round(SCAN_INTERVAL_MIN * 1.5);

/** "2 days 3 hours" / "47 minutes" / "under a minute". */
export function formatGap(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 1) return "under a minute";
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  // Minutes are only worth printing inside the first day: "2 days 3 hours" is a
  // length a person can hold in their head, "2 days 3 hours 17 minutes" is not.
  if (!days && mins) parts.push(`${mins} minute${mins === 1 ? "" : "s"}`);
  return parts.join(" ");
}

export interface Coverage {
  /** Sports with at least one fixture inside the 26-hour scan window, or null. */
  sports: number | null;
  /** Fixtures inside the 26-hour window, or null. */
  fixtures: number | null;
}

export interface RestartReportInput {
  /** "Now" — injectable for tests. */
  now: Date;
  /** ISO time of the last COMPLETED scan, or null when none is on record. */
  lastScanAt: string | null;
  /** When this scan loop started (ISO), or null when it is not known. */
  restartAt: string | null;
  /** Green-cash opportunities found since the restart, or null when unreadable. */
  foundSinceRestart: number | null;
  /** Sports/fixtures in the 26-hour window, from the surviving index file. */
  coverage: Coverage;
  /** When the stall alarm itself last ran (ISO), or null when there is no record. */
  stallAlarmLastRunAt: string | null;
  /** The gap already announced (state from disk), or null. */
  reportedFor: string | null;
  /** Override for tests. */
  thresholdMin?: number;
}

export type RestartReportDecision =
  | { action: "none"; reason: string }
  | {
      action: "report";
      /** Identity of this gap — the last scan's timestamp, or "none". */
      gapKey: string;
      /** Length of the silence in minutes, or null when the last scan is unknown. */
      gapMinutes: number | null;
      message: string;
    };

function coverageLine(coverage: Coverage): string {
  if (coverage.sports == null || coverage.fixtures == null) {
    return "Coverage: unknown (no coverage index on record).";
  }
  return `Coverage now: ${coverage.sports} sport${coverage.sports === 1 ? "" : "s"} / ${coverage.fixtures} fixture${coverage.fixtures === 1 ? "" : "s"} in the next 26 hours.`;
}

function foundLine(found: number | null): string {
  if (found == null) return "Since the restart: opportunities found — not recorded yet.";
  if (found === 0) return "Since the restart: 0 green-cash opportunities found so far.";
  return `Since the restart: ${found} green-cash opportunit${found === 1 ? "y" : "ies"} found.`;
}

/**
 * The message itself. Every number in it is either passed in from a state file
 * or replaced by the word "unknown" — this function never guesses a figure, and
 * it never claims the scanner was working when the record says it was not.
 */
export function buildRestartMessage(input: {
  now: Date;
  lastScanAt: string | null;
  restartAt: string | null;
  gapMinutes: number | null;
  foundSinceRestart: number | null;
  coverage: Coverage;
  stallAlarmLastRunAt: string | null;
}): string {
  const gapWords =
    input.gapMinutes == null ? "an unknown length of time" : formatGap(input.gapMinutes);
  const restartWords = input.restartAt ? scanStampLabel(input.restartAt, input.now) : null;

  const when = input.lastScanAt
    ? `The last completed scan was ${scanStampLabel(input.lastScanAt, input.now)}.`
    : "There is no completed scan on record at all.";

  const alarm =
    input.stallAlarmLastRunAt != null
      ? `Stall alarm last ran: ${scanStampLabel(input.stallAlarmLastRunAt, input.now)}.`
      : "Stall alarm last ran: unknown — no record of the watchdog running.";

  return (
    `⚠️ Everyone's A Winner — the scanner is back, after ${gapWords} of silence.\n\n` +
    `Nothing scanned and no opportunity alert went out in that time. ${when}` +
    (restartWords ? ` This machine restarted at ${restartWords}.` : "") +
    `\n\n` +
    `${foundLine(input.foundSinceRestart)}\n` +
    `${coverageLine(input.coverage)}\n` +
    `${alarm}\n\n` +
    `Why you are reading this: the stall alarm runs on this machine, and a machine that is off ` +
    `cannot report its own death — so the gap is reported when the machine comes back. The 09:00 ` +
    `daily heartbeat is what catches a silence that never ends. A check running outside this ` +
    `machine would be the real fix.`
  );
}

/**
 * Decide whether this restart is worth a message.
 *
 * Once per gap: `reportedFor` is the identity of the gap already announced (the
 * last scan's timestamp), so the report survives a supervisor that restarts the
 * loop twice in a minute without saying the same thing twice.
 */
export function decideRestartReport(input: RestartReportInput): RestartReportDecision {
  const threshold = input.thresholdMin ?? RESTART_GAP_MIN;
  const nowMs = input.now.getTime();

  const lastMs = input.lastScanAt ? new Date(input.lastScanAt).getTime() : NaN;
  const hasScan = Number.isFinite(lastMs);
  const gapMinutes = hasScan ? Math.max(0, (nowMs - lastMs) / 60_000) : null;

  // A routine restart: the previous scan is recent, so the machine was never
  // meaningfully silent. Say nothing — this is the common case and it must be
  // silent, or the message teaches its reader to ignore it.
  if (gapMinutes != null && gapMinutes < threshold) {
    return {
      action: "none",
      reason: `last scan ${Math.round(gapMinutes)} min ago — under the ${threshold} min gap threshold`,
    };
  }

  // No scan on record: we cannot measure the silence, but "no record" is itself
  // worth exactly one message (never a stream of them — the key is stable).
  const gapKey = hasScan ? new Date(lastMs).toISOString() : "none";
  if (input.reportedFor === gapKey) {
    return { action: "none", reason: "this gap has already been reported — staying quiet" };
  }

  return {
    action: "report",
    gapKey,
    gapMinutes,
    message: buildRestartMessage({
      now: input.now,
      lastScanAt: input.lastScanAt,
      restartAt: input.restartAt,
      gapMinutes,
      foundSinceRestart: input.foundSinceRestart,
      coverage: input.coverage,
      stallAlarmLastRunAt: input.stallAlarmLastRunAt,
    }),
  };
}

/** "09:42 on Wed 4 Nov" — exported for the log line the runner writes. */
export function stampLabel(iso: string, now: Date): string {
  return scanStampLabel(iso, now);
}

/** "10:45" — London clock time of an ISO instant, or null. */
export function clockLabel(iso: string): string | null {
  return londonTimeLabel(iso);
}
