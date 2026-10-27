/**
 * Back/lay sanity check — one rule set shared by every surface that reads odds
 * (Lay Bet Finder, Best Odds / oddsmatcher, Bet Builder, and the alert worker).
 *
 * The Odds API feed contains two classes of bad row:
 *
 *  1. SENTINEL PRICES. 1.00 and 451 are the feed's "no price here" markers, not
 *     odds. Read literally, a 451 is a ~£9,000 return on a £20 stake and makes
 *     any dutching/arb calculation on that market invent a profit.
 *
 *  2. CROSS-COVERAGE ARTEFACTS. The bookmaker's back price and the exchange's
 *     lay price describe different markets — regulation-time vs overtime, a
 *     different line, or a mislabelled selection on a thin minor league. The
 *     lay then sits far BELOW the back. Read literally that is a huge
 *     guaranteed profit; in reality the two numbers cannot be matched.
 *     Real examples from the SHL (ice hockey) feed:
 *       Växjö Lakers   back 5.50 / lay 2.56
 *       HV71           back 1.70 / lay 1.50
 *
 * RULES (decimal odds):
 *   • A price is usable only when 1.01 ≤ p < 451. 1.00 is not an odds, 451 is
 *     the feed's "no price" sentinel; ≤0, NaN and ±Infinity are unusable too.
 *   • A back/lay pair is suspect when the lay is more than 10% BELOW the back
 *     (lay < back × 0.90). Exchange commission is 5%, so a genuine lay-under-back
 *     edge is worth a few percent at most — a 10%+ shortfall means the two
 *     numbers come from different coverage, not from a real opportunity.
 *
 * Consumers:
 *   • transformMatches() applies this at the data layer: unusable back prices
 *     are dropped, and an unusable/suspect lay price is WITHHELD (layOdds set
 *     to null) with the row marked `laySuspect` so the UI can say so honestly.
 *   • Every downstream surface therefore inherits it: the Lay Bet Finder can't
 *     show it (no lay price), the Bet Builder can't use it as a leg, the
 *     oddsmatcher drops sentinel back prices before any profit maths, and the
 *     alert worker skips it (plus a defence-in-depth re-check, because its
 *     on-disk cache can hold matches transformed by an older build).
 */

/** Lowest usable decimal price (1.00 means "certainty", i.e. no price at all). */
export const MIN_PRICE = 1.01;

/** The feed's low sentinel: a 1.00 price means "no price available". */
export const SENTINEL_LOW = 1.0;

/** The feed's high sentinel: 451 means "no price available". */
export const SENTINEL_HIGH = 451;

/** Highest usable decimal price (exclusive). */
export const MAX_PRICE = SENTINEL_HIGH;

/** How far below the back price a lay price may sit before it is suspect. */
export const BELOW_BACK_TOLERANCE = 0.1;

/** True when a price is one of the feed's "no price here" markers. */
export function isSentinelPrice(price: number | null | undefined): boolean {
  if (price == null || !Number.isFinite(price)) return true;
  return price <= SENTINEL_LOW || price >= SENTINEL_HIGH;
}

/** True when a price is a real, usable decimal price (1.01 ≤ p < 451). */
export function isPlausiblePrice(price: number | null | undefined): boolean {
  if (price == null || !Number.isFinite(price)) return false;
  return price >= MIN_PRICE && price < MAX_PRICE;
}

export type PairVerdict =
  /** Both prices are usable and consistent — safe to show/act on. */
  | "ok"
  /** Back price is unusable (sentinel/absurd) — the whole row must go. */
  | "bad_back"
  /** No lay price at all — nothing can be calculated from it. */
  | "no_lay"
  /** Lay price is a sentinel/absurd value — withhold it. */
  | "sentinel_lay"
  /** Lay sits far below the back — cross-coverage artefact, not a real edge. */
  | "lay_below_back";

export interface PairCheck {
  verdict: PairVerdict;
  /** True when the row must not be presented as an opportunity. */
  suspect: boolean;
  /** Human-readable reason (shown in UI tooltips / logs) — null when ok. */
  reason: string | null;
}

/**
 * Check one back/lay pair. `verdict: "ok"` is the only value any surface may
 * treat as actionable.
 */
export function checkBackLayPair(
  backOdds: number | null | undefined,
  layOdds: number | null | undefined
): PairCheck {
  if (!isPlausiblePrice(backOdds)) {
    return {
      verdict: "bad_back",
      suspect: true,
      reason: `unusable back price ${backOdds == null ? "missing" : backOdds}`,
    };
  }
  if (layOdds == null) {
    return { verdict: "no_lay", suspect: false, reason: null };
  }
  if (isSentinelPrice(layOdds)) {
    return {
      verdict: "sentinel_lay",
      suspect: true,
      reason: `lay price ${layOdds} is a feed placeholder, not an odds`,
    };
  }
  const floor = backOdds * (1 - BELOW_BACK_TOLERANCE);
  if (layOdds < floor) {
    return {
      verdict: "lay_below_back",
      suspect: true,
      reason: `lay ${layOdds.toFixed(2)} is more than ${Math.round(
        BELOW_BACK_TOLERANCE * 100
      )}% below back ${backOdds.toFixed(2)} — prices from different coverage`,
    };
  }
  return { verdict: "ok", suspect: false, reason: null };
}

/** Convenience wrapper: true only when the pair is safe to act on. */
export function isSaneBackLayPair(
  backOdds: number | null | undefined,
  layOdds: number | null | undefined
): boolean {
  return checkBackLayPair(backOdds, layOdds).verdict === "ok";
}
