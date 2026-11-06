import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideRestartReport,
  formatGap,
  RESTART_GAP_MIN,
  type RestartReportInput,
} from "../src/server/restart-report";
import { SCAN_INTERVAL_MIN } from "../src/lib/cadence";

/**
 * THE RESTART REPORT — silence must explain itself.
 *
 * The owner's report on 2026-11-06: "no Telegram updates, again coincides with
 * cto credits running out, no stall alerts or anything." The machine had been
 * off since about 2026-11-04 11:00. Every alarm in this repo runs on this
 * machine, so nothing said a word. This module is the answer: when the machine
 * comes back, one message says how long it was gone.
 *
 * What is proved here:
 *   1. under 45 minutes → NOTHING (a routine restart stays quiet);
 *   2. over 45 minutes → exactly ONE message, with the gap in words;
 *   3. the same gap is never announced twice (a supervisor restart loop cannot
 *      turn one outage into a stream of messages);
 *   4. the wording contains no figure the state files cannot support — every
 *      unknown is printed as "unknown"/"not recorded", never as a number;
 *   5. the wiring is real: the loop actually calls it, and the stall alarm
 *      actually leaves the last-run marker the report reads.
 */

const NOW = new Date("2026-11-06T14:40:00Z");

function input(overrides: Partial<RestartReportInput> = {}): RestartReportInput {
  return {
    now: NOW,
    lastScanAt: "2026-11-06T14:20:00Z", // 20 min ago — a routine restart
    restartAt: "2026-11-06T14:39:00Z",
    foundSinceRestart: 0,
    coverage: { sports: 19, fixtures: 102 },
    stallAlarmLastRunAt: "2026-11-06T14:38:00Z",
    reportedFor: null,
    ...overrides,
  };
}

describe("gap threshold — a routine restart says nothing", () => {
  test("the threshold is 1.5 scan cycles, so one missed cycle alone is not a gap", () => {
    expect(RESTART_GAP_MIN).toBe(Math.round(SCAN_INTERVAL_MIN * 1.5));
    expect(RESTART_GAP_MIN).toBe(45);
  });

  test("a scan 5 minutes old: silent", () => {
    const d = decideRestartReport(input({ lastScanAt: "2026-11-06T14:35:00Z" }));
    expect(d.action).toBe("none");
    if (d.action === "none") expect(d.reason).toContain("under the 45 min gap threshold");
  });

  test("a scan 44 minutes old: still silent", () => {
    const d = decideRestartReport(input({ lastScanAt: "2026-11-06T13:56:00Z" }));
    expect(d.action).toBe("none");
  });

  test("a scan 46 minutes old: ONE message", () => {
    const d = decideRestartReport(input({ lastScanAt: "2026-11-06T13:54:00Z" }));
    expect(d.action).toBe("report");
    if (d.action === "report") {
      expect(d.gapMinutes).toBe(46);
      expect(d.message).toContain("46 minutes");
    }
  });

  test("exactly 45 minutes old: the boundary speaks", () => {
    const d = decideRestartReport(input({ lastScanAt: "2026-11-06T13:55:00Z" }));
    expect(d.action).toBe("report");
  });
});

describe("the outage message", () => {
  const twoDays = decideRestartReport(
    input({
      lastScanAt: "2026-11-04T09:42:00Z", // the real outage: down ~2 days 5 hours
      restartAt: "2026-11-06T14:33:00Z",
      foundSinceRestart: 3,
    }),
  );

  test("it reports the length of the silence in words a person can read", () => {
    expect(twoDays.action).toBe("report");
    if (twoDays.action !== "report") return;
    expect(twoDays.message).toContain("2 days 4 hours");
    expect(twoDays.gapKey).toBe("2026-11-04T09:42:00.000Z");
  });

  test("it says plainly that nothing scanned and nothing alerted", () => {
    if (twoDays.action !== "report") throw new Error("expected a report");
    expect(twoDays.message).toContain("Nothing scanned and no opportunity alert went out in that time");
  });

  test("it reports what has been found since the restart and the current coverage", () => {
    if (twoDays.action !== "report") throw new Error("expected a report");
    expect(twoDays.message).toContain("Since the restart: 3 green-cash opportunities found");
    expect(twoDays.message).toContain("19 sports / 102 fixtures in the next 26 hours");
  });

  test("it names the gap's limits: a local alarm cannot fire while the machine is off", () => {
    if (twoDays.action !== "report") throw new Error("expected a report");
    expect(twoDays.message).toContain("cannot report its own death");
    expect(twoDays.message).toContain("heartbeat");
    expect(twoDays.message).toContain("A check running outside this machine would be the real fix");
  });

  test("it shows when the stall alarm itself last ran", () => {
    if (twoDays.action !== "report") throw new Error("expected a report");
    expect(twoDays.message).toContain("Stall alarm last ran: 14:38 today");
  });
});

