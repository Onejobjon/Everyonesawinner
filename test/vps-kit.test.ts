/**
 * THE VPS KIT'S SAFETY INVARIANTS — the parts that must be true before anybody
 * points deploy/vps/ at the owner's real server.
 *
 * WHY THIS FILE EXISTS: the kit's own rehearsal (deploy/vps/rehearsal/) proves the
 * *sequence* — install, sync, dry run, cutover, rollback — end to end. It does not
 * run under `bun test`, so for a while the only thing guarding the kit's rules was
 * a shell script somebody had to remember to run. Two of those rules are the ones
 * that would hurt if they broke:
 *
 *   1. the systemd units keep the worker ALIVE (Restart=always) and keep the
 *      SECRETS OUT of the unit file (EnvironmentFile, never Environment=TOKEN=…);
 *   2. the kit refuses to run without its two preconditions (a host and a login
 *      user; an ssh key that exists), rather than half-installing something;
 *   3. sync-state never overwrites a NEWER remote file (the VPS is the truth once
 *      it has scanned — that is the dedup list the owner would otherwise re-see);
 *   4. a rehearsal cannot write outside its own root. On 2026-11-06 the first
 *      rehearsal wrote three eaw-* units into this machine's REAL
 *      /etc/systemd/system. The fence in lib.sh (eaw_guard_write, exit 90) is the
 *      fix, and this file proves it fires — including for a symlink that looks
 *      like it is inside the root and is not.
 *
 * OFFLINE, ALWAYS: no ssh, no network, no systemd, no root. Every check here reads
 * a file, renders a template, or runs a shell function. The kit scripts that would
 * ssh are only ever run far enough to hit a precondition that fails BEFORE the
 * first connection attempt.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const KIT = join(REPO, "deploy", "vps");
const LIB = join(KIT, "lib.sh");
const UNITS = join(KIT, "units");
const INSTALL = join(KIT, "install.sh");
const INSTALL_REMOTE = join(KIT, "install-remote.sh");

/** The values install.sh would use on a real server. */
const REMOTE_ROOT = "/opt/eaw";
const EAW_USER = "eaw";

type Run = { code: number | null; out: string };

