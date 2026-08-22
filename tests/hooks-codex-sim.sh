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
#             here fails the suite). Matchers are Codex regexes: the PreToolUse one covers all
#             three spellings of the shell tool (Bash / shell / local_shell) and nothing else.
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
#             (tool_name "shell", ARRAY command) still blocks.
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
#   - hooks-codex.json is a bare event map (SessionStart / UserPromptSubmit / SubagentStart /
#     PreToolUse / PostToolUse → array of {matcher?, hooks:[{type,command}]}), the JSON spelling
#     of config.toml's [[hooks.Event]]; the `hooks` prefix is implied by the file name.
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
  jq -r --arg e "$1" --argjson i "${2:-0}" '.[$e][0].hooks[$i].command' "$WIRING"
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

for ev in SessionStart UserPromptSubmit SubagentStart PreToolUse PostToolUse; do
  n="$(jq -r --arg e "$ev" '.[$e] | length' "$WIRING" 2>/dev/null)"
  if [ "$n" = "1" ]; then ok; else bad "W1-$ev" "want exactly one entry, got '$n'"; fi
done

# W2: same events as the canonical block — no fnd hook may exist on Claude Code and not on Codex.
cev="$(jq -r '.hooks | keys[]' "$MANIFEST" | sort)"
xev="$(jq -r 'keys[]' "$WIRING" | sort)"
assert_eq W2-event-parity "$xev" "$cev"

# W3: every shared command is the Claude command, verbatim, modulo the root expansion.
for pair in "SessionStart:0" "UserPromptSubmit:0" "SubagentStart:0" "PreToolUse:0" "PreToolUse:1"; do
  ev="${pair%%:*}"; idx="${pair#*:}"
  assert_eq "W3-$ev-$idx" "$(wcmd "$ev" "$idx")" "$(want_cmd "$(ccmd "$ev" "$idx")")"
done

# W4: the ONE deliberate divergence — PostToolUse routes through the Codex adapter instead of
# mcp-slim directly, because this host cannot replace a tool result. Everything else about the
# command (the FND_MCP_SLIM gate, the `|| true` fail-open) is unchanged.
assert_eq W4-posttooluse "$(wcmd PostToolUse 0)" \
  "$(printf '%s' "$(want_cmd "$(ccmd PostToolUse 0)")" | sed -e 's#hooks/mcp-slim.cjs#hooks/codex-mcp-shim.cjs#')"

# W5: every script the wiring names exists in the canonical hooks dir (single-copy: no forked
# per-host copy of a guard or of the compressor).
scripts="$(jq -r 'to_entries[] | .value[] | .hooks[] | .command' "$WIRING" | grep -oE 'hooks/[a-z0-9-]+\.(cjs|sh)' | sort -u)"
for s in $scripts; do
  if [ -f "$PLUG/$s" ]; then ok; else bad "W5-$s" "wiring names a file that does not exist"; fi
done
assert_eq W5-count "$(printf '%s\n' "$scripts" | grep -c .)" 5

# W6: PreToolUse matcher — Codex regex, covering every spelling of the shell tool and nothing else.
pm="$(jq -r '.PreToolUse[0].matcher' "$WIRING")"
for t in Bash shell local_shell; do
  if printf '%s\n' "$t" | grep -Eq "$pm"; then ok; else bad "W6-$t" "PreToolUse matcher '$pm' misses the shell tool"; fi
done
for t in Read Write mcp__plugin_fnd_atlassian__getJiraIssue; do
  if printf '%s\n' "$t" | grep -Eq "$pm"; then bad "W6-not-$t" "PreToolUse matcher '$pm' over-matches"; else ok; fi
done

# W7: PostToolUse matcher — MCP tools only.
qm="$(jq -r '.PostToolUse[0].matcher' "$WIRING")"
if printf '%s\n' "mcp__plugin_fnd_atlassian__getJiraIssue" | grep -Eq "$qm"; then ok; else bad W7-mcp "PostToolUse matcher '$qm' misses an MCP tool"; fi
if printf '%s\n' "Bash" | grep -Eq "$qm"; then bad W7-bash "PostToolUse matcher '$qm' matches Bash"; else ok; fi

# W8: both guards stay wired, in the canonical order (attribution first, no-verify second).
assert_eq W8-guard-count "$(jq -r '.PreToolUse[0].hooks | length' "$WIRING")" 2
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

# ═══ S — SessionStart through the Codex wiring ══════════════════════════════
SS_CMD="$(wcmd SessionStart)"
fake="$TMP/plugroot"; mkdir -p "$fake/hooks"
for f in comment-discipline plugin-feedback store-access task-workspace lean-code mcp-whale; do
  echo "MARK-$f" > "$fake/hooks/$f.md"
done
SS_STORE="$TMP/ss-store"; mkdir -p "$SS_STORE"; : > "$SS_STORE/shopify.theme.toml"
SS_ENV="$TMP/ss-env";     mkdir -p "$SS_ENV";   : > "$SS_ENV/.env"
SS_PLAIN="$TMP/ss-plain"; mkdir -p "$SS_PLAIN"

out="$(cd "$SS_STORE" && CLAUDE_PLUGIN_ROOT="$fake" bash -c "$SS_CMD" 2>/dev/null)"; ec=$?
assert_eq S1-all-present-exit "$ec" 0
for f in comment-discipline plugin-feedback store-access task-workspace lean-code mcp-whale; do
  assert_contains "S1-$f" "$out" "MARK-$f"
done

rm "$fake/hooks/plugin-feedback.md"
out="$(cd "$SS_STORE" && CLAUDE_PLUGIN_ROOT="$fake" bash -c "$SS_CMD" 2>/dev/null)"; ec=$?
assert_eq S2-missing-file-exit "$ec" 0
for f in comment-discipline store-access task-workspace lean-code mcp-whale; do
  assert_contains "S2-$f" "$out" "MARK-$f"
done
echo "MARK-plugin-feedback" > "$fake/hooks/plugin-feedback.md"

out="$(cd "$SS_STORE" && CLAUDE_PLUGIN_ROOT="$fake" FND_LEAN=0 bash -c "$SS_CMD" 2>/dev/null)"; ec=$?
assert_eq S3-lean-off-exit "$ec" 0
assert_absent S3-no-lean "$out" "MARK-lean-code"

out="$(cd "$SS_PLAIN" && CLAUDE_PLUGIN_ROOT="$fake" bash -c "$SS_CMD" 2>/dev/null)"; ec=$?
assert_eq S4-no-store-exit "$ec" 0
assert_absent S4-no-store-access "$out" "MARK-store-access"
for f in comment-discipline task-workspace lean-code mcp-whale; do
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

out="$(run_sub jira-reader)"; ec=$?
assert_eq T2-reader-exit  "$ec" 0
assert_eq T2-reader-quiet "$out" ""

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
# guards read .tool_input.command and scan whatever text comes back, so an argv array is covered.
assert_eq B4-codex-shape-block "$(pre_ec "$(ev_codex 'git commit --no-verify -m x')")" 2
assert_eq B4b-codex-shape-allow "$(pre_ec "$(ev_codex 'git commit -m ok')")" 0

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
