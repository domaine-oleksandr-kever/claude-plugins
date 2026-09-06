#!/usr/bin/env bash
# Simulation harness for the CODEX hook wiring — plugins/fnd/hooks/hooks-codex.json.
#
# The hook LOGIC is single-copy (hooks/*.cjs|sh, canonical, frozen on Claude Code behavior), so
# this suite never re-tests what tests/hooks-sim.sh already pins. It tests the WIRING: that the
# Codex file runs the same scripts, with the same switches, on the same stdin, and reaches the
# same outcomes on a host whose event names, tool names and root env var differ.
#
#   W cases — the wiring file itself: valid JSON, every event present, every referenced script
#             resolves, and each command is the CLAUDE command byte-for-byte modulo the root
#             expansion (the near-verbatim contract — a hook added to plugin.json and forgotten
#             here fails the suite). Matchers are Codex regexes: the shell PreToolUse one covers
#             all three spellings of the shell tool (Bash / shell / local_shell) and nothing
#             else, and the scratch-path group's covers both host spellings of the two
#             screenshot tools (Codex's MCP names carry no plugin_fnd_ prefix).
#   S cases — SessionStart through the wiring: per-file tolerance, FND_LEAN gate, store-access
#             detection, always exit 0, the real plugin root's whale instruction — plus the two
#             root env vars Codex sets (CLAUDE_PLUGIN_ROOT alias and PLUGIN_ROOT) and the
#             injected size measured against Codex's ~2500-token additionalContextLimit.
#   G cases — UserPromptSubmit gate: FND_CTX_MONITOR / FND_PROMPT_JSON semantics through the
#             Codex command, node failure never fails the hook.
#   U cases — UserPromptSubmit end-to-end with real node: a guard block reaches stdout as
#             {"decision":"block"}, a context notice as hookSpecificOutput.additionalContext —
#             both shapes Codex documents.
#   T cases — SubagentStart: code-writing agents get the conventions, readers are skipped,
#             FND_LEAN=0 drops lean-code, always exit 0.
#   B cases — PreToolUse guards through the wiring: exit-2 blocks with a reason on stderr,
#             stdin arrives byte-exact, the child's exit code propagates unchanged (fail-open
#             stays fail-open, the hard block stays a hard block), and Codex's own payload shape
#             (tool_name "shell", ARRAY command) still blocks — plus B12, the scratch-path guard
#             on the second PreToolUse group, which denies on the JSON channel (exit 0) and
#             fails open on its switch and on an unresolvable plugin root.
#   X cases — the no-verify / no-AI-attribution bypass matrix re-run through the Codex wiring:
#             a representative row from every class in tests/no-verify-bypass-matrix.sh (which
#             stays the full FP/FN contract against the scripts themselves), driven through the
#             wired command pair exactly as Codex would run it.
#   M cases — PostToolUse through hooks/codex-mcp-shim.cjs: the FND_MCP_SLIM gate, a whale
#             stubbed into additionalContext with a byte-exact spill, a merely-compressible
#             result dropped (Codex cannot rewrite tool output — re-injecting the compressed
#             body would GROW context), the rails (error shape, small result, malformed stdin,
#             a broken mcp-slim) all silent, and __dirname resolution that ignores a wrong
#             plugin-root env.
#
# PROTOCOL ASSUMPTIONS recorded here because JSON carries no comments (all → verify at M1b):
#   - hooks-codex.json is a {description, hooks: <event map>} envelope — MEASURED at M1b
#     (live 2026-08-23): a bare event map is rejected at parse time with "unknown field
#     `SessionStart`, expected `description` or `hooks`". The inner map is Claude-shaped:
#     Event → array of {matcher?, hooks:[{type,command}]}.
#   - SessionStart / SubagentStart stdout becomes context (Claude parity). If Codex requires the
#     JSON channel instead, only the wiring changes — the scripts already emit plain text.
#   - Exit 2 + stderr blocks a tool call; `permissionDecision: "deny"` is the JSON equivalent and
#     is NOT used here, because the canonical guards block by exit code on every host.
#   - Codex hooks require a one-time `/hooks` trust review, per content hash — an update that
#     touches a hook script or this wiring re-triggers it (install docs, M9).
# Exit 0 = all green.
set -u

# A developer watching the live compressor log must not have fixture noise appended to it, and
# their exported switches must not leak into the cases.
unset FND_MCP_SLIM_DEBUG FND_MCP_SLIM_DIR FND_MCP_SLIM_STUB FND_LEAN FND_CTX_MONITOR FND_PROMPT_JSON

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUG="$ROOT/plugins/fnd"
WIRING="$PLUG/hooks/hooks-codex.json"
MANIFEST="$PLUG/.claude-plugin/plugin.json"
RULES="$PLUG/hooks/no-verify.rules"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0; failures=""
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); failures="${failures}  [$1] $2
"; }
assert_contains() { case "$2" in *"$3"*) ok ;; *) bad "$1" "missing: $3" ;; esac; }
assert_absent()   { case "$2" in *"$3"*) bad "$1" "unexpected: $3" ;; *) ok ;; esac; }
assert_eq()       { if [ "$2" = "$3" ]; then ok; else bad "$1" "got '$2', want '$3'"; fi; }

wcmd() { # event [hook-index] — the command Codex would run
  jq -r --arg e "$1" --argjson i "${2:-0}" '.hooks[$e][0].hooks[$i].command' "$WIRING"
}
ccmd() { # event [hook-index] — the canonical Claude Code command
  jq -r --arg e "$1" --argjson i "${2:-0}" '.hooks[$e][0].hooks[$i].command' "$MANIFEST"
}
# The near-verbatim contract in one function: the Codex command IS the Claude command with the
# root expansion swapped for a shell variable resolved from either env var Codex sets.
codex_spelling() { printf '%s' "$1" | sed -e 's/\${CLAUDE_PLUGIN_ROOT}/$r/g'; }
want_cmd() { printf 'r="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"; %s' "$(codex_spelling "$1")"; }

# ═══ W — the wiring file ════════════════════════════════════════════════════
if jq -e . "$WIRING" >/dev/null 2>&1; then ok; else bad W0-json "hooks-codex.json is not valid JSON"; fi

# W0b: the envelope Codex actually parses — exactly {description, hooks} at top level; any other
# key is the parse error the live install hit ("unknown field …, expected `description` or `hooks`")
if [ "$(jq -r 'keys | sort | join(",")' "$WIRING")" = "description,hooks" ]; then ok
else bad W0b-envelope "top level must be exactly {description, hooks}"; fi

# W1: one matcher group per event on each side — a group added to plugin.json and forgotten here
# (or the reverse) is a hook that silently does not exist on this host.
for ev in SessionStart UserPromptSubmit SubagentStart PreToolUse PostToolUse; do
  n="$(jq -r --arg e "$ev" '.hooks[$e] | length' "$WIRING" 2>/dev/null)"
  c="$(jq -r --arg e "$ev" '.hooks[$e] | length' "$MANIFEST" 2>/dev/null)"
  if [ "$n" = "$c" ]; then ok; else bad "W1-$ev" "want $c entr(ies) like plugin.json, got '$n'"; fi
