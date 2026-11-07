/**
 * THE OVERLAPPING-SCAN DEFECT (2026-11-06) — and the proof it is closed.
 *
 * WHAT WAS WRONG. A scan could be started from three places: the scheduled loop
 * (`bun src/server/alerts.ts --once`), the in-process worker
 * (`startAlertWorker`), and a page open (`/api/instant-wins` →
 * `ensureScanOnOpen`). Only the page-open path took a lock, and it was a lock
 * private to that module, so a scheduled tick that fired while a page-open scan
 * was running started a SECOND scan: two `getMatches()` sweeps (odds credits
 * paid twice for the same fixtures) and two `deliver()` loops (the same green
 * alerted twice).
 *
 * WHAT IS TRUE NOW. One atomic lock, `.run/scan.lock`, taken by
 * `tryStartScan()` in src/server/scan-lock.ts — and every entry point goes
 * through it. The loser does not fetch, does not deliver, and logs exactly one
 * line containing `skipped: scan already in flight`.
 *
 * These tests cover, in order:
 *   · the lock is atomic and only one caller wins;
 *   · a fresh lock held by a live process is respected;
 *   · a DEAD holder's lock and an over-TTL lock are both abandoned (a killed
 *     scan can never wedge the worker);
 *   · two concurrent scans produce exactly ONE credit-spending fetch and ONE set
 *     of alerts — in one process, and, separately, across two real processes;
 *   · the real `runAlertCheck()` does not spend credits or write the last-scan
 *     marker when another scan holds the lock;
 *   · the page-open path and the scheduled path share that one lock.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCAN_IN_FLIGHT,
  SCAN_LOCK_NAME,
  SCAN_LOCK_TTL_MIN,
  acquireScanLock,
  pidAlive,
  readScanLock,
  releaseScanLock,
  scanLockFile,
  scanLockIsStale,
  tryStartScan,
} from "../src/server/scan-lock";
import { runAlertCheck } from "../src/server/alerts";
import { ensureScanOnOpen, lockFile as onOpenLockFile, resetScanOnOpenState } from "../src/server/scan-on-open";
import { runDir } from "../src/server/run-dir";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eaw-scan-lock-"));
  resetScanOnOpenState();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  // Never leave a lock in the shared per-run temp directory for the next test.
  rmSync(scanLockFile(runDir()), { force: true });
  resetScanOnOpenState();
});

/** How many times a phrase occurs — used to prove "exactly one line". */
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

const minutesAgo = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

