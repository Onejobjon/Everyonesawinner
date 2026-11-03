/**
 * INSTANT WINS panel — the GREEN trades in the next 26 hours, already on screen
 * when the page opens. No click, no search, and (the point) no provider call.
 *
 * It reads `GET /api/instant-wins`, which returns the in-window slice of the last
 * scheduled scan. "In the window" is the rolling 26 hours in `lib/scan-window.ts`,
 * NOT today's calendar date — the overnight NBA/NHL/NFL slate tips off after
 * midnight in London and is the reason the scan runs through the night.
 * Every number below is produced by the SHARED `calcLay` at the
 * user's own stake and the SHARED exchange-commission control, so this panel can
 * never disagree with the Lay Bet Finder or the calculator about money.
 *
 * OWNER REQUIREMENT (2026-11-02): "we need any odds visible, only rule being it
 * must be green." So there is no odds floor, no odds ceiling and no
 * qualifying-grade tier here: a row is shown if and only if the trade is
 * profitable on both sides after commission at the user's stake. A 1.05 and a
 * 14.0 both belong; a tight-but-unprofitable 2.00/2.05 does not.
 *
 * Honesty rules this panel keeps:
 *   • "as of HH:MM" from the scan's own timestamp, plus an explicit warning once
 *     the scan is older than STALE_AFTER_MIN — a stale row must never look live.
 *   • No scan data is a STATE ("no scan data yet"), never an empty list that
 *     would read as "no opportunities".
 *   • An empty feed still shows its coverage ("looked at N fixtures across M
 *     sports") so "no green trades" can never be mistaken for "the feed broke".
 *   • A green row is a FEED price, not a guaranteed fill: exchange liquidity can
 *     make the lay unachievable at that price, and the panel says so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { sessionToken, type Match } from "../lib/odds-api";
import {
  buildInstantWins,
  coverageLine,
  STALE_AFTER_MIN,
} from "../lib/instant-wins";
import { londonDayKey, londonDayLabel, londonTimeLabel } from "../lib/london-day";
import { SCAN_WINDOW_HOURS, windowPhrase } from "../lib/scan-window";
import { money } from "../lib/laybets-common";
import { CommissionControl, CommissionNote, useExchangeCommission } from "./CommissionControl";
import GreensPanel, { type GreensSummary } from "./GreensPanel";

interface Payload {
  ok?: boolean;
  status?: "ok" | "no_scan";
  message?: string;
  scannedAt?: string | null;
  ageMinutes?: number | null;
  oldestPriceAt?: string | null;
  priceAgeMinutes?: number | null;
  stale?: boolean;
  staleAfterMin?: number;
  fixturesScanned?: number;
  sportsScanned?: number;
  fixturesInWindow?: number;
  sportsInWindow?: number;
  sportsInSeason?: number;
  indexSportsInWindow?: number;
  indexFixturesInWindow?: number;
  matches?: Match[];
  /** Greens found in the last 30 days — already in the payload, so no extra cost. */
  greens30d?: GreensSummary;
  /**
   * A scan was started when this page opened (owner directive 2026-11-03, "scan
   * every 30mins and on open"). The rows above are still the previous snapshot —
   * the page re-checks once, ~30 s later, and swaps in the newer data if it landed.
   */
  refreshing?: boolean;
  /** When that on-open scan started (ISO). */
  refreshStartedAt?: string | null;
  /** The most recent on-open scan failed — the prices here may have moved. */
  refreshFailed?: boolean;
  error?: string;
}

const DEFAULT_STAKE = "20";

