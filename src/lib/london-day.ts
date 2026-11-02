/**
 * Europe/London calendar-day helpers — ONE definition of "today", shared by the
 * Instant Wins feed and the Lay Bet Finder's date control.
 *
 * WHY A SHARED MODULE: a fixture is "today" for a UK user when its kick-off falls
 * on today's date *in London*, not in the server's timezone (this machine runs
 * UTC) and not in the visitor's (a browser in Sydney would see "today" as
 * tomorrow). Every filter on the site must agree, so the day key is computed in
 * exactly one place.
 *
 * A "day key" is a plain `YYYY-MM-DD` string in Europe/London. Comparing keys is
 * DST-safe: the London offset changes twice a year, and string comparison of the
 * calendar date never shifts a fixture into the wrong day because of it.
 */

const LONDON = "Europe/London";

const DAY_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: LONDON,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const TIME_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: LONDON,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Parse anything date-ish; null when it cannot describe a moment. */
function toDate(input: Date | string | number): Date | null {
  const d = input instanceof Date ? input : new Date(input);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * The Europe/London calendar date of a moment, as `YYYY-MM-DD`.
 * Returns null for an unparseable input (never a made-up day).
 */
export function londonDayKey(input: Date | string | number): string | null {
  const d = toDate(input);
  if (!d) return null;
  const parts = DAY_FMT.formatToParts(d);
  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const y = pick("year");
  const m = pick("month");
  const day = pick("day");
  if (!y || !m || !day) return null;
  return `${y}-${m}-${day}`;
}

/** Kick-off clock time in London, `HH:MM` (24h). Null when unparseable. */
export function londonTimeLabel(input: Date | string | number): string | null {
  const d = toDate(input);
  if (!d) return null;
  return TIME_FMT.format(d);
}

/**
 * Add (or subtract) whole days to a day key. Calendar arithmetic on the date
 * itself, so a DST change cannot turn "+1 day" into 23 or 25 hours and land on
 * the wrong date.
 */
export function addDaysToDayKey(dayKey: string, days: number): string {
  const [y, m, d] = dayKey.split("-").map((n) => Number(n));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return dayKey;
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(t);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** The `count` day keys starting at `startKey` (inclusive). */
export function dayKeysFrom(startKey: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(addDaysToDayKey(startKey, i));
  return out;
}

/** "Mon 2 Nov" — for the "which day am I looking at" line. */
export function londonDayLabel(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map((n) => Number(n));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return dayKey;
  // Midday UTC on that calendar date, formatted back in UTC: the label is the
  // date itself, with no timezone conversion in either direction.
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(dt);
}

/** A day key from a `<input type="date">` value, or null when it is not one. */
export function parseDayKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** The day choices the Lay Bet Finder offers. */
export type DayMode = "today" | "tomorrow" | "next7" | "date";

/**
 * The day keys a chosen mode covers, computed from "now" in Europe/London.
 *
 * THIS IS THE DATE FILTER'S WHOLE RULE, kept out of the page so it can be tested
 * at the day boundaries (23:59 vs 00:01 London, and across a DST change) rather
 * than only by eye.
 *
 * `dateValue` is the raw `<input type="date">` value; it is only used for mode
 * "date", and a malformed value falls back to today rather than silently showing
 * everything.
 */
export function resolveDayKeys(
  mode: DayMode,
  dateValue: string | null | undefined,
  now: Date = new Date(),
): string[] {
  const today = londonDayKey(now);
  if (!today) return [];
  if (mode === "today") return [today];
  if (mode === "tomorrow") return [addDaysToDayKey(today, 1)];
  if (mode === "next7") return dayKeysFrom(today, 7);
  return [parseDayKey(dateValue) ?? today];
}

/** True when a kick-off falls on one of these London day keys. */
export function kickoffFallsOn(commenceTime: string | null | undefined, dayKeys: readonly string[]): boolean {
  if (!commenceTime) return false;
  const key = londonDayKey(commenceTime);
  return Boolean(key && dayKeys.includes(key));
}
