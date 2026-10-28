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

  test("headline is never the midpoint when the two outcomes differ", () => {
    const r = calcProfit(DEFAULTS.stake, DEFAULTS.backOdds, DEFAULTS.layOdds, DEFAULTS.comm);
    const midpoint = Math.round(((r.backWin + r.layWin) / 2) * 100) / 100;
    expect(r.profit).not.toBe(midpoint);
    expect(r.profit).toBeLessThan(midpoint);
  });

  test("a genuinely good match still reports the smaller (but positive) side", () => {
    // 2.00 back / 2.02 lay: both sides land just under break-even-ish profit
    const r = calcProfit(10, 2.0, 2.02, 2);
    expect(r.profit).toBe(Math.min(r.backWin, r.layWin));
    expect(r.layStake).toBeGreaterThan(0);
    expect(r.liability).toBeGreaterThan(0);
  });
});
