import { describe, expect, test } from "bun:test";
import {
  calcDutch,
  calcDutchFreeBet,
  calcFreeBetProfit,
  calcLay,
  DEFAULT_COMMISSION,
} from "../src/lib/odds";
import {
  checkBackLayPair,
  excludeLaySource,
  isSameBookmakerKey,
} from "../src/lib/odds-sanity";
import { transformMatches, type Match, type MatchOutcome } from "../src/lib/odds-api";
import { findOpportunities } from "../src/server/alerts";

/**
 * WAVE 5 — two defects that both made the site quietly misreport money.
 *
 * ITEM 1: every stake was capped at £20 and silently rescaled, so a user who
 * typed £100 was shown £20 figures and never told. The owner's promise is
 * "users enter any stake they like — not a fixed £20 — and see exactly what it
 * returns", so the cap is gone and only nonsense stakes are rejected.
 *
 * ITEM 2: an exchange could be its own "best back price" — Betfair 2.66 backed
 * against Betfair's own 2.70 lay. Real cached rows did this in 2 of 7 pairs.
 * Backing and laying the same exchange is a guaranteed small loss, so the lay
 * source is excluded from best-back selection by its ACTUAL feed key.
 */

// ── ITEM 1 — any stake, honoured exactly ───────────────────────────────────

