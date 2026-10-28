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
 *     (lay < back × 0.90). Exchange commission is 2% by default (adjustable, see
 *     DEFAULT_COMMISSION in odds.ts), so a genuine lay-under-back edge is worth
 *     a few percent at most — a 10%+ shortfall means the two
 *     numbers come from different coverage, not from a real opportunity.
 *
 *  3. THE EXCHANGE AS ITS OWN BEST BACK PRICE. An exchange quotes a BACK price
 *     (h2h) and a LAY price (h2h_lay) on the same outcome. When the exchange's
 *     back price is the highest in the market it wins "best back price", and the
 *     row becomes "back 2.66 at Betfair, lay 2.70 at Betfair" — the same
 *     counterparty on both sides. That is a guaranteed small loss (you pay the
 *     spread and commission to yourself), dressed up as an opportunity. Real
 *     rows from our cache did exactly this in 2 of 7 pairs.
 *     RULE: the exchange that supplies the lay may never supply the back. Its
 *     price is excluded from best-back selection, and if it was the only quoted
 *     price the row is withheld as unusable — never silently reused.
 *
 * Consumers:
 *   • transformMatches() applies this at the data layer: unusable back prices
 *     are dropped, an exchange's own price is excluded from the back side of
 *     the pair it lays, and an unusable/suspect lay price is WITHHELD (layOdds
 *     set to null) with the row marked `laySuspect` so the UI can say so honestly.
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

// ── Exchange identity ──────────────────────────────────────────────────────

/**
 * Known exchange bookmaker keys. An exchange quotes BOTH sides of the same
 * outcome (h2h for back, h2h_lay for lay), so a pair whose back and lay come
 * from the same key has no opponent — only the spread and commission.
 *
 * This list is a FALLBACK for labelling and for callers that only have a key
 * string. The rejection itself compares the ACTUAL lay-source key carried on
 * the row (`layBookmakerKey`) with the ACTUAL back key — never a guess — so a
 * new exchange added to the feed is handled the moment it supplies a lay price.
 */
export const EXCHANGE_KEYS: readonly string[] = [
  "betfair_ex_uk",
  "betfair_ex_eu",
  "betfair_ex_au",
  "betfair",
  "betfair_exchange",
  "smarkets",
  "matchbook",
  "matchbook_exchange",
  "betdaq",
  "betdaq_exchange",
];

/** Bookmaker keys are compared normalised: trimmed, lowercased. */
export function normaliseBookmakerKey(key: string | null | undefined): string {
  return (key ?? "").trim().toLowerCase();
}

/** True when this bookmaker key is a known exchange (labelling/documentation). */
export function isExchangeKey(key: string | null | undefined): boolean {
  const k = normaliseBookmakerKey(key);
  return k !== "" && EXCHANGE_KEYS.includes(k);
}

/**
 * True when two bookmaker keys name the same book. Empty/missing keys are
 * never "the same" — an unknown source must not be rejected on a blank match.
 */
export function isSameBookmakerKey(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const A = normaliseBookmakerKey(a);
  const B = normaliseBookmakerKey(b);
  return A !== "" && A === B;
}

/**
 * Split back-price candidates into the ones a pair may use and the ones whose
 * source is the exchange supplying that pair's lay price.
 *
 * `laySourceKey` comes from the row itself (`layBookmakerKey`), not from a
 * hardcoded guess. When no lay price exists nothing is excluded.
 */
export function excludeLaySource<T extends { key: string }>(
  candidates: T[],
  laySourceKey: string | null | undefined
): { kept: T[]; excluded: T[] } {
  if (!laySourceKey) return { kept: candidates, excluded: [] };
  const kept: T[] = [];
  const excluded: T[] = [];
  for (const c of candidates) {
    if (isSameBookmakerKey(c.key, laySourceKey)) excluded.push(c);
    else kept.push(c);
  }
  return { kept, excluded };
}

export type PairVerdict =
  /** Both prices are usable and consistent — safe to show/act on. */
  | "ok"
  /** Back price is unusable (sentinel/absurd) — the whole row must go. */
  | "bad_back"
  /** No lay price at all — nothing can be calculated from it. */
  | "no_lay"
  /** Back and lay come from the same exchange — a guaranteed loss. */
  | "back_is_lay_source"
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
 *
 * `backSourceKey` / `laySourceKey` are the feed's bookmaker keys for each side
 * (e.g. "williamhill" / "betfair_ex_uk"). When both are known and identical the
 * pair is rejected: the same exchange is on both sides of the trade, which is a
 * guaranteed loss, not an opportunity. Both are optional so callers that only
 * hold prices still get every price-level check.
 */
export function checkBackLayPair(
  backOdds: number | null | undefined,
  layOdds: number | null | undefined,
  backSourceKey?: string | null,
  laySourceKey?: string | null
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
  if (isSameBookmakerKey(backSourceKey, laySourceKey)) {
    return {
      verdict: "back_is_lay_source",
      suspect: true,
      reason: `back ${backOdds} and lay ${layOdds} are both from ${normaliseBookmakerKey(
        laySourceKey
      )} — backing and laying the same exchange cannot profit`,
    };
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
  layOdds: number | null | undefined,
  backSourceKey?: string | null,
  laySourceKey?: string | null
): boolean {
  return (
    checkBackLayPair(backOdds, layOdds, backSourceKey, laySourceKey).verdict === "ok"
  );
}
