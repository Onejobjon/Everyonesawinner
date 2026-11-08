/**
 * ONE SCANNER, EVER — the tests behind the VPS cutover.
 *
 * The owner's complaint was that the 30-minute scans only ran when this platform
 * computer happened to be awake, so he got a Telegram message shortly after he
 * mentioned the silence and then nothing. The fix moves the scan to his IONOS
 * VPS (systemd `eaw-alerts`). That fix is only safe if the platform host really
 * stands down — otherwise two scanners double-alert the group and double-spend
 * odds credits.
 *
 * There are FOUR places that could start a scan, and they read the decision in
 * two different languages. These tests pin them to each other:
 *
 *   deploy/vps/primary.conf   ← the answer, in a file bash can read
 *   src/lib/alert-role.ts     ← the same answer, for TypeScript
 *   scripts/alert-loop.sh     ← the schedule (guarded)
 *   scripts/alert-keepalive.sh← the supervisor that restarts it (guarded)
 *   vite.config.ts            ← the dev-server boot hook (guarded)
 *
 * If someone flips one without the others, this file fails. That is the point:
 * a half-done rollback is exactly how you get two scanners.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PRIMARY_SCANNER, isPrimaryScanner, notScannerReason, thisHost } from "../src/lib/alert-role";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** What scripts/alert-role.sh says the primary scanner is. */
function confPrimary(): string {
  const conf = read("deploy/vps/primary.conf");
  const m = /^\s*PRIMARY_SCANNER\s*=\s*([A-Za-z]+)/m.exec(conf);
  return (m?.[1] ?? "").toLowerCase();
}

/** Run the bash helper the same way the loops do, and return what it prints. */
function bashPrimary(): string {
  const script = `set -u; . "${join(ROOT, "scripts/alert-role.sh")}"; eaw_primary_scanner`;
  const out = Bun.spawnSync(["bash", "-c", script], { cwd: ROOT });
  return out.stdout.toString().trim();
}

describe("the scanner is named once", () => {
  test("deploy/vps/primary.conf names exactly one host", () => {
    expect(confPrimary()).toBe("vps");
  });

  test("the TypeScript constant agrees with the file", () => {
    expect(PRIMARY_SCANNER).toBe(confPrimary() as typeof PRIMARY_SCANNER);
  });

  test("the bash helper reads the same answer out of the same file", () => {
    expect(bashPrimary()).toBe(confPrimary());
  });

  test("a host is only the scanner when its role matches", () => {
    const saved = process.env.EAW_ALERT_ROLE;
    try {
      process.env.EAW_ALERT_ROLE = "vps";
      expect(thisHost()).toBe("vps");
      expect(isPrimaryScanner()).toBe(true);

      // The platform sets nothing at all. Unset must mean "platform", so a
      // machine with no environment is still a working scanner after a rollback.
      delete process.env.EAW_ALERT_ROLE;
      expect(thisHost()).toBe("platform");
      expect(isPrimaryScanner()).toBe(false);
      expect(notScannerReason()).toContain("not the alert scanner");

      // An explicit platform role, and any typo, both stand down.
      process.env.EAW_ALERT_ROLE = "platform";
      expect(isPrimaryScanner()).toBe(false);
      process.env.EAW_ALERT_ROLE = "vpss";
      expect(isPrimaryScanner()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.EAW_ALERT_ROLE;
      else process.env.EAW_ALERT_ROLE = saved;
    }
  });
});

describe("every entry point checks it", () => {
  const guarded = [
    ["scripts/alert-loop.sh", "alert-loop"],
    ["scripts/alert-keepalive.sh", "alert-keepalive"],
  ] as const;

  for (const [file, label] of guarded) {
    test(`${file} stands down before it takes its lock`, () => {
      const src = read(file);
      // The guard must be sourced and used…
      expect(src).toContain('. "$HERE/alert-role.sh"');
      expect(src).toContain("eaw_is_primary_scanner");
      expect(src).toContain(`eaw_not_scanner_message "${label}"`);
      // …and it must exit 0, not fail: a stood-down host is healthy, not broken.
      const guardAt = src.indexOf("eaw_is_primary_scanner");
      const exitAt = src.indexOf("exit 0", guardAt);
      expect(exitAt).toBeGreaterThan(guardAt);
      // …and it must come BEFORE the pidfile lock, so a stood-down host never
      // leaves a pidfile that makes a later real start look "already running".
      const lockAt = src.indexOf("write_pidfile");
      expect(guardAt).toBeLessThan(lockAt);
    });
  }

  test("the dev-server boot hook checks it before spawning anything", () => {
    const src = read("vite.config.ts");
    expect(src).toContain('from "./src/lib/alert-role"');
    expect(src).toContain("isPrimaryScanner()");
    const guardAt = src.indexOf("if (!isPrimaryScanner())");
    expect(guardAt).toBeGreaterThan(-1);
    // The guard must return before the first spawn of the supervisor.
    const spawnAt = src.indexOf("if (spawnLoop())");
    expect(guardAt).toBeLessThan(spawnAt);
  });

  test("the systemd unit tells the VPS it is the scanner", () => {
    const unit = read("deploy/vps/units/eaw-alerts.service");
    expect(unit).toContain("Environment=EAW_ALERT_ROLE=vps");
  });
});

describe("the stood-down host says so out loud", () => {
  test("the message names both hosts and the rollback", () => {
    const script = `set -u; . "${join(ROOT, "scripts/alert-role.sh")}"; eaw_not_scanner_message "alert-loop"`;
    const out = Bun.spawnSync(["bash", "-c", script], { cwd: ROOT, env: { ...process.env, EAW_ALERT_ROLE: "platform" } });
    const text = out.stdout.toString();
    expect(text).toContain("standing down");
    expect(text).toContain('this host is "platform"');
    expect(text).toContain('the scanner is "vps"');
    expect(text).toContain("rollback.sh");
  });

  test("on the scanner's own host the message never appears", () => {
    const script = `set -u; . "${join(ROOT, "scripts/alert-role.sh")}"; if eaw_is_primary_scanner; then echo PRIMARY; else eaw_not_scanner_message "x"; fi`;
    const out = Bun.spawnSync(["bash", "-c", script], { cwd: ROOT, env: { ...process.env, EAW_ALERT_ROLE: "vps" } });
    expect(out.stdout.toString().trim()).toBe("PRIMARY");
  });
});
