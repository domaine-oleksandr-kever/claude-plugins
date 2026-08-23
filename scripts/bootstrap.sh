#!/usr/bin/env bash
# fnd bootstrap — one command from a clean machine to an installed plugin
# (shape decision: the rustup-style one-liner, NOT a globally registered CLI, so there is
# exactly one distribution channel and it is this repo).
# Two invocation modes:
#   piped   curl -fsSL https://raw.githubusercontent.com/domaine-oleksandr-kever/claude-plugins/main/scripts/bootstrap.sh | bash
#           (flags: `| bash -s -- --targets cursor,opencode --yes`)
#   direct  ./scripts/bootstrap.sh   — from inside a checkout; the clone step is skipped and
#           this checkout is the one installed
# It owns four things only — the clone, the host picker, the Claude Code instruction block and
# the "what is left to do by hand" report; every real install is delegated to install.sh, which
# already does the linking, the ff-only update and the doctor run.
# Deliberately carries NO version stamp: it is always fetched from `main`, and the versions live
# in the clone it produces.
set -euo pipefail

# The one hardcoded fact a piped run cannot discover: where the plugin comes from. Kept as a
# single unconditional assignment so tests can retarget it at a local bare origin.
REPO_URL="https://github.com/domaine-oleksandr-kever/claude-plugins.git"
# `${HOME:-}` so the HOME-free paths (--help, a claude-only run) survive `set -u`; every use
# that actually needs the default destination re-checks HOME first.
DEFAULT_DIR="${HOME:-}/tools/claude-plugins"

DIR=""
TARGETS=""
# Separate from an empty TARGETS: `--targets ""` is a typo (an unset shell variable in someone's
# wrapper), and answering it with "then install everything" is the one reading it cannot have.
TARGETS_SET="no"
ASSUME_YES="no"
COPY="no"
ACTION="install"

usage() {
  cat <<EOF
usage: bootstrap.sh [--dir <path>] [--targets <csv>] [--yes] [--copy] [--uninstall]

  piped:  curl -fsSL <raw-url>/scripts/bootstrap.sh | bash -s -- --targets cursor --yes
  direct: ./scripts/bootstrap.sh --targets cursor,opencode

  --dir <path>      where to clone (default: \$HOME/tools/claude-plugins); ignored when this
                    script runs from inside a checkout
  --targets <csv>   cursor,codex,opencode,claude or all — hosts to install for, in that order;
                    --target is accepted as an alias. Without it, and with a terminal to ask
                    on, you get a picker
  --yes             accept the defaults and never prompt (the default destination, and every
                    host when --targets is absent)
  --copy            passed through to install.sh (copy instead of symlink)
  --uninstall       remove what install.sh created for the selected hosts; needs an existing
                    checkout (--dir or a direct run) and never clones
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    # A following flag is not a value: `--dir --yes` must refuse, not clone into "./--yes"
    # (the `--dir=<path>` form is the escape hatch for a path that really starts with `-`).
    --dir)
      if [ $# -lt 2 ] || [ "${2#-}" != "$2" ]; then
        echo "error: --dir needs a value (for a path starting with '-', use --dir=<path>)" >&2; exit 2
      fi
      DIR="$2"; shift 2 ;;
    --dir=*) DIR="${1#--dir=}"; shift ;;
    # --target is the spelling install.sh uses, so people type it here too; both take the csv
    --targets|--target) [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }; TARGETS="$2"; TARGETS_SET="yes"; shift 2 ;;
    --targets=*) TARGETS="${1#--targets=}"; TARGETS_SET="yes"; shift ;;
    --target=*) TARGETS="${1#--target=}"; TARGETS_SET="yes"; shift ;;
    --yes|-y) ASSUME_YES="yes"; shift ;;
    --copy) COPY="yes"; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

# --------------------------------------------------------------------------- interaction --
# A piped run reads its own source on stdin, so prompts can only come from /dev/tty. `-t 1` is
# the second half of the gate: a menu written where nobody can read it is a hang, not a prompt.
tty_available() {
  if [ "$ASSUME_YES" = "yes" ]; then return 1; fi
  [ -t 1 ] || return 1
  ( : < /dev/tty ) 2>/dev/null
}

ANSWER=""
# End of input is not consent. Collapsing "pressed Enter" and "closed the input" into the same
# answer would make Ctrl-D — the way people back out of a `curl … | bash` they did not mean to
# finish — mean yes to every default: every host, and a fresh clone on top. A read that fails
# after picking up a partial line (no trailing newline) still has an answer, and that answer is
# honoured; only an empty EOF aborts.
ask() {
  local question="$1" fallback="$2" reply=""
  printf '%s' "$question" > /dev/tty
  if ! IFS= read -r reply < /dev/tty && [ -z "$reply" ]; then
    echo >&2
    echo "error: aborted at the prompt (end of input) — nothing was installed" >&2
    exit 2
  fi
  [ -n "$reply" ] || reply="$fallback"
  ANSWER="$reply"
}

