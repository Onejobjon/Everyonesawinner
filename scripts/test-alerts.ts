/**
 * Pipeline test for the alert worker's opportunity filter + Telegram format.
 *
 * Run:  bun scripts/test-alerts.ts
 *
 * Covers the free-bet freshness/coverage guard (added to stop fake "free bet
 * >100%" alerts from stale/sparse exchange lay data, e.g. minor-league SHL),
 * the green-cash rule (unchanged), and the owner's simplified Telegram format.
 */
import { findOpportunities, telegramText } from "../src/server/alerts";
import type { Match, MatchOutcome } from "../src/lib/odds-api";

const NOW = Date.parse("2026-10-19T08:00:00Z");
const fresh = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}

function mkOutcome(
  o: { name: string; odds: number; layOdds: number | null } & Partial<MatchOutcome>
): MatchOutcome {
  const { name, odds, layOdds, ...rest } = o;
  return {
    name,
    bookmaker: "Sky Bet",
    odds,
    return20: Math.round(20 * odds * 100) / 100,
    layOdds,
    laySource: layOdds ? "Betfair" : null,
    layBookmakerKey: layOdds ? "betfair_ex_uk" : null,
    backLastUpdate: null,
    layLastUpdate: null,
    bookmakerOdds: [],
    ...rest,
  };
}

function mkMatch(
  o: { home: string; away: string; outcomes: MatchOutcome[] } & Partial<Match>
): Match {
  const { home, away, outcomes, ...rest } = o;
  return {
    matchId: "m-" + Math.random().toString(36).slice(2),
    home,
    away,
    league: "Test League",
    leagueKey: "test_league",
    time: "20:00",
    commenceTime: "2026-10-19T20:00:00Z",
    outcomes,
    hasLayCoverage: true,
    ...rest,
  };
}

console.log("1) GREEN CASH — tight gap, positive profit");
{
  const m = mkMatch({
    home: "Arsenal",
    away: "Chelsea",
    outcomes: [mkOutcome({ name: "Over 2.5 Goals", odds: 2.0, layOdds: 1.9 })],
  });
  const { opps, skippedSuspects } = findOpportunities([m]);
  assert(opps.length === 1, `exactly 1 opportunity (got ${opps.length})`);
  assert(opps[0]?.type === "cash", "type is 'cash'");
  assert(opps[0]?.type === "cash" && opps[0].expectedProfit === 0.54, "expectedProfit = 0.54");
  assert(skippedSuspects === 0, "no suspect rows skipped");
}

console.log("2) FREE BET 100%+ — fresh, covered league → alerts");
{
  const m = mkMatch({
    home: "Team A",
    away: "Team B",
    outcomes: [
      mkOutcome({
        name: "Team A",
        odds: 5.0,
        layOdds: 3.5,
        backLastUpdate: fresh(5),
        layLastUpdate: fresh(10),
      }),
    ],
  });
  const { opps, skippedSuspects } = findOpportunities([m]);
  assert(opps.length === 1, `exactly 1 opportunity (got ${opps.length})`);
  assert(opps[0]?.type === "freebet", "type is 'freebet'");
  assert(
    opps[0]?.type === "freebet" && opps[0].freeBetProfit === 22.03,
    "freeBetProfit = 22.03"
  );
  assert(opps[0]?.type === "freebet" && opps[0].retentionPct === 110, "retentionPct = 110");
  assert(skippedSuspects === 0, "no suspect rows skipped");
}

console.log("3) SHL-style artefact — stale lay (lay ≪ back) → does NOT alert");
{
  const m = mkMatch({
    home: "Växjö Lakers",
    away: "Malmö",
    outcomes: [
      mkOutcome({
        name: "Växjö Lakers",
        odds: 5.5,
        layOdds: 2.56,
        backLastUpdate: fresh(5),
        layLastUpdate: fresh(120), // > 60 min older than back → stale
      }),
    ],
  });
  const { opps, skippedSuspects } = findOpportunities([m]);
  assert(opps.length === 0, `no opportunity (got ${opps.length})`);
  assert(skippedSuspects === 1, `1 suspect row skipped (got ${skippedSuspects})`);
}

