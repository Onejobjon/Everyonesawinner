import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  calcLay,
  layGap,
  round2,
  qualifiesForLay,
  type LayCalc,
} from "../lib/odds";
import {
  searchLeagues,
  type Match,
  type MatchOutcome,
  type LeagueSearchResult,
} from "../lib/odds-api";
import catalogue from "../data/sports-catalogue.json";
import Paywall from "../components/Paywall";
import PageHeader from "../components/PageHeader";
import CompetitionPicker from "../components/CompetitionPicker";
import Markdown from "../components/Markdown";
import layGuide from "../content/lay-betting-guide.md?raw";
import TwoUpNoteTag from "../components/TwoUpNoteTag";
import TwoUpGuideSection from "../components/TwoUpGuideSection";
import { twoUpNoteForOutcome } from "../lib/two-up";
import { getIcon, money } from "../lib/laybets-common";
import { CommissionControl, CommissionNote, useExchangeCommission } from "../components/CommissionControl";
import { kickoffFallsOn, londonDayKey, londonDayLabel, parseDayKey, resolveDayKeys, type DayMode } from "../lib/london-day";

const DEFAULT_STAKE = "20"; // cash qualifying back stake (user-editable)

/**
 * Which day of fixtures to SHOW. Defaults to Today.
 *
 * The filter runs on what came back — it never widens the request, so the price
 * quoted before the click (1 credit per competition) is still exactly what is
 * spent. That is deliberate: a date control that quietly asked the provider for
 * more would make the price on the button a lie.
 */
const DAY_MODES: { value: DayMode; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "next7", label: "Next 7 days" },
  { value: "date", label: "A specific date" },
];

function isDayMode(v: unknown): v is DayMode {
  return v === "today" || v === "tomorrow" || v === "next7" || v === "date";
}

// v2: the saved controls now include the selected competitions (v1 saved a
// "sport" category that no longer exists), so old state is deliberately ignored.
// The shape is unchanged by the 2026-11-04 redesign: the picker is presentation
// only, and `leagues` is still the array of selected competition keys.
const LS_KEY = "eaw_laybets_singles_v2";

/**
 * How many competitions one search may cover. The odds provider bills 1 credit
 * per request, so this is the hard ceiling on what a single button press can
 * spend — not a limit anyone should need to reach in normal use.
 */
const MAX_LEAGUES = 8;

interface LayOpportunity {
  match: Match;
  outcome: MatchOutcome;
  lay: LayCalc;
  gap: number;
}

interface CatalogueSport {
  key: string;
  title: string;
  label: string;
  group: string;
}

/**
 * The competition list is DATA, generated from the odds provider's own list by
 * `bun scripts/build-sports-catalogue.ts` (that call costs 0 credits). Nothing
 * here is hand-maintained, and the search endpoint validates every key against
 * the same file before spending a credit on it.
 */
const SPORTS = (catalogue as unknown as { sports: CatalogueSport[] }).sports;
const DEFAULT_KEYS = ((catalogue as unknown as { defaultKeys?: string[] }).defaultKeys ?? []).filter(
  (key) => SPORTS.some((s) => s.key === key),
);

/** Persisted controls. */
interface Persisted {
  stake: string;
  minOdds: string;
  leagues: string[];
  dayMode: DayMode;
  dayDate: string;
}

const DEFAULT_PERSISTED: Persisted = {
  stake: DEFAULT_STAKE,
  minOdds: "1.5",
  leagues: DEFAULT_KEYS,
  dayMode: "today",
  dayDate: "",
};

