#!/usr/bin/env bash
# rehearse.sh — run the whole VPS kit against a throwaway sandbox and print the
# transcript. No VPS, no root, no systemd, no network, no odds-API credits.
#
#   deploy/vps/rehearsal/rehearse.sh [sandbox-dir]
#
# ISOLATION (fixed 2026-11-06, after two non-deterministic runs):
#   · Each run gets its OWN root — a fresh mktemp directory unless one is named —
#     so no run can see another run's pidfiles, units, config or state.
#   · TMPDIR points inside that root, so every mktemp/staging file the kit makes
#     lands there too (the old harness staged /tmp/eaw-secret.* on this machine).
#   · deploy/vps/lib.sh fences every write: a path that resolves outside the root
#     aborts with exit 90. Scenario 12 proves that by trying it.
#   · A trap cleans up on EXIT/INT/TERM, so a failed or interrupted run cannot
#     leave fake workers behind for the next run to trip over.
#   · After every scenario the harness asserts the sandbox holds exactly the
#     processes that scenario is supposed to leave — no accumulation.
#
# Every check below is a safety property from the brief, checked by looking at
# real files, real pids and real exit codes — not by printing "ok".
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ -n "${1:-}" ]; then
  S="$1"
  mkdir -p "$S"
else
  S="$(mktemp -d "${TMPDIR:-/tmp}/eaw-rehearsal.XXXXXX")"
fi
S="$(cd "$S" && pwd -P)"
export EAW_SANDBOX="$S"
# The boot hook loads the owner's real Telegram file by default; point it at the
# sandbox canaries so a rehearsal never reads the live secrets.
export EAW_TELEGRAM_ENV="$S/secrets/telegram.env"
# Short waits: the sandbox's fake worker "scans" every 2 seconds, so the real
# verification loops finish in seconds instead of minutes.
export ROLLBACK_VERIFY_SEC="${ROLLBACK_VERIFY_SEC:-20}"
export CUTOVER_VERIFY_SEC="${CUTOVER_VERIFY_SEC:-60}"
fail=0
scenario="0"
PASS_COUNT=0
# /tmp is shared with everything else on this machine. Anything already there
# when we start is somebody else's; anything new afterwards is ours and is a bug.
TMP_BEFORE="$(ls /tmp/eaw-secret.* /tmp/eaw-state.* /tmp/eaw-bun.* 2>/dev/null | sort)"

# ── output ─────────────────────────────────────────────────────────────────
say()  { scenario="$1"; printf '\n\033[1m── %s\033[0m\n' "$*"; }
pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; fail=$((fail + 1)); }
assert() { local d="$1"; shift; if "$@"; then pass "$d"; else bad "$d"; fi; }

