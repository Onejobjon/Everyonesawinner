import { describe, expect, test } from "bun:test";
import {
  DEFAULT_COMMISSION,
  calcFreeBetProfit,
  calcLay,
  qualifiesForLay,
} from "../src/lib/odds";
import { findOpportunities } from "../src/server/alerts";
import type { Match, MatchOutcome } from "../src/lib/odds-api";
import {
  DEFAULT_COMMISSION_PCT,
  clampCommissionPct,
  formatCommissionPct,
  pctToRate,
} from "../src/lib/commission";

/**
 * EXCHANGE COMMISSION — 2%, not 5% (owner directive 2026-10-28).
 *
 * The point of these tests is NOT that the constant changed. It is that the
 * rate actually moves the money, in the right direction, by an amount a reader
 * can check by hand — and that the site never assumes a rate silently.
 *
 * The arithmetic, worked once and reused below:
 *
 *   Lay stake   L = (stake × backOdds) / (layOdds − c)
 *   Liability   = L × (layOdds − 1)
 *   P/L         = stake × (backOdds − 1) − liability
 *
 * At £10, back 2.00, lay 2.10:
 *   c = 2%: L = 20 / 2.08 = 9.615384…  liability = 10.576923…  P/L = −0.576923…
 *   c = 5%: L = 20 / 2.05 = 9.756097…  liability = 10.731707…  P/L = −0.731707…
 *   the difference is exactly 22 × (1/2.05 − 1/2.08) = 0.66 / 4.264 = 0.154784…
 *
 * The 2% figures are the BETTER ones (a smaller lay stake funds the same back
 * return, so less is lost to commission). If a future change ever made 2% look
 * worse than 5%, these tests fail — which is the whole point.
 */
describe("commission moves the money (back 2.00 / lay 2.10 / £10 stake)", () => {
  const STAKE = 10;
  const BACK = 2.0;
  const LAY = 2.1;

  // Exact expected values, computed as fractions so the reader can check them.
  const layStakeAt = (c: number) => (STAKE * BACK) / (LAY - c);
  const liabilityAt = (c: number) => layStakeAt(c) * (LAY - 1);
  const profitAt = (c: number) => STAKE * (BACK - 1) - liabilityAt(c);

  test("the site's default rate is 2%, and every call falls back to it", () => {
    expect(DEFAULT_COMMISSION).toBe(0.02);
    // No 4th argument → the default rate is used.
    expect(calcLay(BACK, LAY, STAKE)).toEqual(calcLay(BACK, LAY, STAKE, 0.02));
  });

  test("lay stake at 2% is 20/2.08 = 9.615384…, exactly 20/2.08 − 20/2.05 less than at 5%", () => {
    const two = calcLay(BACK, LAY, STAKE, 0.02)!;
    const five = calcLay(BACK, LAY, STAKE, 0.05)!;
    expect(two.layStake).toBeCloseTo(layStakeAt(0.02), 10);
    expect(two.layStake).toBeCloseTo(9.615384615, 8);
    expect(five.layStake).toBeCloseTo(9.75609756, 8);
    // Difference = 20/2.08 − 20/2.05 = 0.1407129…
    expect(five.layStake - two.layStake).toBeCloseTo(20 / 2.05 - 20 / 2.08, 10);
    expect(two.layStake).toBeLessThan(five.layStake);
  });

  test("both outcomes at 2% are better by exactly 0.66/4.264 = 0.154784…", () => {
    const two = calcLay(BACK, LAY, STAKE, 0.02)!;
    const five = calcLay(BACK, LAY, STAKE, 0.05)!;

    // Liability: 10.576923… at 2% vs 10.731707… at 5%.
    expect(two.liability).toBeCloseTo(10.576923077, 8);
    expect(five.liability).toBeCloseTo(10.731707317, 8);
    expect(five.liability - two.liability).toBeCloseTo(0.66 / 4.264, 10);

    // Both outcomes: back bet wins vs lay bet wins. The lay-side outcome is
    // stake − liability at these prices (the lay wins the stake back), and the
    // back-side outcome is the same £10 either way.
    expect(two.profitLoss).toBeCloseTo(profitAt(0.02), 10);
    expect(five.profitLoss).toBeCloseTo(profitAt(0.05), 10);
    expect(two.profitLoss).toBeGreaterThan(five.profitLoss);
    expect(two.profitLoss - five.profitLoss).toBeCloseTo(0.66 / 4.264, 10);
  });

  test("a 2% user who is quoted 5% figures is under-told their loss, never over-told their profit", () => {
    // The honesty rule from the plan: the site must not overstate what a user
    // gets. At these prices the 5% row is the WORSE one, so a site quoting 2%
    // to someone who pays 5% is optimistic — which is exactly why the rate is
    // shown on every figure and adjustable.
    const two = calcLay(BACK, LAY, STAKE, 0.02)!;
    const five = calcLay(BACK, LAY, STAKE, 0.05)!;
    expect(two.profitLoss).toBeGreaterThan(five.profitLoss);
  });

  test("qualifiesForLay accepts the same rows at either rate (the rate is not a filter)", () => {
    expect(qualifiesForLay(2.0, 2.1, 0.02)).toBe(qualifiesForLay(2.0, 2.1, 0.05));
    // …but a lay price at or below the commission is still nonsense.
    expect(qualifiesForLay(0.03, 0.02, 0.02)).toBe(false);
  });
});

