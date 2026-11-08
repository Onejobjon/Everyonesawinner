#!/usr/bin/env bash
# Alert worker loop — the owner's 30-minute opportunity scans. PORT-FREE by design:
# it never binds a socket, so it does not care that the platform dev server owns
# port 3000. Each tick is one `runAlertCheck()` in a fresh bun process, so a
# crash cannot leave the worker half-dead, and a bad scan can never wedge the
# schedule.
#
# ONE SCAN AT A TIME: each tick goes through src/server/scan-lock.ts, which takes
# an atomic lock in .run/ that the page-open path takes too. If a scan is already
# in flight this tick does NOT fetch (no odds credits) and does not alert — it
# logs one line, `skipped: scan already in flight`, and exits 0 so the schedule
# carries on. A lock left by a killed scan is abandoned after 20 minutes, or
# immediately when its pid is gone.
#
# CADENCE (owner directive 2026-11-03: "scan every 30mins and on open"):
#   30 minutes = 1800s, and it is a DEFAULT IN THIS COMMITTED FILE, not an env var
#   set in somebody's shell — so a replaced machine re-reads it and comes back at
#   the same cadence (the pidfile fix below survives the same way). The number is
#   pinned to src/lib/cadence.ts by test/cadence.test.ts; change both together.
#   "On open" is the other half and lives in src/server/scan-on-open.ts.
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
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/.."
REPO="$PWD"
SECRETS="/home/team/shared/.secrets/telegram.env"
LOG="$REPO/.run/alerts.log"
INTERVAL="${ALERT_INTERVAL_SEC:-1800}"   # every 30 min — OWNER DIRECTIVE 2026-11-03 ("scan every 30mins and on open")
RETRY_FAST="${ALERT_RETRY_SEC:-15}"      # quick retry when a tick crashes
mkdir -p .run

# shellcheck disable=SC1091
. "$HERE/pidfile.sh"

# WHO SCANS. Exactly one host may run this loop: two would double-alert the
# owner's Telegram group and double-spend odds credits. The answer is
# deploy/vps/primary.conf, read through scripts/alert-role.sh, and it is checked
# BEFORE the lock so a stood-down host writes no pidfile and looks like what it
# is — deliberately idle, not crashed. Since 2026-11-08 the scanner is the VPS
# (systemd eaw-alerts) and this platform host stands down here.
# shellcheck disable=SC1091
. "$HERE/alert-role.sh"
if ! eaw_is_primary_scanner; then
  eaw_not_scanner_message "alert-loop"
  exit 0
fi

# Single instance. A PID number alone is not an identity: after a machine
# replacement the kernel hands the same numbers to unrelated processes, and the
# old check ("kill -0 says alive") then blocked every restart for four and a half
# days. pid_is_ours() also matches the process's own command line.
LOCK="$REPO/.run/alert-loop.pid"
if [ -f "$LOCK" ]; then
  other="$(read_pidfile "$LOCK")"
  if pid_is_ours "$other" "alert-loop"; then
    echo "[alert-loop $(date -u +%FT%TZ)] already running (pid $other) — exiting"
    exit 0
  fi
  if [ -n "$other" ]; then
    echo "[alert-loop $(date -u +%FT%TZ)] stale pidfile (pid $other is not this loop — machine replaced?) — starting anyway"
  fi
fi
write_pidfile "$LOCK"
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

# RESTART REPORT — the owner is told, with the length of the gap, the moment this
# loop comes back after the machine was off (owner report 2026-11-06: two days of
# silence with no message at all). One message per gap, and NOTHING at all when
# the last completed scan is under 45 minutes old, so a routine restart stays
# quiet. Run after the first successful tick — not before it — so "found since
# the restart" is a real number instead of a zero.
RESTART_AT="$(date -u +%FT%TZ)"
export RESTART_AT

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
    EAW_RESTART_AT="$RESTART_AT" bun scripts/alert-restart-report.ts >> .run/alerts.log 2>&1 || true
    sleep "$INTERVAL"
  fi
done
