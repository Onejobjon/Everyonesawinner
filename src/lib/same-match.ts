/**
 * SAME-MATCH SCORELINE PINNING — the maths for /same-match.
 *
 * The owner's spec, verbatim: "calculations that lead to 1 possible outcome for
 * every outcome that we can. They must result in 1 layable outcome, no more. So
 * home win, goals over 0.5 and under 1.5 could only be 1-0."
 *
 * His constraint on the output, and the load-bearing rule of this whole file:
 * **"Only ever build bets for a single layable option on the exchange."** A plan
 * that would need two lays, or a lay on something that is not a single exchange
 * selection, must never be shown. So:
 *
 *   • `SameMatchPlan.lay` is a 1-TUPLE (`readonly [LaySelection]`), not an
 *     array. Adding a second lay is a TYPE ERROR, not a convention.
 *   • `buildPlan()` is the only constructor and THROWS unless it is handed
 *     exactly one lay — the runtime half of the same rule, because a type alone
 *     is not enforced by `vite build` (esbuild strips types without checking).
 *   • The lay is always the CORRECT SCORE market for the ONE pinned scoreline.
 *     That is a single exchange selection; nothing here can produce a plan whose
 *     lay is spread over several selections.
 *
 * TWO HONEST LIMITS THIS FILE IS BUILT AROUND (researched, settled — see
 * /home/team/shared/data-source-findings-2026-10-28.md):
 *
 *  1. Our odds feed has NO combined / SGM market. `bet_builder`,
 *     `same_game_multi`, `combo` and `winner_and_btts` all return
 *     422 INVALID_MARKET, and a bookmaker's builder price is generated live per
 *     user. There is therefore no feed that can tell us the bookmaker's price:
 *     it is ALWAYS the user's typed number. We never fetch it, never guess it.
 *
 *  2. The feed carries exactly ONE lay market, `h2h_lay` (match result). There
 *     is no `correct_score_lay`, `btts_lay` or `totals_lay`, so the exchange's
 *     lay price for a single scoreline is ALSO the user's typed number. We can
 *     see correct-score BACK prices (williamhill / paddypower / betfair_ex_uk)
 *     and we show the best of them as a labelled BENCHMARK — never as a quote,
 *     and never as the lay price.
 *
 * No second lay formula lives here: the money maths calls `calcLay()` from
 * ./odds (commission-aware, no £20 cap), and prices pass through the shared
 * Odds Sanity Rule in ./odds-sanity (1.01 ≤ p < 451; an exchange can never be
 * its own back price).
 */

import { calcLay, round2 } from "./odds";
import {
  checkBackLayPair,
  isExchangeKey,
  isPlausiblePrice,
  normaliseBookmakerKey,
} from "./odds-sanity";

// ── Scorelines ─────────────────────────────────────────────────────────────

export interface Scoreline {
  readonly home: number;
  readonly away: number;
}

/**
 * The scorelines we enumerate and show: 0-0 … 5-5 (36 of them). This is the
 * grid the user is told we searched.
 */
export const SCORELINE_MAX = 5;

/**
 * The wider grid used to PROVE a combination pins exactly one scoreline.
 *
 * Why it exists: a combo judged unique on the 0-0…5-5 grid could still admit
 * 7-1 outside it, and we would then be claiming "only one possible outcome"
 * about something that has two. Everything is therefore tested on
 * 0-0 … 9-9, and a pin is only accepted when (a) exactly one scoreline survives
 * and (b) that scoreline sits strictly inside the wider grid — so the answer
 * does not depend on where we stopped counting.
 */
const VERIFY_MAX = 9;

export function scorelineKey(s: Scoreline): string {
  return `${s.home}-${s.away}`;
}

/** "1-0" — how a scoreline is written everywhere on the page. */
export function scorelineLabel(s: Scoreline): string {
  return scorelineKey(s);
}

function grid(max: number): Scoreline[] {
  const out: Scoreline[] = [];
  for (let home = 0; home <= max; home++) {
    for (let away = 0; away <= max; away++) out.push({ home, away });
  }
  return out;
}

