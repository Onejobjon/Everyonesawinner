/**
 * THE SCAN WINDOW — one definition, shared by the free sports index, the paid
 * sweep's cache prune and the Instant Wins feed, so the three can never disagree
 * about which fixtures are "on".
 *
 * OWNER COMPLAINT 2026-11-03: "On the site it just says 3 tournaments... The
 * reason we scan through the night is for the American market. If we don't have
 * access there is no point in scanning at night."
 *
 * The old rule was a LONDON CALENDAR DAY: `londonDay(commence_time) === today`.
 * At 20:52 UTC that counted basketball_ncaab and one Brazilian football match and
 * nothing else, because every NBA / NHL / NFL tip-off falls after midnight in
 * London and was therefore "tomorrow" — the exact market the overnight scan
 * exists for. The scan was never blind to those games; it was refusing to pay for
 * them.
 *
 * So the rule is now a ROLLING WINDOW on absolute time, with no calendar date in
 * it at all:
 *
 *     now  <  commence_time  <=  now + SCAN_WINDOW_HOURS
 *
 * At 21:00 London that runs to 23:00 London the next day, which covers a full US
 * evening slate. 26 rather than 24 so a fixture starting just after the same
 * clock time tomorrow is not lost in the gap between two scans, and it matches
 * the `commenceTimeTo` the paid odds call already asks for — the window the cache
 * holds is exactly the window we pay for.
 */

/** How far ahead the scan looks, in hours. Single source of truth. */
export const SCAN_WINDOW_HOURS = 26;

/** The far edge of the window: `commence_time` must be at or before this. */
export function scanWindowEnd(now: Date = new Date(), hours: number = SCAN_WINDOW_HOURS): Date {
  return new Date(now.getTime() + hours * 3600_000);
}

/**
 * True when a fixture kicks off strictly after `now` and no later than
 * `now + hours`. An unparseable time is not in the window — a fixture we cannot
 * date is not something we can tell a user to bet on.
 */
export function isInScanWindow(
  commenceTime: string | null | undefined,
  now: Date = new Date(),
  hours: number = SCAN_WINDOW_HOURS,
): boolean {
  if (typeof commenceTime !== "string") return false;
  const t = Date.parse(commenceTime);
  if (!Number.isFinite(t)) return false;
  const nowMs = now.getTime();
  return t > nowMs && t <= nowMs + hours * 3600_000;
}

/**
 * The one phrase the site uses for this window. Every surface that used to say
 * "today" says this instead, so a 03:00 tip-off reads correctly at 21:00.
 */
export function windowPhrase(hours: number = SCAN_WINDOW_HOURS): string {
  return `in the next ${hours} hours`;
}
