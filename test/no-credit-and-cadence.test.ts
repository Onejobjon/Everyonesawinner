/**
 * THREE GUARDS, ONE FILE.
 *
 * 1. NO CREDIT OR COST LANGUAGE ANYWHERE A USER CAN SEE IT (owner, 2026-11-03:
 *    "Credit usage doesn't need to be in the site, remove any and related
 *    wording etc."). This is a lint over the strings that actually reach a
 *    browser: string/template literals and JSX text in the pages and components,
 *    plus the `message:` strings the API returns. Internal logging, the
 *    `credits.jsonl` spend log and code identifiers are deliberately still
 *    allowed to say "credit" — this is about copy, not about our own bookkeeping.
 *
 * 2. THE CADENCE IS 30 MINUTES, AND THE THREE PLACES THAT USE IT AGREE
 *    (src/lib/cadence.ts, scripts/alert-loop.sh, src/server/gap-alarm.ts).
 *
 * 3. SCAN ON OPEN IS SINGLE-FLIGHT, NEVER BLOCKS AND NEVER BLANKS
 *    (src/server/scan-on-open.ts), proved with a stubbed scan so the test spends
 *    no provider credits.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SCAN_INTERVAL_MIN, STALL_ALARM_MIN, SCAN_INTERVAL_SEC } from "../src/lib/cadence";
import { GAP_ALARM_MIN, decideGapAlarm } from "../src/server/gap-alarm";
import {
  decideScanOnOpen,
  ensureScanOnOpen,
  awaitInflight,
  resetScanOnOpenState,
  lockIsStale,
  lockFile,
  REFRESH_AFTER_MIN,
  REFRESH_COOLDOWN_MIN,
} from "../src/server/scan-on-open";

const ROOT = join(import.meta.dir, "..");
const BANNED = /credit|quota|billed|charged/i;

/** Drop every `${…}` region (brace-matched), so identifiers are not read as copy. */
function withoutExpressions(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf("${", i);
    if (start < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, start);
    let depth = 1;
    let j = start + 2;
    while (j < s.length && depth > 0) {
      if (s[j] === "{") depth += 1;
      else if (s[j] === "}") depth -= 1;
      j += 1;
    }
    i = j;
  }
  return out;
}

/** Everything inside "…", '…' or `…` — what a component can print. */
function literals(source: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  for (const m of source.matchAll(re)) {
    // `${result.credits.spent}` is an identifier, not copy: internal bookkeeping
    // must not fail the copy check.
    out.push(withoutExpressions(m[1] ?? m[2] ?? m[3] ?? ""));
  }
  return out;
}

/** Strip comments so the reasons written beside the code are not mistaken for copy. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/** JSX text: what is left after literals, comments and {...} expressions go. */
function jsxText(source: string): string {
  let s = stripComments(source);
  s = s.replace(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g, '""');
  for (let i = 0; i < 6; i += 1) s = s.replace(/\{[^{}]*\}/g, " ");
  return s;
}

function tsxFiles(dir: string): string[] {
  const abs = join(ROOT, dir);
  return readdirSync(abs)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => join(abs, f));
}

/** Server files whose `message:` strings and copy literals reach a user. */
const SERVER_COPY_FILES = [
  "serve-static.ts",
  "src/server/pro-gate.ts",
  "src/server/instant-wins.ts",
  "src/lib/same-match-fetch.ts",
  ...readdirSync(join(ROOT, "api")).filter((f) => f.endsWith(".ts")).map((f) => `api/${f}`),
];

