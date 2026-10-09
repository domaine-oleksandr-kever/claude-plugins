#!/usr/bin/env bash
#
# worktree-theme.sh — the Shopify half of a worktree that base's `/base:worktree` created (it copies
# `shopify.theme.toml` because fe's `worktree copy list:` names it, and knows nothing about themes).
#
# Two things, once the worktree exists:
#   1. The copied `shopify.theme.toml` is routinely the SOURCE checkout's pinned config (that
#      checkout ran its own preview). Inheriting its session theme is worse than inheriting
#      nothing: this worktree's first `create-preview-theme.sh create` would pull another stream's
#      customizer settings. So the pin is undone in the copy (`session-theme.sh unpin`) and the
#      worktree starts from the shared dev theme. Done ONCE per worktree: a stamp in the worktree's
#      own git dir (`fe-worktree-theme`, gone with the worktree) makes every later run report
#      `toml_unpinned=already`, so a pin this worktree has since made for itself is never undone.
#   2. The dev-server line for THIS checkout: `npm run dev -- --theme <session-theme-id>` on a
#      Foundation checkout, `shopify theme dev --theme <session-theme-id>` on any other (the word
#      project-profile.sh prints; a silent probe keeps the Foundation line), with the worktree's dev
#      port — `--port`, else the `dev-port:` that worktree-setup.sh recorded for this worktree in the
#      shared `.claude/tasks/*/notes.md`. The caller fills `<session-theme-id>` in once the session
#      theme is settled; the line never appears without `--theme`, since a dev server started
#      without it syncs this branch into the SHARED dev theme the copied config names.
#
# Runs from anywhere — the main checkout's session right after `/base:worktree`, or the worktree's
# own session (`worktree-theme.sh .`). Refuses a directory that is not inside a LINKED worktree: on
# the main checkout the un-pin would undo that checkout's own session pin. Never prints a byte of
# the toml (it holds the Theme Access token).
#
# Usage:
#   worktree-theme.sh <worktree-dir> [--port <n>]
#       → worktree=… toml=present|missing toml_unpinned=yes|no|already|failed
#         profile=foundation|theme|none|unknown dev_port=<n>|unknown   followed by the hand-off block
#   worktree-theme.sh --help
#
# toml_unpinned: yes = a pin was reverted now; no = the copy carried none; already = an earlier run
# settled this worktree; failed = a pin is there but the rewrite failed (`warn=toml_unpin_failed`,
# no stamp, so the next run retries). toml=missing prints `warn=no_shopify_theme_toml` and leaves no
# stamp either: a config copied in later is still un-pinned by the next run.
#
# Output is `key=value` lines on stdout; non-fatal problems print `warn=<reason>`. Errors print
# `error=<reason>` on STDOUT (the calling skill relays the output verbatim) — exit 2 for a usage
# error, 1 for anything else. Requires: git.

set -euo pipefail
export LC_ALL=C

USAGE='usage: worktree-theme.sh <worktree-dir> [--port <n>]'
STAMP_NAME="fe-worktree-theme"

fail() { printf 'error=%s\n' "$1"; exit 1; }
usage_fail() { printf 'error=usage: %s (%s)\n' "$1" "$USAGE"; exit 2; }
warn() { printf 'warn=%s\n' "$1"; }

for _a in ${1+"$@"}; do
  case "$_a" in
    -h|--help) sed -n '/^# Usage:/,/^#   worktree-theme.sh --help$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  esac
done

DIR=""; PORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      [ $# -ge 2 ] || usage_fail "--port needs a value"
      case "$2" in ''|*[!0-9]*) usage_fail "--port takes a number" ;; esac
      PORT="$2"; shift 2 ;;
    -*) usage_fail "unknown arg: $1" ;;
    *)
      [ -z "$DIR" ] || usage_fail "one worktree directory only"
      DIR="$1"; shift ;;
  esac
done
[ -n "$DIR" ] || usage_fail "no worktree directory"
[ -d "$DIR" ] || fail "no_such_dir dir=$DIR"

command -v git >/dev/null 2>&1 || fail "git not found on PATH"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SESSION_LIB="$SCRIPT_DIR/session-theme.sh"
[ -f "$SESSION_LIB" ] || fail "session_lib_not_found path=$SESSION_LIB"

WT="$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$WT" ] || fail "not_a_git_checkout dir=$DIR"
GD="$(git -C "$WT" rev-parse --absolute-git-dir 2>/dev/null || true)"
CD="$(git -C "$WT" rev-parse --git-common-dir 2>/dev/null || true)"
case "$CD" in /*) ;; *) CD="$WT/$CD" ;; esac
CD="$(cd "$CD" 2>/dev/null && pwd -P || true)"
GD_PHYS="$(cd "$GD" 2>/dev/null && pwd -P || true)"
[ -n "$GD_PHYS" ] && [ -n "$CD" ] && [ "$GD_PHYS" != "$CD" ] || \
  fail "not_a_linked_worktree dir=$WT (this is a main checkout — its own session pin stays; run this on a worktree /base:worktree made)"

TOML_FILE="$WT/shopify.theme.toml"
STAMP="$GD/$STAMP_NAME"
if [ ! -f "$TOML_FILE" ]; then
  TOML=missing; UNPINNED=no
  warn "no_shopify_theme_toml — the worktree has no store config; copy one in (or re-run /base:worktree from the main checkout) before pushing a preview theme, then run this again"
else
  TOML=present
  if [ -f "$STAMP" ]; then UNPINNED=already
  else
    st=0; bash "$SESSION_LIB" unpin "$TOML_FILE" >/dev/null 2>&1 || st=$?
    case "$st" in
      0) UNPINNED=yes ;;
      1) UNPINNED=no ;;
      *) UNPINNED=failed
         warn "toml_unpin_failed — the copied config still carries the source checkout's session pin; restore its superseded theme line by hand before the first create" ;;
    esac
    if [ "$UNPINNED" != failed ]; then
      date -u +%Y-%m-%dT%H:%M:%SZ > "$STAMP" 2>/dev/null || \
        warn "stamp_not_written path=$STAMP — a later run would un-pin again; run this once only"
    fi
  fi
fi

PROFILE="$(bash "$SCRIPT_DIR/project-profile.sh" "$WT" 2>/dev/null || true)"
case "$PROFILE" in foundation|theme|none) ;; *) PROFILE=unknown ;; esac

if [ -z "$PORT" ]; then
  # worktree-setup.sh's notes line: "- <date> worktree `<path>` on branch `<b>`, dev-port: <n>"
  PORT="$(cat "$WT"/.claude/tasks/*/notes.md 2>/dev/null \
    | grep -F "worktree \`$WT\`" | grep -oE 'dev-port: [0-9]+' | tail -1 | tr -dc '0-9' || true)"
fi

DEV_CMD='npm run dev -- --theme <session-theme-id>'
case "$PROFILE" in theme|none) DEV_CMD='shopify theme dev --theme <session-theme-id>' ;; esac

printf 'worktree=%s\n' "$WT"
printf 'toml=%s\n' "$TOML"
printf 'toml_unpinned=%s\n' "$UNPINNED"
printf 'profile=%s\n' "$PROFILE"
printf 'dev_port=%s\n' "${PORT:-unknown}"

printf '\nnext:\n'
printf '  # dev server:  %s --port %s\n' "$DEV_CMD" "${PORT:-<dev-port>}"
printf '  # pin first: /fe:preview-theme creates or pins this worktree'"'"'s session theme into its own shopify.theme.toml; until then the config names the SHARED dev theme\n'
