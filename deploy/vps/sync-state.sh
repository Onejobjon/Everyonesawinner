#!/usr/bin/env bash
# sync-state.sh — copy the alert worker's state from THIS machine to the VPS.
#
#   deploy/vps/sync-state.sh            # sync (refuses if the VPS worker is live)
#   deploy/vps/sync-state.sh --dry-run  # print the plan, change nothing
#   deploy/vps/sync-state.sh --force    # sync even if the VPS service is active
#
# WHY IT MATTERS: alerts-seen.json is the dedup list. Move the worker without it
# and the owner is re-alerted every green trade he has already been sent — the
# exact failure the lead called out. So the history moves with the worker.
#
# THE THREE RULES, each enforced here and each proven by a test:
#   1. NEVER overwrite a NEWER remote file. If the remote copy's mtime is later
#      than the local one, that file is refused, reported, and left untouched.
#      (Remote newer means the VPS has already scanned — the VPS is the truth.)
#   2. NEVER delete the only copy. A missing local file is skipped, not pushed
#      as empty, and nothing is ever removed on either side.
#   3. ALWAYS back up what is replaced — <file>.<UTC stamp>.bak in
#      <remote .run>/backups/ before the swap.
#
# Timestamps are preserved on the way across (install -p), so rule 1 keeps
# working on the second and third run instead of degrading into "remote is newer
# because I just wrote it".
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/lib.sh"
eaw_init "$HERE"

DRY=0
FORCE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --force) FORCE=1 ;;
    *) eaw_die "unknown argument: $a (use --dry-run or --force)" ;;
  esac
done

# The worker's state files. Order matters only for the report: the seen list
# first, because that is the one the owner would notice losing.
FILES="alerts-seen.json alerts-sports-index.json alerts-cache.json alerts-last-scan.json heartbeat.json gap-alarm-last-run.json"
BACKUP_DIR="$REMOTE_RUN/backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SKEW="${MTIME_SKEW_SEC:-0}"

eaw_require_config
# Every path below is a write: the remote state dir, the backup dir and the
# staging dir on the VPS. Fenced in a rehearsal (exit 90), no-op in production.
eaw_guard_write "$REMOTE_RUN"    "write the remote worker state"
eaw_guard_write "$BACKUP_DIR"    "write remote backups"
eaw_guard_write "$REMOTE_TMP"    "stage uploads on the VPS"
eaw_head "sync-state → $VPS_HOST:$REMOTE_RUN"
eaw_log "local state: $LOCAL_RUN_DIR"
[ "$DRY" = "1" ] && eaw_log "DRY RUN — nothing will be written"

eaw_reachable || eaw_die "VPS unreachable ($VPS_USER@$VPS_HOST)"

# Refuse to write into a worker that is running: it owns these files, and a
# half-written seen list is worse than a stale one.
if [ "$FORCE" != "1" ]; then
  state="$(eaw_root "systemctl is-active $SERVICE" 2>/dev/null | tr -d '\r' | tail -1)"
  if [ "$state" = "active" ]; then
    eaw_die "$SERVICE is ACTIVE on the VPS — it owns these files. Stop it first
  (systemctl stop $SERVICE) or pass --force if you are certain."
  fi
  eaw_log "VPS worker: not running (safe to write its state)"
fi

eaw_root "mkdir -p '$REMOTE_RUN' '$BACKUP_DIR' && chown -R $EAW_USER:$EAW_USER '$REMOTE_RUN' && chmod 0700 '$REMOTE_RUN' '$BACKUP_DIR'" \
  || eaw_die "could not prepare $REMOTE_RUN on the VPS"

