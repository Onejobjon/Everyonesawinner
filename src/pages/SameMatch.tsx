import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Paywall from "../components/Paywall";
import { CommissionControl, CommissionNote, useExchangeCommission } from "../components/CommissionControl";

import { getMatches, searchLeagues, type Match } from "../lib/odds-api";
import catalogue from "../data/sports-catalogue.json";
import { sportCategory } from "../lib/laybets-common";
import {
  assertSingleLay,
  calcPinnedPlan,
  componentsMultiplied,
  findPinnedPlans,
  scorelineKey,
  type SameMatchPlan,
} from "../lib/same-match";
import {
  creditsFor,
  fetchMatchMarkets,
  marketsFor,
  type SameMatchFetchResult,
} from "../lib/same-match-fetch";

/**
 * /same-match — the Same-Match Planner (Pro).
 *
 * The owner's spec: "calculations that lead to 1 possible outcome for every
 * outcome that we can. They must result in 1 layable outcome, no more. So home
 * win, goals over 0.5 and under 1.5 could only be 1-0." And his constraint on
 * the output: "Only ever build bets for a single layable option on the exchange."
 *
 * The page is arranged in that order: pick a fixture (free), pay for that one
 * match's markets (cost stated before the click, one match at a time), see the
 * shortlist of plans that pin EXACTLY ONE scoreline, then type the two prices
 * only the user can know — the bookmaker's bet-builder price and the exchange's
 * lay price for that scoreline.
 *
 * Two facts are stated on the page, not just in the code, because the whole
 * honesty of the feature hangs on them:
 *   • no feed supplies a bet-builder price (combined markets are not served at
 *     all), so the bookmaker price is always the user's typed number;
 *   • the feed has no lay side for correct score, so the lay price is the user's
 *     typed number too — and exchange correct-score markets are often thin.
 */

const LS_KEY = "eaw_same_match_v1";
const DEFAULT_STAKE = "20";
const SHOW_PLANS = 12;

interface Persisted {
  stake: string;
  includeTeamTotals: boolean;
  includeReference: boolean;
}

const DEFAULT_PERSISTED: Persisted = { stake: DEFAULT_STAKE, includeTeamTotals: false, includeReference: false };

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_PERSISTED;
    const p = JSON.parse(raw) as Partial<Persisted>;
    return {
      stake: typeof p.stake === "string" && p.stake.length > 0 ? p.stake : DEFAULT_STAKE,
      includeTeamTotals: p.includeTeamTotals === true,
      includeReference: p.includeReference === true,
    };
  } catch {
    return DEFAULT_PERSISTED;
  }
}

function persist(p: Persisted): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {
    /* localStorage can be unavailable — non-fatal */
  }
}

