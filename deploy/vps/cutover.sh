#!/usr/bin/env bash
# cutover.sh — THE SWITCH. One command, one direction, no half-state.
#
#   deploy/vps/cutover.sh
#
# Order is the safety property, and it is not negotiable:
#   1. prove the VPS can take over   (service installed, enabled, idle, state synced)
#   2. put the off switch in place   (.run/alert-worker.disabled, honoured by
#                                     scripts/pidfile.sh, which the vite boot hook
#                                     and postinstall both reach)
#   3. stop the platform worker      (TERM, wait, KILL) and ASSERT the pids are gone
#   4. only then start the VPS service
#   5. assert the VPS has actually scanned, and that the platform has not
#
# If step 5 fails, the script rolls back by itself: a VPS that cannot scan must
# never be the reason the owner gets silence. That is the one failure mode this
# whole kit exists to remove (2026-11-04 → 2026-11-06).
#
# It prints the exact pids it stopped and the exact service/pid it started.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/lib.sh"
eaw_init "$HERE"

VERIFY_SEC="${CUTOVER_VERIFY_SEC:-600}"
START_EPOCH="$(date +%s)"
START_ISO="$(date -u +%FT%TZ)"
RECORD="$EAW_REPO_ROOT/.run/vps-cutover.json"
mkdir -p "$EAW_REPO_ROOT/.run"

eaw_require_config

# ── 1. preflight ───────────────────────────────────────────────────────────
eaw_head "1/6 preflight"
eaw_reachable || eaw_die "VPS unreachable ($VPS_USER@$VPS_HOST) — nothing was changed"

if ! eaw_root "systemctl is-enabled --quiet $SERVICE" >/dev/null 2>&1; then
  eaw_die "$SERVICE is not enabled on the VPS — run deploy/vps/install.sh first"
fi

st="$(eaw_root "systemctl is-active $SERVICE" 2>/dev/null | tr -d '\r' | tail -1)"
if [ "$st" = "active" ]; then
  eaw_die "$SERVICE is ALREADY ACTIVE on the VPS. If the platform worker is also
  running, that is two workers — stop one before going further:
    ssh $VPS_USER@$VPS_HOST 'sudo systemctl stop $SERVICE'"
fi
eaw_log "VPS worker: installed, enabled, not running"

# The dedup history must be there BEFORE the VPS sends anything, or the owner is
# re-alerted every trade already sent.
lseen="$LOCAL_RUN_DIR/alerts-seen.json"
if [ -f "$lseen" ]; then
  lmt="$(stat -c %Y "$lseen" 2>/dev/null || echo 0)"
  rmt="$(eaw_remote_mtime "$REMOTE_RUN/alerts-seen.json")"
  rmt="${rmt:-0}"
  if [ "$rmt" -eq 0 ]; then
    eaw_die "the VPS has no alerts-seen.json — run deploy/vps/sync-state.sh first (otherwise every past alert is re-sent)"
  fi
  if [ "$rmt" -lt "$lmt" ]; then
    eaw_die "the VPS copy of alerts-seen.json is OLDER than this machine's ($(date -u -d "@$rmt" +%FT%TZ 2>/dev/null || echo "$rmt") < $(date -u -d "@$lmt" +%FT%TZ 2>/dev/null || echo "$lmt")) — run deploy/vps/sync-state.sh first"
  fi
  eaw_log "VPS dedup history: present and not older than this machine's ($(wc -c < "$lseen") bytes local)"
else
  eaw_warn "$lseen does not exist on this machine — continuing with whatever the VPS has"
fi

# A dry run must be finished, not abandoned mid-flight.
dpid="$(eaw_root "cat '$REMOTE_DRY/dry-run.pid' 2>/dev/null || true" 2>/dev/null | tr -d '\r' | tail -1)"
if [ -n "$dpid" ] && eaw_root "kill -0 '$dpid' 2>/dev/null" >/dev/null 2>&1; then
  eaw_die "a dry run is still running on the VPS (pid $dpid) — deploy/vps/dry-run.sh stop first"
