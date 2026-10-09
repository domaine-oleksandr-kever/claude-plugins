#!/usr/bin/env bash
# Domaine plugins bootstrap — one command from a clean machine to installed plugins
# (shape decision: the rustup-style one-liner, NOT a globally registered CLI, so there is
# exactly one distribution channel and it is this repo).
# Two invocation modes:
#   piped   curl -fsSL https://raw.githubusercontent.com/domaine-oleksandr-kever/claude-plugins/main/scripts/bootstrap.sh | bash
#           (flags: `| bash -s -- --targets cursor,opencode --yes`)
#   direct  ./scripts/bootstrap.sh   — from inside a checkout; the clone step is skipped and
#           this checkout is the one installed
# It owns four things only — the clone, the host picker, the Claude Code target and the "what is
# left to do by hand" report. The Claude Code target runs the `claude plugin` CLI when `claude` is
# on PATH and prints the slash commands otherwise; every other host's install is delegated to
# install.sh, which already does the linking, the ff-only update and the doctor run.
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
PLUGINS=""
ASSUME_YES="no"
COPY="no"
ACTION="install"

usage() {
  cat <<EOF
usage: bootstrap.sh [--dir <path>] [--targets <csv>] [--plugins <csv>] [--yes] [--copy] [--uninstall]

  piped:  curl -fsSL <raw-url>/scripts/bootstrap.sh | bash -s -- --targets cursor --yes
  direct: ./scripts/bootstrap.sh --targets cursor,opencode

  --dir <path>      where to clone (default: \$HOME/tools/claude-plugins); ignored when this
                    script runs from inside a checkout
  --targets <csv>   cursor,codex,opencode,claude or all — hosts to install for, in that order;
                    --target is accepted as an alias. Without it, and with a terminal to ask
                    on, you get a picker. claude runs 'claude plugin marketplace add|update' and
                    'claude plugin install' (update when already installed, and enable when
                    disabled) when the claude CLI is on PATH, and prints the slash commands when
                    it is not
  --plugins <csv>   claude only: the plugins to install (default slim,band,base,fe; name the
                    team plugins you need among fe, qa, be, pm; fnd alone for the legacy one),
                    always in the order slim, band, base, fe, qa, be, pm, fnd whatever order
                    the list gives, so a dependency comes first. An install that names fnd
                    beside base or a team plugin is refused: they never run together, and
                    neither is installed next to an enabled copy of the other. With
                    --uninstall, only the named plugins are removed, dependents first
  --yes             accept the defaults and never prompt (the default destination, and every
                    host when --targets is absent); passed to 'claude plugin install|update'
                    as -y
  --copy            passed through to install.sh (copy instead of symlink)
  --uninstall       remove what install.sh created for the selected hosts; needs an existing
                    checkout (--dir or a direct run) and never clones. For claude it runs
                    'claude plugin uninstall' (dependents first, the marketplace kept) and
                    needs no checkout
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
    --plugins) [ $# -ge 2 ] || { echo "error: --plugins needs a value" >&2; exit 2; }; PLUGINS="$2"; shift 2 ;;
    --plugins=*) PLUGINS="${1#--plugins=}"; shift ;;
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
  # Probe and record through the same logical `cd`: mixing a kernel-resolved `-f` test with a
  # lexical pwd would disagree when scripts/ is itself a symlink, and bootstrap would clone a
  # second copy instead of installing the tree the developer ran from.
  CHECKOUT_CAND="$(cd "$SELF_DIR/.." && pwd)"
  if [ -f "$CHECKOUT_CAND/.claude-plugin/marketplace.json" ]; then
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
Which hosts should the plugins be installed for?

  1) cursor     symlink this checkout into ~/.cursor/plugins/local
  2) codex      link the required subagents into ~/.codex/agents
  3) opencode   link skills, agents, commands and the plugin adapter into ~/.config/opencode
  4) claude     install with the claude CLI (prints the slash commands when it is absent)
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