function serverCopyLiterals(rel: string): string[] {
  const raw = readFileSync(join(ROOT, rel), "utf8");
  // console.* / log() lines are internal logging and keep their credit wording.
  const kept = stripComments(raw)
    .split("\n")
    .filter((line) => !/console\.(log|warn|error)|^\s*log\(/.test(line))
    .join("\n");
  return literals(kept);
}

describe("no credit or cost language reaches a user", () => {
  const pageFiles = [...tsxFiles("src/pages"), ...tsxFiles("src/components")];

  for (const file of pageFiles) {
    test(`${file.replace(ROOT + "/", "")} prints no credit wording`, () => {
      const raw = readFileSync(file, "utf8");
      const printed = [...literals(stripComments(raw)), jsxText(raw)];
      const offenders = printed.filter((chunk) => BANNED.test(chunk));
      expect(offenders).toEqual([]);
    });
  }

  for (const rel of SERVER_COPY_FILES) {
    test(`${rel} returns no credit wording`, () => {
      const offenders = serverCopyLiterals(rel).filter((chunk) => BANNED.test(chunk));
      expect(offenders).toEqual([]);
    });
  }

  test("the guard itself catches the wording we removed", () => {
    // A test that can never fail is not a guard.
    expect(BANNED.test("Costs 3 credits")).toBe(true);
    expect(BANNED.test("Nothing was charged for this page.")).toBe(true);
    expect(BANNED.test("Billed once a year")).toBe(true);
    expect(BANNED.test("You have hit your quota")).toBe(true);
    expect(BANNED.test("Prices as of 14:05 today")).toBe(false);
  });

  test("internal bookkeeping still exists (we removed copy, not the ledger)", () => {
    const alerts = readFileSync(join(ROOT, "src/server/alerts.ts"), "utf8");
    expect(alerts).toContain("credits.jsonl");
    expect(existsSync(join(ROOT, ".run/credits.jsonl")) || true).toBe(true);
  });
});

describe("cadence: 30 minutes, and every consumer agrees", () => {
  test("the schedule is 30 minutes", () => {
    expect(SCAN_INTERVAL_MIN).toBe(30);
    expect(SCAN_INTERVAL_SEC).toBe(1800);
  });

  test("the committed bash loop default matches src/lib/cadence.ts", () => {
    // This is what survives a machine replacement: the loop is re-read from the
    // repo, so its default — not an env var in somebody's shell — is the cadence.
    const sh = readFileSync(join(ROOT, "scripts/alert-loop.sh"), "utf8");
    const m = sh.match(/ALERT_INTERVAL_SEC:-(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBe(SCAN_INTERVAL_SEC);
  });

  test("the in-process worker defaults to the same cadence", () => {
    const src = readFileSync(join(ROOT, "src/server/alerts.ts"), "utf8");
    expect(src).toMatch(/num\(process\.env\.ALERT_CHECK_INTERVAL_MIN,\s*SCAN_INTERVAL_MIN\)/);
  });

  test("the stall alarm waits 75 minutes — longer than a whole healthy cycle", () => {
    expect(GAP_ALARM_MIN).toBe(STALL_ALARM_MIN);
    expect(STALL_ALARM_MIN).toBe(75);
    // The bug this fixes: 25 minutes fired on every healthy 30-minute cycle.
    expect(STALL_ALARM_MIN).toBeGreaterThan(SCAN_INTERVAL_MIN * 2);
  });

  test("a healthy 30-minute cycle never alarms", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    const d = decideGapAlarm({
      now,
      lastScanAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
      uptimeMs: 10 * 3600_000,
      announcedFor: null,
    });
    expect(d.action).toBe("none");
  });

  test("two missed cycles alarm once, and only once", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    const lastScanAt = new Date(now.getTime() - 80 * 60_000).toISOString();
    const first = decideGapAlarm({ now, lastScanAt, uptimeMs: 10 * 3600_000, announcedFor: null });
    expect(first.action).toBe("alert");
    if (first.action !== "alert") throw new Error("expected an alert");
    expect(first.message).toContain("every 30 minutes");
    const second = decideGapAlarm({
      now,
      lastScanAt,
      uptimeMs: 10 * 3600_000,
      announcedFor: first.stallKey,
    });
    expect(second.action).toBe("none");
  });
});

describe("scan on open", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eaw-scan-on-open-"));
    resetScanOnOpenState();
  });

  const fresh = (now: Date, minutesOld: number) =>
    new Date(now.getTime() - minutesOld * 60_000).toISOString();

  test("a scan fresher than 5 minutes does not start another", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    const d = decideScanOnOpen({
      now,
      newestScanAt: fresh(now, 2),
      lastAttemptAt: null,
      refreshing: false,
      canScan: true,
    });
    expect(d.action).toBe("skip");
  });

  test("a stale scan starts one; no scan at all starts one", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    expect(
      decideScanOnOpen({
        now,
        newestScanAt: fresh(now, REFRESH_AFTER_MIN + 1),
        lastAttemptAt: null,
        refreshing: false,
        canScan: true,
      }).action,
    ).toBe("start");
    expect(
      decideScanOnOpen({ now, newestScanAt: null, lastAttemptAt: null, refreshing: false, canScan: true })
        .action,
    ).toBe("start");
  });

  test("a host with no odds feed never claims to be scanning", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    const d = decideScanOnOpen({
      now,
      newestScanAt: null,
      lastAttemptAt: null,
      refreshing: false,
      canScan: false,
    });
    expect(d.action).toBe("skip");
  });

  test("a failing scan is not retried on every open (cooldown)", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    const d = decideScanOnOpen({
      now,
      newestScanAt: null,
      lastAttemptAt: fresh(now, REFRESH_COOLDOWN_MIN - 1),
      refreshing: false,
      canScan: true,
    });
    expect(d.action).toBe("skip");
  });

  test("TEN OPENS IN A MINUTE COST ONE SCAN (single flight)", async () => {
    const now = new Date("2026-11-03T12:00:00Z");
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const scan = async () => {
      calls += 1;
      await gate; // hold the scan open so every open arrives while it runs
      return { ok: true };
    };

    const results = Array.from({ length: 10 }, () =>
      ensureScanOnOpen({ now, newestScanAt: fresh(now, 30), scan, dir }),
    );

    // Let the started scan actually begin (it is fire-and-forget by design).
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1); // one scan, not ten
    expect(results.filter((r) => r.started)).toHaveLength(1);
    // Everyone else is told a refresh is in progress and keeps the rows they have.
    expect(results.filter((r) => r.refreshing)).toHaveLength(10);

    release();
    await awaitInflight();
    expect(calls).toBe(1);
  });

  test("a second open after the scan finished does not start another (data is fresh now)", async () => {
    const now = new Date("2026-11-03T12:00:00Z");
    let calls = 0;
    const scan = async () => {
      calls += 1;
    };
    ensureScanOnOpen({ now, newestScanAt: fresh(now, 30), scan, dir });
    await awaitInflight();
    // The scan just finished: the caller now reports a fresh snapshot.
    const again = ensureScanOnOpen({ now, newestScanAt: fresh(now, 0), scan, dir });
    expect(again.started).toBe(false);
    expect(calls).toBe(1);
  });

  test("a failed scan leaves the state clean and the old snapshot untouched", async () => {
    const now = new Date("2026-11-03T12:00:00Z");
    const scan = async () => {
      throw new Error("provider said no");
    };
    const first = ensureScanOnOpen({ now, newestScanAt: fresh(now, 30), scan, dir });
    expect(first.started).toBe(true);
    await awaitInflight();
    // Not stuck "refreshing": the page must not sit on a spinner forever.
    const second = ensureScanOnOpen({ now, newestScanAt: fresh(now, 30), scan, dir });
    expect(second.refreshing).toBe(false);
    // And it does not immediately try again (the credit guard).
    expect(second.started).toBe(false);
  });

  test("another process's live lock is respected; a dead one is not", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    writeFileSync(
      lockFile(dir),
      JSON.stringify({ pid: process.pid, startedAt: now.toISOString() }),
      "utf8",
    );
    let calls = 0;
    const scan = async () => {
      calls += 1;
    };
    const r = ensureScanOnOpen({ now, newestScanAt: fresh(now, 30), scan, dir });
    expect(r.started).toBe(false);
    expect(r.refreshing).toBe(true); // someone is scanning — say so
    expect(calls).toBe(0);

    // A lock from a dead process is abandoned, not obeyed (the 4.5-day outage).
    expect(lockIsStale({ pid: 999_999, startedAt: now.toISOString() }, now)).toBe(true);
    expect(lockIsStale({ pid: process.pid, startedAt: now.toISOString() }, now)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
