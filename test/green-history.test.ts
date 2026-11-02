import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEDUPE_WINDOW_HOURS,
  greenKey,
  loadGreenHistory,
  readGreenHistory,
  recordGreens,
  type GreenCandidate,
} from "../src/server/green-history";

/**
 * GREEN HISTORY — the "greens found in the last 30 days" panel is proof of
 * value, so the file behind it has three rules and these tests pin all three:
 *
 *  1. ONLY GREENS ENTER. A qualifying-grade pair (the Cameron Norrie
 *     1.44/1.46 case, a small loss) must never reach the file, and a record
 *     already on disk with a non-positive profit must never be read back.
 *  2. THE SAME OPPORTUNITY IS ONE ENTRY. The scan sees the same green every few
 *     minutes; a repeat inside DEDUPE_WINDOW_HOURS is not a second green.
 *  3. NEWEST FIRST. The panel lists the most recent ones under the best one, so
 *     the ordering is part of the contract.
 */

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eaw-greens-"));
  file = join(dir, "greens.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function green(over: Partial<GreenCandidate> = {}): GreenCandidate {
  return {
    sport: "soccer",
    match: "Arsenal v Chelsea",
    outcome: "Arsenal",
    bookmaker: "William Hill",
    backOdds: 2.1,
    exchange: "Betfair",
    layOdds: 2.0,
    commission: 0.02,
    ...over,
  };
}

describe("green history — only profitable pairs enter", () => {
  test("a 1.44/1.46 qualifying-grade pair never reaches the file", () => {
    const res = recordGreens(
      [green({ match: "Cameron Norrie v Opponent", outcome: "Norrie", backOdds: 1.44, layOdds: 1.46 })],
      { file, now: new Date("2026-11-02T10:00:00Z") },
    );
    expect(res.appended).toBe(0);
    expect(res.notGreen).toBe(1);
    // Nothing at all was written — not even a line with a negative number.
    expect(loadGreenHistory(file)).toEqual([]);
    // No file at all was created — nothing to read back later, either.
    expect(existsSync(file)).toBe(false);
  });

  test("a record already on disk with a non-positive profit is not read back", () => {
    const bad = {
      ts: "2026-11-02T09:00:00Z",
      sport: "soccer",
      match: "Arsenal v Chelsea",
      outcome: "Arsenal",
      bookmaker: "William Hill",
      backOdds: 1.44,
      exchange: "Betfair",
      layOdds: 1.46,
      profitAt20: -0.4,
      commissionPct: 2,
    };
    writeFileSync(file, JSON.stringify(bad) + "\n", "utf8");
    expect(loadGreenHistory(file)).toEqual([]);
    const summary = readGreenHistory({ file, now: new Date("2026-11-02T10:00:00Z") });
    expect(summary.count).toBe(0);
    expect(summary.best).toBeNull();
  });

  test("a genuinely green pair is recorded once, with the profit at £20", () => {
    const res = recordGreens([green({ backOdds: 2.1, layOdds: 2.0 })], {
      file,
      now: new Date("2026-11-02T10:00:00Z"),
    });
    expect(res.appended).toBe(1);
    const rows = loadGreenHistory(file);
    expect(rows).toHaveLength(1);
    expect(rows[0].profitAt20).toBeGreaterThan(0);
    expect(rows[0].match).toBe("Arsenal v Chelsea");
    expect(rows[0].backOdds).toBe(2.1);
    expect(rows[0].layOdds).toBe(2.0);
  });
});

describe("green history — the same opportunity is one entry", () => {
  test("the same trade seen again 10 minutes later is a duplicate, not a second green", () => {
    const t0 = new Date("2026-11-02T10:00:00Z");
    const t1 = new Date("2026-11-02T10:10:00Z");
    expect(recordGreens([green()], { file, now: t0 }).appended).toBe(1);
    const second = recordGreens([green()], { file, now: t1 });
    expect(second.appended).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(loadGreenHistory(file)).toHaveLength(1);
  });

  test("inside the dedupe window it stays one entry; after it, a re-priced trade is new", () => {
    const t0 = new Date("2026-11-02T10:00:00Z");
    const inside = new Date(t0.getTime() + (DEDUPE_WINDOW_HOURS - 1) * 3600_000);
    const outside = new Date(t0.getTime() + (DEDUPE_WINDOW_HOURS + 1) * 3600_000);
    recordGreens([green()], { file, now: t0 });
    expect(recordGreens([green()], { file, now: inside }).appended).toBe(0);
    expect(recordGreens([green()], { file, now: outside }).appended).toBe(1);
    expect(loadGreenHistory(file)).toHaveLength(2);
  });

  test("the same match at a DIFFERENT price is a different opportunity", () => {
    const t0 = new Date("2026-11-02T10:00:00Z");
    recordGreens([green({ backOdds: 2.1, layOdds: 2.0 })], { file, now: t0 });
    const repriced = recordGreens([green({ backOdds: 2.2, layOdds: 2.0 })], {
      file,
      now: new Date("2026-11-02T10:05:00Z"),
    });
    expect(repriced.appended).toBe(1);
    expect(loadGreenHistory(file)).toHaveLength(2);
    // And the two are genuinely different identities, not a rounding accident.
    expect(greenKey(green({ backOdds: 2.1, layOdds: 2.0 }))).not.toBe(
      greenKey(green({ backOdds: 2.2, layOdds: 2.0 })),
    );
  });
});

describe("green history — newest first, best picked out", () => {
  test("the window is ordered newest first and the best is the largest profit", () => {
    const now = new Date("2026-11-02T12:00:00Z");
    recordGreens([green({ match: "Older v Match", backOdds: 2.1, layOdds: 2.0 })], {
      file,
      now: new Date("2026-11-01T09:00:00Z"),
    });
    recordGreens([green({ match: "Middle v Match", backOdds: 2.3, layOdds: 2.0 })], {
      file,
      now: new Date("2026-11-02T09:00:00Z"),
    });
    recordGreens([green({ match: "Newest v Match", backOdds: 2.15, layOdds: 2.0 })], {
      file,
      now: new Date("2026-11-02T11:00:00Z"),
    });

    const summary = readGreenHistory({ file, now, limit: 10 });
    expect(summary.count).toBe(3);
    expect(summary.entries.map((e) => e.match)).toEqual([
      "Newest v Match",
      "Middle v Match",
      "Older v Match",
    ]);
    // The best is the one with the most money locked in, not the newest.
    expect(summary.best?.match).toBe("Middle v Match");
  });

  test("entries outside the window are not counted", () => {
    const now = new Date("2026-11-02T12:00:00Z");
    recordGreens([green({ match: "Long ago v Match" })], {
      file,
      now: new Date(now.getTime() - 40 * 24 * 3600_000),
    });
    recordGreens([green({ match: "Recent v Match" })], {
      file,
      now: new Date(now.getTime() - 2 * 24 * 3600_000),
    });
    const summary = readGreenHistory({ file, now });
    expect(summary.windowDays).toBe(30);
    expect(summary.count).toBe(1);
    expect(summary.entries[0].match).toBe("Recent v Match");
  });

  test("an empty history is zero, not an error", () => {
    const summary = readGreenHistory({ file: join(dir, "does-not-exist.jsonl"), now: new Date() });
    expect(summary.count).toBe(0);
    expect(summary.best).toBeNull();
    expect(summary.entries).toEqual([]);
  });
});
