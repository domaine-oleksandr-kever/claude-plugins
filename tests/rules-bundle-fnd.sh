#!/usr/bin/env bash
# Assertions for the fnd-authored half of the Cursor rules bundle (M4).
# Rules are always-on context on every Cursor session, so each `.mdc` has to parse as a rule
# (frontmatter + body), carry the alwaysApply value it was designed with, stay small, and — for
# the four transplanted sessionStart texts — stay recognizably the hook's text, since the hook
# is the single home and a hand-made copy is exactly what drifts.
# The foundation import half of the bundle is a separate deliverable; this suite only looks at
# `fnd-*.mdc`, so the two halves can land independently.
# Usage: rules-bundle-fnd.sh [rules-dir]   (default: plugins/fnd/rules)
# Exit 0 = the fnd rules are shippable.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RULES_DIR="${1:-$ROOT/plugins/fnd/rules}"
HOOKS_DIR="$ROOT/plugins/fnd/hooks"

# Budgets. The pack is read on every prompt: the guidelines pair is the part that could grow
# unbounded, so it gets the tightest guard (6 KiB, the M4 brief's ceiling).
MAX_FILE_BYTES=4096
MAX_GUIDELINES_BYTES=6144
# 17 KiB, raised from 15 when untrusted-content joined the transplanted set: every ungated
# sessionStart convention has to reach Cursor somehow, and rules are the only channel there.
MAX_PACK_BYTES=17408

# name:alwaysApply:kind:canonical-source
# kind `hook` = transplant of hooks/<source>.md; kind `doc` = guidelines rule-pack.
EXPECTED="fnd-comment-discipline:true:hook:comment-discipline
fnd-lean-code:true:hook:lean-code
fnd-task-workspace:true:hook:task-workspace
fnd-mcp-whale:true:hook:mcp-whale
fnd-untrusted-content:true:hook:untrusted-content
fnd-plugin-feedback:true:hook:plugin-feedback
fnd-model-policy:true:doc:guidelines
fnd-agent-usage:true:doc:guidelines"

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

# fm <file> — frontmatter body (between the opening and closing `---`), empty when malformed
fm() {
  awk 'NR == 1 { if ($0 != "---") exit 1; next } $0 == "---" { exit } { print }' "$1" 2>/dev/null
}

# body <file> — everything after the closing `---`
body() {
  awk 'NR == 1 && $0 == "---" { in_fm = 1; next } in_fm && $0 == "---" { in_fm = 0; started = 1; next } started { print }' "$1"
}

# fmval <file> <key> — trimmed frontmatter value, empty when the key is absent
fmval() {
  fm "$1" | awk -v k="$2" '
    $0 ~ "^" k ":" { v = substr($0, length(k) + 2); sub(/^[ \t]+/, "", v); sub(/[ \t]+$/, "", v); print v; exit }
  '
}

# shared <rule> <hook> — percent of the hook's non-blank lines still present verbatim in the rule
shared() {
  awk '
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    NR == FNR { if ($0 ~ /[^ \t]/) seen[trim($0)] = 1; next }
    $0 ~ /[^ \t]/ { total++; if (trim($0) in seen) hit++ }
    END { printf "%d", (total ? hit * 100 / total : 0) }
  ' "$1" "$2"
}

if [ -d "$RULES_DIR" ]; then ok; else bad rules-dir "not a directory: $RULES_DIR"; exit 1; fi

# ------------------------------------------------------------------ the designed set --
# Every fnd rule on disk must be in EXPECTED and vice versa: a new always-on rule is a context
# cost and a design decision, so it lands with a row here or not at all.
for f in "$RULES_DIR"/fnd-*.mdc; do
  [ -f "$f" ] || continue
  n="$(basename "$f" .mdc)"
  if printf '%s\n' "$EXPECTED" | grep -q "^$n:"; then ok
  else bad "unexpected-$n" "$n.mdc is not in this suite's design map"; fi
done

