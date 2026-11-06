import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideHeartbeat,
  HEARTBEAT_LOCAL_HOUR,
  HEARTBEAT_MIN_GAP_HOURS,
  STALE_SCAN_MIN,
  type HeartbeatInput,
} from "../src/server/heartbeat";
import { londonHour } from "../src/lib/london-day";

/**
 * THE DAILY HEARTBEAT — the alarm whose signal is its absence.
 *
 * The 2026-11-04 → 2026-11-06 outage taught the real lesson: every alarm in this
 * repo runs on this machine, so when the machine is off there is no alarm at
 * all. A daily message at a fixed UK time turns "no message" into the alarm —
 * the reader supplies the external half, and nothing here has to be running for
 * that to work.
 *
 * What is proved here:
 *   1. 09:00 Europe/London, not 09:00 UTC and not a fixed offset — the UK moves
 *      between GMT and BST and the machine's clock is UTC all year;
 *   2. at most ONE message per London day, across loop restarts, a reboot, and a
 *      clock set backwards;
 *   3. when no scan has completed in the last hour the message still goes out —
 *      because silence must stay meaningful — but it does NOT pretend to be
 *      healthy;
 *   4. the wording contains no figure the state files cannot support.
 */

const GMT_MORNING = new Date("2026-11-07T09:00:00Z"); // 09:00 London (GMT)
const BST_MORNING = new Date("2026-06-15T08:00:00Z"); // 09:00 London (BST)

function input(overrides: Partial<HeartbeatInput> = {}): HeartbeatInput {
  return {
    now: GMT_MORNING,
    lastSentDayKey: null,
    lastSentAt: null,
    lastScanAt: "2026-11-07T08:48:00Z", // 12 min ago — healthy
    coverage: { sports: 19, fixtures: 102 },
    creditsRemaining: 19287,
    lastScanAlerted: 3,
    ...overrides,
  };
}

describe("09:00 Europe/London, and it survives the clock changing", () => {
  test("the hour is resolved through the IANA zone, so it is 09:00 in both halves of the year", () => {
    expect(HEARTBEAT_LOCAL_HOUR).toBe(9);
    expect(londonHour(GMT_MORNING)).toBe(9); // GMT: 09:00 UTC
    expect(londonHour(BST_MORNING)).toBe(9); // BST: 08:00 UTC
    // The machine is UTC all year, so a UTC hour would have been an hour late in
    // summer. These two instants differ by one hour in UTC and agree in London.
    expect(londonHour(new Date("2026-06-15T09:00:00Z"))).toBe(10);
  });

  test("winter (GMT): 08:59 London is silent, 09:00 London speaks", () => {
    const before = decideHeartbeat(input({ now: new Date("2026-11-07T08:59:00Z") }));
    expect(before.action).toBe("none");
    if (before.action === "none") expect(before.reason).toContain("goes out at 9:00");

    const at = decideHeartbeat(input({ now: GMT_MORNING }));
    expect(at.action).toBe("send");
  });

  test("summer (BST): 07:59 UTC is silent, 08:00 UTC speaks — 09:00 London either way", () => {
    const before = decideHeartbeat(
      input({ now: new Date("2026-06-15T07:59:00Z"), lastScanAt: "2026-06-15T07:50:00Z" }),
    );
    expect(before.action).toBe("none");

    const at = decideHeartbeat(
      input({ now: BST_MORNING, lastScanAt: "2026-06-15T07:50:00Z" }),
    );
    expect(at.action).toBe("send");
    if (at.action === "send") expect(at.dayKey).toBe("2026-06-15");
  });

  test("it fires late rather than never: a boot at 14:00 still owes today's message", () => {
    const d = decideHeartbeat(input({ now: new Date("2026-11-07T14:00:00Z") }));
    expect(d.action).toBe("send");
  });
});

describe("once a day, and never twice", () => {
  test("the first check of the day sends, and every later check is silent", () => {
    const first = decideHeartbeat(input());
    expect(first.action).toBe("send");
    if (first.action !== "send") return;
    expect(first.dayKey).toBe("2026-11-07");

    // The supervisor restarts the loop, or the machine reboots, ten times.
    for (let i = 1; i <= 10; i++) {
      const again = decideHeartbeat(
        input({
          now: new Date(`2026-11-07T09:${String(i).padStart(2, "0")}:00Z`),
          lastSentDayKey: first.dayKey,
          lastSentAt: GMT_MORNING.toISOString(),
        }),
      );
      expect(again.action).toBe("none");
      if (again.action === "none") expect(again.reason).toContain("already sent today");
    }
  });

  test("the next London day sends again", () => {
    const d = decideHeartbeat(
      input({
        now: new Date("2026-11-08T09:00:00Z"),
        lastSentDayKey: "2026-11-07",
        lastSentAt: "2026-11-07T09:00:00Z",
        lastScanAt: "2026-11-08T08:50:00Z",
      }),
    );
    expect(d.action).toBe("send");
    if (d.action === "send") expect(d.dayKey).toBe("2026-11-08");
  });

  test("a clock set backwards cannot buy a second message for the same period", () => {
    // Day key differs (yesterday), but only 2 hours have passed: refuse.
    const d = decideHeartbeat(
      input({
        now: new Date("2026-11-07T09:00:00Z"),
        lastSentDayKey: "2026-11-08",
        lastSentAt: "2026-11-07T07:00:00Z",
      }),
    );
    expect(d.action).toBe("none");
    if (d.action === "none") expect(d.reason).toContain("minimum spacing");
    expect(HEARTBEAT_MIN_GAP_HOURS).toBe(20);
  });

  test("a stale day key from a previous year cannot block today", () => {
    const d = decideHeartbeat(
      input({ lastSentDayKey: "2025-11-07", lastSentAt: "2025-11-07T09:00:00Z" }),
    );
    expect(d.action).toBe("send");
  });
});

