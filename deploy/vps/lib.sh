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
#   REMOTE_TMP          scratch dir on the VPS for staged uploads (/tmp)
#   SERVICE / ALARMS_SERVICE / ALARMS_TIMER                    (eaw-alerts.service, …)
#
# TESTING HOOKS — set only by deploy/vps/rehearsal/, never in production:
#   SSH_BIN, RSYNC_BIN, SYSTEMCTL, PGREP, STAT_BIN, UNIT_DIR, EAW_SANDBOX
#
# THE SANDBOX FENCE — EAW_SANDBOX=<throwaway root>. When it is set, eaw_init
# checks every path this kit can write to, and each write site calls
# eaw_guard_write before touching a file. A path that resolves outside the root
# (or into /etc/systemd/system) aborts the run with exit 90 and writes nothing.
# Unset — every real run — the fence is a no-op.
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
  # Scratch space ON THE VPS for staged uploads. A config value so the rehearsal
  # keeps its staging files inside the sandbox instead of /tmp on this machine —
  # the 2026-11-06 rehearsal left /tmp/eaw-secret.odds.env.<pid> behind, which is
  # exactly the kind of outside-the-root write this kit must not do.
  REMOTE_TMP="$(eaw_conf REMOTE_TMP "/tmp")"
  export REMOTE_SITE REMOTE_SECRETS REMOTE_RUN REMOTE_DRY REMOTE_BUN REMOTE_TMP

  SSH_BIN="${SSH_BIN:-ssh}"
  RSYNC_BIN="${RSYNC_BIN:-rsync}"
  SYSTEMCTL="${SYSTEMCTL:-systemctl}"
  PGREP="${PGREP:-pgrep}"
  STAT_BIN="${STAT_BIN:-stat}"
  export SSH_BIN RSYNC_BIN SYSTEMCTL PGREP STAT_BIN

  # The machine-level off switch the platform worker honours (scripts/pidfile.sh).
  OFF_FILE="${OFF_FILE:-$EAW_REPO_ROOT/.run/alert-worker.disabled}"
  export OFF_FILE

  # ── THE SANDBOX FENCE ────────────────────────────────────────────────────
  # deploy/vps/rehearsal/ exports EAW_SANDBOX=<throwaway root>. When that is set,
  # EVERY path this kit can write to must resolve inside that root, and the run
  # aborts (exit 90) before the first byte is written if one does not.
  #
  # This is not belt-and-braces for its own sake. The first rehearsal (2026-11-06
  # 15:08) wrote three eaw-* units into the REAL /etc/systemd/system, because
  # UNIT_DIR was only configurable, not fenced. The machine had no systemd so they
  # were inert, and the lead deleted them — but a harness that can write outside
  # its root is a defect, not an accident. Each write site also calls
  # eaw_guard_write itself; this early pass catches a bad vps.conf before any
  # script gets far enough to try.
  if [ -n "${EAW_SANDBOX:-}" ]; then
    eaw_guard_write "$UNIT_DIR"             "write systemd units"
    eaw_guard_write "$LOCAL_RUN_DIR"        "write the platform worker state"
    eaw_guard_write "$OFF_FILE"             "write the off switch"
    eaw_guard_write "$EAW_REPO_ROOT/.run"   "write cutover/rollback records"
    eaw_guard_write "$REMOTE_ROOT"          "write the remote install root"
    eaw_guard_write "$REMOTE_SITE"          "write the remote repo"
    eaw_guard_write "$REMOTE_SECRETS"       "write the remote secrets"
    eaw_guard_write "$REMOTE_RUN"           "write the remote worker state"
    eaw_guard_write "$REMOTE_DRY"           "write the remote dry-run state"
    eaw_guard_write "$REMOTE_TMP"           "stage uploads on the remote"
    eaw_guard_write "$EAW_LEGACY_SECRETS"   "link the legacy secret paths"
  fi
}

# ── the sandbox fence ──────────────────────────────────────────────────────

# eaw_resolve_path <path> — the path with every symlink and every "." / ".."
#   resolved, including the parts that do not exist yet (the deepest existing
#   ancestor is resolved with `pwd -P`, the rest is appended). Prints the result.
eaw_resolve_path() {
  local p="$1" tail="" d
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  while [ ! -d "$p" ]; do
    case "$p" in /) break ;; esac
    tail="/$(basename "$p")$tail"
    p="$(dirname "$p")"
  done
  d="$(cd "$p" 2>/dev/null && pwd -P)" || return 1
  printf '%s%s' "$d" "$tail"
}

