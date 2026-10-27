#!/usr/bin/env bash
# ensure-alert-worker.sh — the boot hook.
#
# WHY THIS EXISTS: a machine replacement (2026-10-26) killed the alert worker and
# nothing ever restarted it, so the owner lost a full day of scans. Cron isn't
# available here, so we hook the one thing the platform ALWAYS runs on a fresh
# box: its start-up command, which is `bun install` followed by `bun run dev`.
# Both of those now call this script (package.json: postinstall + predev).
#
# It is idempotent and cheap: if the supervisor is already alive it prints one
# line and exits. It never touches port 3000 — the worker binds nothing at all,
# and its health/status host listens on ALERT_PORT (3100).
#
# It also sources the owner's secrets itself, so a boot with an empty
# environment still comes up with Telegram delivery live.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 0
mkdir -p .run

# Never start a worker inside a hosted build sandbox (Vercel etc.) — alerts run
# on the team machine, not in a build step.
if [ -n "${VERCEL:-}" ]; then
  exit 0
fi

# Load the owner's Telegram credentials (0600 file, never committed).
SECRETS="/home/team/shared/.secrets/telegram.env"
if [ -f "$SECRETS" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$SECRETS"
  set +a
fi

# Already supervised? Nothing to do.
PIDFILE=".run/alert-keepalive.pid"
if [ -f "$PIDFILE" ]; then
  other="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
    echo "[ensure-alert-worker] supervisor already running (pid $other) — nothing to do"
    exit 0
  fi
fi

echo "[ensure-alert-worker $(date -u +%FT%TZ)] starting supervisor (trigger: ${1:-boot})"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}" \
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}" \
ODDS_API_KEY="${ODDS_API_KEY:-}" \
  setsid nohup bash scripts/alert-keepalive.sh >> .run/alerts.log 2>&1 < /dev/null &
sleep 1
echo "[ensure-alert-worker] supervisor launched"
exit 0