/** 0-0 … 5-5 — the grid we say we searched. */
export const SCORELINE_GRID: readonly Scoreline[] = grid(SCORELINE_MAX);
/** 0-0 … 9-9 — the grid the uniqueness claim is actually proven on. */
export const VERIFY_GRID: readonly Scoreline[] = grid(VERIFY_MAX);

// ── Legs (the selections we can price) ─────────────────────────────────────

/**
 * The four markets our feed can actually price for one football match. All of
 * them are BACK prices only — the feed's single lay market is `h2h_lay`, which
 * this tool does not use as a leg (a leg is a bookmaker selection).
 */
export type LegMarket = "h2h" | "btts" | "totals" | "team_totals";

export type LegKind =
  | "home" // match result: home win
  | "draw"
  | "away"
  | "btts_yes"
  | "btts_no"
  | "over" // total goals over a line
  | "under"
  | "home_over" // home team goals over a line
  | "home_under"
  | "away_over"
  | "away_under";

export interface LegSelection {
  readonly market: LegMarket;
  readonly kind: LegKind;
  /** The line for totals / team_totals (e.g. 1.5). Absent otherwise. */
  readonly line?: number;
}

export function legKey(sel: LegSelection): string {
  return sel.line == null ? `${sel.market}:${sel.kind}` : `${sel.market}:${sel.kind}:${sel.line}`;
}

/**
 * True when this selection HOLDS for that scoreline. These predicates are the
 * whole pinning rule: everything else is intersection.
 */
export function legHolds(sel: LegSelection, s: Scoreline): boolean {
  switch (sel.kind) {
    case "home":
      return s.home > s.away;
    case "draw":
      return s.home === s.away;
    case "away":
      return s.home < s.away;
    case "btts_yes":
      return s.home > 0 && s.away > 0;
    case "btts_no":
      return s.home === 0 || s.away === 0;
    case "over":
      return sel.line != null && s.home + s.away > sel.line;
    case "under":
      return sel.line != null && s.home + s.away < sel.line;
    case "home_over":
      return sel.line != null && s.home > sel.line;
    case "home_under":
      return sel.line != null && s.home < sel.line;
    case "away_over":
      return sel.line != null && s.away > sel.line;
    case "away_under":
      return sel.line != null && s.away < sel.line;
    default:
      return false;
  }
}

/** Plain English for one leg, using this match's team names. */
export function legLabel(sel: LegSelection, home: string, away: string): string {
  const line = sel.line == null ? "" : ` ${sel.line}`;
  switch (sel.kind) {
    case "home":
      return `${home} to win`;
    case "draw":
      return "Draw";
    case "away":
      return `${away} to win`;
    case "btts_yes":
      return "Both teams to score";
    case "btts_no":
      return "Not both teams to score";
    case "over":
      return `Over${line} goals`;
    case "under":
      return `Under${line} goals`;
    case "home_over":
      return `${home} over${line} goals`;
    case "home_under":
      return `${home} under${line} goals`;
    case "away_over":
      return `${away} over${line} goals`;
    case "away_under":
      return `${away} under${line} goals`;
    default:
      return legKey(sel);
  }
}

/** Every scoreline on `grid` that satisfies every leg. */
export function scorelinesAdmitted(legs: readonly LegSelection[], grid: readonly Scoreline[]): Scoreline[] {
  return grid.filter((s) => legs.every((leg) => legHolds(leg, s)));
}

export type PinOutcome =
  | { ok: true; scoreline: Scoreline }
  | { ok: false; reason: "none" | "many" | "out_of_grid"; admitted: number };

/**
 * Do these legs pin EXACTLY ONE scoreline?
 *
 *   "none"         — the combo admits no scoreline at all (contradictory legs,
 *                    e.g. both teams to score + under 1.5). Such a bet can
 *                    never win, so it is discarded rather than shown.
 *   "many"         — two or more scorelines survive. This is the case the spec
 *                    forbids: "home win + over 0.5" alone admits 2-0, 2-1, 3-0…
 *                    and is rejected, never shown with a caveat.
 *   "out_of_grid"  — exactly one scoreline survived, but it sits on the edge of
 *                    the verification grid (or outside the 0-0…5-5 grid we
 *                    show), so the uniqueness claim would rest on where we
 *                    stopped counting. Rejected.
 */
