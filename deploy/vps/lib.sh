#!/usr/bin/env bash
# lib.sh — shared helpers for the Everyone's A Winner VPS deployment kit.
#
# Sourced by every script in deploy/vps/. Nothing here runs on its own.
#
# WHY THIS KIT EXISTS
#   The alert worker runs on this platform machine, and this machine PAUSES when
#   the platform's usage credits run out (it was off 2026-11-04 11:00 →
#   2026-11-06 14:33 with no alarm, because the stall alarm lives on the same
#   machine). A VPS does not pause. See deploy/vps/README.md for the sequence.
#
# CONFIGURATION — an environment variable wins, then deploy/vps/vps.conf, then
# the default shown here:
#   VPS_HOST            the VPS address                        (required)
#   VPS_USER            the login user                         (required)
#   VPS_PORT            ssh port                               (22)
#   SSH_KEY             private key                            (/home/team/shared/.secrets/eaw-vps_ed25519)
#   SUDO                privilege command                      ("sudo -n"; empty when VPS_USER is root)
#   REMOTE_ROOT         where the kit lives on the VPS         (/opt/eaw)
#   EAW_USER            unprivileged service account           (eaw)
#   LOCAL_SECRETS_DIR   this machine's secret files            (/home/team/shared/.secrets)
#   LOCAL_RUN_DIR       this machine's worker state            (<repo>/.run)
#   SERVICE / ALARMS_SERVICE / ALARMS_TIMER                    (eaw-alerts.service, …)
#
# TESTING HOOKS — set only by deploy/vps/rehearsal/, never in production:
#   SSH_BIN, RSYNC_BIN, SYSTEMCTL, PGREP, STAT_BIN, UNIT_DIR, EAW_SANDBOX
#
# Never echo a secret value from anything in this kit. Nothing here reads a
# secret except install.sh (which pipes bytes from one file into ssh's stdin)
# and sync-state.sh (state files, which are not secret).

# ── paths ──────────────────────────────────────────────────────────────────

