/**
 * Acca (accumulator) maths for the Acca Finder.
 *
 * The finder builds cross-match accumulators from free bets and lays them
 * leg-by-leg on the exchange. This module holds the maths — it uses the SAME
 * 5% commission (COMMISSION from odds.ts) and the SAME stake-not-returned (SNR)
 * convention as the rest of the site, so every number on the page agrees with
 * the oddsmatcher / lay-bet finder.
 */

import { COMMISSION, round2 } from "./odds";

/** One leg of an accumulator: decimal back odds and exchange lay odds. */
export interface AccaLeg {
  backOdds: number;
  layOdds: number;
}

/** The lay plan for a single leg, in the order it should be laid. */
export interface AccaLegPlan {
  backOdds: number;
  layOdds: number;
  /** Amount to lay on the exchange for this leg. */
  layStake: number;
  /** What you risk on this leg's lay = layStake × (layOdds − 1). */
  liability: number;
}

export interface AccaPlan {
  /** Product of every leg's back odds. */
  combinedBackOdds: number;
  /** Return from the free bet if the acca wins (SNR: freeStake × (odds − 1)). */
  grossReturn: number;
  /**
   * Guaranteed retained profit. Because the lays are sequential and sized
   * correctly, this is the SAME whether the acca wins or any leg loses.
   */
  retainedProfit: number;
  /** Share of the free-bet value kept = retainedProfit / grossReturn (0–1). */
  retention: number;
  /** Per-leg lay plan, in the order the legs must be laid. */
  legs: AccaLegPlan[];
  /** Sum of every leg's liability — the worst-case exchange outlay if the acca wins. */
  totalLiability: number;
}

/**
 * Combined back odds for an acca = the product of each leg's back odds.
 */
export function combinedBackOdds(legs: { backOdds: number }[]): number {
  return legs.reduce((acc, l) => acc * l.backOdds, 1);
}

/**
 * Build the sequential-lay plan for a free-bet (SNR) accumulator.
 *
 * The acca is laid leg-by-leg, in order: lay leg 1, and only if it wins, lay
 * leg 2, and so on. The lay stakes are sized so the net result is a single
 * locked-in profit regardless of when (or whether) the acca fails. This is the
 * standard "sequential lay" used to extract value from a free-bet acca.
 *
 *   α₁ = 1 / (1 − c)
 *   αₖ = [1 + Σ_{i<k} αᵢ·(lᵢ−1)] / (1 − c)
 *   S  = Σ αᵢ·(lᵢ−1)
 *   retained profit P = freeStake · (B − 1) / (1 + S)
 *   lay stake for leg k = αₖ · P
 *
 * Returns null when any leg has no usable lay price (we never fabricate one).
 */
export function sequentialLayPlan(
  legs: AccaLeg[],
  freeStake: number,
  commission: number = COMMISSION
): AccaPlan | null {
  if (legs.length === 0) return null;
  if (freeStake <= 0) return null;
  for (const l of legs) {
    if (l.backOdds <= 1) return null;
    if (!l.layOdds || l.layOdds <= commission) return null;
  }

  const B = combinedBackOdds(legs);
  const grossReturn = freeStake * (B - 1); // SNR: stake not returned

  // Forward coefficients — lay stakes scale linearly with the retained profit.
  const alpha: number[] = [];
  let s = 0; // running Σ αᵢ·(lᵢ−1)
  for (const l of legs) {
    const a = (1 + s) / (1 - commission);
    alpha.push(a);
    s += a * (l.layOdds - 1);
  }

  const retainedProfit = grossReturn / (1 + s);

  const legPlans: AccaLegPlan[] = legs.map((l, i) => {
    const layStake = alpha[i] * retainedProfit;
    const liability = layStake * (l.layOdds - 1);
    return { backOdds: l.backOdds, layOdds: l.layOdds, layStake, liability };
  });

  const totalLiability = legPlans.reduce((sum, lp) => sum + lp.liability, 0);

  return {
    combinedBackOdds: round2(B),
    grossReturn: round2(grossReturn),
    retainedProfit: round2(retainedProfit),
    retention: grossReturn > 0 ? retainedProfit / grossReturn : 0,
    legs: legPlans.map((lp) => ({
      ...lp,
      layStake: round2(lp.layStake),
      liability: round2(lp.liability),
    })),
    totalLiability: round2(totalLiability),
  };
}
