#!/usr/bin/env bash
# rollback.sh — undo cutover.sh in one command, and it works when the VPS is
# unreachable.
#
#   deploy/vps/rollback.sh
#   deploy/vps/rollback.sh --no-start-if-uncertain   (strict: never risk two workers)
#
# WHAT IT DOES, in this order:
#   1. take the off switch away   (.run/alert-worker.disabled)
#   2. stop AND disable the VPS service, retrying a few times
#   3. start the platform worker again (scripts/ensure-alert-worker.sh) and verify
#      it is alive
#   4. leave a marker if the VPS could not be confirmed stopped
#
# THE UNREACHABLE-VPS CASE, decided explicitly rather than by accident:
#   If ssh fails, the VPS may be off (not scanning) or up with ssh blocked (still
#   scanning). We cannot tell. Leaving the owner with NO worker means silence,
#   which is the exact failure the move exists to remove — so by default the
#   platform worker is restored anyway, and the script:
#     · exits 2,
#     · writes .run/vps-rollback-uncertain,
#     · prints what to do when the VPS answers again (run rollback.sh again — it
#       is idempotent and will stop the VPS then).
#   The exposure is bounded: at most one extra scan's credits, and duplicate
#   Telegram messages only for trades found in that window.
#   --no-start-if-uncertain flips the default: the platform stays down rather than
#   risk a duplicate. Use it if duplicate alerts would be worse than silence.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/lib.sh"
eaw_init "$HERE"

STRICT=0
[ "${1:-}" = "--no-start-if-uncertain" ] && STRICT=1
VERIFY_SEC="${ROLLBACK_VERIFY_SEC:-300}"
UNCERTAIN_MARKER="$EAW_REPO_ROOT/.run/vps-rollback-uncertain"
RECORD="$EAW_REPO_ROOT/.run/vps-cutover.json"
mkdir -p "$EAW_REPO_ROOT/.run"
vps_ok=1

eaw_require_config

# ── 1. off switch away ─────────────────────────────────────────────────────
eaw_head "1/5 off switch"
if [ -f "$OFF_FILE" ]; then
  rm -f "$OFF_FILE"
  eaw_log "removed $OFF_FILE — this machine may run the alert worker again"
else
  eaw_log "$OFF_FILE was not present (nothing to remove)"
fi

# ── 2. stop the VPS ────────────────────────────────────────────────────────
eaw_head "2/5 stopping the VPS worker"
for attempt in 1 2 3; do
  if SSH_CONNECT_TIMEOUT=8 eaw_reachable; then
    vps_ok=0
    st="$(eaw_root "systemctl is-active $SERVICE" 2>/dev/null | tr -d '\r' | tail -1)"
    if [ "$st" = "active" ]; then
      eaw_root "systemctl stop $SERVICE" >/dev/null 2>&1 && eaw_log "VPS: $SERVICE stopped"
    else
      eaw_log "VPS: $SERVICE already $st"
    fi
    eaw_root "systemctl disable $SERVICE" >/dev/null 2>&1 && eaw_log "VPS: $SERVICE disabled (it will not start on boot)"
    st2="$(eaw_root "systemctl is-active $SERVICE" 2>/dev/null | tr -d '\r' | tail -1)"
    if [ "$st2" = "active" ]; then
      eaw_warn "the VPS still reports $SERVICE as active — retrying (${attempt}/3)"
      vps_ok=1
      sleep 3
      continue
    fi
    eaw_log "asserted: the VPS is not running $SERVICE ($st2)"
    break
  fi
  eaw_warn "VPS unreachable (attempt ${attempt}/3)"
  sleep 2
done