done

# W2: same events as the canonical block — no fnd hook may exist on Claude Code and not on Codex.
cev="$(jq -r '.hooks | keys[]' "$MANIFEST" | sort)"
xev="$(jq -r '.hooks | keys[]' "$WIRING" | sort)"
assert_eq W2-event-parity "$xev" "$cev"

# W3: every shared command is the Claude command, verbatim, modulo the root expansion.
# PreToolUse:0/1 are carved out — see W3b. They are the two commands that may NOT be a bare
# root expansion: an unset root would run "/hooks/<guard>.sh", which exits 127, and Codex reads
# a 127 as "the hook did not block" and runs the git command unchecked. A fail-closed probe is
# not expressible as the Claude command plus a variable, so the contract for those two is the
# set of properties below instead of byte-equality.
for pair in "SessionStart:0" "UserPromptSubmit:0" "SubagentStart:0"; do
  ev="${pair%%:*}"; idx="${pair#*:}"
  assert_eq "W3-$ev-$idx" "$(wcmd "$ev" "$idx")" "$(want_cmd "$(ccmd "$ev" "$idx")")"
done

# W3b: the guard commands' own contract — single-copy script, probe order, cache fallback,
# deny-on-unresolved, and the git-verb gate in front of that deny.
for pair in "0:no-ai-attribution.sh" "1:no-verify-bypass.sh"; do
  idx="${pair%%:*}"; sh="${pair#*:}"
  g="$(wcmd PreToolUse "$idx")"
  # the canonical script, run by path — never a per-host copy of the guard logic
  assert_contains "W3b-$sh-script"   "$g" "\$r/hooks/$sh"
  # probe order: the documented alias first, Codex's own var second, the marketplace cache last
  assert_contains "W3b-$sh-claude"   "$g" '"${CLAUDE_PLUGIN_ROOT:-}"'
  assert_contains "W3b-$sh-plugin"   "$g" '"${PLUGIN_ROOT:-}"'
  assert_contains "W3b-$sh-cache"    "$g" '"$HOME"/.codex/plugins/cache/*/fnd/*'
  # each candidate is validated by the script actually being there, and the newest cache entry
  # wins (a stale version dir left behind by an upgrade must not shadow the current one)
  assert_contains "W3b-$sh-validate" "$g" "[ -f \"\$c/hooks/$sh\" ]"
  assert_contains "W3b-$sh-newest"   "$g" '[ "$c" -nt "$r" ]'
  # nothing resolved → deny, and only for a payload that names a git verb
  assert_contains "W3b-$sh-gate"     "$g" 'case "$(cat)" in *git*|*commit*|*push*|*merge*|*pull*)'
  assert_contains "W3b-$sh-exit2"    "$g" 'exit 2'
  assert_absent   "W3b-$sh-failopen" "$g" '|| true'
  # the claude-side alias order the rest of the wiring uses must not silently reappear here:
  # `${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}` cannot fall through to the cache
  assert_absent   "W3b-$sh-no-bare-expansion" "$g" '${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}'
done

# W4: the ONE deliberate divergence — PostToolUse routes through the Codex adapter instead of
# mcp-slim directly, because this host cannot replace a tool result. Everything else about the
# command (the FND_MCP_SLIM gate, the `|| true` fail-open) is unchanged.
assert_eq W4-posttooluse "$(wcmd PostToolUse 0)" \
  "$(printf '%s' "$(want_cmd "$(ccmd PostToolUse 0)")" | sed -e 's#hooks/mcp-slim.cjs#hooks/codex-mcp-shim.cjs#')"

# W5: every script the wiring names exists in the canonical hooks dir (single-copy: no forked
# per-host copy of a guard or of the compressor).
scripts="$(jq -r '.hooks | to_entries[] | .value[] | .hooks[] | .command' "$WIRING" | grep -oE 'hooks/[a-z0-9-]+\.(cjs|sh)' | sort -u)"
for s in $scripts; do
  if [ -f "$PLUG/$s" ]; then ok; else bad "W5-$s" "wiring names a file that does not exist"; fi
done
assert_eq W5-count "$(printf '%s\n' "$scripts" | grep -c .)" 7

# W6: PreToolUse matcher — Codex regex, covering every spelling of the shell tool and nothing else.
pm="$(jq -r '.hooks.PreToolUse[0].matcher' "$WIRING")"
for t in Bash shell local_shell; do
  if printf '%s\n' "$t" | grep -Eq "$pm"; then ok; else bad "W6-$t" "PreToolUse matcher '$pm' misses the shell tool"; fi
done
for t in Read Write mcp__plugin_fnd_atlassian__getJiraIssue; do
  if printf '%s\n' "$t" | grep -Eq "$pm"; then bad "W6-not-$t" "PreToolUse matcher '$pm' over-matches"; else ok; fi
done

# W7: PostToolUse matcher — MCP tools only.
qm="$(jq -r '.hooks.PostToolUse[0].matcher' "$WIRING")"
if printf '%s\n' "mcp__plugin_fnd_atlassian__getJiraIssue" | grep -Eq "$qm"; then ok; else bad W7-mcp "PostToolUse matcher '$qm' misses an MCP tool"; fi
if printf '%s\n' "Bash" | grep -Eq "$qm"; then bad W7-bash "PostToolUse matcher '$qm' matches Bash"; else ok; fi

# W8: both guards stay wired, in the canonical order (attribution first, no-verify second).
assert_eq W8-guard-count "$(jq -r '.hooks.PreToolUse[0].hooks | length' "$WIRING")" 2
assert_contains W8-attr-first "$(wcmd PreToolUse 0)" "no-ai-attribution.sh"
assert_contains W8-nv-second  "$(wcmd PreToolUse 1)" "no-verify-bypass.sh"

# W9: the execpolicy layer ships, is opt-in (nothing in the wiring points at it), and covers the
# verbs the guard's own message names.
if [ -f "$RULES" ]; then ok; else bad W9-rules "hooks/no-verify.rules missing"; fi
if grep -q "no-verify.rules" "$WIRING"; then bad W9-optin "the wiring references the rules file — it must stay opt-in until M1b"; else ok; fi
for verb in commit push merge am; do
  if grep -q "\"git\", \"$verb\", \"--no-verify\"" "$RULES"; then ok; else bad "W9-$verb" "no prefix_rule forbidding git $verb --no-verify"; fi
done
# the dry-run rail: -n is a bypass on commit and a DRY RUN on push (matrix rows A23–A25)
if grep -q '"git", "commit", "-n"' "$RULES"; then ok; else bad W9-commit-n "no prefix_rule forbidding git commit -n"; fi
if grep -q '"git", "push", "-n"' "$RULES"; then bad W9-push-n "git push -n is a dry run, not a bypass"; else ok; fi

