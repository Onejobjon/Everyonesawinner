/**
 * Cross-process half of the single-flight proof (test/scan-lock.test.ts).
 *
 * Two of these are started at the same time. Each one asks the real guard for the
 * scan lock in a shared, temporary run directory, and the winner appends its pid
 * to a counter file — standing in for "this scan spent odds credits and sent
 * alerts". The loser must not append anything and must print the skip line.
 *
 * Run: SCAN_TEST_DIR=… SCAN_TEST_COUNTER=… SCAN_TEST_OWNER=… bun test/fixtures/scan-guard-child.ts
 */
import { appendFileSync } from "node:fs";
import { tryStartScan } from "../../src/server/scan-lock";

const dir = process.env.SCAN_TEST_DIR;
const counter = process.env.SCAN_TEST_COUNTER;
const owner = process.env.SCAN_TEST_OWNER || "child";
if (!dir || !counter) throw new Error("SCAN_TEST_DIR and SCAN_TEST_COUNTER are required");

const flight = tryStartScan({
  owner,
  dir,
  // Stands in for the credit-spending fetch plus the alert delivery. It holds the
  // lock long enough that the other process is guaranteed to arrive mid-scan.
  scan: async () => {
    appendFileSync(counter, `${process.pid}\n`, "utf8");
    await new Promise((r) => setTimeout(r, 1500));
    return "scanned";
  },
  log: (msg) => console.log(`[child ${owner}] ${msg}`),
});

await flight.done;
console.log(flight.started ? `RESULT ${owner} STARTED` : `RESULT ${owner} SKIPPED`);
