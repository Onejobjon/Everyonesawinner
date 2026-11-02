import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideGapAlarm, GAP_ALARM_MIN, scanStampLabel } from "../src/server/gap-alarm";

/**
 * ITEM 3 — the worker must survive a machine replacement, and a gap must
 * announce itself.
 *
 * Two things are proved here:
 *   1. the gap alarm fires ONCE per stall (not every check) and resets when a
 *      scan lands, and
 *   2. a stale pidfile — the actual reason the loop never came back on
 *      2026-10-28 — no longer blocks a restart.
 */

const NOW = new Date("2026-11-02T12:00:00Z");

describe("gap alarm — one message per stall, silence when healthy", () => {
  test("a healthy scanner says nothing", () => {
    const d = decideGapAlarm({
      now: NOW,
      lastScanAt: "2026-11-02T11:55:00Z", // 5 min ago
      uptimeMs: 3 * 60 * 60_000,
      announcedFor: null,
    });
    expect(d.action).toBe("none");
  });

  test("a machine that has only just booted is not a stall", () => {
    const d = decideGapAlarm({
      now: NOW,
      lastScanAt: null,
      uptimeMs: 4 * 60_000, // up 4 minutes
      announcedFor: null,
    });
    expect(d.action).toBe("none");
    if (d.action === "none") expect(d.reason).toContain("shorter than");
  });

  test("75+ minutes of silence fires once, and only once", () => {
    const lastScanAt = "2026-11-02T10:45:00Z"; // 75 minutes ago
    const first = decideGapAlarm({
      now: NOW,
      lastScanAt,
      uptimeMs: 3 * 60 * 60_000,
      announcedFor: null,
    });
    expect(first.action).toBe("alert");
    if (first.action !== "alert") return;
    expect(first.gapMinutes).toBe(75);
    expect(first.stallKey).toBe("2026-11-02T10:45:00.000Z");
    expect(first.message).toContain("stalled");
    expect(first.message).toContain("1 hour 15 minutes ago");
    expect(first.message).toContain("10:45 today");
    // It must not promise a stream of messages.
    expect(first.message).toContain("only message for this stall");

    // The same stall, checked again a minute later: silence.
    const second = decideGapAlarm({
      now: new Date("2026-11-02T12:01:00Z"),
      lastScanAt,
      uptimeMs: 3 * 60 * 60_000,
      announcedFor: first.stallKey,
    });
    expect(second.action).toBe("none");
    if (second.action === "none") expect(second.reason).toContain("already been announced");
  });

  test("a scan landing again clears the state, so the NEXT stall alerts", () => {
    const cleared = decideGapAlarm({
      now: NOW,
      lastScanAt: "2026-11-02T11:58:00Z", // healthy again
      uptimeMs: 3 * 60 * 60_000,
      announcedFor: "2026-11-02T10:45:00.000Z",
    });
    expect(cleared.action).toBe("clear");

    const nextStall = decideGapAlarm({
      now: new Date("2026-11-02T13:30:00Z"),
      lastScanAt: "2026-11-02T11:58:00Z", // 92 min ago
      uptimeMs: 3 * 60 * 60_000,
      announcedFor: null, // state was cleared
    });
    expect(nextStall.action).toBe("alert");
  });

  test("no scan has EVER completed — that is a stall once the machine is up", () => {
    const d = decideGapAlarm({
      now: NOW,
      lastScanAt: null,
      uptimeMs: 90 * 60_000, // up 90 minutes, nothing scanned
      announcedFor: null,
    });
    expect(d.action).toBe("alert");
    if (d.action !== "alert") return;
    expect(d.stallKey).toBe("none");
    expect(d.message).toContain("since this machine started");
  });

  test("the threshold is 75 minutes and the edges are honest", () => {
    expect(GAP_ALARM_MIN).toBe(75);
    const justUnder = decideGapAlarm({
      now: NOW,
      lastScanAt: new Date(NOW.getTime() - 74 * 60_000).toISOString(),
      uptimeMs: 3 * 60 * 60_000,
      announcedFor: null,
    });
    expect(justUnder.action).toBe("none");
    const justOver = decideGapAlarm({
      now: NOW,
      lastScanAt: new Date(NOW.getTime() - 76 * 60_000).toISOString(),
      uptimeMs: 3 * 60 * 60_000,
      announcedFor: null,
    });
    expect(justOver.action).toBe("alert");
  });

  test("the 'since' stamp uses London time and the London date", () => {
    expect(scanStampLabel("2026-11-02T11:20:00Z", NOW)).toBe("11:20 today");
    // Yesterday's scan is named by date, not just a clock time.
    expect(scanStampLabel("2026-11-01T09:05:00Z", NOW)).toContain("on Sun 1 Nov");
  });
});

describe("pidfile identity — a stale PID from a replaced machine cannot block a restart", () => {
  const repo = process.cwd();

  function pidIsOurs(pid: string, needle: string): boolean {
    const r = Bun.spawnSync([
      "bash",
      "-c",
      `. "${repo}/scripts/pidfile.sh"; pid_is_ours "$1" "$2"`,
      "--",
      pid,
      needle,
    ]);
    return r.exitCode === 0;
  }

  function readPidfile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "eaw-pid-"));
    const file = join(dir, "x.pid");
    writeFileSync(file, content, "utf8");
    try {
      const r = Bun.spawnSync([
        "bash",
        "-c",
        `. "${repo}/scripts/pidfile.sh"; read_pidfile "$1"`,
        "--",
        file,
      ]);
      return r.stdout.toString().trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a live PID belonging to a DIFFERENT process is treated as stale", () => {
    // PID 1 is always alive, and is never our supervisor. Before this fix,
    // `kill -0` alone called that "already running" and the worker never started.
    expect(pidIsOurs("1", "alert-keepalive")).toBe(false);
  });

  test("a live PID that IS our process is respected", () => {
    // The test runner's own PID: alive, and its command line contains "bun".
    expect(pidIsOurs(String(process.pid), "bun")).toBe(true);
    expect(pidIsOurs(String(process.pid), "alert-keepalive")).toBe(false);
  });

  test("a dead PID, an empty file and junk are all stale", () => {
    expect(pidIsOurs("999999", "alert-loop")).toBe(false);
    expect(pidIsOurs("", "alert-loop")).toBe(false);
    expect(pidIsOurs("not-a-pid", "alert-loop")).toBe(false);
  });

  test("pidfiles are read by first field, so old and new formats both work", () => {
    expect(readPidfile("145\n")).toBe("145");
    expect(readPidfile("203 3f2a-boot-id 2026-11-02T11:15:33Z\n")).toBe("203");
  });
});