describe("free-bet maths at 2% vs 5%", () => {
  // 30% free bet (SNR) at back 3.00 / lay 3.10, £10 stake:
  //   c = 2%: 10 × 2 × 0.98 / 3.08 = 6.363636…
  //   c = 5%: 10 × 2 × 0.95 / 3.05 = 6.229508…
  const STAKE = 10;
  const BACK = 3.0;
  const LAY = 3.1;

  test("the 2% figure is strictly larger, and equals 19.6/3.08", () => {
    const two = calcFreeBetProfit(BACK, LAY, STAKE, 0.02)!;
    const five = calcFreeBetProfit(BACK, LAY, STAKE, 0.05)!;
    expect(two).toBeCloseTo((STAKE * (BACK - 1) * (1 - 0.02)) / (LAY - 0.02), 10);
    expect(two).toBeCloseTo(6.363636364, 8);
    expect(five).toBeCloseTo(6.229508197, 8);
    expect(two).toBeGreaterThan(five);
    // Difference = 19.6/3.08 − 19/3.05 = 0.134128…
    expect(two - five).toBeCloseTo(19.6 / 3.08 - 19 / 3.05, 10);
  });

  test("a returned-stake free bet moves the same way", () => {
    const two = calcFreeBetProfit(BACK, LAY, STAKE, 0.02, "sr")!;
    const five = calcFreeBetProfit(BACK, LAY, STAKE, 0.05, "sr")!;
    expect(two).toBeGreaterThan(five);
    expect(two).toBeCloseTo((STAKE * BACK * 0.98) / (LAY - 0.02), 10);
  });

  test("the default (no commission argument) is the 2% figure", () => {
    expect(calcFreeBetProfit(BACK, LAY, STAKE)).toBe(calcFreeBetProfit(BACK, LAY, STAKE, 0.02));
  });
});

describe("the alert worker's green-cash rule at 2% vs 5%", () => {
  /**
   * The green-cash test is `calcLay(...).profitLoss > 0`, which is algebraically
   *
   *     back − lay > c × (back − 1)
   *
   * At back 2.00 that means lay < 1.98 at 2%, but lay < 1.95 at 5%. A lay of
   * 1.97 therefore qualifies at 2% and does NOT at 5%:
   *   c = 2%: L = 20 × 2.00 / 1.95 = 20.5128…, liability = 19.8974…, P/L = +0.1026
   *   c = 5%: L = 20 × 2.00 / 1.92 = 20.8333…, liability = 20.2083…, P/L = −0.2083
   * (20 × (2.00 − 1) = £20 back profit in both cases.)
   */
  const OUTCOME: MatchOutcome = {
    name: "Home",
    odds: 2.0,
    return20: 40,
    bookmaker: "Betfred",
    layOdds: 1.97,
    laySource: "Betfair",
    layBookmakerKey: "betfair_ex_uk",
    backLastUpdate: new Date().toISOString(),
    layLastUpdate: new Date().toISOString(),
    bookmakerOdds: [],
  };
  const MATCH: Match = {
    matchId: "test-match",
    home: "Home",
    away: "Away",
    league: "Test League",
    leagueKey: "soccer_epl",
    sportKey: "soccer_epl",
    time: "20:00",
    // Comfortably in the future so the kickoff/actionability guards do not skip it.
    commenceTime: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    outcomes: [OUTCOME],
    hasLayCoverage: true,
  };

  test("the row is green-cash at 2% and is NOT at 5%", () => {
    const atTwo = findOpportunities([MATCH], 0.02);
    const atFive = findOpportunities([MATCH], 0.05);
    expect(atTwo.opps.filter((o) => o.type === "cash").length).toBe(1);
    expect(atFive.opps.filter((o) => o.type === "cash").length).toBe(0);
  });

  test("the 2% cash alert reports the exact profit (+0.102564… on a £20 stake)", () => {
    const opp = findOpportunities([MATCH], 0.02).opps.find((o) => o.type === "cash");
    expect(opp).toBeDefined();
    // 20 − (20×2.00/1.95)×0.97 = 20 − 19.897435… = +0.102564…, reported to 2dp.
    expect((opp as { expectedProfit: number }).expectedProfit).toBe(0.1);
    expect((opp as { expectedProfit: number }).expectedProfit).toBeGreaterThan(0);
    expect((opp as { expectedProfit: number }).expectedProfit).toBeGreaterThan(0);
  });

  test("the default rate is 2% (no argument), matching the alert worker", () => {
    const byDefault = findOpportunities([MATCH]);
    const atTwo = findOpportunities([MATCH], 0.02);
    expect(byDefault.opps.length).toBe(atTwo.opps.length);
    expect(byDefault.opps.filter((o) => o.type === "cash").length).toBe(1);
  });
});

describe("the shared commission control's number handling", () => {
  test("the control's default is 2% and it converts to a 0.02 fraction", () => {
    expect(DEFAULT_COMMISSION_PCT).toBe(2);
    expect(pctToRate(2)).toBe(0.02);
    expect(pctToRate(2)).toBe(DEFAULT_COMMISSION);
  });

  test("it is clamped to 0–10% so a typo cannot produce an absurd figure", () => {
    expect(clampCommissionPct(-5)).toBe(0);
    expect(clampCommissionPct(400)).toBe(10);
    expect(clampCommissionPct(Number.NaN)).toBe(2);
    expect(pctToRate(4.5)).toBe(0.045);
  });

  test("the rate prints without a trailing zero", () => {
    expect(formatCommissionPct(2)).toBe("2%");
    expect(formatCommissionPct(2.5)).toBe("2.5%");
    expect(formatCommissionPct(5)).toBe("5%");
  });
});
