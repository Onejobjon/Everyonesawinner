import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInstantWins,
  coverageLine,
  selectSameDayMatches,
  STALE_AFTER_MIN,
} from "../src/lib/instant-wins";
import { readInstantWins } from "../src/server/instant-wins";
import {
  addDaysToDayKey,
  kickoffFallsOn,
  londonDayKey,
  londonTimeLabel,
  resolveDayKeys,
} from "../src/lib/london-day";
import { calcLay } from "../src/lib/odds";
import type { Match, MatchOutcome } from "../src/lib/odds-api";

/**
 * INSTANT WINS + the Lay Bet Finder's date option.
 *
 * The two things these tests exist to stop:
 *   • a feed that looks live when it is not (stale prices, or "no scan yet"
 *     rendered as "no opportunities"), and
 *   • a date filter whose day boundaries drift, so a fixture tomorrow shows up
 *     under "Today" — the exact complaint that put the date control on the page.
 */

// A fixed "now": 10:00 UTC on Mon 2 Nov 2026 (GMT, so 10:00 in London too).
const NOW = new Date("2026-11-02T10:00:00Z");

function outcome(over: Partial<MatchOutcome> = {}): MatchOutcome {
  return {
    name: "Home",
    bookmaker: "William Hill",
    odds: 2.0,
    return20: 40,
    layOdds: 2.05,
    laySource: "Betfair",
    layBookmakerKey: "betfair_ex_uk",
    backLastUpdate: "2026-11-02T09:50:00Z",
    layLastUpdate: "2026-11-02T09:50:00Z",
    bookmakerOdds: [],
    bookmakerKey: "williamhill",
    ...over,
  };
}

function match(commenceTime: string, over: Partial<Match> = {}): Match {
  return {
    matchId: `id-${commenceTime}`,
    home: "Arsenal",
    away: "Chelsea",
    league: "Premier League",
    leagueKey: "soccer epl",
    sportKey: "soccer_epl",
    time: "15:00",
    commenceTime,
    outcomes: [outcome()],
    hasLayCoverage: true,
    ...over,
  };
}

const TODAY_LATER = match("2026-11-02T15:00:00Z");
const TOMORROW = match("2026-11-03T15:00:00Z");
const NEXT_WEEK = match("2026-11-09T15:00:00Z");
const TODAY_STARTED = match("2026-11-02T09:00:00Z");

