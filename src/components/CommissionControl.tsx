/**
 * The one shared exchange-commission control, plus the label that goes on the
 * numbers.
 *
 * WHY IT EXISTS (owner directive 2026-10-28): commission is 2% on Smarkets and
 * Betfair, but Betfair charges per market, so a fixed rate would misstate
 * profit. The rate therefore has to be (a) visible next to every profit figure
 * and (b) adjustable in one place that all three tools share.
 *
 * `useExchangeCommission()` is the hook a page uses; `<CommissionControl>` is
 * the input; `<CommissionNote>` is the "Betfair · 2% assumed" label.
 */
import { useCallback, useState } from "react";
import {
  COMMISSION_MAX_PCT,
  COMMISSION_MIN_PCT,
  COMMISSION_STEP_PCT,
  clampCommissionPct,
  formatCommissionPct,
  pctToRate,
  readCommissionPct,
  writeCommissionPct,
} from "../lib/commission";

export interface ExchangeCommission {
  /** What the user typed, in percent (2 = 2%). Drives the input. */
  pct: number;
  /** The same rate as a fraction (0.02), which is what the maths takes. */
  rate: number;
  /** "2%" — for sentences. */
  label: string;
  setPct: (next: number) => void;
}

/**
 * The shared commission state. Persisted under ONE key
 * (eaw_exchange_commission_pct) so a change on the calculator is still in force
 * on the Lay Bet Finder and the Bet Builder.
 */
export function useExchangeCommission(): ExchangeCommission {
  const [pct, setPctState] = useState<number>(() => readCommissionPct());
  const setPct = useCallback((next: number) => {
    const clean = clampCommissionPct(next);
    setPctState(clean);
    writeCommissionPct(clean);
  }, []);
  return { pct, rate: pctToRate(pct), label: formatCommissionPct(pct), setPct };
}

interface ControlProps {
  pct: number;
  onChange: (next: number) => void;
  /** Extra classes for the wrapper. */
  className?: string;
}

/**
 * A small, labelled percent input. Percent, step 0.5, 0–10, default 2 — and the
 * helper line says why it is adjustable rather than asserting one number.
 */
export function CommissionControl({ pct, onChange, className = "" }: ControlProps) {
  return (
    <label className={`block ${className}`}>
      <span className="text-xs font-medium text-gray-500">Exchange commission</span>
      <div className="mt-1 flex items-center gap-1.5">
        <input
          type="number"
          inputMode="decimal"
          value={pct}
          min={COMMISSION_MIN_PCT}
          max={COMMISSION_MAX_PCT}
          step={COMMISSION_STEP_PCT}
          onChange={(e) => onChange(Number(e.target.value))}
          onBlur={(e) => onChange(clampCommissionPct(Number(e.target.value)))}
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
          aria-label="Exchange commission, percent"
        />
        <span className="text-sm font-semibold text-gray-600 dark:text-gray-300">%</span>
      </div>
      <span className="mt-1 block text-[11px] leading-tight text-gray-400">
        Betfair charges per market (often 5% on main football) — set yours.
      </span>
    </label>
  );
}

interface NoteProps {
  pct: number;
  /** The exchange the lay price came from, when the row names one. */
  source?: string | null;
  className?: string;
}

/**
 * The label that goes ON the numbers: "Betfair · 2% assumed". A profit figure
 * must never appear without the rate that produced it being visible.
 */
export function CommissionNote({ pct, source, className = "" }: NoteProps) {
  const rate = formatCommissionPct(pct);
  return (
    <span className={className} title={`Figures use ${rate} exchange commission, adjustable on this page`}>
      {source ? `${source} · ${rate} assumed` : `${rate} commission assumed`}
    </span>
  );
}
