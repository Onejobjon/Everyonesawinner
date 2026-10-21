#!/usr/bin/env bash
# Watchdog LOOP — runs scripts/watchdog.sh every 60s in-process, so the alert
# worker (serve-static.ts) survives PROCESS crashes. Needed because crontab is
# NOT available in this sandbox, so there is no cron to schedule the per-minute
# watchdog.
#
# Start it alongside serve-static.ts (same inline-secrets pattern as the server
# restart, so the loop → watchdog → restarted-server chain keeps Telegram + key):
#   nohup env ODDS_API_KEY="<key>" TELEGRAM_BOT_TOKEN="<token>" TELEGRAM_CHAT_ID="<chat>" \
#     bash scripts/watchdog-loop.sh >> .run/watchdog-loop.log 2>&1 &
#
# LIMITATION: this protects against PROCESS crashes only, not machine
# replacements. A machine replacement kills this loop too (its process dies with
# the machine) — after any replacement, re-run the start line above to restore
# the loop. See scripts/watchdog.sh for the full restart procedure.
set -u
cd "$(dirname "$0")/.."

while true; do
  bash scripts/watchdog.sh >> .run/watchdog.log 2>&1
  sleep 60
done
