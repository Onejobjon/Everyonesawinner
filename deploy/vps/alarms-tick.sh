#!/usr/bin/env bash
# alarms-tick.sh — the two alarm jobs the platform's supervisor used to run on
# its 60-second tick, now run by eaw-alarms.timer on the VPS.
#
# WHY IT IS A SEPARATE UNIT: the stall alarm and the daily heartbeat are the only
# things that SPEAK when the worker is dead, so they must not share the worker's
# fate. eaw-alerts.service restarts the scan loop; this timer keeps the alarms
# ticking even while that service is failing.
#
# Both jobs are one-shot and guard themselves on disk (one message per stall,
# one heartbeat per London day), so a 60-second tick cannot double-send.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SITE="$(cd "$HERE/../.." && pwd)"
cd "$SITE" || exit 1
mkdir -p .run

bun scripts/alert-gap-alarm.ts >> .run/alerts.log 2>&1 || true
bun scripts/alert-heartbeat.ts >> .run/alerts.log 2>&1 || true
exit 0
