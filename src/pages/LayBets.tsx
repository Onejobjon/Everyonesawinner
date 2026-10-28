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
import Markdown from "../components/Markdown";
import layGuide from "../content/lay-betting-guide.md?raw";
import TwoUpNoteTag from "../components/TwoUpNoteTag";
import TwoUpGuideSection from "../components/TwoUpGuideSection";
import { twoUpNoteForOutcome } from "../lib/two-up";
import { getIcon, money } from "../lib/laybets-common";
import { CommissionControl, CommissionNote, useExchangeCommission } from "../components/CommissionControl";

const DEFAULT_STAKE = "20"; // cash qualifying back stake (user-editable)

// v2: the saved controls now include the selected competitions (v1 saved a
// "sport" category that no longer exists), so old state is deliberately ignored.
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
const GROUP_LABELS: Record<string, string> = { Soccer: "Football" };
/** Football first — it is what this tool is for — then everything else. */
const GROUPS: string[] = [...new Set(SPORTS.map((s) => s.group))].sort((a, b) => {
  if (a === "Soccer") return -1;
  if (b === "Soccer") return 1;
  return a.localeCompare(b);
});

/** Persisted controls. */
interface Persisted {
  stake: string;
  minOdds: string;
  leagues: string[];
}

const DEFAULT_PERSISTED: Persisted = {
  stake: DEFAULT_STAKE,
  minOdds: "1.5",
  leagues: DEFAULT_KEYS,
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

/** "3 credits" / "1 credit" — never a bare number next to the word credit. */
function credits(n: number): string {
  return `${n} credit${n === 1 ? "" : "s"}`;
}

export default function LayBets() {
  const persisted = useMemo(loadPersisted, []);

  const [stake, setStake] = useState<string>(persisted.stake);
  const stakeVal = parseAmount(stake, 20);

  // Min odds stays as RAW TEXT while being typed; it is parsed on Search/blur.
  const [minOddsText, setMinOddsText] = useState<string>(persisted.minOdds);
  const [minOdds, setMinOdds] = useState<number>(() => parseMinOdds(persisted.minOdds));

  const [selected, setSelected] = useState<string[]>(persisted.leagues);

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
    persist({ stake, minOdds: minOddsText, leagues: selected });
  }, [stake, minOddsText, selected]);

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

  const results = useMemo(() => {
    const rows: LayOpportunity[] = [];
    // Rows where the feed quoted a lay price but the back/lay sanity check
    // withheld it (sentinel value, or a lay >10% below the back = two different
    // markets). Counted so the page can say so instead of silently hiding them.
    let withheld = 0;
    const sorted = [...searchMatches].sort(
      (a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime()
    );
    for (const m of sorted) {
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
    return { singles: rows, withheld };
  }, [searchMatches, minOdds, stakeVal, commission]);

  const bestProfit =
    results.singles.length > 0 ? round2(results.singles[0].lay.profitLoss) : 0;

  const failed = result ? result.leagues.filter((l) => !l.ok) : [];
  const answered = result ? result.leagues.filter((l) => l.ok) : [];
  const costNow = selected.length;

  const controlClass =
    "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200";

  return (
    <Paywall tier="pro" title="the Lay Bet Finder">
      <div className="min-h-dvh page-bg font-['Inter',system-ui,sans-serif]">
        <nav className="border-b border-gray-200 bg-white/90 dark:border-gray-800 dark:bg-gray-950/90">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
            <Link to="/" className="flex items-center gap-2">
              <span className="rounded-lg bg-purple-600 p-2 text-white font-bold text-lg">EAW</span>
              <span className="text-xl font-bold tracking-tight">Everyone's A Winner</span>
            </Link>
            <div className="flex items-center gap-4">
              <Link to="/bet-builder" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400">🧮 Bet Builder</Link>
              <Link to="/oddsmatcher" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400">Best Odds</Link>
              <Link to="/dashboard" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">Dashboard →</Link>
            </div>
          </div>
        </nav>

        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <h1 className="text-3xl font-bold tracking-tight">Lay Bet Finder</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            Back an outcome at the bookmaker, lay it on the exchange — and lock in the result. Pick the competitions you care about and search them yourself; every close single lay comes back ranked by what it returns on your stake.
          </p>

          {/* Competition picker — the source of the search. */}
          <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Competitions to search</h2>
                <p className="text-xs text-gray-500">
                  {selected.length === 0
                    ? "Nothing selected — pick at least one."
                    : `${selected.length} of ${MAX_LEAGUES} selected · a search costs ${credits(costNow)} (the odds feed bills 1 credit per competition, whatever it returns)`}
                </p>
              </div>
              <button
                onClick={resetLeagues}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
              >
                Reset to EPL / Championship / Champions League
              </button>
            </div>

            {GROUPS.map((group) => {
              const groupSports = SPORTS.filter((s) => s.group === group);
              const label = GROUP_LABELS[group] ?? group;
              const chosen = groupSports.filter((s) => selected.includes(s.key)).length;
              const body = (
                <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
                  {groupSports.map((s) => {
                    const isOn = selected.includes(s.key);
                    const atCap = !isOn && selected.length >= MAX_LEAGUES;
                    return (
                      <label
                        key={s.key}
                        className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm ${
                          isOn ? "bg-purple-50 text-purple-900 dark:bg-purple-950/40 dark:text-purple-200" : "text-gray-600 dark:text-gray-300"
                        } ${atCap ? "cursor-not-allowed opacity-50" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={isOn}
                          disabled={atCap}
                          onChange={() => toggleLeague(s.key)}
                          className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                        />
                        <span className="truncate">{s.label}</span>
                      </label>
                    );
                  })}
                </div>
              );
              // Football is open by default (it is what this tool is for); the
              // other sports stay collapsed so the page is not a wall of boxes.
              if (group === "Soccer") {
                return (
                  <div key={group} className="mt-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                      {label} {chosen > 0 && <span className="text-purple-500">· {chosen} selected</span>}
                    </p>
                    {body}
                  </div>
                );
              }
              return (
                <details key={group} className="mt-3 group">
                  <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-wide text-gray-400">
                    {label} {chosen > 0 && <span className="text-purple-500">· {chosen} selected</span>} <span className="text-gray-300">▾</span>
                  </summary>
                  {body}
                </details>
              );
            })}
            {selected.length >= MAX_LEAGUES && (
              <p className="mt-3 text-xs text-gray-500">
                That is the most one search covers ({MAX_LEAGUES} competitions = {credits(MAX_LEAGUES)}). Untick one to swap it for another.
              </p>
            )}
          </div>

          {/* Controls: stake / min odds / search */}
          <div className="mt-4 grid grid-cols-2 items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="text-xs font-medium text-gray-500">Stake</span>
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
              <span className="text-xs font-medium text-gray-500">Minimum back odds</span>
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

            <div>
              <button
                onClick={() => void runSearch()}
                disabled={phase === "searching" || selected.length === 0}
                className="w-full rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {phase === "searching"
                  ? "Searching…"
                  : `Search ${selected.length} competition${selected.length === 1 ? "" : "s"}`}
              </button>
              <p className="mt-1 text-center text-[11px] text-gray-500">
                {selected.length === 0 ? "Nothing will be fetched" : `Costs ${credits(costNow)}`}
              </p>
            </div>
          </div>

          {/* Cost honesty, before the click. */}
          <p className="mt-3 text-xs text-gray-400">
            Singles show every outcome with a lay gap under 0.20 (negative gap = better than break-even), on your £{stakeVal} cash back stake, including {commLabel} exchange commission (adjustable above — set it to what your exchange actually charges). Ice hockey is excluded — bookmaker back odds are regulation-time but exchange lays include overtime, so they never match.
          </p>
          <p className="mt-1 text-xs text-gray-400">
            <strong>Nothing is fetched until you press Search.</strong> This page has no automatic scan — the scheduled scanning is the opportunity alerts, which run separately on their own timetable. A search reads the feed fresh for each competition you selected, and the odds provider bills <strong>1 credit per competition</strong> however many fixtures come back: {selected.length === 0 ? "nothing to spend yet" : `${credits(costNow)} for this selection`}. Prices the feed reports as unavailable (1.00 / 451) are removed, and a lay price more than 10% below the bookmaker price is withheld — those rows are two different markets, not an opportunity.
          </p>

          {error && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950">
              <p className="font-medium text-red-700 dark:text-red-400">The search could not run</p>
              <p className="mt-1 text-sm text-red-600 dark:text-red-300">{error}</p>
            </div>
          )}

          {phase === "searching" && (
            <div className="mt-10 flex flex-col items-center justify-center gap-3">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-purple-600 border-t-transparent" />
              <p className="text-sm text-gray-500">
                Reading {selected.length} competition{selected.length === 1 ? "" : "s"} from the odds feed…
              </p>
            </div>
          )}

          {/* Before any search: say plainly that nothing has run, and what it costs. */}
          {phase === "idle" && !result && (
            <div className="mt-8 rounded-xl border border-gray-200 bg-white p-8 dark:border-gray-800 dark:bg-gray-950">
              <div className="flex items-start gap-3">
                <span className="text-4xl">🔍</span>
                <div>
                  <p className="text-lg font-semibold text-gray-700 dark:text-gray-200">No search has run yet</p>
                  <p className="mt-1 text-sm text-gray-500">
                    Nothing has been fetched from the odds feed, and this page will not start a scan on its own.
                  </p>
                  <p className="mt-2 text-sm text-gray-500">
                    Press <strong>Search</strong> to read the latest prices for the{" "}
                    <strong>{selected.length}</strong> competition{selected.length === 1 ? "" : "s"} you have ticked. That costs{" "}
                    <strong>{credits(costNow)}</strong> — the odds provider bills one credit per competition however many fixtures
                    it returns — and the page will tell you exactly what it spent when the results come back.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* After a search: what was searched, what it cost, what failed. */}
          {phase === "done" && result && (
            <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-900/50">
              <p role="status" className="text-sm text-gray-700 dark:text-gray-200">
                <strong>
                  Searched {result.leagues.length} competition{result.leagues.length === 1 ? "" : "s"} in{" "}
                  {(result.elapsedMs / 1000).toFixed(1)}s
                </strong>{" "}
                — {result.fixtures} fixture{result.fixtures === 1 ? "" : "s"} read, {results.singles.length} close-lay row
                {results.singles.length === 1 ? "" : "s"} found. Credits spent:{" "}
                <strong>{credits(result.credits.spent)}</strong>
                {result.credits.measured ? " (measured by the odds feed)" : " (estimated — the feed did not report per-request cost)"}
                {result.credits.remaining != null ? ` · ${result.credits.remaining.toLocaleString()} left on the account` : ""}.
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
                    {failed.length} of {result.leagues.length} competitions failed — these results are incomplete
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-amber-800 dark:text-amber-300">
                    {failed.map((l) => (
                      <li key={l.key}>
                        <strong>{l.label}</strong> — {l.error ?? "no reason given"}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
                    The rows below come only from the {answered.length} competition{answered.length === 1 ? "" : "s"} that answered.
                    Nothing has been filled in to make the list look complete — search again to retry the missing one
                    {failed.length === 1 ? "" : "s"}.
                  </p>
                </div>
              )}
            </div>
          )}

          {results.withheld > 0 && (
            <p className="mt-2 text-xs font-medium text-amber-600 dark:text-amber-400">
              ⚠️ {results.withheld} row{results.withheld === 1 ? "" : "s"} hidden — the exchange lay price was more than 10% below the bookmaker price, so it can't be matched. That gap nearly always means two different markets, not free money. See “Why you'll sometimes see fewer matches” in the guide below.
            </p>
          )}

          {phase === "done" && result && results.singles.length === 0 && (
            <div className="mt-8 rounded-xl border border-gray-200 bg-white p-8 text-left dark:border-gray-800 dark:bg-gray-950">
              <div className="flex items-start gap-3">
                <span className="text-4xl">🔍</span>
                <div>
                  <p className="text-lg font-semibold text-gray-700 dark:text-gray-200">No close lays match these settings</p>
                  <p className="mt-1 text-sm text-gray-500">
                    The search read <strong>{result.fixtures}</strong> fixture{result.fixtures === 1 ? "" : "s"} from{" "}
                    {answered.length} competition{answered.length === 1 ? "" : "s"}.
                  </p>
                  <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-gray-500">
                    {minOdds > 1 && <li>Lower the minimum back odds.</li>}
                    <li>Add more competitions — a wider search costs more credits (1 each).</li>
                    <li>Odds move constantly; search again in a few minutes.</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {phase === "done" && result && results.singles.length > 0 && (
            <>
              <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {results.singles.map((op) => {
                  const profitable = op.lay.profitLoss >= 0;
                  const isBest = profitable && round2(op.lay.profitLoss) === bestProfit;
                  return (
                    <div
                      key={`${op.match.matchId}-${op.outcome.name}`}
                      className={`relative rounded-2xl border-2 bg-white p-5 shadow-sm transition-shadow hover:shadow-md dark:bg-gray-950 ${
                        profitable ? "border-green-300 dark:border-green-800" : "border-gray-200 dark:border-gray-800"
                      }`}
                    >
                      {isBest && (
                        <span className="absolute -top-3 right-4 rounded-full bg-green-600 px-3 py-1 text-xs font-bold text-white shadow-sm">★ Best</span>
                      )}
                      <div>
                        <div className="pr-16 text-lg font-bold leading-tight text-gray-900 dark:text-gray-100">
                          {op.match.home} <span className="font-normal text-gray-400">vs</span> {op.match.away}
                        </div>
                        <div className="mt-1 text-xs text-gray-400">{op.match.league} · {op.match.time}</div>
                      </div>
                      <div className="mt-3 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                        <span className="text-lg">{getIcon(op.outcome.name, op.match.home, op.match.away)}</span>
                        <span className="font-semibold">{op.outcome.name}</span>
                        {/* Information only — never part of the numbers below. Derived
                            from src/data/2up-verified-offers.json; renders nothing for
                            any bookmaker not in that file. */}
                        {(() => {
                          const note = twoUpNoteForOutcome(op.outcome);
                          return note ? <TwoUpNoteTag note={note} /> : null;
                        })()}
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-3">
                        <div className="rounded-xl bg-gray-50 p-3 dark:bg-gray-900">
                          <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Back</div>
                          <div className="mt-1 text-2xl font-extrabold text-gray-900 dark:text-white">{op.outcome.odds.toFixed(2)}</div>
                          <div className="mt-0.5 truncate text-xs text-gray-500">@ {op.outcome.bookmaker}</div>
                        </div>
                        <div className="rounded-xl bg-purple-50 p-3 dark:bg-purple-950/40">
                          <div className="text-[11px] font-medium uppercase tracking-wide text-purple-500">Lay</div>
                          <div className="mt-1 text-2xl font-extrabold text-purple-700 dark:text-purple-300">{op.outcome.layOdds!.toFixed(2)}</div>
                          <div className="mt-0.5 truncate text-xs text-purple-500">@ {op.outcome.laySource}</div>
                          <div className="mt-0.5 truncate text-[11px] text-purple-500">
                            <CommissionNote pct={commPct} source={op.outcome.laySource} />
                          </div>
                        </div>
                      </div>
                      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-gray-100 pt-3 dark:border-gray-800">
                        <div>
                          <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Lay stake</div>
                          <div className="mt-0.5 font-semibold text-gray-800 dark:text-gray-100">{money(op.lay.layStake)}</div>
                        </div>
                        <div>
                          <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Liability</div>
                          <div className="mt-0.5 font-semibold text-gray-800 dark:text-gray-100">{money(op.lay.liability)}</div>
                        </div>
                        <div>
                          <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Profit/Loss</div>
                          <div className={`mt-0.5 font-semibold ${profitable ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}>
                            {profitable ? "+" : "-"}{money(Math.abs(op.lay.profitLoss))}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-4 text-xs text-gray-400">
                Showing {results.singles.length} close-lay opportunities. Lay = betting <strong>against</strong> the outcome on the exchange (Betfair or Smarkets — each row names its source). Figures use your £{stakeVal} back stake and include {commLabel} exchange commission (adjustable above).
              </p>
            </>
          )}

          <div className="mt-10 rounded-xl border border-gray-200 bg-gray-50 p-6 text-center dark:border-gray-800 dark:bg-gray-900/50">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Want to combine two or more legs into one bet with a done-for-you lay plan?
            </p>
            <Link
              to="/bet-builder"
              className="mt-3 inline-block rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 transition-colors"
            >
              Open the Bet Builder →
            </Link>
          </div>

          <section className="mt-16 border-t border-gray-200 pt-10 dark:border-gray-800">
            <details open className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
                <h2 className="text-2xl font-bold tracking-tight">How lay betting works</h2>
                <svg className="h-5 w-5 flex-shrink-0 text-gray-400 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              </summary>
              <div className="mt-4"><Markdown source={layGuide} /></div>
              <TwoUpGuideSection />
            </details>
          </section>
        </div>
      </div>
    </Paywall>
  );
}