export function pinnedScoreline(legs: readonly LegSelection[]): PinOutcome {
  if (legs.length === 0) return { ok: false, reason: "none", admitted: 0 };
  const admitted = scorelinesAdmitted(legs, VERIFY_GRID);
  if (admitted.length === 0) return { ok: false, reason: "none", admitted: 0 };
  if (admitted.length > 1) return { ok: false, reason: "many", admitted: admitted.length };
  const only = admitted[0];
  if (only.home > SCORELINE_MAX || only.away > SCORELINE_MAX) {
    return { ok: false, reason: "out_of_grid", admitted: 1 };
  }
  if (only.home >= VERIFY_MAX || only.away >= VERIFY_MAX) {
    return { ok: false, reason: "out_of_grid", admitted: 1 };
  }
  return { ok: true, scoreline: only };
}

// ── Prices ─────────────────────────────────────────────────────────────────

export interface PriceRef {
  odds: number;
  /** Display name of the bookmaker (e.g. "William Hill"). */
  bookmaker: string;
  /** The feed's bookmaker key (e.g. "williamhill"). */
  bookmakerKey: string;
}

/** A leg carrying the best back price we can see for it, if anyone quoted one. */
export interface PricedLeg extends LegSelection {
  price: PriceRef | null;
  /** Plain English for this leg, using the match's team names. */
  label: string;
}

// ── The plan, and the single-lay invariant ─────────────────────────────────

/**
 * The ONE exchange selection a plan is laid on: the correct-score market for the
 * pinned scoreline. There is deliberately no constructor that takes a list of
 * these beyond `buildPlan`, and `SameMatchPlan.lay` is a 1-tuple.
 */
export interface LaySelection {
  /** The market on the exchange. Always correct score — a single selection. */
  readonly market: "correct_score";
  readonly scoreline: Scoreline;
  /** "correct_score:1-0" — the exact exchange selection to lay. */
  readonly selectionKey: string;
}

export function laySelectionFor(scoreline: Scoreline): LaySelection {
  return {
    market: "correct_score",
    scoreline,
    selectionKey: `correct_score:${scorelineKey(scoreline)}`,
  };
}

export interface PlanLeg {
  readonly selection: LegSelection;
  readonly key: string;
  readonly label: string;
  /** Best back price we can see, or null when nobody quoted this leg. */
  readonly price: PriceRef | null;
}

export interface SameMatchPlan {
  readonly id: string;
  /** The legs to put in the bookmaker's bet builder. */
  readonly legs: readonly PlanLeg[];
  /** The single scoreline these legs pin. Exactly one, by construction. */
  readonly pins: Scoreline;
  /**
   * Exactly one lay. A 1-tuple, so a second lay cannot be added without changing
   * this type — and `buildPlan` refuses it at runtime as well.
   */
  readonly lay: readonly [LaySelection];
  /** Literal 1 — the single-lay invariant, readable at a glance and testable. */
  readonly layCount: 1;
  readonly legCount: number;
  /** Lower = the legs are individually narrower. Tie-break only, not a price. */
  readonly specificity: number;
}

/**
 * THE ONLY WAY TO MAKE A PLAN.
 *
 * Throws unless it is given at least one leg and EXACTLY ONE lay. The throw is
 * the point: this is the constraint "only ever build bets for a single layable
 * option on the exchange" made executable, so a future caller cannot add a
 * second lay and have it silently accepted.
 */
export function buildPlan(
  legs: readonly PlanLeg[],
  pins: Scoreline,
  lays: readonly LaySelection[]
): SameMatchPlan {
  if (legs.length === 0) throw new Error("buildPlan: a plan needs at least one leg");
  if (lays.length !== 1) {
    throw new Error(
      `buildPlan: a plan must carry exactly one lay selection (got ${lays.length}). ` +
        "A bet that needs two lays is not a single layable outcome and must not be built."
    );
  }
  const lay = lays[0];
  if (lay.market !== "correct_score" || lay.selectionKey !== laySelectionFor(pins).selectionKey) {
    throw new Error(
      `buildPlan: the lay must be the correct-score selection for the pinned scoreline ` +
        `(${scorelineKey(pins)}), not ${lay.selectionKey}`
    );
  }
  return {
    id: legs.map((l) => l.key).sort().join("+"),
    legs,
    pins,
    lay: [lay] as readonly [LaySelection],
    layCount: 1,
    legCount: legs.length,
    specificity: 0,
  };
}

