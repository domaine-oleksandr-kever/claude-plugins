#!/usr/bin/env bash
# Host-neutrality lint for the skill bodies (M3 of the multi-harness port).
# A SKILL.md is loaded verbatim by every host, so anything only Claude Code can expand or
# only Claude Code can call has to be either gone or explicitly marked as Claude-only.
# Four hard rules, one watchlist:
#   1. plugin-root  — no `${CLAUDE_PLUGIN_ROOT}` in the body; other hosts never expand it.
#      Frontmatter `allowed-tools:` lines are exempt (permission matching is Claude-only and
#      unknown frontmatter keys are ignored elsewhere).
#   2. claude-only  — AskUserQuestion / EnterPlanMode / ExitPlanMode / ultracode / `Workflow(`
#      may appear only under a Claude Code guard, so a non-Claude host reads them as
#      conditional rather than as an instruction it must somehow satisfy.
#   3. invocation   — `/fnd:<skill>` is a Claude Code slash command; other hosts use their own
#      shims, so every mention needs the same guard.
#   A guard is a CONDITIONAL Claude-Code phrase — a clause-opening "on Claude Code", or
#   "Claude Code only" / "Claude-Code-only" — on the same line, the nearest non-empty line
#   above, or (inside a
#   fenced block) on the fence line or the line that introduced the fence (the
#   "on Claude Code run this verbatim:" + fence shape). A bare mention of the product name is
#   deliberately NOT a guard: it would license anything sharing a paragraph with it.
#   4. plan-mode    — a `[plan mode]` heading marker is Claude-Code-only mechanics, so the file
#      must say so somewhere: one line matching both a conditional Claude-Code phrase and
#      "plan mode" (the Operating-mode gloss). File-scoped, since the marker sits in headings
#      far from that line.
#   5. size        — SKILL.md files over 8000 bytes are printed as a WARN row only. The live
#      Codex run on 2026-08-23 did not measure a per-skill cap, so no threshold is known to
#      enforce; the watchlist stays a WARN until one is measured.
# Usage: skill-neutral-lint.sh [skills-dir]   (default: plugins/fnd/skills)
# Exit 0 = skills are host-neutral.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_DIR="${1:-$ROOT/plugins/fnd/skills}"
SIZE_WARN_BYTES=8000

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

# violations <file> <rule> — one `line<TAB>excerpt` row per unguarded hit, empty when clean
violations() {
  awk -v rule="$2" '
    # A guard is a conditional Claude-Code clause, not a passing mention: "on Claude Code"
    # has to open a clause (line start, punctuation, a closing code span, or a connective),
    # so narrative like "this originated on Claude Code and Cursor alike" guards nothing.
    function guarded(s) {
      if (s ~ /Claude Code only|Claude-Code-only/) return 1
      return s ~ /(^|—|–|[.!?({;:,*>`"]|[[:space:]](and|or|both|only|then))[[:space:]]*[Oo]n Claude Code/
    }
    BEGIN { fm = 0; fence = 0; fence_guard = 0; prev = "" }
    {
      line = $0
      skip = 0

      # --- frontmatter: only the allowed-tools line is exempt, the rest is linted
      if (NR == 1 && line == "---") { fm = 1; prev = line; next }
      if (fm) {
        if (line == "---") fm = 0
        else if (line ~ /^[ \t]*allowed-tools:/) skip = 1
      }

      # --- fenced blocks inherit the guard of the line that introduced them
      if (line ~ /^[ \t]*```/) {
        if (fence) { fence = 0; fence_guard = 0 }
        else { fence = 1; fence_guard = (guarded(line) || guarded(prev)) }
      }

      if (!skip) {
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
      }

      if (line ~ /[^ \t]/) prev = line
    }
  ' "$1"
}

if [ -d "$SKILLS_DIR" ]; then ok; else bad skills-dir "not a directory: $SKILLS_DIR"; fi

found=0
oversized=""
for f in "$SKILLS_DIR"/*/SKILL.md; do
  [ -f "$f" ] || continue
  found=$((found + 1))
  name="$(basename "$(dirname "$f")")"

  # rule 1 — plugin root must not be a Claude-only shell expansion
  rows="$(violations "$f" plugin-root)"
  if [ -z "$rows" ]; then ok
  else
    while IFS="$(printf '\t')" read -r ln txt; do
      [ -n "$ln" ] || continue
      bad "plugin-root-$name" "$name/SKILL.md:$ln unguarded \${CLAUDE_PLUGIN_ROOT}: $txt"
    done <<EOF
$rows
EOF
  fi

  # rule 2 — Claude-only tools/mechanics need an explicit Claude Code guard
  rows="$(violations "$f" claude-only)"
  if [ -z "$rows" ]; then ok
  else
    while IFS="$(printf '\t')" read -r ln txt; do
      [ -n "$ln" ] || continue
      bad "claude-only-$name" "$name/SKILL.md:$ln Claude-only mechanic without a 'Claude Code' guard: $txt"
    done <<EOF
$rows
EOF
  fi

  # rule 3 — `/fnd:` slash commands exist on Claude Code only
  rows="$(violations "$f" invocation)"
  if [ -z "$rows" ]; then ok
  else
    while IFS="$(printf '\t')" read -r ln txt; do
      [ -n "$ln" ] || continue
      bad "invocation-$name" "$name/SKILL.md:$ln /fnd: command without a 'Claude Code' guard: $txt"
    done <<EOF
$rows
EOF
  fi

  # rule 4 — a `[plan mode]` marker needs one file-level line saying it is Claude-Code-only
  if grep -qF '[plan mode]' "$f"; then
    if grep -qE '([Oo]n Claude Code|Claude Code only|Claude-Code-only).*plan mode' "$f"; then ok
    else
      bad "plan-mode-$name" "$name/SKILL.md has a \`[plan mode]\` marker but no line stating it is Claude-Code-only"
    fi
  else ok
  fi

  bytes="$(wc -c < "$f" | tr -d ' ')"
  if [ "$bytes" -gt "$SIZE_WARN_BYTES" ]; then
    oversized="${oversized}  $name/SKILL.md ${bytes} B
"
  fi
done

if [ "$found" -gt 0 ]; then ok; else bad skill-count "no SKILL.md files under $SKILLS_DIR"; fi

echo "skill-neutral-lint: $pass passed, $fail failed ($found skills)"
if [ -n "$oversized" ]; then
  printf 'WARN over %s B (Codex per-skill cap watchlist, not a failure):\n%s' "$SIZE_WARN_BYTES" "$oversized"
fi
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
