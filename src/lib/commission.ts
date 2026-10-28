/**
 * The exchange commission the user tells us they actually pay.
 *
 * ONE storage key and ONE control for the whole site (calculator, Lay Bet
 * Finder, Bet Builder), because a rate that differs between two pages is worse
 * than no control at all: the same bet would show two different profits.
 *
 * OWNER DIRECTIVE (2026-10-28): 2% on both Smarkets and Betfair. But Betfair
 * charges per market — commonly 5% on the main football markets, 2% on some —
 * so the rate is a labelled, adjustable assumption, never a silent constant.
 * Every figure on screen says which rate produced it.
 *
 * The maths lives in src/lib/odds.ts (`DEFAULT_COMMISSION`, and every function
 * takes an optional `commission` fraction). This module is only the number the
 * UI keeps, in PERCENT (2 = 2%), because that is what a person types.
 */
export const COMMISSION_LS_KEY = "eaw_exchange_commission_pct";

/** Bounds of the control. 0 = exchange with no commission; 10 = the worst case. */
export const COMMISSION_MIN_PCT = 0;
export const COMMISSION_MAX_PCT = 10;
export const COMMISSION_STEP_PCT = 0.5;

/** The default rate in percent — mirrors DEFAULT_COMMISSION (0.02) in odds.ts. */
export const DEFAULT_COMMISSION_PCT = 2;

export function clampCommissionPct(pct: number): number {
  if (!Number.isFinite(pct)) return DEFAULT_COMMISSION_PCT;
  return Math.min(COMMISSION_MAX_PCT, Math.max(COMMISSION_MIN_PCT, pct));
}

/** The rate the UI should use, from localStorage. Never throws, never NaN. */
export function readCommissionPct(): number {
  try {
    const raw = localStorage.getItem(COMMISSION_LS_KEY);
    if (raw == null) return DEFAULT_COMMISSION_PCT;
    const n = Number(raw);
    return Number.isFinite(n) ? clampCommissionPct(n) : DEFAULT_COMMISSION_PCT;
  } catch {
    return DEFAULT_COMMISSION_PCT;
  }
}

/** Persist the rate so it survives navigation (and the next visit). */
export function writeCommissionPct(pct: number): void {
  try {
    localStorage.setItem(COMMISSION_LS_KEY, String(clampCommissionPct(pct)));
  } catch {
    /* localStorage can throw in private mode — non-fatal */
  }
}

/** Percent (what the user types) → fraction (what the maths takes). */
export function pctToRate(pct: number): number {
  return clampCommissionPct(pct) / 100;
}

/** "2%" / "2.5%" — never "2.0%". */
export function formatCommissionPct(pct: number): string {
  const n = Math.round(clampCommissionPct(pct) * 10) / 10;
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
}
