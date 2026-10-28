import { describe, expect, test } from "bun:test";
import {
  assertSingleLay,
  buildPlan,
  calcPinnedPlan,
  componentsMultiplied,
  findPinnedPlans,
  laySelectionFor,
  legHolds,
  legKey,
  parseEventMarkets,
  pinnedScoreline,
  scorelineKey,
  scorelinesAdmitted,
  SCORELINE_GRID,
  type LaySelection,
  type PricedLeg,
  type SameMatchPlan,
} from "../src/lib/same-match";
import { DEFAULT_COMMISSION } from "../src/lib/odds";

/**
 * SAME-MATCH SCORELINE PINNING (/same-match).
 *
 * The owner's spec: "calculations that lead to 1 possible outcome for every
 * outcome that we can. They must result in 1 layable outcome, no more. So home
 * win, goals over 0.5 and under 1.5 could only be 1-0."
 *
 * His output constraint: "Only ever build bets for a single layable option on
 * the exchange." These tests hold the code to that, in this order:
 *   1. the pinning rule (home win + over 0.5 + under 1.5 → 1-0 and nothing else);
 *   2. a two-scoreline combo is REJECTED by the search, not shown with a caveat;
 *   3. every plan carries exactly one lay — enforced at runtime and in the type;
 *   4. break-even maths checked by hand;
 *   5. no exchange lay price → "unavailable", never a defaulted number.
 */

const WH = { bookmaker: "William Hill", bookmakerKey: "williamhill" };
const PP = { bookmaker: "Paddy Power", bookmakerKey: "paddypower" };
const BF = { bookmaker: "Betfair Exchange", bookmakerKey: "betfair_ex_uk" };

function leg(
  market: PricedLeg["market"],
  kind: PricedLeg["kind"],
  extra: { line?: number; odds?: number; price?: PricedLeg["price"]; label?: string } = {}
): PricedLeg {
  const line = extra.line;
  return {
    market,
    kind,
    ...(line == null ? {} : { line }),
    price: extra.price === undefined ? { odds: extra.odds ?? 2.0, ...WH } : extra.price,
    label: extra.label ?? legKey({ market, kind, ...(line == null ? {} : { line }) }),
  };
}

const HOME_WIN = leg("h2h", "home", { odds: 1.9, label: "Arsenal to win" });
const AWAY_WIN = leg("h2h", "away", { odds: 4.2, label: "Chelsea to win" });
const DRAW = leg("h2h", "draw", { odds: 3.6, label: "Draw" });
const OVER_05 = leg("totals", "over", { line: 0.5, odds: 1.02, label: "Over 0.5 goals" });
const UNDER_05 = leg("totals", "under", { line: 0.5, odds: 13.0, label: "Under 0.5 goals" });
const UNDER_15 = leg("totals", "under", { line: 1.5, odds: 2.6, label: "Under 1.5 goals" });
const BTTS_YES = leg("btts", "btts_yes", { odds: 1.55, label: "Both teams to score" });
const BTTS_NO = leg("btts", "btts_no", { odds: 2.4, label: "Not both teams to score" });

// ── 1. The pinning rule ────────────────────────────────────────────────────

