#!/usr/bin/env bash
# Worker watchdog — keeps serve-static.ts (which embeds the alert worker) alive.
#
# 2026-10-27 change: the platform now runs its OWN managed dev server on port
# 3000, so the alert host must NOT fight for that port. It runs on
# ALERT_PORT (default 3100) and is health-checked there. Port 3000 belongs to
# the platform's `bun run dev`; never kill it.
#
# Secrets: the owner's Telegram token is stored at
#   /home/team/shared/.secrets/telegram.env   (0600, root)
# and is SOURCED from there instead of being pasted into commands, so it
# survives restarts and never appears in shell history or logs.
#
# Start everything with:
#   setsid nohup bash scripts/watchdog-loop.sh >> .run/watchdog-loop.log 2>&1 < /dev/null &
# or run this script once from cron every minute:
#   * * * * *  cd /home/team/shared/site && bash scripts/watchdog.sh >> .run/watchdog.log 2>&1
set -u
cd "$(dirname "$0")/.."
ALERT_PORT="${ALERT_PORT:-3100}"

# Load the Telegram credentials (and anything else the owner stored) if present.
SECRETS="/home/team/shared/.secrets/telegram.env"
if [ -f "$SECRETS" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$SECRETS"
  set +a
fi

# Healthy if the alert host answers our cheap status endpoint on ITS port.
if curl -sf -m 5 "http://127.0.0.1:${ALERT_PORT}/api/alert-status" >/dev/null 2>&1; then
  exit 0
fi

echo "[watchdog $(date -u +%Y-%m-%dT%H:%M:%SZ)] alert host down on ${ALERT_PORT} — restarting"
mkdir -p .run
PORT="$ALERT_PORT" \
ODDS_API_KEY="${ODDS_API_KEY:-}" \
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}" \
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}" \
  setsid nohup bun serve-static.ts >> .run/alerts-worker.log 2>&1 < /dev/null &
echo "[watchdog] restarted on ${ALERT_PORT} (pid $!)"
