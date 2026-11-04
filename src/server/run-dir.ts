/**
 * ONE PLACE that answers "where does runtime state live?" — and the one place
 * allowed to decide that a TEST RUN may not touch the live directory.
 *
 * WHY THIS FILE EXISTS (defect, 2026-11-04 10:39)
 * ------------------------------------------------
 * `bun test` was writing into the LIVE alert-worker directory
 * (`/home/team/shared/site/.run/`). Every module that keeps state under `.run/`
 * worked out its own default at import time:
 *
 *   alerts.ts        process.env.ALERTS_RUN_DIR || join(import.meta.dir, "../../.run")
 *   green-history.ts process.env.GREENS_FILE || join(ALERTS_RUN_DIR || live, "greens.jsonl")
 *   instant-wins.ts  process.env.ALERTS_RUN_DIR || join(import.meta.dir, "../../.run")
 *   users/sessions/leads/comps/click-log   join(process.cwd(), ".run", …)
 *
 * A test that imported any of them without overriding the env var inherited the
 * live path. The observed damage: a suite run appended a burst of fake
 * `coverage index: …` / `!! SPORTS LIST …` lines to the real `.run/alerts.log`,
 * and (earlier) replaced the real `alerts-sports-index.json` with a test-shaped
 * one, which the worker then read as "no previous index to fall back on" and
 * reported as a vendor outage.
 *
 * THE RULE
 * --------
 *  • Production: byte-identical to before — same paths, same file names, same
 *    permissions, same env overrides.
 *  • Under a test runner: `runDir()` resolves to a fresh per-process temp
 *    directory (`mkdtemp`), so a test that forgets to pass a directory cannot
 *    leak. An explicit `ALERTS_RUN_DIR` that points somewhere safe is honoured;
 *    one that points at the live `.run/` is IGNORED (replaced by the temp dir).
 *  • Any write that still resolves inside the live `.run/` during a test run
 *    throws (see `assertNotLiveRunWrite`) — the second line of defence, wired
 *    in as an fs-level guard by `test/setup/live-run-guard.ts`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/** The repo's real runtime directory — `<repo>/.run`. Never written by a test. */
export const LIVE_RUN_DIR = resolve(import.meta.dir, "../../.run");

/**
 * Is this process a test runner?
 *
 * Several independent signals, because a miss here means a test writes to live
 * state: bun sets `NODE_ENV=test`, installs `describe`/`test` globals before a
 * test file's imports run, and puts a bare `test` in argv. `EAW_TEST_RUN=1` is
 * the explicit switch for anything that is test-shaped but not `bun test`.
 */
export function isTestRun(): boolean {
  if (process.env.EAW_TEST_RUN === "1") return true;
  if (process.env.NODE_ENV === "test") return true;
  if (process.env.BUN_TEST === "1") return true;
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.describe === "function" && typeof g.test === "function") return true;
  const argv = process.argv;
  if (Array.isArray(argv) && argv[1] === "test") return true;
  return false;
}

/** Does `file` resolve inside the repo's live `.run/`? Symlinks included when
 * the path exists, so a link cannot be used to sneak a write in. */
export function isInsideLiveRunDir(file: string | URL | undefined): boolean {
  if (!file) return false;
  const raw = typeof file === "string" ? file : String(file);
  if (!raw) return false;
  const candidates = [resolve(raw)];
  try {
    if (existsSync(raw)) candidates.push(realpathSync(raw));
  } catch {
    /* unreadable path — the resolved form is the best we have */
  }
  return candidates.some((p) => p === LIVE_RUN_DIR || p.startsWith(LIVE_RUN_DIR + sep));
}

// ── Violation ledger (read by the tests, and by the preload's afterAll) ──────

export interface LiveRunViolation {
  op: string;
  file: string;
  at: string;
}

const violations: LiveRunViolation[] = [];
/** >0 while a test is deliberately proving the guard fires. */
let probing = 0;

export function liveRunViolations(): LiveRunViolation[] {
  return violations.slice();
}

export function clearLiveRunViolations(): void {
  violations.length = 0;
}

