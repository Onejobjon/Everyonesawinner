/**
 * GAP ALARM — one Telegram message when the scanner stalls.
 *
 * WHY: on 2026-10-28 the machine was replaced and the alert loop never came back.
 * For four and a half days nothing scanned and nothing said so — the owner found
 * out by noticing the site was quiet. A worker that cannot report its own death
 * needs something outside it to notice, which is what this is: a small check that
 * runs from the supervisor AND from the dev-server boot hook, so a dead scan loop
 * cannot silence it.
 *
 * THE RULES (owner's instruction, 2026-10-28):
 *   • no scan completed for longer than a normal cycle allows → ONE message;
 *   • one message PER STALL — not one every scan, and no heartbeat when things
 *     are fine. Silence is the healthy state.
 *
 * THE THRESHOLD FOLLOWS THE CADENCE (2026-11-03): the sweep now runs every 30
 * minutes (src/lib/cadence.ts), so the old 25-minute threshold would have fired on
 * every healthy cycle — an alarm that cries wolf on a working system is worse than
 * no alarm. It is now STALL_ALARM_MIN (75 min = two and a half cycles), imported
 * rather than typed here so the two can never drift apart again.
 *
 * The decision is a pure function so the "once per stall" behaviour can be tested
 * without sending anything: see test/gap-alarm.test.ts.
 */
import { londonDayKey, londonTimeLabel } from "../lib/london-day";
import { SCAN_INTERVAL_MIN, STALL_ALARM_MIN } from "../lib/cadence";

/** Minutes without a completed scan before we say something. */
export const GAP_ALARM_MIN = STALL_ALARM_MIN;

export interface GapAlarmInput {
  /** "Now" — injectable for tests. */
  now: Date;
  /** ISO time of the last COMPLETED scan, or null when none has ever completed. */
  lastScanAt: string | null;
  /** Machine uptime in ms (from /proc/uptime), or null when unknown. */
  uptimeMs: number | null;
  /** The stall already announced (state from disk), or null. */
  announcedFor: string | null;
  /** Override for tests. */
  thresholdMin?: number;
}

export type GapAlarmDecision =
  | { action: "none"; reason: string }
  | { action: "clear"; reason: string }
  | {
      action: "alert";
      /** Identity of this stall — the last scan's timestamp, or "none". */
      stallKey: string;
      /** How long the scanner has been silent, in minutes. */
      gapMinutes: number;
      message: string;
    };

/** "11:15 today" / "09:40 on Sat 1 Nov" — when the last scan finished. */
export function scanStampLabel(iso: string, now: Date): string {
  const time = londonTimeLabel(iso);
  const day = londonDayKey(iso);
  const today = londonDayKey(now);
  if (!time || !day) return iso;
  if (day === today) return `${time} today`;
  const [y, m, d] = day.split("-").map((n) => Number(n));
  const label = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
  return `${time} on ${label}`;
}

function minutes(n: number): string {
  const whole = Math.round(n);
  if (whole < 60) return `${whole} minute${whole === 1 ? "" : "s"}`;
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  return `${h} hour${h === 1 ? "" : "s"}${m ? ` ${m} minute${m === 1 ? "" : "s"}` : ""}`;
}

/**
 * Decide whether to shout, and shout only once per stall.
 *
 * `clear` is returned the moment a scan lands again, so the NEXT stall gets its
 * own message. That is the whole state machine: announcedFor is either the
 * current stall's key or null.
 */
export function decideGapAlarm(input: GapAlarmInput): GapAlarmDecision {
  const threshold = input.thresholdMin ?? GAP_ALARM_MIN;
  const nowMs = input.now.getTime();

  // A machine that has only just booted has not had time to miss a scan. Without
  // this, every restart would page the owner before the worker had its first turn.
  if (input.uptimeMs != null && input.uptimeMs < threshold * 60_000) {
    return {
      action: "none",
      reason: `machine up only ${Math.round(input.uptimeMs / 60_000)} min — shorter than the ${threshold} min window`,
    };
  }

  const lastMs = input.lastScanAt ? new Date(input.lastScanAt).getTime() : NaN;
  const hasScan = Number.isFinite(lastMs);
  // No scan ever: measure the silence from boot, which is the only clock we have.
  const gapMinutes = hasScan
    ? Math.max(0, (nowMs - lastMs) / 60_000)
    : input.uptimeMs != null
      ? input.uptimeMs / 60_000
      : Infinity;

  if (gapMinutes < threshold) {
    return input.announcedFor == null
      ? { action: "none", reason: `last scan ${Math.round(gapMinutes)} min ago — within the window` }
      : { action: "clear", reason: "a scan has completed since the last stall — resetting the alarm" };
  }

  const stallKey = hasScan ? new Date(lastMs).toISOString() : "none";
  if (input.announcedFor === stallKey) {
    return { action: "none", reason: "this stall has already been announced — staying quiet" };
  }

  const since = hasScan
    ? `no scan has completed since ${scanStampLabel(stallKey, input.now)}`
    : `no scan has completed since this machine started`;
  const howLong = Number.isFinite(gapMinutes) ? `${minutes(gapMinutes)} ago` : "an unknown time ago";

  const message =
    `⚠️ Everyone's A Winner — the odds scanner has stalled.\n` +
    `It has been ${howLong} (${since}). Scans normally run every ${SCAN_INTERVAL_MIN} minutes, so ` +
    `${threshold} minutes of silence means the worker is down or wedged.\n` +
    `Nothing needs doing: the supervisor restarts it automatically, and you will get ` +
    `one more message only if it stalls again after recovering. This is the only ` +
    `message for this stall.`;

  return { action: "alert", stallKey, gapMinutes, message };
}