describe("ITEM 1 — Instant Wins is same-day only", () => {
  test("a fixture tomorrow and one next week are both excluded", () => {
    const kept = selectSameDayMatches([TODAY_LATER, TOMORROW, NEXT_WEEK], NOW);
    expect(kept.map((m) => m.commenceTime)).toEqual(["2026-11-02T15:00:00Z"]);
  });

  test("a fixture that already kicked off today is excluded (not started only)", () => {
    const kept = selectSameDayMatches([TODAY_LATER, TODAY_STARTED], NOW);
    expect(kept).toHaveLength(1);
    expect(kept[0].commenceTime).toBe("2026-11-02T15:00:00Z");
  });

  test("the build reports what the scan looked at and what survived the day filter", () => {
    const green = match("2026-11-02T15:00:00Z", {
      outcomes: [outcome({ odds: 2.1, layOdds: 2.0 })],
    });
    const built = buildInstantWins([green, TOMORROW, NEXT_WEEK, TODAY_STARTED], {
      now: NOW,
      stake: 20,
    });
    expect(built.fixturesScanned).toBe(4); // every fixture the scan looked at
    expect(built.sameDayFixtures).toBe(1); // today, not started
    expect(built.rows).toHaveLength(1);
    expect(built.rows[0].kickoff).toBe("2026-11-02T15:00:00Z");
  });

  test("a 23:30 London kick-off is today, a 00:30 one is tomorrow", () => {
    // 23:30 UTC on 2 Nov is 23:30 in London (GMT) — still today.
    const late = match("2026-11-02T23:30:00Z");
    // 00:30 UTC on 3 Nov is 00:30 in London — tomorrow, even though it is only
    // an hour later in wall-clock terms.
    const early = match("2026-11-03T00:30:00Z");
    const kept = selectSameDayMatches([late, early], NOW);
    expect(kept.map((m) => m.commenceTime)).toEqual(["2026-11-02T23:30:00Z"]);
  });

  test("kick-off time shown is London time", () => {
    expect(londonTimeLabel("2026-11-02T15:00:00Z")).toBe("15:00");
    // 14:30 UTC in British Summer Time is 15:30 in London.
    expect(londonTimeLabel("2026-08-10T14:30:00Z")).toBe("15:30");
  });

  test("rows are priced with the shared calcLay at the user's stake — no £20 cap", () => {
    const green = match("2026-11-02T15:00:00Z", {
      outcomes: [outcome({ odds: 2.1, layOdds: 2.0 })],
    });
    const built = buildInstantWins([green], { now: NOW, stake: 100, commission: 0.05 });
    const row = built.rows[0];
    const expected = calcLay(2.1, 2.0, 100, 0.05)!;
    expect(row.layStake).toBeCloseTo(expected.layStake, 10);
    expect(row.liability).toBeCloseTo(expected.liability, 10);
    expect(row.profitLoss).toBeCloseTo(expected.profitLoss, 10);
    // 100-stake figures, not 20-stake ones.
    expect(row.layStake).toBeGreaterThan(90);
  });

  test("GREEN IS THE ONLY ADMISSION RULE — a qualifying-grade row is excluded", () => {
    // back 2.00 / lay 2.05 is a small qualifying loss at any stake. It is a
    // perfectly normal matched-betting row, and it is NOT shown in this feed.
    const built = buildInstantWins([TODAY_LATER], { now: NOW, stake: 20, commission: 0.02 });
    expect(built.rows).toHaveLength(0);
    expect(built.notGreen).toBe(1);
    expect(built.outcomesConsidered).toBe(1);
    // The money is still computed — it is just not admitted.
    expect(calcLay(2.0, 2.05, 20, 0.02)!.profitLoss).toBeLessThan(0);
  });

  test("a green trade at odds 1.05 is shown (no odds floor)", () => {
    const short = match("2026-11-02T15:00:00Z", {
      outcomes: [outcome({ odds: 1.05, layOdds: 1.03 })],
    });
    const built = buildInstantWins([short], { now: NOW, stake: 20, commission: 0.02 });
    expect(built.rows).toHaveLength(1);
    expect(built.rows[0].backOdds).toBe(1.05);
    expect(built.rows[0].profitLoss).toBeGreaterThan(0);
    expect(built.rows[0].gap).toBeLessThan(0);
  });

  test("a green trade at odds 14.0 is shown (no odds ceiling)", () => {
    const long = match("2026-11-02T15:00:00Z", {
      outcomes: [outcome({ odds: 14.0, layOdds: 13.5 })],
    });
    const built = buildInstantWins([long], { now: NOW, stake: 20, commission: 0.02 });
    expect(built.rows).toHaveLength(1);
    expect(built.rows[0].backOdds).toBe(14.0);
    expect(built.rows[0].profitLoss).toBeGreaterThan(0);
  });

  test("a lay gap above the finder's 0.2 threshold is irrelevant — only the money decides", () => {
    // Gap is +1.5, which the Lay Bet Finder would reject outright, but at these
    // prices the trade is still green, so this feed must show it.
    const wide = match("2026-11-02T15:00:00Z", {
      outcomes: [outcome({ odds: 2.0, layOdds: 3.5 })],
    });
    expect(buildInstantWins([wide], { now: NOW, stake: 20 }).rows).toHaveLength(0);
    // ...and the same gap with prices that DO pay both ways is admitted.
    const paid = match("2026-11-02T15:00:00Z", {
      outcomes: [outcome({ odds: 4.0, layOdds: 3.9 })],
    });
    const built = buildInstantWins([paid], { now: NOW, stake: 20 });
    expect(built.rows).toHaveLength(1);
    expect(built.rows[0].gap).toBeLessThan(0);
  });

  test("commission flips a marginal row out of green", () => {
    // back 2.00 / lay 1.95 pays both ways with no commission, and stops paying
    // once 10% is taken from the lay winnings.
    const marginal = match("2026-11-02T15:00:00Z", {
      outcomes: [outcome({ odds: 2.0, layOdds: 1.95 })],
    });
    const free = buildInstantWins([marginal], { now: NOW, stake: 20, commission: 0 });
    expect(free.rows).toHaveLength(1);
    expect(free.rows[0].profitLoss).toBeGreaterThan(0);

    const taxed = buildInstantWins([marginal], { now: NOW, stake: 20, commission: 0.1 });
    expect(taxed.rows).toHaveLength(0);
    expect(taxed.notGreen).toBe(1);
  });

  test("the coverage line reports fixtures and sports, so an empty feed is not a broken one", () => {
    const tennis = match("2026-11-02T12:00:00Z", {
      matchId: "t1",
      sportKey: "tennis_atp_paris_masters",
      league: "ATP Paris Masters",
    });
    const tennis2 = match("2026-11-02T13:00:00Z", {
      matchId: "t2",
      sportKey: "tennis_atp_paris_masters",
      league: "ATP Paris Masters",
    });
    const soccer = match("2026-11-02T19:00:00Z", { matchId: "s1", sportKey: "soccer_epl" });
    const tomorrow = match("2026-11-03T19:00:00Z", { matchId: "s2", sportKey: "soccer_epl" });

    const built = buildInstantWins([tennis, tennis2, soccer, tomorrow], { now: NOW, stake: 20 });
    expect(built.rows).toHaveLength(0); // all three are qualifying-grade
    expect(built.fixturesScanned).toBe(4);
    expect(built.sportsScanned).toBe(2);
    expect(built.sameDayFixtures).toBe(3); // the 3rd soccer fixture is tomorrow
    expect(built.sameDaySports).toBe(2);
    expect(coverageLine(built)).toBe("looked at 3 fixtures across 2 sports");
  });

  test("an outcome with no lay price is counted, not silently dropped", () => {
    const noLay = match("2026-11-02T15:00:00Z", {
      outcomes: [outcome({ layOdds: null, laySource: null })],
    });
    const built = buildInstantWins([noLay], { now: NOW, stake: 20 });
    expect(built.rows).toHaveLength(0);
    expect(built.noLayPrice).toBe(1);
    expect(built.notGreen).toBe(0);
  });

  test("rows are sorted by profit at the user's stake, best first", () => {
    const small = match("2026-11-02T12:00:00Z", {
      matchId: "small",
      outcomes: [outcome({ odds: 2.05, layOdds: 2.0 })],
    });
    const big = match("2026-11-02T13:00:00Z", {
      matchId: "big",
      outcomes: [outcome({ odds: 3.0, layOdds: 2.8 })],
    });
    const built = buildInstantWins([small, big], { now: NOW, stake: 20, commission: 0.02 });
    expect(built.rows).toHaveLength(2);
    expect(built.rows[0].matchId).toBe("big");
    expect(built.rows[0].profitLoss).toBeGreaterThan(built.rows[1].profitLoss);
  });

  test("sanity rules are inherited, not re-implemented", () => {
    const suspect = match("2026-11-02T15:00:00Z", {
      outcomes: [outcome({ layOdds: null, laySuspect: true })],
    });
    const built = buildInstantWins([suspect], { now: NOW, stake: 20 });
    expect(built.rows).toHaveLength(0);
    expect(built.withheld).toBe(1);
  });
});

