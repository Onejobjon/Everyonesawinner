/**
 * Convert decimal odds (e.g. 2.10) to UK fractional format (e.g. "11/10")
 * 
 * decimal odds = (numerator / denominator) + 1
 * So fractional odds = decimal - 1
 * e.g. 2.10 → 1.10 → 11/10
 */
export function decimalToFractional(odds: number): string {
  if (odds <= 1) return "1/1";
  
  const fraction = odds - 1;
  
  // Handle common fractional odds with predefined precision
  const pct = Math.round(fraction * 100);
  
  // Map of common fractional odds by percentage points (rounded)
  const common: Record<number, string> = {
    1: "1/100", 2: "1/50", 3: "1/33", 4: "1/25", 5: "1/20",
    6: "1/16", 7: "1/14", 8: "2/25", 9: "1/11", 10: "1/10",
    11: "1/9", 12: "2/17", 13: "1/8", 14: "2/15", 15: "3/20",
    16: "4/25", 17: "1/6", 18: "2/11", 19: "1/5", 20: "1/5",
    22: "2/9", 25: "1/4", 27: "1/4", 29: "2/7", 30: "3/10",
    33: "1/3", 36: "4/11", 40: "2/5", 44: "4/9", 50: "1/2",
    53: "8/15", 57: "4/7", 60: "3/5", 62: "5/8", 67: "2/3",
    70: "7/10", 73: "11/15", 75: "3/4", 80: "4/5", 83: "5/6",
    85: "5/6", 88: "7/8", 90: "9/10", 91: "10/11", 95: "20/21",
    100: "1/1",
    110: "11/10", 111: "10/9", 114: "8/7", 117: "7/6", 120: "6/5",
    125: "5/4", 130: "13/10", 133: "4/3", 135: "27/20", 140: "7/5",
    143: "10/7", 150: "6/4", 150: "3/2", 160: "8/5", 167: "5/3",
    175: "7/4", 180: "9/5", 182: "11/6", 190: "19/10", 200: "2/1",
    210: "21/10", 220: "11/5", 225: "9/4", 240: "12/5", 250: "5/2",
    260: "13/5", 275: "11/4", 280: "14/5", 300: "3/1", 325: "13/4",
    333: "10/3", 350: "7/2", 375: "15/4", 400: "4/1", 450: "9/2",
    500: "5/1",
  };

  // Try exact match first, then find closest
  if (common[pct]) return common[pct];
  
  // Find closest match
  const keys = Object.keys(common).map(Number).sort((a, b) => a - b);
  let closest = keys[0];
  for (const k of keys) {
    if (Math.abs(k - pct) < Math.abs(closest - pct)) {
      closest = k;
    }
  }
  // If close enough, use the mapped value
  if (Math.abs(closest - pct) <= 5) {
    return common[closest];
  }

  // Fallback: simplify the fraction manually
  const num = Math.round(fraction * 100);
  const den = 100;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(num, den);
  return `${num / g}/${den / g}`;
}

/**
 * Format a value to display as fractional odds string
 */
export function formatOdds(odds: number): string {
  return decimalToFractional(odds);
}

/**
 * Dutching calculator — fixes £10 on the favourite (lowest odds),
 * then calculates variable stakes on other outcomes to equalise the return.
 * All stakes are capped at £20 max — if a calculated stake exceeds £20,
 * all stakes are scaled down proportionally so the max is exactly £20.
 *
 * @param oddsArr - Array of decimal odds for each outcome
 * @param favStake - Fixed stake on the favourite (default £10)
 */