# eaw_init <dir-of-the-calling-script>
#   Resolves the repo root, loads the config, and exports the canonical names
#   every script in the kit uses. Call it once, first thing, in each script.
eaw_init() {
  local here="$1"
  EAW_KIT_DIR="$(cd "$here" && pwd)"
  export EAW_KIT_DIR
  EAW_REPO_ROOT="${EAW_REPO_ROOT:-$(cd "$EAW_KIT_DIR/../.." && pwd)}"
  export EAW_REPO_ROOT
  EAW_CONF="${EAW_CONF:-$EAW_REPO_ROOT/deploy/vps/vps.conf}"

  VPS_HOST="$(eaw_conf VPS_HOST "")"
  VPS_USER="$(eaw_conf VPS_USER "")"
  VPS_PORT="$(eaw_conf VPS_PORT "22")"
  SSH_KEY="$(eaw_conf SSH_KEY "/home/team/shared/.secrets/eaw-vps_ed25519")"
  SUDO="$(eaw_conf SUDO "sudo -n")"
  REMOTE_ROOT="$(eaw_conf REMOTE_ROOT "/opt/eaw")"
  EAW_USER="$(eaw_conf EAW_USER "eaw")"
  LOCAL_SECRETS_DIR="$(eaw_conf LOCAL_SECRETS_DIR "/home/team/shared/.secrets")"
  # Where the VPS keeps the paths scripts/alert-loop.sh and odds-key.ts hardcode.
  # A symlink farm on the VPS, NOT a second copy of the secrets.
  EAW_LEGACY_SECRETS="$(eaw_conf EAW_LEGACY_SECRETS "/home/team/shared/.secrets")"
  LOCAL_RUN_DIR="$(eaw_conf LOCAL_RUN_DIR "$EAW_REPO_ROOT/.run")"
  SERVICE="$(eaw_conf SERVICE "eaw-alerts.service")"
  ALARMS_SERVICE="$(eaw_conf ALARMS_SERVICE "eaw-alarms.service")"
  ALARMS_TIMER="$(eaw_conf ALARMS_TIMER "eaw-alarms.timer")"
  # Where the VPS keeps its unit files. A config value so the rehearsal can point
  # it at a throwaway tree instead of the real /etc/systemd/system.
  UNIT_DIR="$(eaw_conf UNIT_DIR "/etc/systemd/system")"
  export VPS_HOST VPS_USER VPS_PORT SSH_KEY SUDO REMOTE_ROOT EAW_USER EAW_LEGACY_SECRETS \
    LOCAL_SECRETS_DIR LOCAL_RUN_DIR SERVICE ALARMS_SERVICE ALARMS_TIMER UNIT_DIR

  REMOTE_SITE="${REMOTE_SITE:-$REMOTE_ROOT/site}"
  REMOTE_SECRETS="${REMOTE_SECRETS:-$REMOTE_ROOT/secrets}"
  REMOTE_RUN="${REMOTE_RUN:-$REMOTE_SITE/.run}"
  REMOTE_DRY="${REMOTE_DRY:-$REMOTE_ROOT/dry-run}"
  REMOTE_BUN="${REMOTE_BUN:-/usr/local/bin/bun}"
  export REMOTE_SITE REMOTE_SECRETS REMOTE_RUN REMOTE_DRY REMOTE_BUN

  SSH_BIN="${SSH_BIN:-ssh}"
  RSYNC_BIN="${RSYNC_BIN:-rsync}"
  SYSTEMCTL="${SYSTEMCTL:-systemctl}"
  PGREP="${PGREP:-pgrep}"
  STAT_BIN="${STAT_BIN:-stat}"
  export SSH_BIN RSYNC_BIN SYSTEMCTL PGREP STAT_BIN

  # The machine-level off switch the platform worker honours (scripts/pidfile.sh).
  OFF_FILE="${OFF_FILE:-$EAW_REPO_ROOT/.run/alert-worker.disabled}"
  export OFF_FILE
}

# eaw_conf <NAME> <default> — env var if set, else vps.conf, else default.
#   A name that appears in vps.conf with an EMPTY value (SUDO="" for a root
#   login) is honoured as empty — that is not the same as "not configured".
eaw_conf() {
  local name="$1" dflt="$2" cur="" v=""
  cur="${!name-}"
  if [ -n "$cur" ]; then printf '%s' "$cur"; return 0; fi
  if [ -f "$EAW_CONF" ] && grep -qE "^[[:space:]]*(export[[:space:]]+)?${name}=" "$EAW_CONF" 2>/dev/null; then
    v="$(sed -n "s/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}${name}=//p" "$EAW_CONF" 2>/dev/null | tail -1 \
      | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
    printf '%s' "$v"
    return 0
  fi
  printf '%s' "$dflt"
}

# ── output ─────────────────────────────────────────────────────────────────

eaw_log()  { printf '[eaw] %s\n' "$*"; }
eaw_warn() { printf '[eaw] WARNING: %s\n' "$*" >&2; }
eaw_die()  { printf '[eaw] ABORT: %s\n' "$*" >&2; exit "${EAW_EXIT:-1}"; }
eaw_head() { printf '\n=== %s ===\n' "$*"; }

# ── ssh / remote ───────────────────────────────────────────────────────────

eaw_ssh_opts() {
  printf '%s' "-p $VPS_PORT -i $SSH_KEY -o BatchMode=yes -o ConnectTimeout=${SSH_CONNECT_TIMEOUT:-10} -o StrictHostKeyChecking=accept-new"
}

# eaw_ssh <command...> — run a command on the VPS as the login user.
eaw_ssh() {
  # shellcheck disable=SC2046
  "$SSH_BIN" $(eaw_ssh_opts) "$VPS_USER@$VPS_HOST" -- "$@"
}