# W10: the SECOND PreToolUse group — the scratch-path guard (M3). Unlike the git guards it is
# near-verbatim (byte-equal to the Claude command modulo the root expansion): it denies through
# permissionDecision JSON on exit 0, so an unresolvable root is a plain fail-open, not a hole.
SPG_CMD="$(jq -r '.hooks.PreToolUse[] | select(.matcher | test("take_screenshot")) | .hooks[0].command' "$WIRING")"
CSPG_CMD="$(jq -r '.hooks.PreToolUse[] | select(.matcher | test("take_screenshot")) | .hooks[0].command' "$MANIFEST")"
assert_eq       W10-verbatim  "$SPG_CMD" "$(want_cmd "$CSPG_CMD")"
assert_contains W10-script    "$SPG_CMD" '$r/hooks/scratch-path-guard.cjs'
assert_contains W10-gate      "$SPG_CMD" '"${FND_SCRATCH_GUARD:-1}" = "0"'
assert_contains W10-failopen  "$SPG_CMD" '|| true'
# W10b: the matcher is prefix-agnostic on both hosts — Codex names an MCP tool
# mcp__<server>__<tool> from mcp-codex.json, without the plugin_fnd_ prefix Claude Code adds, and
# on Claude Code the same servers are often installed per-user — so BOTH spellings of the two
# screenshot tools must match, and the two hosts' matchers must not drift apart.
spm="$(jq -r '.hooks.PreToolUse[] | select(.matcher | test("take_screenshot")) | .matcher' "$WIRING")"
assert_eq W10b-matcher-parity "$spm" \
  "$(jq -r '.hooks.PreToolUse[] | select(.matcher | test("take_screenshot")) | .matcher' "$MANIFEST")"
for t in mcp__plugin_fnd_chrome-devtools-mcp__take_screenshot mcp__plugin_fnd_playwright__browser_take_screenshot \
         mcp__chrome-devtools-mcp__take_screenshot mcp__playwright__browser_take_screenshot; do
  if printf '%s\n' "$t" | grep -Eq "$spm"; then ok; else bad "W10b-$t" "scratch matcher '$spm' misses a screenshot tool"; fi
done
for t in Bash shell mcp__chrome-devtools-mcp__take_snapshot mcp__figma-dev-mode__get_screenshot; do
  if printf '%s\n' "$t" | grep -Eq "$spm"; then bad "W10b-not-$t" "scratch matcher '$spm' over-matches"; else ok; fi
done

# W11: the THIRD PreToolUse group — hooks/spill-access.sh, the spill-read recorder. It is the one
# PreToolUse command that may never deny: it measures, so an unresolvable bundle exits 0 rather than
# blocking a tool call (the git guards' fail-closed rule would be a pure regression here).
SPA_CMD="$(jq -r '.hooks.PreToolUse[] | select(.matcher | test("Read")) | .hooks[0].command' "$WIRING")"
assert_contains W11-script    "$SPA_CMD" '$r/hooks/spill-access.sh'
assert_contains W11-gate      "$SPA_CMD" '"${FND_SPILL_ACCESS:-1}" = "0"'
assert_contains W11-claude    "$SPA_CMD" '"${CLAUDE_PLUGIN_ROOT:-}"'
assert_contains W11-plugin    "$SPA_CMD" '"${PLUGIN_ROOT:-}"'
assert_contains W11-cache     "$SPA_CMD" '"$HOME"/.codex/plugins/cache/*/fnd/*'
assert_contains W11-newest    "$SPA_CMD" '[ "$c" -nt "$r" ]'
assert_contains W11-failopen  "$SPA_CMD" 'exit 0'
assert_absent   W11-no-deny   "$SPA_CMD" 'exit 2'
# the matcher carries Codex's shell spellings alongside the two file readers
spam="$(jq -r '.hooks.PreToolUse[] | select(.matcher | test("Read")) | .matcher' "$WIRING")"
for t in Bash shell local_shell Read Grep; do
  if printf '%s\n' "$t" | grep -Eq "$spam"; then ok; else bad "W11-$t" "spill-access matcher '$spam' misses $t"; fi
done
for t in Write Edit mcp__plugin_fnd_atlassian__getJiraIssue; do
  if printf '%s\n' "$t" | grep -Eq "$spam"; then bad "W11-not-$t" "spill-access matcher '$spam' over-matches"; else ok; fi
done
# …and it records through the wiring for real: an unresolvable root is silent, a resolved one writes
# the access line the report pairs on.
SPA_D="$TMP/spa-log"; mkdir -p "$SPA_D"
SPA_PAY='{"tool_name":"shell","tool_input":{"command":["bash","-lc","jq . /p/tool-results/b1z10evqs.txt"]},"cwd":"/r/elc"}'
out="$(printf '%s' "$SPA_PAY" | env -u CLAUDE_PLUGIN_ROOT -u PLUGIN_ROOT HOME="$TMP/nohome" \
  FND_MCP_SLIM_DIR="$SPA_D" FND_MCP_SLIM_DEBUG=1 bash -c "$SPA_CMD" 2>&1)"; ec=$?
assert_eq W11-unresolved-exit   "$ec" 0
assert_eq W11-unresolved-silent "$out" ""
printf '%s' "$SPA_PAY" | env CLAUDE_PLUGIN_ROOT="$PLUG" FND_MCP_SLIM_DIR="$SPA_D" FND_MCP_SLIM_DEBUG=1 \
  bash -c "$SPA_CMD" >/dev/null 2>&1
assert_eq W11-run-exit "$?" 0
assert_contains W11-run-line "$(cat "$SPA_D/fnd-mcp-slim-debug.log" 2>/dev/null)" '"entry":"access"'
assert_contains W11-run-via  "$(cat "$SPA_D/fnd-mcp-slim-debug.log" 2>/dev/null)" '"via":"jq"'
printf '%s' "$SPA_PAY" | env CLAUDE_PLUGIN_ROOT="$PLUG" FND_SPILL_ACCESS=0 FND_MCP_SLIM_DIR="$TMP/spa-off" \
  FND_MCP_SLIM_DEBUG=1 bash -c "$SPA_CMD" >/dev/null 2>&1
if [ -e "$TMP/spa-off/fnd-mcp-slim-debug.log" ]; then bad W11-gate-off "the wiring ran the hook with FND_SPILL_ACCESS=0"; else ok; fi

# ═══ S — SessionStart through the Codex wiring ══════════════════════════════
SS_CMD="$(wcmd SessionStart)"
fake="$TMP/plugroot"; mkdir -p "$fake/hooks"
for f in comment-discipline plugin-feedback store-access task-workspace lean-code mcp-whale untrusted-content; do
  echo "MARK-$f" > "$fake/hooks/$f.md"
done
SS_STORE="$TMP/ss-store"; mkdir -p "$SS_STORE"; : > "$SS_STORE/shopify.theme.toml"
SS_ENV="$TMP/ss-env";     mkdir -p "$SS_ENV";   : > "$SS_ENV/.env"
SS_PLAIN="$TMP/ss-plain"; mkdir -p "$SS_PLAIN"

