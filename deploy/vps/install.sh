#!/usr/bin/env bash
# install.sh — one command, run from THIS machine, that puts the alert worker on
# the owner's VPS. Safe to run twice.
#
#   deploy/vps/install.sh              # install / repair
#   deploy/vps/install.sh --check      # preflight only: reachability, key, facts
#
# It does NOT start the worker. It does NOT touch the platform's running worker.
# Starting the VPS worker is cutover.sh's job, and only after the platform's
# worker is confirmed stopped (see cutover.sh and README.md).
#
# WHAT IT DOES
#   1. preflight: config present, key present, ssh works with the key alone
#   2. rsync the repo → /opt/eaw/site (no node_modules, no .git, no .run)
#   3. copy the two secrets files → /opt/eaw/secrets, 0600, owned by eaw.
#      The bytes travel over ssh's stdin; no value is ever printed, logged or
#      passed as a command-line argument.
#   4. run install-remote.sh on the VPS as root: distro check, packages, bun,
#      the eaw user, directories, legacy secret symlinks, the two systemd units,
#      enable (not start)
#   5. print what to run next
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/lib.sh"
eaw_init "$HERE"

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

eaw_head "1/5 preflight"
eaw_require_config
eaw_log "VPS: $VPS_USER@$VPS_HOST:$VPS_PORT"
eaw_log "key: $SSH_KEY"
eaw_log "remote root: $REMOTE_ROOT (site $REMOTE_SITE, secrets $REMOTE_SECRETS)"

[ -x "$RSYNC_BIN" ] || command -v "$RSYNC_BIN" >/dev/null 2>&1 || eaw_die "rsync is not installed on this machine"
[ -f "$SSH_KEY" ] || eaw_die "ssh key $SSH_KEY is missing"
perm="$(stat -c %a "$SSH_KEY" 2>/dev/null || echo '?')"
[ "$perm" = "600" ] || eaw_warn "key mode is $perm, expected 600 (ssh may refuse it): chmod 600 $SSH_KEY"

for f in odds.env telegram.env; do
  [ -f "$LOCAL_SECRETS_DIR/$f" ] || eaw_warn "secret $LOCAL_SECRETS_DIR/$f is missing — the worker will start without it"
done

eaw_log "checking ssh (key only, no password prompt)…"
if ! eaw_reachable; then
  eaw_die "cannot ssh to $VPS_USER@$VPS_HOST with $SSH_KEY.
  Things to confirm with the owner: is port $VPS_PORT open, is the public key in
  ~/.ssh/authorized_keys for $VPS_USER, and is the address right?"
fi
eaw_log "ssh ok"

eaw_head "2/5 remote facts"
eaw_ssh 'printf "host=%s\n" "$(hostname 2>/dev/null || echo ?)"; . /etc/os-release 2>/dev/null && printf "distro=%s\n" "${PRETTY_NAME:-?}"; printf "arch=%s\n" "$(uname -m)"; printf "systemd=%s\n" "$(systemctl --version 2>/dev/null | head -1 || echo none)"; printf "bun=%s\n" "$(command -v bun || echo MISSING)"; printf "root_login=%s\n" "$(id -u)"' || eaw_die "could not read remote facts"

if [ "$CHECK_ONLY" = "1" ]; then
  eaw_head "check complete"
  eaw_log "--check stops here; nothing was written"
  exit 0
fi

eaw_head "3/5 rsync the repo"
# --delete keeps the VPS tree honest, and the excludes PROTECT the things that
# must survive a re-install: .run (the worker's state), secrets, and the config.
eaw_rsync -az --delete \
  --exclude 'node_modules/' --exclude '.git/' --exclude '.run/' --exclude 'dist/' \
  --exclude 'deploy/vps/vps.conf' --exclude '*.log' --exclude '.env' \
  "$EAW_REPO_ROOT/" "$VPS_USER@$VPS_HOST:$REMOTE_SITE/" \
  || eaw_die "rsync failed"
eaw_log "repo synced to $REMOTE_SITE"

