#!/usr/bin/env bash
# make-sandbox.sh <dir> — build a throwaway "VPS + platform machine" so the whole
# kit can be rehearsed on one box with no VPS, no root, no systemd and no network.
#
# WHAT IS SIMULATED, EXPLICITLY (say it out loud, it is the honest part):
#   · ssh        → a stub that runs the remote command LOCALLY, so the remote
#                  script really executes — against $S/remote instead of /
#   · rsync      → a stub that rewrites user@host:/path to a local path
#   · systemd    → a stub state machine (enabled/, active/ files + a call log)
#   · useradd/id → a stub user database (sysd/users/)
#   · chown      → recorded and ignored (the sandbox has no `eaw` account)
#   · journald   → a file
#   · the worker → fake alert-loop.sh / alert-keepalive.sh that take pidfiles and
#                  sleep, so no odds API call is ever made
# What is REAL: the kit's own scripts, the real scripts/pidfile.sh off-switch
# guard, the real systemd unit templates, real file modes, real mtimes, real
# process identity (a live pid with the right cmdline and cwd), real rsync, real
# kill/kill -0.
#
# Prints the sandbox path on success. Exits non-zero if it cannot build.
set -uo pipefail
S="${1:?usage: make-sandbox.sh <dir>}"
REAL_KIT="$(cd "$(dirname "$0")/.." && pwd)"
REAL_REPO="$(cd "$REAL_KIT/../.." && pwd)"

