/**
 * Cross-process half of the single-flight proof (test/scan-lock.test.ts).
 *
 * Two of these are started at the same time, but they do NOT race each other to
 * the lock — that race is what made this test flaky. Whichever process happened
 * to finish booting first won, so the test's assertion "the scheduled loop is the
 * one that scans" was a coin flip (measured: 4 failures in 12 runs, always with
 * the loser being `scheduled`). The lock itself was never the problem: exactly one
 * process scanned every single time.
 *
 * So the two children now shake hands instead:
 *
 *   holder (SCAN_TEST_ROLE=holder)
 *     1. takes the lock through the real `tryStartScan`;
 *     2. INSIDE the scan, appends its pid to the counter file (standing in for
 *        "this scan spent odds credits and sent alerts") and writes
 *        `handshake/holder-took-lock` — a marker that can only exist while the
 *        lock is held;
 *     3. stays inside the scan until the loser says it has finished, so the
 *        loser's attempt is guaranteed to fall strictly inside the lock window.
 *
 *   loser (SCAN_TEST_ROLE=loser)
 *     1. waits for `holder-took-lock` (or for the holder to finish without ever
 *        taking the lock — a broken lock, which the test must report rather than
 *        hang on);
 *     2. only then asks for the lock, and must be told to skip;
 *     3. writes `handshake/loser-done` so the holder can finish.
 *
 * Both waits are bounded by a deadline, so a real regression fails the test
 * loudly instead of hanging it.
 *
 * Run: SCAN_TEST_DIR=… SCAN_TEST_COUNTER=… SCAN_TEST_OWNER=… SCAN_TEST_ROLE=… \
 *      bun test/fixtures/scan-guard-child.ts
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryStartScan } from "../../src/server/scan-lock";

const dir = process.env.SCAN_TEST_DIR;
const counter = process.env.SCAN_TEST_COUNTER;
const owner = process.env.SCAN_TEST_OWNER || "child";
const role = process.env.SCAN_TEST_ROLE;
if (!dir || !counter) throw new Error("SCAN_TEST_DIR and SCAN_TEST_COUNTER are required");
if (role !== "holder" && role !== "loser") throw new Error("SCAN_TEST_ROLE must be holder or loser");

const handshake = join(dir, "handshake");
mkdirSync(handshake, { recursive: true });
const tookLockFile = join(handshake, "holder-took-lock");
const holderDoneFile = join(handshake, "holder-done");
const loserDoneFile = join(handshake, "loser-done");

/** Generous: the real handshake completes in milliseconds. */
const DEADLINE_MS = 6_000;
const POLL_MS = 5;

/** Wait until any of `files` exists. Returns the first one seen, or null on deadline. */
async function waitForAny(files: string[]): Promise<string | null> {
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    for (const file of files) if (existsSync(file)) return file;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (role === "holder") {
  const flight = tryStartScan({
    owner,
    dir,
    // The whole credit-spending fetch plus alert delivery happens here, with the
    // lock held. It does not return until the other process has had its attempt.
    scan: async () => {
      appendFileSync(counter, `${process.pid}\n`, "utf8");
      writeFileSync(tookLockFile, String(process.pid), "utf8");
      const seen = await waitForAny([loserDoneFile]);
      if (!seen) console.log(`[child ${owner}] handshake: no loser-done before deadline`);
      return "scanned";
    },
    log: (msg) => console.log(`[child ${owner}] ${msg}`),
  });

  await flight.done;
  writeFileSync(holderDoneFile, String(process.pid), "utf8");
  console.log(flight.started ? `RESULT ${owner} STARTED` : `RESULT ${owner} SKIPPED`);
} else {
  // Never touch the lock until the other process provably holds it.
  const signal = await waitForAny([tookLockFile, holderDoneFile]);
  if (!signal) console.log(`[child ${owner}] handshake: holder never signalled before deadline`);

  const flight = tryStartScan({
    owner,
    dir,
    // Only reachable if the lock is broken: the loser must never get here.
    scan: async () => {
      appendFileSync(counter, `${process.pid}\n`, "utf8");
      await sleep(50);
      return "scanned";
    },
    log: (msg) => console.log(`[child ${owner}] ${msg}`),
  });

  try {
    await flight.done;
  } finally {
    writeFileSync(loserDoneFile, String(process.pid), "utf8");
  }
  console.log(flight.started ? `RESULT ${owner} STARTED` : `RESULT ${owner} SKIPPED`);
}
