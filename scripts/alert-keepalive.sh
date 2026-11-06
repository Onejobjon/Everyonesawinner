#!/usr/bin/env bash
# alert-keepalive.sh — supervisor for the alert worker.
#
# It keeps TWO things alive, checking every 60s:
#   1. the scan loop  (scripts/alert-loop.sh → `alerts.ts --once` hourly) — binds
#      no port at all, so it can never fight the platform's dev server for 3000;
#   2. the status host (/api/alert-status on ALERT_PORT, default 3100) — this is
#      serve-static.ts started with ALERT_WORKER_DISABLED=1, so it serves health
#      only and the scan loop stays the single source of scans.
#
# Started by scripts/ensure-alert-worker.sh, which package.json runs from
# postinstall (bun install) and predev (bun run dev) — i.e. on every platform
# start, including after a machine replacement.
#
#   setsid nohup bash scripts/alert-keepalive.sh >> .run/alerts.log 2>&1 < /dev/null &
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/.." || exit 1
mkdir -p .run
ALERT_PORT="${ALERT_PORT:-3100}"

# PID identity, not PID numbers — see scripts/pidfile.sh for the 4.5-day outage
# this fixes (a stale pidfile on a replaced machine pointed at an unrelated
# process, so every restart attempt said "already running" and exited).
# shellcheck disable=SC1091
. "$HERE/pidfile.sh"

# Single instance. A PID file alone is not enough (numbers get reused across a
# machine replacement), so the check also matches the process's own command line.
KLOCK=".run/alert-keepalive.pid"
if [ -f "$KLOCK" ]; then
  other="$(read_pidfile "$KLOCK")"
  if pid_is_ours "$other" "alert-keepalive"; then
    echo "[alert-keepalive $(date -u +%FT%TZ)] already running (pid $other) — exiting"
    exit 0
  fi
  if [ -n "$other" ]; then
    echo "[alert-keepalive $(date -u +%FT%TZ)] stale pidfile (pid $other is not this supervisor — machine replaced?) — starting anyway"
  fi
fi
write_pidfile "$KLOCK"
trap 'rm -f "$KLOCK"' EXIT

SECRETS="/home/team/shared/.secrets/telegram.env"
if [ -f "$SECRETS" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$SECRETS"
  set +a
fi
export PORT="$ALERT_PORT" ALERT_WORKER_DISABLED=1

echo "[alert-keepalive $(date -u +%FT%TZ)] supervising scan loop + status host on ${ALERT_PORT}"

ensure_status_host() {
  # "Up" means the port ANSWERS, not that the answer is 2xx. /api/alert-status
  # is owner-gated (pro-gate.ts, 2026-11-02) and correctly returns 404 to an
  # unauthenticated caller — curl -sf read that 404 as "host down" and spawned
  # a second serve-static every minute, which could not bind the port and
  # spammed .run/alerts-worker.log. Only a refused connection (000) is down.
  local code
  code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${ALERT_PORT}/api/alert-status" 2>/dev/null || echo 000)"
  if [ -n "$code" ] && [ "$code" != "000" ]; then
    return 0
  fi
  echo "[alert-keepalive $(date -u +%FT%TZ)] status host down — starting serve-static on ${ALERT_PORT}"
  PORT="$ALERT_PORT" ALERT_WORKER_DISABLED=1 \
  TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}" \
  TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}" \
  TELEGRAM_ALERTS_CHAT_ID="${TELEGRAM_ALERTS_CHAT_ID:-}" \
  TELEGRAM_ADMIN_CHAT_ID="${TELEGRAM_ADMIN_CHAT_ID:-}" \
  ODDS_API_KEY="${ODDS_API_KEY:-}" \
    setsid nohup bun serve-static.ts >> .run/alerts-worker.log 2>&1 < /dev/null &
}

ensure_scan_loop() {
  local pidfile=".run/alert-loop.pid" other=""
  if [ -f "$pidfile" ]; then
    other="$(read_pidfile "$pidfile")"
    if pid_is_ours "$other" "alert-loop"; then
      return 0
    fi
    if [ -n "$other" ]; then
      echo "[alert-keepalive $(date -u +%FT%TZ)] stale scan-loop pidfile (pid $other is not the scan loop) — restarting it"
    fi
  fi
  echo "[alert-keepalive $(date -u +%FT%TZ)] scan loop not running — starting it"
  setsid nohup bash scripts/alert-loop.sh >> .run/alerts.log 2>&1 < /dev/null &
}

# GAP ALARM — one message per stall, never a heartbeat. Runs from the supervisor
# AND from the dev-server boot hook, so a dead scan loop cannot silence it. It
# sends nothing at all while scans are landing.
check_gap_alarm() {
  bun scripts/alert-gap-alarm.ts >> .run/alerts.log 2>&1 || true
}

# DAILY HEARTBEAT — one "still alive" message a day at 09:00 Europe/London, and
# nothing else. This is the only check whose SIGNAL is its absence: the stall
# alarm above runs on this machine and cannot speak while the machine is off
# (that is the whole of the 2026-11-04 → 2026-11-06 outage), so a missing
# heartbeat is what a reader can notice without any process here being alive.
# Checked on this 60s tick because the supervisor is the one thing that always
# comes back after a machine replacement; the once-a-day guard is on disk
# (.run/heartbeat.json), so a loop restart cannot send it twice.
check_heartbeat() {
  bun scripts/alert-heartbeat.ts >> .run/alerts.log 2>&1 || true
}

while true; do
  ensure_status_host
  ensure_scan_loop
  check_gap_alarm
  check_heartbeat
  sleep 60
done
