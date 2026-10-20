#!/usr/bin/env bash
# Worker watchdog — keeps serve-static.ts (which embeds the alert worker) alive
# across machine replacements. Check port 3000; restart if not listening.
#
# Schedule every minute. NOTE: crontab is NOT available in this sandbox
# (`crontab: command not found`), so this is invoked by an external scheduler on
# the production host. On a host with cron:
#   * * * * *  cd /home/team/shared/site && bash scripts/watchdog.sh >> .run/watchdog.log 2>&1
set -u
cd "$(dirname "$0")/.."

# Healthy if the server answers our cheap health endpoint.
if curl -sf -m 5 http://127.0.0.1:3000/api/alert-status >/dev/null 2>&1; then
  exit 0
fi

echo "[watchdog $(date -u +%Y-%m-%dT%H:%M:%SZ)] port 3000 down — restarting serve-static.ts"
mkdir -p .run

# Restart with owner secrets inline (inherited from this process's env, which the
# platform re-injects with the owner's secrets — same pattern as sync-git.mjs).
nohup bun serve-static.ts >> .run/serve.log 2>&1 &
echo "[watchdog] restarted (pid $!)"
