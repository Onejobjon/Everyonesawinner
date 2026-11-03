/**
 * THE SCAN WINDOW — overnight US fixtures must be in it.
 *
 * OWNER COMPLAINT (2026-11-03): "On the site it just says 3 tournaments... The
 * reason we scan through the night is for the American market. If we don't have
 * access there is no point in scanning at night."
 *
 * The cause was a LONDON CALENDAR DAY filter: `londonDay(commence_time) ===
 * today`. At 20:52 UTC on 2026-11-03 that counted 2 fixtures, because every NBA,
 * NHL and NFL tip-off falls after midnight in London and was therefore filed as
 * "tomorrow". The fix is a ROLLING WINDOW on absolute time:
 *
 *     now  <  commence_time  <=  now + 26 hours
 *
 * These tests pin that rule at the three points that matter — the free index (what
 * we pay for), the cache prune (what we keep), and the feed (what we show) — and
 * pin the one case that used to fail: 21:00 London, 03:00 the next morning.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SCAN_WINDOW_HOURS, isInScanWindow, scanWindowEnd, windowPhrase } from "../src/lib/scan-window";
import { selectWindowMatches } from "../src/lib/instant-wins";
import type { Match } from "../src/lib/odds-api";

/** 21:00 in London on Tue 3 Nov 2026 (GMT, so 21:00 UTC) — the owner's evening. */
const NINE_PM = new Date("2026-11-03T21:00:00Z");

function match(commenceTime: string, sportKey = "basketball_nba"): Match {
  return {
    matchId: `id-${sportKey}-${commenceTime}`,
    home: "Home",
    away: "Away",
    league: "NBA",
    leagueKey: sportKey,
    sportKey,
    time: "03:00",
    commenceTime,
    outcomes: [],
    hasLayCoverage: true,
  };
}

describe("the window rule", () => {
  test("an NBA tip-off at 03:00 the next morning IS in the window at 21:00", () => {
    // 21:00 London → 03:00 London the next day: six hours out, a different
    // calendar date, and exactly what the overnight scan exists for.
    expect(isInScanWindow("2026-11-04T03:00:00Z", NINE_PM)).toBe(true);
  });

  test("a fixture 30 hours out is NOT in the window", () => {
    // 21:00 + 30h = 03:00 two mornings later. Beyond 26h, so not paid for.
    expect(isInScanWindow("2026-11-05T03:00:00Z", NINE_PM)).toBe(false);
  });

  test("a fixture that has already started is NOT in the window", () => {
    expect(isInScanWindow("2026-11-03T20:00:00Z", NINE_PM)).toBe(false);
    // And a fixture starting exactly NOW has started — strictly greater than.
    expect(isInScanWindow(NINE_PM.toISOString(), NINE_PM)).toBe(false);
  });

  test("the far edge is inclusive, one second past it is not", () => {
    const end = scanWindowEnd(NINE_PM);
    expect(isInScanWindow(end.toISOString(), NINE_PM)).toBe(true);
    expect(isInScanWindow(new Date(end.getTime() + 1000).toISOString(), NINE_PM)).toBe(false);
  });

  test("an unparseable or missing time is never in the window", () => {
    expect(isInScanWindow("not a date", NINE_PM)).toBe(false);
    expect(isInScanWindow(null, NINE_PM)).toBe(false);
    expect(isInScanWindow(undefined, NINE_PM)).toBe(false);
  });

  test("the window is 26 hours and the site's phrase says so", () => {
    expect(SCAN_WINDOW_HOURS).toBe(26);
    expect(windowPhrase()).toBe("in the next 26 hours");
  });

  test("the feed keeps the same fixtures the window rule keeps", () => {
    const kept = selectWindowMatches(
      [
        match("2026-11-04T03:00:00Z"), // overnight NBA — the point of the fix
        match("2026-11-03T20:00:00Z"), // already started
        match("2026-11-05T03:00:00Z"), // 30h out
      ],
      NINE_PM,
    );
    expect(kept.map((m) => m.commenceTime)).toEqual(["2026-11-04T03:00:00Z"]);
  });
});

