import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calcDutch, calcDutchFreeBet } from "../src/lib/odds";

/**
 * /oddsmatcher USED TO PRINT £10 THE VISITOR NEVER TYPED.
 *
 * Every card is worked out from one number: the free bet in free-bet mode, or
 * the stake on the ⭐ favourite in cash mode. Those amounts were invisible
 * defaults of 10 inside calcDutchFreeBet / calcDutch, and the free-bet row
 * carried a hard-coded label `— FREE BET £10`. So a logged-in user saw £10,
 * £35.00, £156.86 and a profit figure, with nothing on the page saying which
 * number was theirs and no way to change it.
 *
 * The fix: one visible amount box, starting at £10, labelled with its default,
 * and the typed amount passed straight through to the calculators. These tests
 * are what stops the hidden default creeping back — the page must not call the
 * calculators without an amount, and no money label may be hard-coded in it.
 */

const ROOT = join(import.meta.dir, "..");
const PAGE = readFileSync(join(ROOT, "src/pages/Oddsmatcher.tsx"), "utf8");

describe("/oddsmatcher passes the user's own amount to the calculators", () => {
  test("both calculators are called with the amount, never with the bare default", () => {
    expect(PAGE).toContain("calcDutchFreeBet(oddsArr, amount)");
    expect(PAGE).toContain("calcDutch(oddsArr, amount)");
    expect(PAGE).not.toContain("calcDutchFreeBet(oddsArr)");
    expect(PAGE).not.toContain("calcDutch(oddsArr)");
  });

  test("the amount box says its default and invites any number", () => {
    expect(PAGE).toContain("default £");
    expect(PAGE).toContain("change it to anything");
    // The box exists and is labelled for screen readers in both modes.
    expect(PAGE).toContain('aria-label={freeBetMode ? "Free bet amount in pounds"');
  });

  test("no money figure is hard-coded in the page any more", () => {
    // Every rendered £ must come from the user's amount. The only literal
    // money left is the deliberately hypothetical "a £200 free bet would get
    // £200-sized stakes" in the no-cap explainer, so strip that sentence and
    // what remains must contain no "£<digit>" at all.
    const withoutHypothetical = PAGE.replace(/\/\*[\s\S]*?\*\//g, "") // code comments talk about the old £10
      .replace(
        /Nothing is capped or rescaled: a £200 free bet would get £200-sized stakes\./,
        ""
      );
    expect(PAGE).toContain("a £200 free bet would get"); // the sentence still exists
    expect(withoutHypothetical.match(/£\d/g) ?? []).toEqual([]);
    // The default shown in the label is interpolated, not typed.
    expect(PAGE).toContain("(default £{freeBetMode ? DEFAULT_FREE_BET : DEFAULT_CASH_STAKE}");
  });

  test("the default really is £10 and it is only a starting value", () => {
    expect(PAGE).toContain("const DEFAULT_FREE_BET = 10;");
    expect(PAGE).toContain("const DEFAULT_CASH_STAKE = 10;");
    // MAX_ALLOWED stayed removed: no cap on what the user can type.
    expect(PAGE).not.toContain("MAX_ALLOWED");
  });
});

describe("a user's amount is honoured exactly, so the figures follow it", () => {
  const odds = [5.2, 1.2];

  test("a £10 free bet and a £25 free bet produce different, proportional stakes", () => {
    const ten = calcDutchFreeBet(odds, 10);
    const twentyFive = calcDutchFreeBet(odds, 25);
    expect(ten.freeBetIndex).toBe(twentyFive.freeBetIndex);
    // SNR: the free bet returns amount × (odds − 1).
    expect(ten.freeBetReturn).toBeCloseTo(42, 2);
    expect(twentyFive.freeBetReturn).toBeCloseTo(105, 2);
    // Cash stake = freeBetReturn ÷ the other outcome's odds — no cap, no rescale.
    const cashIndex = twentyFive.freeBetReturn / odds[1];
    expect(twentyFive.stakes[1]).toBeCloseTo(cashIndex, 2);
    expect(twentyFive.totalCashStake).toBeLessThan(cashIndex + 0.01);
    expect(twentyFive.stakes[1]).toBeGreaterThan(ten.stakes[1]);
    // Profit scales with the free bet (7 at £10 → 17.50 at £25).
    expect(ten.netProfit).toBeCloseTo(7, 2);
    expect(twentyFive.netProfit).toBeCloseTo(17.5, 2);
  });

  test("a cash stake of £50 puts £50 on the favourite, not £10", () => {
    const result = calcDutch(odds, 50);
    expect(result.stakes[result.favIndex]).toBe(50);
    // The other outcome is staked to return the same: favStake × favOdds ÷ otherOdds.
    expect(result.totalStake).toBeCloseTo(50 + (50 * odds[1]) / odds[0], 2);
  });

  test("a stake far above the old £20 cap is not scaled down", () => {
    const big = calcDutchFreeBet(odds, 200);
    // Old MAX_ALLOWED would have squeezed the largest stake to £20.
    expect(Math.max(...big.stakes)).toBeGreaterThan(20);
    expect(big.freeBetReturn).toBeCloseTo(200 * (odds[0] - 1), 2);
  });
});
