/**
 * THE SPORTS-LIST GUARD — a short `/sports/?all=false` is a BAD RESPONSE, not news.
 *
 * OBSERVED DEFECT (2026-11-03): the 23:11 scan recorded `sportsInSeason: 2` where
 * the endpoint returns 80 (verified twice by hand three minutes later). Coverage
 * collapsed to one sport for the next 30 minutes. A forced rebuild at 23:15 found
 * 19 sports / 102 fixtures — i.e. the world had not changed, the answer had.
 *
 * The rule these tests pin:
 *   • fewer than 20 in-season sports → retry the list once;
 *   • if the retry is still short → reuse the PREVIOUS index's in-season list
 *     (re-counting its fixtures), or the previous index unchanged when the file
 *     predates this guard;
 *   • log loudly (`!! SPORTS LIST ...`) and mark the index `degraded`;
 *   • a healthy list is never retried.
 *
 * The provider is stubbed: these are free calls, but a test must not spend one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SPORTS_LIST_FLOOR,
  SPORTS_LIST_PREVIOUS_FLOOR,
  fetchSportsIndex,
  previousListIsUsable,
  sportsListIsShort,
} from "../src/server/alerts";

/** 21:00 in London on Tue 3 Nov 2026 — the owner's evening. */
const NINE_PM = new Date("2026-11-03T21:00:00Z");
const INDEX_FILE = "alerts-sports-index.json";

const sport = (key: string, title = key) => ({ key, title, active: true });

/** 80 keys, the shape a healthy vendor answer has. */
function keys(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `sport_${i}`);
}

let dir: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eaw-sports-guard-"));
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Stub the vendor. `lists` is what each successive `/sports/?all=false` call
 * returns (the last entry repeats); every events call returns one fixture 6
 * hours out, i.e. inside the rolling window.
 */
function stubVendor(lists: { key: string; title?: string; active?: boolean }[][]) {
  const state = { listCalls: 0, eventCalls: 0 };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    let body: unknown;
    if (url.includes("/sports/?all=false")) {
      body = lists[Math.min(state.listCalls, lists.length - 1)];
      state.listCalls++;
    } else {
      state.eventCalls++;
      body = [{ commence_time: "2026-11-04T03:00:00Z" }];
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
      text: async () => "",
    } as unknown as Response;
  }) as typeof fetch;
  return state;
}

function writePreviousIndex(index: Record<string, unknown>): void {
  writeFileSync(join(dir, INDEX_FILE), JSON.stringify(index));
}

const staleTs = () => Date.now() - 6 * 60 * 60_000; // well past the 30-minute index TTL

describe("the rule itself", () => {
  test("below 20 in-season sports is implausible; 20 and above is believed", () => {
    expect(SPORTS_LIST_FLOOR).toBe(20);
    expect(sportsListIsShort(0)).toBe(true);
    expect(sportsListIsShort(2)).toBe(true); // the 23:11 answer
    expect(sportsListIsShort(19)).toBe(true);
    expect(sportsListIsShort(20)).toBe(false);
    expect(sportsListIsShort(80)).toBe(false);
  });

  test("a previous index is only worth falling back to if it recorded a full list", () => {
    expect(SPORTS_LIST_PREVIOUS_FLOOR).toBe(80);
    expect(previousListIsUsable(80)).toBe(true);
    expect(previousListIsUsable(79)).toBe(false);
    expect(previousListIsUsable(null)).toBe(false);
    expect(previousListIsUsable(undefined)).toBe(false);
  });
});

describe("fetchSportsIndex guards the list", () => {
  test("PATH 1 — a short answer is retried once and the good retry is used", async () => {
    const state = stubVendor([[sport("basketball_nba")], keys(20).map((k) => sport(k))]);

    const index = await fetchSportsIndex(NINE_PM, { runDir: dir, retryDelayMs: 0 });

    expect(state.listCalls).toBe(2); // short answer, then the retry
    expect(index.sportsInSeason).toBe(20);
    expect(index.sports).toHaveLength(20);
    expect(index.totalFixturesInWindow).toBe(20);
    expect(index.degraded).toBeUndefined();
    // The healthy retry is what got persisted, so the next scan has a full list.
    const saved = JSON.parse(readFileSync(join(dir, INDEX_FILE), "utf8"));
    expect(saved.sportsInSeason).toBe(20);
    expect(saved.inSeason).toHaveLength(20);
  });

  test("PATH 2 — still short after the retry: reuse the previous in-season list", async () => {
    // The previous index recorded a full 80-sport world, and 20 of those keys.
    writePreviousIndex({
      ts: staleTs(),
      sportsInSeason: 80,
      inSeason: keys(20),
      sports: [{ key: "sport_0", title: "Old title", fixturesInWindow: 5, nextKickoff: null }],
      totalFixturesInWindow: 5,
      failed: 0,
    });
    const state = stubVendor([[sport("basketball_nba")], [sport("basketball_nba")]]);

    const index = await fetchSportsIndex(NINE_PM, { runDir: dir, retryDelayMs: 0 });

    expect(state.listCalls).toBe(2); // it did retry first
    expect(index.sportsInSeason).toBe(20); // …then used what it already knew
    expect(index.sports.map((s) => s.key)).toHaveLength(20);
    expect(index.degraded).toBe(true);
    expect(index.degradedReason).toContain("1 in-season sports");
    // The previous title is kept for the sport it knew about.
    expect(index.sports.find((s) => s.key === "sport_0")?.title).toBe("Old title");
  });

  test("PATH 2b — an index from before the guard has no key list: reuse it unchanged", async () => {
    const previous = {
      ts: staleTs(),
      sportsInSeason: 80,
      sports: [{ key: "soccer_epl", title: "Premier League", fixturesInWindow: 7, nextKickoff: null }],
      totalFixturesInWindow: 7,
      failed: 0,
    };
    writePreviousIndex(previous);
    stubVendor([[sport("basketball_nba")], [sport("basketball_nba")]]);

    const index = await fetchSportsIndex(NINE_PM, { runDir: dir, retryDelayMs: 0 });

    expect(index.sportsInSeason).toBe(80);
    expect(index.sports.map((s) => s.key)).toEqual(["soccer_epl"]);
    expect(index.totalFixturesInWindow).toBe(7);
    expect(index.degraded).toBe(true);
    // The file is NOT rewritten with a fresh ts: the next scan must ask the
    // vendor again rather than sit on the fallback for another TTL window.
    const saved = JSON.parse(readFileSync(join(dir, INDEX_FILE), "utf8"));
    expect(saved.ts).toBe(previous.ts);
  });

  test("PATH 3 — a healthy list is used as-is, with no retry", async () => {
    const state = stubVendor([keys(20).map((k) => sport(k))]);

    const index = await fetchSportsIndex(NINE_PM, { runDir: dir, retryDelayMs: 0 });

    expect(state.listCalls).toBe(1);
    expect(index.sportsInSeason).toBe(20);
    expect(index.degraded).toBeUndefined();
  });

  test("a failed list call is not mistaken for a world with no sport in it", async () => {
    // No previous index at all and the vendor 500s: the guard still fires, the
    // retry is attempted, and the short answer is kept but marked degraded.
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 500,
        headers: { get: () => null },
        json: async () => null,
        text: async () => "boom",
      }) as unknown as Response) as typeof fetch;

    const index = await fetchSportsIndex(NINE_PM, { runDir: dir, retryDelayMs: 0 });

    expect(index.sportsInSeason).toBe(0);
    expect(index.sports).toHaveLength(0);
    expect(index.degraded).toBe(true);
    expect(index.degradedReason).toContain("no previous index");
  });
});
