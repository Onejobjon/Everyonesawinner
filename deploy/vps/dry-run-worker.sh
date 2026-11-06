#!/usr/bin/env bash
# dry-run-worker.sh — ONE rehearsal session of the alert worker, on the VPS, with
# alerting suppressed. Started by dry-run.sh; you never run it by hand.
#
#   dry-run-worker.sh <scratch-run-dir> <minutes> <interval-seconds>
#
# WHAT IT PROVES: that the VPS sees the same opportunities as the platform worker
# before anybody switches over. It runs the REAL scan against the REAL vendor API
# with the REAL code — the only differences are that nothing is delivered and the
# state it writes goes to a scratch directory.
#
# SUPPRESSION, and how each part is guaranteed rather than hoped for:
#   no Telegram  — `env -i` starts bun with a clean environment: no
#                  TELEGRAM_BOT_TOKEN, no chat ids. postTelegram() is a no-op
#                  when the token is empty.
#   no seen writes — ALERTS_RUN_DIR points at the scratch dir, so alerts-seen.json
#                  there is a copy. The live list is never opened for writing.
#   no snapshot push — SCAN_PUSH_URLS is not in the clean environment, and
#                  EAW_ALERT_DRY_RUN=1 also skips the push in code, so a rehearsal
#                  can never overwrite the website's live feed.
#   no alert state change — EAW_ALERT_DRY_RUN=1 makes deliver() log the message it
#                  WOULD have sent and return without sending (src/server/alerts.ts).
#
# COST: a dry run spends real odds-API credits — one scan per interval, the same
# as the live worker. Keep it to one hour (~2 scans) and check
# .run/credits.jsonl on this machine afterwards.
set -u
RUN_DIR="${1:?scratch run dir required}"
MINUTES="${2:-60}"
INTERVAL="${3:-900}"
SITE="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$SITE" || exit 1
mkdir -p "$RUN_DIR"

PIDFILE="$RUN_DIR/dry-run.pid"
printf '%s\n' "${BASHPID}" > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

SEED="$SITE/.run/alerts-seen.json"
if [ ! -f "$RUN_DIR/alerts-seen.json" ] && [ -f "$SEED" ]; then
  # Seed with the live dedup list, so "would alert" means "new to the owner".
  cp "$SEED" "$RUN_DIR/alerts-seen.json"
  echo "[dry-run $(date -u +%FT%TZ)] seeded seen list from $SEED"
fi

DEADLINE=$(( $(date +%s) + MINUTES * 60 ))
echo "[dry-run $(date -u +%FT%TZ)] starting: ${MINUTES}min, interval ${INTERVAL}s, run dir $RUN_DIR, pid ${BASHPID}"

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  cp "$RUN_DIR/alerts-seen.json" "$RUN_DIR/.seen.before" 2>/dev/null || echo '[]' > "$RUN_DIR/.seen.before"
  echo "[dry-run $(date -u +%FT%TZ)] scan starting"
  env -i \
    PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}" \
    HOME="${HOME:-/tmp}" \
    EAW_ALERT_DRY_RUN=1 \
    ALERTS_RUN_DIR="$RUN_DIR" \
    ODDS_ENV_FILE="${ODDS_ENV_FILE:-$SITE/../secrets/odds.env}" \
    bun src/server/alerts.ts --once >> "$RUN_DIR/dry-run.log" 2>&1
  rc=$?
  # What it would have alerted = the keys the scan added to the scratch seen list.
  BEFORE="$RUN_DIR/.seen.before" AFTER="$RUN_DIR/alerts-seen.json" \
  bun -e 'const fs=require("node:fs");
    const before=new Set(JSON.parse(fs.readFileSync(process.env.BEFORE,"utf8")));
    const after=JSON.parse(fs.readFileSync(process.env.AFTER,"utf8"));
    const ts=new Date().toISOString();
    for (const k of after) if (!before.has(k)) console.log(JSON.stringify({ts,key:k}));' \
    >> "$RUN_DIR/would-alert.jsonl" 2>/dev/null
  echo "[dry-run $(date -u +%FT%TZ)] scan rc=$rc — next in ${INTERVAL}s"
  sleep "$INTERVAL"
done

echo "[dry-run $(date -u +%FT%TZ)] finished"
exit 0