# eaw_guard_write <path> [what] — REFUSE to write outside the sandbox root.
#   Aborts with exit 90 (EAW_GUARD_EXIT) and writes nothing. A no-op when
#   EAW_SANDBOX is unset, which is every real run: on a real VPS the unit
#   directory IS /etc/systemd/system and that is correct.
eaw_guard_write() {
  local p="${1:-}" what="${2:-write}" root real
  root="${EAW_SANDBOX:-}"
  [ -n "$root" ] || return 0
  if [ -z "$p" ]; then
    eaw_guard_fail "$what" "(empty path)" "(nothing)" "$root"
  fi
  case "$p" in
    /*) ;;
    *) eaw_guard_fail "$what" "$p (relative)" "$p" "$root" ;;
  esac
  # The one path this kit exists to keep off a rehearsal machine. Named
  # explicitly so the message says what nearly happened, not just "outside".
  case "$p" in
    /etc/systemd/system|/etc/systemd/system/*)
      eaw_guard_fail "$what" "$p" "$p" "$root" ;;
  esac
  root="$(cd "$root" 2>/dev/null && pwd -P)" || eaw_guard_fail "$what" "$p" "$root (missing)" "$root"
  if [ -L "$p" ]; then
    # A symlink is followed: a link inside the root that points at /etc is an
    # escape, and this is the check that catches it.
    real="$(readlink -f "$p" 2>/dev/null || true)"
    [ -n "$real" ] || real="$p"
  else
    real="$(eaw_resolve_path "$p")" || eaw_guard_fail "$what" "$p" "$p (unresolvable)" "$root"
  fi
  case "$real" in
    "$root"|"$root"/*) return 0 ;;
  esac
  eaw_guard_fail "$what" "$p" "$real" "$root"
}

# eaw_guard_fail <what> <path> <resolved> <root> — the abort itself.
eaw_guard_fail() {
  printf '[eaw] SANDBOX ESCAPE BLOCKED: %s would write %s\n' "$1" "$2" >&2
  printf '[eaw]   resolves to: %s\n' "$3" >&2
  printf '[eaw]   sandbox root: %s\n' "$4" >&2
  printf '[eaw] NOTHING WAS WRITTEN. A rehearsal may only touch files inside its own root.\n' >&2
  exit "${EAW_GUARD_EXIT:-90}"
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
    # The kernel appends " (deleted)" when the directory has been removed under a
    # running process. A worker whose tree was deleted is STILL our worker and
    # must still be stopped — reading it as "not ours" is how a rehearsal left
    # fake workers alive across runs.
    cwd="${cwd% (deleted)}"
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

# ── sync-state.sh's two rules, as pure functions ───────────────────────────
# Kept here (rather than inline in sync-state.sh) so `bun test` can cover them
# offline: test/vps-kit.test.ts calls these directly instead of pretending to be
# an ssh server. sync-state.sh calls exactly these, so the tested code IS the
# code that runs.

# eaw_state_refuses_newer <local-mtime> <remote-mtime> [skew]
#   0 = REFUSE: the remote copy is newer, so it must not be overwritten.
#       Remote newer means the VPS has already scanned; the VPS is the truth.
#   1 = safe to copy (local is newer, or the same age within <skew>).
eaw_state_refuses_newer() {
  local lmt="${1:-0}" rmt="${2:-0}" skew="${3:-0}"
  case "$lmt" in ''|*[!0-9]*) lmt=0 ;; esac
  case "$rmt" in ''|*[!0-9]*) rmt=0 ;; esac
  case "$skew" in ''|*[!0-9-]*) skew=0 ;; esac
  [ "$rmt" -gt "$((lmt + skew))" ]
}

# eaw_state_same <local-sha> <remote-sha>
#   0 = identical bytes already on the VPS (nothing to do).
#   An empty either side is never "the same" — a missing remote file is a copy.
eaw_state_same() {
  local l="${1:-}" r="${2:-}"
  [ -n "$l" ] && [ -n "$r" ] && [ "$l" = "$r" ]
}

# eaw_require_config — the two things the owner has to supply.
eaw_require_config() {
  [ -n "$VPS_HOST" ] || eaw_die "VPS_HOST is not set. Put it in deploy/vps/vps.conf (see vps.conf.example) or export it."
  [ -n "$VPS_USER" ] || eaw_die "VPS_USER is not set. Put it in deploy/vps/vps.conf (see vps.conf.example) or export it."
}