# A prompt answer is not shell input: nothing expands `~` on its way here, so an answered
# "~/tools/claude-plugins" would clone into a directory literally NAMED `~` under whatever
# working directory the one-liner happened to run in. bash 3.2 has no safe way to expand
# `~someone` without eval, so that form is refused rather than taken literally.
normalize_dir() {
  case "$DIR" in
    "~") DIR="${HOME:?cannot expand '~' with HOME unset — write the path out in full}" ;;
    "~/"*) DIR="${HOME:?cannot expand '~' with HOME unset — write the path out in full}${DIR#\~}" ;;
    "~"*) echo "error: cannot expand '$DIR' — write the path out in full" >&2; exit 2 ;;
  esac
}
normalize_dir

# --------------------------------------------------------------------------- where we run --
# Running from inside a checkout means the clone step is already done — and that this checkout,
# not some other copy on the machine, is what the developer means to install.
IN_CHECKOUT=""
SELF="${BASH_SOURCE[0]:-}"
if [ -n "$SELF" ] && [ -f "$SELF" ]; then
  SELF_DIR="$(cd "$(dirname "$SELF")" && pwd)"
  # Probe and record through the same logical `cd`: mixing a kernel-resolved `-d` test with a
  # lexical pwd would disagree when scripts/ is itself a symlink, and bootstrap would clone a
  # second copy instead of installing the tree the developer ran from.
  CHECKOUT_CAND="$(cd "$SELF_DIR/.." && pwd)"
  if [ -d "$CHECKOUT_CAND/plugins/fnd" ]; then
    IN_CHECKOUT="$CHECKOUT_CAND"
  fi
fi

if [ -n "$IN_CHECKOUT" ]; then
  if [ -n "$DIR" ] && [ "$DIR" != "$IN_CHECKOUT" ]; then
    echo "note: --dir ignored — running from inside the checkout at $IN_CHECKOUT"
  fi
  DIR="$IN_CHECKOUT"
fi

# ------------------------------------------------------------------------ target selection --
TARGET_LIST=""
add_target() {
  local want="$1" have
  for have in $TARGET_LIST; do
    if [ "$have" = "$want" ]; then return 0; fi
  done
  TARGET_LIST="$TARGET_LIST $want"
}

# The unquoted expansion is the split — but word-splitting is all that is wanted from it. With
# globbing left on, a `--targets '*'` that no shell got to expand becomes the filenames of
# whatever directory the one-liner ran in, so a stray file named `cursor` would silently select a
# host. `set -f` for the split only; nothing else in this script globs.
parse_targets() {
  local raw="$1" t
  set -f
  for t in $(printf '%s' "$raw" | tr ',' ' '); do
    case "$t" in
      all) add_target cursor; add_target codex; add_target opencode; add_target claude ;;
      cursor|codex|opencode|claude) add_target "$t" ;;
      *) set +f; echo "error: unknown target '$t' (expected cursor|codex|opencode|claude|all)" >&2; exit 2 ;;
    esac
  done
  set +f
}

pick_targets() {
  cat <<'EOF'
Which hosts should fnd be installed for?

  1) cursor     symlink this checkout into ~/.cursor/plugins/local
  2) codex      link the dev-channel subagents into ~/.codex/agents
  3) opencode   link skills, agents, commands and the plugin adapter into ~/.config/opencode
  4) claude     print the slash commands to run inside a Claude Code session
  5) all        every host above

EOF
  ask "Numbers or names, comma or space separated [5]: " "5"
  local choice="" t
  set -f                                  # same reason as parse_targets: split, do not glob
  for t in $(printf '%s' "$ANSWER" | tr ',' ' '); do
    case "$t" in
      1) choice="$choice cursor" ;;
      2) choice="$choice codex" ;;
      3) choice="$choice opencode" ;;
      4) choice="$choice claude" ;;
      5) choice="$choice all" ;;
      *) choice="$choice $t" ;;
    esac
  done
  set +f
  parse_targets "$choice"
}

if [ "$TARGETS_SET" = "yes" ]; then
  # An empty value lands here too, and falls out at the "no targets selected" gate below —
  # the same refusal `--targets ,,` gets, rather than the picker's default of every host.
  parse_targets "$TARGETS"
elif tty_available; then
  pick_targets
elif [ "$ASSUME_YES" = "yes" ]; then
  parse_targets all
