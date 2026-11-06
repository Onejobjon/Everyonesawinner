#!/usr/bin/env bash
# dry-run.sh — run the worker ON THE VPS with alerting suppressed, so its finds
# can be compared with the live worker's before anything is switched.
#
#   deploy/vps/dry-run.sh start [minutes] [interval-seconds]   (default 60 / 900)
#   deploy/vps/dry-run.sh status
#   deploy/vps/dry-run.sh report
#   deploy/vps/dry-run.sh stop
#
# The platform worker keeps running throughout. This is a shadow run: same code,
# same vendor API, same fixtures — nothing sent, nothing written to the live
# state. See dry-run-worker.sh for exactly how each side effect is suppressed.
#
# READ THE COMPARISON IN README.md ("What good looks like"). Short version: for
# each scan, the VPS's "would alert" list must match what the live worker alerted
# in the same window. The VPS finding MORE means the platform is dropping trades
# (the move is urgent). The VPS finding FEWER means the VPS is not seeing the
# same fixtures — do not cut over yet.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/lib.sh"
eaw_init "$HERE"

CMD="${1:-status}"
MINUTES="${2:-60}"
INTERVAL="${3:-900}"
eaw_require_config

remote_pid() { eaw_root "cat '$REMOTE_DRY/dry-run.pid' 2>/dev/null || true" 2>/dev/null | tr -d '\r' | tail -1; }
pid_alive() { [ -n "${1:-}" ] && eaw_root "kill -0 '$1' 2>/dev/null && echo alive || echo dead" 2>/dev/null | tr -d '\r' | tail -1 | grep -q alive; }

case "$CMD" in
start)
  eaw_head "dry run: $MINUTES minutes, scan every ${INTERVAL}s, on $VPS_HOST"
  eaw_reachable || eaw_die "VPS unreachable"

  # The VPS's real worker must be OFF: two scan loops on the VPS would double
  # credit spend and make the comparison meaningless.
  st="$(eaw_root "systemctl is-active $SERVICE" 2>/dev/null | tr -d '\r' | tail -1)"
  [ "$st" = "active" ] && eaw_die "$SERVICE is ACTIVE on the VPS — stop it first (systemctl stop $SERVICE). A dry run is a shadow of the LIVE worker, not a second worker."

  old="$(remote_pid)"
  if [ -n "$old" ] && pid_alive "$old"; then
    eaw_die "a dry run is already running on the VPS (pid $old). Use: dry-run.sh report | stop"
  fi

  eaw_root "mkdir -p '$REMOTE_DRY' && chown $EAW_USER:$EAW_USER '$REMOTE_DRY' && chmod 0700 '$REMOTE_DRY'" \
    || eaw_die "could not prepare $REMOTE_DRY"
  # Keep the previous session's findings, don't overwrite them.
  eaw_root "[ -f '$REMOTE_DRY/would-alert.jsonl' ] && mv -f '$REMOTE_DRY/would-alert.jsonl' '$REMOTE_DRY/would-alert.$(date -u +%Y%m%dT%H%M%SZ).jsonl'; true"

  inner="setsid nohup bash '$REMOTE_SITE/deploy/vps/dry-run-worker.sh' '$REMOTE_DRY' '$MINUTES' '$INTERVAL' >> '$REMOTE_DRY/dry-run.log' 2>&1 < /dev/null &"
  eaw_root "su -s /bin/bash $EAW_USER -c $(printf '%q' "$inner")" >/dev/null 2>&1 || eaw_die "could not start the dry-run worker"

  # Confirm it is really up before telling the owner anything.
  for _ in $(seq 1 15); do
    sleep 1
    p="$(remote_pid)"
    if [ -n "$p" ] && pid_alive "$p"; then
      eaw_log "dry-run worker running on the VPS (pid $p), logging to $REMOTE_DRY/dry-run.log"
      eaw_log "alerting is SUPPRESSED: clean environment (no Telegram token), scratch state dir, snapshot push off"
      eaw_log "next: deploy/vps/dry-run.sh report   (after ~15 minutes, and again after an hour)"
      exit 0
    fi
  done
  eaw_die "the dry-run worker did not come up — check $REMOTE_DRY/dry-run.log on the VPS"
  ;;

status)
  p="$(remote_pid)"
  if [ -n "$p" ] && pid_alive "$p"; then
    eaw_log "dry-run worker: RUNNING (pid $p)"
  else
    eaw_log "dry-run worker: not running"
  fi
  eaw_log "scans logged:   $(eaw_root "grep -c 'scan rc=' '$REMOTE_DRY/dry-run.log' 2>/dev/null || echo 0" 2>/dev/null | tr -d '\r' | tail -1)"
  eaw_log "would-alerts:   $(eaw_root "wc -l < '$REMOTE_DRY/would-alert.jsonl' 2>/dev/null || echo 0" 2>/dev/null | tr -d '\r' | tail -1)"
  eaw_log "last scan:      $(eaw_root "stat -c %y '$REMOTE_DRY/alerts-last-scan.json' 2>/dev/null || echo never" 2>/dev/null | tr -d '\r' | tail -1)"
  ;;

report)
  eaw_head "dry-run findings on the VPS"
  echo "— scans —"
  eaw_root "grep -h 'check done\\|scan rc=\\|DRY RUN' '$REMOTE_DRY/dry-run.log' '$REMOTE_DRY/alerts.log' 2>/dev/null | tail -40" 2>/dev/null
  echo
  echo "— what it WOULD have alerted —"
  eaw_root "grep -h 'WOULD ALERT' '$REMOTE_DRY/alerts.log' 2>/dev/null | tail -40" 2>/dev/null
  echo
  echo "— keys (one per would-be alert) —"
  eaw_root "cat '$REMOTE_DRY/would-alert.jsonl' 2>/dev/null | tail -40" 2>/dev/null
  echo
  echo "— how to compare (run these HERE, on the platform machine) —"
  echo "  grep -h 'check done' .run/alerts.log | tail -20"
  echo "  cat .run/alerts-seen.json"
  echo "  Healthy: same scans, same counts, no trade in the dry run that the live worker missed."
  ;;

stop)
  p="$(remote_pid)"
  if [ -z "$p" ]; then
    eaw_log "no dry-run pidfile on the VPS — nothing to stop"
    exit 0
  fi
  eaw_root "kill '$p' 2>/dev/null; sleep 1; kill -9 '$p' 2>/dev/null; rm -f '$REMOTE_DRY/dry-run.pid'; true"
  if pid_alive "$p"; then
    eaw_die "dry-run worker (pid $p) is still alive on the VPS"
  fi
  eaw_log "dry-run worker stopped (pid $p) — findings kept in $REMOTE_DRY/would-alert.jsonl"
  ;;

*)
  eaw_die "unknown command '$CMD' (start|status|report|stop)"
  ;;
esac
exit 0
