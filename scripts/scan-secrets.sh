#!/usr/bin/env bash
# scan-secrets.sh — fail loudly if a credential shape appears in the tree.
#
# WHY: this repo is PUBLIC and a live The Odds API key was committed in
# src/server/odds-key.ts (removed 2026-10-27). This scanner is the tripwire that
# stops it happening again: it runs as `prebuild`, so every publish and every
# `bun run build` refuses to proceed while a secret shape is in the working tree.
#
# USAGE
#   bash scripts/scan-secrets.sh              # working tree — exit 1 on findings
#   bash scripts/scan-secrets.sh --history    # + `git log -p` history — exit 2 on findings
#   bash scripts/scan-secrets.sh --quiet      # only print on findings
#
# It never prints a full match: hits are shown masked (first 4 … last 2 chars), so
# running it is safe in a log or a chat message.
set -u
cd "$(dirname "$0")/.." || exit 1

MODE_TREE=1
MODE_HISTORY=0
QUIET=0
for a in "$@"; do
  case "$a" in
    --history) MODE_HISTORY=1 ;;
    --quiet) QUIET=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 64 ;;
  esac
done

IGNORE_FILE=".secretscanignore"
# Paths never scanned: build output, deps, our own runtime state.
EXCLUDES=(--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist
          --exclude-dir=.run --exclude-dir=.secrets --exclude-dir=coverage
          --exclude=scan-secrets.sh --exclude=.secretscanignore --exclude=alerts-seen.json)

# Pattern table: label|extended-regex
PATTERNS=(
  '32-hex-char string (API key shape)|[^0-9a-fA-F][0-9a-f]{32}([^0-9a-f]|$)'
  'Stripe secret/publishable key|(sk|pk|rk)_(live|test)_[0-9A-Za-z]{10,}'
  'Telegram bot token|[0-9]{8,10}:[A-Za-z0-9_-]{30,}'
  'Private key block|-----BEGIN [A-Z ]*PRIVATE KEY-----'
)

mask() { # mask a match so it is safe to print
  local s="$1"
  if [ ${#s} -le 8 ]; then printf '****'; return; fi
  printf '%s…%s' "${s:0:4}" "${s: -2}"
}

# Optional per-line allowlist: "<path glob or substring>|<context regex>"
# e.g. src/server/users.ts|dummySalt
allowed() { # $1=file $2=line
  [ -f "$IGNORE_FILE" ] || return 1
  local glob ctx
  while IFS='|' read -r glob ctx; do
    case "$glob" in ''|'#'*) continue ;; esac
    # shellcheck disable=SC2053
    [[ "$1" == $glob ]] || continue
    printf '%s' "$2" | grep -Eq "$ctx" && return 0
  done < "$IGNORE_FILE"
  return 1
}

FOUND=0
report() { # $1=file $2=line $3=label $4=masked
  printf '  %s:%s  %s  match=%s\n' "$1" "$2" "$3" "$4"
  FOUND=$((FOUND + 1))
}

if [ "$MODE_TREE" = 1 ]; then
  [ "$QUIET" = 1 ] || echo "[scan-secrets] scanning working tree…"
  for entry in "${PATTERNS[@]}"; do
    label="${entry%%|*}"; re="${entry#*|}"
    while IFS= read -r hit; do
      [ -n "$hit" ] || continue
      file="${hit%%:*}"
      rest="${hit#*:}"
      line="${rest%%:*}"
      text="${rest#*:}"
      allowed "$file" "$text" && { [ "$QUIET" = 1 ] || echo "  (allowed) $file:$line"; continue; }
      m="$(printf '%s' "$text" | grep -Eo -e "$re" | head -1)"
      report "$file" "$line" "$label" "$(mask "${m:0:${#m}}")"
    done < <(grep -rEnI "${EXCLUDES[@]}" -e "$re" . 2>/dev/null | sed 's|^\./||')
  done

  if [ "$FOUND" -gt 0 ]; then
    echo "[scan-secrets] FAIL: $FOUND credential-shaped hit(s) in the working tree." >&2
    echo "[scan-secrets] Remove the literal — read it from process.env or /home/team/shared/.secrets/*.env instead." >&2
    echo "[scan-secrets] If a value is genuinely not a secret, allowlist it in $IGNORE_FILE as: <path>|<context regex>" >&2
    exit 1
  fi
  [ "$QUIET" = 1 ] || echo "[scan-secrets] working tree clean (0 hits)"
fi

if [ "$MODE_HISTORY" = 1 ]; then
  [ "$QUIET" = 1 ] || echo "[scan-secrets] scanning git history (git log -p)…"
  git log -p --all --pretty=format:'@@COMMIT %h %ad %s' --date=short > /tmp/.secretscan-history 2>/dev/null
  HIST=0
  for entry in "${PATTERNS[@]}"; do
    label="${entry%%|*}"; re="${entry#*|}"
    # grep does the matching (awk/mawk cannot compile {32} intervals); awk only
    # maps the hit line back to its commit and file.
    lines="$(grep -En -e "$re" /tmp/.secretscan-history 2>/dev/null | cut -d: -f1 | head -25)"
    [ -n "$lines" ] || continue
    n=0
    while read -r ln; do
      [ -n "$ln" ] || continue
      where="$(awk -v target="$ln" 'NR<=target{ if (/^@@COMMIT /) { c=$2 " " $3 " " $4 } if (/^\+\+\+ /) { f=$2 } } NR==target { print f "\t" c; exit }' /tmp/.secretscan-history)"
      printf '  HISTORY %s (commit %s)  %s\n' "${where%%$'\t'*}" "${where#*$'\t'}" "$label"
      n=$((n + 1))
    done <<< "$lines"
    echo "  … $n historical line(s) matching: $label"
    HIST=$((HIST + n))
  done
  rm -f /tmp/.secretscan-history
  if [ "$HIST" -gt 0 ]; then
    echo "[scan-secrets] HISTORY: $HIST line(s) of credential shapes found in past commits (exit 2)."
    echo "[scan-secrets] History is NOT rewritten — a published secret is treated as compromised and rotated instead."
    exit 2
  fi
  [ "$QUIET" = 1 ] || echo "[scan-secrets] history clean (0 hits)"
fi

exit 0
