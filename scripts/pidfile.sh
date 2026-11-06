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

# ── THE MACHINE-LEVEL OFF SWITCH (deploy/vps/cutover.sh, 2026-11-06) ────────
# The alert worker is moving to the owner's VPS. Once it has moved, this machine
# must never run it again — not on boot, not from `bun install` (postinstall), not
# from the vite boot hook, which spawns scripts/alert-keepalive.sh every 60
# seconds and would otherwise bring the worker straight back after a cutover and
# scan alongside the VPS (double credits, duplicate alerts).
#
# The check lives HERE, and not in alert-keepalive.sh or alert-loop.sh, for two
# reasons:
#   · both of those source this file before they can spawn anything, so one guard
#     covers every entry point;
#   · a SOURCED file is read once, at start-up. Editing a shell script that is
#     already running (a `while true` loop) can make bash re-read from a stale
#     byte offset and execute garbage — this file is never executed as a loop, so
#     adding to it is safe while the worker is live.
# rollback.sh removes the file and the platform worker is allowed to run again.
EAW_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EAW_WORKER_OFF_FILE="${EAW_WORKER_OFF_FILE:-$EAW_SCRIPTS_DIR/../.run/alert-worker.disabled}"
if [ -f "$EAW_WORKER_OFF_FILE" ]; then
  echo "[worker $(date -u +%FT%TZ)] alert worker is DISABLED on this machine ($EAW_WORKER_OFF_FILE) — it runs on the VPS now; see deploy/vps/README.md. Not starting."
  exit 0
fi

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
