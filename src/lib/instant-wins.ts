/**
 * INSTANT WINS — same-day GREEN trades, built from the last scan's cache.
 *
 * This is the feed the owner remembers from the original build: open the site and
 * the opportunities are already there, no click and no search. It is a SEPARATE
 * surface from the Lay Bet Finder (which stays a manual, criteria-led search that
 * states its cost): this one never fetches anything, ever.
 *
 * ── THE ONLY ADMISSION RULE: GREEN ─────────────────────────────────────────
 * OWNER REQUIREMENT (2026-11-02): "we need any odds visible, only rule being it
 * must be green." So a row is admitted if and only if the trade returns money on
 * BOTH sides after exchange commission — i.e. the shared `calcLay` profit/loss at
 * the user's own stake and the user's own commission rate is > 0.
 *
 * There is deliberately NO odds floor, NO odds ceiling, NO lay-gap threshold and
 * NO "qualifying-grade" tier in this file. A green trade at 1.05 is a row; a
 * green trade at 14.0 is a row; a tight-but-unprofitable 2.00/2.05 pair is NOT a
 * row. `qualifiesForLay` (the finder's gap < 0.2 rule) is NOT called here — it
 * answers a different question, and using it here would silently drop rows the
 * owner asked to see.
 *
 * THREE RULES, all inherited rather than re-implemented:
 *   • Odds Sanity Rule — the rows come from `transformMatches` output, so the
 *     1.01 ≤ price < 451 range and the suspect back/lay pairs are already
 *     applied. A row flagged `laySuspect` is never shown; it is counted instead.
 *   • An exchange can never be its own back price — `backSourceExcluded` rows
 *     were already re-priced by the transform; we only count them so the page
 *     can say why a row is missing.
 *   • The money comes from the SHARED `calcLay`, at the user's own stake and the
 *     shared exchange-commission rate. Nothing here has its own arithmetic.
 *
 * SAME DAY means: kick-off falls on today's date in Europe/London AND the match
 * has not started. A fixture tomorrow, or one next week, is excluded — that is
 * the whole point of the name.
 */
import { calcLay, layGap, round2, DEFAULT_COMMISSION } from "./odds";
import type { Match } from "./odds-api";
import { londonDayKey, londonTimeLabel } from "./london-day";

/**
 * How old the OLDEST price on screen may be before the feed says so out loud.
 *
 * The worker refreshes each sport's odds on a budget (see src/server/alerts.ts:
 * a full same-day sweep is one credit PER SPORT, so sports rotate rather than all
 * refreshing every ten minutes). With a 90-minute per-sport refresh window, 100
 * minutes means "this sport has missed a full rotation" — the prices on screen
 * may no longer exist. Deliberately tied to the refresh window rather than to
 * the scan interval: the scan running a minute ago says nothing about how old
 * the tennis prices in front of you are.
 */
export const STALE_AFTER_MIN = 100;

export interface InstantWinRow {
  matchId: string;
  home: string;
  away: string;
  league: string;
  /** Vendor sport key, e.g. "tennis_atp_paris_masters" — for the coverage line. */
  sportKey: string;
  /** Full ISO kick-off (sorting / tooltips). */
  kickoff: string;
  /** HH:MM in Europe/London — what the user's clock shows. */
  kickoffTime: string;
  outcome: string;
  bookmaker: string;
  backOdds: number;
  laySource: string | null;
  layOdds: number;
  /** lay − back, 2dp. Always negative on a green row. */
  gap: number;
  /** From the shared calcLay(), at the caller's stake and commission. */
  layStake: number;
  liability: number;
  /** The worse of the two outcomes — positive by definition here (that IS green). */
  profitLoss: number;
  /** True when the laying exchange's own back price was set aside (rule inherited). */
  backSourceExcluded: boolean;
}

export interface InstantWinsResult {
  /** GREEN rows only, best profit at the user's stake first. */
  rows: InstantWinRow[];
  /** Fixtures held in the scan's cache (all sports, all days). */
  fixturesScanned: number;
  /** Distinct sports among `fixturesScanned`. */
  sportsScanned: number;
  /** Fixtures that kick off today in London and have not started. */
  sameDayFixtures: number;
  /** Distinct sports among `sameDayFixtures` — the "M sports" of the coverage line. */
  sameDaySports: number;
  /** Same-day outcomes examined (the denominator behind the green test). */
  outcomesConsidered: number;
  /** Same-day outcomes with no usable exchange lay price — counted, not hidden. */
  noLayPrice: number;
  /** Rows withheld because the back/lay pair failed the shared sanity check. */
  withheld: number;
  /** Outcomes dropped because the only back price was the laying exchange. */
  laySourceExcluded: number;
  /** Rows that had a usable lay price but were NOT green, so not shown. */
  notGreen: number;
}

export interface InstantWinsOptions {
  /** "Now" — injectable so the day boundary is testable. */
  now?: Date;
  /** The user's cash back stake (honoured exactly, no cap). */
  stake?: number;
  /** Exchange commission as a fraction (0.02 = 2%). */
  commission?: number;
}