else
  echo "error: no --targets given and no terminal to ask on (piped run)" >&2
  echo "       pass --targets cursor,codex,opencode,claude (or all), or --yes for all" >&2
  usage >&2
  exit 2
fi

[ -n "$TARGET_LIST" ] || { echo "error: no targets selected" >&2; usage >&2; exit 2; }

# Only the install.sh-backed hosts need a checkout on disk; a claude-only run has nothing to
# clone, so it must not create one — and must not demand one to uninstall either.
NEEDS_CHECKOUT="no"
for target in $TARGET_LIST; do
  if [ "$target" != "claude" ]; then NEEDS_CHECKOUT="yes"; fi
done

if [ "$NEEDS_CHECKOUT" = "yes" ] && [ -z "$DIR" ]; then
  [ -n "${HOME:-}" ] || { echo "error: HOME is unset and no --dir given — pass --dir <path>" >&2; exit 2; }
  DIR="$DEFAULT_DIR"
  if [ "$ACTION" = "install" ] && tty_available; then
    ask "Clone destination [$DIR]: " "$DIR"
    DIR="$ANSWER"
    normalize_dir
  fi
fi

# ------------------------------------------------------------------------------- the clone --
# Bootstrap never deletes and never overwrites: it clones into an absent dir, reuses a checkout
# that is already this repo, and refuses anything else.
ensure_clone() {
  [ "$NEEDS_CHECKOUT" = "yes" ] || return 0
  # An in-checkout run has already proved its own plugins/fnd; requiring a .git on top of that
  # would refuse the copies that arrive as a tarball or a vendored subtree.
  if [ -n "$IN_CHECKOUT" ]; then return 0; fi
  if [ "$ACTION" = "uninstall" ]; then
    if [ ! -d "$DIR/plugins/fnd" ]; then
      echo "error: --uninstall needs the checkout that did the install; $DIR is not one" >&2
      echo "       pass --dir <path-to-claude-plugins>, or run scripts/bootstrap.sh from inside it" >&2
      exit 2
    fi
    return 0
  fi
  if [ -e "$DIR" ]; then
    if [ -d "$DIR/plugins/fnd" ] && [ -e "$DIR/.git" ]; then
      # No `git pull` here on purpose: install.sh does its own ff-only update per target, and a
      # second pull would only race it.
      echo "using the checkout already at $DIR"
      return 0
    fi
    echo "error: refusing to use $DIR — it exists but is not a claude-plugins checkout" >&2
    echo "       (no plugins/fnd, or not a git work tree); move it aside or pass --dir <path>" >&2
    exit 2
  fi
  command -v git >/dev/null 2>&1 || { echo "error: git not found on PATH — install git, then re-run" >&2; exit 2; }
  echo "cloning $REPO_URL -> $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone "$REPO_URL" "$DIR" || { echo "error: git clone failed — $DIR left untouched" >&2; exit 1; }
}

ensure_clone

INSTALLER="$DIR/scripts/install.sh"

# ------------------------------------------------------------------- Claude Code, by words --
# Claude Code installs from its own marketplace inside a live session, and no outside process can
# drive one — so this target is informational by design and says so rather than pretending.
claude_block() {
  echo
  echo "claude: nothing to run from here — a Claude Code session cannot be driven from outside."
  if [ "$ACTION" = "uninstall" ]; then
    echo "        Remove it from inside a session:"
    echo
    echo "        /plugin uninstall fnd@domaine"
    echo "        /plugin marketplace remove domaine     # optional — drops the marketplace too"
  else
    echo "        Run these four in a session:"
    echo
    echo "        /plugin marketplace add domaine-oleksandr-kever/claude-plugins"
    echo "        /plugin install fnd@domaine"
    echo "        /reload-plugins"
    echo "        /fnd:smoke-test"
  fi
  echo
}

# ----------------------------------------------------------------------------- the targets --
# Word-split on purpose: the flags carry no spaces, and bash 3.2 has no arrays worth the noise.
INSTALL_FLAGS=""
if [ "$COPY" = "yes" ]; then INSTALL_FLAGS="$INSTALL_FLAGS --copy"; fi
if [ "$ACTION" = "uninstall" ]; then INSTALL_FLAGS="$INSTALL_FLAGS --uninstall"; fi

RESULTS=""
EXIT_RC=0
SAW_CURSOR="no"; SAW_CODEX="no"; SAW_OPENCODE="no"; SAW_CLAUDE="no"