/**
 * Defence in depth for any surface that renders a plan: throws unless the plan
 * carries exactly one lay, and unless that lay is the correct-score selection
 * for the scoreline the legs pin. Called on every plan the page draws.
 */
export function assertSingleLay(plan: SameMatchPlan): void {
  const lays: readonly LaySelection[] = plan.lay as readonly LaySelection[];
  if (lays.length !== 1) {
    throw new Error(`assertSingleLay: plan ${plan.id} carries ${lays.length} lays, expected 1`);
  }
  const expected = laySelectionFor(plan.pins).selectionKey;
  if (lays[0].selectionKey !== expected) {
    throw new Error(
      `assertSingleLay: plan ${plan.id} lays ${lays[0].selectionKey} but pins ${scorelineKey(plan.pins)}`
    );
  }
}

// ── The search ─────────────────────────────────────────────────────────────

/** Most legs we will ever put in one builder. The owner's example uses 3. */
export const MAX_PLAN_LEGS = 3;

export interface FindPlansOptions {
  maxLegs?: number;
  /** Hard cap on returned plans, so a big feed cannot produce an endless list. */
  limit?: number;
}

/** Scorelines a single leg admits on the displayed grid — a narrowness measure. */
function legBreadth(sel: LegSelection): number {
  let n = 0;
  for (const s of SCORELINE_GRID) if (legHolds(sel, s)) n++;
  return n;
}

/**
 * Find every MINIMAL combination of the given legs that pins exactly one
 * scoreline, as plans with exactly one lay each.
 *
 * Depth-first with pruning rather than "all subsets then filter":
 *   • once a combination admits one scoreline it is recorded and NOT extended —
 *     extra legs cannot add a scoreline, so every superset is redundant, which
 *     is what keeps the shortlist to minimal plans;
 *   • a combination that admits none is pruned with it.
 *
 * Anything that fails the exactly-one rule (see `pinnedScoreline`) simply never
 * becomes a plan: no caveats, no "probably", no near-misses in the list.
 */
export function findPinnedPlans(
  legs: readonly PricedLeg[],
  opts: FindPlansOptions = {}
): SameMatchPlan[] {
  const maxLegs = Math.max(1, Math.min(opts.maxLegs ?? MAX_PLAN_LEGS, MAX_PLAN_LEGS));
  const limit = Math.max(1, opts.limit ?? 200);

  // One selection per key, in a stable order, so ids and output are repeatable.
  const seen = new Set<string>();
  const pool: PricedLeg[] = [];
  for (const leg of legs) {
    const key = legKey(leg);
    if (seen.has(key)) continue;
    if (leg.line != null && (!Number.isFinite(leg.line) || leg.line <= 0)) continue;
    seen.add(key);
    pool.push(leg);
  }
  pool.sort((a, b) => legKey(a).localeCompare(legKey(b)));

  const breadth = new Map<string, number>();
  for (const leg of pool) breadth.set(legKey(leg), legBreadth(leg));

  const plans: SameMatchPlan[] = [];

  const walk = (start: number, chosen: PricedLeg[]) => {
    if (plans.length >= limit) return;
    if (chosen.length > 0) {
      const pin = pinnedScoreline(chosen);
      if (pin.ok) {
        const planLegs: PlanLeg[] = chosen.map((l) => ({
          selection: { market: l.market, kind: l.kind, ...(l.line == null ? {} : { line: l.line }) },
          key: legKey(l),
          label: l.label,
          price: l.price,
        }));
        const plan = buildPlan(planLegs, pin.scoreline, [laySelectionFor(pin.scoreline)]);
        plans.push({
          ...plan,
          specificity: chosen.reduce((sum, l) => sum + (breadth.get(legKey(l)) ?? 0), 0),
        });
        return; // minimal: do not extend a pin
      }
      if (pin.admitted === 0) return; // impossible below one scoreline — prune
    }
    if (chosen.length === maxLegs) return;
    for (let i = start; i < pool.length; i++) {
      if (plans.length >= limit) return;
      chosen.push(pool[i]);
      walk(i + 1, chosen);
      chosen.pop();
    }
  };

  walk(0, []);

  // Fewest legs first, then the narrowest legs, then a stable key.
  plans.sort((a, b) => {
    if (a.legCount !== b.legCount) return a.legCount - b.legCount;
    if (a.specificity !== b.specificity) return a.specificity - b.specificity;
    return a.id.localeCompare(b.id);
  });
  return plans;
}

