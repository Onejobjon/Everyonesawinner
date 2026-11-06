# Moving the alert worker to the owner's IONOS VPS

The alert worker runs on this platform machine, and **this machine pauses when the
platform's usage credits run out**. It was off from 2026-11-04 11:00 to 2026-11-06
14:33 and produced two days of silence with no alarm, because the stall alarm
lives on the same machine as the worker. A VPS does not pause.

This directory is the whole move: install, state migration, a shadow run, the
switch, and the way back.

```
deploy/vps/
  install.sh            run HERE → installs everything on the VPS (safe twice)
  install-remote.sh     the root half of install.sh (piped over ssh)
  sync-state.sh         copy the alert history across, refusing to overwrite newer
  dry-run.sh            start/stop/report a shadow run on the VPS (no alerts)
  dry-run-worker.sh     the shadow loop that runs on the VPS
  cutover.sh            THE SWITCH (stop here, assert, start there, verify)
  rollback.sh           the way back, in one command, even if the VPS is offline
  alarms-tick.sh        the stall alarm + daily heartbeat, run by a systemd timer
  units/                eaw-alerts.service, eaw-alarms.service, eaw-alarms.timer
  lib.sh                shared helpers (config, ssh, pid identity)
  vps.conf.example      copy to vps.conf (git-ignored) and fill in
  rehearsal/            the local rehearsal: make-sandbox.sh + rehearse.sh
```

## What moves and what does not

| Moves to the VPS | Stays where it is |
|---|---|
| `scripts/alert-loop.sh` + the whole repo it needs | the website, sign-in, checkout |
| `src/server/alerts.ts` and what it imports | the domain and Vercel |
| `.run/` state (seen list, caches, heartbeat) | the platform's dev server on :3000 |
| `odds.env`, `telegram.env` (0600) | Stripe, customer records |
| the stall alarm + daily heartbeat | |

Only the scanner moves. Nothing in the site changes.

## Before the move: what to ask the owner

Beyond the IP address and the login user, four things decide how the scripts run:

1. **Is the login user `root`, or a sudo user?** If it is not root, the user needs
   passwordless sudo. Set `SUDO="sudo -n"` in `vps.conf`; for root set `SUDO=""`.
2. **Is port 22 open from here?** (Or has the owner moved ssh to another port —
   then `VPS_PORT`.) The kit logs in with the key only (`BatchMode=yes`), so a
   password-only account will fail the preflight with a clear message.
3. **Is the box doing anything else?** If another service already runs on it, ask
   for its ports so nothing is disturbed — this kit binds **no port at all** (the
   worker never listens), so the only conflict risk is the `eaw` user name and
   `/opt/eaw`.
4. **Does the VPS have outbound access to `bun.sh` and to `api.the-odds-api.com`
   and `api.telegram.org`?** If `bun.sh` is blocked, `install.sh` pushes this
   machine's bun binary instead (automatic fallback). If Telegram or the odds API
   is blocked, the move is pointless — check before starting.

Also confirm with the owner: **the public half of the keypair** must already be in
`~/.ssh/authorized_keys` for that login user:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHLWfd7KT8VkFKhghIjLYY7kcGLpmutMZMbcgmR8kLCG eaw-agent@platform
```

And one thing the lead should decide: the website's `/api/alert-status` panel and
the Instant Wins feed read `.run/` **on the machine that scans**. After the move,
the panel on the platform shows stale data, and the Instant Wins feed only stays
live if `push.env` (below) is installed so the VPS pushes its snapshot.

## The sequence

Every command runs **from this machine**, in `/home/team/shared/site`.

```bash
# 0. once: fill in the config
cp deploy/vps/vps.conf.example deploy/vps/vps.conf && $EDITOR deploy/vps/vps.conf

