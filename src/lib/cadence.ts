/**
 * THE SCAN CADENCE — one place that says how often we scan, and how long a
 * silence has to be before the stall alarm shouts.
 *
 * OWNER DIRECTIVE (2026-11-03): "Scan every 30mins and on open."
 *
 * WHY THIS IS A MODULE AND NOT A NUMBER IN A SCRIPT: the cadence is used by three
 * things that cannot import each other —
 *   • the scheduled loop (scripts/alert-loop.sh, a bash process),
 *   • the in-process worker (src/server/alerts.ts, `setInterval`),
 *   • the stall alarm (src/server/gap-alarm.ts).
 * They must agree, or the alarm cries wolf on a healthy system. So the numbers
 * live here, the bash default is pinned to them by test/cadence.test.ts, and
 * changing the cadence in one place fails the test until the others follow.
 *
 * SURVIVING A MACHINE REPLACEMENT: every one of these is a committed DEFAULT, not
 * an environment variable set in somebody's shell. A replaced machine re-reads
 * the repo (postinstall/predev → scripts/ensure-alert-worker.sh → the loop), so
 * the cadence comes back with it — the same way the pidfile identity fix does.
 * The env vars still exist as overrides, but nothing depends on them being set.
 */

/** How often the scheduled sweep runs, in minutes. */
export const SCAN_INTERVAL_MIN = 30;

/**
 * How long the scanner may be silent before the owner is told, in minutes.
 *
 * 2.5 normal cycles. At a 30-minute cadence a 25-minute threshold (the old value)
 * would fire on every healthy cycle — a stall alarm that cries wolf is worse than
 * no alarm, because it teaches its reader to ignore it. 75 minutes means one whole
 * cycle was missed AND most of a second, so a real stall is unambiguous.
 */
export const STALL_ALARM_MIN = 75;

/** The same cadence in the units each consumer wants. */
export const SCAN_INTERVAL_SEC = SCAN_INTERVAL_MIN * 60;
export const SCAN_INTERVAL_MS = SCAN_INTERVAL_MIN * 60_000;

/**
 * How old the newest scan may be when a page opens before that open starts one
 * (see src/server/scan-on-open.ts). Separate from the schedule on purpose: this
 * one is about what a person is looking at, not about the background loop.
 */
export const SCAN_ON_OPEN_AFTER_MIN = 5;