# The loop reads from a here-document, not a pipe: a piped `while` would count its passes in a
# subshell and this suite would report an empty run as green.
while IFS=: read -r name want_always kind source; do
  [ -n "$name" ] || continue
  f="$RULES_DIR/$name.mdc"
  if [ -f "$f" ]; then ok; else bad "exists-$name" "missing $name.mdc"; continue; fi

  # --- frontmatter parses and is a flat key: value block
  front="$(fm "$f")"
  if [ -n "$front" ]; then ok
  else bad "frontmatter-$name" "no '---' frontmatter block starting on line 1"; continue; fi
  strays="$(printf '%s\n' "$front" | grep -vcE '^[A-Za-z][A-Za-z0-9-]*:|^[ \t]*(-|#)|^[ \t]*$' || true)"
  if [ "${strays:-0}" -eq 0 ]; then ok
  else bad "frontmatter-$name" "$strays frontmatter line(s) are not 'key: value'"; fi

  desc="$(fmval "$f" description)"
  if [ -n "$desc" ]; then ok; else bad "description-$name" "empty or absent description"; fi

  always="$(fmval "$f" alwaysApply)"
  if [ "$always" = "$want_always" ]; then ok
  else bad "alwaysApply-$name" "alwaysApply is '$always', designed as '$want_always'"; fi

  # an alwaysApply rule is unscoped by definition — a globs value next to it is dead config
  # that reads as a scope the host never applies
  if [ "$want_always" = true ] && [ -n "$(fmval "$f" globs)" ]; then
    bad "globs-$name" "alwaysApply rule also declares globs"
  else ok; fi

  # --- body: real content, headed, and free of Claude-Code-only expansions
  text="$(body "$f")"
  lines="$(printf '%s\n' "$text" | grep -c '[^[:space:]]' || true)"
  if [ "${lines:-0}" -ge 5 ]; then ok
  else bad "body-$name" "body has ${lines:-0} non-blank lines"; fi
  if printf '%s\n' "$text" | grep -q '^## '; then ok
  else bad "heading-$name" "body has no '## ' heading"; fi
  if grep -q 'CLAUDE_PLUGIN_ROOT' "$f"; then
    bad "plugin-root-$name" "\${CLAUDE_PLUGIN_ROOT} — no host outside Claude Code expands it"
  else ok; fi
  # `/fnd:<skill>` is a Claude Code slash command; elsewhere the skill is reached differently
  if grep -n '/fnd:' "$f" | grep -qv 'Claude Code'; then
    bad "invocation-$name" "/fnd: command mentioned without a 'Claude Code' guard"
  else ok; fi

  # --- provenance + drift
  case "$kind" in
    hook)
      hook="$HOOKS_DIR/$source.md"
      if grep -q "hooks/$source.md" "$f"; then ok
      else bad "provenance-$name" "header does not name hooks/$source.md as the canonical source"; fi
      if grep -qi 'garden' "$f"; then ok
      else bad "provenance-$name" "no M8 garden-check note about the hand-made transplant"; fi
      if [ -f "$hook" ]; then
        pct="$(shared "$f" "$hook")"
        if [ "$pct" -ge 50 ]; then ok
        else bad "drift-$name" "only $pct% of hooks/$source.md survives verbatim — re-transplant"; fi
      else bad "drift-$name" "canonical hook missing: hooks/$source.md"; fi
      ;;
    doc)
      if grep -q 'Model Selection and Agentic Usage Guidelines' "$f" && grep -q 'v1\.0' "$f"; then ok
      else bad "provenance-$name" "does not cite the guidelines doc title + version"; fi
      ;;
  esac

  bytes="$(wc -c < "$f" | tr -d ' ')"
  if [ "$bytes" -le "$MAX_FILE_BYTES" ]; then ok
  else bad "size-$name" "$bytes B over the ${MAX_FILE_BYTES} B per-rule budget"; fi
done <<EOF
$EXPECTED
EOF

# ------------------------------------------------ guidelines coverage (the M4 checklist) --
POLICY="$RULES_DIR/fnd-model-policy.mdc"
USAGE="$RULES_DIR/fnd-agent-usage.mdc"
covers() {
  f="$1"; label="$2"; pat="$3"
  if [ -f "$f" ] && grep -qF "$pat" "$f"; then ok
  else bad "coverage-$label" "$(basename "$f") does not encode: $pat"; fi
}
covers "$POLICY" ladder 'Composer 2.5 → Claude Sonnet → GPT-5.5 → Claude Opus'
covers "$POLICY" scenarios 'bug-hunter agent'
covers "$POLICY" scenarios-ship 'ship conductor'
covers "$POLICY" auto-tier 'never as an escalation target'
covers "$POLICY" avoid 'Avoid'
covers "$POLICY" failure-ladder 'Still failing'
covers "$USAGE" preflight 'Pre-flight'
covers "$USAGE" prompt-format 'Objective / Context'
covers "$USAGE" investigation 'Separate investigation from implementation'
covers "$USAGE" plan-mode 'Plan Mode'
covers "$USAGE" bounded 'One primary outcome per session'
covers "$USAGE" continue 'bare "Continue"'
covers "$USAGE" concurrent 'second parallel agent'
covers "$USAGE" data-bans 'credentials'
covers "$USAGE" completion 'qa-feature-or-fix'
covers "$USAGE" completion-review 'pre-commit-review'
# the Codex/OpenCode model maps are unsigned-off — the Cursor rule must say so rather than
# read as policy for every host
covers "$POLICY" proposed 'PROPOSED'

# the pre-flight checklist is the doc's 13 boxes; the rule renders them as one middot-joined run,
# so 13 items means 12 separators
if [ -f "$USAGE" ]; then
  seps="$(awk '/\*\*Pre-flight/, /^$/' "$USAGE" | grep -o '·' | wc -l | tr -d ' ')"
  if [ "$((seps + 1))" -ge 13 ]; then ok
  else bad coverage-preflight-boxes "pre-flight lists $((seps + 1)) items, the doc has 13"; fi
fi

# -------------------------------------------------------------------------- budgets --
pack_bytes="$(cat "$RULES_DIR"/fnd-*.mdc 2>/dev/null | wc -c | tr -d ' ')"
guidelines_bytes="$(cat "$POLICY" "$USAGE" 2>/dev/null | wc -c | tr -d ' ')"
if [ "${guidelines_bytes:-0}" -le "$MAX_GUIDELINES_BYTES" ] && [ "${guidelines_bytes:-0}" -gt 0 ]; then ok
else bad size-guidelines "guidelines pack ${guidelines_bytes} B over the ${MAX_GUIDELINES_BYTES} B budget"; fi
if [ "${pack_bytes:-0}" -le "$MAX_PACK_BYTES" ] && [ "${pack_bytes:-0}" -gt 0 ]; then ok
else bad size-pack "fnd rules pack ${pack_bytes} B over the ${MAX_PACK_BYTES} B budget"; fi

echo "rules-bundle-fnd: $pass passed, $fail failed (pack ${pack_bytes} B, guidelines ${guidelines_bytes} B)"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
