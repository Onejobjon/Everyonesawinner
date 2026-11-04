/**
 * LIVE-STATE ISOLATION — a `bun test` run must not be able to touch the alert
 * worker's real `.run/` directory.
 *
 * THE DEFECT (2026-11-04 10:39): running the suite wrote into
 * `/home/team/shared/site/.run/`. The evidence was a burst of fake
 * `coverage index: …` / `!! SPORTS LIST …` lines in the REAL `alerts.log`, and
 * (earlier) a test-shaped `alerts-sports-index.json` that the worker then read
 * as "no previous index to fall back on" — i.e. a test run looked exactly like a
 * vendor outage. Every module under `src/server/` resolved its own `.run/` path
 * at import time, and a test that did not override it inherited the live one.
 *
 * WHAT THIS FILE PROVES
 *  1. Under a test runner the run directory is a per-run TEMP directory.
 *  2. A scan-shaped operation with NO explicit directory writes into that temp
 *     directory and leaves every file in the live `.run/` byte-identical —
 *     content and mtime — including `alerts.log`, which is what leaked first.
 *  3. The live `alerts-cache.json` and `alerts-sports-index.json` are untouched
 *     by this file (and, through the preload's afterAll, by the whole suite).
 *  4. The guard itself fires: a write aimed at the live directory throws, names
 *     the file, and does not change the file.
 *  5. Production resolution is unchanged: with no test runner, `runDir()` is the
 *     live directory, and `ALERTS_RUN_DIR` still wins.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fetchSportsIndex } from "../src/server/alerts";
import {
  LIVE_RUN_DIR,
  isTestRun,
  liveRunViolations,
  runDir,
  withGuardProbe,
} from "../src/server/run-dir";

const REPO_ROOT = resolve(import.meta.dir, "..");
const LIVE_INDEX = join(LIVE_RUN_DIR, "alerts-sports-index.json");
const LIVE_CACHE = join(LIVE_RUN_DIR, "alerts-cache.json");
const LIVE_LOG = join(LIVE_RUN_DIR, "alerts.log");
const LIVE_LAST_SCAN = join(LIVE_RUN_DIR, "alerts-last-scan.json");

/** 21:00 London on Tue 3 Nov 2026 — the same clock the guard tests use. */
const NINE_PM = new Date("2026-11-03T21:00:00Z");

/**
 * The live STATE files: name → size + mtime, so even a rewrite of identical
 * bytes shows up. Logs (`*.log`) and pidfiles are excluded on purpose — the
 * worker's own keepalive appends to `.run/alerts.log` every minute, so they are
 * never still, and a test writing to them is caught by the guard + the
 * "nothing new in the live log" check below instead.
 */
const VOLATILE = /\.log$|\.pid$/;

function fingerprint(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    if (VOLATILE.test(name)) continue;
    try {
      const st = statSync(join(dir, name));
      out[name] = `${st.isDirectory() ? "d" : "f"}:${st.size}:${st.mtimeMs}`;
    } catch {
      out[name] = "unreadable";
    }
  }
  return out;
}

/** Bytes appended to `file` since `beforeSize` — tolerant of the keepalive's own lines. */
function appendedSince(file: string, beforeSize: number): string {
  if (!existsSync(file)) return "";
  const buf = readFileSync(file);
  return buf.subarray(Math.min(beforeSize, buf.length)).toString("utf8");
}

function sizeOf(file: string): number {
  return existsSync(file) ? statSync(file).size : 0;
}

/** Content hash of one file ("" when absent). */
function sha(file: string): string {
  if (!existsSync(file)) return "absent";
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Snapshot taken as this file loads — the "before" for the afterAll below. */
const AT_LOAD = {
  dir: fingerprint(LIVE_RUN_DIR),
  index: sha(LIVE_INDEX),
  cache: sha(LIVE_CACHE),
  lastScanMtime: existsSync(LIVE_LAST_SCAN) ? statSync(LIVE_LAST_SCAN).mtimeMs : null,
};

/** Stub the odds vendor: 20 in-season sports, each with one fixture 6h out. */
function stubVendor(): void {
  const sports = Array.from({ length: 20 }, (_, i) => ({ key: `sport_${i}`, title: `Sport ${i}`, active: true }));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.includes("/sports/?all=false")
      ? sports
      : [{ commence_time: "2026-11-04T03:00:00Z" }];
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
      text: async () => "",
    } as unknown as Response;
  }) as typeof fetch;
}

/** Run a bun snippet in a child process with a chosen environment. */
function resolveInChild(env: Record<string, string>): { dir: string; live: string } {
  const script =
    'import { LIVE_RUN_DIR, runDir } from "./src/server/run-dir";' +
    "console.log(JSON.stringify({ dir: runDir(), live: LIVE_RUN_DIR }));";
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "ALERTS_RUN_DIR" && k !== "NODE_ENV" && k !== "EAW_TEST_RUN") base[k] = v;
  }
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: REPO_ROOT,
    env: { ...base, ...env },
  });
  const out = proc.stdout.toString().trim().split("\n").pop() || "";
  if (!out) throw new Error(`child produced no output: ${proc.stderr.toString()}`);
  return JSON.parse(out) as { dir: string; live: string };
}

