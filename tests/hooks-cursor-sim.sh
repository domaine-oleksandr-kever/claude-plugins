#!/usr/bin/env bash
# Simulation harness for the Cursor hook adapter (M5) — hooks/hooks-cursor.json wiring +
# hooks/cursor-shim.cjs, the dialect translator in front of the SINGLE-COPY hook scripts:
#   W cases — hooks/hooks-cursor.json: the five wired events, every command routed through
#             the shim with its own event name, the FND_* gates mirroring plugin.json's, and
#             the one command that must NOT swallow a non-zero exit (beforeShellExecution,
#             where exit 2 is the deny signal); the Cursor manifest's hooks pointer resolves
#   G cases — the wiring gates against a fake `node`: only BOTH prompt switches at 0 keep the
#             process from spawning, FND_MCP_SLIM=0 skips the compressor, and a failing node
#             never fails the hook (except on the guard event, where the exit code is a verdict)
#   S cases — sessionStart: the DYNAMIC context only (plugin-root line + store-access.md,
#             gated on the same store-file detection as the Claude Code wiring) — the statics
#             that became rules/*.mdc in M4 must NOT be injected a second time here; paths
#             resolve from the shim's own location, not from a leaked *_PLUGIN_ROOT
#   U cases — beforeSubmitPrompt → user-prompt.cjs: a large-JSON block becomes
#             `continue:false` + a developer-facing userMessage naming the spilled file (never
#             model context), an ordinary prompt emits nothing, each switch honored in-shim
#   T cases — subagentStart → subagent-conventions.sh: code-writing agents get the
#             conventions as additional_context, read-only readers are skipped, every
#             plausible Cursor spelling of the agent-type field is accepted, FND_LEAN honored
#   M cases — afterMCPExecution → mcp-slim.cjs: a whale comes back as an in-place
#             `updated_mcp_tool_output` rewrite carrying its own full= spill, passthroughs
#             (small / error / no-gain) leave the result alone — a passthrough must never
#             collapse into a null rewrite — and every plausible result key is read
#   P cases — beforeMCPExecution → scratch-path-guard.cjs: a screenshot aimed into the checkout
#             comes back as `permission:"deny"` carrying both message-key spellings, while the
#             workspace path, an out-of-tree path, another MCP tool, the switch and a malformed
#             payload are silent — plus this host's two payload divergences (tool_input as a
#             JSON string, an unprefixed tool name) and the screenshot-tool set's fourth copy
#   X cases — beforeShellExecution → the two commit guards: exit 2 becomes
#             `permission:"deny"` + both message fields + exit 2; a clean command emits
#             nothing; a guard that reaches NO verdict fails open — except the no-verify guard
#             on a git command, which fails closed (a missing guard is a broken install) —
#             plus X13, hooks/spill-access.sh riding the same event: it runs only AFTER the
#             guards allow the command, records the spill read, changes no output, and this
#             host has no read-file event, so shell reads are its whole coverage here
#   H cases — FND_HOST_TRACE: the three events the SHIM composes record themselves (host
#             `cursor`, hook `cursor-shim`, inject / pass), the guard events do not — their
#             spawned script owns that line — and every spawned script inherits FND_HOST
#   N cases — the ENTIRE tests/no-verify-bypass-matrix.sh case list, re-run through the Cursor
#             dialect: the case lists are read out of that file (never copied), so a row added
#             there is covered here on the next run
# Exit 0 = all green.
set -u

# Hermetic: an exported plugin-root env var would decide which bundle the scripts read, and
# these cases exist to prove __dirname does. Debug switches are unset for the same reason
# hooks-sim.sh unsets them — a developer watching the live log must not collect fixture noise.
unset CLAUDE_PLUGIN_ROOT CURSOR_PLUGIN_ROOT FND_MCP_SLIM_DEBUG FND_MCP_SLIM_DIR FND_SPILL_ACCESS
# The host-proof log for the same two reasons: a developer running with the switch on must not
# collect fixture lines, and an exported FND_HOST would rewrite the column the H cases pin.
export FND_HOST_TRACE=0; unset FND_HOST # `0`, not unset: unset falls through to the developer's real global env file

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="$ROOT/plugins/fnd"
SHIM="$PLUGIN/hooks/cursor-shim.cjs"
WIRING="$PLUGIN/hooks/hooks-cursor.json"
CURSOR_MANIFEST="$PLUGIN/.cursor-plugin/plugin.json"
MATRIX="$ROOT/tests/no-verify-bypass-matrix.sh"
JIRA="$ROOT/tests/fixtures/jira-issue-ELC-104.json"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0; failures=""
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); failures="${failures}  [$1] $2
"; }
assert_contains() { case "$2" in *"$3"*) ok ;; *) bad "$1" "missing: $3" ;; esac; }
assert_absent()   { case "$2" in *"$3"*) bad "$1" "unexpected: $3" ;; *) ok ;; esac; }
assert_eq()       { if [ "$2" = "$3" ]; then ok; else bad "$1" "got '$2', want '$3'"; fi; }

# One shim invocation: stdout echoed, exit code returned AND left in $EC (a capture site reads
# it with `; EC=$?` — the command substitution is its own subshell, so a variable set inside it
# never comes back, and that exit code is exactly what the deny cases assert). The payload is
# an ARGUMENT rather than this function's stdin for the same subshell reason.
EC=0
NODE_BIN="$(command -v node)"
run_shim() { # event payload [VAR=val…]
  local event="$1" payload="$2"; shift 2
  local out; EC=0
  out="$(printf '%s' "$payload" | env "$@" "$NODE_BIN" "$SHIM" "$event" 2>/dev/null)" || EC=$?
  printf '%s' "$out"
  return "$EC"
}

# ═══ W — hooks-cursor.json wiring ═══════════════════════════════════════════
if jq -e . "$WIRING" >/dev/null 2>&1; then ok; else bad W0-parse "hooks-cursor.json is not valid JSON"; fi
assert_eq W1-version "$(jq -r '.version' "$WIRING")" 1

