#!/usr/bin/env bash
# install-remote.sh — the half of install.sh that runs ON THE VPS, as root.
#
# You never run this by hand. install.sh pipes it in:
#   ssh <vps> 'sudo -n env EAW_ROOT=/opt/eaw … bash -s' < deploy/vps/install-remote.sh
#
# It is IDEMPOTENT: a second run prints "unchanged" for every object it would
# otherwise have created, creates no duplicate user, no duplicate unit and no
# second copy of anything. (Rehearsed: deploy/vps/rehearsal/rehearse.sh.)
#
# Paths are env-overridable only so the rehearsal can point the whole thing at a
# throwaway tree. On the VPS the defaults are the real ones.
set -uo pipefail

EAW_ROOT="${EAW_ROOT:-/opt/eaw}"
EAW_USER="${EAW_USER:-eaw}"
EAW_LEGACY_SECRETS="${EAW_LEGACY_SECRETS:-/home/team/shared/.secrets}"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
EAW_BUN_SOURCE="${EAW_BUN_SOURCE:-official}"
REMOTE_BUN="${REMOTE_BUN:-/usr/local/bin/bun}"
SERVICE="eaw-alerts.service"
ALARMS_SERVICE="eaw-alarms.service"
ALARMS_TIMER="eaw-alarms.timer"

SITE="$EAW_ROOT/site"
SECRETS="$EAW_ROOT/secrets"
changed=0

note() { printf '[install-remote] %s\n' "$*"; }
fail() { printf '[install-remote] FAIL: %s\n' "$*" >&2; exit 1; }

# ── 0. must be root ────────────────────────────────────────────────────────
# This is the boundary the rehearsal simulates: the script refuses to run
# unprivileged rather than half-installing a service.
[ "$(id -u)" = "0" ] || fail "must run as root (pipe it through sudo, as install.sh does)"

# ── 1. distro ──────────────────────────────────────────────────────────────
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
fi
DISTRO="${ID:-unknown} ${ID_LIKE:-}"
case "$DISTRO" in
  *ubuntu*|*debian*) note "distro: ${PRETTY_NAME:-$DISTRO}" ;;
  *)
    if [ "${EAW_DISTRO_OK:-0}" = "1" ]; then
      note "distro: ${PRETTY_NAME:-$DISTRO} (override accepted)"
    else
      fail "this kit targets Ubuntu/Debian (found: ${PRETTY_NAME:-$DISTRO}). Set EAW_DISTRO_OK=1 only if you know apt and systemd are present."
    fi
    ;;
esac
command -v systemctl >/dev/null 2>&1 || fail "systemd is not present on this machine"
command -v apt-get >/dev/null 2>&1 || fail "apt-get is not present on this machine"

# ── 2. packages ────────────────────────────────────────────────────────────
# rsync is needed by sync-state.sh (it runs FROM this machine INTO the VPS).
need=""
for pkg in rsync curl ca-certificates; do
  case "$pkg" in
    rsync)        command -v rsync >/dev/null 2>&1 || need="$need rsync" ;;
    curl)         command -v curl  >/dev/null 2>&1 || need="$need curl" ;;
    ca-certificates) [ -d /etc/ssl/certs ] || need="$need ca-certificates" ;;
  esac
done
if [ -n "$need" ]; then
  note "installing packages:$need"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq || fail "apt-get update failed"
  # shellcheck disable=SC2086
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $need || fail "apt-get install failed:$need"
  changed=1
else
  note "packages: unchanged (rsync, curl, ca-certificates present)"
fi

# ── 3. bun ─────────────────────────────────────────────────────────────────
if command -v bun >/dev/null 2>&1; then
  note "bun: unchanged ($(bun --version 2>/dev/null || echo '?') at $(command -v bun))"
elif [ -x "$REMOTE_BUN" ]; then
  note "bun: unchanged ($REMOTE_BUN)"
else
  case "$EAW_BUN_SOURCE" in
    copy)
      fail "bun is missing and EAW_BUN_SOURCE=copy was requested — install.sh pushes the binary before re-running this script"
      ;;
    skip)
      note "bun: SKIPPED on request"
      ;;
    *)
      note "bun: installing from bun.sh"
      if curl -fsSL --max-time 120 https://bun.sh/install 2>/dev/null | BUN_INSTALL=/usr/local bash >/dev/null 2>&1; then
        :
      fi
      if command -v bun >/dev/null 2>&1 || [ -x "$REMOTE_BUN" ]; then
        note "bun: installed"
        changed=1
      else
        # Exit code 10 is the contract with install.sh: "bun is missing, push
        # this machine's binary and re-run me". Nothing else uses 10.
        printf '[install-remote] bun unavailable (no download) — install.sh will push a binary\n' >&2
        exit 10
      fi
      ;;
  esac
fi

# ── 4. the unprivileged service account ────────────────────────────────────
if id -u "$EAW_USER" >/dev/null 2>&1; then
  note "user $EAW_USER: unchanged (uid $(id -u "$EAW_USER"))"
else
  note "user $EAW_USER: creating (system account, no login shell, no password)"
  useradd --system --create-home --home-dir "/home/$EAW_USER" \
          --shell /usr/sbin/nologin --comment "Everyone's A Winner alert worker" "$EAW_USER" \
    || fail "useradd $EAW_USER failed"
  changed=1