describe("ITEM 1 — freshness and the 'no scan yet' state", () => {
  function tempCache(content: string): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), "eaw-instant-"));
    const file = join(dir, "alerts-cache.json");
    writeFileSync(file, content, "utf8");
    return { dir, file };
  }

  test("staleness follows the OLDEST per-sport price, not when the scan ran", () => {
    // The scan ticked a minute ago, but this sport's odds were fetched two hours
    // ago: the row is stale and the page must say so.
    const old = NOW.getTime() - 120 * 60_000;
    const { dir, file } = tempCache(
      JSON.stringify({
        ts: NOW.getTime() - 60_000,
        data: [TODAY_LATER],
        perSport: { soccer_epl: { fetchedAt: old, fixtures: 1, events: 1 } },
      }),
    );
    try {
      const p = readInstantWins({ file, now: NOW });
      expect(p.ageMinutes).toBe(1); // the loop is healthy...
      expect(p.priceAgeMinutes).toBe(120); // ...but the price is not
      expect(p.stale).toBe(true);
      expect(p.oldestPriceAt).toBe(new Date(old).toISOString());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the server payload carries the coverage numbers the page prints", () => {
    const ts = NOW.getTime() - 60_000;
    const tennis = match("2026-11-02T12:00:00Z", { matchId: "t1", sportKey: "tennis_atp_paris_masters" });
    const soccer = match("2026-11-02T19:00:00Z", { matchId: "s1", sportKey: "soccer_epl" });
    const { dir, file } = tempCache(
      JSON.stringify({
        ts,
        data: [tennis, soccer, TOMORROW],
        index: { ts, sportsInSeason: 78, sportsWithToday: 20, totalTodayFixtures: 55 },
      }),
    );
    try {
      const p = readInstantWins({ file, now: NOW });
      expect(p.sportsScanned).toBe(2); // tennis + soccer (tomorrow's is also soccer)
      expect(p.sameDaySports).toBe(2);
      expect(p.sameDayFixtures).toBe(2);
      expect(p.sportsInSeason).toBe(78);
      expect(p.sportsWithToday).toBe(20);
      expect(p.fixturesToday).toBe(55);
      expect(p.message).toContain("2 fixtures kicking off today across 2 sports");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fresh scan is not stale", () => {
    const ts = NOW.getTime() - 5 * 60_000;
    const { dir, file } = tempCache(JSON.stringify({ ts, data: [TODAY_LATER, TOMORROW] }));
    try {
      const p = readInstantWins({ file, now: NOW });
      expect(p.status).toBe("ok");
      expect(p.ageMinutes).toBe(5);
      expect(p.stale).toBe(false);
      expect(p.fixturesScanned).toBe(2);
      expect(p.sameDayFixtures).toBe(1);
      expect(p.matches).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a cache older than the staleness window is flagged stale", () => {
    // Derived from the constant, not hard-coded: the window moved from 20 to 45
    // minutes when the scan became a budgeted per-sport sweep, and a test pinned
    // to "25" would have quietly tested nothing after that change.
    const age = STALE_AFTER_MIN + 5;
    const ts = NOW.getTime() - age * 60_000;
    const { dir, file } = tempCache(JSON.stringify({ ts, data: [TODAY_LATER] }));
    try {
      const p = readInstantWins({ file, now: NOW });
      expect(p.status).toBe("ok");
      expect(p.ageMinutes).toBe(age);
      expect(p.stale).toBe(true);
      expect(p.staleAfterMin).toBe(STALE_AFTER_MIN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exactly at the window it is not yet stale", () => {
    const ts = NOW.getTime() - STALE_AFTER_MIN * 60_000;
    const { dir, file } = tempCache(JSON.stringify({ ts, data: [] }));
    try {
      expect(readInstantWins({ file, now: NOW }).stale).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a MISSING cache is 'no scan data yet', not 'no opportunities'", () => {
    const dir = mkdtempSync(join(tmpdir(), "eaw-instant-"));
    try {
      const p = readInstantWins({ file: join(dir, "alerts-cache.json"), now: NOW });
      expect(p.status).toBe("no_scan");
      expect(p.reason).toBe("missing");
      expect(p.message).toContain("No scan data yet");
      // The distinction that matters: it must not read as "we looked, nothing on".
      expect(p.message).not.toContain("no fixtures kicking off today");
      expect(p.scannedAt).toBeNull();
      expect(p.matches).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an UNREADABLE cache is 'no scan data yet' too, never an empty list", () => {
    const { dir, file } = tempCache("{ this is not json");
    try {
      const p = readInstantWins({ file, now: NOW });
      expect(p.status).toBe("no_scan");
      expect(p.reason).toBe("unreadable");
      expect(p.message).toContain("No scan data yet");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a cache in the wrong shape is 'no scan data yet' as well", () => {
    const { dir, file } = tempCache(JSON.stringify({ hello: "world" }));
    try {
      const p = readInstantWins({ file, now: NOW });
      expect(p.status).toBe("no_scan");
      expect(p.reason).toBe("unreadable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a scan that ran and found nothing is a DIFFERENT state from no scan", () => {
    const { dir, file } = tempCache(JSON.stringify({ ts: NOW.getTime() - 60_000, data: [TOMORROW] }));
    try {
      const p = readInstantWins({ file, now: NOW });
      // The scan exists, so this is "scanned, nothing on today" — not "no scan".
      expect(p.status).toBe("ok");
      expect(p.fixturesScanned).toBe(1);
      expect(p.sameDayFixtures).toBe(0);
      expect(p.message).toContain("no fixtures kicking off today");
      expect(p.message).not.toContain("No scan data yet");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reading the feed issues NO provider request (zero credits, proved)", () => {
    // The credit guarantee, tested rather than asserted: with fetch wrapped, ten
    // reads of the feed must make zero network calls of any kind.
    const ts = NOW.getTime() - 2 * 60_000;
    const { dir, file } = tempCache(JSON.stringify({ ts, data: [TODAY_LATER, TOMORROW] }));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      calls++;
      return originalFetch(...args);
    }) as typeof fetch;
    try {
      for (let i = 0; i < 10; i++) {
        const p = readInstantWins({ file, now: NOW });
        expect(p.status).toBe("ok");
        expect(p.sameDayFixtures).toBe(1);
      }
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ITEM 2 — the Lay Bet Finder's date filter and its day boundaries", () => {
  test("Today / Tomorrow / Next 7 days resolve from London dates", () => {
    expect(resolveDayKeys("today", null, NOW)).toEqual(["2026-11-02"]);
    expect(resolveDayKeys("tomorrow", null, NOW)).toEqual(["2026-11-03"]);
    expect(resolveDayKeys("next7", null, NOW)).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
    ]);
  });

  test("a specific date is honoured exactly", () => {
    expect(resolveDayKeys("date", "2026-11-09", NOW)).toEqual(["2026-11-09"]);
    // A malformed value falls back to today rather than showing everything.
    expect(resolveDayKeys("date", "not-a-date", NOW)).toEqual(["2026-11-02"]);
    expect(resolveDayKeys("date", "", NOW)).toEqual(["2026-11-02"]);
  });

  test("23:59 vs 00:01 London land on different days", () => {
    const lastMinute = "2026-11-02T23:59:00Z";
    const firstMinute = "2026-11-03T00:01:00Z";
    expect(kickoffFallsOn(lastMinute, resolveDayKeys("today", null, NOW))).toBe(true);
    expect(kickoffFallsOn(firstMinute, resolveDayKeys("today", null, NOW))).toBe(false);
    expect(kickoffFallsOn(firstMinute, resolveDayKeys("tomorrow", null, NOW))).toBe(true);
  });

  test("the boundary is London's, not UTC's — a BST evening stays on its own day", () => {
    // 22:30 UTC on 10 Aug 2026 is 23:30 in London (BST) — same day.
    const bstEvening = "2026-08-10T22:30:00Z";
    // 23:30 UTC on 10 Aug is 00:30 on 11 Aug in London — the next day.
    const bstMidnight = "2026-08-10T23:30:00Z";
    const now = new Date("2026-08-10T12:00:00Z");
    const today = resolveDayKeys("today", null, now);
    expect(today).toEqual(["2026-08-10"]);
    expect(kickoffFallsOn(bstEvening, today)).toBe(true);
    expect(kickoffFallsOn(bstMidnight, today)).toBe(false);
  });

  test("Next 7 days still spans a DST change without skipping or repeating a day", () => {
    // BST begins on Sunday 29 March 2026.
    const before = new Date("2026-03-26T12:00:00Z");
    const keys = resolveDayKeys("next7", null, before);
    expect(keys).toEqual([
      "2026-03-26",
      "2026-03-27",
      "2026-03-28",
      "2026-03-29",
      "2026-03-30",
      "2026-03-31",
      "2026-04-01",
    ]);
    // A fixture at 00:30 UTC on the 29th is 01:30 BST on the 29th — inside the range.
    expect(kickoffFallsOn("2026-03-29T00:30:00Z", keys)).toBe(true);
    expect(kickoffFallsOn("2026-04-02T12:00:00Z", keys)).toBe(false);
  });

  test("adding days never drifts across a month boundary", () => {
    expect(addDaysToDayKey("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDaysToDayKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysToDayKey("2026-03-28", 1)).toBe("2026-03-29");
  });

  test("a day key and a kick-off agree for a fixture at London midnight", () => {
    expect(londonDayKey("2026-11-03T00:00:00Z")).toBe("2026-11-03");
    expect(londonDayKey("2026-07-01T23:30:00Z")).toBe("2026-07-02"); // BST: 00:30 next day
  });
});

describe("REGRESSION — the Norrie row the owner saw must never appear", () => {
  // Reported from the live dashboard on 2026-11-02: a Cameron Norrie tennis row
  // was shown in the instant-win feed with back 1.44 and lay 1.46. That is a
  // QUALIFYING LOSS of £0.40 on a £20 stake, not a green trade — the lay price
  // is ABOVE the back price. Showing it as green is the worst failure this feed
  // can have, so it is pinned here with the owner's own numbers.
  test("back 1.44 / lay 1.46 is a loss, not a green, and is excluded", () => {
    const norrie = match("2026-11-02T13:00:00Z", {
      home: "Cameron Norrie",
      away: "Someone Else",
      outcomes: [outcome({ name: "Cameron Norrie", odds: 1.44, layOdds: 1.46 })],
    });
    const built = buildInstantWins([norrie], { now: NOW, stake: 20, commission: 0.02 });
    expect(built.rows).toHaveLength(0);
    expect(built.notGreen).toBe(1);
  });

  test("the arithmetic behind that exclusion, spelled out", () => {
    // back £20 at 1.44 → £8.80 profit if it wins; lay stake £20 at 1.46 →
    // £9.20 liability. Both sides lose £0.40. Nothing about stake or commission
    // can turn this into a green trade, because lay > back.
    const r = calcLay(1.44, 1.46, 20, 0.02);
    expect(r).not.toBeNull();
    expect(r!.profitLoss).toBeLessThan(0);
    expect(Math.abs(r!.profitLoss - -0.4)).toBeLessThan(0.01);
  });

  test("a genuine green at the same short odds still passes", () => {
    // 1.46 back / 1.44 lay — the mirror image — IS green and must survive the fix.
    const green = match("2026-11-02T13:00:00Z", {
      outcomes: [outcome({ name: "Home", odds: 1.46, layOdds: 1.44 })],
    });
    const built = buildInstantWins([green], { now: NOW, stake: 20, commission: 0.02 });
    expect(built.rows).toHaveLength(1);
    expect(built.rows[0].profitLoss).toBeGreaterThan(0);
    expect(built.rows[0].layOdds).toBeLessThan(built.rows[0].backOdds);
  });
});
