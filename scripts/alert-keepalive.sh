#!/usr/bin/env bash
# Keep-alive supervisor for the alert loop.
#
# Why this exists: a single shell loop can be killed (OOM killer, a stray
# pkill, a machine tool tidying processes) and then nothing restarts it — which
# is exactly how the worker stayed dead on 2026-10-26/27. This wrapper re-runs
# scripts/alert-loop.sh whenever it exits, for any reason, so the only thing
# that has to survive is THIS process — and it is started at every dev-server
# boot by vite.config.ts.
#
#   setsid nohup bash scripts/alert-keepalive.sh >> .run/alerts.log 2>&1 < /dev/null &
set -u
cd "$(dirname "$0")/.."
mkdir -p .run

# Single instance via PID file (same reasoning as alert-loop.sh: an inherited
# flock FD would survive into child processes and deadlock future restarts).
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

echo "[alert-keepalive $(date -u +%FT%TZ)] supervising scripts/alert-loop.sh"
while true; do
  bash scripts/alert-loop.sh
  rc=$?
  echo "[alert-keepalive $(date -u +%FT%TZ)] alert-loop exited rc=$rc — restarting in ${ALERT_KEEPALIVE_SEC:-20}s"
  sleep "${ALERT_KEEPALIVE_SEC:-20}"
done