# 1. install (safe to run twice — it is idempotent)
deploy/vps/install.sh
# 2. copy the alert history across
deploy/vps/sync-state.sh
# 3. shadow run: one hour, no alerts, compare with the live worker
deploy/vps/dry-run.sh start 60 900
deploy/vps/dry-run.sh report
deploy/vps/dry-run.sh stop
# 4. the switch
deploy/vps/cutover.sh
# ...and if anything looks wrong:
deploy/vps/rollback.sh
```

### What to check after each step

**After `install.sh`**
- `remote facts` prints the distro, arch, bun path and `root_login=0`. If
  `root_login` is not `0`, you are not root — check `SUDO`.
- `unit eaw-alerts.service: written`, `enabled eaw-alerts.service: enabled`.
- `secret odds.env: installed … (0600 eaw)` — never a value.
- **Good**: exit 0, `RESULT: install completed with changes`.
- Run it a second time: every line should say `unchanged` and the result should be
  `RESULT: nothing to change`. That is the idempotency check.
- `ssh <user>@<vps> 'sudo systemctl status eaw-alerts'` → `inactive (dead)`.
  It is enabled but NOT started. Nothing scans on the VPS yet.

**After `sync-state.sh`**
- Six `SYNCED` lines (or `UNCHANGED` on a re-run), `refused: 0`.
- **Good**: `alerts-seen.json` synced with its mtime preserved.
- **Bad**: `REFUSED alerts-seen.json — the VPS copy is NEWER`. That is correct
  behaviour if the VPS has scanned; it means do not push this file. Nothing is
  deleted and nothing is overwritten.
- The VPS service must be inactive, or the script refuses to run (use `--force`
  only if you are certain).

**After `dry-run.sh start` / `report`**
- `dry-run worker running on the VPS (pid N)`, `alerting is SUPPRESSED`.
- `report` shows `DRY RUN: alerting suppressed`, one `check done:` line per scan,
  and `[dry-run] WOULD ALERT …` lines.

**After `cutover.sh`**
- It prints the pids it stopped, then `asserted: no platform worker process
  remains`, then `VPS: eaw-alerts.service is active (MainPID …)`, then
  `VPS: first scan completed at …`, then
  `asserted: the platform has not scanned since its worker stopped`.
- **Good**: exit 0, `.run/vps-cutover.json` written, and a real Telegram alert
  arrives within 30 minutes.
- **Bad**: it aborts before starting the VPS (nothing lost — the off switch is in
  place and nothing restarts), or it rolls back by itself and says so.

### What "good" looks like for the dry-run comparison

The dry run is a shadow of the **live** worker: same code, same vendor API, same
fixtures, nothing sent. Compare, for the same window:

```bash
deploy/vps/dry-run.sh report                       # what the VPS would have alerted
grep -h 'check done' .run/alerts.log | tail -5     # what the live worker did alert
```

| Observation | Meaning | Do |
|---|---|---|
| Same scans, same counts, same trades | healthy | cut over |
| VPS finds **more** than the platform | the platform is dropping trades (the pause problem) | cut over — the move is the fix |
| VPS finds **fewer** / scans fail | the VPS cannot see the same fixtures (egress, geo, credits) | do **not** cut over; fix first |
| VPS logs `deliver failed` / Telegram errors | it is trying to send (it must not) | stop it, check `EAW_ALERT_DRY_RUN` |

Cost: a dry run spends real odds-API credits, one scan per interval — the same as
the live worker. One hour ≈ 2 scans. Check `.run/credits.jsonl` afterwards.

## Safety properties and how each is proven

Each one is checked by `deploy/vps/rehearsal/rehearse.sh` against a throwaway tree
with stubbed `ssh`, `rsync`, `systemctl`, `useradd`, `chown` and a fake worker —
and by `test/vps-kit.test.ts` in `bun test`.

| Property | How it is enforced | How it is proven |
|---|---|---|
| **Cutover cannot leave two workers running** | the platform pids are stopped and re-checked before `systemctl start`; the off switch is proven to work *before* anything is stopped; if the VPS does not scan within `CUTOVER_VERIFY_SEC` it rolls back by itself | the systemctl stub records `DOUBLE-WORKER-RISK` if any platform worker is alive at the instant the VPS service starts; the rehearsal asserts `PLATFORM-CLEAN` and no risk line |
| **State sync never overwrites a newer file** | mtime comparison, then refuse + report; timestamps preserved on transfer (`install -p`) so the rule keeps working | the rehearsal makes the remote copy 1 hour newer and asserts the content hash is unchanged |
| **State sync never deletes the only copy** | nothing is ever removed; a missing local file is skipped, never pushed as empty; a backup is taken before any replacement | the rehearsal removes a local file and asserts the remote copy keeps its content |
| **A second install changes nothing** | useradd only if absent; units compared before writing; enable checked first; secrets compared by hash | the rehearsal runs install twice and asserts one `useradd`, one `enable`, three units, two secrets, `RESULT: nothing to change` |
| **Secrets land 0600 and are never echoed** | piped over ssh stdin into `$REMOTE_TMP` with `umask 077`, `chmod 0600` before the move, `chown eaw`, never printed; the units use `EnvironmentFile`, not `Environment=` | the rehearsal plants canary tokens and asserts they appear in no log; `stat -c %a` must be 600 |
| **Rollback works with the VPS offline** | it removes the off switch, tries three times, and restores the platform worker anyway; it exits 2 and leaves `.run/vps-rollback-uncertain` | the rehearsal sets the ssh stub offline and asserts the platform worker is back, the marker exists, exit code 2 |
| **A rehearsal cannot write outside its own root** | `eaw_init` fences every writable path (`UNIT_DIR`, `LOCAL_RUN_DIR`, the off switch, the records, every `REMOTE_*` path, the staging dir) and each write site calls `eaw_guard_write`; `install-remote.sh` fences itself. A path that resolves outside the root — or into `/etc/systemd/system`, or through a symlink that points there — aborts with exit **90** and writes nothing | scenario 12 points `UNIT_DIR` at the real `/etc/systemd/system`, then at a symlink inside the sandbox that points there, then at `/var/lib/eaw`, and asserts exit 90 each time and that nothing appeared; `test/vps-kit.test.ts` proves the same three cases plus the "no-op in production" control |
| **One run cannot contaminate the next** | every run gets its own `mktemp` root, its own `TMPDIR`, its own pidfiles, units and config; a trap cleans up on EXIT/INT/TERM; after each scenario the harness asserts exactly the processes that scenario should leave | three consecutive runs, each in a fresh root, produce identical summaries |

**The one judgement call, stated plainly:** if the VPS is unreachable, the script
cannot tell "off" from "ssh blocked". Leaving the owner with no worker is the
failure this move exists to remove, so by default it restores the platform worker
and warns loudly, bounding the risk to one scan's credits and possible duplicate
messages. `rollback.sh --no-start-if-uncertain` prefers silence over duplicates.

## The off switch

`cutover.sh` writes `.run/alert-worker.disabled`. The check lives in
`scripts/pidfile.sh`, which `alert-loop.sh` and `alert-keepalive.sh` both source
before they can spawn anything — and the vite boot hook spawns `alert-keepalive.sh`
every 60 seconds, so without it the platform worker would come back and scan
alongside the VPS. It is in `pidfile.sh` rather than in the two loops because a
sourced file is read once at start-up: editing a shell script that is already
running in a `while true` loop can make bash re-read from a stale byte offset.
`rollback.sh` deletes the file.

## Deliberately not automated

- **The keypair**: generated by the lead, installed by hand into
  `authorized_keys`. The kit never touches `~/.ssh` on the VPS.
- **The DNS/domain**: the site does not move.
- **Rotating the Telegram token**: the same token is used on the VPS. If the
  owner wants a separate bot, that is a manual change in `telegram.env`.
- **Deleting the platform's `.run/`**: left in place on purpose, as the rollback
  path's history. Nothing on this machine is deleted by the kit.
- **The push secret**: `push.env` (`SCAN_PUSH_URLS`, `OWNER_PASSWORD`) is optional
  in `install.sh` — without it the VPS scans and alerts but does not update the
  website's feed. It is not in `/home/team/shared/.secrets/` yet.
- **`systemd` itself**: the rehearsal stubs it. The units are checked by rendering
  and comparing, not by starting them on this machine (there is no systemd here).

## Rehearsing it yourself

```bash
deploy/vps/rehearsal/rehearse.sh              # fresh mktemp root, prints the transcript
deploy/vps/rehearsal/rehearse.sh /tmp/eaw-rs  # or a named, empty directory
```

Builds a sandbox (`make-sandbox.sh`), runs thirteen scenarios and prints a
PASS/FAIL transcript with a `summary: PASS=n FAIL=n` line. It never touches the
real worker (every pid check is filtered by the process's working directory, so
the live worker on this machine cannot be killed by mistake), never calls the odds
API, and cannot write outside its own root.

**Why the root is per-run.** The first version took a fixed path and started its
fake worker with a relative command line. Two things followed from that: the
cleanup `pkill -f "<root>/repo/scripts/alert-"` never matched (the cmdline is
`bash scripts/alert-loop.sh`), and a worker left behind by an interrupted run had
its directory deleted by the next run, so `/proc/<pid>/cwd` read back as
`… (deleted)` — which the kit's own pid filter did not recognise as ours, while the
harness's counter did. Scenario 8 then saw four platform pids instead of two and
scenario 11's assertions cascaded. The fix is structural: a fresh root per run, a
trap that cleans up on failure as well as success, cwd normalisation in
`eaw_platform_pids`, and a per-scenario pid count assertion so drift cannot hide.

**What the rehearsal still cannot prove**, because this machine has no systemd and
no VPS: that `systemctl` accepts the units, that `Restart=always` really restarts
the loop, that journald captures the output, that `useradd`/`chown` work on the
real distro, that `EnvironmentFile` is read as root and never appears in
`systemctl show`, and that ssh key-only auth works against the owner's server. All
of that is checked for the first time on the real box.