function run(cmd: string, args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync(cmd, args, {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Source lib.sh and run a snippet with it. Never touches the network. */
function withLib(snippet: string, env: Record<string, string> = {}): Run {
  return run("bash", ["-c", `. "${LIB}"\n${snippet}`], env);
}

/** install-remote.sh's own renderer: @EAW_ROOT@ and @EAW_USER@ → real values. */
function renderUnit(name: string): string {
  return readFileSync(join(UNITS, name), "utf8")
    .split("@EAW_ROOT@").join(REMOTE_ROOT)
    .split("@EAW_USER@").join(EAW_USER);
}

/** A throwaway directory for one test, removed afterwards. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "eaw-vps-kit-test-"));
}

// ── 1. the units keep the worker alive and the secrets out of the unit file ──

describe("systemd units", () => {
  const alerts = renderUnit("eaw-alerts.service");
  const alarms = renderUnit("eaw-alarms.service");
  const timer = renderUnit("eaw-alarms.timer");

  test("the worker unit restarts itself forever — the whole point of the move", () => {
    // The platform machine pauses when its credits run out (2026-11-04 11:00 →
    // 2026-11-06 14:33 of silence). systemd replaces alert-keepalive.sh on the
    // VPS, so Restart=always is the property that makes the move worth doing.
    expect(alerts).toMatch(/^Restart=always$/m);
    expect(alerts).toMatch(/^RestartSec=\d+$/m);
    expect(alerts).toMatch(/^Type=simple$/m);
    // A hung bun process must not survive a stop.
    expect(alerts).toMatch(/^TimeoutStopSec=\d+$/m);
    expect(alerts).toMatch(/^KillMode=(mixed|control-group)$/m);
  });

  test("the worker runs as the unprivileged account, from the repo", () => {
    expect(alerts).toMatch(/^User=eaw$/m);
    expect(alerts).toMatch(/^Group=eaw$/m);
    expect(alerts).toMatch(/^WorkingDirectory=\/opt\/eaw\/site$/m);
  });

  test("exactly one ExecStart, and it is the same scan loop the platform runs", () => {
    const starts = alerts.match(/^ExecStart=/gm) ?? [];
    expect(starts).toHaveLength(1);
    expect(alerts).toMatch(/^ExecStart=\/usr\/bin\/bash \/opt\/eaw\/site\/scripts\/alert-loop\.sh$/m);
  });

  test("secrets arrive as FILES, never inline in the unit", () => {
    expect(alerts).toMatch(/^EnvironmentFile=\/opt\/eaw\/secrets\/odds\.env$/m);
    // The optional ones carry the "-" prefix so a missing push.env cannot stop
    // the worker from starting.
    expect(alerts).toMatch(/^EnvironmentFile=-\/opt\/eaw\/secrets\/telegram\.env$/m);
    expect(alerts).toMatch(/^EnvironmentFile=-\/opt\/eaw\/secrets\/push\.env$/m);
    // Nothing that looks like a credential may be assigned a value in the unit.
    expect(alerts).not.toMatch(/^\s*Environment=.*(TOKEN|API_KEY|SECRET|PASSWORD)=/m);
    expect(alerts).not.toMatch(/TELEGRAM_BOT_TOKEN\s*=/);
    expect(alerts).not.toMatch(/ODDS_API_KEY\s*=/);
    // And the placeholders are all rendered by install-remote.sh's sed.
    expect(alerts).not.toContain("@EAW_ROOT@");
    expect(alerts).not.toContain("@EAW_USER@");
  });

  test("the alarms unit is a oneshot that does NOT depend on the worker", () => {
    // The stall alarm and the daily heartbeat are the only things that SPEAK
    // when the worker is dead, so they must not share its fate.
    expect(alarms).toMatch(/^Type=oneshot$/m);
    expect(alarms).toMatch(/^ExecStart=\/usr\/bin\/bash \/opt\/eaw\/site\/deploy\/vps\/alarms-tick\.sh$/m);
    expect(alarms).not.toMatch(/^(Requires|BindsTo|PartOf)=/m);
    expect(alarms).not.toMatch(/^\s*Environment=.*(TOKEN|API_KEY|SECRET|PASSWORD)=/m);
  });

  test("the timer fires every 60 seconds and survives a reboot", () => {
    expect(timer).toMatch(/^\[Timer\]$/m);
    expect(timer).toMatch(/^OnUnitActiveSec=60$/m);
    expect(timer).toMatch(/^OnBootSec=\d+$/m);
    expect(timer).toMatch(/^Unit=eaw-alarms\.service$/m);
    expect(timer).toMatch(/^WantedBy=timers\.target$/m);
  });

  test("the units are all installed by name, from the repo, and nothing else", () => {
    // install-remote.sh renders and installs exactly these three, and enables
    // only the worker and the timer. A fourth unit would be one nobody renders,
    // compares or enables.
    const remote = readFileSync(INSTALL_REMOTE, "utf8");
    for (const call of ['put_unit "$SERVICE"', 'put_unit "$ALARMS_SERVICE"', 'put_unit "$ALARMS_TIMER"']) {
      expect(remote).toContain(call);
    }
    expect(remote).toContain('for u in "$SERVICE" "$ALARMS_TIMER"');
    for (const name of ["eaw-alerts.service", "eaw-alarms.service", "eaw-alarms.timer"]) {
      expect(existsSync(join(UNITS, name))).toBe(true);
    }
  });
});

// ── 2. the config preconditions ─────────────────────────────────────────────

describe("config preconditions", () => {
  function confFile(dir: string, body: string): string {
    const p = join(dir, "vps.conf");
    writeFileSync(p, body);
    return p;
  }

  test("install.sh refuses to run without VPS_HOST", () => {
    const dir = scratch();
    try {
      const conf = confFile(dir, 'VPS_USER="root"\n');
      const r = run("bash", [INSTALL, "--check"], { EAW_CONF: conf, RSYNC_BIN: "/bin/true" });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("VPS_HOST is not set");
      // It must stop BEFORE trying to connect: no ssh, no network, ever.
      expect(r.out).not.toContain("checking ssh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("install.sh refuses to run without VPS_USER", () => {
    const dir = scratch();
    try {
      const conf = confFile(dir, 'VPS_HOST="203.0.113.10"\n');
      const r = run("bash", [INSTALL, "--check"], { EAW_CONF: conf, RSYNC_BIN: "/bin/true" });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("VPS_USER is not set");
      expect(r.out).not.toContain("checking ssh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("install.sh refuses without an ssh key, before it can connect", () => {
    // The precondition the owner's VPS depends on: key-only ssh, no password
    // prompt. A missing key is a hard stop, not a warning.
    const dir = scratch();
    try {
      const conf = confFile(
        dir,
        `VPS_HOST="203.0.113.10"\nVPS_USER="root"\nSSH_KEY="${join(dir, "no-such-key")}"\n`,
      );
      const r = run("bash", [INSTALL, "--check"], { EAW_CONF: conf, RSYNC_BIN: "/bin/true" });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("is missing");
      expect(r.out).not.toContain("checking ssh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the two required values are exactly what eaw_require_config asks for", () => {
    const r = withLib('eaw_require_config && echo CONFIG-OK', {
      VPS_HOST: "",
      VPS_USER: "",
      EAW_CONF: "/nonexistent/vps.conf",
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("VPS_HOST is not set");
    expect(r.out).not.toContain("CONFIG-OK");
  });
});

// ── 3. sync-state's rules, as pure functions ────────────────────────────────

describe("sync-state rules", () => {
  function refusesNewer(lmt: number | string, rmt: number | string, skew = 0): boolean {
    const r = withLib(
      `if eaw_state_refuses_newer "${lmt}" "${rmt}" "${skew}"; then echo REFUSE; else echo ALLOW; fi`,
    );
    return r.out.includes("REFUSE");
  }

  test("a NEWER remote file is refused — the VPS is the truth once it has scanned", () => {
    expect(refusesNewer(1000, 2000)).toBe(true);
    expect(refusesNewer(2000, 1000)).toBe(false);
  });

  test("equal timestamps are not 'newer' — the sync may proceed", () => {
    expect(refusesNewer(2000, 2000)).toBe(false);
  });

  test("the skew allowance is honoured (clock noise is not an outage)", () => {
    expect(refusesNewer(2000, 2005, 10)).toBe(false);
    expect(refusesNewer(2000, 2020, 10)).toBe(true);
  });

  test("a remote copy with no local counterpart is never overwritten", () => {
    // local mtime 0 = "not present here"; anything on the VPS is newer.
    expect(refusesNewer(0, 1)).toBe(true);
  });

  test("junk input cannot make the rule fire or crash", () => {
    expect(refusesNewer("", "")).toBe(false);
    expect(refusesNewer("abc", "def")).toBe(false);
    expect(refusesNewer("1000", "abc")).toBe(false);
  });

  test("identical bytes are 'unchanged', and a missing side is never identical", () => {
    const same = (l: string, r: string) =>
      withLib(`if eaw_state_same "${l}" "${r}"; then echo SAME; else echo DIFF; fi`).out.includes("SAME");
    expect(same("abc123", "abc123")).toBe(true);
    expect(same("abc123", "abc124")).toBe(false);
    // An empty remote digest means the file is not there: copy it.
    expect(same("abc123", "")).toBe(false);
    expect(same("", "abc123")).toBe(false);
  });

  test("sync-state.sh actually uses those functions", () => {
    const src = readFileSync(join(KIT, "sync-state.sh"), "utf8");
    expect(src).toContain("eaw_state_refuses_newer");
    expect(src).toContain("eaw_state_same");
  });
});

// ── 4. the sandbox fence ────────────────────────────────────────────────────

describe("the sandbox fence", () => {
  /**
   * A sandbox root with a repo directory, a units directory and a valid config
   * whose every path is inside the root. Tests then poison ONE value.
   */
  function sandbox(overrides: Record<string, string> = {}) {
    const root = scratch();
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".run"), { recursive: true });
    mkdirSync(join(root, "units"), { recursive: true });
    mkdirSync(join(root, "remote"), { recursive: true });
    mkdirSync(join(root, "secrets"), { recursive: true });
    const values: Record<string, string> = {
      VPS_HOST: "127.0.0.1",
      VPS_USER: "root",
      SSH_KEY: join(root, "fake_key"),
      UNIT_DIR: join(root, "units"),
      LOCAL_RUN_DIR: join(repo, ".run"),
      REMOTE_ROOT: join(root, "remote"),
      EAW_LEGACY_SECRETS: join(root, "legacy"),
      REMOTE_TMP: join(root, "remote", "tmp"),
      ...overrides,
    };
    const conf = join(root, "vps.conf");
    writeFileSync(
      conf,
      Object.entries(values).map(([k, v]) => `${k}="${v}"`).join("\n") + "\n",
    );
    return { root, conf };
  }

  /** eaw_init with EAW_SANDBOX set: the fence runs on every writable path. */
  function initIn(s: { root: string; conf: string }, extra: Record<string, string> = {}): Run {
    return run("bash", ["-c", `. "${LIB}"; eaw_init "${KIT}"; echo REACHED-END-OF-INIT`], {
      EAW_CONF: s.conf,
      EAW_SANDBOX: s.root,
      EAW_REPO_ROOT: join(s.root, "repo"),
      ...extra,
    });
  }

  test("a correct sandbox config passes the fence", () => {
    const s = sandbox();
    try {
      const r = initIn(s);
      expect(r.code).toBe(0);
      expect(r.out).toContain("REACHED-END-OF-INIT");
      expect(r.out).not.toContain("SANDBOX ESCAPE BLOCKED");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("UNIT_DIR=/etc/systemd/system aborts the run with exit 90", () => {
    // THE DEFECT THIS PREVENTS: the first rehearsal wrote eaw-alerts.service,
    // eaw-alarms.service and eaw-alarms.timer into the real /etc/systemd/system.
    const s = sandbox({ UNIT_DIR: "/etc/systemd/system" });
    try {
      const r = initIn(s);
      expect(r.code).toBe(90);
      expect(r.out).toContain("SANDBOX ESCAPE BLOCKED");
      expect(r.out).toContain("/etc/systemd/system");
      expect(r.out).toContain("NOTHING WAS WRITTEN");
      expect(r.out).not.toContain("REACHED-END-OF-INIT");
      // And it really did not write: no unit appeared.
      expect(existsSync("/etc/systemd/system/eaw-alerts.service")).toBe(false);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("a symlink inside the root that points at /etc is caught too", () => {
    // A prefix check would pass this. Resolution is what catches it.
    const s = sandbox();
    try {
      const link = join(s.root, "sneaky-units");
      symlinkSync("/etc/systemd/system", link);
      const s2 = sandbox({ UNIT_DIR: link });
      try {
        const r = initIn(s2);
        expect(r.code).toBe(90);
        expect(r.out).toContain("SANDBOX ESCAPE BLOCKED");
        expect(existsSync("/etc/systemd/system/eaw-alerts.service")).toBe(false);
      } finally {
        rmSync(s2.root, { recursive: true, force: true });
      }
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("a writable path outside the root (state, not units) is refused", () => {
    const s = sandbox({ LOCAL_RUN_DIR: "/var/lib/eaw" });
    try {
      const r = initIn(s);
      expect(r.code).toBe(90);
      expect(r.out).toContain("/var/lib/eaw");
      expect(existsSync("/var/lib/eaw")).toBe(false);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("a relative write path is refused rather than resolved against $PWD", () => {
    // REMOTE_DRY is derived, not configured, so it is poisoned through the env —
    // the same door a caller has. A relative path could resolve anywhere.
    const s = sandbox();
    try {
      const r = initIn(s, { REMOTE_DRY: "dry-run" });
      expect(r.code).toBe(90);
      expect(r.out).toContain("relative");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("eaw_guard_write is a NO-OP in production (no EAW_SANDBOX set)", () => {
    // On the real VPS the unit directory IS /etc/systemd/system. The fence must
    // never block a real run — it only fences a declared sandbox.
    const r = withLib(
      'eaw_guard_write /etc/systemd/system/eaw-alerts.service "install"; echo GUARD-NOOP',
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("GUARD-NOOP");
    expect(r.out).not.toContain("SANDBOX ESCAPE BLOCKED");
  });

  test("install-remote.sh carries its own fence for the half that runs as root", () => {
    // Belt and braces: the remote half writes the units, so it fences UNIT_DIR
    // itself rather than trusting the caller's config.
    const root = scratch();
    try {
      const r = run("bash", [INSTALL_REMOTE], {
        EAW_SANDBOX_ROOT: root,
        UNIT_DIR: "/etc/systemd/system",
        EAW_ROOT: join(root, "opt", "eaw"),
        EAW_LEGACY_SECRETS: join(root, "legacy"),
        REMOTE_TMP: join(root, "tmp"),
      });
      expect(r.code).toBe(90);
      expect(r.out).toContain("SANDBOX ESCAPE BLOCKED");
      expect(r.out).toContain("/etc/systemd/system");
      expect(existsSync("/etc/systemd/system/eaw-alerts.service")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("every script that writes calls the fence", () => {
    // A write site added without a guard is the defect coming back. These are
    // the scripts that create files or directories.
    for (const name of ["cutover.sh", "rollback.sh", "sync-state.sh", "dry-run.sh", "install.sh"]) {
      const src = readFileSync(join(KIT, name), "utf8");
      expect({ name, guarded: src.includes("eaw_guard_write") }).toEqual({ name, guarded: true });
    }
    const remote = readFileSync(INSTALL_REMOTE, "utf8");
    expect(remote).toContain('fence "$UNIT_DIR"');
    expect(remote).toContain("EAW_SANDBOX_ROOT");
  });
});

// ── 5. the rehearsal is isolated by construction ────────────────────────────

describe("rehearsal isolation", () => {
  const rehearse = readFileSync(join(KIT, "rehearsal", "rehearse.sh"), "utf8");
  const makeSandbox = readFileSync(join(KIT, "rehearsal", "make-sandbox.sh"), "utf8");

  test("each run gets its own root and its own scratch directory", () => {
    expect(rehearse).toContain("mktemp -d");
    expect(rehearse).toContain('export EAW_SANDBOX="$S"');
    expect(rehearse).toContain('export TMPDIR="$S/tmp"');
  });

  test("it cleans up on failure, not just on success", () => {
    // The flaky runs of 2026-11-06 were fake workers left behind by an earlier
    // run; the next run counted them and scenario 8 saw four pids, not two.
    expect(rehearse).toMatch(/trap finish EXIT INT TERM/);
    expect(rehearse).toContain("cleanup");
  });

  test("the sandbox config points every writable path inside the sandbox", () => {
    expect(makeSandbox).toContain('UNIT_DIR="$S/remote/etc/systemd/system"');
    expect(makeSandbox).toContain('REMOTE_TMP="$S/remote/tmp"');
    expect(makeSandbox).toContain('LOCAL_RUN_DIR="$S/repo/.run"');
    expect(makeSandbox).toContain('EAW_LEGACY_SECRETS="$S/legacy"');
  });

  test("it refuses to build over the repo, /etc, /usr or /home", () => {
    expect(makeSandbox).toMatch(/refusing to build a sandbox at/);
  });
});
