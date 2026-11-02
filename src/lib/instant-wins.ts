/**
 * INSTANT WINS — same-day opportunities, built from the last scan's cache.
 *
 * This is the feed the owner remembers from the original build: open the site and
 * the opportunities are already there, no click and no search. It is a SEPARATE
 * surface from the Lay Bet Finder (which stays a manual, criteria-led search that
 * states its cost): this one never fetches anything, ever.
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
import { calcLay, layGap, qualifiesForLay, round2, DEFAULT_COMMISSION } from "./odds";
import type { Match } from "./odds-api";
import { londonDayKey, londonTimeLabel } from "./london-day";

/**
 * How old the scan may be before the feed says so out loud. The worker scans
 * every 10 minutes, so 20 minutes means it has missed at least one round: the
 * prices on screen may no longer exist.
 */
export const STALE_AFTER_MIN = 20;

/** qualifying = a normal matched-betting row; arbitrage = green cash. */
export type InstantWinGrade = "arbitrage" | "qualifying";

export interface InstantWinRow {
  matchId: string;
  home: string;
  away: string;
  league: string;
  /** Full ISO kick-off (sorting / tooltips). */
  kickoff: string;
  /** HH:MM in Europe/London — what the user's clock shows. */
  kickoffTime: string;
  outcome: string;
  bookmaker: string;
  backOdds: number;
  laySource: string | null;
  layOdds: number;
  /** lay − back, 2dp. Negative = the lay sits below the back (better than break-even). */
  gap: number;
  /** From the shared calcLay(), at the caller's stake and commission. */
  layStake: number;
  liability: number;
  profitLoss: number;
  grade: InstantWinGrade;
  /** True when the laying exchange's own back price was set aside (rule inherited). */
  backSourceExcluded: boolean;
}

export interface InstantWinsResult {
  rows: InstantWinRow[];
  /** Fixtures in the cached scan (before the same-day filter). */
  fixturesScanned: number;
  /** Fixtures that kick off today in London and have not started. */
  sameDayFixtures: number;
  /** Rows withheld because the back/lay pair failed the sanity check. */
  withheld: number;
  /** Outcomes dropped because the only back price was the laying exchange. */
  laySourceExcluded: number;
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
 * Build the rows: same-day fixtures only, each usable back/lay pair priced with
 * the shared calcLay at the caller's stake and commission.
 *
 * `qualifiesForLay` is the same close-lay rule the Lay Bet Finder uses (gap under
 * 0.20), so the two surfaces can never disagree about what counts as a row.
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

  const sameDay = [...selectSameDayMatches(matches, now)].sort(
    (a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime(),
  );

  const rows: InstantWinRow[] = [];
  for (const m of sameDay) {
    laySourceExcluded += m.backWithheldAsLaySource ?? 0;
    for (const o of m.outcomes) {
      // The sanity rule already withheld this price — never resurrect it.
      if (o.laySuspect) {
        withheld++;
        continue;
      }
      if (!qualifiesForLay(o.odds, o.layOdds, commission)) continue;
      const lay = calcLay(o.odds, o.layOdds, stake, commission);
      if (!lay) continue;
      rows.push({
        matchId: m.matchId,
        home: m.home,
        away: m.away,
        league: m.league,
        kickoff: m.commenceTime,
        kickoffTime: londonTimeLabel(m.commenceTime) ?? m.time,
        outcome: o.name,
        bookmaker: o.bookmaker,
        backOdds: o.odds,
        laySource: o.laySource,
        layOdds: o.layOdds as number,
        gap: layGap(o.odds, o.layOdds as number),
        layStake: lay.layStake,
        liability: lay.liability,
        profitLoss: lay.profitLoss,
        // Green cash = the row actually returns money at this stake and rate.
        // Everything else is qualifying-grade: a small loss you take to release
        // a free bet or hit a wagering requirement. Most rows are this.
        grade: lay.profitLoss > 0 ? "arbitrage" : "qualifying",
        backSourceExcluded: Boolean(o.backSourceExcluded),
      });
    }
  }

  rows.sort((a, b) => {
    const d = round2(b.profitLoss) - round2(a.profitLoss);
    if (d !== 0) return d;
    return a.gap - b.gap;
  });

  return {
    rows,
    fixturesScanned: matches.length,
    sameDayFixtures: sameDay.length,
    withheld,
    laySourceExcluded,
  };
}
