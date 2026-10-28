import { describe, expect, test } from "bun:test";
import { calcProfit } from "../src/pages/Calculator";

/**
 * The calculator used to print the MIDPOINT of the two outcomes — a number
 * nobody receives. The headline is now the WORSE of the two, because that is
 * the only figure guaranteed whichever way the bet goes.
 *
 * Defaults on the page: £10 stake, 3.00 bookmaker, 3.10 exchange, 2% commission.
 */
const DEFAULTS = { stake: 10, backOdds: 3.0, layOdds: 3.1, comm: 2 };

describe("calculator headline", () => {
  test("default inputs do NOT print a positive figure", () => {
    const r = calcProfit(DEFAULTS.stake, DEFAULTS.backOdds, DEFAULTS.layOdds, DEFAULTS.comm);
    expect(r.profit).toBeLessThan(0);
  });

  test("headline equals min(backWin, layWin)", () => {
    const r = calcProfit(DEFAULTS.stake, DEFAULTS.backOdds, DEFAULTS.layOdds, DEFAULTS.comm);
    expect(r.profit).toBe(Math.round(Math.min(r.backWin, r.layWin) * 100) / 100);
    expect(r.profit).toBe(Math.min(r.backWin, r.layWin));
  });

  test("both outcomes balance: the calculator agrees with the Lay Bet Finder", () => {
    // Once the lay stake includes commission (the formula calcLay uses), the two
    // outcomes must land in the same place to within a penny. The OLD formula had
    // no commission term, so they diverged — and this calculator quoted a
    // different loss from the finder for an identical bet.
    const r = calcProfit(DEFAULTS.stake, DEFAULTS.backOdds, DEFAULTS.layOdds, DEFAULTS.comm);
    expect(Math.abs(r.backWin - r.layWin)).toBeLessThanOrEqual(0.01);
    expect(r.profit).toBe(Math.min(r.backWin, r.layWin));
  });

  test("commission is charged: a 5% exchange costs more than a 2% one", () => {
    const two = calcProfit(10, 3.0, 3.1, 2);
    const five = calcProfit(10, 3.0, 3.1, 5);
    expect(five.profit).toBeLessThan(two.profit);
  });

  test("the lay stake is shorter than the back stake, as the formula requires", () => {
    const r = calcProfit(20, 2.0, 2.05, 2);
    expect(r.layStake).toBeLessThan(20);
    expect(r.layStake).toBeGreaterThan(19);
  });

  test("a genuinely good match still reports the smaller (but positive) side", () => {
    // 2.00 back / 2.02 lay: both sides land just under break-even-ish profit
    const r = calcProfit(10, 2.0, 2.02, 2);
    expect(r.profit).toBe(Math.min(r.backWin, r.layWin));
    expect(r.layStake).toBeGreaterThan(0);
    expect(r.liability).toBeGreaterThan(0);
  });
});