/** Run `fn` without recording the block it is expected to trigger. */
export function withGuardProbe<T>(fn: () => T): T {
  probing++;
  try {
    return fn();
  } finally {
    probing--;
  }
}

/**
 * THE GUARD. Throws if a test run tries to write inside the live `.run/`.
 *
 * Called by every write helper below, and by the fs-level wrapper installed by
 * the test preload — which is what catches a module that never went through a
 * helper at all.
 */
export function assertNotLiveRunWrite(file: string | URL | undefined, op = "write"): void {
  if (!isTestRun()) return; // production is untouched
  if (!isInsideLiveRunDir(file)) return;
  const path = typeof file === "string" ? file : String(file);
  if (probing === 0) violations.push({ op, file: path, at: new Date().toISOString() });
  throw new Error(
    `[eaw] TEST RUN BLOCKED a ${op} into the LIVE alert-worker directory.\n` +
      `  file: ${path}\n` +
      `  live: ${LIVE_RUN_DIR}\n` +
      `A test resolved a runtime path to the real .run/ directory. Under a test run every\n` +
      `runtime path must resolve to the per-run temp directory (src/server/run-dir.ts).\n` +
      `Pass the directory explicitly, or let runDir() supply the temp one.`,
  );
}

// ── Resolution ─────────────────────────────────────────────────────────────

let cachedRunDir: string | null = null;

/** The per-run temp directory. Created once, removed when the process exits. */
function testRunDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eaw-test-run-"));
  if (process.env.EAW_KEEP_TEST_RUN_DIR !== "1") {
    process.once("exit", () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });
  }
  return dir;
}

/**
 * Where runtime state lives for THIS process.
 *
 * Production: `ALERTS_RUN_DIR` if set, else `<repo>/.run` — exactly as before.
 * Test run:   the temp directory, unless an explicit `ALERTS_RUN_DIR` points
 *             somewhere that is not the live `.run/`.
 */
export function runDir(): string {
  if (cachedRunDir) return cachedRunDir;
  const envDir = (process.env.ALERTS_RUN_DIR || "").trim();
  if (isTestRun()) {
    cachedRunDir = envDir && !isInsideLiveRunDir(envDir) ? resolve(envDir) : testRunDir();
  } else {
    cachedRunDir = envDir ? resolve(envDir) : LIVE_RUN_DIR;
  }
  return cachedRunDir;
}

/** A file inside `runDir()`. */
export function runFile(name: string): string {
  return join(runDir(), name);
}

/**
 * A file that follows the alert worker's rule: an explicit env override wins,
 * otherwise the run directory. Production behaviour is unchanged; under a test
 * run the fallback is the temp directory.
 */
export function alertsRunFile(envValue: string | undefined, name: string): string {
  const explicit = (envValue || "").trim();
  if (explicit) return resolve(explicit);
  return join(runDir(), name);
}

/**
 * A file that follows the "cwd/.run" rule the account stores use (users,
 * sessions, leads, comps, clicks). Production is untouched — `process.cwd()`
 * still decides; only a test run is redirected to the temp directory.
 */
export function cwdRunFile(envValue: string | undefined, name: string): string {
  const explicit = (envValue || "").trim();
  if (explicit) return resolve(explicit);
  if (isTestRun()) return join(runDir(), name);
  return join(process.cwd(), ".run", name);
}

// ── Guarded writes ─────────────────────────────────────────────────────────

/** mkdir + writeFile, guarded. Production mode/behaviour identical. */
export function writeRunFile(file: string, data: string): void {
  assertNotLiveRunWrite(file, "write");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data, "utf8");
}

/** mkdir + appendFile, guarded. */
export function appendRunFile(file: string, data: string): void {
  assertNotLiveRunWrite(file, "append");
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, data, "utf8");
}

/** mkdir -p, guarded (a test must not even create the live directory). */
export function ensureRunDir(dir: string): void {
  assertNotLiveRunWrite(dir, "mkdir");
  mkdirSync(dir, { recursive: true });
}

/** Read a run file, or null when it is absent/unreadable. Never throws. */
export function readRunFile(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}
