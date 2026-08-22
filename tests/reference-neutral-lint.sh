#!/usr/bin/env bash
# Host-neutrality lint for the reference files (M4 carry-over of the M3 skills pass).
# References are pulled in verbatim by skills and read standalone by subagents on every host, so
# they carry the same three hard rules as tests/skill-neutral-lint.sh:
#   1. plugin-root  — no `${CLAUDE_PLUGIN_ROOT}` outside a Claude Code guard; other hosts never
#      expand it. Each file names its own anchor ("plugin root = the plugin's own directory") and
#      writes bundled paths as `<plugin root>/…`; the literal survives only where a command has to
#      stay byte-identical, inside a guard that says so.
#   2. claude-only  — AskUserQuestion / EnterPlanMode / ExitPlanMode / ultracode / `Workflow(`
#      may appear only under a Claude Code guard.
#   3. invocation   — `/fnd:<skill>` is a Claude Code slash command; other hosts use `$name` or a
#      command shim, so every mention needs the same guard.
#   A guard is a CONDITIONAL Claude-Code phrase — a clause-opening "on Claude Code", or
#   "Claude Code only" / "Claude-Code-only" — on the same line, the nearest non-empty line above,
#   or (inside a fenced block) on the fence line or the line that introduced the fence. A bare
#   mention of the product name is deliberately NOT a guard.
#   4. anchor      — a file that uses `<plugin root>/` must define the term at least once
#      ("plugin root" + "the plugin's own directory"), because a subagent may open this file with
#      no skill body around it.
# Scope: plugins/fnd/references/*.md plus every skills/*/REFERENCE.md (same audience, same rules;
# SKILL.md bodies belong to skill-neutral-lint.sh).
# Usage: reference-neutral-lint.sh [plugin-dir]   (default: plugins/fnd)
# Exit 0 = references are host-neutral.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="${1:-$ROOT/plugins/fnd}"

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

# violations <file> <rule> — one `line<TAB>excerpt` row per unguarded hit, empty when clean
violations() {
  awk -v rule="$2" '
    function guarded(s) {
      if (s ~ /Claude Code only|Claude-Code-only/) return 1
      return s ~ /(^|—|–|[.!?({;:,*>`"]|[[:space:]](and|or|both|only|then))[[:space:]]*[Oo]n Claude Code/
    }
    BEGIN { fence = 0; fence_guard = 0; prev = "" }
    {
      line = $0

      # fenced blocks inherit the guard of the line that introduced them
      if (line ~ /^[ \t]*```/) {
        if (fence) { fence = 0; fence_guard = 0 }
        else { fence = 1; fence_guard = (guarded(line) || guarded(prev)) }
      }

      g = guarded(line) || guarded(prev) || (fence && fence_guard)
      hit = 0
      if (rule == "plugin-root") { if (index(line, "CLAUDE_PLUGIN_ROOT") > 0) hit = 1 }
      else if (rule == "invocation") { if (index(line, "/fnd:") > 0) hit = 1 }
      else if (line ~ /AskUserQuestion|EnterPlanMode|ExitPlanMode|ultracode|Workflow\(/) hit = 1
      if (hit && !g) {
        excerpt = line
        if (length(excerpt) > 90) excerpt = substr(excerpt, 1, 90) "…"
        printf "%d\t%s\n", NR, excerpt
      }

      if (line ~ /[^ \t]/) prev = line
    }
  ' "$1"
}

# check_rule <file> <label> <rule> <message>
check_rule() {
  rows="$(violations "$1" "$3")"
  if [ -z "$rows" ]; then ok; return; fi
  while IFS="$(printf '\t')" read -r ln txt; do
    [ -n "$ln" ] || continue
    bad "$3-$2" "$2:$ln $4: $txt"
  done <<EOF
$rows
EOF
}

REF_DIR="$PLUGIN_DIR/references"
if [ -d "$REF_DIR" ]; then ok; else bad references-dir "not a directory: $REF_DIR"; fi

found=0
for f in "$REF_DIR"/*.md "$PLUGIN_DIR"/skills/*/REFERENCE.md; do
  [ -f "$f" ] || continue
  found=$((found + 1))
  case "$f" in
    */references/*) label="references/$(basename "$f")" ;;
    *) label="skills/$(basename "$(dirname "$f")")/$(basename "$f")" ;;
  esac

  # rule 1 — plugin root must not be a Claude-only shell expansion
  check_rule "$f" "$label" plugin-root 'unguarded ${CLAUDE_PLUGIN_ROOT}'

  # rule 2 — Claude-only tools/mechanics need an explicit Claude Code guard
  check_rule "$f" "$label" claude-only "Claude-only mechanic without a 'Claude Code' guard"

  # rule 3 — `/fnd:` slash commands exist on Claude Code only
  check_rule "$f" "$label" invocation "/fnd: command without a 'Claude Code' guard"

  # rule 4 — a file using the `<plugin root>` form defines it, for standalone readers
  if grep -qF '<plugin root>/' "$f"; then
    # the anchor sentence often wraps, so match it against the whitespace-squashed file
    if tr '\n' ' ' < "$f" | tr -s ' ' |
       grep -qiE "plugin root[^.]{0,80}the plugin's own directory"; then ok
    else bad "anchor-$label" "$label uses \`<plugin root>/\` but never defines it as the plugin's own directory"
    fi
  else ok
  fi
done

if [ "$found" -gt 0 ]; then ok; else bad reference-count "no reference files under $PLUGIN_DIR"; fi

echo "reference-neutral-lint: $pass passed, $fail failed ($found files)"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
