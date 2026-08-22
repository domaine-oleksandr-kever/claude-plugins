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

# ---------------------------------------------------------------------------
# M7 — orchestration degradation contract
# No new scanning rule is warranted: rule 2 already fails an unguarded `Workflow(`/`ultracode`
# (self-tested below). What needs asserting is that the ONE host-conditional fallback exists,
# is single-homed in pipeline-phases.md, is honest about the loss, and is reachable from the
# files that need it — while the Claude Code path keeps every brief it always had.
# ---------------------------------------------------------------------------

PHASES="$REF_DIR/pipeline-phases.md"
FLOW="$REF_DIR/review-flow.md"
RESEARCH="$REF_DIR/research-pressure-test.md"
SHIP="$PLUGIN_DIR/skills/ship/SKILL.md"

# has <file> <label> <extended-regex> <what-is-missing>
has() {
  if [ -f "$1" ] && grep -qEi "$3" "$1"; then ok; else bad "m7-$2" "$2: $4"; fi
}

# the Orchestration section only — from its heading to the next `## `
orch="$(awk '/^## Orchestration/ { on = 1; print; next } on && /^## / { exit } on { print }' "$PHASES" 2>/dev/null)"
if [ -n "$orch" ]; then ok; else bad m7-orchestration "pipeline-phases.md has no '## Orchestration' section"; fi

# the fallback is described once, for every non-Claude host, and names Claude Code as the unchanged path
for host in "Claude Code" "Cursor" "OpenCode" "Codex"; do
  case "$orch" in
    *"$host"*) ok ;;
    *) bad m7-orchestration-host "pipeline-phases.md → Orchestration never names $host" ;;
  esac
done
# ONE fallback, not three: the hoisted shape is stated as the single branch
case "$orch" in
  *"One fallback, not a variant per host"*) ok ;;
  *) bad m7-one-fallback "pipeline-phases.md → Orchestration does not state the single-fallback rule" ;;
esac
# per-host mechanics that must stay documented
case "$orch" in *subagent_depth*) ok ;; *) bad m7-opencode "Orchestration omits OpenCode's subagent_depth" ;; esac
case "$orch" in *max_concurrent_threads_per_session*) ok ;; *) bad m7-codex "Orchestration omits Codex's concurrency lever" ;; esac
# honest loss accounting
case "$orch" in *"adversarial verify fan-out"*) ok ;; *) bad m7-loss "Orchestration does not name the lost adversarial verify fan-out" ;; esac
case "$orch" in *telemetry*) ok ;; *) bad m7-loss "Orchestration does not name the lost phase telemetry" ;; esac

# the callers that need the branch point at it — single home, no second copy
has "$FLOW" review-flow 'pipeline-phases\.md.*Orchestration' \
  "review-flow.md §2 does not point at pipeline-phases.md → Orchestration"
has "$SHIP" ship-skill 'pipeline-phases\.md.*Orchestration|Orchestration governs' \
  "ship/SKILL.md Step 4 does not point at the Orchestration section"
has "$RESEARCH" research 'top-level session' \
  "research-pressure-test.md does not pin the sweep to the top-level session"

# Claude Code path preserved: every phase brief still reachable, review-flow keeps its three parts
for phase in implement qa finalize create-pr steps-to-test aftercare jira-hand-off; do
  if grep -qE "^[0-9]+\. \*\*$phase\*\*" "$PHASES"; then ok
  else bad m7-phase-brief "pipeline-phases.md lost the '$phase' brief heading"; fi
done
for part in "## 1\. The marker" "## 2\. How the checks run" "## 3\. On entry"; do
  if grep -qE "^$part" "$FLOW"; then ok; else bad m7-review-part "review-flow.md lost section '$part'"; fi
done

# self-test of rule 2's guard on the phrasing the M7 prose uses — proves the new lines are
# clean because they are guarded, not because the rule stopped matching
tmp="$(mktemp -d 2>/dev/null || mktemp -d -t refneutral)"
printf 'On Claude Code, the host scripted Workflow (ultracode) layer stays out of it.\n' > "$tmp/guarded.md"
printf 'The conductor calls Workflow(step) through the ultracode layer.\n' > "$tmp/unguarded.md"
if [ -z "$(violations "$tmp/guarded.md" claude-only)" ]; then ok
else bad m7-selftest "guard self-test: a guarded 'On Claude Code …ultracode' line was flagged"; fi
if [ "$(violations "$tmp/unguarded.md" claude-only | wc -l | tr -d ' ')" = 1 ]; then ok
else bad m7-selftest "guard self-test: an unguarded ultracode/Workflow( line was NOT flagged"; fi
rm -rf "$tmp"

echo "reference-neutral-lint: $pass passed, $fail failed ($found files)"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