eaw_head "4/5 secrets (0600, owned by $EAW_USER, never echoed)"
# The file is piped into ssh's stdin and written by a remote shell that never
# prints it. Compare hashes first so a second run reports "unchanged" instead of
# rewriting the file (and so a rotation is visible).
push_secret() {
  local name="$1" src="$LOCAL_SECRETS_DIR/$1" dst="$REMOTE_SECRETS/$1" lsum rsum
  if [ ! -f "$src" ]; then
    eaw_warn "secret $src missing — skipped (remote copy, if any, is left alone)"
    return 0
  fi
  lsum="$(eaw_local_sha256 "$src")"
  rsum="$(eaw_remote_sha256 "$dst")"
  if [ -n "$lsum" ] && [ "$lsum" = "$rsum" ]; then
    eaw_log "secret $name: unchanged (same content, already on the VPS)"
    return 0
  fi
  # Stage in /tmp (writable by any login user), then move into place as root.
  # chmod runs BEFORE the move, so the file is never briefly readable by others.
  local stage="/tmp/eaw-secret.$name.${BASHPID}"
  eaw_ssh_stdin "umask 077; cat > '$stage'" < "$src" || eaw_die "could not upload $name"
  eaw_root "chmod 0600 '$stage' && chown $EAW_USER:$EAW_USER '$stage' && mv -f '$stage' '$dst'" \
    || eaw_die "could not install $dst"
  eaw_log "secret $name: installed at $dst (0600 $EAW_USER)"
}
push_secret odds.env
push_secret telegram.env

# Optional third file: the snapshot push to the published site. Without it the
# VPS scans and alerts but the website's Instant Wins feed stops updating, so
# the move is not really complete until this exists.
if [ -f "$LOCAL_SECRETS_DIR/push.env" ]; then
  push_secret push.env
else
  eaw_warn "no $LOCAL_SECRETS_DIR/push.env — the VPS will scan and alert, but will NOT push the"
  eaw_warn "fixtures snapshot to the website (SCAN_PUSH_URLS / OWNER_PASSWORD). See README 'open questions'."
fi

eaw_head "5/5 install on the VPS"
# The remote script needs its paths; pass them explicitly so the rehearsal can
# point the same script at a throwaway tree.
REMOTE_ENV="EAW_ROOT=$REMOTE_ROOT EAW_USER=$EAW_USER EAW_LEGACY_SECRETS=$EAW_LEGACY_SECRETS UNIT_DIR=${UNIT_DIR:-/etc/systemd/system} EAW_BUN_SOURCE=${EAW_BUN_SOURCE:-official} REMOTE_BUN=$REMOTE_BUN EAW_DISTRO_OK=${EAW_DISTRO_OK:-0}"

run_remote_install() {
  local out rc
  out="$(eaw_ssh_stdin "${SUDO:+$SUDO }env $REMOTE_ENV bash -s" < "$HERE/install-remote.sh" 2>&1)"
  rc=$?
  printf '%s\n' "$out"
  return $rc
}

run_remote_install
rc=$?
if [ "$rc" = "10" ]; then
  # The VPS could not download bun (no egress to bun.sh, or curl missing). Push
  # this machine's bun binary instead — bun is a single static executable, and a
  # VPS that cannot reach bun.sh can still reach us over ssh.
  eaw_warn "bun could not be installed on the VPS — pushing this machine's binary to $REMOTE_BUN"
  local_bun="$(command -v bun || true)"
  [ -n "$local_bun" ] || eaw_die "no bun on this machine to push, and none on the VPS"
  eaw_ssh_stdin "cat > '/tmp/eaw-bun.${BASHPID}'" < "$local_bun" || eaw_die "could not upload bun"
  eaw_root "chmod 0755 '/tmp/eaw-bun.${BASHPID}' && mv -f '/tmp/eaw-bun.${BASHPID}' '$REMOTE_BUN'" \
    || eaw_die "could not install $REMOTE_BUN"
  eaw_log "bun pushed ($("$local_bun" --version 2>/dev/null || echo '?')) — re-running the remote install"
  run_remote_install || eaw_die "remote install failed after the bun fallback"
elif [ "$rc" != "0" ]; then
  eaw_die "remote install failed (exit $rc)"
fi

eaw_head "installed"
eaw_log "next: deploy/vps/sync-state.sh   (copy the alert history across)"
eaw_log "then: deploy/vps/dry-run.sh start (one hour, no alerts, compare against live)"
eaw_log "then: deploy/vps/cutover.sh      (the switch)"
exit 0
