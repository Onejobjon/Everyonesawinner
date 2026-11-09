/**
 * SETTLEMENT RULE — the owner-reported defect of 2026-11-09:
 *
 *   "Telegram alerts. Issue with odds. Cup game, may go to extra time but the
 *    casumo odds used are the win in 90mins odds."
 *
 * A green alert quoted Casumo's 90-minute price against an exchange price that
 * could settle after extra time, so the profit was not real. These tests run the
 * rule against CAPTURED live payloads (the-odds-api, 2026-11-09, one credit
 * each) — not hand-written shapes — so the evidence is the feed's own:
 *
 *   • test/fixtures/cup-tie-payload.json — soccer_fa_cup, Plymouth Parkway FC v
 *     Berkhamsted FC, event 8b3289c2c6ddd9b85f95e1d569aea292
 *   • test/fixtures/league-payload.json  — soccer_epl, Manchester City v Fulham,
 *     event 6ef39b0fd8839f6e93a3de32523e9807
 *
 * WHAT THE CUP PAYLOAD PROVES: the only market keys are "h2h" and "h2h_lay", no
 * market carries a `description`, and the lay market's outcome names are the same
 * three names as the back market's — a Draw is listed on the exchange side too.
 * Nothing in the payload says whether the exchange leg is the 90-minute Match
 * Odds market or the to-qualify market, so the two legs cannot be proven to
 * settle alike. The rule is therefore silence.
 *
 * The captured kick-off times are rewritten a few hours into the future before
 * the transform, because `transformMatches` drops fixtures that have already
 * started (the FA Cup tie was captured 29 minutes before kick-off). Every price,
 * market key and outcome name below is exactly as captured.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transformMatches } from "../src/lib/odds-api";
import { buildInstantWins } from "../src/lib/instant-wins";
import {
  SETTLEMENT_NOTE,
  isKnockoutFootball,
  settlementProofFor,
} from "../src/lib/settlement";
import { findOpportunities, telegramText } from "../src/server/alerts";

type RawPayload = Parameters<typeof transformMatches>[0];

function loadCaptured(name: string, hoursAhead = 3): RawPayload {
  const raw = JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures", name), "utf8"),
  ) as RawPayload;
  const at = new Date(Date.now() + hoursAhead * 3600_000).toISOString();
  // Only the clock moves — see the header note. Prices and markets are captured.
  return raw.map((e) => ({ ...e, commence_time: at })) as RawPayload;
}

const cupRaw = () => loadCaptured("cup-tie-payload.json");
const leagueRaw = () => loadCaptured("league-payload.json");

describe("the captured cup payload cannot prove the two legs settle alike", () => {
  test("market keys and outcome names are identical on both sides, and no description is offered", () => {
    const [event] = cupRaw();
    const betfair = event.bookmakers.find((b) => b.key === "betfair_ex_uk")!;
    const back = betfair.markets.find((m) => m.key === "h2h")!;
    const lay = betfair.markets.find((m) => m.key === "h2h_lay")!;

    expect(event.sport_key).toBe("soccer_fa_cup");
    expect(event.sport_title).toBe("FA Cup");
    expect(back.key).toBe("h2h");
    expect(lay.key).toBe("h2h_lay");
    // The feed gives no field that says which market this is.
    expect((back as { description?: string }).description).toBeUndefined();
    expect((lay as { description?: string }).description).toBeUndefined();
    // Same names on both sides — shape cannot separate them either.
    expect(lay.outcomes.map((o) => o.name).sort()).toEqual(
      back.outcomes.map((o) => o.name).sort(),
    );
    // A real green was available on paper before the rule: Casumo 1.67 back
    // against a 1.67 lay on the same outcome is exactly the pair the owner saw.
    const casumo = event.bookmakers.find((b) => b.key === "casumo")!;
    expect(casumo.markets.find((m) => m.key === "h2h")!.outcomes.length).toBe(3);
  });
});

describe("a cup tie is silent", () => {
  test("no lay price is published at all, and the reason says why", () => {
    const [match] = transformMatches(cupRaw());
    expect(match).toBeDefined();
    expect(match.outcomes.length).toBeGreaterThan(0);
    for (const o of match.outcomes) {
      expect(o.layOdds).toBeNull();
      expect(o.laySource).toBeNull();
    }
    expect(match.layWithheldReason).toMatch(/extra time|penalties/);
  });

  test("the alert worker produces no opportunity and counts the skip", () => {
    const matches = transformMatches(cupRaw());
    const result = findOpportunities(matches, 0.02);
    expect(result.opps).toEqual([]);
    expect(result.skippedSettlement).toBe(1);
  });

  test("a stale cache row is still refused by the worker's own check", () => {
    // Defence-in-depth: a cache written by an older build can hold this fixture
    // with a lay price attached. The worker must refuse it on the competition
    // alone, before any pairing.
    const [match] = transformMatches(cupRaw());
    const stale = {
      ...match,
      outcomes: match.outcomes.map((o) => ({
        ...o,
        layOdds: o.odds + 0.02,
        laySource: "Betfair",
        layBookmakerKey: "betfair_ex_uk",
        bookmakerKey: "casumo",
      })),
    };
    const result = findOpportunities([stale], 0.02);
    expect(result.opps).toEqual([]);
    expect(result.skippedSettlement).toBe(1);
  });

  test("Instant Wins shows nothing for it", () => {
    const matches = transformMatches(cupRaw());
    const wins = buildInstantWins(matches, { stake: 20, commission: 0.02 });
    expect(wins.rows).toEqual([]);
  });
});

describe("a matching league match still alerts", () => {
  test("lay prices are published and no settlement reason is attached", () => {
    const [match] = transformMatches(leagueRaw());
    expect(match).toBeDefined();
    expect(match.layWithheldReason).toBeUndefined();
    const withLay = match.outcomes.filter((o) => o.layOdds != null);
    expect(withLay.length).toBeGreaterThan(0);
    expect(withLay[0].laySource).toBe("Betfair");
  });

  test("a green on it reaches the alert text", () => {
    // The captured EPL prices are not green (they are a normal market). One
    // bookmaker's back price is raised until the trade is green, which is the
    // only change: the markets, outcome names and lay side are captured.
    const [match] = transformMatches(leagueRaw());
    const home = match.outcomes[0];
    const greened = {
      ...match,
      outcomes: match.outcomes.map((o) =>
        o.name === home.name ? { ...o, odds: (o.layOdds ?? 0) * 1.08, bookmaker: "Test Book" } : o,
      ),
    };
    const result = findOpportunities([greened], 0.02);
    const cash = result.opps.find((o) => o.type === "cash");
    expect(cash).toBeDefined();
    expect(result.skippedSettlement).toBe(0);
    expect(telegramText(cash!)).toContain("GREEN CASH");
  });
});

describe("the second proof: a lay market with no Draw is not match odds", () => {
  test("a two-way lay market on a league fixture is withheld", () => {
    const raw = leagueRaw();
    const event = raw[0];
    // Drop the Draw from the exchange's lay market only — the shape of a
    // "to qualify" market on a football match.
    const patched = {
      ...event,
      bookmakers: event.bookmakers.map((b) =>
        b.key !== "betfair_ex_uk"
          ? b
          : {
              ...b,
              markets: b.markets.map((m) =>
                m.key !== "h2h_lay"
                  ? m
                  : { ...m, outcomes: m.outcomes.filter((o) => o.name.toLowerCase() !== "draw") },
              ),
            },
      ),
    };
    const [match] = transformMatches([patched] as RawPayload);
    expect(match.layWithheldReason).toMatch(/no Draw/);
    for (const o of match.outcomes) expect(o.layOdds).toBeNull();
    expect(findOpportunities([match], 0.02).opps).toEqual([]);
  });
});

describe("the rule names the competitions it excludes", () => {
  test("knockout football is excluded, leagues are not", () => {
    for (const key of [
      "soccer_fa_cup",
      "soccer_england_efl_cup",
      "soccer_germany_dfb_pokal",
      "soccer_spain_copa_del_rey",
      "soccer_conmebol_copa_libertadores",
      "soccer_uefa_champs_league",
      "soccer_uefa_europa_league",
      "soccer_fifa_world_cup",
    ]) {
      expect(isKnockoutFootball(key)).toBe(true);
      expect(settlementProofFor(key).proven).toBe(false);
    }
    for (const key of ["soccer_epl", "soccer_spain_la_liga", "soccer_italy_serie_a"]) {
      expect(isKnockoutFootball(key)).toBe(false);
      expect(settlementProofFor(key).proven).toBe(true);
    }
    // Ice hockey keeps its own long-standing exclusion, for the same reason.
    expect(settlementProofFor("icehockey_nhl").proven).toBe(false);
    // A non-football sport is untouched by the cup rule.
    expect(settlementProofFor("tennis_atp_paris_masters").proven).toBe(true);
  });

  test("the site line is short and says what is missing and why", () => {
    expect(SETTLEMENT_NOTE.length).toBeLessThan(200);
    expect(SETTLEMENT_NOTE).toMatch(/cup ties/i);
    expect(SETTLEMENT_NOTE).toMatch(/settle on different results/i);
  });
});