export function calcDutch(
  oddsArr: number[],
  favStake = 10
): {
  stakes: number[];          // Stake per outcome (favStake for favourite, variable for others)
  favIndex: number;          // Index of the favourite outcome
  totalStake: number;        // Sum of all stakes
  guaranteedReturn: number;  // Same return regardless of which outcome wins
  netProfit: number;         // guaranteedReturn - totalStake (positive = arbitrage)
  overroundPct: number;      // (S - 1) × 100 — bookmaker margin
  isArbitrage: boolean;      // True when guaranteed profit exists
} {
  // Find the favourite — lowest decimal odds = highest implied probability
  let favIndex = 0;
  for (let i = 1; i < oddsArr.length; i++) {
    if (oddsArr[i] < oddsArr[favIndex]) favIndex = i;
  }

  const favOdds = oddsArr[favIndex];
  // Guaranteed return = favStake × favourite odds
  const guaranteedReturn = favStake * favOdds;

  // Calculate stakes for each outcome
  let stakes = oddsArr.map((odds, i) =>
    i === favIndex ? favStake : guaranteedReturn / odds
  );

  // Cap max stake at £20 using proportional scaling
  const maxStake = Math.max(...stakes);
  const MAX_ALLOWED = 20;
  if (maxStake > MAX_ALLOWED) {
    const scale = MAX_ALLOWED / maxStake;
    stakes = stakes.map((s) => s * scale);
  }

  const totalStake = stakes.reduce((sum, s) => sum + s, 0);
  // Recalculate guaranteed return: min of (stake × odds) across all outcomes
  const guaranteedReturnCapped = Math.min(...stakes.map((s, i) => s * oddsArr[i]));
  const netProfit = guaranteedReturnCapped - totalStake;

  // Overround still uses the standard formula
  const S = oddsArr.reduce((sum, o) => sum + 1 / o, 0);
  const overroundPct = (S - 1) * 100;

  return {
    stakes,
    favIndex,
    totalStake,
    guaranteedReturn: guaranteedReturnCapped,
    netProfit,
    overroundPct,
    isArbitrage: netProfit > 0,
  };
}

/**
 * Free bet dutching calculator — places a £10 SNR free bet on the most
 * profitable outcome, then calculates cash stakes on all other outcomes
 * to equalise the return. SNR means the stake is NOT returned, so the
 * free bet return = freeBetAmount × (odds - 1).
 *
 * All cash stakes are capped at £20 max — if a calculated stake exceeds £20,
 * all cash stakes are scaled down proportionally so the max is exactly £20.
 *
 * Tries all outcomes and picks the one that maximises net profit.
 *
 * @param oddsArr - Array of decimal odds for each outcome
 * @param freeBetAmount - Amount of the free bet (default £10)
 */
export function calcDutchFreeBet(
  oddsArr: number[],
  freeBetAmount = 10
): {
  stakes: number[];             // Cash stake per outcome (0 for the free bet outcome)
  freeBetIndex: number;         // Index of the outcome the free bet is placed on
  freeBetReturn: number;        // Return from the free bet (SNR: amount × (odds - 1))
  totalCashStake: number;       // Total cash outlay (sum of cash stakes)
  guaranteedReturn: number;     // Same return regardless of which outcome wins
  netProfit: number;            // guaranteedReturn - totalCashStake
  overroundPct: number;         // (S - 1) × 100 — bookmaker margin
  isArbitrage: boolean;         // True when guaranteed profit exists
} {
  const MAX_ALLOWED = 20;
  let bestResult: {
    stakes: number[];
    freeBetIndex: number;
    freeBetReturn: number;
    totalCashStake: number;
    guaranteedReturn: number;
    netProfit: number;
  } | null = null;

  // Try each outcome as the free bet target
  for (let fbIdx = 0; fbIdx < oddsArr.length; fbIdx++) {
    const fbOdds = oddsArr[fbIdx];
    // SNR: free bet returns only the profit, not the stake
    const freeBetReturn = freeBetAmount * (fbOdds - 1);

    // Calculate cash stakes for all other outcomes
    let stakes = oddsArr.map((odds, i) =>
      i === fbIdx ? 0 : freeBetReturn / odds
    );

    // Cap max cash stake at £20 using proportional scaling
    const maxStake = Math.max(...stakes);
    if (maxStake > MAX_ALLOWED) {
      const scale = MAX_ALLOWED / maxStake;
      stakes = stakes.map((s) => s * scale);
    }

    const totalCashStake = stakes.reduce((sum, s) => sum + s, 0);
    // Guaranteed return = min of freeBetReturn and (cashStake × odds) for cash outcomes
    const cashReturns = stakes.map((s, i) => (i === fbIdx ? Infinity : s * oddsArr[i]));
    const guaranteedReturn = Math.min(freeBetReturn, ...cashReturns);
    const netProfit = guaranteedReturn - totalCashStake;

    if (!bestResult || netProfit > bestResult.netProfit) {
      bestResult = { stakes, freeBetIndex: fbIdx, freeBetReturn, totalCashStake, guaranteedReturn, netProfit };
    }
  }

  if (!bestResult) throw new Error("calcDutchFreeBet: no outcomes");

  // Overround uses standard formula
  const S = oddsArr.reduce((sum, o) => sum + 1 / o, 0);
  const overroundPct = (S - 1) * 100;

  return {
    stakes: bestResult.stakes,
    freeBetIndex: bestResult.freeBetIndex,
    freeBetReturn: bestResult.freeBetReturn,
    totalCashStake: bestResult.totalCashStake,
    guaranteedReturn: bestResult.guaranteedReturn,
    netProfit: bestResult.netProfit,
    overroundPct,
    isArbitrage: bestResult.netProfit > 0,
  };
}

