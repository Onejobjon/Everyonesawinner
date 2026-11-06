#!/usr/bin/env bash
# rehearse.sh — run the whole VPS kit against a throwaway sandbox and print the
# transcript. No VPS, no root, no systemd, no network, no odds-API credits.
#
#   deploy/vps/rehearsal/rehearse.sh [sandbox-dir]
#
# Every scenario below is a safety property from the brief, checked by looking at
# real files, real pids and real exit codes — not by printing "ok".
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
S="${1:-/tmp/eaw-vps-rehearsal}"
export EAW_SANDBOX="$S"
# Short waits: the sandbox's fake worker "scans" every 2 seconds, so the real
# verification loops finish in seconds instead of minutes.
export ROLLBACK_VERIFY_SEC="${ROLLBACK_VERIFY_SEC:-20}"
export CUTOVER_VERIFY_SEC="${CUTOVER_VERIFY_SEC:-60}"
fail=0

# Live processes that belong to THIS sandbox (cwd inside it). Never a bare pgrep:
# the real platform worker is running on this machine and must not be touched.
sandbox_pids() {
  local pid cwd
  for pid in $(pgrep -f 'alert-loop|alert-keepalive' 2>/dev/null); do
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    case "$cwd" in "$S"/*) echo "$pid" ;; esac
  done
}

say()  { printf '\n\033[1m── %s\033[0m\n' "$*"; }
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; fail=1; }
assert() { local d="$1"; shift; if "$@"; then pass "$d"; else bad "$d"; fi; }

pkill -f "$S/repo/scripts/alert-" 2>/dev/null || true
sleep 1
bash "$HERE/make-sandbox.sh" "$S" >/dev/null || { echo "sandbox build failed" >&2; exit 1; }
R="$S/repo"
KIT="$R/deploy/vps"
PATH="$S/bin:$PATH"
export PATH
RUN="$R/.run"

# ── 1. install, twice ──────────────────────────────────────────────────────
say "1. install.sh — first run"
"$KIT/install.sh" > "$S/install1.log" 2>&1
rc=$?
echo "  exit=$rc"
grep -E 'user eaw|unit eaw|enabled eaw|secret |RESULT|installed' "$S/install1.log" | sed 's/^/  /'
assert "first install exits 0" [ "$rc" = "0" ]
assert "unprivileged user eaw created once" [ "$(grep -c 'useradd' "$S/sysd/calls.log")" = "1" ]
assert "three unit files installed" [ "$(ls "$S/remote/etc/systemd/system" | wc -l)" = "3" ]

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

# ── 8. the platform worker, then cutover ───────────────────────────────────
say "8. cutover.sh — the switch"
( cd "$R" && setsid nohup bash scripts/alert-keepalive.sh >> .run/alerts.log 2>&1 < /dev/null & )
sleep 2
pids_before="$(sandbox_pids | tr '\n' ' ')"
echo "  platform worker pids before cutover: $pids_before"
assert "platform worker is running (2 pids)" [ "$(echo $pids_before | wc -w)" = "2" ]

"$KIT/cutover.sh" > "$S/cutover.log" 2>&1
rc=$?
echo "  exit=$rc"
grep -E 'TERM|KILL|asserted|VPS:|record|complete' "$S/cutover.log" | sed 's/^/  /'
assert "cutover exits 0" [ "$rc" = "0" ]
assert "the platform pids are gone" [ -z "$(sandbox_pids)" ]
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
assert "the platform worker is running again" [ -n "$(sandbox_pids)" ]
assert "the off switch was removed" test ! -f "$RUN/alert-worker.disabled"
assert "an 'uncertain' marker was left for the owner" test -f "$RUN/vps-rollback-uncertain"
rm -f "$S/remote/OFFLINE"

say "10. rollback.sh — with the VPS reachable (clears the marker)"
"$KIT/rollback.sh" > "$S/rollback-online.log" 2>&1
rc=$?
echo "  exit=$rc"
grep -E 'VPS:|asserted|platform worker is up|done' "$S/rollback-online.log" | sed 's/^/  /'
assert "rollback exits 0" [ "$rc" = "0" ]
assert "the VPS service was stopped" test ! -f "$S/sysd/active/eaw-alerts.service"
assert "the VPS service was disabled" test ! -f "$S/sysd/enabled/eaw-alerts.service"
assert "the uncertain marker was cleared" test ! -f "$RUN/vps-rollback-uncertain"

# ── 11. cutover that must abort and roll back by itself ────────────────────
say "11. cutover.sh — VPS worker fails to come up: abort + auto-rollback"
PATH="$S/bin:$PATH" systemctl enable eaw-alerts.service
assert "platform worker still running before the failed cutover" [ -n "$(sandbox_pids)" ]
EAW_STUB_FAIL_START=1 "$KIT/cutover.sh" > "$S/cutover-fail.log" 2>&1
rc=$?
echo "  exit=$rc"
grep -E 'rolling back|VPS:|ABORT|platform worker is up' "$S/cutover-fail.log" | sed 's/^/  /'
assert "cutover aborts (non-zero)" [ "$rc" != "0" ]
assert "the platform worker was restored automatically" [ -n "$(sandbox_pids)" ]
assert "the VPS is not running a worker" test ! -f "$S/sysd/active/eaw-alerts.service"
assert "no double worker in the failed cutover either" \
  bash -c "! grep -q DOUBLE-WORKER-RISK '$S/sysd/calls.log'"

# ── 12. tidy up the sandbox processes ──────────────────────────────────────
pkill -f "$S/repo/scripts/alert-" 2>/dev/null || true
for pid in $(pgrep -f 'alert-loop|alert-keepalive' 2>/dev/null); do
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  case "$cwd" in "$S"/*) kill -9 "$pid" 2>/dev/null || true ;; esac
done

echo
if [ "$fail" = "0" ]; then
  printf '\033[32mALL REHEARSAL CHECKS PASSED\033[0m (sandbox: %s)\n' "$S"
else
  printf '\033[31mREHEARSAL FAILURES — see FAIL lines above\033[0m\n'
fi
exit "$fail"
