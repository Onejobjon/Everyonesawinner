/**
 * DAILY HEARTBEAT — one scheduled "still alive" message a day, so that NOT
 * receiving it means something.
 *
 * WHY (owner, 2026-11-06): the machine was off from about 2026-11-04 11:00 until
 * 2026-11-06 14:33 and the owner heard nothing at all — no stall alarm, no
 * error, no update. Everything that could have said "I am not scanning" lives
 * on this machine, and this machine was not running.
 *
 * AN ALARM THAT RUNS HERE CANNOT FIRE WHILE THIS MACHINE IS OFF. That is not a
 * bug to fix inside the repo, it is physics: no process on a powered-down box
 * executes. There are only two honest responses, and the repo now has both:
 *   1. src/server/restart-report.ts — report the outage, with its length, the
 *      moment the machine comes back;
 *   2. this file — send one message at a fixed UK time every day, so a day with
 *      no message is itself the alarm. The reader supplies the "external" half:
 *      they notice the silence, and the machine does not have to be alive for
 *      that to work.
 * The real fix is a check that runs somewhere other than this machine (an
 * external dead-man's switch / cron service that pings a URL we expose and
 * alerts when the ping stops). That is infrastructure we do not have here, so
 * it is deliberately not faked — see scripts/alert-heartbeat.ts.
 *
 * THE RULES:
 *   • 09:00 Europe/London, computed with Intl on the IANA zone — NOT a UTC hour
 *     and NOT a fixed offset. The machine's clock is UTC, and the UK moves
 *     between GMT and BST; a `09:00` that was really `08:00` for half the year
 *     would be a heartbeat that arrives at a different time than the owner was
 *     told to expect.
 *   • At most ONE per London day. The guard is the day key written to disk, so
 *     it survives the supervisor restarting the loop, the machine rebooting,
 *     and the process being killed mid-send. A 20-hour minimum spacing sits
 *     under the day key as a second line of defence for a clock that moves
 *     backwards.
 *   • Never twice: state is written only after Telegram confirms delivery, and
 *     the day key makes a re-run inside the same day a no-op.
 *   • If no scan has completed in the last hour the message still goes out —
 *     because the absence of a message is the alarm — but it is NOT dressed up
 *     as a healthy check-in: it says plainly that nothing is scanning. A
 *     heartbeat that claims health it cannot see is worse than no heartbeat.
 *
 * Pure functions only — no file system, no network — so the schedule, the
 * once-a-day guard and the wording can all be proven in tests. The runner is
 * scripts/alert-heartbeat.ts.
 */
import { londonDayKey, londonHour } from "../lib/london-day";
import { formatGap } from "./restart-report";
import { scanStampLabel } from "./gap-alarm";

/** The London hour the heartbeat goes out at. */
export const HEARTBEAT_LOCAL_HOUR = 9;

/**
 * Minimum spacing between two heartbeats, in hours. The day key already allows
 * only one per London day; this catches the case where the clock is set back a
 * day (or a restore replays yesterday's state) so the same "day" cannot fire
 * twice from our side.
 */
export const HEARTBEAT_MIN_GAP_HOURS = 20;

/**
 * How old the last completed scan may be before the heartbeat stops claiming
 * health. One hour = two scan cycles at the 30-minute cadence.
 */
export const STALE_SCAN_MIN = 60;

export interface HeartbeatInput {
  /** "Now" — injectable for tests. */
  now: Date;
  /** London day key of the last heartbeat that was actually delivered, or null. */
  lastSentDayKey: string | null;
  /** When that heartbeat was delivered (ISO), or null. */
  lastSentAt: string | null;
  /** ISO time of the last COMPLETED scan, or null when none is on record. */
  lastScanAt: string | null;
  /** Sports/fixtures in the 26-hour window, or null when unreadable. */
  coverage: { sports: number | null; fixtures: number | null };
  /** Odds-API credits the vendor last reported, or null when unknown. */
  creditsRemaining: number | null;
  /** How many opportunities the last completed scan alerted, or null. */
  lastScanAlerted: number | null;
  /** Override for tests. */
  staleMin?: number;
}

export type HeartbeatDecision =
  | { action: "none"; reason: string }
  | {
      action: "send";
      /** London day key this message belongs to — the once-a-day guard. */
      dayKey: string;
      /** false when the scanner is stale: the message says so instead of pretending. */
      healthy: boolean;
      message: string;
    };

function creditsLine(credits: number | null, healthy: boolean): string {
  if (credits == null) return "Odds credits remaining: unknown (the vendor has not reported a figure).";
  return healthy
    ? `Odds credits remaining: ${credits}.`
    : `Odds credits remaining: ${credits} (as of the last completed scan).`;
}

function coverageLine(coverage: { sports: number | null; fixtures: number | null }, healthy: boolean): string {
  if (coverage.sports == null || coverage.fixtures == null) {
    return "Coverage: unknown (no coverage index on record).";
  }
  const lead = healthy ? "Coverage" : "Coverage last known";
  return `${lead}: ${coverage.sports} sport${coverage.sports === 1 ? "" : "s"} / ${coverage.fixtures} fixture${coverage.fixtures === 1 ? "" : "s"} in the 26-hour window.`;
}