if [ "$vps_ok" != "0" ]; then
  printf 'VPS %s could not be confirmed stopped at %s. Run deploy/vps/rollback.sh again when it answers.\n' \
    "$VPS_HOST" "$(date -u +%FT%TZ)" > "$UNCERTAIN_MARKER"
  eaw_warn "=============================================================="
  eaw_warn " THE VPS COULD NOT BE REACHED, SO IT MAY STILL BE SCANNING."
  eaw_warn " If it is, the platform worker below would be the second one."
  eaw_warn " Marker written: $UNCERTAIN_MARKER"
  eaw_warn " When the VPS answers again: deploy/vps/rollback.sh  (idempotent)"
  eaw_warn "=============================================================="
  if [ "$STRICT" = "1" ]; then
    eaw_die "strict mode: not starting the platform worker while the VPS may be scanning"
  fi
else
  rm -f "$UNCERTAIN_MARKER"
fi

# ── 3. platform worker back ────────────────────────────────────────────────
eaw_head "3/5 restarting the platform worker"
started=""
if [ -x "$EAW_REPO_ROOT/scripts/ensure-alert-worker.sh" ] || [ -f "$EAW_REPO_ROOT/scripts/ensure-alert-worker.sh" ]; then
  bash "$EAW_REPO_ROOT/scripts/ensure-alert-worker.sh" rollback 2>&1 | sed 's/^/  /' || eaw_warn "ensure-alert-worker.sh returned non-zero"
else
  eaw_warn "scripts/ensure-alert-worker.sh not found — starting the supervisor directly"
  ( cd "$EAW_REPO_ROOT" && setsid nohup bash scripts/alert-keepalive.sh >> .run/alerts.log 2>&1 < /dev/null & )
fi

# ── 4. verify it is really up ──────────────────────────────────────────────
eaw_head "4/5 verifying"
waited=0
up=0
while [ "$waited" -lt 60 ]; do
  pids="$(eaw_platform_pids)"
  if [ -n "$pids" ]; then up=1; break; fi
  sleep 2
  waited=$((waited + 2))
done
if [ "$up" != "1" ]; then
  eaw_die "the platform worker did not come back within 60s — check $EAW_REPO_ROOT/.run/alerts.log"
fi
started="$(printf '%s\n' "$pids" | cut -f1 | xargs)"
eaw_log "platform worker is up (pid(s):$started )"
printf '%s\n' "$pids" | while IFS=$'\t' read -r p c; do eaw_log "  pid $p  $c"; done

# A scan should land quickly (the loop scans first, then sleeps). Soft check:
# it needs the odds API, so a slow vendor is not a rollback failure.
eaw_log "waiting up to ${VERIFY_SEC}s for a completed scan on this machine…"
scan_threshold="$(date +%s)"
swaited=0
scanned=0
while [ "$swaited" -lt "$VERIFY_SEC" ]; do
  mt="$(stat -c %Y "$LOCAL_RUN_DIR/alerts-last-scan.json" 2>/dev/null || echo 0)"
  if [ "${mt:-0}" -ge "$scan_threshold" ]; then scanned=1; break; fi
  sleep 10
  swaited=$((swaited + 10))
done
if [ "$scanned" = "1" ]; then
  eaw_log "a scan has landed on this machine"
else
  eaw_warn "no completed scan on this machine yet — the worker is up but the odds API may be slow"
  eaw_warn "watch $EAW_REPO_ROOT/.run/alerts.log; the loop retries every 15s on failure"
fi

# ── 5. report ──────────────────────────────────────────────────────────────
eaw_head "5/5 rollback complete"
if [ -f "$RECORD" ]; then
  printf '{ "rolledBackAt": "%s", "vpsConfirmedStopped": %s, "platformPids": "%s" }\n' \
    "$(date -u +%FT%TZ)" "$([ "$vps_ok" = "0" ] && echo true || echo false)" "$started" \
    > "$EAW_REPO_ROOT/.run/vps-rollback.json" 2>/dev/null || true
  eaw_log "record written: $EAW_REPO_ROOT/.run/vps-rollback.json"
fi
eaw_log "platform pids started:$started"
if [ "$vps_ok" = "0" ]; then
  eaw_log "VPS: $SERVICE stopped and disabled"
  eaw_log "done — this machine is the only worker again"
  exit 0
fi
eaw_log "VPS: NOT confirmed stopped (unreachable) — see the warning above"
exit 2
