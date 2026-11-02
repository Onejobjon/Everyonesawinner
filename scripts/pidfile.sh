#!/usr/bin/env bash
# pidfile.sh — shared "is this PID actually OUR process?" check.
#
# THE BUG THIS EXISTS FOR (2026-10-28 → 2026-11-02): after a machine replacement,
# `.run/alert-keepalive.pid` and `.run/alert-loop.pid` survived on disk (files are
# kept) and named PIDs from the OLD machine. The new machine had reassigned those
# numbers to unrelated processes, so `kill -0 <pid>` said "alive" and every
# restart attempt printed "already running — exiting". The worker stayed dead for
# four and a half days while the supervisor believed it was running.
#
# A PID number is not an identity. The kernel tells us the identity in
# /proc/<pid>/cmdline, so the check now requires BOTH: the PID is alive AND its
# command line looks like the process we mean.
#
# Usage (from another script):
#   . "$(dirname "$0")/pidfile.sh"
#   if pid_is_ours "$(cat "$PIDFILE" 2>/dev/null)" "alert-loop"; then ...; fi

# pid_is_ours <pid> <cmdline-substring>
#   0 = the PID is alive AND its command line contains the substring (ours)
#   1 = dead, empty, or a different process (stale — safe to start a new one)
pid_is_ours() {
  local pid="${1:-}" needle="${2:-}"
  [ -n "$pid" ] || return 1
  case "$pid" in
    *[!0-9]*) return 1 ;;   # not a number (a boot id, junk, empty) — stale
  esac
  kill -0 "$pid" 2>/dev/null || return 1

  # The PID is alive. Is it US?
  if [ -r "/proc/$pid/cmdline" ]; then
    local cmd
    cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    case "$cmd" in
      *"$needle"*) return 0 ;;
      *) return 1 ;;       # a live PID that is somebody else — STALE
    esac
  fi

  # No readable /proc (restricted container): assume it is ours rather than risk
  # spawning a second worker. Conservative — never doubles up.
  return 0
}

# The kernel's boot identity — a different value means a different boot, so any
# PID recorded under the old one is meaningless.
boot_id() {
  if [ -r /proc/sys/kernel/random/boot_id ]; then
    cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo "unknown"
  else
    echo "unknown"
  fi
}

# write_pidfile <file> — records "<pid> <boot_id> <iso time>" for the caller.
write_pidfile() {
  local file="$1"
  printf '%s %s %s\n' "$BASHPID" "$(boot_id)" "$(date -u +%FT%TZ)" > "$file"
}

# read_pidfile <file> — the PID out of a pidfile (old files hold just the number,
# new ones hold "pid boot_id time" — the first field is the PID either way).
read_pidfile() {
  awk '{print $1; exit}' "$1" 2>/dev/null || true
}