describe("A. a test run resolves runtime state to a temp directory", () => {
  test("isTestRun() is true and runDir() is not the live .run/", () => {
    expect(isTestRun()).toBe(true);
    expect(runDir()).not.toBe(LIVE_RUN_DIR);
    expect(runDir().startsWith(LIVE_RUN_DIR)).toBe(false);
  });

  test("the directory really is a fresh temp directory", () => {
    expect(resolve(runDir()).startsWith(resolve(tmpdir()))).toBe(true);
    expect(existsSync(runDir())).toBe(true);
  });

  test("production resolution is unchanged: no test runner → the live directory", () => {
    const prod = resolveInChild({ NODE_ENV: "production" });
    expect(prod.dir).toBe(prod.live);
    expect(prod.live).toBe(LIVE_RUN_DIR);
  });

  test("ALERTS_RUN_DIR still wins in production, but never hands a test the live dir", () => {
    // Production: the override is honoured, exactly as before.
    const custom = join(tmpdir(), "eaw-explicit-run-dir");
    const prod = resolveInChild({ NODE_ENV: "production", ALERTS_RUN_DIR: custom });
    expect(prod.dir).toBe(custom);

    // Test run: an override that points at the live directory is REFUSED.
    const underTest = resolveInChild({ NODE_ENV: "test", ALERTS_RUN_DIR: LIVE_RUN_DIR });
    expect(underTest.dir).not.toBe(LIVE_RUN_DIR);
    expect(underTest.dir.startsWith(tmpdir())).toBe(true);
  });
});

describe("B. a scan-shaped operation with no explicit directory cannot leak", () => {
  test("the index lands in the temp dir and every live file is byte-identical", async () => {
    const before = {
      dir: fingerprint(LIVE_RUN_DIR),
      index: sha(LIVE_INDEX),
      cache: sha(LIVE_CACHE),
      logSize: sizeOf(LIVE_LOG),
    };
    const originalFetch = globalThis.fetch;
    stubVendor();
    let index;
    try {
      // NO `runDir` in opts — this is the call shape that leaked.
      index = await fetchSportsIndex(NINE_PM, { retryDelayMs: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }

    // (b) the write landed in a temp directory…
    expect(index.sportsInSeason).toBe(20);
    expect(index.totalFixturesInWindow).toBe(20);
    const tempIndex = join(runDir(), "alerts-sports-index.json");
    expect(existsSync(tempIndex)).toBe(true);
    expect(JSON.parse(readFileSync(tempIndex, "utf8")).sportsInSeason).toBe(20);

    // …and the worker's own log line went there too, not to the live log.
    const tempLog = join(runDir(), "alerts.log");
    expect(existsSync(tempLog)).toBe(true);
    expect(readFileSync(tempLog, "utf8")).toContain("coverage index: 20 sports in season");

    // …and NOT to the live log — the exact symptom the lead found on 2026-11-04.
    const leaked = appendedSince(LIVE_LOG, before.logSize);
    expect(leaked).not.toContain("coverage index");
    expect(leaked).not.toContain("SPORTS LIST");

    // (a) nothing under the live .run/ changed — size, mtime and content.
    expect(fingerprint(LIVE_RUN_DIR)).toEqual(before.dir);
    expect(sha(LIVE_INDEX)).toBe(before.index);
    expect(sha(LIVE_CACHE)).toBe(before.cache);
  });
});

describe("C. the guard is a real second line of defence", () => {
  // Every probe below aims at a filename the worker does not use, so even a
  // catastrophically broken guard leaves a stray file rather than damaged state.
  // (An earlier version of this test aimed at the real index and proved the
  // point the hard way: it overwrote it when the guard turned out to be inert.)
  test("a write aimed at the live directory throws, names the file, and creates nothing", () => {
    const target = join(LIVE_RUN_DIR, "isolation-probe.json");
    const err = withGuardProbe(() => {
      try {
        writeFileSync(target, '{"sportsInSeason":0}');
        return null;
      } catch (e) {
        return e as Error;
      }
    });

    expect(err).toBeInstanceOf(Error);
    expect(String(err?.message)).toContain("TEST RUN BLOCKED");
    expect(String(err?.message)).toContain(target); // names the file
    expect(existsSync(target)).toBe(false); // the write never happened
  });

  test("creating anything inside the live directory is refused too", () => {
    const target = join(LIVE_RUN_DIR, "isolation-probe-dir");
    const err = withGuardProbe(() => {
      try {
        mkdirSync(target, { recursive: true });
        return null;
      } catch (e) {
        return e as Error;
      }
    });
    expect(err).toBeInstanceOf(Error);
    expect(existsSync(target)).toBe(false);
  });

  test("an append is refused as well — the flag does not smuggle it past", () => {
    const target = join(LIVE_RUN_DIR, "isolation-probe-append.jsonl");
    const err = withGuardProbe(() => {
      try {
        writeFileSync(target, "{}", { flag: "a" });
        return null;
      } catch (e) {
        return e as Error;
      }
    });
    expect(err).toBeInstanceOf(Error);
    expect(existsSync(target)).toBe(false);
  });

  test("no leak was recorded anywhere in this run", () => {
    expect(liveRunViolations()).toEqual([]);
  });
});

/**
 * THE WHOLE-FILE FINGERPRINT. Compared against the snapshot taken when this
 * file loaded. The worker legitimately rewrites the cache every ~30 minutes, so
 * the check is skipped (with a note) if the worker completed a scan during this
 * file — `alerts-last-scan.json` is the marker for that, and it is what the gap
 * alarm measures.
 */
afterAll(() => {
  const scanMoved =
    existsSync(LIVE_LAST_SCAN) && AT_LOAD.lastScanMtime !== null
      ? statSync(LIVE_LAST_SCAN).mtimeMs !== AT_LOAD.lastScanMtime
      : false;
  if (scanMoved) {
    console.log("[live-run-isolation] the worker scanned during this file — fingerprint check skipped");
    return;
  }
  expect(sha(LIVE_INDEX)).toBe(AT_LOAD.index);
  expect(sha(LIVE_CACHE)).toBe(AT_LOAD.cache);
  expect(fingerprint(LIVE_RUN_DIR)).toEqual(AT_LOAD.dir);
});
