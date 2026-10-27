#!/usr/bin/env bash
# Alert worker loop — the owner's hourly opportunity scans. PORT-FREE by design:
# it never binds a socket, so it does not care that the platform dev server owns
# port 3000. Each tick is one `runAlertCheck()` in a fresh bun process, so a
# crash cannot leave the worker half-dead, and a bad scan can never wedge the
# schedule.
#
# Credentials are READ FROM FILE at start-up — they are never pasted into this
# script, the repo, or a command line:
#   /home/team/shared/.secrets/telegram.env   (0600)
# ODDS_API_KEY is taken from the environment when the owner has set it, and
# otherwise from src/server/odds-key.ts' fallback (see the log line on boot —
# it says which one is in play).
#
# Run (idempotent — a second copy exits immediately thanks to flock):
#   setsid nohup bash scripts/alert-loop.sh >> .run/alerts.log 2>&1 < /dev/null &
#
# Auto-start on machine replacement: vite.config.ts starts this loop whenever
# the platform boots the dev server (`bun run dev`), so a rebuilt machine gets
# the worker back without anyone touching a terminal.
set -u
cd "$(dirname "$0")/.."
REPO="$PWD"
SECRETS="/home/team/shared/.secrets/telegram.env"
LOG="$REPO/.run/alerts.log"
INTERVAL="${ALERT_INTERVAL_SEC:-3600}"   # hourly while all is well
RETRY_FAST="${ALERT_RETRY_SEC:-15}"      # quick retry when a tick crashes
mkdir -p .run

# Single instance via PID file (NOT flock): an flock FD would be inherited by
# the `bun` scan child, so killing the shell would leave the lock held and every
# restart would exit "already running" — a real deadlock we hit on 2026-10-27.
# A PID file has no inheritance problem: when the shell dies the PID is reused
# or dead, and `kill -0` tells us so.
LOCK="$REPO/.run/alert-loop.pid"
if [ -f "$LOCK" ]; then
  other="$(cat "$LOCK" 2>/dev/null || true)"
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
    echo "[alert-loop $(date -u +%FT%TZ)] already running (pid $other) — exiting"
    exit 0
  fi
fi
echo "$BASHPID" > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

# Load the owner's Telegram credentials from the 0600 file.
if [ -f "$SECRETS" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$SECRETS"
  set +a
else
  echo "[alert-loop $(date -u +%FT%TZ)] WARNING: $SECRETS missing — alerts will not be delivered"
fi

echo "[alert-loop $(date -u +%FT%TZ)] starting (interval ${INTERVAL}s, telegram=$([ -n "${TELEGRAM_BOT_TOKEN:-}" ] && echo configured || echo MISSING), odds_key=$( [ -n "${ODDS_API_KEY:-}" ] && echo env || echo fallback-from-src ))"

while true; do
  start=$(date +%s)
  bun src/server/alerts.ts --once
  rc=$?
  took=$(( $(date +%s) - start ))
  if [ "$rc" -ne 0 ]; then
    echo "[alert-loop $(date -u +%FT%TZ)] scan exited rc=$rc after ${took}s — retrying in ${RETRY_FAST}s"
    sleep "$RETRY_FAST"
  else
    echo "[alert-loop $(date -u +%FT%TZ)] scan ok in ${took}s — next in ${INTERVAL}s"
    sleep "$INTERVAL"
  fi
done