out="$(cd "$SS_STORE" && CLAUDE_PLUGIN_ROOT="$fake" bash -c "$SS_CMD" 2>/dev/null)"; ec=$?
assert_eq S1-all-present-exit "$ec" 0
for f in comment-discipline plugin-feedback store-access task-workspace lean-code mcp-whale untrusted-content; do
  assert_contains "S1-$f" "$out" "MARK-$f"
done

rm "$fake/hooks/plugin-feedback.md"
out="$(cd "$SS_STORE" && CLAUDE_PLUGIN_ROOT="$fake" bash -c "$SS_CMD" 2>/dev/null)"; ec=$?
assert_eq S2-missing-file-exit "$ec" 0
for f in comment-discipline store-access task-workspace lean-code mcp-whale untrusted-content; do
  assert_contains "S2-$f" "$out" "MARK-$f"
done
echo "MARK-plugin-feedback" > "$fake/hooks/plugin-feedback.md"

out="$(cd "$SS_STORE" && CLAUDE_PLUGIN_ROOT="$fake" FND_LEAN=0 bash -c "$SS_CMD" 2>/dev/null)"; ec=$?
assert_eq S3-lean-off-exit "$ec" 0
assert_absent S3-no-lean "$out" "MARK-lean-code"

out="$(cd "$SS_PLAIN" && CLAUDE_PLUGIN_ROOT="$fake" bash -c "$SS_CMD" 2>/dev/null)"; ec=$?
assert_eq S4-no-store-exit "$ec" 0
assert_absent S4-no-store-access "$out" "MARK-store-access"
for f in comment-discipline task-workspace lean-code mcp-whale untrusted-content; do
  assert_contains "S4-$f" "$out" "MARK-$f"
done

out="$(cd "$SS_ENV" && CLAUDE_PLUGIN_ROOT="$fake" bash -c "$SS_CMD" 2>/dev/null)"; ec=$?
assert_eq S5-env-exit "$ec" 0
assert_contains S5-env-store-access "$out" "MARK-store-access"

# S6: the REAL plugin root emits the deterministic json-slim whale-routing instruction
out="$(cd "$SS_PLAIN" && CLAUDE_PLUGIN_ROOT="$PLUG" bash -c "$SS_CMD" 2>/dev/null)"; ec=$?
assert_eq       S6-real-root-exit  "$ec" 0
assert_contains S6-whale-conv      "$out" "oversized MCP results"
assert_contains S6-whale-json-slim "$out" "json-slim.cjs"

# S7: Codex's OWN root variable — a plugin hook that only ever sees PLUGIN_ROOT must still work.
out="$(cd "$SS_STORE" && env -u CLAUDE_PLUGIN_ROOT PLUGIN_ROOT="$fake" bash -c "$SS_CMD" 2>/dev/null)"; ec=$?
assert_eq S7-plugin-root-exit "$ec" 0
assert_contains S7-plugin-root "$out" "MARK-comment-discipline"

# S8: both set (Codex sets the alias too) → the documented alias wins; a stale PLUGIN_ROOT can
# never shadow it.
other="$TMP/otherroot"; mkdir -p "$other/hooks"; echo "MARK-WRONG" > "$other/hooks/comment-discipline.md"
out="$(cd "$SS_STORE" && CLAUDE_PLUGIN_ROOT="$fake" PLUGIN_ROOT="$other" bash -c "$SS_CMD" 2>/dev/null)"
assert_contains S8-alias-wins "$out" "MARK-comment-discipline"
assert_absent   S8-no-shadow  "$out" "MARK-WRONG"

# S9: neither var set → the command still exits 0 (a hook may not break a session start).
out="$(cd "$SS_PLAIN" && env -u CLAUDE_PLUGIN_ROOT -u PLUGIN_ROOT bash -c "$SS_CMD" 2>/dev/null)"; ec=$?
assert_eq S9-no-root-exit "$ec" 0

# S10: injected size vs Codex's ~2500-token additionalContextLimit (its own spill dir catches the
# rest, but a session-start block that always spills is a design smell). 4 B/token is the
# conservative reading for markdown prose.
out="$(cd "$SS_STORE" && CLAUDE_PLUGIN_ROOT="$PLUG" bash -c "$SS_CMD" 2>/dev/null)"
bytes=$(printf '%s' "$out" | wc -c | tr -d ' ')
if [ "$bytes" -lt 10000 ]; then ok
else bad S10-context-budget "SessionStart injects $bytes B (~$((bytes / 4)) tok) — over Codex's ~2500-token additionalContextLimit"; fi

# ═══ G — UserPromptSubmit gate ══════════════════════════════════════════════
UPS_CMD="$(wcmd UserPromptSubmit)"
shim="$TMP/shim"; mkdir -p "$shim"
cat > "$shim/node" <<'SH'
#!/usr/bin/env bash
echo run >> "$NODE_LOG"
exit "${NODE_EC:-0}"
SH
chmod +x "$shim/node"

run_gate() { # [VAR=val…]
  : > "$TMP/node.log"
  env "$@" NODE_LOG="$TMP/node.log" PATH="$shim:$PATH" CLAUDE_PLUGIN_ROOT="$fake" \
    bash -c "$UPS_CMD" >/dev/null 2>&1
}

run_gate FND_CTX_MONITOR=0; ec=$?
assert_eq G1-ctx-off-exit "$ec" 0
if [ -s "$TMP/node.log" ]; then ok; else bad G1-ctx-off "node did not run with only the monitor off"; fi

run_gate FND_PROMPT_JSON=0
if [ -s "$TMP/node.log" ]; then ok; else bad G1b-json-off "node did not run with only the guard off"; fi

run_gate FND_CTX_MONITOR=0 FND_PROMPT_JSON=0; ec=$?
assert_eq G1c-both-off-exit "$ec" 0
if [ -s "$TMP/node.log" ]; then bad G1c-both-off "node ran with both switches off"; else ok; fi

run_gate; ec=$?
assert_eq G2-default-exit "$ec" 0
if [ -s "$TMP/node.log" ]; then ok; else bad G2-default "node did not run by default"; fi

run_gate FND_CTX_MONITOR=true
if [ -s "$TMP/node.log" ]; then ok; else bad G3-true "node did not run with FND_CTX_MONITOR=true"; fi

run_gate NODE_EC=1; ec=$?
assert_eq G4-node-failure-exit "$ec" 0

# ═══ U — UserPromptSubmit end-to-end (real node) ════════════════════════════
PJD="$TMP/pj"; mkdir -p "$PJD"
mk() { # blobBytes promptBytes cwd blobfile
  node -e '
    const fs=require("fs");
    const tb=+process.argv[1], tp=+process.argv[2], cwd=process.argv[3], bf=process.argv[4];
    let items=[],blob;
    do{items.push({id:items.length,pad:"x".repeat(40)});blob=JSON.stringify({items});}while(blob.length<tb);
    fs.writeFileSync(bf,blob);
    const need=Math.max(0, tp-blob.length-2);
    const prompt=(need?"z".repeat(need)+"\n":"")+blob;
    process.stdout.write(JSON.stringify({prompt,cwd}));
  ' "$1" "$2" "$3" "$4"
}
run_prompt() { # input-json [VAR=val…]
  local in="$1"; shift
  printf '%s' "$in" | env TMPDIR="$PJD" CLAUDE_PLUGIN_ROOT="$PLUG" "$@" bash -c "$UPS_CMD" 2>/dev/null
}