// ── Markets: parsing the per-event feed ────────────────────────────────────

export interface ReferencePrice {
  scorelineKey: string;
  scoreline: Scoreline;
  odds: number;
  bookmaker: string;
  bookmakerKey: string;
  /**
   * True when the best correct-score price we can see is the exchange's OWN
   * price (betfair_ex_uk). Backing at the exchange and laying on the same
   * exchange pays the spread and commission to yourself, so this is flagged
   * rather than quietly presented as a bookmaker benchmark.
   */
  isExchangeOwnPrice: boolean;
}

export interface EventMarkets {
  eventId: string;
  home: string;
  away: string;
  /** Priced legs the search may use. Only selections somebody actually quoted. */
  legs: PricedLeg[];
  /** Best correct-score BACK price per scoreline — a benchmark, never a lay. */
  reference: ReferencePrice[];
  /** Every bookmaker seen on the event, by display name. */
  bookmakers: string[];
  /** Markets the feed answered with nothing usable — stated on the page. */
  missingMarkets: string[];
  /** Correct-score outcome names we could not read as a scoreline (e.g. "Other"). */
  unreadableCorrectScoreOutcomes: string[];
}

interface RawOutcome {
  name?: unknown;
  price?: unknown;
  point?: unknown;
  description?: unknown;
}

interface RawMarket {
  key?: unknown;
  outcomes?: unknown;
}

interface RawBookmaker {
  key?: unknown;
  title?: unknown;
  markets?: unknown;
}

const CORRECT_SCORE_RE = /^(\d{1,2})\s*[-:–]\s*(\d{1,2})$/;

function toNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Best price per leg key, preferring a real bookmaker over an exchange. */
function betterPrice(current: PriceRef | null, next: PriceRef): PriceRef {
  if (!current) return next;
  const currentIsExchange = isExchangeKey(current.bookmakerKey);
  const nextIsExchange = isExchangeKey(next.bookmakerKey);
  // Odds Sanity Rule, exchange-can't-be-its-own-back side: when a bookmaker and
  // an exchange quote the same leg, the bookmaker price is the better benchmark
  // for a builder — the exchange price is where the lay will sit.
  if (currentIsExchange && !nextIsExchange) return next;
  if (!currentIsExchange && nextIsExchange) return current;
  return next.odds > current.odds ? next : current;
}

/**
 * Read one per-event payload into the legs we can price, plus the correct-score
 * reference prices.
 *
 * `raw` is the odds provider's `/v4/sports/{sport}/events/{event}/odds` body
 * (an object, or a single-element array). Everything that is not readable is
 * reported in `missingMarkets` / `unreadableCorrectScoreOutcomes` instead of
 * being guessed at — a leg we cannot attribute to the right side would silently
 * pin the wrong scoreline.
 */