describe("ITEM 1: the £20 cap is gone — stakes are honoured exactly", () => {
  const BACK = 2.0;
  const LAY = 2.05;

  test("a £100 stake at back 2.00 / lay 2.05 gives £100-stake figures", () => {
    // L = 100 × 2.00 / (2.05 − 0.02) = 200 / 2.03 = 98.522167… (NOT ~19.70)
    // liability = 98.522167… × 1.05 = 103.448275…
    // P/L = 100 × 1.00 − 103.448275… = −3.448275…
    const r = calcLay(BACK, LAY, 100, DEFAULT_COMMISSION)!;
    expect(r).not.toBeNull();
    expect(r.layStake).toBeCloseTo(200 / 2.03, 10);
    expect(r.layStake).toBeCloseTo(98.5221674877, 8);
    expect(r.liability).toBeCloseTo((200 / 2.03) * 1.05, 10);
    expect(r.liability).toBeCloseTo(103.4482758621, 8);
    expect(r.profitLoss).toBeCloseTo(100 - (200 / 2.03) * 1.05, 10);
    expect(r.profitLoss).toBeCloseTo(-3.4482758621, 8);
    // The old cap produced a lay stake of about £19.70 for this pair; this is
    // the assertion that would have failed before the fix.
    expect(r.layStake).toBeGreaterThan(90);
  });

  test("a £100 dutch keeps £100 on the favourite — no proportional rescale", () => {
    // Favourite 2.00 at £100, other leg 200/2.05 = 97.560975…
    const d = calcDutch([2.0, 2.05], 100);
    expect(d.favIndex).toBe(0);
    expect(d.stakes[0]).toBe(100);
    expect(d.stakes[1]).toBeCloseTo(200 / 2.05, 10);
    expect(d.totalStake).toBeCloseTo(100 + 200 / 2.05, 10);
    // Under the cap this total was exactly 20 and stakes[0] was ~10.13.
    expect(d.totalStake).toBeGreaterThan(100);
    // Equalised return on both outcomes = 100 × 2.00.
    expect(d.stakes[0] * 2.0).toBeCloseTo(d.stakes[1] * 2.05, 10);
    expect(d.guaranteedReturn).toBeCloseTo(200, 10);
  });

  test("a £100 free-bet dutch also keeps its size", () => {
    const d = calcDutchFreeBet([2.0, 2.05], 100);
    // The planner puts the free bet where the net is best: on 2.05 (SNR return
    // 100 × 1.05 = 105), cash leg 105 / 2.00 = 52.50, guaranteed 105 either way.
    expect(d.freeBetIndex).toBe(1);
    expect(d.freeBetReturn).toBeCloseTo(105, 10);
    expect(Math.max(...d.stakes)).toBeCloseTo(52.5, 10);
    expect(d.totalCashStake).toBeCloseTo(52.5, 10);
    expect(d.netProfit).toBeCloseTo(52.5, 10);
    // Under the cap every cash stake was scaled to a £20 maximum.
    expect(d.totalCashStake).toBeGreaterThan(20);
  });

  test("£500 scales linearly against £50 — exactly 10×", () => {
    const big = calcLay(BACK, LAY, 500, DEFAULT_COMMISSION)!;
    const small = calcLay(BACK, LAY, 50, DEFAULT_COMMISSION)!;
    expect(big.layStake).toBeCloseTo(small.layStake * 10, 6);
    expect(big.liability).toBeCloseTo(small.liability * 10, 6);
    expect(big.profitLoss).toBeCloseTo(small.profitLoss * 10, 6);

    const bigBet = calcFreeBetProfit(BACK, LAY, 500)!;
    const smallBet = calcFreeBetProfit(BACK, LAY, 50)!;
    expect(bigBet).toBeCloseTo(smallBet * 10, 6);

    const bigDutch = calcDutch([1.9, 2.4, 3.6], 500);
    const smallDutch = calcDutch([1.9, 2.4, 3.6], 50);
    expect(bigDutch.totalStake).toBeCloseTo(smallDutch.totalStake * 10, 6);
    expect(bigDutch.guaranteedReturn).toBeCloseTo(smallDutch.guaranteedReturn * 10, 6);
    expect(bigDutch.netProfit).toBeCloseTo(smallDutch.netProfit * 10, 6);

    const bigFree = calcDutchFreeBet([1.9, 2.4, 3.6], 500);
    const smallFree = calcDutchFreeBet([1.9, 2.4, 3.6], 50);
    expect(bigFree.totalCashStake).toBeCloseTo(smallFree.totalCashStake * 10, 6);
    expect(bigFree.netProfit).toBeCloseTo(smallFree.netProfit * 10, 6);
  });

  test("invalid stakes are rejected, never rescaled into a £20 bet", () => {
    // Null-returning calculators: a rejection, not a number.
    expect(calcLay(BACK, LAY, 0)).toBeNull();
    expect(calcLay(BACK, LAY, -5)).toBeNull();
    expect(calcLay(BACK, LAY, Number.NaN)).toBeNull();
    expect(calcLay(BACK, LAY, Number.POSITIVE_INFINITY)).toBeNull();
    expect(calcFreeBetProfit(BACK, LAY, 0)).toBeNull();
    expect(calcFreeBetProfit(BACK, LAY, Number.NaN)).toBeNull();

    // Throwing calculators: a RangeError, never a silent £20-sized answer.
    expect(() => calcDutch([2.0, 3.0], 0)).toThrow(RangeError);
    expect(() => calcDutch([2.0, 3.0], -1)).toThrow(RangeError);
    expect(() => calcDutch([2.0, 3.0], Number.NaN)).toThrow(RangeError);
    expect(() => calcDutch([2.0, 3.0], Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => calcDutchFreeBet([2.0, 3.0], 0)).toThrow(RangeError);
    expect(() => calcDutchFreeBet([2.0, 3.0], Number.NaN)).toThrow(RangeError);
  });

  test("the odds sanity rule is untouched: 451 is still not a price", () => {
    // A price-level guard, not a money-level one — unchanged by removing the cap.
    expect(checkBackLayPair(451, 2.5).verdict).toBe("bad_back");
    expect(checkBackLayPair(1.0, 2.5).verdict).toBe("bad_back");
    expect(checkBackLayPair(2.5, 451).verdict).toBe("sentinel_lay");
    expect(checkBackLayPair(2.5, 2.6).verdict).toBe("ok");
  });
});

// ── ITEM 2 — the exchange is never its own back price ──────────────────────

describe("ITEM 2: an exchange can never be its own best back price", () => {
  test("the exact cached case is rejected: back 2.66 Betfair / lay 2.70 Betfair", () => {
    const pair = checkBackLayPair(2.66, 2.7, "betfair_ex_uk", "betfair_ex_uk");
    expect(pair.verdict).toBe("back_is_lay_source");
    expect(pair.suspect).toBe(true);
    expect(pair.reason).toContain("betfair_ex_uk");
  });

  test("the same exchange under any of its keys is rejected, case/space-insensitively", () => {
    expect(isSameBookmakerKey(" Betfair_EX_UK ", "betfair_ex_uk")).toBe(true);
    expect(checkBackLayPair(2.66, 2.7, "SMARKETS", "smarkets").suspect).toBe(true);
    expect(checkBackLayPair(2.66, 2.7, "matchbook", "matchbook").suspect).toBe(true);
    // Different books on each side is a real pair — unchanged, and "ok".
    const ok = checkBackLayPair(2.7, 2.75, "williamhill", "betfair_ex_uk");
    expect(ok.verdict).toBe("ok");
    expect(ok.suspect).toBe(false);
    // Missing keys must never be treated as a match.
    expect(checkBackLayPair(2.66, 2.7).verdict).toBe("ok");
    expect(isSameBookmakerKey(undefined, "")).toBe(false);
  });

  test("excludeLaySource drops only the lay source's own prices", () => {
    const candidates = [
      { key: "betfair_ex_uk", odds: 2.66 },
      { key: "williamhill", odds: 2.55 },
      { key: "paddypower", odds: 2.5 },
    ];
    const { kept, excluded } = excludeLaySource(candidates, "betfair_ex_uk");
    expect(excluded.map((c) => c.key)).toEqual(["betfair_ex_uk"]);
    expect(kept.map((c) => c.key)).toEqual(["williamhill", "paddypower"]);
    // No lay source → nothing is excluded.
    expect(excludeLaySource(candidates, null).kept.length).toBe(3);
  });

  const kickoff = () => new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

  /** Raw feed payload shaped like The Odds API's /odds response. */
  const rawMatch = (bookmakers: unknown[]) => [
    {
      id: "evt-1",
      sport_key: "soccer_epl",
      sport_title: "Premier League",
      commence_time: kickoff(),
      home_team: "Home FC",
      away_team: "Away FC",
      bookmakers,
    },
  ];

  const bm = (key: string, title: string, prices: Record<string, number>, lays?: Record<string, number>) => ({
    key,
    title,
    last_update: new Date().toISOString(),
    markets: [
      {
        key: "h2h",
        last_update: new Date().toISOString(),
        outcomes: Object.entries(prices).map(([name, price]) => ({ name, price })),
      },
      ...(lays
        ? [
            {
              key: "h2h_lay",
              last_update: new Date().toISOString(),
              outcomes: Object.entries(lays).map(([name, price]) => ({ name, price })),
            },
          ]
        : []),
    ],
  });

  test("the transform never picks the lay exchange as the back price", () => {
    // Betfair has the HIGHEST back price (2.66) and also supplies the lay (2.70)
    // — exactly the cached defect. William Hill 2.55 must win instead.
    const matches = transformMatches(
      rawMatch([
        bm("betfair_ex_uk", "Betfair", { "Home FC": 2.66, "Away FC": 1.78 }, { "Home FC": 2.7, "Away FC": 1.8 }),
        bm("williamhill", "William Hill", { "Home FC": 2.55, "Away FC": 1.72 }),
        bm("paddypower", "Paddy Power", { "Home FC": 2.5, "Away FC": 1.74 }),
      ]) as Parameters<typeof transformMatches>[0]
    );
    expect(matches.length).toBe(1);
    const home = matches[0].outcomes.find((o) => o.name === "Home FC")!;
    expect(home.odds).toBe(2.55); // NOT Betfair's 2.66
    expect(home.bookmaker).toBe("William Hill");
    expect(home.bookmakerKey).toBe("williamhill");
    expect(home.layBookmakerKey).toBe("betfair_ex_uk");
    expect(home.backSourceExcluded).toBe(true);
    // Every row in the match: the two sides never come from the same book.
    for (const o of matches[0].outcomes) {
      expect(isSameBookmakerKey(o.bookmakerKey, o.layBookmakerKey)).toBe(false);
    }
    // The pair still qualifies as a close lay (2.70 lay vs 2.55 back).
    expect(home.layOdds).toBe(2.7);
    expect(checkBackLayPair(home.odds, home.layOdds, home.bookmakerKey, home.layBookmakerKey).verdict).toBe("ok");
  });

  test("a genuine bookmaker's best price is left completely alone", () => {
    // William Hill has the best price (2.70); Betfair is only the lay side.
    const matches = transformMatches(
      rawMatch([
        bm("williamhill", "William Hill", { "Home FC": 2.7, "Away FC": 1.66 }),
        bm("betfair_ex_uk", "Betfair", { "Home FC": 2.66, "Away FC": 1.78 }, { "Home FC": 2.75, "Away FC": 1.8 }),
      ]) as Parameters<typeof transformMatches>[0]
    );
    const home = matches[0].outcomes.find((o) => o.name === "Home FC")!;
    expect(home.odds).toBe(2.7);
    expect(home.bookmaker).toBe("William Hill");
    expect(home.layOdds).toBe(2.75);
    expect(matches[0].backWithheldAsLaySource).toBeUndefined();
  });

  test("if the exchange is the only back price, the row is withheld and said so", () => {
    // Three-way market: the draw has ONLY Betfair quoting a back price, from the
    // same exchange that lays it. It must vanish, not reappear as an "opportunity".
    const matches = transformMatches(
      rawMatch([
        bm(
          "betfair_ex_uk",
          "Betfair",
          { "Home FC": 2.66, "Away FC": 1.78, Draw: 3.4 },
          { "Home FC": 2.7, "Away FC": 1.8, Draw: 3.45 }
        ),
        bm("williamhill", "William Hill", { "Home FC": 2.55, "Away FC": 1.72 }),
      ]) as Parameters<typeof transformMatches>[0]
    );
    expect(matches.length).toBe(1);
    const names = matches[0].outcomes.map((o) => o.name);
    expect(names).not.toContain("Draw");
    expect(matches[0].backWithheldAsLaySource).toBe(1);
    expect(matches[0].outcomesWithheld).toBe(1);
    // No row anywhere in this match carries Betfair as its back price.
    for (const o of matches[0].outcomes) expect(o.bookmakerKey).not.toBe("betfair_ex_uk");
  });

  test("the alert worker refuses a same-exchange row even from a stale cache", () => {
    // back 2.50 / lay 2.45 is profitable at 2% (P/L = +0.164), so the ONLY thing
    // that can stop it alerting is the same-source rule.
    const sameExchange: MatchOutcome = {
      name: "Home",
      odds: 2.5,
      return20: 50,
      bookmaker: "Betfair",
      bookmakerKey: "betfair_ex_uk",
      layOdds: 2.45,
      laySource: "Betfair",
      layBookmakerKey: "betfair_ex_uk",
      backLastUpdate: new Date().toISOString(),
      layLastUpdate: new Date().toISOString(),
      bookmakerOdds: [],
    };
    const makeMatch = (o: MatchOutcome): Match => ({
      matchId: "m1",
      home: "Home",
      away: "Away",
      league: "Test League",
      leagueKey: "soccer_epl",
      sportKey: "soccer_epl",
      time: "20:00",
      commenceTime: kickoff(),
      outcomes: [o],
      hasLayCoverage: true,
    });

    const same = findOpportunities([makeMatch(sameExchange)], 0.02);
    expect(same.opps.length).toBe(0);
    expect(same.skippedSameSource).toBe(1);

    // Control: identical prices, but the back comes from a real bookmaker.
    const genuine = findOpportunities(
      [makeMatch({ ...sameExchange, bookmaker: "William Hill", bookmakerKey: "williamhill" })],
      0.02
    );
    expect(genuine.opps.filter((o) => o.type === "cash").length).toBe(1);
    expect(genuine.skippedSameSource).toBe(0);
  });
});
