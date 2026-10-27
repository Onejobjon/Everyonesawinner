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
cd "$(dirname "$0")/.." || exit 1
mkdir -p .run
ALERT_PORT="${ALERT_PORT:-3100}"

# Single instance via PID file (an flock FD would be inherited by children and
# deadlock restarts — see alert-loop.sh).
KLOCK=".run/alert-keepalive.pid"
if [ -f "$KLOCK" ]; then
  other="$(cat "$KLOCK" 2>/dev/null || true)"
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
    echo "[alert-keepalive $(date -u +%FT%TZ)] already running (pid $other) — exiting"
    exit 0
  fi
fi
echo "$BASHPID" > "$KLOCK"
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
  if curl -sf -m 3 "http://127.0.0.1:${ALERT_PORT}/api/alert-status" >/dev/null 2>&1; then
    return 0
  fi
  echo "[alert-keepalive $(date -u +%FT%TZ)] status host down — starting serve-static on ${ALERT_PORT}"
  PORT="$ALERT_PORT" ALERT_WORKER_DISABLED=1 \
  TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}" \
  TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}" \
  ODDS_API_KEY="${ODDS_API_KEY:-}" \
    setsid nohup bun serve-static.ts >> .run/alerts-worker.log 2>&1 < /dev/null &
}

ensure_scan_loop() {
  local pidfile=".run/alert-loop.pid" other=""
  if [ -f "$pidfile" ]; then
    other="$(cat "$pidfile" 2>/dev/null || true)"
    if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
      return 0
    fi
  fi
  echo "[alert-keepalive $(date -u +%FT%TZ)] scan loop not running — starting it"
  setsid nohup bash scripts/alert-loop.sh >> .run/alerts.log 2>&1 < /dev/null &
}

while true; do
  ensure_status_host
  ensure_scan_loop
  sleep 60
done
