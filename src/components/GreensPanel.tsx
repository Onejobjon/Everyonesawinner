/**
 * GREENS FOUND IN THE LAST 30 DAYS — the small proof-of-value panel that sits
 * under the live feed on the dashboard.
 *
 * WHY (owner, 2026-11-02): greens are rare, so on a quiet day the live feed is
 * empty and the page looks like nothing works. The history is the answer: it
 * says how many greens we have actually found in the last 30 days, which was
 * the best of them, and when the most recent ones turned up.
 *
 * WHAT IT IS ALLOWED TO SAY:
 *   • The data is already in the `/api/instant-wins` payload (`greens30d`), so
 *     this panel costs ZERO credits and never asks for anything else.
 *   • Zero is a real answer. It is printed as zero, in plain words, with no
 *     spin — an empty history is not dressed up as anything else.
 *   • Only profitable-on-both-sides rows are ever printed. The history file
 *     enforces that on write and on read (src/server/green-history.ts); the
 *     filter here is a second belt so a malformed record can never be shown as
 *     winnings.
 */
import { londonDayKey, londonDayLabel, londonTimeLabel } from "../lib/london-day";
import { money } from "../lib/laybets-common";

/** One recorded green — mirrors GreenRecord in src/server/green-history.ts. */
export interface GreenEntry {
  ts: string;
  sport: string;
  match: string;
  outcome: string;
  bookmaker: string;
  backOdds: number;
  exchange: string | null;
  layOdds: number;
  /** The worse of the two outcomes at a £20 stake. Positive by definition. */
  profitAt20: number;
  commissionPct: number;
}

/** Mirrors GreenHistorySummary in src/server/green-history.ts. */
export interface GreensSummary {
  windowDays: number;
  count: number;
  best: GreenEntry | null;
  entries: GreenEntry[];
}

/** "2 Nov at 14:05" — when a green was first seen. */
function whenLabel(ts: string): string {
  const day = londonDayKey(ts);
  const time = londonTimeLabel(ts);
  if (!day || !time) return "date unknown";
  return `${londonDayLabel(day)} at ${time}`;
}

function isGreen(e: GreenEntry | null | undefined): e is GreenEntry {
  return Boolean(e) && typeof e?.profitAt20 === "number" && e.profitAt20 > 0;
}

export default function GreensPanel({ greens }: { greens?: GreensSummary | null }) {
  const windowDays = greens?.windowDays ?? 30;
  const count = typeof greens?.count === "number" ? greens.count : 0;
  // Belt and braces: a record that is not profitable on both sides is not shown,
  // whatever the server sent.
  const entries = (greens?.entries ?? []).filter(isGreen);
  const bestCandidate = greens?.best ?? null;
  const best = isGreen(bestCandidate) ? bestCandidate : null;

  return (
    <section
      className="mt-6 rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950"
      aria-labelledby="greens-30d-heading"
    >
      <h3 id="greens-30d-heading" className="text-lg font-bold tracking-tight">
        Greens found in the last {windowDays} days
      </h3>

      {!greens ? (
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          We cannot read the history of past greens here right now, so there is nothing to show.
          This is not the same as &ldquo;no greens found&rdquo; — today&rsquo;s list above is
          unaffected.
        </p>
      ) : count === 0 ? (
        <>
          <p className="mt-2 text-lg font-semibold text-gray-800 dark:text-gray-100">
            None. We have not found a single green trade in the last {windowDays} days.
          </p>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            That is the real count, not a display fault: every green we find is written down
            here, and there have been none in this window. A green is rare — it needs a bookmaker
            price and an exchange lay price that leave money whichever way the result goes.
          </p>
        </>
      ) : (
        <>
          <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">
            <strong className="text-lg">{count}</strong> green trade{count === 1 ? "" : "s"} found in
            the last {windowDays} days. Every one of them returned money whichever way the result
            went, at a {money(20)} stake after commission.
          </p>

          {best && (
            <div className="mt-4 rounded-xl border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950/40">
              <p className="text-xs font-semibold uppercase tracking-wide text-green-800 dark:text-green-300">
                The best one
              </p>
              <p className="mt-1 font-semibold text-gray-900 dark:text-gray-100">
                {best.match} — {best.outcome}
              </p>
              <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
                Back <strong>{best.backOdds.toFixed(2)}</strong> at {best.bookmaker} · lay{" "}
                <strong>{best.layOdds.toFixed(2)}</strong> on {best.exchange ?? "the exchange"} ·{" "}
                <strong className="text-green-700 dark:text-green-400">
                  +{money(best.profitAt20)}
                </strong>{" "}
                on a {money(20)} stake
              </p>
              <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                Seen {whenLabel(best.ts)} · commission {best.commissionPct}%
              </p>
            </div>
          )}

          {entries.length > 0 && (
            <>
              <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Most recent
              </p>
              <ul className="mt-2 space-y-2 text-sm">
                {entries.map((e) => (
                  <li
                    key={`${e.ts}-${e.match}-${e.outcome}-${e.backOdds}`}
                    className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-gray-100 pb-2 last:border-0 dark:border-gray-900"
                  >
                    <span className="font-medium text-gray-900 dark:text-gray-100">
                      {e.match} <span className="font-normal text-gray-400">—</span> {e.outcome}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      back {e.backOdds.toFixed(2)} at {e.bookmaker} · lay {e.layOdds.toFixed(2)} on{" "}
                      {e.exchange ?? "the exchange"}
                    </span>
                    <span className="text-xs font-semibold text-green-700 dark:text-green-400">
                      +{money(e.profitAt20)} on {money(20)}
                    </span>
                    <span className="text-[11px] text-gray-400">{whenLabel(e.ts)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="mt-3 text-[11px] text-gray-400">
            Prices as they were when the green was first seen, not today&rsquo;s prices — they are
            history, not something you can take now.
          </p>
        </>
      )}
    </section>
  );
}