describe("a stale scanner is never dressed up as health", () => {
  test("a scan 3 hours old: the message goes out, and says it is not a heartbeat", () => {
    const d = decideHeartbeat(
      input({ lastScanAt: "2026-11-07T06:00:00Z" }), // 180 min
    );
    expect(d.action).toBe("send");
    if (d.action !== "send") return;
    expect(d.healthy).toBe(false);
    expect(d.message).toContain("no heartbeat today");
    expect(d.message).toContain("not a healthy check-in");
    expect(d.message).toContain("has not completed a scan since");
    // No false comfort: no tick, no "proves the scanner is alive".
    expect(d.message).not.toContain("✅");
    expect(d.message).not.toContain("proves the scanner is alive");
  });

  test("the stale boundary is one hour — two scan cycles", () => {
    expect(STALE_SCAN_MIN).toBe(60);
    const exactly = decideHeartbeat(input({ lastScanAt: "2026-11-07T08:00:00Z" }));
    expect(exactly.action).toBe("send");
    if (exactly.action === "send") expect(exactly.healthy).toBe(true);

    const over = decideHeartbeat(input({ lastScanAt: "2026-11-07T07:59:00Z" }));
    expect(over.action).toBe("send");
    if (over.action === "send") expect(over.healthy).toBe(false);
  });

  test("no scan ever on record: says so, and does not pretend", () => {
    const d = decideHeartbeat(input({ lastScanAt: null, lastScanAlerted: null }));
    expect(d.action).toBe("send");
    if (d.action !== "send") return;
    expect(d.healthy).toBe(false);
    expect(d.message).toContain("no completed scan on record");
  });
});

describe("the healthy message", () => {
  const d = decideHeartbeat(input());

  test("it carries the four facts the owner asked for", () => {
    if (d.action !== "send") throw new Error("expected a heartbeat");
    expect(d.healthy).toBe(true);
    expect(d.message).toContain("daily heartbeat, 09:00 London");
    expect(d.message).toContain("Last scan: 12 minutes ago");
    expect(d.message).toContain("Coverage: 19 sports / 102 fixtures in the 26-hour window");
    expect(d.message).toContain("Odds credits remaining: 19287");
    expect(d.message).toContain("Last scan alerted: 3 opportunities");
  });

  test("it explains what its own absence means, including the local-alarm limit", () => {
    if (d.action !== "send") throw new Error("expected a heartbeat");
    expect(d.message).toContain("If it stops arriving, assume nothing is scanning");
    expect(d.message).toContain("cannot speak while the machine is off");
  });

  test("nothing alerted is stated as nothing, not omitted", () => {
    const none = decideHeartbeat(input({ lastScanAlerted: 0 }));
    if (none.action !== "send") throw new Error("expected a heartbeat");
    expect(none.message).toContain("Last scan alerted: nothing.");
  });
});

describe("no figure the state files cannot support", () => {
  test("unknown credits, unknown coverage and an unrecorded alert count are all said plainly", () => {
    const d = decideHeartbeat(
      input({
        coverage: { sports: null, fixtures: null },
        creditsRemaining: null,
        lastScanAlerted: null,
      }),
    );
    if (d.action !== "send") throw new Error("expected a heartbeat");
    expect(d.message).toContain("Odds credits remaining: unknown");
    expect(d.message).toContain("Coverage: unknown");
    expect(d.message).toContain("Last scan alerted: not recorded.");
    // No invented numbers anywhere in the message.
    expect(d.message).not.toMatch(/\b\d{4,}\b/); // no credit figure, no fixture count
    expect(d.message).not.toMatch(/\d+ sports/);
  });
});

describe("the wiring is real", () => {
  const repo = join(import.meta.dir, "..");
  const keepalive = readFileSync(join(repo, "scripts/alert-keepalive.sh"), "utf8");
  const runner = readFileSync(join(repo, "scripts/alert-heartbeat.ts"), "utf8");

  test("the supervisor's 60s loop runs the heartbeat", () => {
    expect(keepalive).toContain("check_heartbeat()");
    expect(keepalive).toContain("bun scripts/alert-heartbeat.ts");
    // …inside the loop, next to the other checks.
    const loop = keepalive.slice(keepalive.indexOf("while true; do"));
    expect(loop).toContain("check_heartbeat");
  });

  test("the runner talks to the private DM helper only", () => {
    expect(runner).toContain("sendSystemMessage");
    expect(runner).not.toContain("api.telegram.org");
    expect(runner).not.toContain("TELEGRAM_ALERTS_CHAT_ID");
  });

  test("state is written only after a confirmed delivery", () => {
    // The day key must not be recorded before sendSystemMessage() returns true,
    // or one Telegram blip would silence a whole day.
    const sendAt = runner.indexOf("await sendSystemMessage");
    const stateAt = runner.indexOf("if (sent) writeState");
    expect(sendAt).toBeGreaterThan(-1);
    expect(stateAt).toBeGreaterThan(sendAt);
  });
});