# eaw_ssh_stdin <command> — same, but stdin is passed through (secret files).
eaw_ssh_stdin() {
  # shellcheck disable=SC2046
  "$SSH_BIN" $(eaw_ssh_opts) "$VPS_USER@$VPS_HOST" -- "$1"
}

# eaw_root <command...> — run a command on the VPS with privileges.
#   One argument is treated as a whole shell command line ("a && b"); several are
#   quoted word by word. Both forms are common in this kit.
eaw_root() {
  local q
  if [ "$#" -eq 1 ]; then
    q="$1"
  else
    q="$(printf '%q ' "$@")"
  fi
  if [ -n "${SUDO:-}" ]; then
    eaw_ssh "$SUDO $q"
  else
    eaw_ssh "$q"
  fi
}

# eaw_rsync <args...> — rsync with the kit's ssh transport.
eaw_rsync() {
  "$RSYNC_BIN" -e "$SSH_BIN $(eaw_ssh_opts)" "$@"
}

eaw_reachable() {
  eaw_ssh "true" >/dev/null 2>&1
}

# ── process identity ───────────────────────────────────────────────────────

# eaw_pid_is_ours <pid> <cmdline-needle>
#   Deliberately a COPY of scripts/pidfile.sh's rule (not a source of it):
#   pidfile.sh exits the caller when the off-switch file exists, and cutover.sh
#   has to keep working precisely when that file is present. A PID number is not
#   an identity — the kernel's cmdline is (see scripts/pidfile.sh for the
#   4.5-day outage that taught us this).
eaw_pid_is_ours() {
  local pid="${1:-}" needle="${2:-}"
  [ -n "$pid" ] || return 1
  case "$pid" in *[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  if [ -r "/proc/$pid/cmdline" ]; then
    local cmd
    cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    case "$cmd" in *"$needle"*) return 0 ;; *) return 1 ;; esac
  fi
  return 0
}

# eaw_platform_pids — every live alert process that belongs to THIS repo.
#   Prints "<pid>\t<cmdline>" per line. Identity is checked twice: the cmdline
#   must name the loop/supervisor, and the process's working directory must be
#   inside this repo — so a rehearsal sandbox or a second checkout can never be
#   mistaken for the live worker (and never killed by mistake).
eaw_platform_pids() {
  local pid cmd cwd
  for pid in $("$PGREP" -f "alert-loop|alert-keepalive" 2>/dev/null || true); do
    [ "$pid" = "$$" ] && continue
    cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    case "$cmd" in
      *alert-loop*|*alert-keepalive*) ;;
      *) continue ;;
    esac
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    case "$cwd" in
      "$EAW_REPO_ROOT"|"$EAW_REPO_ROOT"/*) printf '%s\t%s\n' "$pid" "$cmd" ;;
    esac
  done
}

# ── remote facts ───────────────────────────────────────────────────────────

# eaw_remote_mtime <remote-path> — epoch seconds, or 0 when absent.
eaw_remote_mtime() {
  eaw_root "$STAT_BIN -c %Y '$1' 2>/dev/null || echo 0" 2>/dev/null | tr -d '\r' | tail -1
}

# eaw_remote_sha256 <remote-path> — hex digest, or empty.
eaw_remote_sha256() {
  eaw_root "sha256sum '$1' 2>/dev/null | cut -d' ' -f1" 2>/dev/null | tr -d '\r' | tail -1
}

eaw_local_sha256() {
  sha256sum "$1" 2>/dev/null | cut -d' ' -f1
}

# eaw_require_config — the two things the owner has to supply.
eaw_require_config() {
  [ -n "$VPS_HOST" ] || eaw_die "VPS_HOST is not set. Put it in deploy/vps/vps.conf (see vps.conf.example) or export it."
  [ -n "$VPS_USER" ] || eaw_die "VPS_USER is not set. Put it in deploy/vps/vps.conf (see vps.conf.example) or export it."
}
