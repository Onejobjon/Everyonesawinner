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
  /**
   * What the exchange lay WINS (after commission) if this leg's outcome fails —
   * i.e. the gross win that offsets the earlier legs' liabilities and leaves the
   * guaranteed retained profit. = layStake × (1 − commission).
   */
  layWin: number;
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
    const layWin = layStake * (1 - commission);
    return { backOdds: l.backOdds, layOdds: l.layOdds, layStake, liability, layWin };
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
      layWin: round2(lp.layWin),
    })),
    totalLiability: round2(totalLiability),
  };
}

/**
 * Build the sequential-lay plan for a PAID (real-money) accumulator — the
 * user's own back stake is at risk, so the locked-in figure is a qualifying
 * profit/loss (usually a small negative cost), not a retained free-bet profit.
 *
 * Back the acca with your own money S at combined odds B, then lay each leg in
 * order. Lay stakes are sized so the net result is identical whether the acca
 * wins or any leg loses:
 *
 *   γ₁ = 1,  γₖ = γₖ₋₁ · (lₖ₋₁ − c) / (1 − c)
 *   R  = Σ γₖ · (lₖ − 1)
 *   locked-in P = S · [(B−1)(1−c) − R] / [(1−c) + R]
 *   lay stake Lₖ = γₖ · (P + S) / (1 − c)
 *
 * `retainedProfit` in the returned plan is this locked-in P (negative when the
 * lay is tight = a qualifying cost). Returns null when any leg has no usable
 * lay price (we never fabricate one).
 */
export function sequentialLayPlanPaid(
  legs: AccaLeg[],
  backStake: number,
  commission: number = COMMISSION
): AccaPlan | null {
  if (legs.length === 0) return null;
  if (backStake <= 0) return null;
  for (const l of legs) {
    if (l.backOdds <= 1) return null;
    if (!l.layOdds || l.layOdds <= commission) return null;
  }
  const B = combinedBackOdds(legs);
  const c = commission;
  // Forward coefficients γₖ — lay stakes scale with (P + S).
  const gamma: number[] = [];
  for (let i = 0; i < legs.length; i++) {
    if (i === 0) {
      gamma.push(1);
    } else {
      gamma.push(gamma[i - 1] * (legs[i - 1].layOdds - c) / (1 - c));
    }
  }
  const R = legs.reduce((sum, l, i) => sum + gamma[i] * (l.layOdds - 1), 0);
  const grossReturn = backStake * (B - 1); // back profit if the acca wins
  const lockedIn = (backStake * ((B - 1) * (1 - c) - R)) / ((1 - c) + R);
  const base = (lockedIn + backStake) / (1 - c); // = L₁ since γ₁ = 1
  const legPlans: AccaLegPlan[] = legs.map((l, i) => {
    const layStake = gamma[i] * base;
    const liability = layStake * (l.layOdds - 1);
    const layWin = layStake * (1 - c);
    return { backOdds: l.backOdds, layOdds: l.layOdds, layStake, liability, layWin };
  });
  const totalLiability = legPlans.reduce((sum, lp) => sum + lp.liability, 0);
  return {
    combinedBackOdds: round2(B),
    grossReturn: round2(grossReturn),
    retainedProfit: round2(lockedIn),
    retention: grossReturn > 0 ? lockedIn / grossReturn : 0, // negative when a cost
    legs: legPlans.map((lp) => ({
      ...lp,
      layStake: round2(lp.layStake),
      liability: round2(lp.liability),
      layWin: round2(lp.layWin),
    })),
    totalLiability: round2(totalLiability),
  };
}