/**
 * Exchange commission — the DEFAULT rate the site assumes, as a fraction.
 *
 * OWNER DIRECTIVE (2026-10-28): 2% on both Smarkets and Betfair. This is only a
 * DEFAULT: Betfair charges per market (commonly 5% on the main football
 * markets, 2% on some), so a silently fixed 2% would overstate profit for a
 * user who actually pays 5% — the same failure class as the midpoint we
 * removed. Every calculation below therefore takes an explicit `commission`
 * argument, and the UI shows the rate next to the figures with a control to
 * change it.
 */
export const DEFAULT_COMMISSION = 0.02;

/** The default rate as a percentage, for UI controls (2 → "2%"). */
export const DEFAULT_COMMISSION_PCT = 2;

/**
 * Format a commission FRACTION as a percentage for display: 0.02 → "2%",
 * 0.025 → "2.5%". Never prints a trailing ".0".
 */
export function commissionPctLabel(rate: number): string {
  const pct = Math.round(rate * 1000) / 10;
  return `${pct}%`;
}

export interface LayCalc {
  /** Amount to stake on the exchange (the "lay" bet) */
  layStake: number;
  /** How much you risk on the lay bet = layStake × (layOdds − 1) */
  liability: number;
  /**
   * Qualifying profit/loss on a fixed back stake.
   * Negative = small qualifying loss (normal for matched betting),
   * positive = a value opportunity.
   */
  profitLoss: number;
}

/**
 * Matched-betting lay calculator.
 *
 * You back an outcome at the bookmaker (backOdds, fixed back stake) and lay the
 * SAME outcome on the exchange (layOdds). The lay stake below equalises the
 * result so the outcome barely matters — this is the core of matched betting.
 *
 *   layStake = (backStake × backOdds) / (layOdds − commission)
 *   liability = layStake × (layOdds − 1)
 *   profit/loss = backStake × (backOdds − 1) − layStake × (layOdds − 1)
 *
 * Returns null when there's no usable lay price (never fabricate a number).
 */
export function calcLay(
  backOdds: number,
  layOdds: number | null,
  backStake = 20,
  commission = DEFAULT_COMMISSION
): LayCalc | null {
  if (!layOdds || layOdds <= commission || backOdds <= 0) return null;
  const layStake = (backStake * backOdds) / (layOdds - commission);
  const liability = layStake * (layOdds - 1);
  const profitLoss = backStake * (backOdds - 1) - liability;
  return { layStake, liability, profitLoss };
}