in="$(mk 20000 25000 "$PJD" "$PJD/u1.json")"
out="$(run_prompt "$in")"; ec=$?
assert_eq       U1-exit  "$ec" 0
assert_contains U1-block "$out" '"decision":"block"'
p="$(printf '%s' "$out" | jq -r '.reason' 2>/dev/null | grep -oE '/[^[:space:]]+fnd-prompt-json-[^[:space:]]+\.json' | head -1)"
if [ -n "$p" ] && [ -f "$p" ] && cmp -s "$p" "$PJD/u1.json"; then ok; else bad U1-spill "blocked prompt's blob not spilled byte-exact (p='$p')"; fi

# U2: the context monitor's channel is hookSpecificOutput.additionalContext — the shape Codex
# documents for UserPromptSubmit.
printf '%s\n' '{"message":{"model":"claude-fable-5","usage":{"input_tokens":50000,"cache_read_input_tokens":100000,"output_tokens":1000}},"isSidechain":false}' > "$TMP/t0.jsonl"
in="$(jq -n --arg t "$TMP/t0.jsonl" --arg s "codex-u2-$$" '{transcript_path:$t,session_id:$s,prompt:"hi",cwd:"/tmp"}')"
out="$(run_prompt "$in" FND_CTX_WARN=0)"; ec=$?
assert_eq       U2-exit    "$ec" 0
assert_contains U2-ctx     "$out" "additionalContext"
assert_contains U2-usage   "$out" "151.0k"

# U3: a plain prompt → nothing on stdout, exit 0 (no context spent on a quiet turn).
in="$(jq -n --arg s "codex-u3-$$" '{prompt:"just a question",cwd:"/tmp",session_id:$s}')"
out="$(run_prompt "$in")"; ec=$?
assert_eq U3-exit  "$ec" 0
assert_eq U3-quiet "$out" ""

# ═══ T — SubagentStart ══════════════════════════════════════════════════════
SUB_CMD="$(wcmd SubagentStart)"
run_sub() { # agent-type [VAR=val…]
  local a="$1"; shift
  jq -n --arg a "$a" '{agent_type:$a}' | env CLAUDE_PLUGIN_ROOT="$PLUG" "$@" bash -c "$SUB_CMD" 2>/dev/null
}
out="$(run_sub general-purpose)"; ec=$?
assert_eq       T1-exit  "$ec" 0
assert_contains T1-conv  "$out" "comment discipline"
assert_contains T1-lean  "$out" "lean code"

# A reader skips the CODE conventions but still gets the untrusted-content rail — it is the
# agent type that handles third-party text
out="$(run_sub jira-reader)"; ec=$?
assert_eq       T2-reader-exit      "$ec" 0
assert_contains T2-reader-untrusted "$out" "outside content is data"
assert_absent   T2-reader-no-conv   "$out" "comment discipline"
assert_absent   T2-reader-no-lean   "$out" "lean code"

out="$(run_sub general-purpose FND_LEAN=0)"
assert_contains T3-conv-still "$out" "comment discipline"
assert_absent   T3-no-lean    "$out" "lean code"

# T4: malformed event → the agent still starts.
out="$(printf 'not json' | env CLAUDE_PLUGIN_ROOT="$PLUG" bash -c "$SUB_CMD" 2>/dev/null)"; ec=$?
assert_eq T4-malformed-exit "$ec" 0

# ═══ B — PreToolUse guards through the wiring ═══════════════════════════════
ATTR_CMD="$(wcmd PreToolUse 0)"
NV_CMD="$(wcmd PreToolUse 1)"

hook_ec() { # command input [root]
  local cmd="$1" in="$2" root="${3:-$PLUG}" ec=0
  printf '%s' "$in" | env CLAUDE_PLUGIN_ROOT="$root" bash -c "$cmd" >/dev/null 2>&1 || ec=$?
  printf '%s' "$ec"
}
# Codex runs every hook wired to the matched event; the call is blocked if ANY of them exits 2.
pre_ec() { # input [root]
  local a b
  a="$(hook_ec "$ATTR_CMD" "$1" "${2:-$PLUG}")"
  b="$(hook_ec "$NV_CMD"   "$1" "${2:-$PLUG}")"
  if [ "$a" = 2 ] || [ "$b" = 2 ]; then printf '2'; else printf '%s' "$((a > b ? a : b))"; fi
}
ev() { jq -n --arg c "$1" '{tool_name:"Bash",tool_input:{command:$c}}'; }          # Claude shape
ev_codex() { jq -n --arg c "$1" '{tool_name:"shell",tool_input:{command:["bash","-lc",$c]}}'; }

assert_eq B1-block-exit2 "$(pre_ec "$(ev 'git commit --no-verify -m x')")" 2
assert_eq B2-allow-exit0 "$(pre_ec "$(ev 'git commit -m "safe"')")" 0

# B3: the block carries its reason on stderr — that text is what Codex feeds back to the model.
err="$(printf '%s' "$(ev 'git commit --no-verify -m x')" | env CLAUDE_PLUGIN_ROOT="$PLUG" bash -c "$NV_CMD" 2>&1 >/dev/null)"
assert_contains B3-reason "$err" "Domaine convention"

# B4: Codex's own payload shape — tool_name "shell" and an ARRAY command — still blocks. The
# guards join the array into one line before scanning, so both array spellings are covered:
# ["bash","-lc","<one string>"] here, and the raw argv form in B7/B8 below.
assert_eq B4-codex-shape-block "$(pre_ec "$(ev_codex 'git commit --no-verify -m x')")" 2
assert_eq B4b-codex-shape-allow "$(pre_ec "$(ev_codex 'git commit -m ok')")" 0