function parseAmount(raw: string, fallback: number): number {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function money(n: number): string {
  const sign = n < 0 ? "−" : "";
  return `${sign}£${Math.abs(n).toFixed(2)}`;
}

function credits(n: number): string {
  return `${n} credit${n === 1 ? "" : "s"}`;
}

/** Plain-language names for the markets we ask for, so the cost list is readable. */
const MARKET_LABEL: Record<string, string> = {
  h2h: "match result",
  btts: "both teams to score",
  totals: "total goals",
  team_totals: "each team's goals",
  correct_score: "correct score (reference price only)",
};

interface CatalogueSport {
  key: string;
  label: string;
  group: string;
}

/**
 * Football competitions, for when the shared cached feed holds no football.
 *
 * It often doesn't: the cached `upcoming` list is whatever the feed returns
 * across every sport (frequently tennis-only). Rather than leave the planner
 * unusable, one competition can be asked for directly — and because that read
 * costs a credit, it is a separate, explicitly-priced button, never something
 * the page does on its own.
 */
const FOOTBALL_COMPETITIONS: CatalogueSport[] = ((catalogue as unknown as { sports: CatalogueSport[] }).sports ?? [])
  .filter((s) => s.group === "Soccer")
  .sort((a, b) => a.label.localeCompare(b.label));

const DEFAULT_COMPETITION = "soccer_epl";

export default function SameMatch() {
  const persisted = useMemo(loadPersisted, []);

  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [includeTeamTotals, setIncludeTeamTotals] = useState(persisted.includeTeamTotals);
  const [includeReference, setIncludeReference] = useState(persisted.includeReference);

  const [phase, setPhase] = useState<"idle" | "fetching" | "done">("idle");
  const [fetched, setFetched] = useState<SameMatchFetchResult | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchedFor, setFetchedFor] = useState<{ eventId: string; teamTotals: boolean; reference: boolean } | null>(null);

  const [chosenId, setChosenId] = useState<string | null>(null);
  const [bookmakerPriceText, setBookmakerPriceText] = useState("");
  const [layPriceText, setLayPriceText] = useState("");
  const [stakeText, setStakeText] = useState(persisted.stake);

  // Competition fixture search — the priced fallback when the shared cached feed
  // holds no football. One competition, one credit, on an explicit click.
  const [competition, setCompetition] = useState(DEFAULT_COMPETITION);
  const [compPhase, setCompPhase] = useState<"idle" | "fetching">("idle");
  const [compNote, setCompNote] = useState<string | null>(null);
  const [compError, setCompError] = useState<string | null>(null);

  const { pct: commPct, rate: commission, label: commLabel, setPct: setCommPct } = useExchangeCommission();
  const stake = parseAmount(stakeText, 20);

  useEffect(() => {
    persist({ stake: stakeText, includeTeamTotals, includeReference });
  }, [stakeText, includeTeamTotals, includeReference]);

  // The fixture list comes from the same 10-minute cached feed the rest of the
  // site reads. It costs nothing: no credit is spent until the fetch button.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getMatches()
      .then((data) => {
        if (cancelled) return;
        setMatches(data);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : "Could not load the fixture list.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * This planner only works on football: both-teams-to-score, total goals and
   * correct score are football markets. Anything else is filtered out rather
   * than listed and then failing.
   */
  const football = useMemo(
    () =>
      matches
        .filter((m) => sportCategory(m.sportKey) === "soccer")
        .sort((a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime()),
    [matches]
  );

  const selected = football.find((m) => m.matchId === selectedId) ?? null;

  const requestOptions = { includeTeamTotals, includeReference };
  const markets = marketsFor(requestOptions);
  const cost = creditsFor(requestOptions);
  const optionsChanged =
    fetchedFor != null &&
    (fetchedFor.teamTotals !== includeTeamTotals || fetchedFor.reference !== includeReference);

  /**
   * One competition's fixtures, on an explicit click.
   *
   * This is the one place the planner asks the feed for a LIST rather than a
   * match, and it costs 1 credit (1 request, match-result market, UK region) —
   * so it is a button with the price on it, not something the page does by
   * itself. Results are merged into the fixture list, never replacing it.
   */
  const findFixtures = async () => {
    if (compPhase === "fetching") return;
    setCompPhase("fetching");
    setCompError(null);
    setCompNote(null);
    try {
      const result = await searchLeagues([competition]);
      const fresh = result.matches.filter((m) => sportCategory(m.sportKey) === "soccer");
      const seen = new Set(matches.map((m) => m.matchId));
      const added = fresh.filter((m) => !seen.has(m.matchId));
      setMatches((prev) => [...prev, ...added]);
      const label = FOOTBALL_COMPETITIONS.find((c) => c.key === competition)?.label ?? competition;
      setCompNote(
        `${label}: ${fresh.length} fixture${fresh.length === 1 ? "" : "s"} returned` +
          (added.length < fresh.length ? ` (${fresh.length - added.length} already listed)` : "") +
          ` · ${credits(result.credits.spent)} spent${result.credits.remaining != null ? `, ${result.credits.remaining.toLocaleString()} left` : ""}`
      );
    } catch (e) {
      setCompError(e instanceof Error ? e.message : "That competition could not be read.");
    } finally {
      setCompPhase("idle");
    }
  };

  const runFetch = async () => {
    if (!selected || phase === "fetching") return;
    setPhase("fetching");
    setFetchError(null);
    setChosenId(null);
    try {
      const result = await fetchMatchMarkets({
        eventId: selected.matchId,
        sportKey: selected.sportKey,
        ...requestOptions,
      });
      setFetched(result);
      setFetchedFor({ eventId: selected.matchId, teamTotals: includeTeamTotals, reference: includeReference });
      setPhase("done");
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : "The fetch could not run.");
      setPhase(fetched ? "done" : "idle");
    }
  };

  /**
   * The shortlist. Every plan here pins exactly one scoreline and carries
   * exactly one lay — the search cannot produce anything else, and anything that
   * failed `assertSingleLay` would be dropped before it could be drawn.
   */
  const plans = useMemo(() => {
    if (!fetched) return [] as SameMatchPlan[];
    const found = findPinnedPlans(fetched.event.legs, { limit: 100 });
    const safe: SameMatchPlan[] = [];
    for (const plan of found) {
      try {
        assertSingleLay(plan);
        safe.push(plan);
      } catch {
        // A plan that is not exactly-one-lay never reaches the page.
      }
    }
    return safe;
  }, [fetched]);

  const chosen = plans.find((p) => p.id === chosenId) ?? null;
  const reference = chosen
    ? fetched?.event.reference.find((r) => r.scorelineKey === scorelineKey(chosen.pins)) ?? null
    : null;

  const calc = chosen
    ? calcPinnedPlan({
        bookmakerPrice: bookmakerPriceText.trim() === "" ? null : Number(bookmakerPriceText),
        layPrice: layPriceText.trim() === "" ? null : Number(layPriceText),
        backStake: stake,
        commission,
      })
    : null;

  const card = "rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950";
  const input =
    "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200";
  const label = "text-xs font-medium text-gray-500";

  return (
    <Paywall tier="pro" title="the Same-Match Planner">
      <div className="min-h-dvh page-bg font-['Inter',system-ui,sans-serif]">
        <nav className="border-b border-gray-200 bg-white/90 dark:border-gray-800 dark:bg-gray-950/90">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
            <Link to="/" className="flex items-center gap-2">
              <span className="rounded-lg bg-purple-600 p-2 text-lg font-bold text-white">EAW</span>
              <span className="text-xl font-bold tracking-tight">Everyone's A Winner</span>
            </Link>
            <div className="flex items-center gap-4">
              <Link to="/lay-bets" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400">⚡ Lay Bets</Link>
              <Link to="/bet-builder" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400">Bet Builder</Link>
              <Link to="/dashboard" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">Dashboard →</Link>
            </div>
          </div>
        </nav>

        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          <h1 className="text-3xl font-bold tracking-tight">Same-Match Planner</h1>
          <p className="mt-2 max-w-3xl text-gray-600 dark:text-gray-400">
            Build bets that can only land on <strong>one</strong> scoreline, then lay that one scoreline on the
            exchange. Home win + over 0.5 goals + under 1.5 goals can only be 1-0 — so the bet is backed at your
            bookmaker and 1-0 is laid as a single selection on the exchange.
          </p>
          <p className="mt-2 max-w-3xl text-sm text-purple-700 dark:text-purple-300">
            Every plan on this page pins exactly one scoreline and needs exactly one lay. Anything that could land on
            two scorelines never appears here — not with a warning, not greyed out. It is discarded.
          </p>

          {/* ── Step 1 ─────────────────────────────────────────────────── */}
          <section className={`mt-8 ${card}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold">1 · Pick one fixture</h2>
              <span className="rounded-full bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-700 dark:bg-green-900/50 dark:text-green-300">Free — no credits</span>
            </div>
            <p className="mt-1 text-sm text-gray-500">
              This list is football only (both-teams-to-score, goals and correct-score markets are football markets).
              It comes from the same odds feed the rest of the site reads, cached up to 10 minutes. Building the list
              costs nothing.
            </p>

            {loading && <p className="mt-4 text-sm text-gray-500">Loading fixtures…</p>}
            {loadError && !loading && (
              <p className="mt-4 text-sm text-red-600 dark:text-red-400">Couldn't load the fixture list — {loadError}</p>
            )}
            {!loading && !loadError && football.length === 0 && (
              <p className="mt-4 text-sm text-gray-500">
                The shared cached feed holds no football fixtures right now. Odds refresh about every 10 minutes — or
                ask the feed for one competition below ({credits(1)}).
              </p>
            )}

            {!loading && !loadError && football.length > 0 && (
              <div className="mt-4 max-h-72 space-y-2 overflow-y-auto pr-1">
                {football.map((m) => {
                  const active = m.matchId === selectedId;
                  return (
                    <button
                      key={m.matchId}
                      type="button"
                      onClick={() => {
                        setSelectedId(m.matchId);
                        // A different fixture means any plan on screen is for
                        // another match — clear it rather than let the prices
                        // be typed against the wrong game.
                        setChosenId(null);
                      }}
                      className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                        active
                          ? "border-purple-500 bg-purple-50 dark:bg-purple-950/40"
                          : "border-gray-200 hover:border-gray-300 dark:border-gray-800"
                      }`}
                    >
                      <span>
                        <span className="font-semibold">{m.home} v {m.away}</span>
                        <span className="ml-2 text-xs text-gray-500">{m.league}</span>
                      </span>
                      <span className="shrink-0 text-xs text-gray-500">{m.time}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Priced fallback: one competition's fixtures, on an explicit click.
                It costs a credit, so it never runs by itself — the price is on
                the button. */}
            <div className="mt-4 rounded-xl bg-gray-50 p-3 dark:bg-gray-900">
              <div className="text-xs font-medium text-gray-600 dark:text-gray-300">
                No football in the list you want? Ask the feed for one competition
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  value={competition}
                  onChange={(e) => setCompetition(e.target.value)}
                  className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200"
                >
                  {FOOTBALL_COMPETITIONS.map((c) => (
                    <option key={c.key} value={c.key}>{c.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void findFixtures()}
                  disabled={compPhase === "fetching"}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200"
                >
                  {compPhase === "fetching" ? "Reading…" : `Find fixtures — ${credits(1)}`}
                </button>
                <span className="text-[11px] text-gray-500">
                  One request for that competition's match-result market. Nothing is read until you press it.
                </span>
              </div>
              {compNote && <p className="mt-2 text-xs text-green-700 dark:text-green-400">{compNote}</p>}
              {compError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{compError}</p>}
            </div>
          </section>

          {/* ── Step 2 ─────────────────────────────────────────────────── */}
          <section className={`mt-4 ${card}`}>
            <h2 className="text-lg font-semibold">2 · Fetch this match's markets</h2>
            <p className="mt-1 text-sm text-gray-500">
              One match, one request, one time. Nothing is fetched until you press the button, and nothing runs in the
              background.
            </p>

            <ul className="mt-3 space-y-1 text-sm text-gray-600 dark:text-gray-300">
              {markets.map((m) => (
                <li key={m} className="flex items-center justify-between gap-3 border-b border-gray-100 py-1 last:border-0 dark:border-gray-800">
                  <span>{MARKET_LABEL[m] ?? m}</span>
                  <span className="text-xs font-medium text-gray-500">1 credit</span>
                </li>
              ))}
              <li className="flex items-center justify-between gap-3 pt-1 font-semibold text-gray-800 dark:text-gray-100">
                <span>Total for this match</span>
                <span>{credits(cost)}</span>
              </li>
            </ul>

            <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={includeTeamTotals}
                  onChange={(e) => setIncludeTeamTotals(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-purple-600"
                />
                <span>Each team's goal lines <span className="text-xs text-gray-500">(+1 credit — finds more two-leg plans)</span></span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={includeReference}
                  onChange={(e) => setIncludeReference(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-purple-600"
                />
                <span>Correct-score reference price <span className="text-xs text-gray-500">(+1 credit, optional)</span></span>
              </label>
            </div>

            {includeReference && (
              <p className="mt-2 text-xs text-gray-500">
                The reference price is a benchmark only: the best correct-score <em>back</em> price we can see for the
                pinned scoreline, from a named bookmaker. It is not a quote and it is not the lay price — we cannot see
                the exchange's lay side for a scoreline at all. Off by default because it costs a credit.
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void runFetch()}
                disabled={!selected || phase === "fetching"}
                className="rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {phase === "fetching"
                  ? "Fetching…"
                  : selected
                    ? `Fetch ${selected.home} v ${selected.away} — ${credits(cost)}`
                    : "Pick a fixture first"}
              </button>
              {selected && phase !== "fetching" && (
                <span className="text-xs text-gray-500">
                  Costs {credits(cost)} when you press this. It does not repeat — one press, one match.
                </span>
              )}
            </div>

            {optionsChanged && (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                You changed the market options after this match was fetched. The plans below were built from the
                markets you paid for, which did not include the new ones. Fetch again to include them ({credits(cost)}
                {" "}for this match).
              </p>
            )}

            {fetchError && (
              <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
                {fetchError}
              </p>
            )}

            {fetched && (
              <p className="mt-3 text-xs text-gray-500">
                Fetched {new Date(fetched.fetchedAt).toLocaleTimeString()} ·{" "}
                {fetched.credits.measured ? `${credits(fetched.credits.spent)} spent` : `about ${credits(fetched.credits.spent)} spent (estimated)`}{" "}
                {fetched.credits.remaining != null ? `· ${fetched.credits.remaining.toLocaleString()} credits left on the account` : ""}
                {" "}· markets: {fetched.marketsRequested.map((m) => MARKET_LABEL[m] ?? m).join(", ")}
              </p>
            )}
          </section>

          {/* ── Step 3: the shortlist ──────────────────────────────────── */}
          {fetched && (
            <section className={`mt-4 ${card}`}>
              <h2 className="text-lg font-semibold">3 · Plans that pin one scoreline</h2>

              {fetched.event.missingMarkets.length > 0 && (
                <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                  The feed quoted no prices for: {fetched.event.missingMarkets.map((m) => MARKET_LABEL[m] ?? m).join(", ")}.
                  Plans that need them are simply not offered — we never fill a gap with a made-up price.
                </p>
              )}
              {fetched.event.unreadableCorrectScoreOutcomes.length > 0 && (
                <p className="mt-2 text-xs text-gray-500">
                  The feed also prices scores we cannot use as a single line (
                  {fetched.event.unreadableCorrectScoreOutcomes.slice(0, 4).join(", ")}
                  {fetched.event.unreadableCorrectScoreOutcomes.length > 4 ? ", …" : ""}) — those are not a single
                  scoreline, so they are ignored rather than treated as one.
                </p>
              )}

              {plans.length === 0 ? (
                <div className="mt-4 text-sm text-gray-500">
                  <p className="font-medium text-gray-700 dark:text-gray-200">No combination of this match's markets pins a single scoreline.</p>
                  <p className="mt-1">
                    That happens on matches where the feed's lines are far apart, or where a market came back empty. The
                    tool only shows exact pins, so it shows nothing rather than something approximate.
                  </p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                    {!includeTeamTotals && <li>Tick “each team's goal lines” and fetch again — it widens the lines we can pin with (+1 credit).</li>}
                    <li>Try a different fixture — lines vary by match.</li>
                  </ul>
                </div>
              ) : (
                <>
                  <p className="mt-1 text-sm text-gray-500">
                    {plans.length} plan{plans.length === 1 ? "" : "s"} found, fewest legs first, each pinning exactly one
                    scoreline with exactly one lay. Showing {Math.min(plans.length, SHOW_PLANS)}.
                  </p>
                  <div className="mt-4 space-y-3">
                    {plans.slice(0, SHOW_PLANS).map((plan) => {
                      const active = plan.id === chosenId;
                      const product = componentsMultiplied(plan);
                      return (
                        <div
                          key={plan.id}
                          className={`rounded-xl border p-4 transition-colors ${
                            active
                              ? "border-purple-500 bg-purple-50/50 dark:bg-purple-950/20"
                              : "border-gray-200 dark:border-gray-800"
                          }`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
                                {plan.legCount} leg{plan.legCount === 1 ? "" : "s"} → only{" "}
                                <span className="text-purple-700 dark:text-purple-300">{scorelineKey(plan.pins)}</span>
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm">
                                {plan.legs.map((leg, i) => (
                                  <span key={leg.key} className="flex items-center gap-1.5">
                                    {i > 0 && <span className="text-gray-400">+</span>}
                                    <span className="rounded-md bg-gray-100 px-2 py-1 dark:bg-gray-800">{leg.label}</span>
                                  </span>
                                ))}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setChosenId(active ? null : plan.id);
                                setBookmakerPriceText("");
                                setLayPriceText("");
                              }}
                              className="rounded-lg bg-purple-600 px-3 py-2 text-xs font-semibold text-white hover:bg-purple-700"
                            >
                              {active ? "Hide prices" : "Use this plan"}
                            </button>
                          </div>

                          <div className="mt-3 grid gap-2 sm:grid-cols-2">
                            {plan.legs.map((leg) => (
                              <div key={leg.key} className="rounded-md bg-white px-2 py-1.5 text-xs dark:bg-gray-900">
                                <div className="text-gray-500">{leg.label}</div>
                                <div className="font-semibold text-gray-800 dark:text-gray-100">
                                  {leg.price ? leg.price.odds.toFixed(2) : "no price"}
                                  {leg.price && <span className="ml-1 font-normal text-gray-400">@ {leg.price.bookmaker}</span>}
                                </div>
                              </div>
                            ))}
                          </div>

                          <div className="mt-3 rounded-md bg-gray-50 px-2.5 py-2 text-xs text-gray-600 dark:bg-gray-900 dark:text-gray-300">
                            <div>
                              <strong>Lay exactly one selection:</strong>{" "}
                              {scorelineKey(plan.pins)} in your exchange's Correct Score market. Nothing else on that
                              market, and no second lay.
                            </div>
                            {product != null && (
                              <div className="mt-1 text-gray-500">
                                Components multiplied = {product.toFixed(2)} — an estimate that treats each leg as a
                                separate bet. A real bet-builder price is normally <em>shorter</em> than this, because
                                the bookmaker prices the combination. It is not your bookmaker's price.
                              </div>
                            )}
                            {product == null && (
                              <div className="mt-1 text-gray-500">
                                At least one leg has no price in the feed, so we cannot even estimate a combined price
                                for it.
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </section>
          )}

          {/* ── Step 4: the two prices ─────────────────────────────────── */}
          {chosen && (
            <section className={`mt-4 ${card}`}>
              <h2 className="text-lg font-semibold">4 · Your two prices</h2>
              <p className="mt-1 text-sm text-gray-500">
                These are the only two numbers the calculation needs, and both are yours: we cannot see either of
                them. Lay{" "}
                <strong className="text-gray-800 dark:text-gray-100">{scorelineKey(chosen.pins)}</strong> — one
                selection.
              </p>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="block">
                  <span className={label}>Bookmaker bet-builder price</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={bookmakerPriceText}
                    onChange={(e) => setBookmakerPriceText(e.target.value)}
                    placeholder="e.g. 9.00"
                    className={input}
                  />
                  <span className="mt-1 block text-[11px] leading-tight text-gray-400">
                    The price your bookmaker is showing for these legs.
                  </span>
                </label>
                <label className="block">
                  <span className={label}>Exchange lay price for {scorelineKey(chosen.pins)}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={layPriceText}
                    onChange={(e) => setLayPriceText(e.target.value)}
                    placeholder="e.g. 8.00"
                    className={input}
                  />
                  <span className="mt-1 block text-[11px] leading-tight text-gray-400">
                    Correct Score → {scorelineKey(chosen.pins)} on the exchange.
                  </span>
                </label>
                <label className="block">
                  <span className={label}>Stake — any amount</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={stakeText}
                    onChange={(e) => setStakeText(e.target.value)}
                    onBlur={() => setStakeText(String(parseAmount(stakeText, 20)))}
                    className={input}
                  />
                  <span className="mt-1 block text-[11px] leading-tight text-gray-400">
                    Your money at the bookmaker. No cap.
                  </span>
                </label>
                <CommissionControl pct={commPct} onChange={setCommPct} />
              </div>

              {calc && calc.status === "unavailable" && (
                <div className="mt-4 rounded-xl bg-gray-50 px-3 py-3 text-sm text-gray-600 dark:bg-gray-900 dark:text-gray-300">
                  <p className="font-medium text-gray-800 dark:text-gray-100">Plan unavailable</p>
                  <p className="mt-1">{calc.message}</p>
                  <p className="mt-2 text-xs text-gray-500">
                    Nothing has been defaulted to fill the gap: with no usable prices there is no plan to show, not a
                    plan with an assumed number in it.
                  </p>
                </div>
              )}

              {calc && calc.status === "ok" && (
                <>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-xl bg-gray-50 p-3 dark:bg-gray-900">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Lay stake</div>
                      <div className="mt-0.5 text-xl font-bold text-gray-900 dark:text-white">{money(calc.layStake)}</div>
                      <div className="text-[11px] text-gray-400">on {scorelineKey(chosen.pins)}, one selection</div>
                    </div>
                    <div className="rounded-xl bg-gray-50 p-3 dark:bg-gray-900">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Liability</div>
                      <div className="mt-0.5 text-xl font-bold text-gray-900 dark:text-white">{money(calc.liability)}</div>
                      <div className="text-[11px] text-gray-400">your worst-case outlay on the exchange</div>
                    </div>
                    <div className="rounded-xl bg-green-50 p-3 dark:bg-green-950/30">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-green-700 dark:text-green-400">
                        If {scorelineKey(chosen.pins)} lands
                      </div>
                      <div className={`mt-0.5 text-xl font-bold ${calc.profitIfPinned < 0 ? "text-red-600 dark:text-red-400" : "text-green-700 dark:text-green-300"}`}>
                        {money(calc.profitIfPinned)}
                      </div>
                      <div className="text-[11px] text-green-700/70 dark:text-green-400/70">builder wins, lay loses</div>
                    </div>
                    <div className="rounded-xl bg-green-50 p-3 dark:bg-green-950/30">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-green-700 dark:text-green-400">
                        If it does not land
                      </div>
                      <div className={`mt-0.5 text-xl font-bold ${calc.profitIfNot < 0 ? "text-red-600 dark:text-red-400" : "text-green-700 dark:text-green-300"}`}>
                        {money(calc.profitIfNot)}
                      </div>
                      <div className="text-[11px] text-green-700/70 dark:text-green-400/70">builder loses, lay wins</div>
                    </div>
                  </div>

                  <div className="mt-3 rounded-xl bg-purple-50 p-3 text-sm dark:bg-purple-950/30">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-purple-600 dark:text-purple-300">
                      Break-even bookmaker price
                    </div>
                    <div className="mt-0.5 text-2xl font-extrabold text-purple-700 dark:text-purple-200">
                      {calc.breakEvenBookmakerPrice.toFixed(2)}
                    </div>
                    <p className="mt-1 text-xs text-purple-700/80 dark:text-purple-300/80">
                      At {calc.breakEvenBookmakerPrice.toFixed(2)} the plan returns the same either way — exactly
                      nothing. Your price ({calc.bookmakerPrice.toFixed(2)}) is{" "}
                      {calc.edgeVsBreakEven >= 0 ? "above" : "below"} it by {Math.abs(calc.edgeVsBreakEven).toFixed(2)}
                      , so both outcomes {calc.profitIfPinned >= 0 ? "make" : "cost"} the same{" "}
                      {money(Math.abs(calc.profitIfPinned))}. Figures use{" "}
                      <CommissionNote pct={commPct} source={null} /> and a {money(calc.backStake)} stake.
                    </p>
                  </div>

                  {calc.farBelowBookPrice && (
                    <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                      Your lay price is more than 10% below your builder price. For a back/lay pair on the same market
                      that would mean two different markets — here the two prices <em>are</em> different markets, so
                      this is normal for the technique. Just double-check you are laying{" "}
                      {scorelineKey(chosen.pins)} and not a neighbouring scoreline.
                    </p>
                  )}
                </>
              )}

              {/* Reference price — deliberately its own block, never mixed with the maths */}
              <div className="mt-4 rounded-xl border border-dashed border-gray-300 p-3 dark:border-gray-700">
                <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Reference price — benchmark, not a quote</div>
                {reference ? (
                  <>
                    <p className="mt-1 text-sm text-gray-700 dark:text-gray-200">
                      Best correct-score <strong>back</strong> price we can see for {scorelineKey(chosen.pins)}:{" "}
                      <strong>{reference.odds.toFixed(2)}</strong> at {reference.bookmaker}.
                    </p>
                    {reference.isExchangeOwnPrice && (
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                        That is the exchange's own correct-score price. Backing at the exchange and laying on the same
                        exchange pays the spread and the commission to yourself, so treat it as the spread on offer —
                        not as a bookmaker price.
                      </p>
                    )}
                    <p className="mt-1 text-xs text-gray-500">
                      It is there to sanity-check your typed prices, not to replace them. A bookmaker's bet-builder
                      price is not a correct-score price, and the two are not interchangeable.
                    </p>
                  </>
                ) : (
                  <p className="mt-1 text-sm text-gray-500">
                    Not fetched. The reference price is an optional extra market costing 1 credit — tick “correct-score
                    reference price” above and fetch this match again if you want it.
                  </p>
                )}
                <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-300">
                  Thin market: exchange correct-score markets can be illiquid. There may be little or nothing available
                  to lay at the price you type, and the price can move before your bet is matched. The lay price here is
                  yours — we cannot confirm it is on offer.
                </p>
              </div>
            </section>
          )}

          {/* ── Where these numbers come from (required disclosure) ─────── */}
          <section className="mt-8 rounded-2xl border border-gray-200 bg-gray-50 p-5 text-sm dark:border-gray-800 dark:bg-gray-900">
            <h2 className="text-base font-semibold">Where these numbers come from</h2>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-gray-600 dark:text-gray-300">
              <li>
                <strong>Back prices</strong> (the legs of each plan) and the <strong>reference price</strong> come from
                one third-party odds feed, cached for up to 10 minutes. We do not query Betfair or Smarkets directly, and
                we do not read any exchange's API.
              </li>
              <li>
                <strong>Both prices in the calculation are yours.</strong> The bookmaker's bet-builder price and the
                exchange's lay price for the scoreline are typed by you. No feed supplies either one, so we never show
                a figure that looks like we know them.
              </li>
              <li>
                <strong>A price may have moved</strong> between the fetch and your bet. The 10-minute cache means a back
                price can be up to 10 minutes old, and exchange prices move by the second.
              </li>
              <li>
                <strong>The commission is yours too</strong> — currently {commLabel}, adjustable above, because Betfair
                charges per market (often 5% on main football).
              </li>
            </ul>
          </section>

          {/* ── Limits, stated plainly ─────────────────────────────────── */}
          <section className="mt-4 rounded-2xl border border-gray-200 bg-white p-5 text-sm dark:border-gray-800 dark:bg-gray-950">
            <h2 className="text-base font-semibold">What this tool cannot do</h2>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-gray-600 dark:text-gray-300">
              <li>
                <strong>We cannot see your bookmaker's bet-builder price.</strong> Our odds provider has no combined
                market at all — asking for one is refused — and a builder price is generated per customer anyway. That is
                why you type it.
              </li>
              <li>
                <strong>We cannot see the lay side for a scoreline.</strong> The feed carries a lay price for the match
                result only, and there is no correct-score lay market in it. That is why you type the lay price too.
              </li>
              <li>
                <strong>Illustration, not advice.</strong> The maths is exact arithmetic on the numbers you type; whether
                a price is actually available — especially on a thin correct-score market — is not something we can
                confirm.
              </li>
              <li>
                <strong>One match at a time, on purpose.</strong> Each fetch costs credits, so there is no sweep, no
                background scan and no auto-refresh. You pay only for the match you are looking at.
              </li>
            </ul>
          </section>
        </div>
      </div>
    </Paywall>
  );
}