/**
 * How a free bet pays out on a win.
 *   snr — stake NOT returned: only the winnings, stake × (backOdds − 1).
 *   sr  — stake returned: winnings AND stake, stake × backOdds.
 */
export type FreeBetType = "snr" | "sr";

/**
 * Retained profit from laying a free bet on a single outcome. The free bet is
 * backed at backOdds and laid at layOdds; the lay stake is sized so the result
 * is the same whether the outcome wins or loses, and commission (2% by default,
 * adjustable — see DEFAULT_COMMISSION) is deducted from the lay winnings only.
 *
 *   payout = type === "sr" ? backOdds : backOdds − 1
 *   freeBetProfit = stake × payout × (1 − commission) / (layOdds − commission)
 *
 * Returns null when there's no usable lay price (never fabricate a number).
 * "Retention" = freeBetProfit / stake — how much of the free bet's value you
 * keep. Above 1.0 (100%) means the exchange lay price sits below the bookmaker's
 * back price, which is arb-grade and rare.
 */
export function calcFreeBetProfit(
  backOdds: number,
  layOdds: number | null,
  stake = 20,
  commission = DEFAULT_COMMISSION,
  type: FreeBetType = "snr"
): number | null {
  if (!layOdds || layOdds <= commission || backOdds <= 1) return null;
  const payout = type === "sr" ? backOdds : backOdds - 1;
  return (stake * payout * (1 - commission)) / (layOdds - commission);
}

export interface LayMetrics {
  /** Highest profit/loss across all outcomes in the match (best value lay) */
  bestProfit: number;
  /** Smallest |profit/loss| — the outcome closest to break-even */
  closestLoss: number;
  /** Whether any outcome had a usable lay price */
  hasLay: boolean;
}

/**
 * Aggregate matched-betting metrics for a whole match, used for sorting and
 * for highlighting matches that contain a value opportunity.
 */
export function matchLayMetrics(
  outcomes: { odds: number; layOdds: number | null }[],
  backStake = 20,
  commission = DEFAULT_COMMISSION
): LayMetrics {
  let bestProfit = -Infinity;
  let closestLoss = Infinity;
  let hasLay = false;
  for (const o of outcomes) {
    const c = calcLay(o.odds, o.layOdds, backStake, commission);
    if (!c) continue;
    hasLay = true;
    if (c.profitLoss > bestProfit) bestProfit = c.profitLoss;
    const abs = Math.abs(c.profitLoss);
    if (abs < closestLoss) closestLoss = abs;
  }
  return { bestProfit, closestLoss, hasLay };
}

/**
 * Lay Bet Finder eligibility (owner-defined, 2026-10-26):
 * a row qualifies when it has a usable exchange lay price AND a lay gap under
 * 0.2 — i.e. (lay odds − back odds) < 0.2. There is NO back-odds ceiling: all
 * odds qualify. A negative gap means the lay sits below the back, which is
 * better than break-even (arb-grade). Values are rounded to 2dp before the gap
 * comparison to avoid float noise (e.g. 2.82 − 2.76 is not exactly 0.06 in
 * IEEE-754).
 */
export const MAX_LAY_GAP = 0.2;

/** Round to 2 decimal places (for display and float-safe comparisons). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Lay gap in decimal odds, rounded to 2dp. Negative = back beats lay. */
export function layGap(backOdds: number, layOdds: number): number {
  return round2(layOdds - backOdds);
}

/**
 * Whether a back/lay pair is close enough to show in the Lay Bet Finder.
 * `commission` is only used as a floor for a usable price (a lay at or below
 * the commission rate is nonsense), so the rate cannot change which rows
 * qualify — but it is threaded anyway so the whole page uses one rate.
 */
export function qualifiesForLay(
  backOdds: number,
  layOdds: number | null,
  commission = DEFAULT_COMMISSION
): boolean {
  if (!layOdds || layOdds <= commission) return false;
  return layGap(backOdds, layOdds) < MAX_LAY_GAP;
}