describe("the pinning rule — the owner's own example", () => {
  test("home win + over 0.5 + under 1.5 admits 1-0 and nothing else", () => {
    const pin = pinnedScoreline([HOME_WIN, OVER_05, UNDER_15]);
    expect(pin.ok).toBe(true);
    if (!pin.ok) throw new Error("expected a pin");
    expect(scorelineKey(pin.scoreline)).toBe("1-0");

    // Stated the other way round too: exactly one scoreline survives, on the
    // grid the page says it searched.
    const admitted = scorelinesAdmitted([HOME_WIN, OVER_05, UNDER_15], SCORELINE_GRID);
    expect(admitted.length).toBe(1);
    expect(scorelineKey(admitted[0])).toBe("1-0");
  });

  test("the leg predicates mean what the labels say", () => {
    // Over 0.5 holds for any game with a goal; under 1.5 only for 0 or 1 goal.
    expect(legHolds(OVER_05, { home: 1, away: 0 })).toBe(true);
    expect(legHolds(OVER_05, { home: 0, away: 0 })).toBe(false);
    expect(legHolds(UNDER_15, { home: 1, away: 0 })).toBe(true);
    expect(legHolds(UNDER_15, { home: 1, away: 1 })).toBe(false);
    expect(legHolds(BTTS_YES, { home: 1, away: 1 })).toBe(true);
    expect(legHolds(BTTS_NO, { home: 1, away: 0 })).toBe(true);
    expect(legHolds(DRAW, { home: 2, away: 2 })).toBe(true);
    // team totals
    expect(legHolds({ market: "team_totals", kind: "home_over", line: 0.5 }, { home: 1, away: 3 })).toBe(true);
    expect(legHolds({ market: "team_totals", kind: "away_under", line: 0.5 }, { home: 1, away: 3 })).toBe(false);
  });

  test("mirror image: away win + over 0.5 + under 1.5 is 0-1", () => {
    const pin = pinnedScoreline([AWAY_WIN, OVER_05, UNDER_15]);
    expect(pin.ok).toBe(true);
    if (pin.ok) expect(scorelineKey(pin.scoreline)).toBe("0-1");
  });

  test("one leg can pin on its own: under 0.5 goals is 0-0", () => {
    const pin = pinnedScoreline([UNDER_05]);
    expect(pin.ok).toBe(true);
    if (pin.ok) expect(scorelineKey(pin.scoreline)).toBe("0-0");
  });
});

// ── 2. Anything that admits two or more scorelines is discarded ────────────

describe("exactly-one-scoreline is enforced by the search, not by a caveat", () => {
  test("home win + over 0.5 alone admits many scorelines and is not a plan", () => {
    const pin = pinnedScoreline([HOME_WIN, OVER_05]);
    expect(pin.ok).toBe(false);
    if (pin.ok) throw new Error("expected rejection");
    expect(pin.reason).toBe("many");
    // 2-0, 2-1, 3-0, 3-1, 3-2, 4-0 … — several, so it must never be offered.
    expect(pin.admitted).toBeGreaterThan(1);
    expect(scorelinesAdmitted([HOME_WIN, OVER_05], SCORELINE_GRID).length).toBeGreaterThan(1);
  });

  test("the search never returns a combo that admits two or more scorelines", () => {
    const plans = findPinnedPlans([HOME_WIN, OVER_05]);
    expect(plans.length).toBe(0);
    // Explicitly: the two-leg near-miss is not in the output.
    expect(plans.some((p) => p.legCount === 2)).toBe(false);
  });

  test("a contradictory combo is discarded, not shown as a certain loser", () => {
    // Both teams to score AND under 1.5 total goals can never happen.
    const pin = pinnedScoreline([BTTS_YES, UNDER_15]);
    expect(pin.ok).toBe(false);
    if (!pin.ok) {
      expect(pin.reason).toBe("none");
      expect(pin.admitted).toBe(0);
    }
    expect(findPinnedPlans([BTTS_YES, UNDER_15]).length).toBe(0);
  });

  test("every plan the search does return pins exactly one scoreline", () => {
    const plans = findPinnedPlans([HOME_WIN, AWAY_WIN, DRAW, OVER_05, UNDER_15, BTTS_YES, BTTS_NO]);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      const pin = pinnedScoreline(plan.legs.map((l) => l.selection));
      expect(pin.ok).toBe(true);
      if (pin.ok) expect(scorelineKey(pin.scoreline)).toBe(scorelineKey(plan.pins));
      // And independently on the displayed grid.
      const admitted = scorelinesAdmitted(plan.legs.map((l) => l.selection), SCORELINE_GRID);
      expect(admitted.length).toBe(1);
      expect(scorelineKey(admitted[0])).toBe(scorelineKey(plan.pins));
    }
  });

  test("the owner's exact combo appears in the shortlist pinning 1-0", () => {
    const plans = findPinnedPlans([HOME_WIN, AWAY_WIN, DRAW, OVER_05, UNDER_15, BTTS_YES, BTTS_NO]);
    const winner = plans.find(
      (p) =>
        scorelineKey(p.pins) === "1-0" &&
        p.legs.some((l) => l.key === legKey(HOME_WIN)) &&
        p.legs.some((l) => l.key === legKey(OVER_05)) &&
        p.legs.some((l) => l.key === legKey(UNDER_15))
    );
    expect(winner).toBeDefined();
  });

  test("fewest legs first — a one-leg plan outranks a three-leg one", () => {
    const plans = findPinnedPlans([HOME_WIN, OVER_05, UNDER_15, UNDER_05]);
    expect(plans.length).toBeGreaterThan(0);
    expect(plans[0].legCount).toBe(1);
    expect(scorelineKey(plans[0].pins)).toBe("0-0");
    for (let i = 1; i < plans.length; i++) {
      expect(plans[i].legCount).toBeGreaterThanOrEqual(plans[i - 1].legCount);
    }
  });
});

