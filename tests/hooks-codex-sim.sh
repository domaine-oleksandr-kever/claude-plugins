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
#             screenshot tools (Codex's MCP names carry no plugin_fnd_ prefix). W12 is the
#             host-proof log: every command exports FND_HOST=codex, and SessionStart — the one
#             injection composed by a shell command — records itself.
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
#   M cases — PostToolUse through hooks/codex-mcp-shim.cjs: the FND_MCP_SLIM gate, then the BLOCK
#             channel — this host's only way to replace a tool result — carrying both halves of the
#             compressor (a whale's stub with its byte-exact spill, and a compressed body) behind the
#             header that corrects Codex's "Script failed" framing; the two fallbacks (an emission the
#             one-string channel cannot carry → the old additionalContext path for a stub, a dropped
#             body for a compression) and the CAP (M12: over it the body is spilled and stubbed with
#             reason `block-cap`, never truncated); the rails (error shape, small result, malformed
#             stdin, a broken mcp-slim, a HUNG one bounded by the spawn timeout, a child that does not
#             label its emission) all silent, and __dirname resolution that ignores a wrong
#             plugin-root env — plus the delivery accounting throughout: the shim tells the child this
#             host's contract, so the debug record (and `--report`) counts what was DELIVERED, not
#             what the compressor achieved.
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
# their exported switches must not leak into the cases. Same reason for the host-proof log — and
# an exported FND_HOST would rewrite the `host` column the W12 cases pin.
unset FND_MCP_SLIM_DEBUG FND_MCP_SLIM_DIR FND_MCP_SLIM_STUB FND_LEAN FND_CTX_MONITOR FND_PROMPT_JSON
export FND_HOST_TRACE=0; unset FND_HOST # `0`, not unset: unset falls through to the developer's real global env file

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
# root expansion swapped for a shell variable resolved from either env var Codex sets, and the
# host tag swapped for this host's name — FND_HOST is what the trace log's `host` column reports,
# so a command that kept `claude` here would file this host's proof under the wrong one.
codex_spelling() { printf '%s' "$1" | sed -e 's/\${CLAUDE_PLUGIN_ROOT}/$r/g' -e 's/FND_HOST=claude/FND_HOST=codex/g'; }
HOST_TAG='export FND_HOST=codex; '
want_cmd() {
  printf '%s%s%s' "$HOST_TAG" 'r="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"; ' \
    "$(codex_spelling "${1#export FND_HOST=claude; }")"
}

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
# mcp-slim directly, because this host replaces a result only through a hook BLOCK, whose reason the
# adapter builds. Everything else about the command (the FND_MCP_SLIM gate, the `|| true` fail-open)
# is unchanged.
assert_eq W4-posttooluse "$(wcmd PostToolUse 0)" \
  "$(printf '%s' "$(want_cmd "$(ccmd PostToolUse 0)")" | sed -e 's#hooks/mcp-slim.cjs#hooks/codex-mcp-shim.cjs#')"

# W5: every script the wiring names exists in the canonical hooks dir (single-copy: no forked
# per-host copy of a guard or of the compressor).
scripts="$(jq -r '.hooks | to_entries[] | .value[] | .hooks[] | .command' "$WIRING" | grep -oE 'hooks/[a-z0-9-]+\.(cjs|sh)' | sort -u)"
for s in $scripts; do
  if [ -f "$PLUG/$s" ]; then ok; else bad "W5-$s" "wiring names a file that does not exist"; fi
done
assert_eq W5-count "$(printf '%s\n' "$scripts" | grep -c .)" 8

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
# A REAL whale on disk: the recorder drops a path that is not a file, since PreToolUse fires only
# after the platform wrote the spill.
SPA_SP="$TMP/spa-spill/tool-results"; mkdir -p "$SPA_SP"; : > "$SPA_SP/b1z10evqs.txt"
SPA_PAY='{"tool_name":"shell","tool_input":{"command":["bash","-lc","jq . '"$SPA_SP"'/b1z10evqs.txt"]},"cwd":"/r/elc"}'
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

# W12: FND_HOST_TRACE — the host tag every command carries, and the SessionStart trace call. The
# log answers "did this hook fire on THIS host", so a Codex command that shipped without the tag
# would file its proof under `unknown` and leave the Codex column of `doctor --trace` empty.
# `xdg` is an XDG root with no domaine/env in it: the OFF case must be off because the switch is
# nowhere, not because this machine happens to say so.
HTD="$TMP/host-trace"; mkdir -p "$HTD/ss" "$HTD/ss-off" "$HTD/xdg"
ht_ss() { # spill-dir [VAR=val…] — the SessionStart command, tracing into its own sandbox
  local d="$1"; shift
  ( cd "$TMP" && env XDG_CONFIG_HOME="$HTD/xdg" FND_MCP_SLIM_DIR="$d" CLAUDE_PLUGIN_ROOT="$PLUG" "$@" \
      bash -c "$(wcmd SessionStart)" 2>/dev/null )
}
for c in "$(wcmd SessionStart)" "$(wcmd UserPromptSubmit)" "$(wcmd SubagentStart)" \
         "$(wcmd PreToolUse 0)" "$(wcmd PreToolUse 1)" "$SPG_CMD" "$SPA_CMD" "$(wcmd PostToolUse)"; do
  assert_contains W12-host-tag "$c" 'export FND_HOST=codex;'
done
# the SessionStart command is the one injection composed by a shell command rather than a script,
# so the command itself has to record it
ht_ss "$HTD/ss" FND_HOST_TRACE=1 >/dev/null
line="$(cat "$HTD/ss/fnd-host-trace.log" 2>/dev/null)"
assert_contains W12-ss-host     "$line" '"host":"codex"'
assert_contains W12-ss-event    "$line" '"event":"SessionStart"'
assert_contains W12-ss-hook     "$line" '"hook":"session-start"'
assert_contains W12-ss-decision "$line" '"decision":"inject"'
# off is off: no switch, no file — and the session context is printed either way
out="$(ht_ss "$HTD/ss-off")"; ec=$?
assert_eq       W12-off-exit  "$ec" 0
assert_contains W12-off-ctx   "$out" "oversized MCP results"
if [ -e "$HTD/ss-off/fnd-host-trace.log" ]; then bad W12-off-nofile "the trace log was written with the switch off"; else ok; fi
# …and the tag reaches the spawned script, which is what writes ITS line (the guard commands
# resolve the bundle themselves, so a recorder root proves the export without the guard's help)
htrec="$TMP/htrec"; mkdir -p "$htrec/hooks"
printf '#!/bin/sh\nprintf "%%s" "${FND_HOST:-}" > "$HT_REC"\n' > "$htrec/hooks/no-verify-bypass.sh"
chmod +x "$htrec/hooks/no-verify-bypass.sh"
printf '%s' '{"tool_name":"shell","tool_input":{"command":"ls"}}' \
  | env CLAUDE_PLUGIN_ROOT="$htrec" HT_REC="$TMP/htrec.out" bash -c "$(wcmd PreToolUse 1)" >/dev/null 2>&1
assert_eq W12-child-host "$(cat "$TMP/htrec.out" 2>/dev/null)" "codex"

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

# U2: the context monitor reads a Codex rollout — `token_count` events, the live figure from
# `last_token_usage`, the window Codex states, the model from the hook input. An `info: null`
# event after the real one must not win it, nor a prose line that merely mentions "token_count".
# The notice rides `systemMessage`, the band flag `hookSpecificOutput.additionalContext` — both
# shapes Codex accepts on UserPromptSubmit.
ctx_line() { # totalTokens [windowKey]
  printf '{"timestamp":"2026-09-08T07:55:52.626Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2030247,"output_tokens":15510,"total_tokens":2045757},"last_token_usage":{"input_tokens":%s,"cached_input_tokens":148864,"output_tokens":119,"total_tokens":%s}%s}}}\n' \
    "$1" "$1" "${2:+,\"model_context_window\":258400}"
}
{ ctx_line 90000 win
  ctx_line 151660 win
  printf '%s\n' '{"type":"event_msg","payload":{"type":"token_count","info":null}}'
  printf '%s\n' '{"type":"response_item","payload":{"type":"message","content":[{"type":"input_text","text":"the \"token_count\" event is not this line"}]}}'; } > "$TMP/t0.jsonl"
in="$(jq -n --arg t "$TMP/t0.jsonl" --arg s "codex-u2-$$" \
  '{transcript_path:$t,session_id:$s,prompt:"hi",cwd:"/tmp",model:"gpt-5.6-codex"}')"
out="$(run_prompt "$in" FND_CTX_WARN=0)"; ec=$?
assert_eq       U2-exit    "$ec" 0
assert_contains U2-ctx     "$out" "additionalContext"
assert_contains U2-usage   "$out" "151.7k/258k"
assert_contains U2-model   "$out" "gpt-5.6-codex"

# U2b: no window in the rollout and no override → silence. Guessing Claude's 200k default for a
# GPT session would report a percentage that is simply wrong.
ctx_line 151660 > "$TMP/t1.jsonl"
in="$(jq -n --arg t "$TMP/t1.jsonl" --arg s "codex-u2b-$$" '{transcript_path:$t,session_id:$s,prompt:"hi",cwd:"/tmp"}')"
out="$(run_prompt "$in" FND_CTX_WARN=0)"; ec=$?
assert_eq U2b-exit  "$ec" 0
assert_eq U2b-quiet "$out" ""

# U2c: …unless the operator states the window.
out="$(run_prompt "$in" FND_CTX_WARN=0 FND_CTX_WINDOW=200000)"; ec=$?
assert_eq       U2c-exit  "$ec" 0
assert_contains U2c-usage "$out" "151.7k/200k"

# U2d: no `total_tokens` on the live figure → input + output; the window stated only on an
# OLDER event still counts.
{ ctx_line 90000 win
  printf '%s\n' '{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":151541,"cached_input_tokens":148864,"output_tokens":119}}}}'; } > "$TMP/t2.jsonl"
in="$(jq -n --arg t "$TMP/t2.jsonl" --arg s "codex-u2d-$" '{transcript_path:$t,session_id:$s,prompt:"hi",cwd:"/tmp"}')"
out="$(run_prompt "$in" FND_CTX_WARN=0)"; ec=$?
assert_eq       U2d-exit  "$ec" 0
assert_contains U2d-usage "$out" "151.7k/258k"

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

# The host's ceiling on a reason, read off the adapter so the arithmetic below cannot drift from it.
# The adapter hands the child that ceiling LESS its own header and the join (M13b), so the whole size
# contract is one line: the reason it prints is never longer than the ceiling.
BLOCK_BYTES="$(sed -n 's/^const BLOCK_REASON_BYTES = \([0-9]*\);$/\1/p' "$SHIMJS")"
if [ -n "$BLOCK_BYTES" ]; then ok; else bad M2-cap-const "no named BLOCK_REASON_BYTES constant in the shim"; fi
reason_of() { printf '%s' "$1" | jq -r '.reason' 2>/dev/null; }
# The reason fits the channel: header, join and the joined emission together, measured the way the host
# measures them (bytes — it counts 4 per token, whatever the text).
fits_cap() { # reason
  local rb; rb=$(printf '%s' "$1" | wc -c | tr -d ' ')
  if [ "$rb" -le "$BLOCK_BYTES" ]; then echo yes; else echo "reason $rb B over the $BLOCK_BYTES B ceiling"; fi
}

# M2: a whale the compressor cannot shrink → the stub comes back through the BLOCK channel, the only
# way this host lets a hook replace a tool result, and the spill on disk is byte-exact. Never
# updatedToolOutput (parsed and unsupported here) and never additionalContext (that channel leaves the
# raw whale standing beside the stub — the fallback below, not the main path).
WHALE="$(printf 'x%.0s' $(seq 1 40000))"
printf '%s' "$WHALE" > "$TMP/whale.txt"
in="$(jq -n --arg t "$WHALE" '{tool_name:"mcp__plugin_fnd_chrome-devtools-mcp__evaluate_script",tool_response:{content:[{type:"text",text:$t}]}}')"
out="$(run_ptu "$in")"; ec=$?
assert_eq       M2-exit       "$ec" 0
assert_contains M2-block      "$out" '"decision":"block"'
assert_absent   M2-no-rewrite "$out" "updatedToolOutput"
assert_absent   M2-no-context "$out" "additionalContext"
r="$(reason_of "$out")"
assert_contains M2-marker    "$r" "<<fnd-mcp-slim stub>>"
assert_contains M2-cli       "$r" "json-slim.cjs"
p="$(printf '%s' "$r" | grep -o 'full=[^ >]*' | head -1 | sed 's/^full=//')"
if [ -n "$p" ] && [ -f "$p" ] && cmp -s "$p" "$TMP/whale.txt"; then ok; else bad M2-spill "spill missing or not byte-exact (p='$p')"; fi
assert_eq M2-cap "$(fits_cap "$r")" yes
# The pointer must not carry the whale itself back into context — the stub's shape hint quotes
# the first few dozen bytes of the payload and nothing more, so the payload character survives
# in a count far below the 40 000 the result held.
xcount=$(printf '%s' "$r" | tr -cd 'x' | wc -c | tr -d ' ')
if [ "$xcount" -lt 500 ]; then ok; else bad M2-no-payload "the adapter re-injected the payload ($xcount payload bytes)"; fi

# M2b: the HEADER — the whole correction of the framing Codex puts around a block ("Script failed" /
# "Script error:"), which is why block-as-error is usable at all. One copy, at the top, saying the call
# succeeded and must not be retried.
h="${r%%$'\n\n'*}"
assert_contains M2b-succeeded "$h" "SUCCEEDED"
assert_contains M2b-no-retry  "$h" "must NOT be retried"
assert_contains M2b-framing   "$h" "Script error"
assert_eq M2b-once "$(printf '%s' "$r" | grep -c 'NOT an error' || true)" 1
assert_eq M2b-first "$(printf '%s' "$r" | head -c 12)" "fnd mcp-slim"

# M3: a raw-string result stubs the same way (the shape mcp-slim mirrors is irrelevant here —
# the reason is one string whatever the emission's shape was).
in="$(jq -n --arg t "$WHALE" '{tool_name:"mcp__x__y",tool_response:$t}')"
assert_contains M3-string-stub "$(reason_of "$(run_ptu "$in")")" "<<fnd-mcp-slim stub>>"

# M4: a merely COMPRESSIBLE result — the half this host used to throw away, since re-injecting a
# compressed copy beside the raw original only grows context. Through the block channel the raw one is
# withheld, so the compressed body IS the result: it comes back as the reason, with no stub in sight.
ROWS="$(jq -nc '[range(300)|{id:.,label:("row "+(.|tostring)),avatarUrl:("https://cdn.example.com/"+("a"*80)),empty:null}]|tojson')"
in="$(jq -n --argjson r "$ROWS" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$r}]}}')"
out="$(run_ptu "$in")"; ec=$?
r="$(reason_of "$out")"
assert_eq       M4-exit       "$ec" 0
assert_contains M4-block      "$out" '"decision":"block"'
assert_contains M4-body       "$r" '"label":"row 299"'
assert_absent   M4-not-a-stub "$r" "<<fnd-mcp-slim stub>>"
assert_contains M4-handle     "$r" "original_result"
assert_eq       M4-cap        "$(fits_cap "$r")" yes
rb=$(printf '%s' "$r" | wc -c | tr -d ' '); ib=$(printf '%s' "$in" | wc -c | tr -d ' ')
if [ "$rb" -lt $(( ib / 3 )) ]; then ok; else bad M4-smaller "reason $rb B is not a compression of $ib B"; fi

# M5: the rails mcp-slim owns stay silent through the adapter too.
in="$(jq -n --rawfile t "$JIRA" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}],isError:true}}')"
assert_eq M5-error-shape "$(run_ptu "$in")" ""
in="$(jq -n '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:"tiny"}]}}')"
assert_eq M5b-small "$(run_ptu "$in")" ""
assert_eq M5c-malformed "$(run_ptu 'not json at all')" ""

# M6: a per-block stub set (blocks carrying more than type/text cannot be collapsed) — the reason is
# the joined emission, so every stub rides in it. The per-block fields the join cannot spell
# (`annotations` here) are the stated ceiling of this channel; the text they annotated is a stub either
# way, and its spill is named.
in="$(jq -n --arg t "$WHALE" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t,annotations:{audience:["user"]}},{type:"text",text:$t,annotations:{audience:["user"]}}]}}')"
r="$(reason_of "$(run_ptu "$in")")"
n=$(printf '%s' "$r" | grep -c '<<fnd-mcp-slim stub>>' || true)
if [ "$n" -ge 2 ]; then ok; else bad M6-per-block "want a stub per over-limit block, got $n"; fi
assert_eq M6-cap "$(fits_cap "$r")" yes

# M7: __dirname resolution — a WRONG plugin-root env (Cursor's leak bug, Claude's cache/source
# split) must not change which mcp-slim runs.
in="$(jq -n --arg t "$WHALE" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}]}}')"
out="$(printf '%s' "$in" | env CLAUDE_PLUGIN_ROOT="$TMP/nonexistent" PLUGIN_ROOT="$TMP/nonexistent" \
  FND_MCP_SLIM_DIR="$MSD" node "$SHIMJS" 2>/dev/null)"
assert_contains M7-dirname "$(reason_of "$out")" "<<fnd-mcp-slim stub>>"

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

# M9: a HUNG mcp-slim must not hang Codex's hook — the spawn is bounded, and the timeout lands on
# the same fail-open path as a crash (spawnSync sets child.error). The copy runs with the constant
# sed'd down so the case costs a second instead of the production 30 s; the patch itself is
# asserted, so a rename or an inlined literal fails here rather than silently untesting the rail.
hang="$TMP/hang"; mkdir -p "$hang"
sed 's/^const SPAWN_TIMEOUT_MS = 30000;$/const SPAWN_TIMEOUT_MS = 1000;/' "$SHIMJS" > "$hang/codex-mcp-shim.cjs"
if grep -q '^const SPAWN_TIMEOUT_MS = 1000;$' "$hang/codex-mcp-shim.cjs"; then ok
else bad M9-patch "no named SPAWN_TIMEOUT_MS = 30000 constant to bound the spawn"; fi
printf 'setTimeout(function(){}, 20000);\n' > "$hang/mcp-slim.cjs"
s=$(date +%s)
out="$(printf '%s' "$in" | node "$hang/codex-mcp-shim.cjs" 2>/dev/null)"; ec=$?
el=$(( $(date +%s) - s ))
assert_eq M9-hang-silent "$out" ""
assert_eq M9-hang-exit   "$ec" 0
if [ "$el" -lt 8 ]; then ok; else bad M9-hang-bounded "the hook waited ${el}s on a child that never exits"; fi
# M9b: the CHILD decides and this adapter obeys. A fast child that labels its emission is forwarded…
fake_child() { printf 'var c=[];process.stdin.on("data",function(d){c.push(d)});process.stdin.on("end",function(){process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PostToolUse",updatedToolOutput:{content:[{type:"text",text:"<<fnd-mcp-slim stub>> full=/dev/null"}]}%s}}))});\n' "$1" > "$hang/mcp-slim.cjs"; }
fake_child ',fndDelivery:"block"'
assert_contains M9b-fast-child "$(reason_of "$(printf '%s' "$in" | node "$hang/codex-mcp-shim.cjs" 2>/dev/null)")" "<<fnd-mcp-slim stub>>"
# …and one that does not is a contract this file may not guess at: an unlabelled emission (an older
# child, a build that does not know the channel) is dropped, which is the outcome that cannot hurt —
# the host's own result still stands.
fake_child ''
assert_eq M9c-unlabelled "$(printf '%s' "$in" | node "$hang/codex-mcp-shim.cjs" 2>/dev/null)" ""
fake_child ',fndDelivery:"blocc"'
assert_eq M9d-unknown-label "$(printf '%s' "$in" | node "$hang/codex-mcp-shim.cjs" 2>/dev/null)" ""
# M9e: obeying the child stops where the join would DROP something. A block withholds the raw result,
# so an envelope sibling left out of the one string would exist nowhere at all — the canonical child
# refuses to label such an emission (M11c), and a child from another build that does is a contract
# break this file answers with its own silence rather than with a lossy replacement.
printf 'var c=[];process.stdin.on("data",function(d){c.push(d)});process.stdin.on("end",function(){process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PostToolUse",updatedToolOutput:{content:[{type:"text",text:"<<fnd-mcp-slim stub>> full=/dev/null"}],_meta:{nextCursor:"CURSOR-PAGE-2"}},fndDelivery:"block"}}))});\n' > "$hang/mcp-slim.cjs"
assert_eq M9e-sibling-refused "$(printf '%s' "$in" | node "$hang/codex-mcp-shim.cjs" 2>/dev/null)" ""

# M10–M12: DELIVERY accounting. mcp-slim writes its debug record BEFORE this adapter has printed
# anything, so the shim hands it this host's contract (`--delivery=block:<cap>`) and the record says what
# was delivered, not merely what the compressor achieved. Without it `--report` read a dropped body as a
# saving (measured: "79.8% saved" for a call that put nothing in front of the model).
DBGLOG="fnd-mcp-slim-debug.log"
REPORT() { node "$PLUG/scripts/json-slim.cjs" --report "$1" 2>/dev/null; }
run_ptu_dbg() { # dir input-json [VAR=val…]
  local d="$1" i="$2"; shift 2
  printf '%s' "$i" | env CLAUDE_PLUGIN_ROOT="$PLUG" FND_MCP_SLIM_DIR="$d" FND_MCP_SLIM_DEBUG=2 "$@" bash -c "$PTU_CMD" 2>/dev/null
}
# The `delivered` field claims to measure what the ADDING fallback can forward, so it is checked against
# the additionalContext the run actually printed: the fixed header (~220 B) is the only slack.
near_ctx() { local c; c="$(printf '%s' "$1" | wc -c | tr -d " ")"
  if [ "$c" -ge "$2" ] && [ $(( c - $2 )) -le 400 ]; then echo yes; else echo "context $c B vs delivered $2 B"; fi; }

# M10: a delivered compression → decision `compressed`, delivery `replace` (the same accounting Claude
# Code gets, because the same thing happened to the result), and a report that credits the saving.
D1="$TMP/mcp-dbg-block"; mkdir -p "$D1"
in="$(jq -n --argjson r "$ROWS" '{tool_name:"mcp__a__x",tool_response:{content:[{type:"text",text:$r}]}}')"
assert_contains M10-block    "$(run_ptu_dbg "$D1" "$in")" '"decision":"block"'
assert_eq M10-decision "$(jq -r '.decision' "$D1/$DBGLOG" 2>/dev/null)" "compressed"
assert_eq M10-delivery "$(jq -r '.delivery' "$D1/$DBGLOG" 2>/dev/null)" "replace"
assert_eq M10-host     "$(jq -r '.host'     "$D1/$DBGLOG" 2>/dev/null)" "codex"
bi="$(jq -r '.bytes_in' "$D1/$DBGLOG" 2>/dev/null)"; bo="$(jq -r '.bytes_out' "$D1/$DBGLOG" 2>/dev/null)"
rep="$(REPORT "$D1/$DBGLOG")"
assert_contains M10-report-saved "$rep" "totals: $bi → $bo B"
assert_contains M10-report-ranked "$rep" "B over 1 call — mcp__a__x"
# A log in which every event landed reads exactly like a Claude Code one — the line exists to name a
# FALLBACK, so a host where none was taken must not grow one.
assert_absent M10-report-no-line "$rep" "delivery:"

# M10b: the flag is the ONLY thing that moves the accounting — the same child, run the Claude way,
# writes no `delivery` field and no channel instruction, and its saving is real there too.
D2="$TMP/mcp-dbg-replace"; mkdir -p "$D2"
out="$(printf '%s' "$in" | env FND_MCP_SLIM_DIR="$D2" FND_MCP_SLIM_DEBUG=2 node "$PLUG/hooks/mcp-slim.cjs")"
assert_eq     M10b-no-field "$(jq -r '.delivery // "absent"' "$D2/$DBGLOG" 2>/dev/null)" "absent"
assert_absent M10b-no-fnd   "$out" "fndDelivery"
assert_absent M10b-no-line  "$(REPORT "$D2/$DBGLOG")" "delivery:"

# M10c: an adapter that mis-spells the flag (`discard` is a per-decision OUTCOME, never a mode) must not
# land back on the default contract — that is the overstated accounting this whole flag removes, and it
# would pass every suite silently. An unrecognised token reads as `additional`, which can only understate.
# A malformed CAP is the same class of bug one layer down, and takes the same pessimistic reading: never
# invent a ceiling for a channel that truncates whatever exceeds it.
D2b="$TMP/mcp-dbg-badflag"; mkdir -p "$D2b"
for bad_flag in --delivery=discard --delivery=block:0 --delivery=block:lots --delivery=block:; do
  rm -f "$D2b/$DBGLOG"
  printf '%s' "$in" | env FND_MCP_SLIM_DIR="$D2b" FND_MCP_SLIM_DEBUG=2 \
    node "$PLUG/hooks/mcp-slim.cjs" "$bad_flag" >/dev/null 2>&1
  assert_eq "M10c-not-replace$bad_flag" "$(jq -r '.delivery // "absent"' "$D2b/$DBGLOG" 2>/dev/null)" "discard"
done
assert_contains M10c-report-zero "$(REPORT "$D2b/$DBGLOG")" "(0.0% saved)"

# M11: the ADDING fallback. An envelope sibling (`_meta` here, a pagination cursor; `structuredContent`
# is the other) rides beside `content` and can BE the payload — the reason is one string and would evict
# it, and a stub's spill holds the text payload only, so nothing on disk would hold it either. The stub
# goes back as additionalContext instead, beside the raw result that still stands, and the report counts
# the DELIVERED bytes as an ADDITION, never as a saving.
D3="$TMP/mcp-dbg-additional"; mkdir -p "$D3"
in="$(jq -n --arg t "$WHALE" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}],_meta:{cursor:"abc123"}}}')"
out="$(run_ptu_dbg "$D3" "$in")"
ctx="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null)"
assert_absent   M11-not-a-block "$out" '"decision":"block"'
assert_contains M11-context  "$ctx" "<<fnd-mcp-slim stub>>"
assert_contains M11-standing "$ctx" "the raw result still stands"
assert_eq       M11-decision "$(jq -r '.decision' "$D3/$DBGLOG" 2>/dev/null)" "stubbed"
assert_eq       M11-delivery "$(jq -r '.delivery' "$D3/$DBGLOG" 2>/dev/null)" "additional"
bi="$(jq -r '.bytes_in' "$D3/$DBGLOG" 2>/dev/null)"; dv="$(jq -r '.delivered' "$D3/$DBGLOG" 2>/dev/null)"
rep="$(REPORT "$D3/$DBGLOG")"
assert_contains M11-report-added "$rep" "totals: $bi → $((bi + dv)) B"
assert_contains M11-report-line  "$rep" "delivery: additional 1"
assert_contains M11-report-unranked "$rep" "(no hook compressions)"
# …and the figure is the context this run actually printed, bar the adapter's fixed header.
assert_eq M11-tracks-context "$(near_ctx "$ctx" "$dv")" yes

# M11b: the other half of that fallback — a compressed body it cannot carry is DROPPED, exactly as
# every compression was before the block channel: adding it beside the raw original would grow context.
D4="$TMP/mcp-dbg-discard"; mkdir -p "$D4"
in="$(jq -n --rawfile t "$JIRA" '{tool_name:"mcp__plugin_fnd_atlassian__getJiraIssue",tool_response:{content:[{type:"text",text:$t},{type:"image",data:"AAAA",mimeType:"image/png"}]}}')"
assert_eq M11b-silent   "$(run_ptu_dbg "$D4" "$in" FND_MCP_SLIM_STUB=0)" ""
assert_eq M11b-decision "$(jq -r '.decision' "$D4/$DBGLOG" 2>/dev/null)" "compressed"
assert_eq M11b-delivery "$(jq -r '.delivery' "$D4/$DBGLOG" 2>/dev/null)" "discard"
bi="$(jq -r '.bytes_in' "$D4/$DBGLOG" 2>/dev/null)"
rep="$(REPORT "$D4/$DBGLOG")"
assert_contains M11b-report-zero "$rep" "totals: $bi → $bi B (0.0% saved)"
assert_contains M11b-report-line "$rep" "delivery: discard 1"

# M11c: the same rail on the COMPRESSED half — and the reason it must be the same rail. A block
# WITHHOLDS the raw result, so a body joined into the reason without its `_meta` cursor would leave that
# cursor nowhere the model can see: not in context, not named by the `full=` handle, which promises the
# original and says nothing about a field being dropped. The body is discarded instead and Codex's own
# result stands, cursor included — the pre-channel outcome, which is the only one that loses nothing.
D4c="$TMP/mcp-dbg-sibling-body"; mkdir -p "$D4c"
in="$(jq -n --argjson r "$ROWS" '{tool_name:"mcp__a__x",tool_response:{content:[{type:"text",text:$r}],_meta:{nextCursor:"CURSOR-PAGE-2"}}}')"
assert_eq M11c-silent   "$(run_ptu_dbg "$D4c" "$in")" ""
assert_eq M11c-decision "$(jq -r '.decision' "$D4c/$DBGLOG" 2>/dev/null)" "compressed"
assert_eq M11c-delivery "$(jq -r '.delivery' "$D4c/$DBGLOG" 2>/dev/null)" "discard"

# M12: the CAP. Codex truncates a tool output past its token limit to the head, so a compressed body
# over the cap would arrive with its `full=` recovery handle cut off the tail — the one outcome worse
# than not delivering it. mcp-slim spills and STUBS instead (reason `block-cap`, its own vocabulary
# entry, so `--report` can count how often the ceiling bites) and the stub goes through the same
# channel. Reached here through the wired shim with a payload that compresses ~15 %: over the cap, under
# the stub threshold — the window the stub guard alone would have missed.
D5="$TMP/mcp-dbg-blockcap"; mkdir -p "$D5"
THIN="$(jq -nc '[range(400)|{id:.,name:("row "+(.|tostring)),empty:null,note:("lorem ipsum dolor sit amet "+(.|tostring))}]|tojson')"
in="$(jq -n --argjson r "$THIN" '{tool_name:"mcp__a__x",tool_response:{content:[{type:"text",text:$r}]}}')"
out="$(run_ptu_dbg "$D5" "$in")"
r="$(reason_of "$out")"
assert_contains M12-block    "$out" '"decision":"block"'
assert_contains M12-stub     "$r" "<<fnd-mcp-slim stub>>"
assert_eq       M12-reason   "$(jq -r '.reason' "$D5/$DBGLOG" 2>/dev/null)" "block-cap"
assert_eq       M12-decision "$(jq -r '.decision' "$D5/$DBGLOG" 2>/dev/null)" "stubbed"
assert_eq       M12-delivery "$(jq -r '.delivery' "$D5/$DBGLOG" 2>/dev/null)" "replace"
assert_eq       M12-cap      "$(fits_cap "$r")" yes
sp="$(jq -r '.spill' "$D5/$DBGLOG" 2>/dev/null)"
# THIN is the JSON *encoding* of the payload; jq -r decodes it and terminates the line
tb=$(( $(printf '%s' "$THIN" | jq -r . | wc -c | tr -d ' ') - 1 ))
if [ -f "$sp" ] && [ "$(wc -c < "$sp" | tr -d ' ')" = "$tb" ]; then ok
else bad M12-spill "the block-cap stub must name a spill of the whole original payload ($sp)"; fi
# The abandoned compressed body's own recovery spill is not left behind: the stub names the only file
# the model was given, and this run created the other one.
n=$(ls "$D5" | grep -c '^fnd-mcp-slim-[0-9a-f]*\.json$' || true)
assert_eq M12-one-spill "$n" 1
assert_contains M12-report-reason "$(REPORT "$D5/$DBGLOG")" "block-cap 1"

# M12b: the cap is the child's, not the adapter's — the same result at a cap that fits comes back as a
# compressed body, which is what makes M12 a ceiling and not a shape rule.
D5b="$TMP/mcp-dbg-blockcap-wide"; mkdir -p "$D5b"
out="$(printf '%s' "$in" | env FND_MCP_SLIM_DIR="$D5b" FND_MCP_SLIM_DEBUG=2 \
  node "$PLUG/hooks/mcp-slim.cjs" --delivery=block:200000)"
assert_eq       M12b-fnd      "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.fndDelivery' 2>/dev/null)" "block"
assert_eq       M12b-decision "$(jq -r '.decision' "$D5b/$DBGLOG" 2>/dev/null)" "compressed"
assert_eq       M12b-delivery "$(jq -r '.delivery' "$D5b/$DBGLOG" 2>/dev/null)" "replace"

# M12c: with the stub guard off there is nothing small enough to send — the body is emitted unlabelled,
# the adapter drops it, and the record says `discard`. Never a truncated reason.
D5c="$TMP/mcp-dbg-blockcap-nostub"; mkdir -p "$D5c"
assert_eq M12c-silent   "$(run_ptu_dbg "$D5c" "$in" FND_MCP_SLIM_STUB=0)" ""
assert_eq M12c-decision "$(jq -r '.decision' "$D5c/$DBGLOG" 2>/dev/null)" "compressed"
assert_eq M12c-delivery "$(jq -r '.delivery' "$D5c/$DBGLOG" 2>/dev/null)" "discard"
D5d="$TMP/mcp-dbg-blockcap-nostub-direct"; mkdir -p "$D5d"
out="$(printf '%s' "$in" | env FND_MCP_SLIM_DIR="$D5d" FND_MCP_SLIM_DEBUG=2 FND_MCP_SLIM_STUB=0 \
  node "$PLUG/hooks/mcp-slim.cjs" --delivery=block:4096)"
assert_contains M12d-emitted "$out" "updatedToolOutput"
assert_absent   M12d-no-fnd  "$out" "fndDelivery"
assert_eq       M12d-delivery "$(jq -r '.delivery' "$D5d/$DBGLOG" 2>/dev/null)" "discard"

# M12e: the cap's last exit. Blocks carrying `annotations` cannot be collapsed into one stub, and here
# none of them is over the per-block threshold either, so both stub routes decline and the over-cap body
# is emitted unlabelled — the adapter drops it, the record says `discard`. The spill written for that
# body stays on disk: the emitted marker still names it, which is what the caller's bookkeeping is for.
D5e="$TMP/mcp-dbg-blockcap-decline"; mkdir -p "$D5e"
BLK="$(jq -nc '[range(60)|{id:.,name:("row "+(.|tostring)),empty:null,extra:null,note:("lorem ipsum dolor sit amet "+(.|tostring))}]|tojson')"
in="$(jq -n --argjson b "$BLK" '{tool_name:"mcp__a__x",tool_response:{content:[{type:"text",text:$b,annotations:{audience:["user"]}},{type:"text",text:$b,annotations:{audience:["user"]}},{type:"text",text:$b,annotations:{audience:["user"]}},{type:"text",text:$b,annotations:{audience:["user"]}}]}}')"
out="$(printf '%s' "$in" | env FND_MCP_SLIM_DIR="$D5e" FND_MCP_SLIM_DEBUG=2 \
  node "$PLUG/hooks/mcp-slim.cjs" --delivery=block:4096)"
assert_contains M12e-emitted  "$out" "updatedToolOutput"
assert_absent   M12e-no-fnd   "$out" "fndDelivery"
assert_eq       M12e-decision "$(jq -r '.decision' "$D5e/$DBGLOG" 2>/dev/null)" "compressed"
assert_eq       M12e-delivery "$(jq -r '.delivery' "$D5e/$DBGLOG" 2>/dev/null)" "discard"
sp="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedToolOutput.content[]|.text' 2>/dev/null | grep -o 'full=[^ >]*' | head -1 | sed 's/^full=//')"
if [ -n "$sp" ] && [ -f "$sp" ]; then ok; else bad M12e-spill "the emitted marker names no existing file (sp='$sp')"; fi

# M13: the cap lives in TWO files — the adapter states it on every spawn, the child keeps the same
# number for a bare `block` (a hand run, a sim without the adapter). Nothing else ties them, and every
# case above derives its arithmetic from the ADAPTER's, so retuning one and leaving the other behind
# would stay green while a hand-run child measured itself against a stale ceiling.
assert_eq M13-cap-pair "$(sed -n 's/^const BLOCK_CAP_DEFAULT = \([0-9]*\);$/\1/p' "$PLUG/hooks/mcp-slim.cjs")" "$BLOCK_BYTES"
# M13b: the ceiling is on the WHOLE reason, and the adapter puts a header in front of every one — so
# what it actually hands the child is the ceiling less that header and the join, and a body right at the
# cap comes out as a reason of exactly BLOCK_REASON_BYTES. The header is taken from a real reason (its
# text before the first blank line), so a reworded header moves the expected flag with it.
argv_dir="$TMP/argv"; mkdir -p "$argv_dir"; cp "$SHIMJS" "$argv_dir/codex-mcp-shim.cjs"
printf 'require("fs").writeFileSync(__filename+".flag",process.argv[2]||"");process.stdin.resume();\n' > "$argv_dir/mcp-slim.cjs"
in="$(jq -n --arg t "$WHALE" '{tool_name:"mcp__a__x",tool_response:{content:[{type:"text",text:$t}]}}')"
printf '%s' "$in" | node "$argv_dir/codex-mcp-shim.cjs" >/dev/null 2>&1
hdr="$(reason_of "$(run_ptu "$in")")"; hdr="${hdr%%$'\n\n'*}"
hb=$(printf '%s' "$hdr" | wc -c | tr -d ' ')
if [ "$hb" -gt 100 ] && [ "$hb" -lt 1000 ]; then ok; else bad M13b-header "header of $hb B read off the reason"; fi
assert_eq M13b-body-cap "$(cat "$argv_dir/mcp-slim.cjs.flag" 2>/dev/null)" "--delivery=block:$(( BLOCK_BYTES - hb - 2 ))"

echo "hooks-codex wiring sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  printf '%s' "$failures"
  exit 1
fi