EVENTS="sessionStart beforeSubmitPrompt subagentStart beforeShellExecution beforeMCPExecution afterMCPExecution"
for e in $EVENTS; do
  cmd="$(jq -r --arg e "$e" '.hooks[$e][0].command // empty' "$WIRING")"
  if [ -n "$cmd" ]; then ok; else bad "W2-$e" "no command wired"; fi
  assert_contains "W3-$e-shim"  "$cmd" 'hooks/cursor-shim.cjs'
  # the event name is an argument, so one shim serves five events without five entry points
  assert_contains "W4-$e-argv"  "$cmd" "cursor-shim.cjs\" $e"
  # a hard-coded developer path would install but never run on another machine
  case "$cmd" in */Users/*|*/home/*) bad "W5-$e-abs" "absolute path in the wiring: $cmd" ;; *) ok ;; esac
  # The bundle is PROBED for, not read out of the env: the leak the shim defends against would
  # otherwise point the command itself at another plugin's root (or nowhere), and the shim never
  # starts to warn about it. Candidates in order, each validated by the shim file being there.
  assert_contains "W6-$e-probe"  "$cmd" '[ -f "$c/hooks/cursor-shim.cjs" ]'
  assert_contains "W6b-$e-cursor" "$cmd" '"${CURSOR_PLUGIN_ROOT:-}"'
  assert_contains "W6c-$e-claude" "$cmd" '"${CLAUDE_PLUGIN_ROOT:-}"'
  assert_contains "W6d-$e-install" "$cmd" '"$HOME/.cursor/plugins/local/fnd"'
  # the workspace cwd must never be a candidate — a checkout could hand the hook its own script
  assert_absent   "W6e-$e-nocwd" "$cmd" '"$PWD"'
  # …and the RUNTIME is probed on the same footing as the file: `node` missing means exit 127
  # with empty stdout, which Cursor reads as "not a deny" exactly like a missing shim does
  assert_contains "W6f-$e-node-probe" "$cmd" 'command -v node'
done

# The guard event is the one place a non-zero exit is a VERDICT, not a failure — `|| true`
# there would silently reopen every bypass. Everywhere else it is the fail-open rail.
gcmd="$(jq -r '.hooks.beforeShellExecution[0].command' "$WIRING")"
assert_absent W7-guard-no-true "$gcmd" '|| true'
for e in sessionStart beforeSubmitPrompt subagentStart beforeMCPExecution afterMCPExecution; do
  assert_contains "W8-$e-failopen" "$(jq -r --arg e "$e" '.hooks[$e][0].command' "$WIRING")" '|| true'
done

# The switches keep their plugin.json meaning: one prompt process serves both halves, so only
# BOTH at 0 short-circuits it; the compressor rides its own switch.
assert_contains W9-prompt-gate "$(jq -r '.hooks.beforeSubmitPrompt[0].command' "$WIRING")" '"${FND_CTX_MONITOR:-1}" = "0"'
assert_contains W9b-prompt-gate "$(jq -r '.hooks.beforeSubmitPrompt[0].command' "$WIRING")" '"${FND_PROMPT_JSON:-1}" = "0"'
assert_contains W10-slim-gate  "$(jq -r '.hooks.afterMCPExecution[0].command' "$WIRING")" '"${FND_MCP_SLIM:-1}" = "0"'
assert_contains W10b-scratch-gate "$(jq -r '.hooks.beforeMCPExecution[0].command' "$WIRING")" '"${FND_SCRATCH_GUARD:-1}" = "0"'

# The Cursor manifest points at this file — M5 is what makes that pointer resolvable.
ptr="$(jq -r '.hooks // empty' "$CURSOR_MANIFEST")"
if [ -n "$ptr" ] && [ -f "$PLUGIN/$ptr" ]; then ok; else bad W11-manifest-pointer "manifest hooks '$ptr' does not resolve"; fi

# W11b: rules are declared EXPLICITLY — folder auto-discovery proved unreliable on a live
# marketplace install (empty Rules tab, 2026-08-23) — and the pointer resolves to .mdc files.
rptr="$(jq -r '.rules // empty' "$CURSOR_MANIFEST")"
if [ -n "$rptr" ] && [ -d "$PLUGIN/$rptr" ] && ls "$PLUGIN/$rptr"/*.mdc >/dev/null 2>&1; then ok
else bad W11b-manifest-rules "manifest rules '$rptr' does not resolve to a dir with .mdc files"; fi

# W12–W16: the wiring under Cursor's plugin-root LEAK, run for real (real node, real guards).
# A wiring that reads the root out of the env resolves to another plugin's directory here, and
# the guard event — the one that must fail CLOSED — would exit 1 (MODULE_NOT_FOUND), which
# Cursor reads as "not a deny".
DECOY="$TMP/decoy-plugin"; mkdir -p "$DECOY/hooks"          # another plugin: no fnd shim in it
FAKEHOME="$TMP/home"; mkdir -p "$FAKEHOME/.cursor/plugins/local"
ln -s "$PLUGIN" "$FAKEHOME/.cursor/plugins/local/fnd"       # exactly what install.sh --target cursor makes
NOHOME="$TMP/nohome"; mkdir -p "$NOHOME"                     # …and a machine where the install is gone

wired_real() { # event home payload — the wired command, real runtime, leaked roots
  local event="$1" home="$2" payload="$3" cmd out EC=0
  cmd="$(jq -r --arg e "$event" '.hooks[$e][0].command' "$WIRING")"
  out="$(printf '%s' "$payload" | env HOME="$home" CURSOR_PLUGIN_ROOT="$DECOY" CLAUDE_PLUGIN_ROOT="$DECOY" \
    PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin" bash -c "$cmd" 2>"$TMP/wired.err")" || EC=$?
  printf '%s' "$out"
  return "$EC"
}

out="$(wired_real beforeShellExecution "$FAKEHOME" '{"command":"git commit --no-verify -m x"}')"; EC=$?
assert_eq       W12-leak-deny-exit "$EC" 2
assert_eq       W12-leak-deny      "$(printf '%s' "$out" | jq -r '.permission')" "deny"
out="$(wired_real beforeShellExecution "$FAKEHOME" '{"command":"git commit -m clean"}')"; EC=$?
assert_eq       W13-leak-allow     "$out" ""
assert_eq       W13-leak-allow-exit "$EC" 0
# a fail-open event still finds its own bundle through the same probe
out="$(wired_real subagentStart "$FAKEHOME" '{"agent_type":"general-purpose"}')"; EC=$?
assert_eq       W14-leak-subagent-exit "$EC" 0
assert_contains W14-leak-subagent "$(printf '%s' "$out" | jq -r '.additional_context')" "comment"

# No bundle anywhere: the guard command denies a git command rather than waving it through,
# and says why on both channels — the shim cannot warn here, it never starts.
out="$(wired_real beforeShellExecution "$NOHOME" '{"command":"git commit --no-verify -m x"}')"; EC=$?
assert_eq       W15-nobundle-exit "$EC" 2
assert_eq       W15-nobundle-deny "$(printf '%s' "$out" | jq -r '.permission')" "deny"
assert_contains W15-nobundle-msg  "$(printf '%s' "$out" | jq -r '.agentMessage')" "could not be located"
# the pure-shell body carries both key spellings too — it is the same deny, minus the runtime
assert_contains W15-nobundle-snake "$(printf '%s' "$out" | jq -r '.agent_message')" "could not be located"
assert_contains W15-nobundle-snake-user "$(printf '%s' "$out" | jq -r '.user_message')" "could not be located"
assert_contains W15-nobundle-err  "$(cat "$TMP/wired.err")" "could not be located"
# …and an ordinary command is not collateral damage
out="$(wired_real beforeShellExecution "$NOHOME" '{"command":"ls -la"}')"; EC=$?
assert_eq W16-nobundle-nongit      "$out" ""
assert_eq W16-nobundle-nongit-exit "$EC" 0

# W17–W18: the bundle is all there, but `node` is not on PATH. Running the shim anyway exits 127
# with empty stdout, and an empty stdout is not a deny — the guard event would wave the bypass
# through on a machine whose PATH lost its runtime (a GUI-launched Cursor with an nvm-only node
# is the everyday spelling of this). Same fallback as a missing shim: the JSON deny is printed
# by pure shell, because without node there is nothing that could emit it.
NONODE="$TMP/nonode"; mkdir -p "$NONODE"
for t in cat bash; do ln -sf "$(command -v "$t")" "$NONODE/$t"; done
wired_nonode() { # event payload — the wired command with no node anywhere on PATH
  local event="$1" payload="$2" cmd out EC=0
  cmd="$(jq -r --arg e "$event" '.hooks[$e][0].command' "$WIRING")"
  out="$(printf '%s' "$payload" | env -u CURSOR_PLUGIN_ROOT -u CLAUDE_PLUGIN_ROOT \
    HOME="$FAKEHOME" PATH="$NONODE" bash -c "$cmd" 2>"$TMP/nonode.err")" || EC=$?
  printf '%s' "$out"
  return "$EC"
}
if ! PATH="$NONODE" command -v node >/dev/null 2>&1; then ok
else bad W17-nonode-fixture "node is still reachable with PATH=$NONODE"; fi
out="$(wired_nonode beforeShellExecution '{"command":"git commit --no-verify -m x"}')"; EC=$?
assert_eq       W17-nonode-exit "$EC" 2
assert_eq       W17-nonode-deny "$(printf '%s' "$out" | jq -r '.permission')" "deny"
assert_contains W17-nonode-msg  "$(printf '%s' "$out" | jq -r '.agentMessage')" "node is not on PATH"
assert_contains W17-nonode-err  "$(cat "$TMP/nonode.err")" "blocked rather than run unchecked"
# …and a non-git command still runs: a missing runtime may not brick the shell.
out="$(wired_nonode beforeShellExecution '{"command":"ls -la"}')"; EC=$?
assert_eq W18-nonode-nongit      "$out" ""
assert_eq W18-nonode-nongit-exit "$EC" 0
# The fail-open events stay fail-open without node — silence and exit 0, never a hook error.
for e in sessionStart beforeSubmitPrompt subagentStart beforeMCPExecution afterMCPExecution; do
  out="$(wired_nonode "$e" '{"agent_type":"general-purpose","prompt":"hi","tool_response":{"content":[]}}')"; EC=$?
  assert_eq "W18b-$e-nonode-exit"  "$EC" 0
  assert_eq "W18b-$e-nonode-quiet" "$out" ""
done

# ═══ G — wiring gates against a fake node ═══════════════════════════════════
NODESHIM="$TMP/nodeshim"; mkdir -p "$NODESHIM"
cat > "$NODESHIM/node" <<'SH'
#!/usr/bin/env bash
echo run >> "$NODE_LOG"
exit "${NODE_EC:-0}"
SH
chmod +x "$NODESHIM/node"

run_wired() { # event [VAR=val…] — run the wired command with a fake node, log the spawn
  local event="$1"; shift
  local cmd; cmd="$(jq -r --arg e "$event" '.hooks[$e][0].command' "$WIRING")"
  : > "$TMP/node.log"
  env "$@" NODE_LOG="$TMP/node.log" PATH="$NODESHIM:$PATH" \
    CURSOR_PLUGIN_ROOT="$PLUGIN" bash -c "$cmd" >/dev/null 2>&1
}

run_wired beforeSubmitPrompt FND_CTX_MONITOR=0; ec=$?
assert_eq G1-ctx-off-exit "$ec" 0
if [ -s "$TMP/node.log" ]; then ok; else bad G1-ctx-off "node did not run with only the monitor off"; fi
run_wired beforeSubmitPrompt FND_PROMPT_JSON=0
if [ -s "$TMP/node.log" ]; then ok; else bad G1b-json-off "node did not run with only the guard off"; fi
run_wired beforeSubmitPrompt FND_CTX_MONITOR=0 FND_PROMPT_JSON=0; ec=$?
assert_eq G1c-both-off-exit "$ec" 0
if [ -s "$TMP/node.log" ]; then bad G1c-both-off "node ran with both switches off"; else ok; fi
run_wired beforeSubmitPrompt
if [ -s "$TMP/node.log" ]; then ok; else bad G2-default "node did not run by default"; fi

run_wired afterMCPExecution FND_MCP_SLIM=0; ec=$?
assert_eq G3-slim-off-exit "$ec" 0
if [ -s "$TMP/node.log" ]; then bad G3-slim-off "node ran with FND_MCP_SLIM=0"; else ok; fi
run_wired afterMCPExecution
if [ -s "$TMP/node.log" ]; then ok; else bad G4-slim-default "node did not run by default"; fi

run_wired beforeMCPExecution FND_SCRATCH_GUARD=0; ec=$?
assert_eq G3b-scratch-off-exit "$ec" 0
if [ -s "$TMP/node.log" ]; then bad G3b-scratch-off "node ran with FND_SCRATCH_GUARD=0"; else ok; fi
run_wired beforeMCPExecution
if [ -s "$TMP/node.log" ]; then ok; else bad G4b-scratch-default "node did not run by default"; fi

# A node that fails is a broken bundle, not a verdict — every event but the guard swallows it.
for e in sessionStart beforeSubmitPrompt subagentStart beforeMCPExecution afterMCPExecution; do
  run_wired "$e" NODE_EC=1; ec=$?
  assert_eq "G5-$e-failopen-exit" "$ec" 0
done
run_wired beforeShellExecution NODE_EC=2; ec=$?
assert_eq G6-guard-exit-survives "$ec" 2

# ═══ S — sessionStart (dynamic context only) ════════════════════════════════
# A fake bundle: the shim next to sentinel copies of the convention files. Copying the shim
# rather than pointing an env var at the fake root is the whole point — __dirname is what
# decides which bundle is read.
FAKE="$TMP/fakeroot"; mkdir -p "$FAKE/hooks"
cp "$SHIM" "$FAKE/hooks/"
cp "$PLUGIN/hooks/subagent-conventions.sh" "$FAKE/hooks/"
for f in comment-discipline plugin-feedback store-access task-workspace lean-code mcp-whale untrusted-content; do
  echo "MARK-$f" > "$FAKE/hooks/$f.md"
done
fshim() { # event payload [VAR=val…] — same contract as run_shim(), against the fake bundle
  local event="$1" payload="$2"; shift 2
  local out; EC=0
  out="$(printf '%s' "$payload" | env "$@" "$NODE_BIN" "$FAKE/hooks/cursor-shim.cjs" "$event" 2>/dev/null)" || EC=$?
  printf '%s' "$out"
  return "$EC"
}
# Node resolves the main module through realpath, so __dirname reports the real path of the
# temp dir (/private/var/… on macOS) — the root line is asserted against that same reading.
FAKE_REAL="$(cd "$FAKE" && pwd -P)"

SS_STORE="$TMP/ss-store"; mkdir -p "$SS_STORE"; : > "$SS_STORE/shopify.theme.toml"
SS_ENV="$TMP/ss-env";     mkdir -p "$SS_ENV";   : > "$SS_ENV/.env"
SS_PLAIN="$TMP/ss-plain"; mkdir -p "$SS_PLAIN"
ss_in() { printf '{"hook_event_name":"sessionStart","workspace_roots":["%s"]}' "$1"; }

out="$(fshim sessionStart "$(ss_in "$SS_STORE")")"; EC=$?
assert_eq       S1-exit          "$EC" 0
ctx="$(printf '%s' "$out" | jq -r '.additional_context' 2>/dev/null)"
assert_contains S1-store-access  "$ctx" "MARK-store-access"
assert_contains S1-root-line     "$ctx" "fnd plugin root: $FAKE_REAL"
# The statics became always-applied rules on Cursor (M4) — injecting them here too would put
# every one of them in context twice.
for f in comment-discipline plugin-feedback task-workspace mcp-whale lean-code untrusted-content; do
  assert_absent "S2-no-static-$f" "$ctx" "MARK-$f"
done

# A .env alone is enough (same detection as the Claude Code wiring)
assert_contains S3-env-store "$(fshim sessionStart "$(ss_in "$SS_ENV")" | jq -r '.additional_context')" "MARK-store-access"

# No store files → no store-access block, but the root line still ships (store-access.md and
# the bundled runners are addressed relative to it)
out="$(fshim sessionStart "$(ss_in "$SS_PLAIN")")"; EC=$?
assert_eq       S4-exit      "$EC" 0
ctx="$(printf '%s' "$out" | jq -r '.additional_context')"
assert_absent   S4-no-store  "$ctx" "MARK-store-access"
assert_contains S4-root-line "$ctx" "fnd plugin root:"

# A missing convention file drops that block, never the whole injection
rm "$FAKE/hooks/store-access.md"
out="$(fshim sessionStart "$(ss_in "$SS_STORE")")"; EC=$?
assert_eq       S5-missing-exit "$EC" 0
assert_contains S5-still-root   "$(printf '%s' "$out" | jq -r '.additional_context')" "fnd plugin root:"
cp "$PLUGIN/hooks/store-access.md" "$FAKE/hooks/store-access.md"

# S6: the REAL bundle emits the real store-access convention (the runners the model is told about)
out="$(run_shim sessionStart "$(ss_in "$SS_STORE")")"
assert_contains S6-real-runner "$(printf '%s' "$out" | jq -r '.additional_context')" "shopify-admin-gql.sh"

# S7: no workspace_roots → the process cwd is the detection dir (a CLI session, an older payload)
out="$(cd "$SS_STORE" && printf '{}' | "$NODE_BIN" "$SHIM" sessionStart)"
assert_contains S7-cwd-fallback "$(printf '%s' "$out" | jq -r '.additional_context')" "shopify-admin-gql.sh"

# S8/S9: the Cursor env-leak bug — a *_PLUGIN_ROOT pointing at ANOTHER bundle must not decide
# which files are read; the shim reads its own and says so on stderr.
out="$(printf '%s' "$(ss_in "$SS_STORE")" | env CURSOR_PLUGIN_ROOT="$FAKE" "$NODE_BIN" "$SHIM" sessionStart 2>"$TMP/leak.err")"
assert_contains S8-own-bundle "$(printf '%s' "$out" | jq -r '.additional_context')" "fnd plugin root: $PLUGIN"
assert_absent   S8-not-leaked "$(printf '%s' "$out" | jq -r '.additional_context')" "MARK-store-access"
assert_contains S9-leak-warned "$(cat "$TMP/leak.err")" "does not match this bundle"

# ═══ U — beforeSubmitPrompt (context monitor + large-JSON guard) ════════════
UPD="$TMP/upd"; mkdir -p "$UPD"
node -e '
const blob = JSON.stringify({rows: Array.from({length:900},(_,i)=>({id:i,pad:"y".repeat(40)}))});
process.stdout.write(JSON.stringify({hook_event_name:"beforeSubmitPrompt",
  prompt: "look at this\n" + blob + "\n" + "x".repeat(200),
  conversation_id: "c1", workspace_roots: [process.argv[1]]}));
' "$UPD" > "$TMP/bigprompt.json"
BIGPROMPT="$(cat "$TMP/bigprompt.json")"

out="$(run_shim beforeSubmitPrompt "$BIGPROMPT" TMPDIR="$UPD")"; EC=$?
assert_eq       U1-exit     "$EC" 0
assert_eq       U1-blocked  "$(printf '%s' "$out" | jq -r '.continue')" "false"
msg="$(printf '%s' "$out" | jq -r '.userMessage')"
assert_contains U1-message  "$msg" "was NOT sent to the model"
# The spilled file has to exist — the guard erases the prompt, so the path IS the recovery
p="$(printf '%s' "$msg" | grep -o '/[^ ]*fnd-prompt-json-[^ ]*\.json' | head -1)"
if [ -n "$p" ] && [ -f "$p" ]; then ok; else bad U2-spill "no existing spill file (p='$p')"; fi
# `reason` is developer-facing: it must never ride additional_context into the model's context
assert_eq U3-no-model-context "$(printf '%s' "$out" | jq -r '.additional_context // ""')" ""

# An ordinary prompt is untouched (no transcript on this host → no context notice either)
out="$(run_shim beforeSubmitPrompt '{"prompt":"hello"}')"; EC=$?
assert_eq U4-plain-empty "$out" ""
assert_eq U4-plain-exit  "$EC" 0

# In-shim switches (the wiring short-circuits first; this is the direct-invocation rail)
assert_eq U5-guard-off "$(run_shim beforeSubmitPrompt "$BIGPROMPT" FND_PROMPT_JSON=0 TMPDIR="$UPD")" ""
assert_eq U6-both-off  "$(run_shim beforeSubmitPrompt "$BIGPROMPT" FND_CTX_MONITOR=0 FND_PROMPT_JSON=0 TMPDIR="$UPD")" ""

# Malformed / promptless payloads never break a prompt
out="$(run_shim beforeSubmitPrompt 'not json')"; EC=$?
assert_eq U7-malformed-out "$out" ""
assert_eq U7-malformed-exit "$EC" 0
assert_eq U8-no-prompt      "$(run_shim beforeSubmitPrompt '{"conversation_id":"c"}')" ""

# ═══ T — subagentStart (code conventions) ═══════════════════════════════════
tsub() { fshim subagentStart "$@"; }

out="$(tsub '{"agent_type":"general-purpose"}')"; EC=$?
assert_eq       T1-exit    "$EC" 0
ctx="$(printf '%s' "$out" | jq -r '.additional_context')"
assert_contains T1-comment "$ctx" "MARK-comment-discipline"
assert_contains T1-lean    "$ctx" "MARK-lean-code"

# Read-only agents skip the CODE conventions, but every subagent still gets the
# untrusted-content rail — so the reader payload is that file and nothing else
rdr() { printf '%s' "$(tsub "$1")" | jq -r '.additional_context' 2>/dev/null; }
for a in jira-reader jira-writer bug-hunter change-reviewer figma-reader doc-reader theme-explorer; do
  c="$(rdr "{\"agent_type\":\"$a\"}")"
  assert_contains "T2-$a-untrusted"  "$c" "MARK-untrusted-content"
  assert_absent   "T2-$a-no-comment" "$c" "MARK-comment-discipline"
  assert_absent   "T2-$a-no-lean"    "$c" "MARK-lean-code"
done

# Cursor's spelling of the agent-type field is not pinned yet (M1a) — every plausible one is read
i=0
for shape in '{"subagent_type":"jira-reader"}' '{"agent":{"name":"jira-reader"}}' '{"agent":"jira-reader"}'; do
  i=$((i + 1))
  assert_absent "T3-shape-$i" "$(rdr "$shape")" "MARK-comment-discipline"
done
# …and an unrecognized shape errs toward injecting: a code-writing agent without the
# conventions is the costly miss
assert_contains T4-unknown-shape "$(tsub '{"who":"?"}')"        "MARK-comment-discipline"
assert_contains T4-unknown-agent "$(tsub '{"agent_type":"x"}')" "MARK-comment-discipline"

out="$(tsub '{"agent_type":"general-purpose"}' FND_LEAN=0)"
assert_contains T5-lean-off-comment "$out" "MARK-comment-discipline"
assert_absent   T5-lean-off-lean    "$out" "MARK-lean-code"

# T6: subagent-conventions.sh is the one canonical script that PREFERS the plugin-root env over
# its own dirname, so a leaked root would make it cat nothing and exit 0 — an empty injection
# nobody can see. The shim hands every child the root IT resolved, so the leak cannot reach it.
out="$(run_shim subagentStart '{"agent_type":"general-purpose"}' CLAUDE_PLUGIN_ROOT="$TMP/decoy-plugin")"
assert_contains T6-leak-comment "$(printf '%s' "$out" | jq -r '.additional_context')" "comment discipline"
assert_contains T6-leak-lean    "$(printf '%s' "$out" | jq -r '.additional_context')" "lean code"
out="$(run_shim subagentStart '{"agent_type":"general-purpose"}' CURSOR_PLUGIN_ROOT="$TMP/decoy-plugin")"
assert_contains T6b-leak-cursor-env "$(printf '%s' "$out" | jq -r '.additional_context')" "comment discipline"

# ═══ M — afterMCPExecution (in-place MCP-output rewrite) ════════════════════
MSD="$TMP/slim-spill"; mkdir -p "$MSD"
mrun() { # payload-json [VAR=val…]
  local in="$1"; shift
  run_shim afterMCPExecution "$in" FND_MCP_SLIM_DIR="$MSD" FND_MCP_SLIM_STUB=0 "$@"
}

# M1: a whale comes back REWRITTEN in place, smaller, with a resolvable full= handle
in="$(jq -n --rawfile t "$JIRA" '{tool_name:"mcp_atlassian_getJiraIssue",tool_response:{content:[{type:"text",text:$t}]}}')"
out="$(mrun "$in")"; EC=$?
assert_eq       M1-exit    "$EC" 0
assert_contains M1-key     "$out" "updated_mcp_tool_output"
assert_absent   M1-noclaude "$out" "hookSpecificOutput"
text="$(printf '%s' "$out" | jq -r '.updated_mcp_tool_output.content[0].text' 2>/dev/null)"
p="$(printf '%s' "$text" | grep -o 'full=[^ >]*' | head -1 | sed 's/^full=//')"
if [ -n "$p" ] && [ -f "$p" ]; then ok; else bad M1-fullfile "no existing full= file (p='$p')"; fi
inb=$(printf '%s' "$in" | wc -c); outb=$(printf '%s' "$out" | wc -c)
if [ "$outb" -lt "$inb" ]; then ok; else bad M1-smaller "rewrite $outb not < input $inb"; fi

# M2: every plausible Cursor key for the result is read (the pinned one is an M1a item)
for k in tool_response tool_output result output response; do
  in="$(jq -n --arg k "$k" --rawfile t "$JIRA" '{tool_name:"x"} + {($k):{content:[{type:"text",text:$t}]}}')"
  assert_contains "M2-$k" "$(mrun "$in")" "updated_mcp_tool_output"
done

# M3–M6: passthrough must stay passthrough — emitting `{"updated_mcp_tool_output":null}`
# would erase the very result the passthrough exists to preserve.
in='{"tool_name":"mcp_x_y","tool_response":{"content":[{"type":"text","text":"{\"a\":1,\"b\":2}"}]}}'
assert_eq M3-small-passthrough "$(mrun "$in")" ""
in="$(jq -n --rawfile t "$JIRA" '{tool_name:"x",tool_response:{content:[{type:"text",text:$t}],isError:true}}')"
assert_eq M4-error-passthrough "$(mrun "$in")" ""
bignon="$(printf 'x%.0s' $(seq 1 5000))"
in="$(jq -n --arg t "$bignon" '{tool_name:"x",tool_response:{content:[{type:"text",text:$t}]}}')"
assert_eq M5-nogain-passthrough "$(mrun "$in")" ""
assert_eq M6-malformed          "$(mrun 'not json at all')" ""
assert_eq M6b-no-result         "$(mrun '{"tool_name":"x"}')" ""

# M7: the in-shim switch (the wiring gate is G3)
in="$(jq -n --rawfile t "$JIRA" '{tool_name:"x",tool_response:{content:[{type:"text",text:$t}]}}')"
out="$(mrun "$in" FND_MCP_SLIM=0)"; EC=$?
assert_eq M7-slim-off "$out" ""
assert_eq M7-exit     "$EC" 0

# ═══ P — beforeMCPExecution (the screenshot scratch-path deny) ══════════════
# This host documents a before-MCP event with a deny primitive (cursor.com/docs/agent/hooks), so
# the screenshot guard reaches Cursor sessions too. Two payload divergences are pinned here:
# tool_input arrives as a JSON STRING, and the tool name carries no server prefix.
PPROJ="$TMP/pproj"; mkdir -p "$PPROJ/.claude/tasks/ELC-1/tmp"
pev() { # tool key path [--obj] — a Cursor beforeMCPExecution payload
  local t="$1" k="$2" p="$3" shape="${4:-string}"
  if [ "$shape" = "obj" ]; then
    jq -cn --arg t "$t" --arg k "$k" --arg p "$p" --arg w "$PPROJ" \
      '{hook_event_name:"beforeMCPExecution", tool_name:$t, mcp_server_name:"playwright", tool_input:{($k):$p}, workspace_roots:[$w]}'
  else
    jq -cn --arg t "$t" --arg k "$k" --arg p "$p" --arg w "$PPROJ" \
      '{hook_event_name:"beforeMCPExecution", tool_name:$t, mcp_server_name:"playwright", tool_input:({($k):$p}|tojson), workspace_roots:[$w]}'
  fi
}
out="$(run_shim beforeMCPExecution "$(pev browser_take_screenshot filename elc-123-cart.jpeg)")"; EC=$?
assert_eq       P1-exit       "$EC" 0
assert_eq       P1-permission "$(printf '%s' "$out" | jq -r '.permission')" "deny"
# Cursor's docs spell this event's response keys snake_case and the shell event's camelCase, and
# the host reads at most one of each pair — so BOTH ride on BOTH events. A key the host ignores
# costs nothing; guessing wrong drops the reason and leaves the model staring at a silent block.
assert_contains P1-agent-msg  "$(printf '%s' "$out" | jq -r '.agent_message')" '.claude/tasks/<work-id>/tmp/elc-123-cart.jpeg'
assert_contains P1-user-msg   "$(printf '%s' "$out" | jq -r '.user_message')"  'scratch-path guard'
assert_contains P1-camel-agent "$(printf '%s' "$out" | jq -r '.agentMessage')" '.claude/tasks/<work-id>/tmp/elc-123-cart.jpeg'
assert_contains P1-camel-user  "$(printf '%s' "$out" | jq -r '.userMessage')"  'scratch-path guard'
# the object spelling of tool_input is accepted too (the string one is what the docs pin)
assert_eq P1b-obj-shape "$(printf '%s' "$(run_shim beforeMCPExecution "$(pev browser_take_screenshot filename elc-1.jpeg obj)")" | jq -r '.permission')" "deny"
# a prefixed tool name (another host's spelling reaching this event) is covered as well
assert_eq P1c-prefixed "$(printf '%s' "$(run_shim beforeMCPExecution "$(pev mcp__playwright__browser_take_screenshot filename elc-1.jpeg)")" | jq -r '.permission')" "deny"
# P2: the sanctioned destination, an out-of-tree path, and a non-screenshot MCP tool are silent.
# The workspace path is ABSOLUTE (v0.64.1): Cursor's tool names carry no server prefix, so the guard
# cannot tell this from a per-user playwright and judges it as a default-configured one — which
# resolves a relative filename against `<cwd>/.playwright-mcp`, inside the checkout.
assert_eq P2-workspace  "$(run_shim beforeMCPExecution "$(pev browser_take_screenshot filename "$PPROJ/.claude/tasks/ELC-1/tmp/shot.png")")" ""
assert_eq P2b-outside   "$(run_shim beforeMCPExecution "$(pev take_screenshot filePath "$TMP/outside.png")")" ""
assert_eq P2c-other-tool "$(run_shim beforeMCPExecution "$(pev browser_navigate url https://example.com)")" ""
# P3: the switch (in-shim; the wiring gate is G3b) and the fail-open rails
assert_eq P3-off        "$(run_shim beforeMCPExecution "$(pev browser_take_screenshot filename elc-1.jpeg)" FND_SCRATCH_GUARD=0)" ""
assert_eq P3b-malformed "$(run_shim beforeMCPExecution 'not json at all')" ""
assert_eq P3c-no-input  "$(run_shim beforeMCPExecution '{"hook_event_name":"beforeMCPExecution","tool_name":"take_screenshot"}')" ""

# P4: the screenshot-tool SET is spelled in four places — plugin.json's matcher, hooks-codex.json's
# matcher, this shim's SCREENSHOT_TOOL (Cursor has no per-event matcher, so the filter lives in
# code) and the guard's own ALWAYS_WRITES. The first two are pinned against each other by
# hooks-codex-sim W10b and against the tool names by hooks-sim D8; nothing pinned this one, so a
# tool renamed in the manifests would go on being guarded everywhere BUT Cursor. The literal is
# read out of the shim, never copied here.
SPT="$(grep 'const SCREENSHOT_TOOL = ' "$SHIM" | head -1 | sed 's|.*= /||; s|/;[[:space:]]*$||')"
if [ -n "$SPT" ]; then ok; else bad P4-literal "cursor-shim.cjs has no SCREENSHOT_TOOL regex literal"; fi
for t in take_screenshot browser_take_screenshot \
         mcp__plugin_fnd_chrome-devtools-mcp__take_screenshot mcp__plugin_fnd_playwright__browser_take_screenshot \
         mcp__chrome-devtools-mcp__take_screenshot mcp__playwright__browser_take_screenshot; do
  if printf '%s\n' "$t" | grep -Eq "$SPT"; then ok; else bad "P4-$t" "SCREENSHOT_TOOL '$SPT' misses a screenshot tool"; fi
done
for t in take_snapshot get_screenshot mcp__chrome-devtools-mcp__take_snapshot mcp__figma-dev-mode__get_screenshot browser_navigate; do
  if printf '%s\n' "$t" | grep -Eq "$SPT"; then bad "P4-not-$t" "SCREENSHOT_TOOL '$SPT' over-matches"; else ok; fi
done

# ═══ X — beforeShellExecution (the two commit guards) ═══════════════════════
xrun() { run_shim beforeShellExecution "$1"; }

out="$(xrun '{"command":"git commit --no-verify -m x","workspace_roots":["/tmp"]}')"; EC=$?
assert_eq       X1-deny-exit    "$EC" 2
assert_eq       X1-permission   "$(printf '%s' "$out" | jq -r '.permission')" "deny"
# both message fields: the developer sees why, and the model gets the rule text back
assert_contains X1-agent-msg    "$(printf '%s' "$out" | jq -r '.agentMessage')" "never commit, push, merge or am with --no-verify"
assert_contains X1-user-msg     "$(printf '%s' "$out" | jq -r '.userMessage')"  "quality gates"
# …in both key spellings, exactly as the MCP deny above (P1)
assert_contains X1-snake-agent  "$(printf '%s' "$out" | jq -r '.agent_message')" "never commit, push, merge or am with --no-verify"
assert_contains X1-snake-user   "$(printf '%s' "$out" | jq -r '.user_message')"  "quality gates"

out="$(xrun '{"command":"git commit -m \"x Co-Authored-By: Claude <noreply@anthropic.com>\""}')"; EC=$?
assert_eq       X2-attr-exit  "$EC" 2
assert_contains X2-attr-msg   "$(printf '%s' "$out" | jq -r '.agentMessage')" "no AI attribution"

out="$(xrun '{"command":"git commit -m \"clean\""}')"; EC=$?
assert_eq X3-allow-out "$out" ""
assert_eq X3-allow-exit "$EC" 0
assert_eq X4-no-command "$(xrun '{"workspace_roots":["/tmp"]}')" ""
assert_eq X5-malformed  "$(xrun 'not json')" ""

# X4b/X5b: a payload whose command key the shim does not recognize (Cursor's key names are an
# open M1a item) disarms every guard on the host — it stays fail-open, but it must SAY so, or
# the degradation is invisible.
printf '{"cmd":"git commit -m wip --no-verify"}' | "$NODE_BIN" "$SHIM" beforeShellExecution >/dev/null 2>"$TMP/x4.err"
assert_contains X4b-unknown-key-warned "$(cat "$TMP/x4.err")" "no recognized command key"
# X12: a deny writes its reason on stderr as well as into the JSON body — under Cursor's
# Claude-compatible exit-2 path stderr IS the reason the model reads, and a block without one
# sends the model looking for another spelling.
printf '{"command":"git commit --no-verify -m x"}' | "$NODE_BIN" "$SHIM" beforeShellExecution >/dev/null 2>"$TMP/x12.err"
assert_contains X12-deny-stderr "$(cat "$TMP/x12.err")" "quality gates"
# Cursor's key is `command`; a Claude-shaped payload still translates (the matrix rows below
# ride this rail)
assert_eq X6-tool-input-shape "$(run_shim beforeShellExecution '{"tool_input":{"command":"git commit -m ok"}}')" ""

# A guard that reaches no verdict: fail-open is the rail everywhere except the no-verify guard
# on a command it would have inspected — a guard that cannot run is a broken install, and
# waving a bypass through on the strength of one is the outcome this layer exists to prevent.
BROKEN="$TMP/broken"; mkdir -p "$BROKEN/hooks"
cp "$SHIM" "$BROKEN/hooks/"
cp "$PLUGIN/hooks/no-ai-attribution.sh" "$BROKEN/hooks/"
printf '#!/usr/bin/env bash\nexit 3\n' > "$BROKEN/hooks/no-verify-bypass.sh"; chmod +x "$BROKEN/hooks/no-verify-bypass.sh"
brun() { local out ec=0; out="$(printf '%s' "$1" | "$NODE_BIN" "$BROKEN/hooks/cursor-shim.cjs" beforeShellExecution 2>/dev/null)" || ec=$?; printf '%s' "$out"; return "$ec"; }

out="$(brun '{"command":"git commit -m x"}')"; EC=$?
assert_eq       X7-broken-exit  "$EC" 2
assert_contains X7-broken-msg   "$(printf '%s' "$out" | jq -r '.agentMessage')" "could not run"
out="$(brun '{"command":"ls -la"}')"; EC=$?
assert_eq X8-broken-nongit "$out" ""
assert_eq       X8-nongit-exit   "$EC" 0

rm "$BROKEN/hooks/no-verify-bypass.sh"
out="$(brun '{"command":"git push origin main"}')"; EC=$?
assert_eq       X9-missing-exit "$EC" 2
assert_contains X9-missing-msg  "$(printf '%s' "$out" | jq -r '.permission')" "deny"

# The attribution guard is best-effort: its failure alone never blocks a command
cp "$PLUGIN/hooks/no-verify-bypass.sh" "$BROKEN/hooks/"
printf '#!/usr/bin/env bash\nexit 3\n' > "$BROKEN/hooks/no-ai-attribution.sh"
out="$(brun '{"command":"git commit -m clean"}')"; EC=$?
assert_eq X10-attr-failopen "$out" ""
assert_eq X10-attr-failopen-exit "$EC" 0
# …but a broken attribution guard must not stop the no-verify guard from running
out="$(brun '{"command":"git commit --no-verify -m x"}')"; EC=$?
assert_eq X11-second-guard-runs "$EC" 2
assert_contains X11-second-guard-msg "$(printf '%s' "$out" | jq -r '.agentMessage')" "quality gates"

# X13 — hooks/spill-access.sh on this same event. It is measurement, not a guard: it must add
# nothing to the response, run only once the guards have allowed the command, and honour its own
# switch in-shim (the wiring cannot pre-gate it — the commit guard shares beforeShellExecution).
SPA_D="$TMP/spa"; mkdir -p "$SPA_D"
SPA_CMD='{"command":"jq -r .x /p/tool-results/b1z10evqs.txt","workspace_roots":["/r/elc"]}'
out="$(run_shim beforeShellExecution "$SPA_CMD" FND_MCP_SLIM_DIR="$SPA_D" FND_MCP_SLIM_DEBUG=1)"; EC=$?
assert_eq       X13-silent  "$out" ""
assert_eq       X13-exit    "$EC" 0
assert_contains X13-line    "$(cat "$SPA_D/fnd-mcp-slim-debug.log" 2>/dev/null)" '"entry":"access"'
assert_contains X13-via     "$(cat "$SPA_D/fnd-mcp-slim-debug.log" 2>/dev/null)" '"via":"jq"'
assert_contains X13-project "$(cat "$SPA_D/fnd-mcp-slim-debug.log" 2>/dev/null)" '"project":"elc"'
# a DENIED command never ran, so it read no spill
SPA_D2="$TMP/spa-denied"; mkdir -p "$SPA_D2"
run_shim beforeShellExecution '{"command":"git commit --no-verify -m x /p/tool-results/b1z10evqs.txt"}' \
  FND_MCP_SLIM_DIR="$SPA_D2" FND_MCP_SLIM_DEBUG=1 >/dev/null 2>&1
if [ -e "$SPA_D2/fnd-mcp-slim-debug.log" ]; then bad X13-denied "a blocked command was recorded as a spill read"; else ok; fi
# the in-shim switch
SPA_D3="$TMP/spa-off"; mkdir -p "$SPA_D3"
run_shim beforeShellExecution "$SPA_CMD" FND_SPILL_ACCESS=0 FND_MCP_SLIM_DIR="$SPA_D3" FND_MCP_SLIM_DEBUG=1 >/dev/null 2>&1
if [ -e "$SPA_D3/fnd-mcp-slim-debug.log" ]; then bad X13-switch "FND_SPILL_ACCESS=0 was ignored in the shim"; else ok; fi
# Cursor documents no read-file event, so nothing routes the file readers here — recorded as the
# host divergence it is, and asserted so a future event cannot land silently unwired.
if grep -qiE 'beforeReadFile|readFile' "$WIRING"; then bad X13-read-event "hooks-cursor.json gained a read event — wire spill-access.sh to it"; else ok; fi

# X12 — the fast-reject list has three copies and hooks/no-verify-bypass.sh is the single source
# (its `case "$input" in *git*|…` line). The two JS copies must stay byte-identical, so they are
# extracted and diffed rather than each pinned to a literal here. The third copy — the `case` glob
# in hooks/hooks-cursor.json's beforeShellExecution fallback — is deliberately COARSER (no `am`,
# no word boundaries): it runs only when node is unavailable, where over-blocking is the safe
# direction, and JSON carries no comment to say so, so it is recorded here.
gt_cursor="$(grep -n 'const GIT_TRIGGER = ' "$SHIM" | head -1 | cut -d: -f2-)"
gt_opencode="$(grep -n 'const GIT_TRIGGER = ' "$PLUGIN/opencode/fnd-plugin.js" | head -1 | cut -d: -f2-)"
if [ -n "$gt_cursor" ]; then ok; else bad X12-trigger-cursor "cursor-shim.cjs has no GIT_TRIGGER literal"; fi
if [ -n "$gt_opencode" ]; then ok; else bad X12-trigger-opencode "opencode/fnd-plugin.js has no GIT_TRIGGER literal"; fi
assert_eq X12-trigger-identical "$gt_cursor" "$gt_opencode"
# and the coarse shell copy still names every keyword the JS one does, minus the documented `am`
for kw in git commit push merge pull; do
  if grep -qF "*$kw*" "$PLUGIN/hooks/hooks-cursor.json"; then ok
  else bad X12-trigger-json "hooks-cursor.json's fallback case glob drops '$kw'"; fi
done

# ═══ H — FND_HOST_TRACE, the host-proof log ════════════════════════════════
# On this host the session context, the prompt hooks' context and the subagent conventions are
# composed by the SHIM, not by a hook command, so the shim is what records them — and every
# canonical script it spawns has to inherit FND_HOST=cursor, or the Cursor column of
# `doctor --trace` reads `unknown` while the host is plainly Cursor.
HTD="$TMP/host-trace"; mkdir -p "$HTD/xdg"          # an XDG root with no domaine/env in it
hrun() { # spill-dir event payload [VAR=val…] — one shim call, tracing into its own sandbox
  local d="$1" event="$2" payload="$3"; shift 3
  mkdir -p "$d"
  printf '%s' "$payload" | env XDG_CONFIG_HOME="$HTD/xdg" FND_MCP_SLIM_DIR="$d" "$@" \
    "$NODE_BIN" "$SHIM" "$event" 2>/dev/null
}
hlog() { cat "$1/fnd-host-trace.log" 2>/dev/null; }

hrun "$HTD/h1" sessionStart "$(ss_in "$SS_STORE")" FND_HOST_TRACE=1 >/dev/null
assert_eq       H1-one-line "$(hlog "$HTD/h1" | wc -l | tr -d ' ')" 1
assert_contains H1-host     "$(hlog "$HTD/h1")" '"host":"cursor"'
assert_contains H1-event    "$(hlog "$HTD/h1")" '"event":"SessionStart"'
assert_contains H1-hook     "$(hlog "$HTD/h1")" '"hook":"cursor-shim"'
assert_contains H1-decision "$(hlog "$HTD/h1")" '"decision":"inject"'
assert_eq       H1-ms-integer "$(hlog "$HTD/h1" | jq -r '.ms | if . == floor then "int" else "not-int" end')" "int"

# A shim that emitted nothing still fires — `pass` is what tells a reader the hook RAN and had
# nothing to say, which is the whole difference from a hook that never ran at all.
hrun "$HTD/h2" beforeSubmitPrompt '{"prompt":"hello"}' FND_HOST_TRACE=1 >/dev/null
assert_contains H2-event    "$(hlog "$HTD/h2")" '"event":"UserPromptSubmit"'
assert_contains H2-decision "$(hlog "$HTD/h2")" '"decision":"pass"'
hrun "$HTD/h3" subagentStart '{"agent_type":"general-purpose"}' FND_HOST_TRACE=1 >/dev/null
assert_contains H3-subagent-event "$(hlog "$HTD/h3")" '"event":"SubagentStart"'
assert_contains H3-subagent-host  "$(hlog "$HTD/h3")" '"host":"cursor"'

# Off is off, and the response is byte-identical either way — the log is a side effect, never
# an output.
on="$(hrun "$HTD/h4on" sessionStart "$(ss_in "$SS_STORE")" FND_HOST_TRACE=1)"
off="$(hrun "$HTD/h4off" sessionStart "$(ss_in "$SS_STORE")")"
assert_eq H4-identical-stdout "$on" "$off"
if [ -e "$HTD/h4off/fnd-host-trace.log" ]; then bad H4-off-nofile "a trace line was written with the switch off"; else ok; fi

# The guard events translate a spawned script's verdict, and that script writes its own line —
# a second one from the shim would double every deny in the matrix.
hrun "$HTD/h5" beforeShellExecution '{"command":"git commit --no-verify -m x"}' FND_HOST_TRACE=1 >/dev/null
assert_absent H5-no-double-count "$(hlog "$HTD/h5")" '"hook":"cursor-shim"'

# H6: FND_HOST reaches the SPAWNED script — it is the shim, not the wiring, that knows the host
# here, and a canonical script left without the tag would file its own line under `unknown`.
HOSTREC="$TMP/hostrec"; mkdir -p "$HOSTREC/hooks"
cp "$SHIM" "$HOSTREC/hooks/"
printf '#!/bin/sh\nprintf "FNDHOST=[%%s]\\n" "${FND_HOST:-}"\n' > "$HOSTREC/hooks/subagent-conventions.sh"
chmod +x "$HOSTREC/hooks/subagent-conventions.sh"
out="$(printf '%s' '{"agent_type":"general-purpose"}' | env -u FND_HOST "$NODE_BIN" \
  "$HOSTREC/hooks/cursor-shim.cjs" subagentStart 2>/dev/null | jq -r '.additional_context' 2>/dev/null)"
assert_contains H6-child-host "$out" "FNDHOST=[cursor]"

# ═══ N — the whole commit-guard matrix, re-run through the Cursor dialect ═══
# The case lists are READ from the matrix file, never copied: rows added there must be covered
# here on the next run, and a rename that breaks the extraction trips the row-count floor below.
if [ -f "$MATRIX" ]; then ok; else bad N0-matrix "tests/no-verify-bypass-matrix.sh not found"; fi

# The matrix's own harness: `check` takes a command string, `raw` a whole (Claude-protocol)
# stdin — both become Cursor payloads here, and the verdict is read off `permission` + exit
# code instead of the exit code alone.
check() { # $1 block|allow  $2 label  $3 command string
  local expect="$1" label="$2" cmd="$3" out ec=0
  out="$(jq -n --arg c "$cmd" '{command:$c}' | "$NODE_BIN" "$SHIM" beforeShellExecution 2>/dev/null)" || ec=$?
  n_verdict "$expect" "$label" "$ec" "$out" "$cmd"
}
raw() { # $1 block|allow  $2 label  $3 raw stdin  [$4 PATH override]
  # The matrix's raw rows are Claude-protocol events — the shim reads `tool_input.command` as
  # well as Cursor's `command`, so they translate untouched. node is invoked by absolute path:
  # the PATH override exists to hide jq from the GUARDS, and finding the runtime through it
  # would either fail or drag jq back in with it.
  local expect="$1" label="$2" input="$3" path="${4-}" out ec=0
  if [ -n "$path" ]; then
    out="$(printf '%s' "$input" | PATH="$path" "$NODE_BIN" "$SHIM" beforeShellExecution 2>/dev/null)" || ec=$?
  else
    out="$(printf '%s' "$input" | "$NODE_BIN" "$SHIM" beforeShellExecution 2>/dev/null)" || ec=$?
  fi
  n_verdict "$expect" "$label" "$ec" "$out" "$input"
}
n_verdict() { # expect label exit-code stdout subject
  local expect="$1" label="N-$2" ec="$3" out="$4" subject="$5"
  local denied=no
  case "$out" in *'"permission":"deny"'*) denied=yes ;; esac
  if [ "$expect" = block ]; then
    if [ "$denied" = yes ] && [ "$ec" -eq 2 ]; then pass=$((pass+1)); return; fi
  else
    if [ "$denied" = no ] && [ "$ec" -eq 0 ] && [ -z "$out" ]; then pass=$((pass+1)); return; fi
  fi
  fail=$((fail+1))
  failures="${failures}  [$label] expected $expect, got exit $ec :: $out :: $subject
"
}

# No jq on PATH → the guards' sed fallback must still reach the same verdict through the shim.
# `bash` joins the matrix's five tools because the shim spawns each guard by its own shebang
# (`/usr/bin/env bash`), which resolves the interpreter through PATH.
shim_path="$TMP/nojq"; mkdir -p "$shim_path"
for t in cat tr sed grep awk bash; do ln -sf "$(command -v "$t")" "$shim_path/$t"; done
shim="$shim_path" # the name the matrix's own `raw` rows pass as their PATH override

n_before=$pass
eval "$(awk '/^no_verify_cases\(\) \{/,/^\}/' "$MATRIX"; awk '/^attribution_cases\(\) \{/,/^\}/' "$MATRIX")"
no_verify_cases
attribution_cases

# The matrix's two tail blocks are inline loops, not part of either case function, and they
# pin the fast rejects — the quote-split subcommand that only `git` itself keeps in (block),
# and the split-`git` pair the reject deliberately leaves open (allow). Same verdicts here:
# the shim hands the guards the identical command text.
for xp in 'git com"mit" -n -m x' "git com\$'mit' -n -m x" 'git pu"sh" --no-verify' 'HUSKY=0 git com"mit" -m x'; do
  check block "XP-split-kw" "$xp"
done
for xq in 'g"it" com"mit" -n -m x' "g\$'it' com\$'mit' --no-verify -m x"; do
  check allow "XQ-split-git" "$xq"
done

n_rows=$((pass + fail - n_before))
if [ "$n_rows" -ge 200 ]; then ok
else bad N1-row-floor "only $n_rows matrix rows ran through the shim — did the case-list extraction break?"; fi

echo "cursor hooks sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  printf '%s' "$failures"
  exit 1
fi