// ── 3. The single-lay invariant ────────────────────────────────────────────

describe("single-lay invariant — one lay, and only one", () => {
  test("a plan built by the search carries exactly one lay selection", () => {
    const plans = findPinnedPlans([HOME_WIN, AWAY_WIN, DRAW, OVER_05, UNDER_15, BTTS_YES, BTTS_NO]);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      expect(plan.lay.length).toBe(1);
      expect(plan.layCount).toBe(1);
      expect(plan.lay[0].market).toBe("correct_score");
      expect(plan.lay[0].selectionKey).toBe(`correct_score:${scorelineKey(plan.pins)}`);
      expect(() => assertSingleLay(plan)).not.toThrow();
    }
  });

  test("buildPlan THROWS when handed two lays — a second lay cannot be added", () => {
    const pins = { home: 1, away: 0 };
    const planLegs = [
      { selection: HOME_WIN, key: legKey(HOME_WIN), label: HOME_WIN.label, price: HOME_WIN.price },
    ];
    expect(() => buildPlan(planLegs, pins, [laySelectionFor(pins)] as LaySelection[])).not.toThrow();
    // Two lays — the exact thing the owner forbade. Runtime rejection, not a
    // comment asking politely.
    expect(() =>
      buildPlan(planLegs, pins, [laySelectionFor(pins), laySelectionFor({ home: 2, away: 0 })] as LaySelection[])
    ).toThrow(/exactly one lay selection/);
    // No lay at all is equally invalid.
    expect(() => buildPlan(planLegs, pins, [] as LaySelection[])).toThrow(/exactly one lay selection/);
  });

  test("the lay must be the correct-score selection for the pinned scoreline", () => {
    const planLegs = [{ selection: HOME_WIN, key: legKey(HOME_WIN), label: HOME_WIN.label, price: HOME_WIN.price }];
    expect(() => buildPlan(planLegs, { home: 1, away: 0 }, [laySelectionFor({ home: 2, away: 0 })])).toThrow(
      /must be the correct-score selection/
    );
  });

  test("assertSingleLay rejects a plan retro-fitted with a second lay", () => {
    const plan: SameMatchPlan = findPinnedPlans([UNDER_05])[0];
    const twoLays = {
      ...plan,
      lay: [laySelectionFor(plan.pins), laySelectionFor({ home: 0, away: 1 })],
    } as unknown as SameMatchPlan;
    expect(() => assertSingleLay(twoLays)).toThrow(/carries 2 lays/);
  });

  test("a plan is 1 leg + 1 lay — the layout the whole feature promises", () => {
    const plan = findPinnedPlans([UNDER_05])[0];
    expect(plan.legCount).toBe(1);
    expect(plan.lay.length).toBe(1);
    expect(plan.pins).toEqual({ home: 0, away: 0 });
  });
});

// ── 4. Break-even maths, checked by hand ───────────────────────────────────