fi

# ── 5. directories ─────────────────────────────────────────────────────────
mkdir -p "$EAW_ROOT" "$SITE" "$SECRETS" "$SITE/.run"
chmod 0755 "$EAW_ROOT" "$SITE"
chmod 0700 "$SECRETS"
chown -R "$EAW_USER:$EAW_USER" "$SITE" 2>/dev/null || true
chown "$EAW_USER:$EAW_USER" "$SECRETS" 2>/dev/null || true
note "directories: $EAW_ROOT, $SITE, $SECRETS (0700), $SITE/.run"

# ── 6. the repo must be here (install.sh rsyncs it before calling this) ────
[ -f "$SITE/scripts/alert-loop.sh" ] || fail "$SITE/scripts/alert-loop.sh is missing — install.sh must rsync the repo first"
[ -f "$SITE/deploy/vps/units/$SERVICE" ] || fail "$SITE/deploy/vps/units/$SERVICE is missing"
note "repo: present at $SITE ($(wc -l < "$SITE/scripts/alert-loop.sh") lines in alert-loop.sh)"

# ── 7. secrets ─────────────────────────────────────────────────────────────
# install.sh pushes the two files into $SECRETS with 0600. This step only
# verifies them and puts the legacy paths in place, because scripts/alert-loop.sh
# and src/server/odds-key.ts read those absolute paths directly.
for f in odds.env telegram.env; do
  if [ -f "$SECRETS/$f" ]; then
    chmod 0600 "$SECRETS/$f"
    chown "$EAW_USER:$EAW_USER" "$SECRETS/$f" 2>/dev/null || true
    note "secret $SECRETS/$f: present, 0600 $EAW_USER"
  else
    note "secret $SECRETS/$f: ABSENT (install.sh did not push it — the worker will run without it)"
  fi
done

# Legacy absolute paths: a SYMLINK, not a copy, so there is one copy to rotate.
if [ -d "$EAW_LEGACY_SECRETS" ] || mkdir -p "$EAW_LEGACY_SECRETS" 2>/dev/null; then
  for f in odds.env telegram.env; do
    [ -f "$SECRETS/$f" ] || continue
    if [ -L "$EAW_LEGACY_SECRETS/$f" ] && [ "$(readlink "$EAW_LEGACY_SECRETS/$f")" = "$SECRETS/$f" ]; then
      note "legacy path $EAW_LEGACY_SECRETS/$f: unchanged (symlink)"
    else
      if [ -e "$EAW_LEGACY_SECRETS/$f" ] && [ ! -L "$EAW_LEGACY_SECRETS/$f" ]; then
        mv -f "$EAW_LEGACY_SECRETS/$f" "$EAW_LEGACY_SECRETS/$f.pre-vps-$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
      fi
      ln -sfn "$SECRETS/$f" "$EAW_LEGACY_SECRETS/$f" || fail "could not link $EAW_LEGACY_SECRETS/$f"
      note "legacy path $EAW_LEGACY_SECRETS/$f: linked → $SECRETS/$f"
      changed=1
    fi
  done
  chmod 0755 "$EAW_LEGACY_SECRETS" 2>/dev/null || true
fi

# ── 8. systemd units ───────────────────────────────────────────────────────
# Rendered from the repo, compared with what is installed, written only when the
# content differs — that is what makes "run it twice and nothing changes" true.
render() { sed -e "s|@EAW_ROOT@|$EAW_ROOT|g" -e "s|@EAW_USER@|$EAW_USER|g" "$1"; }

put_unit() {
  local name="$1" src="$SITE/deploy/vps/units/$1" tmp
  tmp="$(mktemp)"
  render "$src" > "$tmp"
  if [ -f "$UNIT_DIR/$name" ] && cmp -s "$tmp" "$UNIT_DIR/$name"; then
    note "unit $name: unchanged"
  else
    cp "$tmp" "$UNIT_DIR/$name"
    chmod 0644 "$UNIT_DIR/$name"
    note "unit $name: written"
    changed=1
  fi
  rm -f "$tmp"
}

put_unit "$SERVICE"
put_unit "$ALARMS_SERVICE"
put_unit "$ALARMS_TIMER"

if [ "$changed" = "1" ]; then
  systemctl daemon-reload || fail "systemctl daemon-reload failed"
  note "systemd: daemon-reload"
else
  note "systemd: daemon-reload not needed (nothing changed)"
fi

# ── 9. enable (never start: cutover.sh decides when the VPS starts scanning) ─
for u in "$SERVICE" "$ALARMS_TIMER"; do
  if systemctl is-enabled --quiet "$u" 2>/dev/null; then
    note "enabled $u: unchanged"
  else
    systemctl enable "$u" >/dev/null 2>&1 || fail "systemctl enable $u failed"
    note "enabled $u: enabled"
    changed=1
  fi
done

# ── 10. summary ────────────────────────────────────────────────────────────
if [ "$changed" = "1" ]; then
  note "RESULT: install completed with changes"
else
  note "RESULT: nothing to change — already installed (this is the idempotent path)"
fi
note "next: deploy/vps/sync-state.sh (from this machine), then dry-run.sh, then cutover.sh"
exit 0
