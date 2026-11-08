#!/usr/bin/env bash
# WHO SCANS? — the bash half of src/lib/alert-role.ts.
#
# Sourced by scripts/alert-loop.sh (the 30-minute schedule) and
# scripts/alert-keepalive.sh (the platform supervisor). Both must refuse to run
# on a host that is not the named scanner, because a second scanner double-alerts
# the owner's group and double-spends odds credits.
#
# The answer lives in deploy/vps/primary.conf (`PRIMARY_SCANNER=vps|platform`)
# and the host's own role lives in EAW_ALERT_ROLE, which the VPS systemd unit
# sets to `vps`. Unset means `platform` — so a machine with no environment at all
# is still a working scanner if somebody rolls back.
#
# test/alert-role.test.ts pins all of this: the conf file, this helper's reading
# of it, the TS constant, and the guards in both scripts.

eaw_primary_scanner() {
  local here conf value
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  conf="$here/../deploy/vps/primary.conf"
  value=""
  if [ -f "$conf" ]; then
    value="$(sed -n 's/^[[:space:]]*PRIMARY_SCANNER[[:space:]]*=[[:space:]]*\([A-Za-z]*\).*/\1/p' "$conf" | head -1 | tr 'A-Z' 'a-z')"
  fi
  # A missing or unreadable config must not silence the scanner entirely: the
  # platform value is the pre-cutover default, so the machine still scans.
  printf '%s' "${value:-platform}"
}

eaw_alert_host() {
  local role
  role="$(printf '%s' "${EAW_ALERT_ROLE:-}" | tr 'A-Z' 'a-z')"
  printf '%s' "${role:-platform}"
}

# 0 when this host is the one scanner.
eaw_is_primary_scanner() {
  [ "$(eaw_primary_scanner)" = "$(eaw_alert_host)" ]
}

# One line, printed by a host that has stood down. It names both halves so a
# reader of the log can see WHY nothing scanned — a silent exit would be
# indistinguishable from a crash.
eaw_not_scanner_message() {
  local who="$1"
  printf '[%s %s] standing down: this host is "%s" and the scanner is "%s" (deploy/vps/primary.conf) — no odds fetched, no alert sent. Rollback: bash deploy/vps/rollback.sh\n' \
    "$who" "$(date -u +%FT%TZ)" "$(eaw_alert_host)" "$(eaw_primary_scanner)"
}