describe("the money maths, verified by hand", () => {
  // lay 8.00, commission 2% → break-even builder price B* = (8.00 − 0.02) / 0.98
  const LAY = 8.0;
  const C = DEFAULT_COMMISSION; // 0.02
  const BREAK_EVEN = (LAY - C) / (1 - C); // 8.142857142857142

  test("break-even bookmaker price = (lay − commission) / (1 − commission)", () => {
    const r = calcPinnedPlan({ bookmakerPrice: 8.5, layPrice: LAY, backStake: 20, commission: C });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.breakEvenBookmakerPrice).toBeCloseTo(8.142857142857143, 10);
    expect(r.breakEvenBookmakerPrice).toBeCloseTo(BREAK_EVEN, 12);
    expect(r.edgeVsBreakEven).toBeCloseTo(0.36, 10);
  });

  test("at exactly break-even the plan nets zero on BOTH outcomes", () => {
    // S = £20, B = 8.142857…, L = 8.00
    //   layStake = 20 × 8.142857… / 7.98 = 20.4081632653061…
    //   liability = 20.4081632653061… × 7 = 142.857142857142…
    //   if 1-0 lands:  20 × 7.142857142… − 142.857142857… = 0
    //   if it does not: 20.408163265… × 0.98 − 20      = 0
    const r = calcPinnedPlan({ bookmakerPrice: BREAK_EVEN, layPrice: LAY, backStake: 20, commission: C });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.layStake).toBeCloseTo(20.408163265306124, 10);
    expect(r.liability).toBeCloseTo(142.85714285714286, 10);
    expect(r.profitIfPinned).toBeCloseTo(0, 10);
    expect(r.profitIfNot).toBeCloseTo(0, 10);
  });

  test("a price above break-even wins on both outcomes — equal amounts", () => {
    // B = 8.50, L = 8.00, S = £20, c = 2%
    //   layStake = 170 / 7.98 = 21.30325814536341…
    //   liability = 21.30325814536341… × 7 = 149.1228070175438…
    //   lands:     20 × 7.5  − 149.1228070175438… = +0.8771929824561…
    //   does not:  21.30325814536341… × 0.98 − 20 = +0.8771929824561…
    const r = calcPinnedPlan({ bookmakerPrice: 8.5, layPrice: LAY, backStake: 20, commission: C });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.layStake).toBeCloseTo(21.30325814536341, 10);
    expect(r.liability).toBeCloseTo(149.12280701754386, 10);
    expect(r.profitIfPinned).toBeCloseTo(0.8771929824561404, 10);
    expect(r.profitIfNot).toBeCloseTo(0.8771929824561404, 10);
    expect(r.layWin).toBeCloseTo(20.87719298245614, 10);
    // The matched-bet property: the result does not depend on the scoreline.
    expect(r.profitIfPinned).toBeCloseTo(r.profitIfNot, 12);
    expect(r.profitIfPinned).toBeGreaterThan(0);
  });

  test("a price below break-even loses on both outcomes — equal amounts", () => {
    // B = 7.00: layStake = 140 / 7.98 = 17.5438596491…; liability = 122.807017…
    const r = calcPinnedPlan({ bookmakerPrice: 7.0, layPrice: LAY, backStake: 20, commission: C });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.layStake).toBeCloseTo(17.543859649122805, 10);
    expect(r.profitIfPinned).toBeCloseTo(-2.8070175438596492, 10);
    expect(r.profitIfNot).toBeCloseTo(-2.8070175438596492, 10);
    expect(r.profitIfPinned).toBeLessThan(0);
    expect(r.profitIfPinned).toBeCloseTo(r.profitIfNot, 12);
  });

  test("commission changes the break-even price, and it is the user's rate", () => {
    const at5pct = calcPinnedPlan({ bookmakerPrice: 9.0, layPrice: LAY, backStake: 20, commission: 0.05 });
    expect(at5pct.status).toBe("ok");
    if (at5pct.status !== "ok") return;
    // (8 − 0.05) / 0.95 = 8.368421052631579
    expect(at5pct.breakEvenBookmakerPrice).toBeCloseTo(8.368421052631579, 10);
    // A higher commission demands a better builder price to break even.
    expect(at5pct.breakEvenBookmakerPrice).toBeGreaterThan(BREAK_EVEN);
  });

  test("stake is honoured exactly — £100 stays £100", () => {
    const r = calcPinnedPlan({ bookmakerPrice: 8.5, layPrice: LAY, backStake: 100, commission: C });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    // 100 × 8.5 / 7.98 = 106.51629072681704…
    expect(r.layStake).toBeCloseTo(106.51629072681704, 10);
    expect(r.layStake).toBeGreaterThan(90); // the old £20 cap would have scaled this to ~21.30
  });
});