export function parseEventMarkets(raw: unknown): EventMarkets {
  const event = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | null;
  const home = typeof event?.home_team === "string" ? event.home_team : "";
  const away = typeof event?.away_team === "string" ? event.away_team : "";
  const eventId = typeof event?.id === "string" ? event.id : "";
  const rawBookmakers: RawBookmaker[] = Array.isArray(event?.bookmakers)
    ? (event.bookmakers as RawBookmaker[])
    : [];

  const byLeg = new Map<string, PricedLeg>();
  const refByKey = new Map<string, ReferencePrice>();
  const unreadable: string[] = [];
  const bookmakers = new Set<string>();

  const note = (leg: LegSelection, price: PriceRef) => {
    const key = legKey(leg);
    const existing = byLeg.get(key);
    const best = betterPrice(existing?.price ?? null, price);
    byLeg.set(key, { ...leg, price: best, label: legLabel(leg, home, away) });
  };

  for (const bm of rawBookmakers) {
    const bookmakerKey = normaliseBookmakerKey(typeof bm?.key === "string" ? bm.key : "");
    const bookmaker = typeof bm?.title === "string" && bm.title ? bm.title : bookmakerKey;
    if (!bookmakerKey) continue;
    const markets: RawMarket[] = Array.isArray(bm?.markets) ? (bm.markets as RawMarket[]) : [];
    for (const market of markets) {
      const marketKey = typeof market?.key === "string" ? market.key : "";
      const outcomes: RawOutcome[] = Array.isArray(market?.outcomes) ? (market.outcomes as RawOutcome[]) : [];
      if (outcomes.length === 0) continue;

      for (const o of outcomes) {
        const price = toNumber(o?.price);
        const name = typeof o?.name === "string" ? o.name.trim() : "";
        const description = typeof o?.description === "string" ? o.description.trim() : "";
        if (!isPlausiblePrice(price)) continue; // Odds Sanity Rule: sentinels never count
        const ref: PriceRef = { odds: price as number, bookmaker, bookmakerKey };
        bookmakers.add(bookmaker);
        const lower = name.toLowerCase();

        if (marketKey === "h2h") {
          // Attribution is by exact team name, so a mislabelled market cannot
          // be read as the wrong side (which would pin the wrong scoreline).
          if (home && lower === home.toLowerCase()) note({ market: "h2h", kind: "home" }, ref);
          else if (away && lower === away.toLowerCase()) note({ market: "h2h", kind: "away" }, ref);
          else if (lower === "draw" || lower === "tie") note({ market: "h2h", kind: "draw" }, ref);
        } else if (marketKey === "btts") {
          if (lower === "yes") note({ market: "btts", kind: "btts_yes" }, ref);
          else if (lower === "no") note({ market: "btts", kind: "btts_no" }, ref);
        } else if (marketKey === "totals") {
          const line = toNumber(o?.point);
          if (line == null) continue;
          if (lower === "over") note({ market: "totals", kind: "over", line }, ref);
          else if (lower === "under") note({ market: "totals", kind: "under", line }, ref);
        } else if (marketKey === "team_totals") {
          const line = toNumber(o?.point);
          if (line == null) continue;
          // Which team? `description` is authoritative when the feed sets it
          // (team_totals uses it); otherwise the outcome name carries the team.
          const side = attributeTeam(description, lower, home, away);
          if (!side) continue; // cannot attribute safely → never guess
          const over = lower.includes("over") || description.toLowerCase().includes("over");
          const under = lower.includes("under") || description.toLowerCase().includes("under");
          if (!over && !under) continue;
          const kind: LegKind =
            side === "home" ? (over ? "home_over" : "home_under") : over ? "away_over" : "away_under";
          note({ market: "team_totals", kind, line }, ref);
        } else if (marketKey === "correct_score") {
          const m = CORRECT_SCORE_RE.exec(name);
          if (!m) {
            if (name && !unreadable.includes(name)) unreadable.push(name);
            continue;
          }
          const scoreline: Scoreline = { home: Number(m[1]), away: Number(m[2]) };
          const key = scorelineKey(scoreline);
          const existing = refByKey.get(key);
          const candidate: ReferencePrice = {
            scorelineKey: key,
            scoreline,
            odds: ref.odds,
            bookmaker,
            bookmakerKey,
            isExchangeOwnPrice: isExchangeKey(bookmakerKey),
          };
          if (!existing) refByKey.set(key, candidate);
          else if (preferReference(existing, candidate)) refByKey.set(key, candidate);
        }
      }
    }
  }

  const expected: LegMarket[] = ["h2h", "btts", "totals", "team_totals"];
  const missingMarkets = expected.filter((m) => ![...byLeg.values()].some((l) => l.market === m));

  return {
    eventId,
    home,
    away,
    legs: [...byLeg.values()],
    reference: [...refByKey.values()].sort(
      (a, b) => a.scoreline.home - b.scoreline.home || a.scoreline.away - b.scoreline.away
    ),
    bookmakers: [...bookmakers].sort((a, b) => a.localeCompare(b)),
    missingMarkets,
    unreadableCorrectScoreOutcomes: unreadable,
  };
}

