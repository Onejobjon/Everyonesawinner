/**
 * Pipeline test for the alert worker's opportunity filter + Telegram format.
 *
 * Run:  bun scripts/test-alerts.ts
 *
 * Covers:
 *  • the back/lay sanity guard (sentinel prices and cross-coverage artefacts —
 *    e.g. minor-league SHL "back 5.50 / lay 2.56" — never alert), applied twice:
 *    at the data layer (src/lib/odds-api.ts transformMatches) and again here,
 *    because the worker's on-disk cache can hold matches transformed by an
 *    older build;
 *  • the free-bet freshness/coverage guard (stale or absent timestamps);
 *  • the green-cash rule;
 *  • the kick-off / actionability guards;
 *  • the owner's simplified Telegram format.
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
function near(actual: number | undefined, expected: number, label: string) {
  assert(
    actual != null && Math.abs(actual - expected) < 0.011,
    `${label} (expected ~${expected}, got ${actual})`
  );
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
    sportKey: "soccer_epl",
    time: "20:00",
    // Default kick-off 2h in the future (relative to real `now`) so a plain
    // mkMatch is actionable under the started/too-soon guards.
    commenceTime: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
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
  const { opps, skippedSuspects, skippedInsane } = findOpportunities([m]);
  assert(opps.length === 1, `exactly 1 opportunity (got ${opps.length})`);
  assert(opps[0]?.type === "cash", "type is 'cash'");
  assert(opps[0]?.type === "cash" && opps[0].expectedProfit === 0.54, "expectedProfit = 0.54");
  assert(skippedSuspects === 0, "no stale rows skipped");
  assert(skippedInsane === 0, "no insane back/lay rows skipped");
}

console.log("2) FREE BET 100%+ — sane pair, fresh, covered league → alerts");
{
  // 100.00 back / 90.00 lay is the edge of what the sanity check allows
  // (exactly 10% below the back), i.e. the only place a genuine >100%
  // free-bet retention can now come from: long odds with a tight exchange.
  const m = mkMatch({
    home: "Team A",
    away: "Team B",
    outcomes: [
      mkOutcome({
        name: "Team A",
        odds: 100,
        layOdds: 90,
        backLastUpdate: fresh(5),
        layLastUpdate: fresh(10),
      }),
    ],
  });
  const { opps, skippedSuspects, skippedInsane } = findOpportunities([m]);
  const fb = opps.find((o) => o.type === "freebet");
  assert(Boolean(fb), "freebet opportunity present");
  if (fb && fb.type === "freebet") {
    near(fb.freeBetProfit, 20.91, "freeBetProfit = 20.91");
    assert(fb.retentionPct >= 100, `retentionPct ≥ 100 (got ${fb.retentionPct})`);
  }
  assert(
    Boolean(opps.find((o) => o.type === "cash")),
    "the same row also shows as green cash (a >100% free bet implies cash profit)"
  );
  assert(skippedSuspects === 0, "no stale rows skipped");
  assert(skippedInsane === 0, "no insane back/lay rows skipped");
}

console.log("3) SHL-style artefact (lay ≪ back) in stale cached data → does NOT alert");
{
  // This row is what an older build's on-disk cache can still contain: the
  // sanity guard in the worker must catch it even without the data-layer flag.
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
  });
  const { opps, skippedSuspects, skippedInsane } = findOpportunities([m]);
  assert(opps.length === 0, `no opportunity (got ${opps.length})`);
  assert(skippedInsane === 1, `1 insane back/lay row skipped (got ${skippedInsane})`);
  assert(skippedSuspects === 0, "not counted as a stale-odds skip");
}

console.log("4) Sentinel lay price (451) → does NOT alert");
{
  const m = mkMatch({
    home: "Mainz",
    away: "Köln",
    outcomes: [mkOutcome({ name: "Mainz", odds: 2.4, layOdds: 451 })],
  });
  const { opps, skippedInsane } = findOpportunities([m]);
  assert(opps.length === 0, `no opportunity (got ${opps.length})`);
  assert(skippedInsane === 1, `1 insane row skipped (got ${skippedInsane})`);
}

console.log("5) FREE BET — sane pair but no back timestamp → cash only, no freebet");
{
  const m = mkMatch({
    home: "Team C",
    away: "Team D",
    outcomes: [
      mkOutcome({
        name: "Team C",
        odds: 100,
        layOdds: 90,
        backLastUpdate: null,
        layLastUpdate: fresh(5),
      }),
    ],
  });
  const { opps, skippedSuspects, skippedInsane } = findOpportunities([m]);
  assert(!opps.some((o) => o.type === "freebet"), "no freebet opportunity");
  assert(skippedSuspects === 1, `1 stale row skipped (got ${skippedSuspects})`);
  assert(skippedInsane === 0, `nothing insane (got ${skippedInsane})`);
}

console.log("6) FREE BET — sane pair, no league lay coverage → cash only, no freebet");
{
  const m = mkMatch({
    home: "Team E",
    away: "Team F",
    hasLayCoverage: false,
    outcomes: [
      mkOutcome({
        name: "Team E",
        odds: 100,
        layOdds: 90,
        backLastUpdate: fresh(5),
        layLastUpdate: fresh(5),
      }),
    ],
  });
  const { opps, skippedSuspects } = findOpportunities([m]);
  assert(!opps.some((o) => o.type === "freebet"), "no freebet opportunity");
  assert(skippedSuspects === 1, `1 stale/sparse row skipped (got ${skippedSuspects})`);
}

console.log("7) Telegram format — cash (two short lines, trimmed fields)");
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

console.log("8) Telegram format — freebet (two short lines, trimmed fields)");
{
  const m = mkMatch({
    home: "Team A",
    away: "Team B",
    outcomes: [
      mkOutcome({
        name: "Over 2.5 goals",
        odds: 100,
        layOdds: 90,
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
    assert(lines[0].startsWith("🎯 FREE BET 100%+ — Over 2.5 goals @ 100.00 back / 90.00 lay"), `line1 prefix ok: "${lines[0]}"`);
    assert(lines[0].includes("£20 free bet → £20.91 (105%)"), `line1 retention ok: "${lines[0]}"`);
    assert(lines[1] === "Team A v Team B · Sky Bet · kicks off 20:00 · odds move fast", `line2 ok: "${lines[1]}"`);
    assert(!/lay stake|liability|gap|detected|league/i.test(text), "no lay-stake/liability/gap/detected/league tokens");
  }
}

console.log("9) Started match (past commence_time) → does NOT alert");
{
  const m = mkMatch({
    home: "FC Tokyo",
    away: "V-Varen Nagasaki",
    commenceTime: new Date(Date.now() - 30 * 60_000).toISOString(), // kicked off 30 min ago
    outcomes: [mkOutcome({ name: "FC Tokyo", odds: 2.0, layOdds: 1.9 })],
  });
  const { opps, skippedStarted, skippedTooSoon } = findOpportunities([m]);
  assert(opps.length === 0, `no opportunity (got ${opps.length})`);
  assert(skippedStarted === 1, `1 started match skipped (got ${skippedStarted})`);
  assert(skippedTooSoon === 0, `0 too-soon skipped (got ${skippedTooSoon})`);
}

console.log("10) Match 5 min from kick-off → does NOT alert (too soon to act)");
{
  const m = mkMatch({
    home: "Arsenal",
    away: "Chelsea",
    commenceTime: new Date(Date.now() + 5 * 60_000).toISOString(), // 5 min away
    outcomes: [mkOutcome({ name: "Arsenal", odds: 2.0, layOdds: 1.9 })],
  });
  const { opps, skippedStarted, skippedTooSoon } = findOpportunities([m]);
  assert(opps.length === 0, `no opportunity (got ${opps.length})`);
  assert(skippedStarted === 0, `0 started skipped (got ${skippedStarted})`);
  assert(skippedTooSoon === 1, `1 too-soon match skipped (got ${skippedTooSoon})`);
}

console.log("11) Match 2h from kick-off → alerts");
{
  const m = mkMatch({
    home: "Lille",
    away: "Galatasaray",
    commenceTime: new Date(Date.now() + 2 * 60 * 60_000).toISOString(), // 2h away
    outcomes: [mkOutcome({ name: "Lille", odds: 2.0, layOdds: 1.9 })],
  });
  const { opps, skippedStarted, skippedTooSoon } = findOpportunities([m]);
  assert(opps.length === 1, `exactly 1 opportunity (got ${opps.length})`);
  assert(skippedStarted === 0, `0 started skipped (got ${skippedStarted})`);
  assert(skippedTooSoon === 0, `0 too-soon skipped (got ${skippedTooSoon})`);
}

// ── credit instrumentation (scripts/test-credits.ts) ───────────────────────
// Run in a child process: it must set ALERTS_RUN_DIR *before* importing the
// worker, and it mocks fetch, so it can never spend a credit or touch the real
// rollup. Kept here so `bun scripts/test-alerts.ts` covers the measurement too.
console.log("\n12) credit instrumentation — spend is recorded, not estimated");
{
  const child = Bun.spawnSync([process.execPath, "scripts/test-credits.ts"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = child.stdout.toString();
  const err = child.stderr.toString();
  const passed = (out.match(/^  ✓ /gm) || []).length;
  assert(child.exitCode === 0, `credit-instrumentation checks pass (${passed} assertions, exit ${child.exitCode})`);
  if (child.exitCode !== 0) console.error(out + err);
}

console.log("");
if (failures > 0) {
  console.error(`✗ ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("✓ all assertions passed");
