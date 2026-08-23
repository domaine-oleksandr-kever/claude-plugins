#!/usr/bin/env bash
# fnd multi-harness installer — Cursor, OpenCode and the Codex subagent layer
# (HARNESS-PORT-PLAN.md § Install stories). The clone IS the install: every entry points back
# into this checkout, so a `git pull` updates the host live. Re-running the installer is the
# update path; Claude Code installs from its marketplace and is not handled here.
# Codex is a partial target on purpose: `codex plugin marketplace add` installs the whole bundle
# — skills, hooks, MCP and the TOML subagents (measured 2026-08-23 on CLI 0.149.0: a cache-only
# install spawned jira-reader with no local links) — so `--target codex` is the DEV channel, which
# links agents-codex/*.toml into ~/.codex/agents/ and nothing else: it points Codex at a local
# checkout's subagents, and is the fallback on an older CLI that does not serve them from cache.
set -euo pipefail

# Fallback stamp only: the canonical manifest in the checkout wins whenever it is readable,
# so an update reports (and records) the version the `git pull` actually landed.
FND_VERSION="0.61.0"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN="$REPO/plugins/fnd"

TARGET=""
MODE="symlink"
ACTION="install"

usage() {
  cat <<EOF
usage: install.sh --target cursor|opencode|codex [--copy] [--uninstall]

  --target <host>   cursor  -> ~/.cursor/plugins/local/fnd
                    opencode-> ~/.config/opencode (skills, agents, commands, plugin)
                    codex   -> ~/.codex/agents (subagents only — skills, hooks and MCP
                               come from \`codex plugin marketplace add\`)
  --copy            copy instead of symlink (no-symlink environments); a --copy
                    install does not follow \`git pull\` — re-run to refresh it
  --uninstall       remove only the entries this installer created
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target) [ $# -ge 2 ] || { echo "error: --target needs a value" >&2; exit 2; }; TARGET="$2"; shift 2 ;;
    --target=*) TARGET="${1#--target=}"; shift ;;
    --copy) MODE="copy"; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

case "$TARGET" in
  cursor|opencode|codex) ;;
  "") echo "error: --target is required (cursor|opencode|codex)" >&2; usage >&2; exit 2 ;;
  *) echo "error: unknown target '$TARGET' (expected cursor|opencode|codex)" >&2; exit 2 ;;
esac

[ -d "$PLUGIN" ] || { echo "error: $PLUGIN not found — run this script from its place in the repo" >&2; exit 1; }

case "$TARGET" in
  cursor)   ROOT_DIR="$HOME/.cursor/plugins/local" ;;
  opencode) ROOT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode" ;;
  codex)    ROOT_DIR="$HOME/.codex" ;;
esac

MODE_FILE="$ROOT_DIR/.fnd-install-mode"

LINKS=()
SRCS=()
add_entry() { LINKS+=("$1"); SRCS+=("$2"); }

# The entry list is a snapshot of the checkout, so it MUST be built after update_clone:
# a `git pull` that adds a skill has to be linked by the same run that pulled it.
build_entries() {
  LINKS=()
  SRCS=()
  case "$TARGET" in
    cursor)
      add_entry "$ROOT_DIR/fnd" "$PLUGIN"
      ;;
    opencode)
      # M1C-DEFAULT: the OpenCode install lever is provisional. Spike M1c picks between
      # OPENCODE_CONFIG_DIR, a global opencode.json fragment, and these symlinks; the plan's
      # documented default (symlinks into ~/.config/opencode/*) is what runs until it decides.
      # Per-entry links, never a link over ~/.config/opencode/skills itself, so a user's own
      # entries in those dirs keep working. Generated dirs that M4/M5 add are linked when present.
      for d in "$PLUGIN"/skills/*/; do
        [ -d "$d" ] || continue
        add_entry "$ROOT_DIR/skills/$(basename "$d")" "${d%/}"
      done
      for f in "$PLUGIN"/agents-opencode/*.md; do
        [ -f "$f" ] || continue
        add_entry "$ROOT_DIR/agents/$(basename "$f")" "$f"
      done
      for f in "$PLUGIN"/commands-opencode/*.md; do
        [ -f "$f" ] || continue
        add_entry "$ROOT_DIR/commands/$(basename "$f")" "$f"
      done
      if [ -f "$PLUGIN/opencode/fnd-plugin.js" ]; then
        add_entry "$ROOT_DIR/plugins/fnd-plugin.js" "$PLUGIN/opencode/fnd-plugin.js"
      fi
      ;;
    codex)
      # Subagents only — the dev channel (see the header note). The marketplace install already
      # serves the whole bundle from its cache, subagents included; these links are what points a
      # Codex session at the TOML agents of THIS checkout instead.
      for f in "$PLUGIN"/agents-codex/*.toml; do
        [ -f "$f" ] || continue
        add_entry "$ROOT_DIR/agents/$(basename "$f")" "$f"
      done
      ;;
  esac
}

PREV_MODE=""
PREV_REPO=""
PREV_ENTRIES=""
if [ -f "$MODE_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      mode=*) PREV_MODE="${line#mode=}" ;;
      repo=*) PREV_REPO="${line#repo=}" ;;
      entry=*) PREV_ENTRIES="${PREV_ENTRIES}${line#entry=}
" ;;
    esac
  done < "$MODE_FILE"
fi

points_into_repo() { case "$1" in "$REPO"|"$REPO"/*) return 0 ;; *) return 1 ;; esac; }

was_recorded() {
  local p="$1" e
  while IFS= read -r e; do [ "$e" = "$p" ] && return 0; done <<EOF
$PREV_ENTRIES
EOF
  return 1
}

# A path we may replace without asking: a copy this installer recorded, from this same repo.
is_our_copy() {
  [ "$PREV_MODE" = "copy" ] && [ "$PREV_REPO" = "$REPO" ] && was_recorded "$1"
}

is_current_entry() {
  local p="$1" i=0
  while [ "$i" -lt "${#LINKS[@]}" ]; do
    [ "${LINKS[$i]}" = "$p" ] && return 0
    i=$((i + 1))
  done
  return 1
}

# remove_entry <path> — delete an entry this installer owns. 0 removed, 1 kept (someone
# else's), 2 nothing there, 3 OURS but the removal FAILED. Prints the reason whenever it
# declines. Every call site reads the status through `|| rc=$?`, which switches errexit off for
# the whole function — so an `rm` that fails (a read-only parent directory, an immutable flag)
# would otherwise fall through to `return 0`, be reported as removed, and have its record line
# dropped: the entry survives as an orphan that neither --uninstall nor the doctor can reach
# again. 3 is its own code because "someone else's" is a normal outcome and this is a defect.
remove_entry() {
  local link="$1"
  if [ -L "$link" ]; then
    if points_into_repo "$(readlink "$link")"; then
      rm -f "$link" || { echo "kept: $link (removal failed)"; return 3; }
      return 0
    fi
    echo "kept: $link -> $(readlink "$link") (points outside $REPO)"
    return 1
  fi
  if [ -e "$link" ]; then
    if is_our_copy "$link"; then
      rm -rf "$link" || { echo "kept: $link (removal failed)"; return 3; }
      return 0
    fi
    echo "kept: $link (not recorded as an fnd copy)"
    return 1
  fi
  return 2
}

describe() { ls -ld "$1" 2>/dev/null || echo "$1"; }

# The version the checkout carries right now. Read after update_clone so a --copy install
# records what it actually copied; the FND_VERSION literal is the fallback when the
# canonical manifest is absent (a partial checkout) or unreadable.
manifest_version() {
  local mf="$PLUGIN/.claude-plugin/plugin.json" v=""
  [ -f "$mf" ] || return 1
  if command -v node >/dev/null 2>&1; then
    v="$(node -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (typeof m.version === "string" && m.version) process.stdout.write(m.version);' "$mf" 2>/dev/null)" || v=""
  fi
  if [ -z "$v" ]; then
    v="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$mf" 2>/dev/null | head -1 |
         sed 's/.*:[[:space:]]*"\(.*\)"$/\1/')"
  fi
  [ -n "$v" ] || return 1
  printf '%s' "$v"
}

resolve_version() {
  local v
  # assigned unquoted on purpose: bump-version.cjs stamps every double-quoted assignment to
  # this variable, so a quoted one here would be rewritten into a constant on the next release
  if v="$(manifest_version)"; then FND_VERSION=$v; fi
}

update_clone() {
  if [ ! -e "$REPO/.git" ]; then
    echo "note: $REPO is not a git checkout — skipping update"
    return 0
  fi
  if ! command -v git >/dev/null 2>&1; then
    echo "note: git not found — skipping update"
    return 0
  fi
  if [ -n "$(git -C "$REPO" status --porcelain 2>/dev/null)" ]; then
    echo "note: working tree has local changes — skipping git pull --ff-only"
    return 0
  fi
  if [ -z "$(git -C "$REPO" remote 2>/dev/null)" ]; then
    echo "note: no git remote configured — skipping git pull --ff-only"
    return 0
  fi
  if git -C "$REPO" pull --ff-only >/dev/null 2>&1; then
    echo "updated clone: git pull --ff-only"
  else
    echo "warning: git pull --ff-only failed — installing the checkout as it is" >&2
  fi
}

run_doctor() {
  local doctor="$PLUGIN/scripts/doctor.cjs" rc=0
  if [ ! -f "$doctor" ]; then
    echo "note: scripts/doctor.cjs not in this checkout — install not verified"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "warning: node not found — install not verified (fnd needs Node 18+)" >&2
    return 0
  fi
  node "$doctor" --target "$TARGET" || rc=$?
  [ "$rc" -eq 0 ] || echo "warning: doctor reported problems (exit $rc) — the install itself is in place" >&2
}

do_install() {
  update_clone
  build_entries
  resolve_version
  if [ "$TARGET" = "opencode" ]; then
    echo "note: the OpenCode install lever is provisional (symlink route, pending spike M1c)"
  fi
  if [ "$TARGET" = "codex" ]; then
    if [ "${#LINKS[@]}" -eq 0 ]; then
      echo "warning: no plugins/fnd/agents-codex/*.toml in this checkout — nothing to link;" >&2
      echo "         run plugins/fnd/scripts/gen-host-adapters.cjs, then re-run this installer" >&2
    fi
    echo "note: this target installs the subagent layer only — run"
    echo "      'codex plugin marketplace add domaine/claude-plugins' and install fnd via /plugins"
    echo "      for skills, hooks and MCP (they update with 'codex plugin marketplace upgrade')"
  fi

  local i created=0 replaced=0 unchanged=0 pruned=0 rc link src stale
  i=0
  while [ "$i" -lt "${#LINKS[@]}" ]; do
    link="${LINKS[$i]}"; src="${SRCS[$i]}"
    i=$((i + 1))
    mkdir -p "$(dirname "$link")"
    if [ -L "$link" ]; then
      if [ "$MODE" = "symlink" ] && [ "$(readlink "$link")" = "$src" ]; then
        unchanged=$((unchanged + 1))
        continue
      fi
      points_into_repo "$(readlink "$link")" || echo "note: replacing foreign symlink $link -> $(readlink "$link")"
      rm -f "$link"
      replaced=$((replaced + 1))
    elif [ -e "$link" ]; then
      if is_our_copy "$link"; then
        # A failed removal here leaves the old copy in place while the run goes on to report a
        # successful install and rewrite the record — so it stops the install instead, before
        # the record can claim a state the disk does not have.
        rm -rf "$link" || { echo "kept: $link (removal failed) — install stopped, record left as it was" >&2; return 1; }
        replaced=$((replaced + 1))
      else
        echo "error: refusing to clobber $link — not created by this installer:" >&2
        describe "$link" >&2
        echo "       move it aside (or remove it) and re-run." >&2
        exit 1
      fi
    else
      created=$((created + 1))
    fi
    if [ "$MODE" = "copy" ]; then
      cp -R "$src" "$link"
    else
      ln -s "$src" "$link"
    fi
  done

  # Entries the last run recorded that this checkout no longer produces (a renamed or deleted
  # skill): without this they stay behind as dangling links the host keeps scanning, and the
  # new record no longer mentions them so --uninstall would never reach them either.
  while IFS= read -r stale; do
    [ -n "$stale" ] || continue
    is_current_entry "$stale" && continue
    rc=0
    remove_entry "$stale" || rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "pruned: $stale (no longer in this checkout)"
      pruned=$((pruned + 1))
    fi
  done <<EOF
$PREV_ENTRIES
EOF

  # The per-entry loop above is what usually creates the root; an install that linked nothing
  # (a checkout missing the generated dir this target needs) would otherwise fail to write its
  # record here, report success on stdout, and leave doctor with nothing to diagnose.
  mkdir -p "$ROOT_DIR"
  {
    echo "mode=$MODE"
    echo "repo=$REPO"
    echo "version=$FND_VERSION"
    i=0
    while [ "$i" -lt "${#LINKS[@]}" ]; do
      echo "entry=${LINKS[$i]}"
      i=$((i + 1))
    done
  } > "$MODE_FILE"

  echo "entries: $created created, $replaced replaced, $unchanged unchanged, $pruned pruned (root: $ROOT_DIR)"
  case "$TARGET" in
    cursor) echo "next: reload the Cursor window (Developer: Reload Window) so manifest, hook and MCP changes load" ;;
    opencode) echo "next: start a new OpenCode session so skills, agents and the plugin adapter load" ;;
    codex)
      echo "next: start a new Codex session so the subagents load"
      # Both steps are the user's to take, and skipping either leaves the guard layer dormant while
      # skills and MCP look healthy — so they are printed, not implied.
      echo "      then: set [features] hooks = true in ~/.codex/config.toml (the default varies by CLI version)"
      echo "      then: approve the plugin's hooks via /hooks (per-content-hash review, repeat after every update)"
      ;;
  esac
  if [ "$MODE" = "copy" ]; then
    echo "note: --copy installs do not follow git pull — re-run this script to refresh them"
  fi
  run_doctor
  echo "fnd $FND_VERSION installed for $TARGET (mode: $MODE, repo: $REPO)"
}

do_uninstall() {
  build_entries
  resolve_version
  local targets="" link removed=0 kept=0 stuck=0 rc
  if [ -n "$PREV_ENTRIES" ]; then
    targets="$PREV_ENTRIES"
  else
    local i=0
    while [ "$i" -lt "${#LINKS[@]}" ]; do
      targets="${targets}${LINKS[$i]}
"
      i=$((i + 1))
    done
  fi

  while IFS= read -r link; do
    [ -n "$link" ] || continue
    rc=0
    remove_entry "$link" || rc=$?
    case "$rc" in
      0) removed=$((removed + 1)) ;;
      1) kept=$((kept + 1)) ;;
      3) kept=$((kept + 1)); stuck=$((stuck + 1)) ;;
    esac
  done <<EOF
$targets
EOF

  # A foreign entry (rc 1) is a normal, final outcome — the record has said everything it can
  # about it. An entry that is OURS and would not delete (rc 3) is not: dropping the record would
  # leave it orphaned, with nothing left that names it. Keep the record so a re-run can finish
  # the job once the reason (a read-only parent, a permission) is fixed.
  [ "$stuck" -gt 0 ] || rm -f "$MODE_FILE"
  # `rmdir`, never `rm -r`: these dirs are shared with the host's own config and a user's files
  for d in "$ROOT_DIR/skills" "$ROOT_DIR/agents" "$ROOT_DIR/commands" "$ROOT_DIR/plugins" "$ROOT_DIR"; do
    rmdir "$d" 2>/dev/null || true
  done
  echo "fnd $FND_VERSION uninstalled from $TARGET ($removed removed, $kept kept)"
  if [ "$stuck" -gt 0 ]; then
    echo "warning: $stuck entry/entries could not be removed — the install record was kept so a re-run can finish" >&2
    return 1
  fi
}

case "$ACTION" in
  install) do_install ;;
  uninstall) do_uninstall ;;
esac