/**
 * Which team does a team-totals outcome belong to? Returns null unless the
 * answer is unambiguous — an unattributable totals leg would pin the wrong
 * scoreline, which is worse than dropping it.
 */
function attributeTeam(
  description: string,
  lowerName: string,
  home: string,
  away: string
): "home" | "away" | null {
  const homeLower = home.toLowerCase();
  const awayLower = away.toLowerCase();
  if (!homeLower || !awayLower || homeLower === awayLower) return null;

  const haystacks = [description.toLowerCase(), lowerName].filter((h) => h.length > 0);
  for (const hay of haystacks) {
    const isHome = homeLower.length > 0 && hay.includes(homeLower);
    const isAway = awayLower.length > 0 && hay.includes(awayLower);
    if (isHome && !isAway) return "home";
    if (isAway && !isHome) return "away";
  }
  return null;
}

/** Prefer a real bookmaker's correct-score price over the exchange's own. */
function preferReference(current: ReferencePrice, next: ReferencePrice): boolean {
  if (current.isExchangeOwnPrice && !next.isExchangeOwnPrice) return true;
  if (!current.isExchangeOwnPrice && next.isExchangeOwnPrice) return false;
  return next.odds > current.odds;
}

// ── The calculation (two user-typed prices, nothing else) ──────────────────

export type PlanUnavailableReason =
  | "no_bookmaker_price"
  | "invalid_bookmaker_price"
  | "no_lay_price"
  | "invalid_lay_price"
  | "invalid_stake";

export interface PinnedPlanOk {
  status: "ok";
  /** Amount to lay on the exchange for the single scoreline. */
  layStake: number;
  /** What you risk on that lay = layStake × (layPrice − 1). */
  liability: number;
  /** P/L when the pinned scoreline lands. */
  profitIfPinned: number;
  /** P/L when it does not land — the other side of the same bet. */
  profitIfNot: number;
  /** What the exchange lay WINS (after commission) when the scoreline fails. */
  layWin: number;
  /**
   * The bookmaker price at which this plan breaks exactly even:
   *   B* = (layPrice − commission) / (1 − commission)
   * Stake-independent, and it is the number to compare your builder price to.
   */
  breakEvenBookmakerPrice: number;
  /** Your typed builder price minus the break-even price. > 0 = value. */
  edgeVsBreakEven: number;
  /**
   * True when the typed lay price is more than 10% BELOW the typed bookmaker
   * price. Unlike a feed back/lay pair — where that gap means two different
   * markets — here it is the normal shape of a real opportunity: the builder
   * combo and the correct-score lay are different markets, and the bookmaker
   * being slower than the exchange is exactly what the technique looks for. The
   * page mentions it as a "check you are laying the right scoreline" note
   * rather than refusing the calculation.
   */
  farBelowBookPrice: boolean;
  bookmakerPrice: number;
  layPrice: number;
  backStake: number;
  commission: number;
}

export interface PinnedPlanUnavailable {
  status: "unavailable";
  reason: PlanUnavailableReason;
  /** Plain language for the page. Nothing is ever defaulted to make a figure. */
  message: string;
}

export type PinnedPlanResult = PinnedPlanOk | PinnedPlanUnavailable;

export interface PinnedPlanInput {
  /** The user's typed bookmaker bet-builder price. */
  bookmakerPrice: number | null | undefined;
  /** The user's typed exchange lay price for the pinned scoreline. */
  layPrice: number | null | undefined;
  backStake: number;
  commission: number;
}

