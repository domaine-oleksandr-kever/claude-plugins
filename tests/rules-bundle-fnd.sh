#!/usr/bin/env bash
# Assertions for the fnd half of the Cursor rules bundle: the generated hook rules + the guidelines pack.
# Rules are always-on context on every Cursor session, so each `.mdc` has to parse as a rule
# (frontmatter + body), carry the alwaysApply value it was designed with, and stay small. Each
# hook-kind rule is its sessionStart text produced by the generator, so "still the hook's text" is
# a byte comparison the generator owns; this suite guards shape, budget and the designed set.
# The foundation import half of the bundle is a separate deliverable; this suite only looks at
# `fnd-*.mdc`, so the two halves can land independently.
# Reads the repo's own bundle (plugins/fnd/rules) — the drift rail below needs the generator beside it.
# Exit 0 = the fnd rules are shippable.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RULES_DIR="$ROOT/plugins/fnd/rules"

# Budgets. The pack is read on every prompt: the guidelines pair is the part that could grow
# unbounded, so it gets the tightest guard (6 KiB, the M4 brief's ceiling).
MAX_FILE_BYTES=4096
MAX_GUIDELINES_BYTES=6144
# 17 KiB: every ungated sessionStart convention has to reach Cursor somehow, and rules are the only
# channel there.
MAX_PACK_BYTES=17408

# name:alwaysApply:kind:canonical-source
# kind `hook` = generated from hooks/<source>.md; kind `doc` = guidelines rule-pack.
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
  # the same for `/compact`, `claude --resume` and the `<plugin root>` session line: Claude Code
  # names that a rewrite has to guard or replace, wherever in the hook they land. The guard may sit
  # on the line before, where the sentence wraps.
  if awk 'prev !~ /Claude Code/ && $0 !~ /Claude Code/ && /\/compact|claude --resume|<plugin root>/ { hit = 1 }
          { prev = $0 } END { exit !hit }' "$f"; then
    bad "host-token-$name" "carries /compact, claude --resume or <plugin root> without a 'Claude Code' guard"
  else ok; fi

  # --- provenance
  case "$kind" in
    hook)
      if grep -q "hooks/$source.md" "$f"; then ok
      else bad "provenance-$name" "header does not name hooks/$source.md as the canonical source"; fi
      if grep -qF 'GENERATED by scripts/gen-host-adapters.cjs' "$f"; then ok
      else bad "provenance-$name" "header does not mark the rule as generator output"; fi
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

# The hook-kind rules are generator output, so "still the hook's text" is a byte comparison, not a
# score. `--check` covers the whole generated tree; only its lines about a rule count here — drift
# in an adapter is gen-adapters-sim's finding. A generator that dies leaves the rules unverifiable.
GEN="$ROOT/plugins/fnd/scripts/gen-host-adapters.cjs"
if [ ! -f "$GEN" ]; then bad drift-generated "no scripts/gen-host-adapters.cjs beside $RULES_DIR"
elif ! command -v node >/dev/null 2>&1; then bad drift-generated "node not on PATH"
else
  out="$(node "$GEN" --check 2>&1)"; rc=$?
  rule_line="$(printf '%s\n' "$out" | grep 'fnd-[a-z-]*\.mdc' | head -1)"
  if [ "$rc" = 0 ]; then ok
  elif [ -n "$rule_line" ]; then bad drift-generated "$rule_line"
  elif [ "$rc" = 1 ]; then ok
  else bad drift-generated "generator exit $rc: $(printf '%s' "$out" | head -1)"; fi
fi

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