# ------------------------------------------------------------------- the Claude Code set --
# The new set by default, each dependency before what requires it (base needs slim, every team plugin
# needs base); fnd only when --plugins names it. fnd ships the same agents, skills and MCP servers as
# base and the team plugins, so an install never names fnd beside any of them.
CLAUDE_PLUGINS=""
add_plugin() {
  case " $CLAUDE_PLUGINS " in
    *" $1 "*) ;;
    *) CLAUDE_PLUGINS="${CLAUDE_PLUGINS:+$CLAUDE_PLUGINS }$1" ;;
  esac
}
set -f
for p in $(printf '%s' "$PLUGINS" | tr ',' ' '); do
  case "$p" in
    -*|*[!a-z0-9-]*) set +f; echo "error: '$p' is not a plugin name" >&2; exit 2 ;;
  esac
  add_plugin "$p"
done
set +f
[ -n "$CLAUDE_PLUGINS" ] || CLAUDE_PLUGINS="slim band base fe"
# The dependency order, whatever order --plugins gave: base requires slim and every team plugin
# requires base, so an install that reached a team plugin first would fail, and the reversed
# uninstall would strand it. A name outside the known eight keeps its given place after them.
TEAM_PLUGINS="fe qa be pm"
ORDERED_PLUGINS=""
for p in slim band base $TEAM_PLUGINS fnd; do
  case " $CLAUDE_PLUGINS " in *" $p "*) ORDERED_PLUGINS="${ORDERED_PLUGINS:+$ORDERED_PLUGINS }$p" ;; esac
done
for p in $CLAUDE_PLUGINS; do
  case " slim band base $TEAM_PLUGINS fnd " in *" $p "*) ;; *) ORDERED_PLUGINS="${ORDERED_PLUGINS:+$ORDERED_PLUGINS }$p" ;; esac
done
CLAUDE_PLUGINS="$ORDERED_PLUGINS"
case " $CLAUDE_PLUGINS " in
  *" fnd "*) CLAUDE_FND="yes" ;;
  *) CLAUDE_FND="no" ;;
esac
case " $CLAUDE_PLUGINS " in
  *" base "*) CLAUDE_BASE="yes" ;;
  *) CLAUDE_BASE="no" ;;
esac
CLAUDE_FE="no"; CLAUDE_QA="no"; CLAUDE_BE="no"; CLAUDE_PM="no"
case " $CLAUDE_PLUGINS " in *" fe "*) CLAUDE_FE="yes" ;; esac
case " $CLAUDE_PLUGINS " in *" qa "*) CLAUDE_QA="yes" ;; esac
case " $CLAUDE_PLUGINS " in *" be "*) CLAUDE_BE="yes" ;; esac
case " $CLAUDE_PLUGINS " in *" pm "*) CLAUDE_PM="yes" ;; esac
# "yes" when the set names base or any team plugin: the side fnd never runs beside.
CLAUDE_NEW="no"
case "$CLAUDE_BASE$CLAUDE_FE$CLAUDE_QA$CLAUDE_BE$CLAUDE_PM" in *yes*) CLAUDE_NEW="yes" ;; esac
if [ "$ACTION" = "install" ] && [ "$CLAUDE_FND" = "yes" ] && [ "$CLAUDE_NEW" = "yes" ]; then
  echo "error: fnd must not run together with base or a team plugin (fe, qa, be, pm) — name fnd alone, or the new set, in --plugins" >&2
  exit 2
fi
case " $TARGET_LIST " in
  *" claude "*) ;;
  *) [ -z "$PLUGINS" ] || echo "note: --plugins ignored — it applies to the claude target only" ;;
esac

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
  # An in-checkout run has already proved its own marketplace file; requiring a .git on top of that
  # would refuse the copies that arrive as a tarball or a vendored subtree.
  if [ -n "$IN_CHECKOUT" ]; then return 0; fi
  if [ "$ACTION" = "uninstall" ]; then
    if [ ! -f "$DIR/.claude-plugin/marketplace.json" ]; then
      echo "error: --uninstall needs the checkout that did the install; $DIR is not one" >&2
      echo "       pass --dir <path-to-claude-plugins>, or run scripts/bootstrap.sh from inside it" >&2
      exit 2
    fi
    return 0
  fi
  if [ -e "$DIR" ]; then
    if [ -f "$DIR/.claude-plugin/marketplace.json" ] && [ -e "$DIR/.git" ]; then
      # No `git pull` here on purpose: install.sh does its own ff-only update per target, and a
      # second pull would only race it.
      echo "using the checkout already at $DIR"
      return 0
    fi
    echo "error: refusing to use $DIR — it exists but is not a claude-plugins checkout" >&2
    echo "       (no .claude-plugin/marketplace.json, or not a git work tree); move it aside or pass --dir <path>" >&2
    exit 2
  fi
  command -v git >/dev/null 2>&1 || { echo "error: git not found on PATH — install git, then re-run" >&2; exit 2; }
  echo "cloning $REPO_URL -> $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone "$REPO_URL" "$DIR" || { echo "error: git clone failed — $DIR left untouched" >&2; exit 1; }
}