/** True when this kick-off is on today's date in London. */
export function isSameDayLondon(commenceTime: string, now: Date): boolean {
  const key = londonDayKey(commenceTime);
  const today = londonDayKey(now);
  return Boolean(key && today && key === today);
}

/** True when the match has not started yet. An unparseable time is not "today". */
export function hasNotStarted(commenceTime: string, now: Date): boolean {
  const t = new Date(commenceTime).getTime();
  return Number.isFinite(t) && t > now.getTime();
}

/**
 * Keep only fixtures that kick off today (Europe/London) and have not started.
 * Everything days away is dropped — this feed is same-day only.
 */
export function selectSameDayMatches(matches: readonly Match[], now: Date = new Date()): Match[] {
  return matches.filter(
    (m) => isSameDayLondon(m.commenceTime, now) && hasNotStarted(m.commenceTime, now),
  );
}

/**
 * The green test, in one place: is this back/lay pair profitable on both sides at
 * this stake and commission rate?
 *
 * `calcLay` sizes the lay so both outcomes pay the same, so its `profitLoss` IS
 * the worse of the two — > 0 means genuinely green, not "close to break-even".
 * No odds range is applied here: 1.05 and 14.0 are both allowed, and only the
 * money decides. Returns null when the pair cannot be priced at all.
 */
export function greenTrade(
  backOdds: number,
  layOdds: number | null,
  stake: number,
  commission: number,
): ReturnType<typeof calcLay> {
  const lay = calcLay(backOdds, layOdds, stake, commission);
  if (!lay) return null;
  return lay.profitLoss > 0 ? lay : null;
}

/**
 * Build the rows: same-day fixtures only, GREEN trades only, each priced with the
 * shared calcLay at the caller's stake and commission.
 *
 * Every same-day outcome is accounted for in exactly one of `rows`, `notGreen`,
 * `noLayPrice`, `withheld` — so the page can print an honest coverage line
 * ("looked at N fixtures across M sports, K outcomes, 0 green") instead of an
 * empty table that reads like a broken feed.
 */
export function buildInstantWins(
  matches: readonly Match[],
  options: InstantWinsOptions = {},
): InstantWinsResult {
  const now = options.now ?? new Date();
  const stake = options.stake ?? 20;
  const commission = options.commission ?? DEFAULT_COMMISSION;

  let withheld = 0;
  let laySourceExcluded = 0;
  let noLayPrice = 0;
  let notGreen = 0;
  let outcomesConsidered = 0;

  const sameDay = [...selectSameDayMatches(matches, now)].sort(
    (a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime(),
  );

  const rows: InstantWinRow[] = [];
  for (const m of sameDay) {
    laySourceExcluded += m.backWithheldAsLaySource ?? 0;
    for (const o of m.outcomes) {
      outcomesConsidered++;
      // The sanity rule already withheld this price — never resurrect it.
      if (o.laySuspect) {
        withheld++;
        continue;
      }
      // No exchange lay price at all: the trade cannot be made, so it can never
      // be green. Counted so the coverage line stays honest about it.
      if (!o.layOdds) {
        noLayPrice++;
        continue;
      }
      const lay = greenTrade(o.odds, o.layOdds, stake, commission);
      if (!lay) {
        notGreen++;
        continue;
      }
      rows.push({
        matchId: m.matchId,
        home: m.home,
        away: m.away,
        league: m.league,
        sportKey: m.sportKey,
        kickoff: m.commenceTime,
        kickoffTime: londonTimeLabel(m.commenceTime) ?? m.time,
        outcome: o.name,
        bookmaker: o.bookmaker,
        backOdds: o.odds,
        laySource: o.laySource,
        layOdds: o.layOdds,
        gap: layGap(o.odds, o.layOdds),
        layStake: lay.layStake,
        liability: lay.liability,
        profitLoss: lay.profitLoss,
        backSourceExcluded: Boolean(o.backSourceExcluded),
      });
    }
  }

  // Best profit at the user's stake first; earliest kick-off breaks ties.
  rows.sort((a, b) => {
    const d = round2(b.profitLoss) - round2(a.profitLoss);
    if (d !== 0) return d;
    return new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime();
  });

  return {
    rows,
    fixturesScanned: matches.length,
    sportsScanned: new Set(matches.map((m) => m.sportKey).filter(Boolean)).size,
    sameDayFixtures: sameDay.length,
    sameDaySports: new Set(sameDay.map((m) => m.sportKey).filter(Boolean)).size,
    outcomesConsidered,
    noLayPrice,
    withheld,
    laySourceExcluded,
    notGreen,
  };
}

/**
 * The coverage sentence the page prints under the feed. Pure so a test can assert
 * the numbers reach the screen: "looked at 55 fixtures across 20 sports".
 */
export function coverageLine(result: InstantWinsResult): string {
  const f = result.sameDayFixtures;
  const s = result.sameDaySports;
  return `looked at ${f} fixture${f === 1 ? "" : "s"} across ${s} sport${s === 1 ? "" : "s"}`;
}
