/**
 * The licence line — one component, used by both offers surfaces.
 *
 * Why a component and not a helper string: the public `/free-bets` page used to
 * carry the register evidence only inside a `title=` tooltip on the "UK
 * licensed" badge. A tooltip does not exist on a phone or for a screen reader
 * and cannot be clicked, so the reader was told "UK licensed" with no way to
 * check it. The line and its link now render as visible text everywhere.
 *
 * Rules this component enforces by construction:
 *   • No licence claim without the licensee AND the register account.
 *   • A verified row always renders a link to that row's `registerUrl`, in a
 *     new tab, with `rel="noopener noreferrer"`.
 *   • A row we could not check says so and makes no claim either way — it never
 *     says "unlicensed".
 *   • The caveat keeps the licence check separate from the offer's terms.
 */
import { licenceEvidence, licenceLine, type FreeBetOffer } from "../lib/free-bets";

export function LicenceLine({
  offer,
  testId,
  unknownTestId,
  caveat,
}: {
  offer: FreeBetOffer;
  /** testid on the visible licence text + register link (verified rows only). */
  testId: string;
  /** testid on the "we could not check" sentence (unverified rows only). */
  unknownTestId: string;
  /** What this line is NOT. Must state that a licence is not a terms check. */
  caveat: string;
}) {
  const licence = licenceEvidence(offer);

  if (!licence.ok) {
    return (
      <p className="mt-1.5 text-[11px] leading-5 text-gray-400 dark:text-gray-500">
        <span data-testid={unknownTestId}>{licenceLine(offer)}</span>
      </p>
    );
  }

  return (
    <p className="mt-1.5 border-l-2 border-emerald-300 pl-2 text-[11px] leading-5 text-gray-500 dark:border-emerald-800 dark:text-gray-400">
      <a
        data-testid={testId}
        data-register-account={licence.registerAccount}
        href={licence.registerUrl || undefined}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-dotted hover:text-indigo-600 dark:hover:text-indigo-400"
      >
        Licensed by the Gambling Commission — {licence.licensee}, account {licence.registerAccount}
      </a>
      {licence.checkedOn ? ` · checked ${licence.checkedOn}` : ""}
      <span className="italic"> {caveat}</span>
    </p>
  );
}
