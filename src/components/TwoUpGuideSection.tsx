import { twoUpFeedKeys, twoUpNoteForFeedKey, MARKET_WARNING } from "../lib/two-up";

/**
 * The 2-Up section of the lay-betting guide.
 *
 * Every sentence about a bookmaker is taken verbatim from
 * src/data/2up-verified-offers.json (badge_tooltip + badge_note), so the page
 * cannot drift from the terms we verified. Wording rules from the data file: it
 * is an EARLY PAYOUT, not a free bet; it needs the bookmaker's own 2-Up market;
 * and it makes no profit, value or availability claim.
 */
export default function TwoUpGuideSection() {
  const keys = twoUpFeedKeys();
  if (keys.length === 0) {
    // Nothing verified → say nothing rather than a generic claim.
    return null;
  }
  return (
    <section
      data-testid="2up-guide-section"
      className="mt-8 rounded-xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-gray-900"
    >
      <h3 className="text-lg font-bold tracking-tight">2-Up early payout (some bookmakers)</h3>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        A 2-Up offer is an <strong>early payout</strong>, not a free bet: the bet is settled as a
        winner the moment your team goes two goals ahead. There is no free-bet token, no wagering
        requirement and no expiry. It does <strong>not</strong> change the profit or loss of a
        match on this page.
      </p>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        Both offers apply only on that bookmaker&apos;s own dedicated 2-Up market, which is a
        separate market from the standard full-time result price the Lay Bet Finder lists.{" "}
        {MARKET_WARNING}
      </p>
      <ul className="mt-3 space-y-2 text-sm text-gray-600 dark:text-gray-400">
        {keys.map((key) => {
          const note = twoUpNoteForFeedKey(key)!;
          return (
            <li key={key} className="flex flex-wrap items-baseline gap-x-2">
              <span className="inline-flex items-center rounded border border-gray-300 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-500">
                {note.label}
              </span>
              <span>{note.note || note.tooltip}</span>
              {note.termsUrl ? (
                <a
                  href={note.termsUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="text-xs font-medium text-indigo-600 underline hover:text-indigo-700"
                >
                  Bookmaker terms
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