function parseStake(raw: string): number {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

/** "3 minutes" / "1 hour 20 minutes" — how old the scan is, in words. */
function ageWords(minutes: number): string {
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h} hour${h === 1 ? "" : "s"}${m ? ` ${m} minute${m === 1 ? "" : "s"}` : ""}`;
}

export default function InstantWins() {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stake, setStake] = useState<string>(DEFAULT_STAKE);
  // A re-check that failed on the way back. Kept separate from the server's
  // `refreshFailed` so a dropped connection says the same thing as a failed scan.
  const [recheckFailed, setRecheckFailed] = useState(false);
  // Bounded, so a slow scan can never turn into a polling loop.
  const rechecks = useRef(0);
  const { pct: commPct, rate: commission, label: commLabel, setPct: setCommPct } =
    useExchangeCommission();

  const stakeVal = parseStake(stake);

  /**
   * ONE read on open, plus at most one silent re-check.
   *
   * The server starts a scan if the prices it holds are stale ("scan on open"),
   * and answers IMMEDIATELY with the old snapshot and `refreshing: true`. So:
   *   • a first read may set the panel to loading;
   *   • a re-check (`silent`) NEVER blanks the panel — if it fails, the rows the
   *     user is reading stay exactly where they are and we say the prices may have
   *     moved. Blanking a list of prices because a refresh failed would be a lie:
   *     it would read as "no green trades".
   */
  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    const silent = opts.silent === true;
    if (!silent) {
      setPhase("loading");
      setError(null);
    }
    try {
      const token = sessionToken();
      const headers: Record<string, string> = { accept: "application/json" };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch("/api/instant-wins", { headers, cache: "no-store" });
      const body = (await res.json().catch(() => null)) as Payload | null;
      if (!res.ok || !body) {
        if (silent) {
          setRecheckFailed(true);
          return;
        }
        setError(body?.message || body?.error || `The feed could not load (${res.status}).`);
        setPhase("error");
        return;
      }
      setRecheckFailed(false);
      setError(null);
      setPayload(body);
      setPhase("ready");
    } catch (e) {
      if (silent) {
        setRecheckFailed(true);
        return;
      }
      setError(e instanceof Error ? e.message : "The feed could not load.");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The on-open scan was started by the server. Look once more in ~30 s — by then
  // a normal scan has finished — and render the newer data if it has landed. Two
  // attempts at most, so a wedged scan cannot become a polling loop.
  useEffect(() => {
    if (!payload?.refreshing) return;
    if (rechecks.current >= 2) return;
    const timer = setTimeout(() => {
      rechecks.current += 1;
      void load({ silent: true });
    }, 30_000);
    return () => clearTimeout(timer);
  }, [payload?.refreshing, payload?.scannedAt, load]);

  const now = useMemo(() => new Date(), [payload]);
  const built = useMemo(() => {
    const matches = payload?.matches ?? [];
    return buildInstantWins(matches, { now, stake: stakeVal, commission });
  }, [payload, now, stakeVal, commission]);

  // "As of" is the OLDEST price in the list, not when the loop last ticked:
  // each sport refreshes on its own clock, so the two are different things.
  const priceAt = payload?.oldestPriceAt ?? payload?.scannedAt ?? null;
  const asOfTime = priceAt ? londonTimeLabel(priceAt) : null;
  const asOfDay = priceAt ? londonDayKey(priceAt) : null;
  const todayKey = londonDayKey(new Date());
  const asOfLabel =
    asOfTime && asOfDay
      ? asOfDay === todayKey
        ? `${asOfTime} today`
        : `${asOfTime} on ${londonDayLabel(asOfDay)}`
      : null;
  const stale = Boolean(payload?.stale);
  const staleAfterMin = payload?.staleAfterMin ?? STALE_AFTER_MIN;
  const coverage = coverageLine(built);

  return (
    <section className="mt-8 rounded-2xl border border-purple-200 bg-white p-6 dark:border-purple-900 dark:bg-gray-950">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <span>⚡</span> Instant wins — green trades in the next {SCAN_WINDOW_HOURS} hours
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-gray-600 dark:text-gray-400">
            Already on screen when you open this page — no search, no click. Every sport we
            cover, at <strong>any odds</strong>: the only thing that gets a trade onto this list is
            that it returns money whichever way the result goes, after commission, on your stake.
          </p>
          <p className="mt-2 inline-block rounded-lg bg-purple-50 px-3 py-1 text-xs font-medium text-purple-800 dark:bg-purple-950/50 dark:text-purple-200">
            Loads straight from the list we already hold — no search, no click.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <label className="block w-32">
            <span className="text-xs font-medium text-gray-500">Your stake</span>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="text-sm font-semibold text-gray-600 dark:text-gray-300">£</span>
              <input
                type="text"
                inputMode="decimal"
                value={stake}
                onChange={(e) => setStake(e.target.value)}
                onBlur={() => setStake(String(parseStake(stake)))}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
                aria-label="Your back stake in pounds"
              />
            </div>
          </label>
        </div>
      </div>

      {/* Freshness — always visible, and loud once the scan is old. */}
      {phase === "ready" && payload?.status === "ok" && (
        <div className="mt-4">
          {payload?.refreshing && (
            <p
              className="mb-2 rounded-lg border border-purple-200 bg-purple-50 p-3 text-sm font-medium text-purple-900 dark:border-purple-900 dark:bg-purple-950/40 dark:text-purple-200"
              role="status"
            >
              Updating these prices now — the list below is the previous set, and this page will
              swap in the new one as soon as it lands. You do not need to do anything.
            </p>
          )}
          {(payload?.refreshFailed || recheckFailed) && !payload?.refreshing && (
            <p
              className="mb-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
              role="status"
            >
              We could not update these prices just now, so they may have moved since we looked.
              What you see below is the last set we did read — check the price at the bookmaker and
              the exchange before you place anything.
            </p>
          )}
          <p className="text-sm text-gray-700 dark:text-gray-200" role="status">
            {asOfLabel ? (
              <>
                Prices <strong>as of {asOfLabel}</strong>
                {typeof payload.priceAgeMinutes === "number"
                  ? ` (${ageWords(payload.priceAgeMinutes)} ago — the oldest in this list)`
                  : ""}{" "}
                —{" "}
                {built.fixturesInWindow} fixture{built.fixturesInWindow === 1 ? "" : "s"} across{" "}
                {built.sportsInWindow} sport{built.sportsInWindow === 1 ? "" : "s"} kicking off{" "}
                {windowPhrase()}.
              </>
            ) : (
              <>We did not record a time for these prices.</>
            )}
          </p>
          {stale && (
            <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              ⚠️ Some prices here are {ageWords(payload.priceAgeMinutes ?? staleAfterMin)} old — they
              may have moved since we last looked. We refresh sports in turn rather than all at
              once, so a sport can be up to about {staleAfterMin} minutes old. Check the price at the
              bookmaker and the exchange before you place anything.
            </p>
          )}
          <p className="mt-1 text-[11px] text-gray-400">
            Next {SCAN_WINDOW_HOURS} hours only: a fixture qualifies when it has not started and
            kicks off within the next {SCAN_WINDOW_HOURS} hours — whatever the date, so an overnight
            US tip-off is included. Anything further out is excluded by design — for those, use the
            Lay Bet Finder&apos;s date option.
          </p>
        </div>
      )}

      {/* Controls that change the money, not the feed. */}
      {phase === "ready" && payload?.status === "ok" && (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <CommissionControl pct={commPct} onChange={setCommPct} />
          <div className="self-end text-[11px] text-gray-400">
            Every figure below uses the shared lay calculator at your £{stakeVal} stake and{" "}
            {commLabel} exchange commission.
          </div>
        </div>
      )}

      {phase === "loading" && (
        <p className="mt-6 text-sm text-gray-500">Loading prices…</p>
      )}

      {phase === "error" && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950">
          <p className="font-medium text-red-700 dark:text-red-400">The feed could not load</p>
          <p className="mt-1 text-sm text-red-600 dark:text-red-300">{error}</p>
          <button
            onClick={() => void load()}
            className="mt-3 rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-300"
          >
            Try again
          </button>
        </div>
      )}

      {/* NO SCAN is its own state — never an empty list.
          The explanation is the SERVER's own `message`, not our guess about how
          often anything runs: on the published host the feed can be unable to see
          the scanner at all, and "it runs every 10 minutes" would then be a
          promise we cannot keep. Whatever the server says, it is written for a
          customer — no schedule, no machinery. */}
      {phase === "ready" && payload?.status === "no_scan" && (
        <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-6 dark:border-gray-800 dark:bg-gray-900/50">
          <p className="text-lg font-semibold text-gray-700 dark:text-gray-200">No prices yet</p>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {payload.message?.trim() || "There are no prices to show you yet."}
          </p>
          <p className="mt-2 text-sm text-gray-500">
            This is not &ldquo;no green trades&rdquo; — it means we have no prices to show you yet.
            Check back in a few minutes.
          </p>
          {payload?.refreshing && (
            <p className="mt-2 text-sm font-medium text-purple-700 dark:text-purple-300" role="status">
              We are reading the latest prices now — this page will fill in on its own.
            </p>
          )}
        </div>
      )}

      {/* Scanned, but nothing green in the window. Says so in exactly those words,
          and still shows what the scan covered. */}
      {phase === "ready" && payload?.status === "ok" && built.rows.length === 0 && (
        <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-6 dark:border-gray-800 dark:bg-gray-900/50">
          <p className="text-lg font-semibold text-gray-700 dark:text-gray-200">
            No green trades right now
          </p>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            We {coverage} — <strong>{built.outcomesConsidered}</strong> outcome
            {built.outcomesConsidered === 1 ? "" : "s"} priced, and none of them was profitable on
            both sides after commission at your £{stakeVal} stake.
          </p>
          <ul className="mt-2 space-y-1 text-xs text-gray-500">
            <li>
              {built.noLayPrice} outcome{built.noLayPrice === 1 ? "" : "s"} had no exchange lay price
              — those cannot be matched at all, so they cannot be green.
            </li>
            <li>
              {built.notGreen} outcome{built.notGreen === 1 ? "" : "s"} had a lay price but was not
              green at {commLabel} commission; raising or lowering the commission above can move a
              marginal one either way.
            </li>
            {built.withheld > 0 && (
              <li>
                {built.withheld} row{built.withheld === 1 ? "" : "s"} withheld by the price sanity
                check — the lay was far below the bookmaker price, which nearly always means two
                different markets rather than free money.
              </li>
            )}
          </ul>
          {typeof payload.indexFixturesInWindow === "number" && payload.indexFixturesInWindow > 0 && (
            <p className="mt-2 text-xs text-gray-500">
              The next {SCAN_WINDOW_HOURS} hours hold {payload.indexFixturesInWindow} fixture
              {payload.indexFixturesInWindow === 1 ? "" : "s"} across{" "}
              {payload.indexSportsInWindow} sport{payload.indexSportsInWindow === 1 ? "" : "s"} in
              total; we refresh sports in turn rather than all at once, so we hold prices for{" "}
              {built.fixturesInWindow} of them right now.
            </p>
          )}
          <p className="mt-2 text-sm text-gray-500">
            Prices move constantly — this panel updates on your next visit. You can also search
            specific competitions yourself in the Lay Bet Finder.
          </p>
        </div>
      )}

      {phase === "ready" && payload?.status === "ok" && built.rows.length > 0 && (
        <>
          <p className="mt-4 text-sm font-medium text-gray-800 dark:text-gray-100">
            {built.rows.length} green trade{built.rows.length === 1 ? "" : "s"} — we {coverage},
            best return first.
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-[11px] uppercase tracking-wide text-gray-400 dark:border-gray-800">
                  <th className="py-2 pr-3 font-medium">Kick-off</th>
                  <th className="py-2 pr-3 font-medium">Match</th>
                  <th className="py-2 pr-3 font-medium">Back (bookmaker)</th>
                  <th className="py-2 pr-3 font-medium">Lay (exchange)</th>
                  <th className="py-2 pr-3 font-medium">Gap</th>
                  <th className="py-2 font-medium">Returns on £{stakeVal}</th>
                </tr>
              </thead>
              <tbody>
                {built.rows.map((r) => (
                  <tr
                    key={`${r.matchId}-${r.outcome}`}
                    className="border-b border-gray-100 align-top last:border-0 dark:border-gray-900"
                  >
                    <td className="py-3 pr-3 font-semibold text-gray-800 dark:text-gray-100">
                      {r.kickoffTime}
                    </td>
                    <td className="py-3 pr-3">
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {r.home} <span className="font-normal text-gray-400">vs</span> {r.away}
                      </div>
                      <div className="text-xs text-gray-400">
                        {r.league} · backing <strong>{r.outcome}</strong>
                      </div>
                    </td>
                    <td className="py-3 pr-3">
                      <div className="font-semibold text-gray-900 dark:text-white">
                        {r.backOdds.toFixed(2)}
                      </div>
                      <div className="text-xs text-gray-500">{r.bookmaker}</div>
                    </td>
                    <td className="py-3 pr-3">
                      <div className="font-semibold text-purple-700 dark:text-purple-300">
                        {r.layOdds.toFixed(2)}
                      </div>
                      <div className="text-xs text-purple-500">{r.laySource ?? "exchange"}</div>
                      <div className="text-[11px] text-purple-500">
                        <CommissionNote pct={commPct} source={r.laySource} />
                      </div>
                    </td>
                    <td className="py-3 pr-3">
                      <span className="font-semibold text-green-600 dark:text-green-400">
                        {r.gap > 0 ? "+" : ""}
                        {r.gap.toFixed(2)}
                      </span>
                    </td>
                    <td className="py-3">
                      <div className="font-semibold text-green-600 dark:text-green-400">
                        +{money(r.profitLoss)}
                      </div>
                      <div className="text-[11px] text-gray-400">
                        lay {money(r.layStake)} · liability {money(r.liability)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 space-y-1 text-[11px] text-gray-400">
            <p>
              <strong>A green row is a feed price, not a guaranteed fill.</strong> Exchange liquidity
              can make the lay unachievable at the price shown — the amount matched at that price may
              be smaller than your stake, so check the available size on the exchange before you
              commit. If it is not there, the trade is not green at your stake.
            </p>
            <p>
              Every row is priced at your £{stakeVal} stake with {commLabel} exchange commission
              (adjustable above). No odds floor and no odds ceiling: a short-priced and a long-priced
              trade are both shown when the money works.
            </p>
            <p>
              These are the prices we held when you opened this page, not a fresh check made for
              your visit. We can only see pre-match back prices and exchange lay prices —
              bet-builder and same-game prices are generated by the bookmaker for you personally, so
              they are not in this feed.
            </p>
          </div>
        </>
      )}

      {/* GREENS IN THE LAST 30 DAYS — under the live feed, from the same payload
          (zero extra cost). Empty history is printed as empty. */}
      {phase === "ready" && <GreensPanel greens={payload?.greens30d} />}

      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-gray-100 pt-4 dark:border-gray-800">
        <Link
          to="/lay-bets"
          className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700"
        >
          Open the Lay Bet Finder — search your own competitions →
        </Link>
        <span className="text-xs text-gray-500">
          The finder is the manual search: you pick competitions and a date, and it reads fresh
          prices when you press Search. This panel is the already-loaded list.
        </span>
      </div>
    </section>
  );
}