# B7/B8: the RAW argv array — the spelling `local_shell` (and `shell` without a -lc wrapper)
# sends. `jq -r` on an array prints one element PER LINE, which puts `git` and its subcommand on
# different lines; every matcher in both guards is per-line, so an unjoined array walks past all
# of them. Run through the wired commands on both extraction paths — with jq, and with jq hidden,
# where the guards fall back to sed. tests/no-verify-bypass-matrix.sh (V / AV rows) is the full
# contract; these are the wiring's copy.
ev_argv() { jq -nc '{tool_name:"shell",tool_input:{command:$ARGS.positional}}' --args -- "$@"; }
NOJQ="$TMP/nojq"; mkdir -p "$NOJQ"
for t in cat tr sed grep awk bash env; do ln -sf "$(command -v "$t")" "$NOJQ/$t"; done
pre_ec_nojq() { # input — the same guard pair with jq off PATH
  local a=0 b=0
  printf '%s' "$1" | env CLAUDE_PLUGIN_ROOT="$PLUG" PATH="$NOJQ" bash -c "$ATTR_CMD" >/dev/null 2>&1 || a=$?
  printf '%s' "$1" | env CLAUDE_PLUGIN_ROOT="$PLUG" PATH="$NOJQ" bash -c "$NV_CMD" >/dev/null 2>&1 || b=$?
  if [ "$a" = 2 ] || [ "$b" = 2 ]; then printf '2'; else printf '%s' "$((a > b ? a : b))"; fi
}
argv_row() { # block|allow label element…
  local expect="$1" label="$2" want=0 in; shift 2
  [ "$expect" = block ] && want=2
  in="$(ev_argv "$@")"
  assert_eq "B7-$label-jq"   "$(pre_ec "$in")"      "$want"
  assert_eq "B8-$label-nojq" "$(pre_ec_nojq "$in")" "$want"
}
argv_row block argv-long      git commit --no-verify -m x
argv_row block argv-short     git commit -n -m x
argv_row block argv-bundled   git commit -anm wip
argv_row block argv-push      git push --no-verify origin main
argv_row block argv-husky     env HUSKY=0 git commit -m x
argv_row block argv-hookspath git -c core.hooksPath=/dev/null commit -m x
argv_row block argv-trailer   git commit -m 'feat: x

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>'
argv_row allow argv-clean     git commit -m ok
argv_row allow argv-push-dry  git push -n origin main
argv_row allow argv-human     git commit -m 'pair work

Co-Authored-By: Jane Doe <jane@corp.example>'

# B5: stdin reaches the script byte-for-byte and the child's exit code propagates unchanged —
# the two properties the wiring is entirely responsible for. A recorder standing in for the guard
# proves both without touching the canonical script.
rec="$TMP/recroot"; mkdir -p "$rec/hooks"
cat > "$rec/hooks/no-verify-bypass.sh" <<'SH'
#!/usr/bin/env bash
cat > "$REC_OUT"
exit "${REC_EC:-0}"
SH
chmod +x "$rec/hooks/no-verify-bypass.sh"
payload="$(printf '{"tool_name":"shell","tool_input":{"command":"echo \\"quoted\\"\tand a tab\n"}}')"
printf '%s' "$payload" | env CLAUDE_PLUGIN_ROOT="$rec" REC_OUT="$TMP/rec.txt" bash -c "$NV_CMD" >/dev/null 2>&1
printf '%s' "$payload" > "$TMP/rec.want"
if cmp -s "$TMP/rec.txt" "$TMP/rec.want"; then ok; else bad B5-stdin-byte-exact "the wiring altered the event JSON"; fi
# Every code, not just 2: the wiring may neither swallow the hard block nor invent one out of a
# script that merely failed (fail-open) — both are guard defects the exit code alone reveals.
for want in 0 1 2 7; do
  got=0
  printf '%s' "$payload" | env CLAUDE_PLUGIN_ROOT="$rec" REC_OUT="$TMP/rec.txt" REC_EC="$want" \
    bash -c "$NV_CMD" >/dev/null 2>&1 || got=$?
  assert_eq "B6-exit-$want" "$got" "$want"
done

# B9–B11: the unresolvable-root branch. With neither env var set and no marketplace cache under
# HOME, a bare `"$r/hooks/<guard>.sh"` runs "/hooks/<guard>.sh" → exit 127 → Codex proceeds, and
# the whole guard layer is gone on a broken install without anything saying so. It denies instead
# — but only for the payloads it would have inspected.
NOROOT="$TMP/noroot"; mkdir -p "$NOROOT"
noroot_ec() { # command input
  local ec=0
  printf '%s' "$2" | env -u CLAUDE_PLUGIN_ROOT -u PLUGIN_ROOT HOME="$NOROOT" \
    bash -c "$1" >/dev/null 2>&1 || ec=$?
  printf '%s' "$ec"
}
assert_eq B9-noroot-attr-denies "$(noroot_ec "$ATTR_CMD" "$(ev 'git commit -m x')")" 2
assert_eq B9b-noroot-nv-denies  "$(noroot_ec "$NV_CMD"   "$(ev 'git commit -m x')")" 2
assert_eq B10-noroot-nongit     "$(noroot_ec "$NV_CMD"   "$(ev 'ls -la')")" 0
assert_eq B10b-noroot-nongit-attr "$(noroot_ec "$ATTR_CMD" "$(ev 'npm run build')")" 0
err="$(printf '%s' "$(ev 'git commit -m x')" | env -u CLAUDE_PLUGIN_ROOT -u PLUGIN_ROOT \
  HOME="$NOROOT" bash -c "$NV_CMD" 2>&1 >/dev/null)"
assert_contains B10c-noroot-reason "$err" "could not be located"

# B11: the marketplace cache IS a resolvable root — a Codex session that sets no plugin-root env
# still finds the bundle it was installed from. Two candidates: a stale one that sorts FIRST and
# would allow everything, and the current one, newer by mtime, carrying the real guard. A block
# is the proof that the newest dir wins rather than the first one the glob happens to yield.
CXH="$TMP/codexhome"; CXC="$CXH/.codex/plugins/cache/domaine/fnd"
mkdir -p "$CXC/0.10.0/hooks" "$CXC/0.9.0/hooks" "$CXC/0.5.0"
printf '#!/usr/bin/env bash\nexit 0\n' > "$CXC/0.10.0/hooks/no-verify-bypass.sh"
chmod +x "$CXC/0.10.0/hooks/no-verify-bypass.sh"
cp "$PLUG/hooks/no-verify-bypass.sh" "$CXC/0.9.0/hooks/no-verify-bypass.sh"
touch -t 202001010000 "$CXC/0.10.0"
cache_ec() { # input
  local ec=0
  printf '%s' "$1" | env -u CLAUDE_PLUGIN_ROOT -u PLUGIN_ROOT HOME="$CXH" \
    bash -c "$NV_CMD" >/dev/null 2>&1 || ec=$?
  printf '%s' "$ec"
}
assert_eq B11-cache-newest-blocks "$(cache_ec "$(ev 'git commit --no-verify -m x')")" 2
assert_eq B11b-cache-allow        "$(cache_ec "$(ev 'git commit -m ok')")" 0