pushed=0; unchanged=0; refused=0; skipped=0
for f in $FILES; do
  lf="$LOCAL_RUN_DIR/$f"
  if [ ! -f "$lf" ]; then
    eaw_log "SKIP     $f — not present here (remote copy, if any, is left alone)"
    skipped=$((skipped + 1))
    continue
  fi
  lmt="$(stat -c %Y "$lf" 2>/dev/null || echo 0)"
  rmt="$(eaw_remote_mtime "$REMOTE_RUN/$f")"
  rmt="${rmt:-0}"
  lsize="$(stat -c %s "$lf" 2>/dev/null || echo 0)"

  # RULE 1 — never overwrite a newer remote file. The comparison is the pure
  # function eaw_state_refuses_newer() in lib.sh, which test/vps-kit.test.ts
  # exercises directly — so the rule that runs here is the rule under test.
  if eaw_state_refuses_newer "$lmt" "$rmt" "$SKEW"; then
    eaw_warn "REFUSED  $f — the VPS copy is NEWER (remote $(date -u -d "@$rmt" +%FT%TZ 2>/dev/null || echo "$rmt") > local $(date -u -d "@$lmt" +%FT%TZ 2>/dev/null || echo "$lmt"))"
    eaw_warn "         the VPS has scanned more recently than this machine; nothing was written"
    refused=$((refused + 1))
    continue
  fi

  lsha="$(eaw_local_sha256 "$lf")"
  rsha="$(eaw_remote_sha256 "$REMOTE_RUN/$f")"
  if eaw_state_same "$lsha" "$rsha"; then
    eaw_log "UNCHANGED $f — same content already on the VPS ($lsize bytes)"
    unchanged=$((unchanged + 1))
    continue
  fi

  if [ "$DRY" = "1" ]; then
    if [ "$rmt" -gt 0 ]; then
      eaw_log "WOULD    $f — back up remote copy, then replace ($lsize bytes)"
    else
      eaw_log "WOULD    $f — create on the VPS ($lsize bytes)"
    fi
    pushed=$((pushed + 1))
    continue
  fi

  # RULE 3 — back up whatever is being replaced (on the VPS, so a local disk
  # problem cannot take the backup with it).
  if [ "$rmt" -gt 0 ]; then
    eaw_root "cp -p '$REMOTE_RUN/$f' '$BACKUP_DIR/$f.$STAMP.bak'" \
      || eaw_die "could not back up $f on the VPS — refusing to replace it"
    eaw_log "backup   $f → $BACKUP_DIR/$f.$STAMP.bak"
  fi

  # Stage in $REMOTE_TMP, then install with -p so the mtime travels with the file.
  stage="$REMOTE_TMP/eaw-state.$f.${BASHPID}"
  eaw_rsync -t "$lf" "$VPS_USER@$VPS_HOST:$stage" >/dev/null 2>&1 \
    || eaw_die "rsync of $f failed"
  eaw_root "chmod 0600 '$stage' && install -p -m 0600 '$stage' '$REMOTE_RUN/$f' && chown $EAW_USER:$EAW_USER '$REMOTE_RUN/$f' && rm -f '$stage'" \
    || eaw_die "could not install $f on the VPS"

  # Verify: the bytes AND the timestamp both have to match, or rule 1 stops
  # working on the next run.
  nsha="$(eaw_remote_sha256 "$REMOTE_RUN/$f")"
  nmt="$(eaw_remote_mtime "$REMOTE_RUN/$f")"
  if [ "$nsha" != "$lsha" ]; then
    eaw_die "verification failed for $f (remote sha $nsha != local $lsha)"
  fi
  if [ "${nmt:-0}" != "$lmt" ]; then
    eaw_warn "timestamp not preserved for $f (remote ${nmt:-0} != local $lmt) — rule 1 will compare against the wrong clock"
  fi
  eaw_log "SYNCED   $f — $lsize bytes, sha ${lsha:0:12}…, mtime preserved"
  pushed=$((pushed + 1))
done

eaw_head "summary"
eaw_log "synced: $pushed   unchanged: $unchanged   refused (remote newer): $refused   skipped (not here): $skipped"
if [ "$refused" -gt 0 ]; then
  eaw_warn "$refused file(s) were NOT copied because the VPS has newer data."
  eaw_warn "That is the correct outcome if the VPS has already been scanning."
  EAW_EXIT=3 eaw_die "state sync incomplete by design — read the REFUSED lines above"
fi
[ "$DRY" = "1" ] && eaw_log "dry run: nothing was written"
eaw_log "next: deploy/vps/dry-run.sh start"
exit 0