record() { RESULTS="${RESULTS}$1 $2
"; }

for target in $TARGET_LIST; do
  case "$target" in
    claude)
      SAW_CLAUDE="yes"
      claude_block
      record claude "PRINTED (run the slash commands in a session)"
      continue
      ;;
    cursor) SAW_CURSOR="yes" ;;
    codex) SAW_CODEX="yes" ;;
    opencode) SAW_OPENCODE="yes" ;;
  esac
  # An incomplete checkout is this target's failure, not the run's: exiting here would skip the
  # remaining hosts AND the report, which is the one thing this script always owes the caller.
  if [ ! -f "$INSTALLER" ]; then
    echo "error: $INSTALLER not found — the checkout at $DIR is incomplete" >&2
    record "$target" "FAILED (no install.sh at $INSTALLER)"
    EXIT_RC=2
    continue
  fi
  echo
  echo "== $target =="
  rc=0
  "$INSTALLER" --target "$target" $INSTALL_FLAGS || rc=$?
  # A failed target does not stop the run — the remaining hosts are independent installs, and
  # the report is worth more than an early exit. Its rc becomes bootstrap's own.
  if [ "$rc" -eq 0 ]; then
    record "$target" "OK"
  else
    record "$target" "FAILED (install.sh exit $rc)"
    EXIT_RC="$rc"
  fi
done

# ---------------------------------------------------------------------------- the leftovers --
echo
echo "== summary =="
if [ "$NEEDS_CHECKOUT" = "yes" ]; then echo "checkout $DIR"; fi
printf '%s' "$RESULTS"
echo
echo "left to do by hand:"

if [ "$ACTION" = "uninstall" ]; then
  if [ "$NEEDS_CHECKOUT" = "yes" ]; then
    # Bootstrap removes what install.sh created and nothing else — the clone is the developer's
    # own working copy, and deleting it is a decision no installer gets to make for them.
    echo "  - clone kept at $DIR"
    echo "    Delete it yourself if you are done with it — a symlink install reads from that"
    echo "    checkout, so removing the folder is what finishes the job."
  fi
  if [ "$SAW_CURSOR" = "yes" ]; then
    echo "  - Cursor: this removed the local-checkout install. A MARKETPLACE-installed copy lives in"
    echo "    Cursor's own cache and is removable only in the editor UI (Customize -> Plugins -> ..."
    echo "    -> Uninstall) — no script can reach it. Then reload the window (Developer: Reload"
    echo "    Window) so the removed plugin stops loading."
  fi
  if [ "$SAW_CODEX" = "yes" ]; then
    echo "  - Codex: this removed the dev-channel subagents only — the bundle itself goes with"
    echo "    'codex plugin marketplace remove domaine-oleksandr-kever/claude-plugins'"
  fi
  if [ "$SAW_OPENCODE" = "yes" ]; then
    echo "  - OpenCode: the config you pasted by hand stays yours — drop the fnd 'mcp' block, the"
    echo "    permission fragment and the statics from 'instructions' in your own opencode.json"
  fi
  if [ "$SAW_CLAUDE" = "yes" ]; then
    echo "  - Claude Code: run the removal slash commands printed above in a live session"
  fi
else
  if [ "$SAW_CURSOR" = "yes" ]; then
    echo "  - Cursor: remove any MARKETPLACE-installed fnd copy first (Customize -> Plugins -> ... ->"
    echo "    Uninstall) — one route per machine — then reload the window (Developer: Reload Window)."
    echo "    Marketplace installs currently ignore agent model pins; on this local route they bind."
  fi
  if [ "$SAW_CODEX" = "yes" ]; then
    echo "  - Codex: 'codex plugin marketplace add domaine-oleksandr-kever/claude-plugins' is the"
    echo "    primary channel (skills, hooks, MCP); --target codex linked the dev-channel subagents"
    echo "    only. Then set [features] hooks = true in ~/.codex/config.toml and approve /hooks."
  fi
  if [ "$SAW_OPENCODE" = "yes" ]; then
    echo "  - OpenCode: three pastes into your own opencode.json that no installer may write — the"
    echo "    'mcp' block, the permission fragment and the statics in 'instructions'."
    # A clone that predates the renderer reaches this line too, and a command that is not there
    # is worse than no command.
    if [ -f "$DIR/plugins/fnd/scripts/opencode-config.cjs" ]; then
      echo "    Print all three, with this clone's paths already filled in:"
      echo "      node $DIR/plugins/fnd/scripts/opencode-config.cjs"
    fi
    echo "    Steps 3-5 of docs/README.opencode.md ($DIR/docs/README.opencode.md)"
  fi
  if [ "$SAW_CLAUDE" = "yes" ]; then
    echo "  - Claude Code: run the four slash commands printed above in a live session"
  fi
  echo "  - every host: run /smoke-test once in a live session (/fnd:smoke-test on Claude Code,"
  echo "    \$smoke-test on Codex CLI) — it proves the layers no script can reach"
fi

exit "$EXIT_RC"