/** Parse a positive stake amount (empty/invalid → fallback). */
function parseAmount(raw: string, fallback: number): number {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Parse the min-odds text, clamping to ≥ 1.0 (empty/invalid → 1). */
function parseMinOdds(raw: string): number {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Persisted>;
      const leagues = Array.isArray(p.leagues)
        ? p.leagues.filter((k): k is string => typeof k === "string" && SPORTS.some((s) => s.key === k))
        : [];
      return {
        stake: typeof p.stake === "string" && p.stake.length > 0 ? p.stake : DEFAULT_STAKE,
        minOdds: typeof p.minOdds === "string" ? p.minOdds : DEFAULT_PERSISTED.minOdds,
        leagues: leagues.length > 0 ? leagues.slice(0, MAX_LEAGUES) : DEFAULT_KEYS,
        dayMode: isDayMode(p.dayMode) ? p.dayMode : "today",
        dayDate: typeof p.dayDate === "string" && parseDayKey(p.dayDate) ? p.dayDate : "",
      };
    }
  } catch {
    /* corrupted/stale — fall back to defaults */
  }
  return DEFAULT_PERSISTED;
}

function persist(p: Persisted): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {
    /* localStorage can throw in private mode — non-fatal */
  }
}

export default function LayBets() {
  const persisted = useMemo(loadPersisted, []);

  const [stake, setStake] = useState<string>(persisted.stake);
  const stakeVal = parseAmount(stake, 20);

  // Min odds stays as RAW TEXT while being typed; it is parsed on Search/blur.
  const [minOddsText, setMinOddsText] = useState<string>(persisted.minOdds);
  const [minOdds, setMinOdds] = useState<number>(() => parseMinOdds(persisted.minOdds));

  const [selected, setSelected] = useState<string[]>(persisted.leagues);

  // Which day to show. Defaults to Today (the weekend problem: a search used to
  // dump fixtures days away into one list with no way to say which day you wanted).
  const [dayMode, setDayMode] = useState<DayMode>(persisted.dayMode);
  const [dayDate, setDayDate] = useState<string>(
    () => persisted.dayDate || londonDayKey(new Date()) || "",
  );

  // ONE shared exchange commission, persisted across pages. 2% by default
  // (owner directive), adjustable — Betfair charges per market, so the rate has
  // to be the user's, and every figure below is labelled with it.
  const { pct: commPct, rate: commission, label: commLabel, setPct: setCommPct } =
    useExchangeCommission();

  /**
   * `idle` until the user presses Search. NOTHING is fetched on mount: opening
   * this page must cost nothing and scan nothing (owner, 2026-10-28 — the
   * automatic scan belongs to the alert worker, not this finder).
   */
  const [phase, setPhase] = useState<"idle" | "searching" | "done">("idle");
  const [result, setResult] = useState<LeagueSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Persist last-used controls across visits.
  useEffect(() => {
    persist({ stake, minOdds: minOddsText, leagues: selected, dayMode, dayDate });
  }, [stake, minOddsText, selected, dayMode, dayDate]);

  const toggleLeague = (key: string) => {
    setSelected((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      if (prev.length >= MAX_LEAGUES) return prev;
      return [...prev, key];
    });
  };

  const resetLeagues = () => setSelected(DEFAULT_KEYS);

  const runSearch = async () => {
    if (phase === "searching") return;
    if (selected.length === 0) {
      setError("Pick at least one competition — a search only runs over what you select.");
      return;
    }
    const appliedMinOdds = parseMinOdds(minOddsText);
    setMinOddsText(String(appliedMinOdds));
    setMinOdds(appliedMinOdds);
    setError(null);
    setPhase("searching");
    try {
      const r = await searchLeagues(selected);
      setResult(r);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The search failed.");
      // Keep any earlier results on screen rather than blanking the page.
      setPhase(result ? "done" : "idle");
    }
  };

  const searchMatches = result?.matches ?? [];

  // ── Which day is on screen ────────────────────────────────────────────────
  // Day boundaries are Europe/London calendar dates (the same helper the Instant
  // Wins feed uses), so "Today" means today for a UK user whatever this machine's
  // timezone says.
  const todayKey = londonDayKey(new Date()) ?? "";
  const dayKeys = useMemo(
    () => resolveDayKeys(dayMode, dayDate, new Date()),
    [dayMode, dayDate, todayKey],
  );

  const dayLabel = useMemo(() => {
    if (dayMode === "next7") {
      if (dayKeys.length < 7) return "Next 7 days";
      return `Next 7 days (${londonDayLabel(dayKeys[0])} – ${londonDayLabel(dayKeys[6])})`;
    }
    const key = dayKeys[0];
    if (!key) return "Today";
    const prefix = dayMode === "today" ? "Today — " : dayMode === "tomorrow" ? "Tomorrow — " : "";
    return `${prefix}${londonDayLabel(key)}`;
  }, [dayMode, dayKeys]);

  /** Fixtures that fall inside the chosen day(s) — the count shown on the page. */
  const dayMatches = useMemo(() => {
    return searchMatches.filter((m) => kickoffFallsOn(m.commenceTime, dayKeys));
  }, [searchMatches, dayKeys]);

  const results = useMemo(() => {
    const rows: LayOpportunity[] = [];
    // Rows where the feed quoted a lay price but the back/lay sanity check
    // withheld it (sentinel value, or a lay >10% below the back = two different
    // markets). Counted so the page can say so instead of silently hiding them.
    let withheld = 0;
    // Outcomes dropped entirely because the ONLY back price quoted was the
    // exchange that supplies the lay. Backing and laying the same exchange is a
    // guaranteed loss, so those rows cannot be shown at all — counted so the
    // page can say why instead of quietly returning fewer rows.
    let laySourceExcluded = 0;
    const sorted = [...dayMatches].sort(
      (a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime()
    );
    for (const m of sorted) {
      laySourceExcluded += m.backWithheldAsLaySource ?? 0;
      for (const o of m.outcomes) {
        if (o.odds < minOdds) continue;
        if (o.laySuspect) withheld++;
        // All odds with a lay gap < 0.2 (no back-odds ceiling). Ice hockey is
        // already excluded at the data layer (layOdds = null), so qualifiesForLay
        // returns false for it automatically.
        if (!qualifiesForLay(o.odds, o.layOdds, commission)) continue;
        const lay = calcLay(o.odds, o.layOdds, stakeVal, commission);
        if (!lay) continue;
        rows.push({ match: m, outcome: o, lay, gap: layGap(o.odds, o.layOdds!) });
      }
    }
    rows.sort((a, b) => {
      const d = round2(b.lay.profitLoss) - round2(a.lay.profitLoss);
      if (d !== 0) return d;
      return a.gap - b.gap;
    });
    return { singles: rows, withheld, laySourceExcluded };
  }, [dayMatches, minOdds, stakeVal, commission]);

  const bestProfit =
    results.singles.length > 0 ? round2(results.singles[0].lay.profitLoss) : 0;

  const failed = result ? result.leagues.filter((l) => !l.ok) : [];
  const answered = result ? result.leagues.filter((l) => l.ok) : [];

  const controlClass =
    "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:focus:ring-indigo-900";

  /** The card the results are made of — one shape, used by every row. */
  const cardClass = "rounded-xl border-2 bg-white p-4 shadow-sm transition-shadow hover:shadow-md sm:p-5 dark:bg-gray-950";

  return (
    <Paywall tier="pro" title="the Lay Bet Finder">
      <PageHeader
        title="Lay Bet Finder"
        subtitle="Back an outcome at the bookmaker, lay it on the exchange — and lock in the result. Pick the competitions you care about and search them yourself."
        note="Every close single lay comes back ranked by what it returns on your stake. Prices the feed reports as unavailable (1.00 / 451) are removed before any profit is calculated."
      >
        {/* ── What to search ───────────────────────────────────────────────── */}
        <CompetitionPicker
          sports={SPORTS}
          selected={selected}
          max={MAX_LEAGUES}
          onToggle={toggleLeague}
          onReset={resetLeagues}
          resetLabel="EPL, Championship & Champions League"
        />

        {/* ── Your search: day, stake, min odds, commission, go ─────────────── */}
        <section className="mt-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Your search</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400" role="status">
              Showing <strong className="text-indigo-700 dark:text-indigo-300">{dayLabel}</strong>
              {result
                ? ` — ${dayMatches.length} fixture${dayMatches.length === 1 ? "" : "s"} matched`
                : " — nothing searched yet"}
            </p>
          </div>

          {/* Which day — a filter on the RESULTS, never on the request. */}
          <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-gray-100 p-1 sm:grid-cols-4 dark:bg-gray-900">
            {DAY_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setDayMode(m.value)}
                aria-pressed={dayMode === m.value}
                className={`rounded-md px-2 py-2 text-xs font-medium transition-colors ${
                  dayMode === m.value
                    ? "bg-white text-indigo-700 shadow-sm dark:bg-gray-800 dark:text-indigo-300"
                    : "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {dayMode === "date" && (
            <label className="mt-2 block">
              <span className="sr-only">Choose a date</span>
              <input
                type="date"
                value={dayDate}
                onChange={(e) => setDayDate(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:focus:ring-indigo-900"
              />
            </label>
          )}

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Back stake</span>
              <div className="mt-1 flex items-center gap-1.5">
                <span className="text-sm font-semibold text-gray-600 dark:text-gray-300">£</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={stake}
                  onChange={(e) => setStake(e.target.value)}
                  onBlur={() => setStake(String(parseAmount(stake, 20)))}
                  className={controlClass}
                />
              </div>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Minimum back odds</span>
              <input
                type="text"
                inputMode="decimal"
                value={minOddsText}
                onChange={(e) => setMinOddsText(e.target.value)}
                onBlur={() => {
                  const v = parseMinOdds(minOddsText);
                  setMinOddsText(String(v));
                  setMinOdds(v);
                }}
                className={controlClass}
              />
            </label>

            <CommissionControl pct={commPct} onChange={setCommPct} />
          </div>

          <button
            onClick={() => void runSearch()}
            disabled={phase === "searching" || selected.length === 0}
            className="mt-3 w-full rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {phase === "searching"
              ? "Searching…"
              : `Search ${selected.length} competition${selected.length === 1 ? "" : "s"}`}
          </button>
          <p className="mt-1.5 text-center text-[11px] text-gray-500 dark:text-gray-400">
            {selected.length === 0
              ? "Nothing will be fetched — pick at least one competition above."
              : `${selected.length} competition${selected.length === 1 ? "" : "s"} · one fresh price read each. Nothing is fetched until you press Search.`}
          </p>
        </section>

        {/* The rules of the search — a short visible line, the detail on demand. */}
        <details className="mt-3 rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-950">
          <summary className="cursor-pointer list-none text-xs font-medium text-gray-700 dark:text-gray-200">
            What the search shows — and what it leaves out
          </summary>
          <div className="mt-2 space-y-2 text-xs text-gray-500 dark:text-gray-400">
            <p>
              Singles show every outcome with a lay gap under 0.20 (negative gap = better than
              break-even), on your £{stakeVal} cash back stake, including {commLabel} exchange
              commission (adjustable above — set it to what your exchange actually charges). Ice
              hockey is excluded — bookmaker back odds are regulation-time but exchange lays include
              overtime, so they never match.
            </p>
            <p>
              <strong>Nothing is fetched until you press Search.</strong> This page never searches on
              its own. A search reads fresh prices for each competition you selected, however many
              fixtures come back. The day filter only filters what came back — it never changes the
              request, so a date choice can never quietly ask for more. Prices the feed reports as
              unavailable (1.00 / 451) are removed, and a lay price more than 10% below the
              bookmaker price is withheld — those rows are two different markets, not an opportunity.
            </p>
          </div>
        </details>

        {error && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950">
            <p className="font-medium text-red-700 dark:text-red-400">The search could not run</p>
            <p className="mt-1 text-sm break-words text-red-600 dark:text-red-300">{error}</p>
          </div>
        )}

        {phase === "searching" && (
          <div className="mt-10 flex flex-col items-center justify-center gap-3">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Reading {selected.length} competition{selected.length === 1 ? "" : "s"} from the odds feed…
            </p>
          </div>
        )}

        {/* Before any search: say plainly that nothing has run. */}
        {phase === "idle" && !result && (
          <div className={`mt-6 border-gray-200 dark:border-gray-800 ${cardClass}`}>
            <div className="flex items-start gap-3">
              <span className="text-3xl">🔍</span>
              <div className="min-w-0">
                <p className="text-base font-semibold text-gray-700 dark:text-gray-200">No search has run yet</p>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  Nothing has been fetched from the odds feed, and this page will not search on its own.
                </p>
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  Press <strong>Search</strong> to read the latest prices for the{" "}
                  <strong>{selected.length}</strong> competition{selected.length === 1 ? "" : "s"} you
                  have chosen, and the page will show you exactly what came back.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* After a search: what was searched, what came back, what failed. */}
        {phase === "done" && result && (
          <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-900/50">
            <p role="status" className="text-sm text-gray-700 dark:text-gray-200">
              <strong>
                Searched {result.leagues.length} competition{result.leagues.length === 1 ? "" : "s"} in{" "}
                {(result.elapsedMs / 1000).toFixed(1)}s
              </strong>{" "}
              — {result.fixtures} fixture{result.fixtures === 1 ? "" : "s"} read, {results.singles.length}{" "}
              close-lay row{results.singles.length === 1 ? "" : "s"} found. Showing{" "}
              <strong>{dayLabel}</strong>: {dayMatches.length} fixture{dayMatches.length === 1 ? "" : "s"}{" "}
              matched.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {result.leagues.map((l) => (
                <span
                  key={l.key}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                    l.ok
                      ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300"
                      : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300"
                  }`}
                >
                  {l.ok ? "✓" : "⚠"} {l.label} — {l.ok ? `${l.events} fixture${l.events === 1 ? "" : "s"}` : "failed"}
                </span>
              ))}
            </div>
            {failed.length > 0 && (
              <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-300">
                  {failed.length} of {result.leagues.length} competitions failed — these results are
                  incomplete
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs break-words text-amber-800 dark:text-amber-300">
                  {failed.map((l) => (
                    <li key={l.key}>
                      <strong>{l.label}</strong> — {l.error ?? "no reason given"}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
                  The rows below come only from the {answered.length} competition
                  {answered.length === 1 ? "" : "s"} that answered. Nothing has been filled in to make
                  the list look complete — search again to retry the missing one
                  {failed.length === 1 ? "" : "s"}.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Withheld rows: always visible, never behind a disclosure. */}
        {results.withheld > 0 && (
          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
            <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
              ⚠️ {results.withheld} row{results.withheld === 1 ? "" : "s"} hidden — the exchange lay
              price was more than 10% below the bookmaker price, so it can't be matched. That gap
              nearly always means two different markets, not free money. See “Why you'll sometimes see
              fewer matches” in the guide below.
            </p>
          </div>
        )}

        {results.laySourceExcluded > 0 && (
          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
            <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
              ⚠️ {results.laySourceExcluded} outcome{results.laySourceExcluded === 1 ? "" : "s"}{" "}
              withheld — the only back price quoted came from the very exchange that lays it. Backing
              and laying the same exchange means paying the spread and the commission to yourself: it
              can only lose, so we won't show it as an opportunity.
            </p>
          </div>
        )}

        {phase === "done" && result && results.singles.length === 0 && dayMatches.length === 0 && (
          <div className={`mt-6 border-gray-200 dark:border-gray-800 ${cardClass}`}>
            <div className="flex items-start gap-3">
              <span className="text-3xl">📅</span>
              <div className="min-w-0">
                <p className="text-base font-semibold text-gray-700 dark:text-gray-200">
                  No fixtures on {dayLabel}
                </p>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  The search read <strong>{result.fixtures}</strong> fixture
                  {result.fixtures === 1 ? "" : "s"} from {answered.length} competition
                  {answered.length === 1 ? "" : "s"}, and none of them kicks off on the day you have
                  chosen. That is a date result, not an empty table — these prices are already read, so
                  try another day without searching again.
                </p>
                <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-gray-500 dark:text-gray-400">
                  <li>
                    Switch to <strong>Next 7 days</strong> to see everything this search returned.
                  </li>
                  <li>Or pick the specific date you care about.</li>
                  <li>Searching again is not needed for this.</li>
                </ul>
              </div>
            </div>
          </div>
        )}

        {phase === "done" && result && results.singles.length === 0 && dayMatches.length > 0 && (
          <div className={`mt-6 border-gray-200 dark:border-gray-800 ${cardClass}`}>
            <div className="flex items-start gap-3">
              <span className="text-3xl">🔍</span>
              <div className="min-w-0">
                <p className="text-base font-semibold text-gray-700 dark:text-gray-200">
                  No close lays match these settings
                </p>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  Showing <strong>{dayLabel}</strong>: {dayMatches.length} fixture
                  {dayMatches.length === 1 ? "" : "s"} matched out of the {result.fixtures} the search
                  read from {answered.length} competition{answered.length === 1 ? "" : "s"}.
                </p>
                <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-gray-500 dark:text-gray-400">
                  {minOdds > 1 && <li>Lower the minimum back odds.</li>}
                  <li>Add more competitions — a wider search reads more of the feed.</li>
                  <li>Odds move constantly; search again in a few minutes.</li>
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* ── Results: one column, one card shape ──────────────────────────── */}
        {phase === "done" && result && results.singles.length > 0 && (
          <>
            <div className="mt-6 grid grid-cols-1 gap-4">
              {results.singles.map((op) => {
                const profitable = op.lay.profitLoss >= 0;
                const isBest = profitable && round2(op.lay.profitLoss) === bestProfit;
                return (
                  <article
                    key={`${op.match.matchId}-${op.outcome.name}`}
                    className={`relative ${cardClass} ${
                      profitable ? "border-green-500" : "border-gray-200 dark:border-gray-800"
                    }`}
                  >
                    {isBest && (
                      <span className="absolute -top-3 right-4 rounded-full bg-green-600 px-3 py-1 text-xs font-bold text-white shadow-sm">
                        ★ Best
                      </span>
                    )}

                    {/* Fixture · competition · kick-off */}
                    <div className={`flex flex-wrap items-baseline gap-x-2 gap-y-1 ${isBest ? "pr-16" : ""}`}>
                      <h3 className="min-w-0 break-words text-base font-bold leading-tight text-gray-900 sm:text-lg dark:text-gray-100">
                        {op.match.home} <span className="font-normal text-gray-400">vs</span> {op.match.away}
                      </h3>
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                        {op.match.league}
                      </span>
                      <span className="text-[11px] text-gray-400 dark:text-gray-500">{op.match.time}</span>
                    </div>

                    {/* The outcome being backed and laid */}
                    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-gray-700 dark:text-gray-300">
                      <span className="text-base">{getIcon(op.outcome.name, op.match.home, op.match.away)}</span>
                      <span className="min-w-0 break-words font-semibold">{op.outcome.name}</span>
                      {/* Information only — never part of the numbers below. Derived
                          from src/data/2up-verified-offers.json; renders nothing for
                          any bookmaker not in that file. */}
                      {(() => {
                        const note = twoUpNoteForOutcome(op.outcome);
                        return note ? <TwoUpNoteTag note={note} /> : null;
                      })()}
                    </div>

                    {/* Back at the bookmaker, then lay on the exchange — stacked
                        on a phone, side by side from sm. */}
                    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
                      <div className="rounded-lg bg-gray-50 px-3 py-2.5 dark:bg-gray-900">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                            Back
                          </span>
                          <span className="text-xl font-extrabold tabular-nums text-gray-900 dark:text-white">
                            {op.outcome.odds.toFixed(2)}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
                          @ {op.outcome.bookmaker}
                        </div>
                        {op.outcome.backSourceExcluded && (
                          <div className="mt-1 text-[11px] leading-snug text-amber-600 dark:text-amber-400">
                            {op.outcome.laySource ?? "The laying exchange"}'s own back price was set
                            aside — backing and laying the same exchange cannot profit.
                          </div>
                        )}
                      </div>

                      <div className="rounded-lg bg-indigo-50 px-3 py-2.5 dark:bg-indigo-950/40">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[11px] font-medium uppercase tracking-wide text-indigo-500 dark:text-indigo-400">
                            Lay
                          </span>
                          <span className="text-xl font-extrabold tabular-nums text-indigo-700 dark:text-indigo-300">
                            {op.outcome.layOdds!.toFixed(2)}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate text-xs text-indigo-600 dark:text-indigo-400">
                          @ {op.outcome.laySource}
                        </div>
                        <div className="mt-0.5 text-[11px] leading-snug text-indigo-500 dark:text-indigo-400">
                          <CommissionNote pct={commPct} source={op.outcome.laySource} />
                        </div>
                      </div>
                    </div>

                    {/* The loudest number on the card. */}
                    <div className="mt-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-t border-gray-100 pt-3 dark:border-gray-800">
                      <div>
                        <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                          Profit / loss on {money(stakeVal)}
                        </div>
                        <div
                          className={`mt-0.5 text-2xl font-extrabold tabular-nums sm:text-3xl ${
                            profitable
                              ? "text-green-600 dark:text-green-400"
                              : "text-red-600 dark:text-red-400"
                          }`}
                        >
                          {profitable ? "+" : "−"}
                          {money(Math.abs(op.lay.profitLoss))}
                        </div>
                      </div>
                      <dl className="flex gap-4 text-xs text-gray-500 dark:text-gray-400">
                        <div>
                          <dt className="text-[10px] uppercase tracking-wide text-gray-400">Lay stake</dt>
                          <dd className="mt-0.5 font-semibold tabular-nums text-gray-700 dark:text-gray-200">
                            {money(op.lay.layStake)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-[10px] uppercase tracking-wide text-gray-400">Liability</dt>
                          <dd className="mt-0.5 font-semibold tabular-nums text-gray-700 dark:text-gray-200">
                            {money(op.lay.liability)}
                          </dd>
                        </div>
                      </dl>
                    </div>
                  </article>
                );
              })}
            </div>
            <p className="mt-4 text-xs text-gray-400 dark:text-gray-500">
              Showing {results.singles.length} close-lay opportunit
              {results.singles.length === 1 ? "y" : "ies"} on <strong>{dayLabel}</strong>. Lay =
              betting <strong>against</strong> the outcome on the exchange (Betfair or Smarkets — each
              row names its source). Figures use your £{stakeVal} back stake and include {commLabel}{" "}
              exchange commission (adjustable above).
            </p>
          </>
        )}

        <div className="mt-10 rounded-xl border border-gray-200 bg-gray-50 p-6 text-center dark:border-gray-800 dark:bg-gray-900/50">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Want to combine two or more legs into one bet with a done-for-you lay plan?
          </p>
          <Link
            to="/bet-builder"
            className="mt-3 inline-block rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700"
          >
            Open the Bet Builder →
          </Link>
        </div>

        <section className="mt-12 border-t border-gray-200 pt-8 dark:border-gray-800">
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
              <h2 className="text-xl font-bold tracking-tight sm:text-2xl">How lay betting works</h2>
              <svg
                className="h-5 w-5 flex-shrink-0 text-gray-400 transition-transform group-open:rotate-180"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </summary>
            <div className="mt-4">
              <Markdown source={layGuide} />
            </div>
            <TwoUpGuideSection />
          </details>
        </section>
      </PageHeader>
    </Paywall>
  );
}