ensure_clone

INSTALLER="$DIR/scripts/install.sh"

# ------------------------------------------------------------------------------ Claude Code --
MARKETPLACE="domaine"
MARKETPLACE_SOURCE="domaine-oleksandr-kever/claude-plugins"

# dependents first: CLAUDE_PLUGINS is in dependency order (slim before base, base before the team plugins)
CLAUDE_REVERSED=""
for p in $CLAUDE_PLUGINS; do CLAUDE_REVERSED="$p${CLAUDE_REVERSED:+ $CLAUDE_REVERSED}"; done

# The checks a session runs after the install, in install order: fnd's smoke test, base's doctor,
# then one doctor per team plugin named.
VERIFY_STEPS=""
if [ "$CLAUDE_FND" = "yes" ]; then VERIFY_STEPS="/fnd:smoke-test"; fi
if [ "$CLAUDE_BASE" = "yes" ]; then VERIFY_STEPS="${VERIFY_STEPS:+$VERIFY_STEPS }/base-doctor"; fi
if [ "$CLAUDE_FE" = "yes" ]; then VERIFY_STEPS="${VERIFY_STEPS:+$VERIFY_STEPS }/fe-doctor"; fi
if [ "$CLAUDE_QA" = "yes" ]; then VERIFY_STEPS="${VERIFY_STEPS:+$VERIFY_STEPS }/qa-doctor"; fi
if [ "$CLAUDE_BE" = "yes" ]; then VERIFY_STEPS="${VERIFY_STEPS:+$VERIFY_STEPS }/be-doctor"; fi
if [ "$CLAUDE_PM" = "yes" ]; then VERIFY_STEPS="${VERIFY_STEPS:+$VERIFY_STEPS }/pm-doctor"; fi
# "a", "a and b", "a, b and c"
CLAUDE_VERIFY=""
set -f
set -- $VERIFY_STEPS
set +f
while [ $# -gt 0 ]; do
  if [ -z "$CLAUDE_VERIFY" ]; then CLAUDE_VERIFY="$1"
  elif [ $# -eq 1 ]; then CLAUDE_VERIFY="$CLAUDE_VERIFY and $1"
  else CLAUDE_VERIFY="$CLAUDE_VERIFY, $1"; fi
  shift
done
CLAUDE_NEXT="restart Claude Code, or run /reload-plugins in an open session"
if [ "$ACTION" = "install" ] && [ -n "$CLAUDE_VERIFY" ]; then CLAUDE_NEXT="$CLAUDE_NEXT, then $CLAUDE_VERIFY"; fi

# How the claude target ended: "cli-ok", "cli-failed", "conflict" (fnd beside base or a team plugin,
# nothing run) or "printed" — the leftovers read it, and a conflict also reads the removal steps.
CLAUDE_OUTCOME=""
CLAUDE_CONFLICT_STEPS=""

# A child that inherits stdin in a piped run reads the rest of this script as its input, and a
# prompt with nobody at it is a hang. A terminal gets the CLI's own confirmations; anything else
# gets end of input. In 2.1.293 only install and update confirm anything (a marketplace-declared
# command, which -y accepts); `marketplace add` has no confirmation flag. Should the add refuse
# without a terminal anyway, its exit code becomes this target's FAILED line.
claude_cli() {
  local stdin="/dev/null"
  if tty_available; then stdin="/dev/tty"; fi
  echo "+ claude $*"
  claude "$@" < "$stdin"
}

# The installed plugins as "<id> <scope> <enabled>" lines, from `claude plugin list --json`. Split
# on the "id" key instead of parsed: a fresh machine has no jq, and each entry carries one id, one
# scope and one enabled flag before the next id. INSTALLED_KNOWN stays "no" when the list fails.
INSTALLED=""
INSTALLED_KNOWN="no"
read_installed() {
  local json
  json="$(claude plugin list --json < /dev/null 2>/dev/null)" || return 0
  INSTALLED_KNOWN="yes"
  INSTALLED="$(printf '%s' "$json" | tr '\n' ' ' | awk '{
    n = split($0, part, /"id"[ \t]*:[ \t]*/)
    for (i = 2; i <= n; i++) {
      s = part[i]; id = ""; sc = "-"; en = "-"
      if (match(s, /^"[^"]*"/)) id = substr(s, 2, RLENGTH - 2)
      if (match(s, /"scope"[ \t]*:[ \t]*"[^"]*"/)) { sc = substr(s, RSTART, RLENGTH); sub(/^.*:[ \t]*"/, "", sc); sub(/"$/, "", sc) }
      if (match(s, /"enabled"[ \t]*:[ \t]*(true|false)/)) { en = substr(s, RSTART, RLENGTH); sub(/^.*:[ \t]*/, "", en) }
      if (id != "") print id, sc, en
    }
  }')"
}
# user_install <id> — prints "true"/"false" (enabled) for a user-scope install, nothing otherwise.
# bootstrap installs at user scope, so a project-scope copy elsewhere is not "already installed".
user_install() { printf '%s\n' "$INSTALLED" | awk -v id="$1" '$1 == id && $2 == "user" { print $3; exit }'; }
# removal_steps <id regex> — how to remove every enabled copy whose id matches, joined by ", then ".
# The CLI uninstalls only from user, project and local scope, and the last two only from inside
# that project; a synced copy belongs to the claude.ai account and a managed one to the admin.
removal_steps() {
  printf '%s\n' "$INSTALLED" | awk -v re="$1" '$1 ~ re && $3 == "true" {
    if ($2 == "synced") s = "remove " $1 " from your claude.ai account (it is synced from there)"
    else if ($2 == "user" || $2 == "-") s = "claude plugin uninstall " $1
    else if ($2 == "managed") s = "ask your admin to drop " $1 " from the managed settings (a user cannot uninstall it)"
    else if ($2 == "project" || $2 == "local") s = "claude plugin uninstall -s " $2 " " $1 " (run it in the project that installed it)"
    else s = "remove " $1 " where it was added (" $2 " scope)"
    out = out (out == "" ? "" : ", then ") s
  } END { printf "%s", out }'
}

# A re-run is the update: an existing `domaine` marketplace is refreshed (a failure only leaves
# the cached catalog, so it warns), an absent one is added. A list that fails says nothing either
# way, so the add is tried, and its failure is this target's.
MARKETPLACE_WARN=""
CONFLICT_WARN=""
claude_marketplace() {
  local list rc=0
  list="$(claude plugin marketplace list --json < /dev/null 2>/dev/null)" || rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$list" | grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$MARKETPLACE\""; then
    claude_cli plugin marketplace update "$MARKETPLACE" || rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "claude: WARN — 'claude plugin marketplace update $MARKETPLACE' exit $rc; installing from the catalog already on disk" >&2
      MARKETPLACE_WARN=" (WARN: claude plugin marketplace update $MARKETPLACE exit $rc)"
    fi
    return 0
  fi
  if [ "$rc" -ne 0 ]; then echo "claude: could not list marketplaces (exit $rc) — adding $MARKETPLACE_SOURCE"; fi
  rc=0
  claude_cli plugin marketplace add "$MARKETPLACE_SOURCE" || rc=$?
  if [ "$rc" -ne 0 ]; then
    record claude "FAILED (claude plugin marketplace add $MARKETPLACE_SOURCE exit $rc)"
    EXIT_RC="$rc"
  fi
  return "$rc"
}

# The first failed install stops the rest: the plugins after it depend on it (base on slim, the team
# plugins on base), so they would fail too, and a half-installed set reported as one failure is easier to
# re-run than a list of knock-on errors.
claude_cli_install() {
  local p id verb state rc yes="" what="" steps=""
  if [ "$ASSUME_YES" = "yes" ]; then yes="-y"; fi
  read_installed
  # Any enabled fnd counts, whatever its marketplace: a claude.ai-synced fnd is shadowed only while
  # fnd@domaine is installed, and loads once that copy is gone.
  # An unreadable list must not pass for an empty one: the install goes ahead (a refusal would
  # leave no way past a CLI whose list is broken), but the summary says the check never ran.
  if [ "$INSTALLED_KNOWN" = "no" ]; then
    echo "claude: could not read 'claude plugin list --json' — installing every plugin"
    if [ "$CLAUDE_NEW" = "yes" ]; then what="fnd"
    elif [ "$CLAUDE_FND" = "yes" ]; then what="base or a team plugin"; fi
    if [ -n "$what" ]; then
      echo "claude: WARN — an enabled $what was not checked for; run 'claude plugin list' and remove it if it shows (fnd never runs with base or a team plugin)" >&2
      CONFLICT_WARN=" (WARN: $what not checked)"
    fi
  elif [ "$CLAUDE_NEW" = "yes" ]; then
    what="fnd"; steps="$(removal_steps '^fnd@')"
  elif [ "$CLAUDE_FND" = "yes" ]; then
    what="base or a team plugin"
    steps="$(removal_steps "^($(printf '%s' "$TEAM_PLUGINS" | tr ' ' '|'))@$MARKETPLACE\$")"
    p="$(removal_steps "^base@$MARKETPLACE\$")"
    if [ -n "$p" ]; then steps="${steps:+$steps, then }$p"; fi
  fi
  if [ -n "$steps" ]; then
    echo "error: $what is installed and enabled — fnd never runs with base or a team plugin." >&2
    echo "       Remove it first: $steps" >&2
    record claude "FAILED ($what is installed and enabled — remove it first)"
    CLAUDE_CONFLICT_STEPS="$steps"
    EXIT_RC=2; CLAUDE_OUTCOME="conflict"; return 0
  fi
  claude_marketplace || { CLAUDE_OUTCOME="cli-failed"; return 0; }
  for p in $CLAUDE_PLUGINS; do
    id="$p@$MARKETPLACE"
    state="$(user_install "$id")"
    verb="install"
    if [ -n "$state" ]; then verb="update"; fi
    rc=0
    claude_cli plugin "$verb" $yes "$id" || rc=$?
    # an update keeps a disabled plugin disabled; asking for it here means wanting it loaded
    if [ "$rc" -eq 0 ] && [ "$state" = "false" ]; then
      verb="enable"
      claude_cli plugin enable "$id" || rc=$?
    fi
    if [ "$rc" -ne 0 ]; then
      record claude "FAILED (claude plugin $verb $id exit $rc)"
      EXIT_RC="$rc"; CLAUDE_OUTCOME="cli-failed"; return 0
    fi
  done
  echo "claude: $CLAUDE_NEXT"
  record claude "OK$MARKETPLACE_WARN$CONFLICT_WARN"
  CLAUDE_OUTCOME="cli-ok"
}

# An uninstall keeps going past a failure — each removal stands alone — and skips what `claude
# plugin list` shows is not installed at user scope, so only a real removal failure is reported.
# The marketplace is never removed: other plugins may still come from it.
claude_cli_uninstall() {
  local p id rc failed=""
  read_installed
  for p in $CLAUDE_REVERSED; do
    id="$p@$MARKETPLACE"
    if [ "$INSTALLED_KNOWN" = "yes" ] && [ -z "$(user_install "$id")" ]; then
      echo "claude: $id is not installed at user scope — skipped"
      continue
    fi
    rc=0
    claude_cli plugin uninstall "$id" || rc=$?
    if [ "$rc" -ne 0 ]; then
      failed="${failed:+$failed; }claude plugin uninstall $id exit $rc"
      EXIT_RC="$rc"
    fi
  done
  echo "claude: the $MARKETPLACE marketplace stays — 'claude plugin marketplace remove $MARKETPLACE' drops it too (optional)"
  if [ -n "$failed" ]; then
    record claude "FAILED ($failed)"
    CLAUDE_OUTCOME="cli-failed"
  else
    record claude "OK"
    CLAUDE_OUTCOME="cli-ok"
  fi
}

# Without the CLI (CI, a Desktop-only machine) the same steps are printed as slash commands.
claude_block() {
  echo
  echo "claude: the \`claude\` CLI is not on PATH — run these in a session:"
  local p
  if [ "$ACTION" = "uninstall" ]; then
    echo
    for p in $CLAUDE_REVERSED; do echo "        /plugin uninstall $p@domaine"; done
    echo "        /plugin marketplace remove domaine     # optional — drops the marketplace too"
  else
    echo
    echo "        /plugin marketplace add domaine-oleksandr-kever/claude-plugins"
    for p in $CLAUDE_PLUGINS; do echo "        /plugin install $p@domaine"; done
    echo "        /reload-plugins"
    for p in $VERIFY_STEPS; do echo "        $p"; done
    if [ "$CLAUDE_NEW" = "yes" ]; then
      echo
      echo "        Moving from fnd: run /plugin uninstall fnd@domaine first — fnd never runs with base or a team plugin."
    fi
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
SAW_CURSOR="no"; SAW_CODEX="no"; SAW_OPENCODE="no"

record() { RESULTS="${RESULTS}$1 $2
"; }

for target in $TARGET_LIST; do
  case "$target" in
    claude)
      if command -v claude >/dev/null 2>&1; then
        echo
        echo "== claude =="
        if [ "$ACTION" = "uninstall" ]; then claude_cli_uninstall; else claude_cli_install; fi
      else
        claude_block
        record claude "PRINTED (no claude on PATH)"
        CLAUDE_OUTCOME="printed"
      fi
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
    echo "  - Codex: this removed the subagent links only — the bundle itself goes with"
    echo "    'codex plugin marketplace remove domaine-oleksandr-kever/claude-plugins'"
  fi
  if [ "$SAW_OPENCODE" = "yes" ]; then
    echo "  - OpenCode: the config you pasted by hand stays yours — drop the fnd 'mcp' block, the"
    echo "    permission fragment and the statics from 'instructions' in your own opencode.json"
  fi
  if [ "$CLAUDE_OUTCOME" = "printed" ]; then
    echo "  - Claude Code: run the removal slash commands printed above in a live session"
  elif [ "$CLAUDE_OUTCOME" = "cli-ok" ]; then
    echo "  - Claude Code: $CLAUDE_NEXT"
  elif [ "$CLAUDE_OUTCOME" = "cli-failed" ]; then
    echo "  - Claude Code: fix the failed 'claude plugin' call above, re-run with --targets claude"
    echo "    --uninstall, then $CLAUDE_NEXT"
  fi
else
  if [ "$SAW_CURSOR" = "yes" ]; then
    echo "  - Cursor: remove any MARKETPLACE-installed fnd copy first (Customize -> Plugins -> ... ->"
    echo "    Uninstall) — one route per machine — then reload the window (Developer: Reload Window)."
    echo "    Marketplace installs currently ignore agent model pins; on this local route they bind."
  fi
  if [ "$SAW_CODEX" = "yes" ]; then
    echo "  - Codex: 'codex plugin marketplace add domaine-oleksandr-kever/claude-plugins' is the"
    echo "    primary channel (skills, hooks, MCP); --target codex linked the subagents — the half"
    echo "    Codex loads from ~/.codex/agents, never from the cache. Then set [features] hooks ="
    echo "    true in ~/.codex/config.toml and approve /hooks."
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
  if [ "$CLAUDE_OUTCOME" = "printed" ]; then
    echo "  - Claude Code: run the slash commands printed above in a live session"
  elif [ "$CLAUDE_OUTCOME" = "cli-ok" ]; then
    if [ -n "$CONFLICT_WARN" ]; then
      echo "  - Claude Code: 'claude plugin list' could not be read, so nothing checked that fnd is not"
      echo "    enabled beside base or a team plugin — run it, and remove whichever side this run did not install"
    fi
    echo "  - Claude Code: $CLAUDE_NEXT"
  elif [ "$CLAUDE_OUTCOME" = "cli-failed" ]; then
    echo "  - Claude Code: fix the failed 'claude plugin' call above and re-run with --targets claude"
    echo "    (a re-run updates what is already installed), then $CLAUDE_NEXT"
  elif [ "$CLAUDE_OUTCOME" = "conflict" ]; then
    echo "  - Claude Code: fnd never runs with base or a team plugin, so nothing was installed. First"
    echo "    $CLAUDE_CONFLICT_STEPS;"
    echo "    then re-run this command and $CLAUDE_NEXT"
  fi
  if [ "$CLAUDE_FND" = "yes" ]; then
    echo "  - every host: run /smoke-test once in a live session (/fnd:smoke-test on Claude Code,"
    echo "    \$smoke-test on Codex CLI) — it proves the layers no script can reach"
  elif [ "$NEEDS_CHECKOUT" = "yes" ]; then
    echo "  - Cursor, Codex CLI, OpenCode: run /smoke-test once in a live session (\$smoke-test on"
    echo "    Codex CLI) — it proves the layers no script can reach"
  fi
fi

exit "$EXIT_RC"