fi

before_pids="$(eaw_platform_pids)"
if [ -n "$before_pids" ]; then
  eaw_log "platform worker: running"
  printf '%s\n' "$before_pids" | while IFS=$'\t' read -r p c; do eaw_log "  pid $p  $c"; done
else
  eaw_warn "no platform worker process found under $EAW_REPO_ROOT — nothing to stop here"
fi

# ── 2. the off switch ──────────────────────────────────────────────────────
eaw_head "2/6 off switch"
printf 'Moved to the VPS %s by deploy/vps/cutover.sh. Remove this file (or run rollback.sh) to let this machine run the alert worker again.\n' "$START_ISO" > "$OFF_FILE"
eaw_log "wrote $OFF_FILE"

# Prove the switch works BEFORE stopping anything: pidfile.sh is sourced by
# alert-keepalive.sh (which the vite boot hook spawns every 60s) and by
# alert-loop.sh, so an honoured switch means neither can come back.
if bash -c "cd '$EAW_REPO_ROOT' && . scripts/pidfile.sh; echo GUARD-MISSING" 2>/dev/null | grep -q GUARD-MISSING; then
  rm -f "$OFF_FILE"
  eaw_die "scripts/pidfile.sh does NOT honour $OFF_FILE — the platform worker could come
  straight back after being stopped. Aborted with nothing stopped and nothing started."
fi
eaw_log "off switch honoured by scripts/pidfile.sh (vite boot hook + postinstall are blocked)"

# ── 3. stop the platform worker ────────────────────────────────────────────
eaw_head "3/6 stopping the platform worker"
stopped=""
for p in $(printf '%s\n' "$before_pids" | cut -f1); do
  [ -n "$p" ] || continue
  cmd="$(printf '%s\n' "$before_pids" | awk -F'\t' -v pid="$p" '$1==pid{print $2}')"
  kill -TERM "$p" 2>/dev/null && eaw_log "TERM → pid $p  ($cmd)"
  stopped="$stopped $p"
done

for _ in $(seq 1 20); do
  [ -z "$(eaw_platform_pids)" ] && break
  sleep 1
done
for p in $(printf '%s\n' "$(eaw_platform_pids)" | cut -f1); do
  [ -n "$p" ] || continue
  kill -KILL "$p" 2>/dev/null && eaw_log "KILL → pid $p (did not exit on TERM)"
done
sleep 1

# THE GATE: no platform worker may be alive when the VPS one starts.
remaining="$(eaw_platform_pids)"
if [ -n "$remaining" ]; then
  printf '%s\n' "$remaining" | while IFS=$'\t' read -r p c; do eaw_warn "  still alive: pid $p  $c"; done
  eaw_die "platform worker is STILL RUNNING — refusing to start a second worker on the VPS.
  Nothing was started on the VPS. The off switch is in place, so nothing restarts by itself.
  Re-run cutover.sh, or run rollback.sh to give the platform the job back."
fi
eaw_log "asserted: no platform worker process remains (pids stopped:$stopped )"
# The clock that matters for "the platform has not scanned": the moment its
# worker was confirmed gone. A scan that completed while we were stopping it is
# not evidence of a second worker, so allow a few seconds of grace.
STOP_EPOCH="$(date +%s)"

