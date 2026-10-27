import { MARKET_WARNING, type TwoUpNote } from "../lib/two-up";

/**
 * A small, neutral bookmaker note on a Lay Bet Finder row.
 *
 * Deliberately NOT a badge on the numbers: it sits in its own line, muted grey,
 * with no colour or weight that could read as "this price qualifies" or as part
 * of the profit maths. The full text is in the title attribute (and read out by
 * screen readers), including the warning that the offer applies only on the
 * bookmaker's own 2-Up market.
 */
export default function TwoUpNoteTag({ note }: { note: TwoUpNote }) {
  const fullText = [note.tooltip, note.note, MARKET_WARNING].filter(Boolean).join(" ");
  return (
    <span
      data-testid="2up-note"
      data-two-up-feed-note="1"
      role="note"
      aria-label={`${note.label}: ${fullText}`}
      title={fullText}
      className="inline-flex cursor-help items-center gap-1 rounded border border-gray-200 bg-transparent px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:border-gray-700 dark:text-gray-500"
    >
      {note.label}
      <span aria-hidden="true" className="normal-case">*</span>
    </span>
  );
}