describe("the free index counts the overnight slate (0 credits, stubbed provider)", () => {
  test("an NBA game after midnight is indexed; a fixture 30h out is not", async () => {
    // `runDir` is passed explicitly: the module-level default is fixed at import,
    // so relying on ALERTS_RUN_DIR made this test depend on which file imported
    // alerts.ts first — and when the live worker's own index was fresh, the test
    // read THAT instead of its own stub.
    const dir = mkdtempSync(join(tmpdir(), "eaw-index-"));
    const originalFetch = globalThis.fetch;
    try {
      // The index is a set of free GETs: the sport list, then one events call per
      // sport. Stubbed here so the test is deterministic and spends nothing.
      const sports = [
        { key: "basketball_nba", title: "NBA", active: true },
        { key: "soccer_epl", title: "Premier League", active: true },
      ];
      const events: Record<string, { commence_time: string }[]> = {
        basketball_nba: [{ commence_time: "2026-11-04T03:00:00Z" }], // 6h out — in
        soccer_epl: [{ commence_time: "2026-11-05T03:00:00Z" }], // 30h out — not
      };
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        const body = url.includes("/sports/?all=false")
          ? sports
          : events[/\/sports\/([a-z_]+)\/events\//.exec(url)?.[1] ?? ""] ?? [];
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => body,
          text: async () => "",
        } as unknown as Response;
      }) as typeof fetch;

      const { fetchSportsIndex } = await import("../src/server/alerts");
      const index = await fetchSportsIndex(NINE_PM, { runDir: dir, retryDelayMs: 0 });

      expect(index.sports.map((s) => s.key)).toEqual(["basketball_nba"]);
      expect(index.sports[0].fixturesInWindow).toBe(1);
      expect(index.sports[0].nextKickoff).toBe("2026-11-04T03:00:00Z");
      expect(index.totalFixturesInWindow).toBe(1);
      expect(index.sportsInSeason).toBe(2);
      // The field names say what they mean: no "today" survives in the index.
      expect(index).not.toHaveProperty("totalTodayFixtures");
      expect(index.sports[0]).not.toHaveProperty("todayFixtures");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the cache prune uses the same rule", () => {
  test("started and out-of-window fixtures are dropped; overnight ones are kept", async () => {
    const { pruneScanCache } = await import("../src/server/alerts");
    const kept = pruneScanCache(
      [
        match("2026-11-04T03:00:00Z"), // overnight NBA — kept
        match("2026-11-03T20:00:00Z"), // started — dropped
        match("2026-11-05T03:00:00Z"), // 30h out — dropped
      ],
      { now: NINE_PM, sportsInSeason: ["basketball_nba"], fetchedSports: ["basketball_nba"] },
    );
    expect(kept.map((m) => m.commenceTime)).toEqual(["2026-11-04T03:00:00Z"]);
  });

  test("a sport no longer in season loses its cached fixtures", async () => {
    const { pruneScanCache } = await import("../src/server/alerts");
    const kept = pruneScanCache([match("2026-11-04T03:00:00Z", "basketball_nba")], {
      now: NINE_PM,
      sportsInSeason: [], // NBA has finished for the season
      fetchedSports: ["basketball_nba"],
    });
    expect(kept).toHaveLength(0);
  });
});

describe("an index file from before the rename is rebuilt, not trusted", () => {
  test("a fresh old-shape index is ignored and re-fetched on the new rule", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eaw-index-old-"));
    const originalFetch = globalThis.fetch;
    try {
      // A file written seconds ago by the calendar-day build: fresh enough for the
      // TTL, but its numbers answer the wrong question.
      writeFileSync(
        join(dir, "alerts-sports-index.json"),
        JSON.stringify({
          ts: Date.now(),
          sportsInSeason: 80,
          sports: [{ key: "soccer_brazil_campeonato", title: "Brazil", todayFixtures: 1 }],
          totalTodayFixtures: 2,
          failed: 0,
        }),
      );
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        const body = url.includes("/sports/?all=false")
          ? [{ key: "basketball_nba", title: "NBA", active: true }]
          : [{ commence_time: "2026-11-04T03:00:00Z" }];
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => body,
          text: async () => "",
        } as unknown as Response;
      }) as typeof fetch;

      const { fetchSportsIndex } = await import("../src/server/alerts");
      const index = await fetchSportsIndex(NINE_PM, { runDir: dir, retryDelayMs: 0 });
      expect(index.sports.map((s) => s.key)).toEqual(["basketball_nba"]);
      expect(index.totalFixturesInWindow).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