# ── 4. start the VPS worker ────────────────────────────────────────────────
eaw_head "4/6 starting the VPS worker"
eaw_root "systemctl start $SERVICE" || {
  eaw_warn "systemctl start $SERVICE failed on the VPS"
  eaw_warn "rolling back — the platform gets the job back"
  bash "$HERE/rollback.sh" || true
  EAW_EXIT=4 eaw_die "cutover failed: the VPS worker would not start"
}
sleep 3
st="$(eaw_root "systemctl is-active $SERVICE" 2>/dev/null | tr -d '\r' | tail -1)"
mainpid="$(eaw_root "systemctl show -p MainPID --value $SERVICE 2>/dev/null || systemctl show -p MainPID $SERVICE 2>/dev/null | cut -d= -f2" 2>/dev/null | tr -d '\r' | tail -1)"
eaw_log "VPS: $SERVICE is $st (MainPID ${mainpid:-unknown})"
if [ "$st" != "active" ]; then
  eaw_warn "the VPS service did not stay active"
  bash "$HERE/rollback.sh" || true
  EAW_EXIT=4 eaw_die "cutover failed: $SERVICE is $st"
fi

# ── 5. verify both sides ───────────────────────────────────────────────────
eaw_head "5/6 verifying (up to ${VERIFY_SEC}s for the VPS's first scan)"
scanned=0
waited=0
while [ "$waited" -lt "$VERIFY_SEC" ]; do
  mt="$(eaw_remote_mtime "$REMOTE_RUN/alerts-last-scan.json")"
  mt="${mt:-0}"
  if [ "$mt" -gt "$START_EPOCH" ]; then
    scanned=1
    break
  fi
  sleep 10
  waited=$((waited + 10))
  [ $((waited % 60)) -eq 0 ] && eaw_log "  … waiting for the VPS's first completed scan (${waited}s)"
done

if [ "$scanned" != "1" ]; then
  eaw_warn "the VPS service is up but has not completed a scan in ${VERIFY_SEC}s"
  eaw_warn "that is not good enough to leave the owner on — rolling back"
  bash "$HERE/rollback.sh" || true
  EAW_EXIT=5 eaw_die "cutover failed: no completed scan on the VPS within ${VERIFY_SEC}s"
fi
eaw_log "VPS: first scan completed at $(eaw_root "stat -c %y '$REMOTE_RUN/alerts-last-scan.json'" 2>/dev/null | tr -d '\r' | tail -1)"

# The platform must NOT have scanned since its worker was stopped.
pmt="$(stat -c %Y "$LOCAL_RUN_DIR/alerts-last-scan.json" 2>/dev/null || echo 0)"
if [ "${pmt:-0}" -gt "$((STOP_EPOCH + 5))" ]; then
  eaw_die "the PLATFORM has scanned since its worker was stopped ($(date -u -d "@$pmt" +%FT%TZ 2>/dev/null || echo "$pmt") > $(date -u -d "@$STOP_EPOCH" +%FT%TZ 2>/dev/null || echo "$STOP_EPOCH")) — something restarted it. Run rollback.sh and check $OFF_FILE."
fi
eaw_log "asserted: the platform has not scanned since its worker stopped ($(date -u -d "@${pmt:-0}" +%FT%TZ 2>/dev/null || echo never))"
if [ -n "$(eaw_platform_pids)" ]; then
  eaw_die "a platform worker process reappeared — run rollback.sh and check $OFF_FILE"
fi

# ── 6. record + report ─────────────────────────────────────────────────────
eaw_head "6/6 cutover complete"
cat > "$RECORD" <<JSON
{
  "cutoverAt": "$START_ISO",
  "vpsHost": "$VPS_HOST",
  "service": "$SERVICE",
  "mainPid": "${mainpid:-}",
  "platformPidsStopped": "$(printf '%s' "$stopped" | xargs)",
  "offSwitch": "$OFF_FILE",
  "verifiedScan": true
}
JSON
eaw_log "record written: $RECORD"
eaw_log "platform pids stopped:$stopped"
eaw_log "VPS service started: $SERVICE (MainPID ${mainpid:-unknown})"
eaw_log "off switch in place: $OFF_FILE"
eaw_log ""
eaw_log "NOW WATCH: the next scan should land within 30 minutes and a Telegram"
eaw_log "opportunity alert should arrive exactly as before. If it does not, run:"
eaw_log "  deploy/vps/rollback.sh"
exit 0