# B12: the scratch-path guard through the wired command, real node. The deny travels on STDOUT
# as permissionDecision JSON (exit stays 0 — Codex reads the JSON channel here, not the code),
# and every allow shape stays silent. The rule itself is pinned in tests/hooks-sim.sh.
SPGP="$TMP/spg-proj"; mkdir -p "$SPGP/.claude/tasks/ELC-1/tmp"
spg_run() { # key path [VAR=val…] — one screenshot event through the wired Codex command
  local key="$1" p="$2"; shift 2
  jq -cn --arg k "$key" --arg p "$p" --arg cwd "$SPGP" \
    '{hook_event_name:"PreToolUse",tool_name:"mcp__playwright__browser_take_screenshot",tool_input:{($k):$p},cwd:$cwd}' \
    | (cd "$SPGP" && env "$@" CLAUDE_PLUGIN_ROOT="$PLUG" bash -c "$SPG_CMD" 2>/dev/null)
}
out="$(spg_run filename elc-123-cart.jpeg)"; ec=$?
assert_eq       B12-exit "$ec" 0
assert_contains B12-deny "$out" '"permissionDecision":"deny"'
# The workspace path is ABSOLUTE here (v0.64.1): Codex names MCP tools without the plugin_fnd_
# prefix, so the guard cannot tell this server from a per-user one and judges it as a default-
# configured playwright — which resolves a RELATIVE filename against `<cwd>/.playwright-mcp`, not
# the project. The absolute form is what the deny reason recommends and what sails through.
out="$(spg_run filePath "$SPGP/.claude/tasks/ELC-1/tmp/shot.png")"
if [ -z "$out" ]; then ok; else bad B12b-workspace "a workspace path was denied: $out"; fi
out="$(spg_run filename elc-123-cart.jpeg FND_SCRATCH_GUARD=0)"; ec=$?
assert_eq B12c-off-exit "$ec" 0
if [ -z "$out" ]; then ok; else bad B12c-off "FND_SCRATCH_GUARD=0 still denied: $out"; fi
# an unresolvable plugin root is a fail-open here (the guard denies through JSON, not exit 2) —
# node cannot load the file, `|| true` swallows it, the screenshot proceeds
out="$(jq -cn --arg cwd "$SPGP" '{hook_event_name:"PreToolUse",tool_input:{filename:"x.png"},cwd:$cwd}' \
  | (cd "$SPGP" && env -u CLAUDE_PLUGIN_ROOT -u PLUGIN_ROOT bash -c "$SPG_CMD" 2>/dev/null))"; ec=$?
assert_eq B12d-noroot-exit "$ec" 0
if [ -z "$out" ]; then ok; else bad B12d-noroot "an unresolvable root produced output: $out"; fi

# ═══ X — the bypass matrix through the Codex wiring ═════════════════════════
# tests/no-verify-bypass-matrix.sh stays the full FP/FN contract against the scripts; these rows
# re-run one representative of every class in it through the WIRED command pair.
check() { # block|allow label command
  local expect="$1" label="$2" want=0
  [ "$expect" = block ] && want=2
  local got; got="$(pre_ec "$(ev "$3")")"
  if [ "$got" = "$want" ]; then ok; else bad "X-$label" "expected $expect (exit $want), got exit $got :: $3"; fi
}

# --- no-verify: the flag in every spelling ---
check block X01-plain-long        'git commit --no-verify -m "x"'
check block X02-plain-short       'git commit -n -m "x"'
check block X03-bundled           'git commit -anm "wip"'
check block X04-quoted-flag       'git commit "-n" -m "x"'
check block X05-quote-split-flag  "git commit --no-'verify' -m x"
check block X06-line-continuation $'git commit \\\n  --no-verify -m x'
check block X07-prefix-veri       'git commit --no-veri -m x'
check block X08-ansic-hex-dash    "git commit \$'\\x2dn' -m x"
check block X09-flag-after-msg    'git commit -m "real msg" -n'
check block X10-sh-wrap           'sh -c "git commit -n -m x"'
check block X11-amend             'cd repo && git commit --amend -n'
check block X12-cmd-subst         'echo "$(git commit -n)"'
# --- other verbs ---
check block X13-push              'git push --force-with-lease --no-verify origin main'
check block X14-pull              'git pull --no-verify'
check block X15-merge             'git merge --no-verify feature/x'
check block X16-am                'git am --no-verify /tmp/p.mbox'
check block X17-split-git-am      'g"it" am --no-verify /tmp/p.mbox'
# --- hooks redirected ---
check block X18-hooksPath-c       'git -c core.hooksPath=/dev/null commit -m x'
check block X19-hooksPath-env     'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x'
check block X20-hooksPath-config  'git config core.hooksPath /dev/null && git commit -m x'
check block X21-hooksPath-scoped  'git config --local core.hooksPath=/tmp/x && git commit -m x'
check block X22-husky-env         'HUSKY=0 git commit -m "x"'
check block X23-husky-env-push    'HUSKY=0 git push origin main'
# --- hook files tampered with ---
check block X24-rm-husky          'rm .husky/pre-commit && git commit -m "x"'
check block X25-chmod-git-hooks   'chmod -x .git/hooks/pre-commit && git commit -m x'
check block X26-truncate-husky    ': > .husky/pre-commit && git commit -m x'
check block X27-sed-inplace       'sed -i "" -e "1s/.*/exit 0/" .husky/pre-commit && git commit -m x'
check block X28-cd-then-rm        'cd .husky && rm pre-commit && cd .. && git commit -m x'
check block X29-glued-amp-then-rm 'git commit -m wip&&rm -rf .husky&&git commit -m real'
# --- no false positives ---
check allow X30-plain             'git commit -m "safe change"'
check allow X31-flag-in-msg       'git commit -m "do not use --no-verify"'
check allow X32-no-edit           'git commit --amend --no-edit'
check allow X33-no-gpg-sign       'git commit --no-gpg-sign -m x'
check allow X34-log-n             'git log -n 5'
check allow X35-cherry-pick-n     'git cherry-pick -n abc123'
check allow X36-push-dry-run      'git push -n origin main'
check allow X37-push-dry-long     'git push --dry-run origin main'
check allow X38-hooksPath-alone   'git config core.hooksPath .husky'
check allow X39-file-arg          'git commit -F notes.txt'
check allow X40-bare-commit       'git commit'
check allow X41-non-git           'npm run commit'
check allow X42-multiline-msg     $'git commit -m "note:\n--no-verify is banned"'
# --- AI attribution ---
check block X43-trailer-multiline $'git commit -m "feat: x\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>"'
check block X44-generated-with    $'git commit -m "x\n\n🤖 Generated with [Claude Code]"'
check block X45-heredoc-F         $'git commit -F - <<\'EOF\'\nmsg\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF'
check block X46-addr-only         $'git commit -m "feat: x\n\nCo-Authored-By: Fable 5 <fable@anthropic.com>"'
check allow X47-human-coauthor    $'git commit -m "pair work\n\nCo-Authored-By: Jane Doe <jane@corp.example>"'
check allow X48-log-grep          'git log --grep "Co-Authored-By: Claude"'
check allow X49-claude-mention    'git commit -m "explain claude workflow"'
# --- degraded input: never block what cannot be read ---
assert_eq X50-no-command-field "$(pre_ec '{"tool_name":"shell","tool_input":{}}')" 0
assert_eq X51-empty-stdin      "$(pre_ec '')" 0

# ═══ M — PostToolUse through the Codex MCP adapter ══════════════════════════
PTU_CMD="$(wcmd PostToolUse)"
SHIMJS="$PLUG/hooks/codex-mcp-shim.cjs"
FIX="$ROOT/tests/fixtures"
JIRA="$FIX/jira-issue-ELC-104.json"
MSD="$TMP/mcp-spill"; mkdir -p "$MSD"

