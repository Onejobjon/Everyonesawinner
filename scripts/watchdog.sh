#!/usr/bin/env bash
# Worker watchdog — keeps serve-static.ts (which embeds the alert worker) alive
# across PROCESS crashes. Check port 3000; restart if not listening.
#
# This script is meant to be run every 60s by scripts/watchdog-loop.sh (an
# in-process `while true` loop), since crontab is NOT available in this sandbox.
# On a host WITH cron you can instead schedule it directly:
#   * * * * *  cd /home/team/shared/site && bash scripts/watchdog.sh >> .run/watchdog.log 2>&1
#
# RESTART PROCEDURE — start BOTH the server and the watchdog loop, passing the
# owner's Telegram secrets AND the odds API key inline so the alert worker keeps
# its channel + quota across any crash restart (the base shell env does NOT
# carry them):
#
#   1. Start the server:
#        nohup env ODDS_API_KEY="<key>" TELEGRAM_BOT_TOKEN="<token>" \
#          TELEGRAM_CHAT_ID="<chat>" bun serve-static.ts >> .run/serve.log 2>&1 &
#   2. Start the watchdog loop:
#        nohup env ODDS_API_KEY="<key>" TELEGRAM_BOT_TOKEN="<token>" \
#          TELEGRAM_CHAT_ID="<chat>" bash scripts/watchdog-loop.sh >> .run/watchdog-loop.log 2>&1 &
set -u
cd "$(dirname "$0")/.."

# Healthy if the server answers our cheap health endpoint.
if curl -sf -m 5 http://127.0.0.1:3000/api/alert-status >/dev/null 2>&1; then
  exit 0
fi

echo "[watchdog $(date -u +%Y-%m-%dT%H:%M:%SZ)] port 3000 down — restarting serve-static.ts"
mkdir -p .run

# Restart with the owner's Telegram secrets + odds key inline (inherited from this
# process's env, which the watchdog loop re-injects), so the alert worker keeps
# its channel + quota.
nohup env ODDS_API_KEY="${ODDS_API_KEY:-}" TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}" \
  TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}" bun serve-static.ts >> .run/serve.log 2>&1 &
echo "[watchdog] restarted (pid $!)"
