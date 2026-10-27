/**
 * 2UP early-payout notes — information only, never part of the profit maths.
 *
 * Source of truth: src/data/2up-verified-offers.json (schema_version 2), verified
 * from the bookmakers' own terms on 2026-10-27. Nothing about which bookmakers
 * qualify is hardcoded here: the keys, label, tooltip and note are all read from
 * that file, so adding or removing a bookmaker is a data edit, not a code edit.
 *
 * WHAT 2UP IS (must never be mis-stated in UI copy): an EARLY PAYOUT settlement
 * rule — the bet is settled as a winner as soon as the team leads by two goals.
 * It is not a free bet, has no wagering and no expiry.
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID: both verified offers apply to a
 * DEDICATED 2-Up market that is separate from the standard Full Time Result
 * price the Lay Bet Finder lists. So a note can never be rendered as "this
 * row's price qualifies" — the tooltip says the opposite explicitly.
 */
import raw from "../data/2up-verified-offers.json";

export interface TwoUpNote {
  /** Short neutral label from the data file, e.g. "2UP". */
  label: string;
  /** The bookmaker's settlement rule, verbatim from the data file. */
  tooltip: string;
  /** Longer plain-English note (early payout, not a free bet), verbatim. */
  note: string;
  /** Link to the bookmaker's own terms. Provenance, not a claim. */
  termsUrl: string;
}

interface BookmakerEntry {
  feed_key?: string;
  confirmed?: boolean;
  market?: { is_dedicated_2up_market?: boolean };
  badge_label?: string;
  badge_tooltip?: string;
  badge_note?: string;
  terms_url?: string;
}

/** Shown with every note: the price on the row is NOT the 2-Up price. */
export const MARKET_WARNING =
  "Applies only on this bookmaker's own 2-Up market — not on the price shown on this row.";

let warnedMissing = false;

function bookmakers(): Record<string, BookmakerEntry> {
  const table = (raw as { bookmakers?: Record<string, BookmakerEntry> })?.bookmakers;
  if (!table || typeof table !== "object") {
    if (!warnedMissing) {
      console.warn("[2up] 2up-verified-offers.json has no bookmakers table — no notes will render");
      warnedMissing = true;
    }
    return {};
  }
  return table;
}

/**
 * The note for a feed bookmaker key, or null. Null for anything not in the file,
 * for unconfirmed entries, and for entries whose market is not a dedicated 2-Up
 * market — a note must never imply a price qualifies when it does not.
 */
export function twoUpNoteForFeedKey(feedKey: string | null | undefined): TwoUpNote | null {
  if (!feedKey) return null;
  const entry = bookmakers()[feedKey];
  if (!entry) return null;
  if (entry.confirmed !== true) return null;
  if (entry.market?.is_dedicated_2up_market !== true) return null;
  if (!entry.badge_label || !entry.badge_tooltip) return null;
  return {
    label: entry.badge_label,
    tooltip: entry.badge_tooltip,
    note: entry.badge_note ?? "",
    termsUrl: entry.terms_url ?? "",
  };
}

/** Every feed key that currently carries a note. Derived, never hardcoded. */
export function twoUpFeedKeys(): string[] {
  return Object.keys(bookmakers()).filter((k) => twoUpNoteForFeedKey(k) !== null);
}

/**
 * The feed key of the bookmaker that actually set this outcome's best back price.
 * The row shows a display title ("888sport"); the note needs the feed key
 * ("sport888"), and the per-bookmaker matrix already carries both.
 */
export function feedKeyForOutcome(outcome: {
  bookmaker: string;
  odds: number;
  bookmakerOdds?: { key: string; title: string; odds: number }[];
}): string | null {
  const matrix = outcome.bookmakerOdds ?? [];
  const exact = matrix.find((b) => b.title === outcome.bookmaker && b.odds === outcome.odds);
  if (exact) return exact.key;
  // Titles can repeat across keys; fall back to any entry with the same title.
  const byTitle = matrix.find((b) => b.title === outcome.bookmaker);
  return byTitle ? byTitle.key : null;
}

/** Note for a Lay Bet Finder row, or null when the bookmaker is not in the file. */
export function twoUpNoteForOutcome(outcome: {
  bookmaker: string;
  odds: number;
  bookmakerOdds?: { key: string; title: string; odds: number }[];
}): TwoUpNote | null {
  return twoUpNoteForFeedKey(feedKeyForOutcome(outcome));
}
