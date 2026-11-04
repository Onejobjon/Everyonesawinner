/**
 * TEST PRELOAD — the hard guard (second line of defence).
 *
 * `src/server/run-dir.ts` makes a test run resolve every runtime path to a
 * per-run temp directory. This file covers the case where that is not enough:
 * any code path that still resolves to the repo's LIVE `.run/` — a module that
 * never went through run-dir.ts, a hand-built path, a future regression —
 * throws instead of writing, and the whole `bun test` run FAILS at the end
 * (see the afterAll below) rather than quietly corrupting the live scanner.
 *
 * ORDER MATTERS. Bun snapshots the `node:fs` function values into its ESM
 * facade the first time anything does `import … from "node:fs"`. Patch AFTER
 * that and `import { writeFileSync } from "node:fs"` keeps the unguarded
 * original — the guard silently does nothing (found the hard way). So this file
 * patches through `require("node:fs")` FIRST, before a single static import,
 * and only then loads the rest dynamically.
 *
 * Loaded via bunfig.toml `[test] preload`.
 */

const fs = require("node:fs") as Record<string, unknown>;

/** Functions whose FIRST argument is the path being written. */
const SINGLE_PATH_WRITES = [
  "writeFileSync",
  "appendFileSync",
  "mkdirSync",
  "rmSync",
  "rmdirSync",
  "unlinkSync",
  "truncateSync",
  "createWriteStream",
  "chmodSync",
  "utimesSync",
];

/** Functions where BOTH of the first two arguments are paths. */
const TWO_PATH_WRITES = ["renameSync", "copyFileSync", "cpSync", "linkSync", "symlinkSync"];

/** Filled in after the dynamic import below; the wrappers only read it later. */
let guard: { assertNotLiveRunWrite(file: unknown, op?: string): void } | null = null;

function check(paths: unknown[], op: string): void {
  if (!guard) return; // cannot happen for a write that follows this preload
  for (const p of paths) guard.assertNotLiveRunWrite(p as string | URL | undefined, op);
}

function wrap(target: Record<string, unknown>, name: string, paths: (a: unknown[]) => unknown[]): void {
  const original = target[name];
  if (typeof original !== "function") return;
  target[name] = function guarded(this: unknown, ...args: unknown[]) {
    check(paths(args), name);
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };
}

for (const name of SINGLE_PATH_WRITES) wrap(fs, name, (a) => [a[0]]);
for (const name of TWO_PATH_WRITES) wrap(fs, name, (a) => [a[0], a[1]]);

// openSync: block only the WRITING modes. Reading the live cache from a test is
// untidy but harmless; writing it is the defect.
{
  const original = fs.openSync as ((...a: unknown[]) => unknown) | undefined;
  if (typeof original === "function") {
    fs.openSync = function guarded(this: unknown, ...args: unknown[]) {
      const flags = args[1];
      const writing =
        typeof flags === "string"
          ? /[wa+]/.test(flags)
          : typeof flags === "number"
            ? (flags & 0o3) !== 0 // O_RDONLY is 0
            : false;
      if (writing) check([args[0]], "openSync");
      return original.apply(this, args);
    };
  }
}

// node:fs/promises — the async mirror, in case anything ever writes that way.
try {
  const fsp = require("node:fs/promises") as Record<string, unknown>;
  for (const name of ["writeFile", "appendFile", "mkdir", "rm", "rmdir", "unlink", "truncate", "chmod", "utimes"]) {
    wrap(fsp, name, (a) => [a[0]]);
  }
  for (const name of ["rename", "copyFile", "cp", "link", "symlink"]) {
    wrap(fsp, name, (a) => [a[0], a[1]]);
  }
} catch {
  /* no fs/promises — nothing to guard */
}

// Only now may the ESM side load (it imports node:fs, which must already be patched).
const { afterAll } = await import("bun:test");
const runDirModule = await import("../../src/server/run-dir");
guard = { assertNotLiveRunWrite: runDirModule.assertNotLiveRunWrite };

const { LIVE_RUN_DIR, isTestRun, liveRunViolations } = runDirModule;

// The preload is the first thing a test run loads, so this is the earliest
// possible assertion that the detection works at all. A silent no-op here would
// be worse than a loud failure: it would leave the guard inert.
if (!isTestRun()) {
  throw new Error(
    `[eaw] test preload loaded but isTestRun() is false — the live-run guard would be inert. ` +
      `Refusing to run: a test could then write into ${LIVE_RUN_DIR}.`,
  );
}

/**
 * THE LOUD FAILURE. One afterAll registered from the preload runs once, after
 * the last test file, so this covers the WHOLE suite rather than one file.
 *
 * `log()`-style callers swallow write errors on purpose (logging must never
 * break the worker), so a thrown block can be invisible in a passing test. This
 * turns every recorded attempt into a failing run with the file named.
 */
afterAll(() => {
  const violations = liveRunViolations();
  if (violations.length === 0) return;
  const lines = violations.map((v) => `  • ${v.op} ${v.file} at ${v.at}`).join("\n");
  throw new Error(
    `[eaw] ${violations.length} attempt(s) to write into the LIVE alert-worker directory ` +
      `during this test run — blocked, but the leak must be fixed:\n${lines}\n` +
      `Live directory: ${LIVE_RUN_DIR}`,
  );
});