describe("the scan lock itself", () => {
  test("one atomic create, one winner — the second caller is told who has it", () => {
    const first = acquireScanLock({ dir, owner: "scheduled", now: new Date() });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected the first acquire to win");

    const second = acquireScanLock({ dir, owner: "on-open", now: new Date() });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected the second acquire to lose");
    expect(second.reason).toBe(SCAN_IN_FLIGHT);
    expect(second.holder?.owner).toBe("scheduled");
    expect(second.holder?.pid).toBe(process.pid);

    // The lock file is the worker's state directory, beside its other state.
    expect(scanLockFile(dir)).toBe(join(dir, SCAN_LOCK_NAME));
    expect(readScanLock(scanLockFile(dir))?.owner).toBe("scheduled");
  });

  test("a live, fresh lock is respected; a DEAD holder's lock is abandoned", () => {
    const now = new Date();
    // A pid that cannot exist on this machine (the kernel's max is far below it).
    expect(pidAlive(999_999)).toBe(false);
    writeFileSync(scanLockFile(dir), JSON.stringify({ pid: 999_999, startedAt: now.toISOString(), owner: "scheduled" }), "utf8");
    expect(scanLockIsStale(readScanLock(scanLockFile(dir)), now)).toBe(true);

    // THE RECOVERY: the next scan takes the lock a killed scan left behind.
    const got = acquireScanLock({ dir, owner: "on-open", now });
    expect(got.ok).toBe(true);
    expect(readScanLock(scanLockFile(dir))?.owner).toBe("on-open");

    // And a lock from a live process is NOT stolen while it is inside the TTL.
    expect(acquireScanLock({ dir, owner: "scheduled", now }).ok).toBe(false);
  });

  test("a lock older than the TTL is abandoned even if its pid is still alive", () => {
    const now = new Date();
    const ttl = SCAN_LOCK_TTL_MIN;
    // 20 minutes: ~4x the slowest scan ever recorded (286 s, .run/alerts.log),
    // so a genuinely slow scan is never preempted but a wedged one always clears.
    expect(ttl).toBe(20);

    writeFileSync(
      scanLockFile(dir),
      JSON.stringify({ pid: process.pid, startedAt: minutesAgo(ttl + 1), owner: "on-open" }),
      "utf8",
    );
    expect(scanLockIsStale(readScanLock(scanLockFile(dir)), now)).toBe(true);
    expect(acquireScanLock({ dir, owner: "scheduled", now }).ok).toBe(true);

    // One minute inside the TTL the lock is still honoured.
    rmSync(scanLockFile(dir), { force: true });
    writeFileSync(
      scanLockFile(dir),
      JSON.stringify({ pid: process.pid, startedAt: minutesAgo(ttl - 1), owner: "on-open" }),
      "utf8",
    );
    expect(acquireScanLock({ dir, owner: "scheduled", now }).ok).toBe(false);
  });

  test("an unreadable/half-written lock does not wedge the worker", () => {
    writeFileSync(scanLockFile(dir), "{not json", "utf8");
    expect(scanLockIsStale(readScanLock(scanLockFile(dir)), new Date())).toBe(true);
    expect(acquireScanLock({ dir, owner: "scheduled", now: new Date() }).ok).toBe(true);
  });

  test("releasing is owner-only — a timed-out lock taken over by another process survives", () => {
    const first = acquireScanLock({ dir, owner: "on-open", now: new Date(), pid: process.pid });
    if (!first.ok) throw new Error("expected the acquire to win");
    // Another process took over after our lock timed out.
    writeFileSync(scanLockFile(dir), JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString(), owner: "scheduled" }), "utf8");
    expect(releaseScanLock(scanLockFile(dir), process.pid)).toBe(false);
    expect(existsSync(scanLockFile(dir))).toBe(true);
    expect(readScanLock(scanLockFile(dir))?.owner).toBe("scheduled");
  });
});