mkdir -p "$S"
S="$(cd "$S" && pwd)"
[ -e "$S/.sandbox" ] || { [ -z "$(ls -A "$S" 2>/dev/null)" ] || { echo "make-sandbox: $S is not empty and is not a sandbox" >&2; exit 1; }; }
rm -rf "$S"/*
: > "$S/.sandbox"

mkdir -p "$S/bin" \
         "$S/remote/opt/eaw/site/.run" "$S/remote/opt/eaw/secrets" \
         "$S/remote/etc/systemd/system" "$S/remote/tmp" "$S/remote/home/eaw" \
         "$S/remote/usr/local/bin" \
         "$S/repo/scripts" "$S/repo/.run" "$S/repo/src/server" "$S/repo/deploy/vps" \
         "$S/secrets" "$S/state" "$S/sysd/enabled" "$S/sysd/active" "$S/sysd/users"

export EAW_SANDBOX="$S"

# ── the kit itself, copied into the sandbox repo (this is what gets deployed) ─
cp -R "$REAL_KIT/." "$S/repo/deploy/vps/"
rm -rf "$S/repo/deploy/vps/rehearsal"

# ── fake worker scripts ────────────────────────────────────────────────────
# The REAL pidfile.sh: the off-switch guard is the thing under test.
cp "$REAL_REPO/scripts/pidfile.sh" "$S/repo/scripts/pidfile.sh"
cp "$REAL_REPO/scripts/ensure-alert-worker.sh" "$S/repo/scripts/ensure-alert-worker.sh"

cat > "$S/repo/scripts/alert-loop.sh" <<'LOOP'
#!/usr/bin/env bash
# SANDBOX fake: takes a pidfile and sleeps. Never touches the odds API.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/.." || exit 1
. "$HERE/pidfile.sh"
mkdir -p .run
printf '%s 0000 %s\n' "$BASHPID" "$(date -u +%FT%TZ)" > .run/alert-loop.pid
trap 'rm -f .run/alert-loop.pid' EXIT
# A "scan" every 2 seconds, so the scan-freshness checks have something real to
# read (the real loop writes this file after every completed scan).
while true; do
  printf '{"ts":"%s","checked":1,"alerted":0}' "$(date -u +%FT%TZ)" > .run/alerts-last-scan.json
  sleep 2
done
LOOP

cat > "$S/repo/scripts/alert-keepalive.sh" <<'KEEP'
#!/usr/bin/env bash
# SANDBOX fake supervisor: takes a pidfile, starts the fake loop, sleeps.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/.." || exit 1
. "$HERE/pidfile.sh"
mkdir -p .run
printf '%s 0000 %s\n' "$BASHPID" "$(date -u +%FT%TZ)" > .run/alert-keepalive.pid
trap 'rm -f .run/alert-keepalive.pid' EXIT
setsid nohup bash scripts/alert-loop.sh >> .run/alerts.log 2>&1 < /dev/null &
while true; do sleep 2; done
KEEP

cat > "$S/repo/src/server/alerts.ts" <<'ALERTS'
// SANDBOX fake of the alert worker: records a scan, adds one seen key, exits.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.ALERTS_RUN_DIR || join(process.cwd(), ".run");
mkdirSync(dir, { recursive: true });
const seenFile = join(dir, "alerts-seen.json");
const seen: string[] = existsSync(seenFile) ? JSON.parse(readFileSync(seenFile, "utf8")) : [];
const key = `cash|fixture-${Date.now()}|HOME|2.1|2.2`;
if (!seen.includes(key)) {
  seen.push(key);
  if (process.env.EAW_ALERT_DRY_RUN === "1") {
    console.log(`[alerts] [dry-run] WOULD ALERT cash | Fixture vs Fixture | HOME @ 2.1 / lay 2.2`);
  }
  writeFileSync(seenFile, JSON.stringify(seen));
}
writeFileSync(join(dir, "alerts-last-scan.json"), JSON.stringify({ ts: new Date().toISOString(), checked: 1, alerted: 1 }));
console.log(`ALERT_ONCE result={"checked":1,"alerted":1}`);
ALERTS

chmod +x "$S/repo/scripts/"*.sh

# ── sandbox config (the real kit reads this) ───────────────────────────────
cat > "$S/repo/deploy/vps/vps.conf" <<CONF
VPS_HOST="127.0.0.1"
VPS_USER="root"
VPS_PORT="2222"
SSH_KEY="$S/fake_key"
SUDO=""
REMOTE_ROOT="$S/remote/opt/eaw"
EAW_USER="eaw"
LOCAL_SECRETS_DIR="$S/secrets"
LOCAL_RUN_DIR="$S/repo/.run"
UNIT_DIR="$S/remote/etc/systemd/system"
EAW_LEGACY_SECRETS="$S/legacy"
CONF
chmod 600 "$S/repo/deploy/vps/vps.conf"
ssh-keygen -q -t ed25519 -N '' -f "$S/fake_key" >/dev/null 2>&1 || printf 'not-a-real-key\n' > "$S/fake_key"
chmod 600 "$S/fake_key"

# ── secrets (canary values: if these ever reach stdout, the test fails) ─────
printf 'ODDS_API_KEY=CANARY-ODDS-KEY-0f3a9\n' > "$S/secrets/odds.env"
printf '# canary\nTELEGRAM_BOT_TOKEN=CANARY-TELEGRAM-TOKEN-77\nTELEGRAM_CHAT_ID=1\nTELEGRAM_ALERTS_CHAT_ID=2\nTELEGRAM_ADMIN_CHAT_ID=3\n' > "$S/secrets/telegram.env"
chmod 600 "$S/secrets/odds.env" "$S/secrets/telegram.env"

# ── the platform machine's worker state ────────────────────────────────────
printf '["cash|old-1|HOME|1.9|2.0","cash|old-2|AWAY|3.1|3.2"]' > "$S/repo/.run/alerts-seen.json"
printf '{"ts":"%s","checked":3,"alerted":0}' "$(date -u -d '-2 hours' +%FT%TZ)" > "$S/repo/.run/alerts-last-scan.json"
touch -d '-2 hours' "$S/repo/.run/alerts-last-scan.json"
printf '{"fixtures":19}' > "$S/repo/.run/alerts-cache.json"
printf '{"fixturesInWindow":102}' > "$S/repo/.run/alerts-sports-index.json"
printf '{"daykey":"2026-11-06"}' > "$S/repo/.run/heartbeat.json"
printf '{"at":"2026-11-06T10:00:00Z"}' > "$S/repo/.run/gap-alarm-last-run.json"

# ── stubs ──────────────────────────────────────────────────────────────────
stub() { printf '%s\n' "$2" > "$S/bin/$1"; chmod +x "$S/bin/$1"; }

stub ssh '#!/usr/bin/env bash
# SANDBOX ssh: runs the "remote" command locally.
S="${EAW_SANDBOX:?}"
if [ -f "$S/remote/OFFLINE" ]; then
  echo "ssh: connect to host 127.0.0.1 port 2222: Connection refused" >&2
  exit 255
fi
echo "ssh $*" >> "$S/sysd/calls.log"
while [ $# -gt 0 ]; do
  case "$1" in
    -p|-i|-o|-l|-F) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
shift                      # user@host
[ "${1:-}" = "--" ] && shift
exec bash -c "$*"'

stub rsync '#!/usr/bin/env bash
# SANDBOX rsync: rewrites user@host:/path to a local path.
S="${EAW_SANDBOX:?}"
args=()
for a in "$@"; do
  case "$a" in
    *@*:*)
      p="${a#*:}"
      case "$p" in
        "$S"/*) args+=("$p") ;;
        /tmp/*) args+=("$p") ;;
        *) args+=("$S/remote$p") ;;
      esac
      ;;
    *) args+=("$a") ;;
  esac
done
echo "rsync $*" >> "$S/sysd/calls.log"
exec /usr/bin/rsync "${args[@]}"'

stub systemctl '#!/usr/bin/env bash
# SANDBOX systemctl: a state machine over $S/sysd/{enabled,active}/.
S="${EAW_SANDBOX:?}"
D="$S/sysd"; mkdir -p "$D/enabled" "$D/active"
echo "systemctl $*" >> "$D/calls.log"
act=""; unit=""
for a in "$@"; do
  case "$a" in
    enable|disable|start|stop|restart|is-active|is-enabled|daemon-reload|show|status|kill) act="$a" ;;
    -*) ;;
    *) unit="$a" ;;
  esac
done
RUNDIR="$S/remote/opt/eaw/site/.run"
case "$act" in
  enable)   touch "$D/enabled/$unit"; exit 0 ;;
  disable)  rm -f "$D/enabled/$unit"; exit 0 ;;
  is-enabled) [ -f "$D/enabled/$unit" ] && exit 0 || exit 1 ;;
  is-active) [ -f "$D/active/$unit" ] && { echo active; exit 0; } || { echo inactive; exit 3; } ;;
  start)
    if [ "$unit" = "eaw-alerts.service" ] && [ -n "${EAW_STUB_FAIL_START:-}" ]; then
      echo "stub: job for $unit failed" >&2; exit 1
    fi
    # THE DOUBLE-WORKER ASSERTION: at the instant the VPS worker is started,
    # no platform worker may be alive. Recorded in calls.log so a test can grep
    # for it — this is what "cutover cannot leave two workers running" means.
    if [ "$unit" = "eaw-alerts.service" ]; then
      alive=""
      for pid in $(pgrep -f "alert-loop|alert-keepalive" 2>/dev/null); do
        cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
        case "$cwd" in "$S/repo"|"$S/repo"/*) alive="$alive $pid" ;; esac
      done
      if [ -n "$alive" ]; then
        echo "DOUBLE-WORKER-RISK:$alive" >> "$D/calls.log"
      else
        echo "PLATFORM-CLEAN" >> "$D/calls.log"
      fi
    fi
    touch "$D/active/$unit"
    if [ "$unit" = "eaw-alerts.service" ] && [ -z "${EAW_STUB_NO_SCAN:-}" ]; then
      mkdir -p "$RUNDIR"
      printf "{\"ts\":\"%s\",\"checked\":19,\"alerted\":0}" "$(date -u +%FT%TZ)" > "$RUNDIR/alerts-last-scan.json"
    fi
    exit 0 ;;
  stop)     rm -f "$D/active/$unit"; exit 0 ;;
  show)     case "$*" in *MainPID*) echo "4242" ;; esac; exit 0 ;;
  *)        exit 0 ;;
esac'

stub journalctl '#!/usr/bin/env bash
S="${EAW_SANDBOX:?}"; cat "$S/sysd/journal.log" 2>/dev/null || true; exit 0'

stub id '#!/usr/bin/env bash
S="${EAW_SANDBOX:?}"
if [ "${1:-}" = "-u" ] && [ -n "${2:-}" ]; then
  if [ -f "$S/sysd/users/$2" ]; then echo 1001; exit 0; fi
  echo "id: \"$2\": no such user" >&2; exit 1
fi
exec /usr/bin/id "$@"'

stub useradd '#!/usr/bin/env bash
S="${EAW_SANDBOX:?}"; u=""
for a in "$@"; do case "$a" in -*) ;; *) u="$a" ;; esac; done
mkdir -p "$S/sysd/users"; : > "$S/sysd/users/$u"
echo "useradd $*" >> "$S/sysd/calls.log"'

stub groupadd '#!/usr/bin/env bash
S="${EAW_SANDBOX:?}"; echo "groupadd $*" >> "$S/sysd/calls.log"'

stub chown '#!/usr/bin/env bash
S="${EAW_SANDBOX:?}"; echo "chown $*" >> "$S/sysd/calls.log"; exit 0'

stub curl '#!/usr/bin/env bash
# SANDBOX curl: no network, ever.
echo "curl: (6) Could not resolve host" >&2; exit 6'

stub su '#!/usr/bin/env bash
# SANDBOX su: run the -c command locally, ignore the user switch.
S="${EAW_SANDBOX:?}"; cmd=""
while [ $# -gt 0 ]; do
  case "$1" in
    -s) shift 2 ;;
    -c) shift; cmd="$1"; shift ;;
    *) shift ;;
  esac
done
exec bash -c "$cmd"'

printf 'sandbox: %s\n' "$S"
printf 'repo:    %s\n' "$S/repo"
printf 'remote:  %s\n' "$S/remote"
exit 0