// ── 5. No lay price means unavailable — never a default ────────────────────

describe("no exchange lay price = unavailable, never a defaulted number", () => {
  test("a blank lay price leaves the plan unavailable and prints no figures", () => {
    const r = calcPinnedPlan({ bookmakerPrice: 9.0, layPrice: null, backStake: 20, commission: DEFAULT_COMMISSION });
    expect(r.status).toBe("unavailable");
    if (r.status !== "unavailable") return;
    expect(r.reason).toBe("no_lay_price");
    expect(r.message).toMatch(/does not carry a lay side for correct score/i);
    // Nothing is invented: no lay stake, no liability, no profit, no break-even.
    expect("layStake" in r).toBe(false);
    expect("profitIfPinned" in r).toBe(false);
    expect("breakEvenBookmakerPrice" in r).toBe(false);
  });

  test("an empty string or a zero lay price is still no lay price", () => {
    for (const bad of [undefined, "", 0] as unknown as (number | null | undefined)[]) {
      const r = calcPinnedPlan({ bookmakerPrice: 9.0, layPrice: bad, backStake: 20, commission: DEFAULT_COMMISSION });
      expect(r.status).toBe("unavailable");
    }
  });

  test("the feed's 451 sentinel is rejected by the Odds Sanity Rule", () => {
    const r = calcPinnedPlan({ bookmakerPrice: 9.0, layPrice: 451, backStake: 20, commission: DEFAULT_COMMISSION });
    expect(r.status).toBe("unavailable");
    if (r.status === "unavailable") expect(r.reason).toBe("invalid_lay_price");
  });

  test("a missing bookmaker price says plainly that we cannot see it", () => {
    const r = calcPinnedPlan({ bookmakerPrice: null, layPrice: 8.0, backStake: 20, commission: DEFAULT_COMMISSION });
    expect(r.status).toBe("unavailable");
    if (r.status !== "unavailable") return;
    expect(r.reason).toBe("no_bookmaker_price");
    expect(r.message).toMatch(/cannot see it/i);
    expect(r.message).toMatch(/no feed supplies bet-builder prices/i);
  });

  test("a lay well below the builder price still calculates — that is the shape of a real edge", () => {
    // 7.00 is 22% below 9.00. For a FEED back/lay pair that would mean two
    // different markets and would be withheld; here the builder combo and the
    // correct-score lay ARE different markets, so it is the normal shape of an
    // opportunity. It is flagged for a double-check rather than refused.
    const r = calcPinnedPlan({ bookmakerPrice: 9.0, layPrice: 7.0, backStake: 20, commission: DEFAULT_COMMISSION });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.farBelowBookPrice).toBe(true);
    expect(r.breakEvenBookmakerPrice).toBeCloseTo((7 - 0.02) / 0.98, 10); // 7.122448979…
    expect(r.edgeVsBreakEven).toBeGreaterThan(0);
    expect(r.profitIfPinned).toBeCloseTo(r.profitIfNot, 12);
  });

  test("a tight pair is not flagged", () => {
    const r = calcPinnedPlan({ bookmakerPrice: 8.5, layPrice: 8.0, backStake: 20, commission: DEFAULT_COMMISSION });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.farBelowBookPrice).toBe(false);
  });
});

// ── 6. Reading the feed, and the reference price ───────────────────────────