describe("two concurrent scans cost one fetch and one set of alerts", () => {
  test("the second scan does not fetch, does not alert, and says so in one line", async () => {
    // The scan stands in for getMatches() + deliver(): one credit-spending fetch
    // and one set of alerts per real scan.
    let fetches = 0;
    const alerts: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const scan = async () => {
      fetches += 1;
      await gate; // hold the scan open so both callers are genuinely concurrent
      alerts.push("green: Arsenal vs Chelsea");
      return { alerted: 1 };
    };

    const lines: string[] = [];
    const log = (m: string) => lines.push(m);

    // The two entry points, exactly as production starts them.
    const scheduled = tryStartScan({ owner: "scheduled", dir, scan, log });
    const onOpen = tryStartScan({ owner: "on-open", dir, scan, log });

    await new Promise((r) => setTimeout(r, 0));
    expect(fetches).toBe(1); // ONE credit-spending fetch, not two
    expect([scheduled.started, onOpen.started].filter(Boolean)).toHaveLength(1);

    release();
    await Promise.all([scheduled.done, onOpen.done]);

    expect(fetches).toBe(1);
    expect(alerts).toEqual(["green: Arsenal vs Chelsea"]); // ONE set of alerts

    const skips = lines.filter((l) => l.includes(`skipped: ${SCAN_IN_FLIGHT}`));
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("did not fetch");
    // The lock is released when the scan finishes, so the next scan may run.
    expect(existsSync(scanLockFile(dir))).toBe(false);
  });

  test("across two real PROCESSES: one scans, one skips, one counter line", async () => {
    const counter = join(dir, "fetches.txt");
    const child = join(import.meta.dir, "fixtures", "scan-guard-child.ts");
    const env = { ...process.env, SCAN_TEST_DIR: dir, SCAN_TEST_COUNTER: counter };

    // WHY A HANDSHAKE AND NOT "start them together".
    //
    // Both processes used to be spawned at once and the test asserted that
    // `scheduled` won. Which process reaches `acquireScanLock` first is decided
    // by process start-up time, not by anything the test controls: measured on
    // this machine the loser won the boot race in 4 of 12 runs, so the assertion
    // was a coin flip (the flake, 2026-11-07). The lock itself was never at
    // fault — exactly one process scanned in every run.
    //
    // Now the holder takes the lock first and signals from INSIDE its scan; the
    // loser does not even attempt the lock until it sees that signal, and the
    // holder does not release until the loser has recorded its outcome. The
    // loser's attempt therefore falls strictly inside the holder's lock window,
    // whatever the scheduler does. See test/fixtures/scan-guard-child.ts.
    const procs = [
      { owner: "scheduled", role: "holder" },
      { owner: "on-open", role: "loser" },
    ].map(({ owner, role }) =>
      Bun.spawn(["bun", child], {
        env: { ...env, SCAN_TEST_OWNER: owner, SCAN_TEST_ROLE: role },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const out = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
    await Promise.all(procs.map((p) => p.exited));

    const results = out.join("\n");
    // The holder won because the handshake made it the only one who could, so
    // these three are deterministic rather than a race.
    expect(results).toContain("RESULT scheduled STARTED");
    expect(results).toContain("RESULT on-open SKIPPED");
    expect(results).toContain(`skipped: ${SCAN_IN_FLIGHT}`);
    expect(results).not.toContain("RESULT on-open STARTED");
    expect(results).not.toContain("handshake: "); // no deadline was hit

    // The counter is the credit spend: exactly one scan reached it, and it was
    // the holder's process — not "some process, we don't know which".
    const fetches = readFileSync(counter, "utf8").trim().split("\n").filter(Boolean);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toBe(String(procs[0].pid));
    // The lock is gone again once the holder finishes.
    expect(existsSync(scanLockFile(dir))).toBe(false);
  }, 20_000);
});

describe("the real runAlertCheck goes through the guard", () => {
  test("another scan holding the lock means no fetch, no credits line, no last-scan marker", async () => {
    // The test process's run directory is the temp one (src/server/run-dir.ts), so
    // this can never touch the live worker's state.
    const live = runDir();
    expect(live).not.toContain("/site/.run");
    const held = acquireScanLock({ dir: live, owner: "on-open", now: new Date() });
    expect(held.ok).toBe(true);

    const result = await runAlertCheck();

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain(`skipped: ${SCAN_IN_FLIGHT}`);
    expect(result.checked).toBe(0);
    expect(result.alerted).toBe(0);
    // Nothing was paid for and nothing was recorded as a completed scan.
    expect(existsSync(join(live, "credits.jsonl"))).toBe(false);
    expect(existsSync(join(live, "alerts-last-scan.json"))).toBe(false);
    // The one line is in the worker's log, where the owner looks.
    expect(readFileSync(join(live, "alerts.log"), "utf8")).toContain(`skipped: ${SCAN_IN_FLIGHT}`);
  });

  test("the page-open path takes the SAME lock as the scheduled loop", async () => {
    // A scheduled scan is in flight (another process would look exactly like this).
    const held = acquireScanLock({ dir: runDir(), owner: "scheduled", now: new Date() });
    expect(held.ok).toBe(true);

    let calls = 0;
    const r = ensureScanOnOpen({
      newestScanAt: minutesAgo(30), // stale enough that an open would normally scan
      scan: async () => {
        calls += 1;
      },
    });

    expect(r.started).toBe(false);
    expect(r.refreshing).toBe(true); // the page is told a scan is running
    expect(calls).toBe(0); // …and it did not start a second one
    // Both paths point at one lock file.
    expect(onOpenLockFile(runDir())).toBe(scanLockFile(runDir()));
  });
});

describe("the skip line is what the loop greps", () => {
  test("a skipped scan appends exactly one skip line to the worker log", async () => {
    const live = runDir();
    const logFile = join(live, "alerts.log");
    if (existsSync(logFile)) appendFileSync(logFile, "", "utf8");
    const before = existsSync(logFile) ? occurrences(readFileSync(logFile, "utf8"), `skipped: ${SCAN_IN_FLIGHT}`) : 0;

    acquireScanLock({ dir: live, owner: "on-open", now: new Date() });
    await runAlertCheck();

    const after = occurrences(readFileSync(logFile, "utf8"), `skipped: ${SCAN_IN_FLIGHT}`);
    expect(after).toBe(before + 1);
  });
});