/**
 * Work out the plan's money from the TWO prices the user types.
 *
 * The lay stake comes from `calcLay()` — the same commission-aware formula as
 * the calculator, the Lay Bet Finder and the Bet Builder. There is no second
 * lay formula in this file: `calcLay`'s `profitLoss` IS the P/L when the pinned
 * scoreline lands, and the other side is calculated explicitly so the page can
 * show both outcomes rather than one.
 *
 * Every failure returns `status: "unavailable"` with a reason. Nothing is
 * defaulted, padded or assumed: no lay price means no plan, not a lay at some
 * invented price.
 */
export function calcPinnedPlan(input: PinnedPlanInput): PinnedPlanResult {
  const { backStake, commission } = input;
  const bookmakerPrice = toNumber(input.bookmakerPrice);
  const layPrice = toNumber(input.layPrice);

  if (bookmakerPrice == null) {
    return {
      status: "unavailable",
      reason: "no_bookmaker_price",
      message:
        "Enter the price your bookmaker is showing for this bet builder. We cannot see it — no feed supplies bet-builder prices, because they are generated per customer — so this number has to be yours.",
    };
  }
  if (!isPlausiblePrice(bookmakerPrice)) {
    return {
      status: "unavailable",
      reason: "invalid_bookmaker_price",
      message: `A bookmaker price must be a real decimal price between 1.01 and 450.99. You entered ${bookmakerPrice}.`,
    };
  }
  if (layPrice == null) {
    return {
      status: "unavailable",
      reason: "no_lay_price",
      message:
        "Enter the exchange's lay price for this scoreline. Our feed does not carry a lay side for correct score (h2h_lay is the only lay market it has), so there is no price to default to — and we will not invent one.",
    };
  }
  if (!isPlausiblePrice(layPrice)) {
    return {
      status: "unavailable",
      reason: "invalid_lay_price",
      message: `An exchange lay price must be a real decimal price between 1.01 and 450.99. You entered ${layPrice}.`,
    };
  }
  if (!Number.isFinite(backStake) || backStake <= 0) {
    return {
      status: "unavailable",
      reason: "invalid_stake",
      message: "Enter a stake — any stake you like. We do not assume one.",
    };
  }

  // The Odds Sanity Rule is applied to the typed pair only for what it can
  // honestly say here: both numbers must be real prices (1.01 ≤ p < 451, no
  // 1.00/451 sentinels) — that is enforced above. Its "lay far below back"
  // verdict is deliberately NOT fatal for this tool: the builder combo and the
  // correct-score lay are different markets, so a lay below the builder price is
  // precisely what a real opportunity looks like. It is reported as a
  // double-check note instead of blocking the maths.
  const pair = checkBackLayPair(bookmakerPrice, layPrice);
  const farBelowBookPrice = pair.verdict === "lay_below_back";

  const calc = calcLay(bookmakerPrice, layPrice, backStake, commission);
  if (!calc) {
    return {
      status: "unavailable",
      reason: "invalid_lay_price",
      message: "These two prices cannot make a matched bet (the lay price has to exceed the commission rate).",
    };
  }

  const profitIfPinned = calc.profitLoss;
  const layWin = calc.layStake * (1 - commission);
  const profitIfNot = layWin - backStake;
  const breakEvenBookmakerPrice = (layPrice - commission) / (1 - commission);

  return {
    status: "ok",
    layStake: calc.layStake,
    liability: calc.liability,
    profitIfPinned,
    profitIfNot,
    layWin,
    breakEvenBookmakerPrice,
    edgeVsBreakEven: round2(bookmakerPrice - breakEvenBookmakerPrice),
    farBelowBookPrice,
    bookmakerPrice,
    layPrice,
    backStake,
    commission,
  };
}

/**
 * The "components multiplied" figure: what the legs would pay if the bookmaker
 * priced each of them separately and simply multiplied them.
 *
 * THIS IS NOT THE BOOKMAKER'S PRICE and the page says so. A real bet-builder
 * price is normally SHORTER than this product, because the bookmaker prices the
 * correlated combination rather than the independent legs — which is exactly
 * why the user has to type the real number for the calculation to mean
 * anything. Returns null when any leg has no price.
 */
export function componentsMultiplied(plan: SameMatchPlan): number | null {
  let product = 1;
  for (const leg of plan.legs) {
    if (!leg.price) return null;
    product *= leg.price.odds;
  }
  return round2(product);
}
