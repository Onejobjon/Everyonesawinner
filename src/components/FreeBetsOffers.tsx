import { useMemo, useState } from "react";
import offersData from "../content/free-bets-offers.json";
import { LicenceLine } from "./LicenceLine";
import {
  keptOffers,
  licenceEvidence,
  profitText,
  statusLabel,
  type FreeBetOffer,
} from "../lib/free-bets";

/**
 * The offers panel on /oddsmatcher.
 *
 * It renders `src/content/free-bets-offers.json` and nothing else — there is no
 * operator list in this file, so it cannot drift from /free-bets again. What it
 * shows about each row is described by src/lib/free-bets.ts, which the public
 * page uses too.
 */
const DATASET: FreeBetOffer[] = keptOffers(offersData.offers as FreeBetOffer[]);
const CHECKED_ON = (offersData.meta as { lastVerified?: string }).lastVerified || "";

const TONE_CLASS: Record<string, string> = {
  changed:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  verified:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  unverifiable:
    "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
  withdrawn: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

export default function FreeBetsOffers({
  defaultOpen = false,
  offers,
}: {
  defaultOpen?: boolean;
  /** Overridable so a test can prove the fail-closed path; defaults to the dataset. */
  offers?: FreeBetOffer[];
}) {
  const OFFERS = useMemo(() => keptOffers(offers ?? DATASET), [offers]);
  const [open, setOpen] = useState(defaultOpen);
  const [search, setSearch] = useState("");
  const [section, setSection] = useState<"all" | "uk" | "global">("all");

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return OFFERS.filter((o) => {
      if (section !== "all" && o.section !== section) return false;
      if (!q) return true;
      return (
        o.bookmaker.toLowerCase().includes(q) ||
        o.offer.toLowerCase().includes(q) ||
        (o.jurisdiction || "").toLowerCase().includes(q)
      );
    });
  }, [search, section, OFFERS]);

  const ukCount = OFFERS.filter((o) => o.section === "uk").length;
  const globalCount = OFFERS.filter((o) => o.section === "global").length;
  const withEvidence = OFFERS.filter((o) => licenceEvidence(o).ok).length;

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-950">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-6 py-4 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-900"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">🎁</span>
          <span className="text-base font-semibold">Free Bet Offers</span>
          <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300">
            {OFFERS.length} listed
          </span>
        </div>
        <svg
          className={`h-5 w-5 text-gray-500 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-gray-200 dark:border-gray-800">
          {/* Guidance note */}
          <div className="px-6 py-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Listed UK, Irish &amp; global welcome offers. Only offers marked as re-checked were read on the
              bookmaker's own page; the rest are unconfirmed and may be out of date. We do not quote a profit
              figure — what you keep depends on which offers you can actually open and the odds you match at.
            </p>
          </div>

          {/* Search bar */}
          <div className="px-6 pb-3">
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search bookmakers or offers..."
                className="w-full rounded-lg border border-gray-300 bg-gray-50 py-2 pl-10 pr-4 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500 dark:focus:border-indigo-500"
              />
            </div>
          </div>

          {/* Section filter tabs */}
          <div className="flex gap-1 px-6 pb-3">
            <button
              onClick={() => setSection("all")}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                section === "all"
                  ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
                  : "bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
              }`}
            >
              All ({OFFERS.length})
            </button>
            <button
              onClick={() => setSection("uk")}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                section === "uk"
                  ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
                  : "bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
              }`}
            >
              🇬🇧 UK/IE ({ukCount})
            </button>
            <button
              onClick={() => setSection("global")}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                section === "global"
                  ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
                  : "bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
              }`}
            >
              🌍 Global ({globalCount})
            </button>
            {search && (
              <button
                onClick={() => setSearch("")}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
              >
                ✕ Clear
              </button>
            )}
          </div>

          {/* Results */}
          <div className="divide-y divide-gray-100 dark:divide-gray-800 max-h-[500px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-6 py-8 text-center text-sm text-gray-400">
                No bookmakers match your search.
              </div>
            ) : (
              filtered.map((o) => {
                const licence = licenceEvidence(o);
                const status = statusLabel(o.status);
                const profit = profitText(o);
                return (
                  <div
                    key={o.bookmaker}
                    data-bookmaker={o.bookmaker}
                    data-testid="offers-row"
                    data-licence-evidence={licence.ok ? "yes" : "no"}
                    className="grid grid-cols-1 gap-2 px-6 py-3 text-sm transition-colors hover:bg-gray-50 sm:grid-cols-[1fr_auto_auto_auto_auto] sm:items-center sm:gap-3 dark:hover:bg-gray-900"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <a
                          href={o.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-semibold text-gray-900 hover:text-indigo-600 hover:underline dark:text-gray-100 dark:hover:text-indigo-400"
                        >
                          {o.bookmaker}
                        </a>
                        {licence.ok ? (
                          <span
                            data-testid="offers-row-uk-tick"
                            title={`Licensed: ${licence.licensee} — Gambling Commission account ${licence.registerAccount}`}
                            className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                          >
                            ✅ UK licensed
                          </span>
                        ) : (
                          <span
                            data-testid="offers-row-no-licence"
                            title="We could not check this operator on the Gambling Commission register, so we record no licence here — that is not a statement that they are unlicensed."
                            className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                          >
                            licence not recorded
                          </span>
                        )}
                        <span
                          data-testid="offers-row-status"
                          title={o.statusReason || undefined}
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${TONE_CLASS[status.tone]}`}
                        >
                          {status.text}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{o.offer}</p>
                      <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">
                        {o.jurisdiction ? `${o.jurisdiction} · ` : ""}checked {o.checked_on}
                        {o.verified_on ? ` · terms read ${o.verified_on}` : ""}
                      </p>
                      {/* Licence line: the operator's licence only — never a claim that the offer is running. */}
                      <LicenceLine
                        offer={o}
                        testId="offers-row-licence"
                        unknownTestId="offers-row-licence-unknown"
                        caveat="— a licence is not a terms check and it is not evidence this offer is live: the row's status above says whether the offer itself was confirmed."
                      />
                    </div>
                    <div className="text-right">
                      <span className="text-xs text-gray-400">Min stake</span>
                      <p className="font-medium text-gray-700 dark:text-gray-300">{o.minStake}</p>
                      <span className="text-[11px] text-gray-400">@ {o.minOdds}</span>
                    </div>
                    <div className="text-right">
                      <span className="text-xs text-gray-400">Free bets</span>
                      <p className="font-medium text-purple-600 dark:text-purple-400">{o.freeBetTokens}</p>
                      <span className="text-[11px] text-gray-400">{o.freeBetExpiry}</span>
                    </div>
                    <div className="text-right sm:max-w-[180px]">
                      <span className="text-xs text-gray-400">Est. profit</span>
                      {profit.isEstimate ? (
                        <p
                          title={profit.basis}
                          className="font-semibold text-indigo-600 dark:text-indigo-400"
                        >
                          {profit.text}
                        </p>
                      ) : (
                        <p className="text-[11px] text-gray-400">{profit.text}</p>
                      )}
                    </div>
                    <div className="text-right">
                      <span className="text-xs text-gray-400">UK/GBP</span>
                      <p className="font-medium">{o.ukGbp === "✅" ? "GBP" : "verify"}</p>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-gray-100 px-6 py-3 dark:border-gray-800">
            <p className="text-xs text-gray-400 text-center">
              “✅ UK licensed” appears only where we re-confirmed the operator on the Gambling Commission register
              and hold their account number; the row then names the licensee, links to the register and gives the
              date we checked. {withEvidence === 0
                ? "No row on this page carries that evidence today"
                : `${withEvidence} of ${OFFERS.length} rows carry it`}. Where we could not check an operator, the row
              says so and makes no licence claim — which is not a statement that the operator is unlicensed.
              running: that is what each row's status shows.{" "}
              <a href="/how-we-check-offers" className="underline hover:text-indigo-600 dark:hover:text-indigo-400">
                How we check these offers
              </a>.
            </p>
            <p className="text-xs text-gray-400 text-center mt-1">
              “unverified” = we could not read this offer on the bookmaker's own page; “re-checked” = we did, and
              the terms had changed. Only re-checked offers were read on the bookmaker's own page — the rest are a
              starting point, not a current quote.
            </p>
            <p className="text-xs text-gray-400 text-center mt-1">
              We do not quote a profit figure — what you keep depends on the odds you match at. Always check the
              terms on the bookmaker's own site before signing up. 18+ · begambleaware.org
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