describe("once per gap — a restart loop cannot spam the owner", () => {
  test("the same gap is announced once, then silence", () => {
    const first = decideRestartReport(
      input({ lastScanAt: "2026-11-04T09:42:00Z", restartAt: "2026-11-06T14:33:00Z" }),
    );
    expect(first.action).toBe("report");
    if (first.action !== "report") return;

    const second = decideRestartReport(
      input({
        lastScanAt: "2026-11-04T09:42:00Z",
        restartAt: "2026-11-06T14:41:00Z", // supervisor restarted the loop a minute later
        reportedFor: first.gapKey,
      }),
    );
    expect(second.action).toBe("none");
    if (second.action === "none") expect(second.reason).toContain("already been reported");
  });

  test("a NEW gap after a healthy scan gets its own message", () => {
    const d = decideRestartReport(
      input({
        lastScanAt: "2026-11-06T09:00:00Z", // a different outage, later
        reportedFor: "2026-11-04T09:42:00.000Z",
      }),
    );
    expect(d.action).toBe("report");
  });
});

describe("no figure the state files cannot support", () => {
  test("no scan on record: says unknown, does not invent a gap length", () => {
    const d = decideRestartReport(input({ lastScanAt: null, foundSinceRestart: null }));
    expect(d.action).toBe("report");
    if (d.action !== "report") return;
    expect(d.gapMinutes).toBeNull();
    expect(d.gapKey).toBe("none");
    expect(d.message).toContain("an unknown length of time");
    expect(d.message).toContain("There is no completed scan on record at all.");
    expect(d.message).toContain("opportunities found — not recorded yet");
    // …and it is still once-only for that state.
    const again = decideRestartReport(input({ lastScanAt: null, reportedFor: d.gapKey }));
    expect(again.action).toBe("none");
  });

  test("missing coverage index: 'unknown', never a made-up count", () => {
    const d = decideRestartReport(
      input({ lastScanAt: "2026-11-04T09:42:00Z", coverage: { sports: null, fixtures: null } }),
    );
    if (d.action !== "report") throw new Error("expected a report");
    expect(d.message).toContain("Coverage: unknown");
    expect(d.message).not.toMatch(/\d+ sports/);
  });

  test("missing stall-alarm timestamp: the word 'unknown', not a guess", () => {
    const d = decideRestartReport(
      input({ lastScanAt: "2026-11-04T09:42:00Z", stallAlarmLastRunAt: null }),
    );
    if (d.action !== "report") throw new Error("expected a report");
    expect(d.message).toContain("Stall alarm last ran: unknown — no record of the watchdog running.");
  });

  test("zero found since the restart is stated as zero, not as an unknown", () => {
    const d = decideRestartReport(
      input({ lastScanAt: "2026-11-04T09:42:00Z", foundSinceRestart: 0 }),
    );
    if (d.action !== "report") throw new Error("expected a report");
    expect(d.message).toContain("Since the restart: 0 green-cash opportunities found so far");
  });
});

describe("formatGap", () => {
  test("days, hours and minutes read naturally", () => {
    expect(formatGap(0.4)).toBe("under a minute");
    expect(formatGap(1)).toBe("1 minute");
    expect(formatGap(47)).toBe("47 minutes");
    expect(formatGap(60)).toBe("1 hour");
    expect(formatGap(80)).toBe("1 hour 20 minutes");
    expect(formatGap(2 * 1440 + 3 * 60)).toBe("2 days 3 hours");
    expect(formatGap(2 * 1440 + 3 * 60 + 17)).toBe("2 days 3 hours"); // minutes are noise past a day
  });
});

/**
 * THE WIRING. A pure function nobody calls is a comment. These assertions pin
 * the two call sites so a future edit cannot quietly drop them.
 */
describe("the wiring is real", () => {
  const repo = join(import.meta.dir, "..");
  const loop = readFileSync(join(repo, "scripts/alert-loop.sh"), "utf8");
  const keepalive = readFileSync(join(repo, "scripts/alert-keepalive.sh"), "utf8");
  const gapAlarm = readFileSync(join(repo, "scripts/alert-gap-alarm.ts"), "utf8");

  test("the scan loop runs the restart report after a successful tick, with its own start time", () => {
    expect(loop).toContain("RESTART_AT=");
    expect(loop).toContain("bun scripts/alert-restart-report.ts");
    expect(loop).toContain('EAW_RESTART_AT="$RESTART_AT"');
    // After the scan, not before it — the "found since restart" count must be real.
    const scanAt = loop.indexOf("bun src/server/alerts.ts --once");
    const reportAt = loop.indexOf("bun scripts/alert-restart-report.ts");
    expect(scanAt).toBeGreaterThan(-1);
    expect(reportAt).toBeGreaterThan(scanAt);
  });

  test("the stall alarm leaves the last-run marker the report reads", () => {
    expect(gapAlarm).toContain("gap-alarm-last-run.json");
    expect(gapAlarm).toContain("writeLastRun()");
  });

  test("the report only ever talks to the private DM helper", () => {
    const runner = readFileSync(join(repo, "scripts/alert-restart-report.ts"), "utf8");
    expect(runner).toContain("sendSystemMessage");
    // No direct Telegram call and no alerts-chat fallback in the runner.
    expect(runner).not.toContain("api.telegram.org");
    expect(runner).not.toContain("TELEGRAM_ALERTS_CHAT_ID");
  });
});