console.log("4) SHL-style artefact — no league lay coverage → does NOT alert");
{
  const m = mkMatch({
    home: "Växjö Lakers",
    away: "Malmö",
    outcomes: [
      mkOutcome({
        name: "Växjö Lakers",
        odds: 5.5,
        layOdds: 2.56,
        backLastUpdate: fresh(5),
        layLastUpdate: fresh(5),
      }),
    ],
    hasLayCoverage: false,
  });
  const { opps, skippedSuspects } = findOpportunities([m]);
  assert(opps.length === 0, `no opportunity (got ${opps.length})`);
  assert(skippedSuspects === 1, `1 suspect row skipped (got ${skippedSuspects})`);
}

console.log("5) FREE BET — missing back timestamp → does NOT alert");
{
  const m = mkMatch({
    home: "Team C",
    away: "Team D",
    outcomes: [
      mkOutcome({
        name: "Team C",
        odds: 5.0,
        layOdds: 3.5,
        backLastUpdate: null,
        layLastUpdate: fresh(5),
      }),
    ],
  });
  const { opps, skippedSuspects } = findOpportunities([m]);
  assert(opps.length === 0, `no opportunity (got ${opps.length})`);
  assert(skippedSuspects === 1, `1 suspect row skipped (got ${skippedSuspects})`);
}

console.log("6) Telegram format — cash (two short lines, trimmed fields)");
{
  const m = mkMatch({
    home: "Arsenal",
    away: "Chelsea",
    outcomes: [mkOutcome({ name: "Arsenal to win", odds: 2.1, layOdds: 2.0 })],
  });
  const { opps } = findOpportunities([m]);
  const cash = opps.find((o) => o.type === "cash");
  assert(Boolean(cash), "cash opportunity present");
  if (cash) {
    const text = telegramText(cash);
    const lines = text.split("\n");
    assert(lines.length === 2, `exactly 2 lines (got ${lines.length})`);
    assert(lines[0].startsWith("💰 GREEN CASH — Arsenal to win @ 2.10 back / 2.00 lay"), `line1 prefix ok: "${lines[0]}"`);
    assert(lines[0].includes("— £20 → ~£0.46"), `line1 profit ok: "${lines[0]}"`);
    assert(lines[1] === "Arsenal v Chelsea · Sky Bet · kicks off 20:00 · odds move fast", `line2 ok: "${lines[1]}"`);
    assert(!/lay stake|liability|gap|detected|league/i.test(text), "no lay-stake/liability/gap/detected/league tokens");
  }
}

console.log("7) Telegram format — freebet (two short lines, trimmed fields)");
{
  const m = mkMatch({
    home: "Team A",
    away: "Team B",
    outcomes: [
      mkOutcome({
        name: "Over 2.5 goals",
        odds: 5.0,
        layOdds: 3.5,
        backLastUpdate: fresh(5),
        layLastUpdate: fresh(10),
      }),
    ],
  });
  const { opps } = findOpportunities([m]);
  const fb = opps.find((o) => o.type === "freebet");
  assert(Boolean(fb), "freebet opportunity present");
  if (fb) {
    const text = telegramText(fb);
    const lines = text.split("\n");
    assert(lines.length === 2, `exactly 2 lines (got ${lines.length})`);
    assert(lines[0].startsWith("🎯 FREE BET 100%+ — Over 2.5 goals @ 5.00 back / 3.50 lay"), `line1 prefix ok: "${lines[0]}"`);
    assert(lines[0].includes("£20 free bet → £22.03 (110%)"), `line1 retention ok: "${lines[0]}"`);
    assert(lines[1] === "Team A v Team B · Sky Bet · kicks off 20:00 · odds move fast", `line2 ok: "${lines[1]}"`);
    assert(!/lay stake|liability|gap|detected|league/i.test(text), "no lay-stake/liability/gap/detected/league tokens");
  }
}

console.log("");
if (failures > 0) {
  console.error(`✗ ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("✓ all assertions passed");