# ── process identity ───────────────────────────────────────────────────────
# Live processes that belong to THIS sandbox: the cmdline names one of the loops
# and the cwd (or the cmdline) is inside the root. Never a bare pgrep — the real
# platform worker runs on this machine and must not be touched. A cwd the kernel
# reports as "… (deleted)" still counts: that is a worker whose tree this run has
# already replaced, and leaving it alive is exactly what broke scenario 8.
sandbox_pids() {
  local pid cmd cwd
  for pid in $(pgrep -f 'alert-loop|alert-keepalive|dry-run-worker' 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    case "$cmd" in
      *alert-loop*|*alert-keepalive*|*dry-run-worker*) ;;
      *) continue ;;
    esac
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    cwd="${cwd% (deleted)}"
    case "$cwd" in
      "$S"|"$S"/*) echo "$pid"; continue ;;
    esac
    case "$cmd" in
      *"$S/"*) echo "$pid" ;;
    esac
  done
}

# expect_pids <n> <description> — wait up to 15s for exactly n sandbox processes.
expect_pids() {
  local want="$1" what="$2" i have
  for i in $(seq 1 30); do
    have="$(sandbox_pids | wc -l)"
    [ "$have" = "$want" ] && { pass "$what ($have pid(s))"; return 0; }
    sleep 0.5
  done
  have="$(sandbox_pids | tr '\n' ' ')"
  bad "$what — expected $want pid(s), found [$have]"
}

# cleanup — kill everything this run started. Safe to call twice.
cleanup() {
  local pid n=0
  for pid in $(sandbox_pids); do
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in $(sandbox_pids); do
    kill -KILL "$pid" 2>/dev/null && n=$((n + 1))
  done
  [ "$n" -gt 0 ] && printf '  (cleanup: killed %s straggler(s))\n' "$n"
  rm -f "$S/repo/.run/alert-loop.pid" "$S/repo/.run/alert-keepalive.pid" 2>/dev/null || true
  return 0
}

eaw_units_on_this_machine() { ls /etc/systemd/system 2>/dev/null | grep -E '^eaw-' || true; }

# finish — runs on EXIT/INT/TERM: cleanup, then the machine-clean assertions.
finish() {
  local rc=$?
  trap - EXIT INT TERM
  cleanup
  # An early exit must never read as green: if the run died before every
  # scenario ran, say so and fail. (This bit the first version of the rewrite:
  # a failed sandbox build still printed "ALL CHECKS PASSED".)
  if [ "$rc" != "0" ] && [ "$fail" = "0" ]; then
    bad "the rehearsal ended early (exit $rc) before every scenario ran"
  fi
  say "13. this machine is unchanged"
  expect_pids 0 "no sandbox process survives the run"
  assert "no eaw-* unit exists in the real /etc/systemd/system" \
    bash -c '[ -z "$(ls /etc/systemd/system 2>/dev/null | grep -E "^eaw-")" ]'
  assert "the real secrets directory was never written (still regular files)" \
    bash -c '[ ! -L /home/team/shared/.secrets/telegram.env ]'
  assert "no staged secret or state file was left in the real /tmp by this run" \
    [ "$(ls /tmp/eaw-secret.* /tmp/eaw-state.* /tmp/eaw-bun.* 2>/dev/null | sort)" = "$TMP_BEFORE" ]
  echo
  if [ "$fail" = "0" ]; then
    printf '\033[32mALL REHEARSAL CHECKS PASSED\033[0m\n'
  else
    printf '\033[31mREHEARSAL FAILURES — %s FAIL line(s) above\033[0m\n' "$fail"
  fi
  printf 'sandbox root: %s\n' "$S"
  printf 'summary: PASS=%s FAIL=%s\n' "$PASS_COUNT" "$fail"
  if [ "$fail" = "0" ] && [ "$rc" = "0" ]; then exit 0; else exit 1; fi
}
trap finish EXIT INT TERM

# ── 0. preflight: this machine must be clean before we start ───────────────
say "0. preflight — the sandbox root and this machine"
assert "the sandbox root is not this machine's /etc, /usr, /home or the repo" \
  bash -c "case '$S' in /|/etc|/etc/*|/usr|/usr/*|/home|/home/*|/home/team/shared/site|/home/team/shared/site/*) exit 1 ;; esac"
assert "no eaw-* unit is already present in the real /etc/systemd/system" \
  bash -c '[ -z "$(ls /etc/systemd/system 2>/dev/null | grep -E "^eaw-")" ]'
bash "$HERE/make-sandbox.sh" "$S" >/dev/null || { bad "the sandbox could not be built"; exit 1; }
# Everything the kit stages with mktemp() must land inside the root — set after
# the build, because make-sandbox insists on an empty directory.
mkdir -p "$S/tmp"
export TMPDIR="$S/tmp"
R="$S/repo"
KIT="$R/deploy/vps"
PATH="$S/bin:$PATH"
export PATH
RUN="$R/.run"
assert "a fresh sandbox was built at $S (own units, own pidfiles, own config)" test -f "$S/repo/deploy/vps/vps.conf"
assert "the sandbox config points the unit directory inside the root" \
  grep -q "^UNIT_DIR=\"$S/" "$S/repo/deploy/vps/vps.conf"

# ── 1. install, twice ──────────────────────────────────────────────────────
say "1. install.sh — first run"
"$KIT/install.sh" > "$S/install1.log" 2>&1
rc=$?
echo "  exit=$rc"
grep -E 'user eaw|unit eaw|enabled eaw|secret |RESULT|installed' "$S/install1.log" | sed 's/^/  /'
assert "first install exits 0" [ "$rc" = "0" ]
assert "unprivileged user eaw created once" [ "$(grep -c 'useradd' "$S/sysd/calls.log")" = "1" ]
assert "three unit files installed, inside the sandbox" [ "$(ls "$S/remote/etc/systemd/system" | wc -l)" = "3" ]
expect_pids 0 "install starts no worker"

say "2. install.sh — SECOND run (idempotency)"
"$KIT/install.sh" > "$S/install2.log" 2>&1
rc2=$?
echo "  exit=$rc2"
grep -E 'unchanged|RESULT' "$S/install2.log" | sed 's/^/  /'
assert "second install exits 0" [ "$rc2" = "0" ]
assert "second run reports 'nothing to change'" grep -q 'RESULT: nothing to change' "$S/install2.log"
assert "no second useradd" [ "$(grep -c 'useradd' "$S/sysd/calls.log")" = "1" ]
assert "still exactly three unit files" [ "$(ls "$S/remote/etc/systemd/system" | wc -l)" = "3" ]
assert "still exactly two secrets" [ "$(ls "$S/remote/opt/eaw/secrets" | wc -l)" = "2" ]
assert "no second enable for eaw-alerts.service" [ "$(grep -c 'systemctl enable eaw-alerts.service' "$S/sysd/calls.log")" = "1" ]

# ── 3. secrets: mode + never echoed ────────────────────────────────────────
say "3. secrets land 0600 and are never printed"
for f in odds.env telegram.env; do
  m="$(stat -c %a "$S/remote/opt/eaw/secrets/$f")"
  echo "  $f mode=$m owner=$(stat -c %U "$S/remote/opt/eaw/secrets/$f") (chown is stubbed here)"
  assert "$f is 0600" [ "$m" = "600" ]
done
assert "no secret value in any output (canary tokens absent from logs and calls.log)" \
  bash -c "! grep -rq 'CANARY-ODDS-KEY-0f3a9\|CANARY-TELEGRAM-TOKEN-77' '$S/install1.log' '$S/install2.log' '$S/sysd/calls.log'"
assert "legacy path for telegram.env is a SYMLINK, not a second copy" test -L "$S/legacy/telegram.env"
assert "the symlink points at the real secret file" \
  [ "$(readlink "$S/legacy/telegram.env")" = "$S/remote/opt/eaw/secrets/telegram.env" ]
assert "the real secrets directory was NOT touched by the rehearsal" \
  test -f /home/team/shared/.secrets/telegram.env -a ! -L /home/team/shared/.secrets/telegram.env
assert "staged uploads went to the sandbox's remote tmp, not this machine's /tmp" \
  [ "$(ls /tmp/eaw-secret.* 2>/dev/null | sort)" = "$(printf '%s\n' "$TMP_BEFORE" | grep 'eaw-secret' || true)" ]

# ── 4. state sync ──────────────────────────────────────────────────────────
say "4. sync-state.sh — first sync"
"$KIT/sync-state.sh" > "$S/sync1.log" 2>&1
rc=$?
echo "  exit=$rc"
grep -E 'SYNCED|UNCHANGED|SKIP|REFUSED|summary|synced:' "$S/sync1.log" | sed 's/^/  /'
assert "sync exits 0" [ "$rc" = "0" ]
assert "alerts-seen.json is on the VPS" test -f "$S/remote/opt/eaw/site/.run/alerts-seen.json"
assert "the seen list arrived intact" cmp -s "$RUN/alerts-seen.json" "$S/remote/opt/eaw/site/.run/alerts-seen.json"
assert "mtime preserved (rule 1 keeps working)" [ "$(stat -c %Y "$RUN/alerts-seen.json")" = "$(stat -c %Y "$S/remote/opt/eaw/site/.run/alerts-seen.json")" ]

say "5. sync-state.sh — a NEWER remote file must not be overwritten"
REMOTE_SEEN="$S/remote/opt/eaw/site/.run/alerts-seen.json"
printf '["cash|vps-own-scan|HOME|1.5|1.6"]' > "$REMOTE_SEEN"
touch -d '+1 hour' "$REMOTE_SEEN"
before="$(sha256sum "$REMOTE_SEEN" | cut -d' ' -f1)"
"$KIT/sync-state.sh" > "$S/sync2.log" 2>&1
rc=$?
echo "  exit=$rc"
grep -E 'REFUSED|ABORT' "$S/sync2.log" | sed 's/^/  /'
after="$(sha256sum "$REMOTE_SEEN" | cut -d' ' -f1)"
assert "sync refuses (non-zero exit)" [ "$rc" != "0" ]
assert "the newer remote file is untouched" [ "$before" = "$after" ]
assert "the newer remote file still exists (only copy kept)" test -f "$REMOTE_SEEN"

say "6. sync-state.sh — a file that is missing locally is skipped, not emptied"
mv "$RUN/heartbeat.json" "$S/heartbeat.parked"
printf '{"daykey":"remote-owns-this"}' > "$S/remote/opt/eaw/site/.run/heartbeat.json"
"$KIT/sync-state.sh" > "$S/sync3.log" 2>&1
grep -E 'SKIP|REFUSED' "$S/sync3.log" | sed 's/^/  /'
assert "remote heartbeat.json still has its content" grep -q 'remote-owns-this' "$S/remote/opt/eaw/site/.run/heartbeat.json"
mv "$S/heartbeat.parked" "$RUN/heartbeat.json"
# put the remote seen list back to a sane state for the cutover scenarios
cp -p "$RUN/alerts-seen.json" "$REMOTE_SEEN"
expect_pids 0 "sync starts no worker"

# ── 7. dry run ─────────────────────────────────────────────────────────────
say "7. dry-run.sh — shadow scan with alerting suppressed"
"$KIT/dry-run.sh" start 1 2 > "$S/dryrun.log" 2>&1
rc=$?
echo "  exit=$rc"
grep -E 'dry-run worker running|SUPPRESSED' "$S/dryrun.log" | sed 's/^/  /'
assert "dry run starts" [ "$rc" = "0" ]
sleep 3
"$KIT/dry-run.sh" status 2>&1 | sed 's/^/  /'
assert "the dry run wrote its own last-scan, not the live one" test -f "$S/remote/opt/eaw/dry-run/alerts-last-scan.json"
assert "the LIVE seen list was not touched by the dry run" cmp -s "$RUN/alerts-seen.json" "$REMOTE_SEEN"
"$KIT/dry-run.sh" stop 2>&1 | sed 's/^/  /'
assert "dry run stopped" test ! -f "$S/remote/opt/eaw/dry-run/dry-run.pid"
expect_pids 0 "the dry-run worker is gone"

# ── 8. the platform worker, then cutover ───────────────────────────────────
say "8. cutover.sh — the switch"
( cd "$R" && bash scripts/ensure-alert-worker.sh rehearsal >/dev/null 2>&1 )
expect_pids 2 "the boot hook started the platform worker (supervisor + scan loop)"
pids_before="$(sandbox_pids | tr '\n' ' ')"
echo "  platform worker pids before cutover: $pids_before"

"$KIT/cutover.sh" > "$S/cutover.log" 2>&1
rc=$?
echo "  exit=$rc"
grep -E 'TERM|KILL|asserted|VPS:|record|complete' "$S/cutover.log" | sed 's/^/  /'
assert "cutover exits 0" [ "$rc" = "0" ]
expect_pids 0 "the platform pids are gone"
assert "the VPS service is active" test -f "$S/sysd/active/eaw-alerts.service"
assert "the VPS has scanned since cutover" test -f "$S/remote/opt/eaw/site/.run/alerts-last-scan.json"
assert "NO DOUBLE WORKER: at the moment the VPS started, no platform worker was alive" \
  bash -c "grep -q PLATFORM-CLEAN '$S/sysd/calls.log' && ! grep -q DOUBLE-WORKER-RISK '$S/sysd/calls.log'"
assert "the off switch is in place" test -f "$RUN/alert-worker.disabled"
assert "the off switch really blocks a restart (real scripts/pidfile.sh)" \
  bash -c "cd '$R' && ! bash -c '. scripts/pidfile.sh; echo GUARD-MISSING' | grep -q GUARD-MISSING"
assert "the fake supervisor refuses to start while the switch is on" \
  bash -c "cd '$R' && timeout 5 bash scripts/alert-keepalive.sh | grep -q DISABLED"
assert "a cutover record was written" test -f "$RUN/vps-cutover.json"

# ── 9. rollback with the VPS offline ───────────────────────────────────────
say "9. rollback.sh — with the VPS UNREACHABLE"
touch "$S/remote/OFFLINE"
"$KIT/rollback.sh" > "$S/rollback-offline.log" 2>&1
rc=$?
echo "  exit=$rc (2 = rolled back locally, VPS not confirmed stopped)"
grep -E 'MAY STILL BE SCANNING|platform worker is up|NOT confirmed|removed' "$S/rollback-offline.log" | sed 's/^/  /'
assert "rollback exits 2 (VPS unconfirmed) but still works" [ "$rc" = "2" ]
expect_pids 2 "the platform worker is running again (exactly two processes)"
assert "the off switch was removed" test ! -f "$RUN/alert-worker.disabled"
assert "an 'uncertain' marker was left for the owner" test -f "$RUN/vps-rollback-uncertain"
rm -f "$S/remote/OFFLINE"

say "10. rollback.sh — with the VPS reachable (clears the marker)"
"$KIT/rollback.sh" > "$S/rollback-online.log" 2>&1
rc=$?
echo "  exit=$rc"
grep -E 'VPS:|asserted|platform worker is up|done|already running' "$S/rollback-online.log" | sed 's/^/  /'
assert "rollback exits 0" [ "$rc" = "0" ]
assert "the VPS service was stopped" test ! -f "$S/sysd/active/eaw-alerts.service"
assert "the VPS service was disabled" test ! -f "$S/sysd/enabled/eaw-alerts.service"
assert "the uncertain marker was cleared" test ! -f "$RUN/vps-rollback-uncertain"
# THE REGRESSION THAT MADE THIS REHEARSAL FLAKY: the boot hook used to read the
# whole "pid boot_id time" line into kill -0, which can never succeed, so every
# rollback launched a second supervisor. The pid count must not drift.
assert "the boot hook did NOT start a second supervisor" grep -q 'already running' "$S/rollback-online.log"
expect_pids 2 "still exactly two platform processes after the second rollback"

# ── 11. cutover that must abort and roll back by itself ────────────────────
say "11. cutover.sh — VPS worker fails to come up: abort + auto-rollback"
PATH="$S/bin:$PATH" systemctl enable eaw-alerts.service
expect_pids 2 "platform worker still running before the failed cutover"
EAW_STUB_FAIL_START=1 "$KIT/cutover.sh" > "$S/cutover-fail.log" 2>&1
rc=$?
echo "  exit=$rc"
grep -E 'rolling back|VPS:|ABORT|platform worker is up' "$S/cutover-fail.log" | sed 's/^/  /'
assert "cutover aborts (non-zero)" [ "$rc" != "0" ]
assert "the platform worker was restored automatically" [ -n "$(sandbox_pids)" ]
assert "the VPS is not running a worker" test ! -f "$S/sysd/active/eaw-alerts.service"
assert "no double worker in the failed cutover either" \
  bash -c "! grep -q DOUBLE-WORKER-RISK '$S/sysd/calls.log'"
expect_pids 2 "the platform is back to exactly two processes"

# ── 12. the fence: a write outside the root must abort ─────────────────────
say "12. the sandbox fence — a misconfigured run cannot write outside the root"
# (a) the classic: UNIT_DIR pointed at the real systemd directory
cat > "$S/poison-units.conf" <<POISON
VPS_HOST="127.0.0.1"
VPS_USER="root"
VPS_PORT="2222"
SSH_KEY="$S/fake_key"
SUDO=""
REMOTE_ROOT="$S/remote/opt/eaw"
EAW_USER="eaw"
LOCAL_SECRETS_DIR="$S/secrets"
LOCAL_RUN_DIR="$S/repo/.run"
UNIT_DIR="/etc/systemd/system"
EAW_LEGACY_SECRETS="$S/legacy"
REMOTE_TMP="$S/remote/tmp"
POISON
EAW_CONF="$S/poison-units.conf" EAW_REPO_ROOT="$R" "$KIT/install.sh" > "$S/fence-units.log" 2>&1
rc=$?
echo "  exit=$rc (90 = refused by the fence)"
grep -E 'SANDBOX ESCAPE BLOCKED|resolves to|sandbox root' "$S/fence-units.log" | sed 's/^/  /'
assert "install.sh refuses to write units outside the root (exit 90)" [ "$rc" = "90" ]
assert "the refusal names /etc/systemd/system" grep -q '/etc/systemd/system' "$S/fence-units.log"
assert "nothing was written to the real /etc/systemd/system" \
  bash -c '[ -z "$(ls /etc/systemd/system 2>/dev/null | grep -E "^eaw-")" ]'

# (b) the sneaky one: a path that LOOKS inside the root but is a symlink out
ln -sfn /etc/systemd/system "$S/sneaky-units"
sed "s|^UNIT_DIR=.*|UNIT_DIR=\"$S/sneaky-units\"|" "$S/poison-units.conf" > "$S/poison-symlink.conf"
EAW_CONF="$S/poison-symlink.conf" EAW_REPO_ROOT="$R" "$KIT/install.sh" > "$S/fence-symlink.log" 2>&1
rc=$?
echo "  exit=$rc (90 = refused by the fence)"
grep -E 'SANDBOX ESCAPE BLOCKED|resolves to' "$S/fence-symlink.log" | sed 's/^/  /'
assert "a symlink inside the root pointing at /etc is caught too (exit 90)" [ "$rc" = "90" ]
assert "still nothing in the real /etc/systemd/system" \
  bash -c '[ -z "$(ls /etc/systemd/system 2>/dev/null | grep -E "^eaw-")" ]'

# (c) a plain path outside the root, and the state directory this time
sed "s|^LOCAL_RUN_DIR=.*|LOCAL_RUN_DIR=\"/var/lib/eaw\"|; s|^UNIT_DIR=.*|UNIT_DIR=\"$S/remote/etc/systemd/system\"|" \
  "$S/poison-units.conf" > "$S/poison-state.conf"
EAW_CONF="$S/poison-state.conf" EAW_REPO_ROOT="$R" "$KIT/cutover.sh" > "$S/fence-state.log" 2>&1
rc=$?
echo "  exit=$rc (90 = refused by the fence)"
grep -E 'SANDBOX ESCAPE BLOCKED|resolves to' "$S/fence-state.log" | sed 's/^/  /'
assert "cutover.sh refuses a state path outside the root (exit 90)" [ "$rc" = "90" ]
assert "the refusal names the outside path" grep -q '/var/lib/eaw' "$S/fence-state.log"
assert "the outside state directory was never created" test ! -e /var/lib/eaw
expect_pids 2 "the fence started nothing new (scenario 11's two processes are untouched)"

# (d) the control: the same script with the sandbox config is NOT blocked
assert "the fence does not fire for a correct sandbox config" \
  bash -c "EAW_CONF='$S/repo/deploy/vps/vps.conf' EAW_REPO_ROOT='$R' bash -c '. \"$KIT/lib.sh\"; eaw_init \"$KIT\"; echo CONFIG-OK' | grep -q CONFIG-OK"

# finish() (the EXIT trap) does the cleanup, the machine-clean assertions and the
# summary. Nothing after this line.