const EVENT = {
  id: "evt_1",
  sport_key: "soccer_epl",
  home_team: "Arsenal",
  away_team: "Chelsea",
  bookmakers: [
    {
      key: "williamhill",
      title: "William Hill",
      markets: [
        { key: "h2h", outcomes: [{ name: "Arsenal", price: 1.9 }, { name: "Draw", price: 3.6 }, { name: "Chelsea", price: 4.2 }] },
        { key: "btts", outcomes: [{ name: "Yes", price: 1.55 }, { name: "No", price: 2.4 }] },
        {
          key: "totals",
          outcomes: [
            { name: "Over", point: 0.5, price: 1.02 },
            { name: "Under", point: 1.5, price: 2.6 },
          ],
        },
        {
          key: "team_totals",
          outcomes: [
            { name: "Over", description: "Arsenal", point: 0.5, price: 1.25 },
            { name: "Over", description: "Chelsea", point: 0.5, price: 1.85 },
          ],
        },
        {
          key: "correct_score",
          outcomes: [
            { name: "1-0", price: 8.5 },
            { name: "0-1", price: 11.0 },
            { name: "Other", price: 4.5 },
          ],
        },
      ],
    },
    {
      key: "betfair_ex_uk",
      title: "Betfair Exchange",
      markets: [{ key: "correct_score", outcomes: [{ name: "1-0", price: 8.0 }, { name: "0-1", price: 10.0 }] }],
    },
  ],
};

describe("reading the per-event feed", () => {
  test("legs are parsed with the right side and line", () => {
    const m = parseEventMarkets(EVENT);
    const keys = m.legs.map((l) => legKey(l));
    expect(keys).toContain("h2h:home");
    expect(keys).toContain("h2h:draw");
    expect(keys).toContain("h2h:away");
    expect(keys).toContain("btts:btts_yes");
    expect(keys).toContain("totals:over:0.5");
    expect(keys).toContain("totals:under:1.5");
    // team totals attributed to the right side by team name
    expect(keys).toContain("team_totals:home_over:0.5");
    expect(keys).toContain("team_totals:away_over:0.5");
    expect(m.home).toBe("Arsenal");
    expect(m.away).toBe("Chelsea");
  });

  test("the pinned plan can be found from parsed legs alone", () => {
    const m = parseEventMarkets(EVENT);
    const plans = findPinnedPlans(m.legs);
    const oneNil = plans.find((p) => scorelineKey(p.pins) === "1-0");
    expect(oneNil).toBeDefined();
    expect(oneNil!.lay.length).toBe(1);
  });

  test("the reference price prefers a bookmaker over the exchange, and is labelled as such", () => {
    const m = parseEventMarkets(EVENT);
    const oneNil = m.reference.find((r) => r.scorelineKey === "1-0")!;
    // William Hill 8.5 beats Betfair's own 8.0, and Betfair is the exchange.
    expect(oneNil.bookmaker).toBe("William Hill");
    expect(oneNil.odds).toBe(8.5);
    expect(oneNil.isExchangeOwnPrice).toBe(false);
  });

  test("when only the exchange quotes a scoreline, it is flagged rather than sold as a benchmark", () => {
    const onlyExchange = {
      id: "evt_2",
      home_team: "Arsenal",
      away_team: "Chelsea",
      bookmakers: [
        { key: "betfair_ex_uk", title: "Betfair Exchange", markets: [{ key: "correct_score", outcomes: [{ name: "2-1", price: 9.0 }] }] },
      ],
    };
    const m = parseEventMarkets(onlyExchange);
    const ref = m.reference.find((r) => r.scorelineKey === "2-1")!;
    expect(ref.isExchangeOwnPrice).toBe(true);
  });

  test("correct-score lines that are not a single scoreline are reported, not guessed", () => {
    const m = parseEventMarkets(EVENT);
    expect(m.unreadableCorrectScoreOutcomes).toContain("Other");
    expect(m.reference.some((r) => r.scorelineKey === "Other")).toBe(false);
  });

  test("an unreadable payload yields no legs instead of invented ones", () => {
    const m = parseEventMarkets({ id: "evt_3", home_team: "A", away_team: "B", bookmakers: "nonsense" });
    expect(m.legs.length).toBe(0);
    expect(m.reference.length).toBe(0);
    expect(m.missingMarkets.length).toBe(4);
  });
});

// ── 7. The component-derived figure is labelled for what it is ─────────────

describe("components multiplied is an estimate, and only an estimate", () => {
  test("it multiplies the leg prices and returns null when a leg has no price", () => {
    const plan = findPinnedPlans([UNDER_05])[0];
    expect(componentsMultiplied(plan)).toBe(13.0);
    const unpriced = findPinnedPlans([leg("totals", "under", { line: 0.5, price: null })])[0];
    expect(componentsMultiplied(unpriced)).toBeNull();
  });
});