function alertedLine(alerted: number | null): string {
  if (alerted == null) return "Last scan alerted: not recorded.";
  if (alerted === 0) return "Last scan alerted: nothing.";
  return `Last scan alerted: ${alerted} opportunit${alerted === 1 ? "y" : "ies"}.`;
}

/** The healthy heartbeat. */
export function buildHeartbeatMessage(input: {
  now: Date;
  lastScanAt: string;
  scanAgeMin: number;
  coverage: { sports: number | null; fixtures: number | null };
  creditsRemaining: number | null;
  lastScanAlerted: number | null;
}): string {
  return (
    `✅ Everyone's A Winner — daily heartbeat, 09:00 London.\n\n` +
    `Last scan: ${formatGap(input.scanAgeMin)} ago (${scanStampLabel(input.lastScanAt, input.now)}).\n` +
    `${coverageLine(input.coverage, true)}\n` +
    `${creditsLine(input.creditsRemaining, true)}\n` +
    `${alertedLine(input.lastScanAlerted)}\n\n` +
    `This is the one message that proves the scanner is alive. If it stops arriving, assume nothing ` +
    `is scanning: the stall alarm runs on this machine and cannot speak while the machine is off, so ` +
    `a missing heartbeat is the alarm.`
  );
}

/**
 * The stale variant — sent instead of a heartbeat, never as one. It opens by
 * saying it is not a healthy check-in, because the whole point of a daily
 * message is that a reader can trust what it means.
 */
export function buildStaleMessage(input: {
  now: Date;
  lastScanAt: string | null;
  scanAgeMin: number | null;
  coverage: { sports: number | null; fixtures: number | null };
  creditsRemaining: number | null;
  lastScanAlerted: number | null;
}): string {
  const since = input.lastScanAt
    ? `since ${scanStampLabel(input.lastScanAt, input.now)}` +
      (input.scanAgeMin != null ? ` (${formatGap(input.scanAgeMin)} ago)` : "")
    : `at all — there is no completed scan on record`;

  return (
    `⚠️ Everyone's A Winner — no heartbeat today, because the scanner has not completed a scan ${since}.\n\n` +
    `That is not a healthy check-in: with no completed scan, nothing has been compared and no ` +
    `opportunity alerts have gone out.\n` +
    `${coverageLine(input.coverage, false)}\n` +
    `${creditsLine(input.creditsRemaining, false)}\n` +
    `${alertedLine(input.lastScanAlerted)}\n\n` +
    `The stall alarm runs on this machine and cannot speak while the machine is off. A check running ` +
    `outside this machine would be the real fix.`
  );
}

/**
 * Decide whether to send today's heartbeat.
 *
 * Order matters: the day key and the 20-hour spacing are checked BEFORE the
 * 09:00 hour, so a restart at 14:00 cannot produce a second message for a day
 * that has already had one.
 */
export function decideHeartbeat(input: HeartbeatInput): HeartbeatDecision {
  const staleMin = input.staleMin ?? STALE_SCAN_MIN;
  const dayKey = londonDayKey(input.now);
  if (!dayKey) return { action: "none", reason: "could not resolve the Europe/London date" };

  // ONCE A DAY. The day key is written to disk after a confirmed delivery, so it
  // survives a loop restart, a reboot and a killed process.
  if (input.lastSentDayKey === dayKey) {
    return { action: "none", reason: `already sent today (${dayKey}) — one heartbeat per day` };
  }

  // A clock set backwards (or state restored from an older day) must not buy a
  // second message for the same period.
  if (input.lastSentAt) {
    const lastMs = new Date(input.lastSentAt).getTime();
    if (Number.isFinite(lastMs)) {
      const hours = (input.now.getTime() - lastMs) / 3_600_000;
      if (hours >= 0 && hours < HEARTBEAT_MIN_GAP_HOURS) {
        return {
          action: "none",
          reason: `last heartbeat ${hours.toFixed(1)}h ago — inside the ${HEARTBEAT_MIN_GAP_HOURS}h minimum spacing`,
        };
      }
    }
  }

  const hour = londonHour(input.now);
  if (hour == null) return { action: "none", reason: "could not resolve the Europe/London hour" };
  if (hour < HEARTBEAT_LOCAL_HOUR) {
    return { action: "none", reason: `it is ${hour}:00 London — the heartbeat goes out at ${HEARTBEAT_LOCAL_HOUR}:00` };
  }

  const lastMs = input.lastScanAt ? new Date(input.lastScanAt).getTime() : NaN;
  const hasScan = Number.isFinite(lastMs);
  const scanAgeMin = hasScan ? Math.max(0, (input.now.getTime() - lastMs) / 60_000) : null;
  const healthy = scanAgeMin != null && scanAgeMin <= staleMin;

  const message = healthy
    ? buildHeartbeatMessage({
        now: input.now,
        lastScanAt: input.lastScanAt as string,
        scanAgeMin: scanAgeMin as number,
        coverage: input.coverage,
        creditsRemaining: input.creditsRemaining,
        lastScanAlerted: input.lastScanAlerted,
      })
    : buildStaleMessage({
        now: input.now,
        lastScanAt: input.lastScanAt,
        scanAgeMin,
        coverage: input.coverage,
        creditsRemaining: input.creditsRemaining,
        lastScanAlerted: input.lastScanAlerted,
      });

  return { action: "send", dayKey, healthy, message };
}