run_ptu() { # input-json [VAR=val…]
  local in="$1"; shift
  printf '%s' "$in" | env CLAUDE_PLUGIN_ROOT="$PLUG" FND_MCP_SLIM_DIR="$MSD" "$@" bash -c "$PTU_CMD" 2>/dev/null
}

# M1: the FND_MCP_SLIM gate short-circuits before node, exactly as on Claude Code.
: > "$TMP/node.log"
printf '{}' | env NODE_LOG="$TMP/node.log" PATH="$shim:$PATH" CLAUDE_PLUGIN_ROOT="$PLUG" FND_MCP_SLIM=0 \
  bash -c "$PTU_CMD" >/dev/null 2>&1; ec=$?
assert_eq M1-gate-exit "$ec" 0
if [ -s "$TMP/node.log" ]; then bad M1-gate "node ran with FND_MCP_SLIM=0"; else ok; fi
: > "$TMP/node.log"
printf '{}' | env NODE_LOG="$TMP/node.log" PATH="$shim:$PATH" CLAUDE_PLUGIN_ROOT="$PLUG" \
  bash -c "$PTU_CMD" >/dev/null 2>&1
if [ -s "$TMP/node.log" ]; then ok; else bad M1b-gate-default "node did not run by default"; fi

# M2: a whale the compressor cannot shrink → the stub comes back as additionalContext (the one
# channel this host honors), never as updatedToolOutput, and the spill on disk is byte-exact.
WHALE="$(printf 'x%.0s' $(seq 1 40000))"
printf '%s' "$WHALE" > "$TMP/whale.txt"
in="$(jq -n --arg t "$WHALE" '{tool_name:"mcp__plugin_fnd_chrome-devtools-mcp__evaluate_script",tool_response:{content:[{type:"text",text:$t}]}}')"
out="$(run_ptu "$in")"; ec=$?
assert_eq       M2-exit      "$ec" 0
assert_contains M2-event     "$out" '"hookEventName":"PostToolUse"'
assert_contains M2-context   "$out" "additionalContext"
assert_absent   M2-no-rewrite "$out" "updatedToolOutput"
ctx="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null)"
assert_contains M2-marker    "$ctx" "<<fnd-mcp-slim stub>>"
assert_contains M2-cli       "$ctx" "json-slim.cjs"
assert_contains M2-host-note "$ctx" "cannot replace a tool result"
p="$(printf '%s' "$ctx" | grep -o 'full=[^ >]*' | head -1 | sed 's/^full=//')"
if [ -n "$p" ] && [ -f "$p" ] && cmp -s "$p" "$TMP/whale.txt"; then ok; else bad M2-spill "spill missing or not byte-exact (p='$p')"; fi
cb=$(printf '%s' "$ctx" | wc -c | tr -d ' ')
if [ "$cb" -lt 10000 ]; then ok; else bad M2-budget "additionalContext is $cb B — over Codex's ~2500-token limit"; fi
# The pointer must not carry the whale itself back into context — the stub's shape hint quotes
# the first few dozen bytes of the payload and nothing more, so the payload character survives
# in a count far below the 40 000 the result held.
xcount=$(printf '%s' "$ctx" | tr -cd 'x' | wc -c | tr -d ' ')
if [ "$xcount" -lt 500 ]; then ok; else bad M2-no-payload "the adapter re-injected the payload ($xcount payload bytes)"; fi

# M3: a raw-string result stubs the same way (the shape mcp-slim mirrors is irrelevant here —
# the adapter reads text wherever it sits).
in="$(jq -n --arg t "$WHALE" '{tool_name:"mcp__x__y",tool_response:$t}')"
ctx="$(run_ptu "$in" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null)"
assert_contains M3-string-stub "$ctx" "<<fnd-mcp-slim stub>>"

# M4: a merely COMPRESSIBLE result → nothing. Codex already delivered the full result; the
# compressed copy would add tokens, not save them.
in="$(jq -n --rawfile t "$JIRA" '{tool_name:"mcp__plugin_fnd_atlassian__getJiraIssue",tool_response:{content:[{type:"text",text:$t}]}}')"
out="$(run_ptu "$in" FND_MCP_SLIM_STUB=0)"; ec=$?
assert_eq M4-compressed-silent "$out" ""
assert_eq M4-exit "$ec" 0

# M5: the rails mcp-slim owns stay silent through the adapter too.
in="$(jq -n --rawfile t "$JIRA" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}],isError:true}}')"
assert_eq M5-error-shape "$(run_ptu "$in")" ""
in="$(jq -n '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:"tiny"}]}}')"
assert_eq M5b-small "$(run_ptu "$in")" ""
assert_eq M5c-malformed "$(run_ptu 'not json at all')" ""

# M6: a per-block stub set (blocks carrying more than type/text cannot be collapsed) arrives as
# one context block holding every stub.
in="$(jq -n --arg t "$WHALE" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t,annotations:{audience:["user"]}},{type:"text",text:$t,annotations:{audience:["user"]}}]}}')"
ctx="$(run_ptu "$in" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null)"
n=$(printf '%s' "$ctx" | grep -c '<<fnd-mcp-slim stub>>' || true)
if [ "$n" -ge 2 ]; then ok; else bad M6-per-block "want a stub per over-limit block, got $n"; fi

# M7: __dirname resolution — a WRONG plugin-root env (Cursor's leak bug, Claude's cache/source
# split) must not change which mcp-slim runs.
in="$(jq -n --arg t "$WHALE" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}]}}')"
ctx="$(printf '%s' "$in" | env CLAUDE_PLUGIN_ROOT="$TMP/nonexistent" PLUGIN_ROOT="$TMP/nonexistent" \
  FND_MCP_SLIM_DIR="$MSD" node "$SHIMJS" 2>/dev/null | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null)"
assert_contains M7-dirname "$ctx" "<<fnd-mcp-slim stub>>"

# M8: a broken mcp-slim → nothing on stdout, exit 0. The adapter is fail-open like every hook
# here except the commit guard, so a compressor failure can never cost the model its result.
brk="$TMP/broken"; mkdir -p "$brk"
cp "$SHIMJS" "$brk/codex-mcp-shim.cjs"
printf 'process.stdout.write("not json");process.exit(1);\n' > "$brk/mcp-slim.cjs"
out="$(printf '%s' "$in" | node "$brk/codex-mcp-shim.cjs" 2>/dev/null)"; ec=$?
assert_eq M8-broken-silent "$out" ""
assert_eq M8-broken-exit   "$ec" 0
printf 'process.exit(3);\n' > "$brk/mcp-slim.cjs"
out="$(printf '%s' "$in" | node "$brk/codex-mcp-shim.cjs" 2>/dev/null)"; ec=$?
assert_eq M8b-crash-silent "$out" ""
assert_eq M8b-crash-exit   "$ec" 0

echo "hooks-codex wiring sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  printf '%s' "$failures"
  exit 1
fi
