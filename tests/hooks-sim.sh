#!/usr/bin/env bash
# Simulation harness for the fnd plugin's session-level hooks:
#   S cases — plugin.json SessionStart command: per-file tolerance (one broken
#             md must not discard the rest), FND_LEAN gate, always exit 0, and the
#             real plugin root emitting the json-slim whale-routing instruction
#   G cases — plugin.json UserPromptSubmit gate: FND_CTX_MONITOR semantics
#             (only literal "0" disables), node failure never fails the hook
#   C cases — hooks/context-stats.cjs against transcript fixtures: synthetic
#             (API-error) entries skipped, FND_CTX_WARN=0 honored, >100%
#             window-override hint
#   M cases — plugin.json PostToolUse gate (FND_MCP_SLIM) + hooks/mcp-slim.cjs:
#             big result compressed with a real full= spill, error/small results
#             and unrecognized shapes pass through, node never spawns when disabled;
#             M12–M16 the TTL sweep (stale pruned, fresh/foreign/debug-log kept,
#             FND_MCP_SLIM_TTL=0 + throttle-marker skip); M17–M24 the FND_MCP_SLIM_DEBUG
#             log (one JSONL line per invocation: compressed / size-gate / error-shape /
#             non-json / unrecognized reasons, no file when off, rotation at ~5 MB, plus
#             the M8 non-json format tag + per-project project field); M25–M26 the M9
#             JSONL path (a bulk-operation line stream compresses like an array, `jsonl` stage);
#             M31–M36 the M12 platform-overflow tag (the platform's own overflow notice is logged
#             as reason:"platform-overflow" + the saved whale's path — above the size gate too — a
#             mere quote is not, a big result quoting it is still compressed, and the path probe
#             only scans a 4 KB window after the phrase); M37–M52 the M12b spill-and-stub guard
#             (a whale the pipeline can't shrink is replaced by a ~1 KB stub + byte-exact spill,
#             a weak-gain compression stubs too and writes exactly ONE spill — its own, the
#             compressed body's `full=` spill is never written — and the rails — error shapes at ANY
#             size, blocks carrying anything beyond type/text, overflow notices, sub-threshold,
#             spill failure, FND_MCP_SLIM_STUB=0, threshold parsing — never stub);
#             M53–M56 the M13 jsx stage (a Figma get_design_context result is compacted with a
#             legend header, a resolvable node-id map spill and a `jsx` stage tag, never stubbed;
#             mixed sibling shapes compress without losing copy)
#   P cases — plugin.json UserPromptSubmit gate (FND_PROMPT_JSON) + hooks/
#             prompt-json-guard.cjs: a big prompt carrying a big JSON blob is blocked
#             with the blob spilled byte-exact, below-gate / no-json / small prompts
#             pass through, string-aware + conservative extraction, workspace placement,
#             spill-failure never blocks, node never spawns when disabled
#   T cases — hooks/subagent-conventions.sh: code-writing / unknown agents get the
#             conventions, read-only readers AND jira-writer are skipped, FND_LEAN=0
#             drops lean-code, the hook always exits 0
# Commands under test are extracted from plugin.json, not duplicated here.
# Exit 0 = all green.
set -u

# Hermetic env: an exported FND_MCP_SLIM_DEBUG / FND_MCP_SLIM_DIR (a developer watching the log live)
# must not leak into the cases — the debug ones set both switches on the invocation themselves, and
# the rest would otherwise append fixture noise to the developer's real log.
unset FND_MCP_SLIM_DEBUG FND_MCP_SLIM_DIR

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/plugins/fnd/.claude-plugin/plugin.json"
CTX="$ROOT/plugins/fnd/hooks/context-stats.cjs"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0; failures=""
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); failures="${failures}  [$1] $2
"; }
assert_contains() { case "$2" in *"$3"*) ok ;; *) bad "$1" "missing: $3" ;; esac; }
assert_absent()   { case "$2" in *"$3"*) bad "$1" "unexpected: $3" ;; *) ok ;; esac; }
assert_eq()       { if [ "$2" = "$3" ]; then ok; else bad "$1" "got '$2', want '$3'"; fi; }

# ═══ S — SessionStart per-file tolerance + store-access gating ══════════════
SS_CMD="$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$MANIFEST")"
fake="$TMP/plugroot"; mkdir -p "$fake/hooks"
for f in comment-discipline plugin-feedback store-access task-workspace lean-code mcp-whale; do
  echo "MARK-$f" > "$fake/hooks/$f.md"
done
# store-access is gated on store files in the cwd — run each case from a controlled dir
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

out="$(cd "$SS_STORE" && CLAUDE_PLUGIN_ROOT="$fake" FND_LEAN=0 bash -c "$SS_CMD" 2>/dev/null)"; ec=$?
assert_eq S3-lean-off-exit "$ec" 0
assert_absent S3-no-lean "$out" "MARK-lean-code"

# S4: no store files in the cwd → store-access.md is NOT injected, the rest is
out="$(cd "$SS_PLAIN" && CLAUDE_PLUGIN_ROOT="$fake" bash -c "$SS_CMD" 2>/dev/null)"; ec=$?
assert_eq S4-no-store-exit "$ec" 0
assert_absent S4-no-store-access "$out" "MARK-store-access"
for f in comment-discipline task-workspace lean-code mcp-whale; do
  assert_contains "S4-$f" "$out" "MARK-$f"
done

# S5: a .env alone is enough to inject store-access.md
out="$(cd "$SS_ENV" && CLAUDE_PLUGIN_ROOT="$fake" bash -c "$SS_CMD" 2>/dev/null)"; ec=$?
assert_eq S5-env-exit "$ec" 0
assert_contains S5-env-store-access "$out" "MARK-store-access"

# S6: the REAL plugin root emits the deterministic json-slim whale-routing instruction
realroot="$ROOT/plugins/fnd"
out="$(cd "$SS_PLAIN" && CLAUDE_PLUGIN_ROOT="$realroot" bash -c "$SS_CMD" 2>/dev/null)"; ec=$?
assert_eq       S6-real-root-exit  "$ec" 0
assert_contains S6-whale-conv      "$out" "oversized MCP results"
assert_contains S6-whale-json-slim "$out" "json-slim.cjs"

# ═══ G — UserPromptSubmit FND_CTX_MONITOR gate ══════════════════════════════
UPS_CMD="$(jq -r '.hooks.UserPromptSubmit[0].hooks[0].command' "$MANIFEST")"
shim="$TMP/shim"; mkdir -p "$shim"
cat > "$shim/node" <<'SH'
#!/usr/bin/env bash
echo run >> "$NODE_LOG"
exit "${NODE_EC:-0}"
SH
chmod +x "$shim/node"

run_gate() { # [VAR=val…] — extra env for the gate command
  : > "$TMP/node.log"
  env "$@" NODE_LOG="$TMP/node.log" PATH="$shim:$PATH" CLAUDE_PLUGIN_ROOT="$fake" \
    bash -c "$UPS_CMD" >/dev/null 2>&1
}

run_gate FND_CTX_MONITOR=0; ec=$?
assert_eq G1-off-exit "$ec" 0
if [ -s "$TMP/node.log" ]; then bad G1-off "node ran with FND_CTX_MONITOR=0"; else ok; fi

run_gate; ec=$?
assert_eq G2-default-exit "$ec" 0
if [ -s "$TMP/node.log" ]; then ok; else bad G2-default "node did not run by default"; fi

run_gate FND_CTX_MONITOR=1
if [ -s "$TMP/node.log" ]; then ok; else bad G3-one "node did not run with FND_CTX_MONITOR=1"; fi

# Docs say "0 disables" — any other value must keep the monitor on.
run_gate FND_CTX_MONITOR=true
if [ -s "$TMP/node.log" ]; then ok; else bad G4-true "node did not run with FND_CTX_MONITOR=true"; fi

run_gate FND_CTX_MONITOR=2
if [ -s "$TMP/node.log" ]; then ok; else bad G5-two "node did not run with FND_CTX_MONITOR=2"; fi

run_gate NODE_EC=1; ec=$?
assert_eq G6-node-failure-exit "$ec" 0

# ═══ C — context-stats.cjs transcript fixtures ══════════════════════════════
REAL='{"message":{"model":"claude-fable-5","usage":{"input_tokens":50000,"cache_read_input_tokens":100000,"output_tokens":1000}},"isSidechain":false}'
SYN='{"message":{"model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0}},"isSidechain":false}'
BIG='{"message":{"model":"claude-haiku-4-5-20251001","usage":{"input_tokens":450000,"cache_read_input_tokens":50000,"output_tokens":0}},"isSidechain":false}'

run_ctx() { # transcript-file session-id [VAR=val…] — unique sid per case: the band
  local t="$1" sid="$2"; shift 2   # state file persists in tmpdir across sim runs
  printf '{"transcript_path":"%s","session_id":"%s","effort":{"level":"high"}}' "$t" "$sid" \
    | env "$@" node "$CTX" 2>/dev/null
}

printf '%s\n' "$REAL" > "$TMP/t0.jsonl"
out="$(run_ctx "$TMP/t0.jsonl" "c0-$$")"
assert_contains C0-usage  "$out" "151.0k/1M (15%)"
assert_contains C0-model  "$out" "claude-fable-5"
assert_contains C0-effort "$out" "effort high"

# API-error tail: usage must come from the real entry, not the synthetic zero.
printf '%s\n' "$REAL" "$SYN" > "$TMP/t1.jsonl"
out="$(run_ctx "$TMP/t1.jsonl" "c1-$$")"
assert_contains C1-real-usage "$out" "151.0k"
assert_absent   C1-not-zero   "$out" "0.0k"

out="$(run_ctx "$TMP/t0.jsonl" "c2-$$" FND_CTX_WARN=0)"
assert_contains C2-warn0-cta "$out" "/compact"
assert_contains C2-warn0-ctx "$out" "additionalContext"

out="$(run_ctx "$TMP/t0.jsonl" "c3-$$" FND_CTX_WARN=abc)"
assert_absent C3-warn-nan "$out" "/compact"

# 200k guess on a 1M session → impossible pct → override hint.
printf '%s\n' "$BIG" > "$TMP/t2.jsonl"
out="$(run_ctx "$TMP/t2.jsonl" "c4-$$")"
assert_contains C4-over100 "$out" "500.0k/200k (250%)"
assert_contains C4-hint    "$out" "FND_CTX_WINDOW"

out="$(run_ctx "$TMP/t2.jsonl" "c5-$$" FND_CTX_WINDOW=1000000)"
assert_contains C5-override "$out" "500.0k/1M (50%)"
assert_absent   C5-no-hint  "$out" "FND_CTX_WINDOW"

# ── band transitions (2026-07 token audit): additionalContext only on change ──
# C6: same band twice — the CTA stays on every prompt, the context flag fires once
out="$(run_ctx "$TMP/t0.jsonl" "c6-$$" FND_CTX_WARN=10)"
assert_contains C6-first-ctx "$out" "additionalContext"
out="$(run_ctx "$TMP/t0.jsonl" "c6-$$" FND_CTX_WARN=10)"
assert_contains C6-second-cta "$out" "/compact"
assert_absent   C6-second-no-ctx "$out" "additionalContext"

# C7: band escalation (warn → crit) re-emits the flag in the same session — with a
# silent same-band prompt in between, so the case fails if emission is unconditional
out="$(run_ctx "$TMP/t0.jsonl" "c7-$$" FND_CTX_WARN=10)"
assert_contains C7-warn-ctx "$out" "additionalContext"
out="$(run_ctx "$TMP/t0.jsonl" "c7-$$" FND_CTX_WARN=10)"
assert_absent   C7-same-band-silent "$out" "additionalContext"
out="$(run_ctx "$TMP/t2.jsonl" "c7-$$" FND_CTX_WARN=10)"
assert_contains C7-crit-ctx "$out" "additionalContext"

# C8: dropping back under the threshold emits nothing; re-entering warn re-emits
out="$(run_ctx "$TMP/t0.jsonl" "c8-$$" FND_CTX_WARN=10)"
assert_contains C8-enter-ctx "$out" "additionalContext"
out="$(run_ctx "$TMP/t0.jsonl" "c8-$$" FND_CTX_WARN=90)"
assert_absent   C8-ok-no-ctx "$out" "additionalContext"
out="$(run_ctx "$TMP/t0.jsonl" "c8-$$" FND_CTX_WARN=10)"
assert_contains C8-reenter-ctx "$out" "additionalContext"

# C9: WARN_AT inside the 75/90 tiers — a sub-threshold prompt must stay band 0 (not
# pre-record band 2 and swallow the warn-entry emission when the threshold is crossed)
MID='{"message":{"model":"claude-haiku-4-5-20251001","usage":{"input_tokens":154000,"output_tokens":0}},"isSidechain":false}'
HI='{"message":{"model":"claude-haiku-4-5-20251001","usage":{"input_tokens":170000,"output_tokens":0}},"isSidechain":false}'
printf '%s\n' "$MID" > "$TMP/t3.jsonl"
printf '%s\n' "$HI"  > "$TMP/t4.jsonl"
out="$(run_ctx "$TMP/t3.jsonl" "c9-$$" FND_CTX_WARN=80)"   # 77% < 80 → silent
assert_absent   C9-below-warn "$out" "additionalContext"
out="$(run_ctx "$TMP/t4.jsonl" "c9-$$" FND_CTX_WARN=80)"   # 85% ≥ 80 → warn entry emits
assert_contains C9-warn-entry "$out" "additionalContext"

# ═══ M — PostToolUse mcp-slim (result compressor) ═══════════════════════════
# Gate (FND_MCP_SLIM) tested via the extracted plugin.json command + node shim;
# hook behavior tested by invoking mcp-slim.cjs directly on PostToolUse-shaped input.
SLIM="$ROOT/plugins/fnd/hooks/mcp-slim.cjs"
FIX="$ROOT/tests/fixtures"
JIRA="$FIX/jira-issue-ELC-104.json"
PTU_CMD="$(jq -r '.hooks.PostToolUse[0].hooks[0].command' "$MANIFEST")"
MSD="$TMP/slim-spill"; mkdir -p "$MSD"
# M1–M36 exercise the COMPRESSOR, so the M12b spill-and-stub guard is pinned off for them: the Jira
# fixture is 260 KB and still ~58 KB after a 77 % cut, i.e. over the guard's 32 KB threshold — a size
# no real MCP result reaches (the platform spills anything past ~25k tokens before this hook runs).
# The guard's own cases (M37–M52) clear the switch again with `env -u`, so the DEFAULT is under test.
export FND_MCP_SLIM_STUB=0

run_slim() { # input-json [VAR=val…] — pipe input to the hook, echo its stdout
  local in="$1"; shift
  printf '%s' "$in" | env FND_MCP_SLIM_DIR="$MSD" "$@" node "$SLIM" 2>/dev/null
}

# M1: big MCP result (content-array shape) → updatedToolOutput + a full= spill that exists
in="$(jq -n --rawfile t "$JIRA" \
  '{tool_name:"mcp__plugin_fnd_atlassian__getJiraIssue",tool_response:{content:[{type:"text",text:$t}]}}')"
out="$(run_slim "$in")"
assert_contains M1-updated   "$out" "updatedToolOutput"
assert_contains M1-hookevent "$out" "PostToolUse"
text="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedToolOutput.content[0].text' 2>/dev/null)"
p="$(printf '%s' "$text" | grep -o 'full=[^ >]*' | head -1 | sed 's/^full=//')"
if [ -n "$p" ] && [ -f "$p" ]; then ok; else bad M1-fullfile "no existing full= file (p='$p')"; fi
inb=$(printf '%s' "$in" | wc -c); outb=$(printf '%s' "$out" | wc -c)
if [ "$outb" -lt "$inb" ]; then ok; else bad M1-smaller "output $outb not < input $inb"; fi

# M2: MCP error result (isError:true) → untouched, even when big
in="$(jq -n --rawfile t "$JIRA" \
  '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}],isError:true}}')"
assert_eq M2-iserror-passthrough "$(run_slim "$in")" ""

# M3: error envelope in the text (errors:[…]) → untouched (write-gating reads it verbatim)
err="$(jq -cn '{errors:[{message:"boom"}],filler:[range(0;600)|{id:.,note:"padding-padding-padding"}]}')"
in="$(jq -n --arg t "$err" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}]}}')"
assert_eq M3-errenvelope-passthrough "$(run_slim "$in")" ""

# M4: small result (≤ 4 KB gate) → untouched
in='{"tool_name":"mcp__x__y","tool_response":{"content":[{"type":"text","text":"{\"a\":1,\"b\":2}"}]}}'
assert_eq M4-small-passthrough "$(run_slim "$in")" ""

# M5: transform crash / non-JSON → passthrough (outer try, then slim's parse guard)
assert_eq M5a-malformed-input "$(run_slim 'not json at all')" ""
bignon="$(printf 'x%.0s' $(seq 1 5000))"   # 5000 non-JSON chars, over the size gate
in="$(jq -n --arg t "$bignon" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}]}}')"
assert_eq M5b-big-nonjson "$(run_slim "$in")" ""

# M6: FND_MCP_SLIM gate — 0 means node never spawns; unset means it runs ($shim/$fake from G/S)
run_ptu_gate() { : > "$TMP/node.log"; env "$@" NODE_LOG="$TMP/node.log" PATH="$shim:$PATH" \
  CLAUDE_PLUGIN_ROOT="$fake" bash -c "$PTU_CMD" >/dev/null 2>&1; }
run_ptu_gate FND_MCP_SLIM=0; ec=$?
assert_eq M6-off-exit "$ec" 0
if [ -s "$TMP/node.log" ]; then bad M6-off "node ran with FND_MCP_SLIM=0"; else ok; fi
run_ptu_gate; ec=$?
assert_eq M6-default-exit "$ec" 0
if [ -s "$TMP/node.log" ]; then ok; else bad M6-default "node did not run by default"; fi

# M7: raw-string result shape → compressed string (mirrors input shape, carries full=)
in="$(jq -n --rawfile t "$JIRA" '{tool_name:"mcp__x__y",tool_response:$t}')"
out="$(run_slim "$in")"
assert_contains M7-rawstring-updated "$out" "updatedToolOutput"
assert_contains M7-rawstring-full    "$out" "full="

# M8: docs-variant input field name (tool_output) is honored like tool_response
in="$(jq -n --rawfile t "$JIRA" '{tool_name:"mcp__x__y",tool_output:{content:[{type:"text",text:$t}]}}')"
assert_contains M8-tooloutput-updated "$(run_slim "$in")" "updatedToolOutput"

# M9: unrecognized result shape (object, no text/content) → passthrough (scope boundary)
in="$(jq -cn '{tool_name:"mcp__x__y",tool_response:{stuff:[range(0;600)|{id:.,v:"padpadpadpad"}]}}')"
assert_eq M9-unrecognized-passthrough "$(run_slim "$in")" ""

# M10: mixed content [compressible, TRAILING error envelope] — the recovery handle rides
# the compressed block; the verbatim error block stays byte-identical & JSON-parseable
comp="$(jq -cn '{rows:[range(0;600)|{id:.,note:"padding-padding-padding"}]}')"
errb='{"errors":[{"message":"insufficient permissions"}]}'
in="$(jq -n --arg c "$comp" --arg e "$errb" \
  '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$c},{type:"text",text:$e}]}}')"
out="$(run_slim "$in")"
assert_contains M10-updated "$out" "updatedToolOutput"
b0="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedToolOutput.content[0].text' 2>/dev/null)"
b1="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedToolOutput.content[1].text' 2>/dev/null)"
assert_contains M10-marker-on-block0 "$b0" "full="
assert_eq       M10-errblock-verbatim "$b1" "$errb"
if printf '%s' "$b1" | jq -e . >/dev/null 2>&1; then ok; else bad M10-errblock-json "error block no longer parses"; fi

# M11: large multibyte payload survives stdin chunking — no U+FFFD in the emitted result
# OR the recovery spill (regression for per-Buffer-chunk decoding across a read boundary)
node -e '
  const rows = Array.from({length:4000},(_,i)=>({id:i,note:"がぎぐげご漢字テスト日本語サンプル",emoji:"🍣🎏🍜"}));
  const tr = {content:[{type:"text",text:JSON.stringify({items:rows})}]};
  process.stdout.write(JSON.stringify({tool_name:"mcp__x__y",tool_response:tr}));
' > "$TMP/utf8-in.json"
out="$(FND_MCP_SLIM_DIR="$MSD" node "$SLIM" < "$TMP/utf8-in.json" 2>/dev/null)"
assert_contains M11-updated "$out" "updatedToolOutput"
if printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.exit(/�/.test(s)?1:0))'; then ok; else bad M11-no-fffd-out "U+FFFD in emitted result"; fi
sp="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedToolOutput.content[0].text' 2>/dev/null | grep -o 'full=[^ >]*' | head -1 | sed 's/^full=//')"
if [ -n "$sp" ] && node -e 'const fs=require("fs");process.exit(/�/.test(fs.readFileSync(process.argv[1],"utf8"))?1:0)' "$sp"; then ok; else bad M11-no-fffd-spill "U+FFFD in recovery spill (sp='$sp')"; fi

# ── M12–M16: spill-file hygiene (TTL sweep, M5) ──────────────────────────────
# The hook calls sweepSpills() AFTER emitting; a dedicated spill dir per scenario keeps the
# throttle-marker state controlled (M1–M11's $MSD already carries a fresh marker). `touch -t`
# ages a seeded spill past the 24 h TTL. `msin` = the M1 content-array input for a real spill.
msin="$(jq -n --rawfile t "$JIRA" \
  '{tool_name:"mcp__plugin_fnd_atlassian__getJiraIssue",tool_response:{content:[{type:"text",text:$t}]}}')"
sweep_body() { printf '%s' "$1" | jq -r '.hookSpecificOutput.updatedToolOutput.content[0].text' 2>/dev/null | sed 's/<<full=[^>]*>>//g'; }

# M12: a hook run seeds its own FRESH spill and sweeps a pre-seeded STALE one — stale gone,
# fresh kept, the hook's own new spill present, and the emitted body identical to a TTL=0 run.
SWD="$TMP/sweep-m12"; mkdir -p "$SWD"
stale="$SWD/fnd-crush-STALE.json"; : > "$stale"; touch -t 200001010000 "$stale"
fresh="$SWD/fnd-mcp-slim-FRESH.json"; : > "$fresh"   # mtime now → must survive
outS="$(printf '%s' "$msin" | env FND_MCP_SLIM_DIR="$SWD" node "$SLIM" 2>/dev/null)"
if [ ! -f "$stale" ]; then ok; else bad M12-stale-swept "stale spill survived the sweep"; fi
if [ -f "$fresh" ]; then ok; else bad M12-fresh-kept "fresh spill was swept"; fi
np="$(printf '%s' "$outS" | jq -r '.hookSpecificOutput.updatedToolOutput.content[0].text' 2>/dev/null | grep -o 'full=[^ >]*' | tail -1 | sed 's/^full=//')"
if [ -n "$np" ] && [ -f "$np" ]; then ok; else bad M12-newspill "hook's own spill missing (np='$np')"; fi
SWD0="$TMP/sweep-m12-nosweep"; mkdir -p "$SWD0"
outN="$(printf '%s' "$msin" | env FND_MCP_SLIM_DIR="$SWD0" FND_MCP_SLIM_TTL=0 node "$SLIM" 2>/dev/null)"
assert_eq M12-body-identical "$(sweep_body "$outS")" "$(sweep_body "$outN")"

# M13: FND_MCP_SLIM_TTL=0 disables the sweep → a stale spill survives
SWD="$TMP/sweep-m13"; mkdir -p "$SWD"
stale="$SWD/fnd-mcp-slim-STALE.json"; : > "$stale"; touch -t 200001010000 "$stale"
printf '%s' "$msin" | env FND_MCP_SLIM_DIR="$SWD" FND_MCP_SLIM_TTL=0 node "$SLIM" >/dev/null 2>&1
if [ -f "$stale" ]; then ok; else bad M13-ttl0-keeps-stale "TTL=0 still swept a stale spill"; fi

# M14: a stale FOREIGN-named file (not our prefix) survives; our stale one is swept
SWD="$TMP/sweep-m14"; mkdir -p "$SWD"
foreign="$SWD/other-tool-STALE.json"; : > "$foreign"; touch -t 200001010000 "$foreign"
ourstale="$SWD/fnd-crush-STALE.json"; : > "$ourstale"; touch -t 200001010000 "$ourstale"
printf '%s' "$msin" | env FND_MCP_SLIM_DIR="$SWD" node "$SLIM" >/dev/null 2>&1
if [ -f "$foreign" ]; then ok; else bad M14-foreign-kept "sweep deleted a foreign-named file"; fi
if [ ! -f "$ourstale" ]; then ok; else bad M14-ours-swept "sweep missed our stale file"; fi

# M15: throttle — run 1 leaves a fresh marker; a stale spill seeded AFTER it survives run 2
SWD="$TMP/sweep-m15"; mkdir -p "$SWD"
printf '%s' "$msin" | env FND_MCP_SLIM_DIR="$SWD" node "$SLIM" >/dev/null 2>&1
if [ -f "$SWD/.fnd-mcp-slim-sweep" ]; then ok; else bad M15-marker "run 1 did not create the sweep marker"; fi
stale="$SWD/fnd-crush-STALE.json"; : > "$stale"; touch -t 200001010000 "$stale"
printf '%s' "$msin" | env FND_MCP_SLIM_DIR="$SWD" node "$SLIM" >/dev/null 2>&1
if [ -f "$stale" ]; then ok; else bad M15-throttled "throttle failed: stale swept despite a fresh marker"; fi

# M16: the M6 debug log + its rotation are excluded by exact name even when stale (a real spill
# alongside them is still swept, proving the exclusion is name-based, not a blanket skip)
SWD="$TMP/sweep-m16"; mkdir -p "$SWD"
dbg="$SWD/fnd-mcp-slim-debug.log"; : > "$dbg"; touch -t 200001010000 "$dbg"
dbg1="$SWD/fnd-mcp-slim-debug.log.1"; : > "$dbg1"; touch -t 200001010000 "$dbg1"
stale="$SWD/fnd-mcp-slim-STALE.json"; : > "$stale"; touch -t 200001010000 "$stale"
printf '%s' "$msin" | env FND_MCP_SLIM_DIR="$SWD" node "$SLIM" >/dev/null 2>&1
if [ -f "$dbg" ] && [ -f "$dbg1" ]; then ok; else bad M16-debug-kept "sweep deleted the debug log"; fi
if [ ! -f "$stale" ]; then ok; else bad M16-stale-swept "sweep missed a stale spill next to the debug log"; fi

# ── M17–M24: FND_MCP_SLIM_DEBUG log (M6, + M8 format/project) ─────────────────
# One JSONL metadata line per invocation → <FND_MCP_SLIM_DIR>/fnd-mcp-slim-debug.log; opt-in, never
# any payload content. Each case uses a dedicated dir so the single line is unambiguous.
DBGLOG="fnd-mcp-slim-debug.log"
run_dbg() { printf '%s' "$2" | env FND_MCP_SLIM_DIR="$1" FND_MCP_SLIM_DEBUG=1 node "$SLIM" 2>/dev/null; }

# M17: DEBUG on + big result → exactly one line, decision compressed, sane bytes/pct, spill exists,
# AND the emitted body is byte-identical to a DEBUG-off run (logging never alters the result).
DBG="$TMP/dbg-m17"; mkdir -p "$DBG"
outD="$(run_dbg "$DBG" "$msin")"; LOG="$DBG/$DBGLOG"
assert_eq M17-one-line  "$(wc -l < "$LOG" 2>/dev/null | tr -d ' ')" 1
assert_eq M17-entry     "$(jq -r '.entry'    "$LOG" 2>/dev/null)" "hook"
assert_eq M17-decision  "$(jq -r '.decision' "$LOG" 2>/dev/null)" "compressed"
bi="$(jq -r '.bytes_in' "$LOG" 2>/dev/null)"; bo="$(jq -r '.bytes_out' "$LOG" 2>/dev/null)"
if [ "$bo" -lt "$bi" ]; then ok; else bad M17-bytes "bytes_out $bo not < bytes_in $bi"; fi
if jq -e '.pct > 0' "$LOG" >/dev/null 2>&1; then ok; else bad M17-pct "pct not > 0"; fi
sp="$(jq -r '.spill' "$LOG" 2>/dev/null)"
if [ -n "$sp" ] && [ -f "$sp" ]; then ok; else bad M17-spill "spill file missing (sp='$sp')"; fi
DBG0="$TMP/dbg-m17-off"; mkdir -p "$DBG0"
outN="$(printf '%s' "$msin" | env -u FND_MCP_SLIM_DEBUG FND_MCP_SLIM_DIR="$DBG0" node "$SLIM" 2>/dev/null)"
assert_eq M17-body-identical "$(sweep_body "$outD")" "$(sweep_body "$outN")"

# M18: MCP error result (isError:true) → passthrough logged as error-shape (still no stdout)
DBG="$TMP/dbg-m18"; mkdir -p "$DBG"
in="$(jq -n --rawfile t "$JIRA" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}],isError:true}}')"
assert_eq M18-passthrough "$(run_dbg "$DBG" "$in")" ""
assert_eq M18-decision "$(jq -r '.decision' "$DBG/$DBGLOG" 2>/dev/null)" "passthrough"
assert_eq M18-reason   "$(jq -r '.reason'   "$DBG/$DBGLOG" 2>/dev/null)" "error-shape"

# M19: small result → passthrough logged as size-gate
DBG="$TMP/dbg-m19"; mkdir -p "$DBG"
run_dbg "$DBG" '{"tool_name":"mcp__x__y","tool_response":{"content":[{"type":"text","text":"{\"a\":1,\"b\":2}"}]}}' >/dev/null
assert_eq M19-reason "$(jq -r '.reason' "$DBG/$DBGLOG" 2>/dev/null)" "size-gate"

# M20: DEBUG unset → no log file created at all (zero side effects).
# env -u clears any ambient FND_MCP_SLIM_DEBUG (a developer may export it to observe the log live).
DBG="$TMP/dbg-m20"; mkdir -p "$DBG"
printf '%s' "$msin" | env -u FND_MCP_SLIM_DEBUG FND_MCP_SLIM_DIR="$DBG" node "$SLIM" >/dev/null 2>&1
if [ ! -f "$DBG/$DBGLOG" ]; then ok; else bad M20-no-log "debug log written with FND_MCP_SLIM_DEBUG unset"; fi

# M21: rotation — a >5 MB log is renamed to .log.1 before the fresh line lands in a new .log
DBG="$TMP/dbg-m21"; mkdir -p "$DBG"
dd if=/dev/zero of="$DBG/$DBGLOG" bs=1024 count=5121 >/dev/null 2>&1   # ~5.001 MB, over the cap
run_dbg "$DBG" "$msin" >/dev/null
if [ -f "$DBG/$DBGLOG.1" ]; then ok; else bad M21-rotated "log > 5 MB not rotated to .log.1"; fi
assert_eq M21-fresh-line "$(wc -l < "$DBG/$DBGLOG" 2>/dev/null | tr -d ' ')" 1

# M22: big non-JSON text → passthrough logged as non-json, format:"text" (M8) + a project tag
DBG="$TMP/dbg-m22"; mkdir -p "$DBG"
bignon="$(printf 'x%.0s' $(seq 1 5000))"
in="$(jq -n --arg t "$bignon" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}]}}')"
run_dbg "$DBG" "$in" >/dev/null
assert_eq M22-reason "$(jq -r '.reason' "$DBG/$DBGLOG" 2>/dev/null)" "non-json"
assert_eq M22-format "$(jq -r '.format' "$DBG/$DBGLOG" 2>/dev/null)" "text"
m22proj="$(jq -r '.project' "$DBG/$DBGLOG" 2>/dev/null)"
if [ -n "$m22proj" ] && [ "$m22proj" != "null" ]; then ok; else bad M22-project "project tag missing on debug line"; fi

# M23: unrecognized object shape (no text/content) → passthrough logged as unrecognized-shape
DBG="$TMP/dbg-m23"; mkdir -p "$DBG"
in="$(jq -cn '{tool_name:"mcp__x__y",tool_response:{stuff:[range(0;600)|{id:.,v:"padpadpadpad"}]}}')"
run_dbg "$DBG" "$in" >/dev/null
assert_eq M23-reason "$(jq -r '.reason' "$DBG/$DBGLOG" 2>/dev/null)" "unrecognized-shape"

# M24 (M8): big non-JSON XML body → format:"xml", and the emitted stdout stays byte-identical to a
# DEBUG-off run (the format sniff is metadata only — it never alters the passthrough).
DBG="$TMP/dbg-m24"; mkdir -p "$DBG"
xmlbody="<frame id=\"1\">$(printf '<node x="1"/>%.0s' $(seq 1 400))</frame>"
in="$(jq -n --arg t "$xmlbody" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}]}}')"
outD="$(run_dbg "$DBG" "$in")"
assert_eq M24-reason "$(jq -r '.reason' "$DBG/$DBGLOG" 2>/dev/null)" "non-json"
assert_eq M24-format "$(jq -r '.format' "$DBG/$DBGLOG" 2>/dev/null)" "xml"
DBG0="$TMP/dbg-m24-off"; mkdir -p "$DBG0"
outN="$(printf '%s' "$in" | env -u FND_MCP_SLIM_DEBUG FND_MCP_SLIM_DIR="$DBG0" node "$SLIM" 2>/dev/null)"
assert_eq M24-body-identical "$outD" "$outN"

# ── M25–M26: JSONL detection (M9) ─────────────────────────────────────────────
# A tool result whose text is a JSONL line stream (bulk-operation dump) is a same-shape array; the
# hook must crush it like any other (updatedToolOutput + a full= recovery spill) and — with DEBUG
# on — record the `jsonl` stage. The block is generated in-test (no committed 468 KB fixture).
JLB="$(node -e '
  const rows=Array.from({length:400},(_,i)=>JSON.stringify({id:`gid://shopify/Product/${1000+i}`,status:"ACTIVE",vendor:"MAC",productType:"Lipstick",publishedAt:"2024-01-01"}));
  process.stdout.write(rows.join("\n"));
')"
in="$(jq -n --arg t "$JLB" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}]}}')"

# M25: a >4 KB JSONL text block → updatedToolOutput carrying a full= spill that exists on disk
out="$(run_slim "$in")"
assert_contains M25-updated "$out" "updatedToolOutput"
text="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedToolOutput.content[0].text' 2>/dev/null)"
p="$(printf '%s' "$text" | grep -o 'full=[^ >]*' | head -1 | sed 's/^full=//')"
if [ -n "$p" ] && [ -f "$p" ]; then ok; else bad M25-fullfile "no existing full= file (p='$p')"; fi

# M26: DEBUG on → the emitted line is `compressed` and its stages include `jsonl`
DBG="$TMP/dbg-m26"; mkdir -p "$DBG"
run_dbg "$DBG" "$in" >/dev/null
assert_eq M26-decision "$(jq -r '.decision' "$DBG/$DBGLOG" 2>/dev/null)" "compressed"
if jq -e '.stages | index("jsonl")' "$DBG/$DBGLOG" >/dev/null 2>&1; then ok; else bad M26-jsonl-stage "stages=$(jq -c '.stages' "$DBG/$DBGLOG" 2>/dev/null)"; fi

# ── M27–M28: log/build-output text (M10) ──────────────────────────────────────
# A tool result whose text is log-shaped (console WARN spam + errors + a JS stack trace) is
# signal-selected, not JSON — the hook must compress it like any other lossy stage (updatedToolOutput
# + a full= recovery spill) and, with DEBUG on, record the `log` stage. Generated in-test.
LGB="$(node -e '
  const l=[];
  for(let i=0;i<300;i++) l.push("[WARN] frame budget exceeded: draw call skipped for layer=overlay");
  l.push("[ERROR] renderer: device removed reason=hung");
  l.push("TypeError: Cannot read properties of undefined (reading \"gl\")");
  l.push("    at Renderer.draw (/app/src/render.js:42:15)");
  process.stdout.write(l.join("\n"));
')"
in="$(jq -n --arg t "$LGB" '{tool_name:"mcp__pw__console",tool_response:{content:[{type:"text",text:$t}]}}')"

# M27: a >4 KB log text block → updatedToolOutput carrying a full= spill that exists on disk, with the
# looping warning deduped ×N and the ERROR/stack-head kept.
out="$(run_slim "$in")"
assert_contains M27-updated "$out" "updatedToolOutput"
text="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedToolOutput.content[0].text' 2>/dev/null)"
p="$(printf '%s' "$text" | grep -o 'full=[^ >]*' | head -1 | sed 's/^full=//')"
if [ -n "$p" ] && [ -f "$p" ]; then ok; else bad M27-fullfile "no existing full= file (p='$p')"; fi
assert_contains M27-xN "$text" "×300"
assert_contains M27-error-kept "$text" "[ERROR] renderer"

# M28: DEBUG on → the emitted line is `compressed` and its stages include `log`
DBG="$TMP/dbg-m28"; mkdir -p "$DBG"
run_dbg "$DBG" "$in" >/dev/null
assert_eq M28-decision "$(jq -r '.decision' "$DBG/$DBGLOG" 2>/dev/null)" "compressed"
if jq -e '.stages | index("log")' "$DBG/$DBGLOG" >/dev/null 2>&1; then ok; else bad M28-log-stage "stages=$(jq -c '.stages' "$DBG/$DBGLOG" 2>/dev/null)"; fi

# ── M29–M30: fenced-payload unwrap (M11) ─────────────────────────────────────
# A tool result whose text is a DOMINANT markdown fence (prose preamble + ```json\n<payload>\n```,
# e.g. chrome-devtools evaluate_script) hides a compressible body from the whole pipeline. The hook
# must unwrap it, crush the body, and keep the preamble on top — updatedToolOutput + a full= recovery
# spill (the whole ORIGINAL wrapper) — and, with DEBUG on, record the `fence` stage. Generated in-test.
FJB="$(node -e '
  const obj={products:Array.from({length:600},(_,i)=>({id:i,note:"padding-padding-padding-padding"}))};
  process.stdout.write("Script ran on page and returned:\n```json\n"+JSON.stringify(obj)+"\n```");
')"
in="$(jq -n --arg t "$FJB" '{tool_name:"mcp__plugin_fnd_chrome-devtools-mcp__evaluate_script",tool_response:{content:[{type:"text",text:$t}]}}')"

# M29: a >4 KB fenced-JSON tool result → updatedToolOutput carrying a full= spill that exists on disk,
# and the emitted body keeps the prose preamble on top (still reads as what the tool said).
out="$(run_slim "$in")"
assert_contains M29-updated "$out" "updatedToolOutput"
text="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedToolOutput.content[0].text' 2>/dev/null)"
p="$(printf '%s' "$text" | grep -o 'full=[^ >]*' | head -1 | sed 's/^full=//')"
if [ -n "$p" ] && [ -f "$p" ]; then ok; else bad M29-fullfile "no existing full= file (p='$p')"; fi
if printf '%s' "$text" | head -1 | grep -Fq "Script ran on page and returned:"; then ok; else bad M29-preamble "preamble not kept on top: $(printf '%s' "$text" | head -c 60)"; fi

# M30: DEBUG on → the emitted line is `compressed` and its stages include `fence`
DBG="$TMP/dbg-m30"; mkdir -p "$DBG"
run_dbg "$DBG" "$in" >/dev/null
assert_eq M30-decision "$(jq -r '.decision' "$DBG/$DBGLOG" 2>/dev/null)" "compressed"
if jq -e '.stages | index("fence")' "$DBG/$DBGLOG" >/dev/null 2>&1; then ok; else bad M30-fence-stage "stages=$(jq -c '.stages' "$DBG/$DBGLOG" 2>/dev/null)"; fi

# ── M31–M36: platform-overflow tagging (M12) ─────────────────────────────────
# A result over MAX_MCP_OUTPUT_TOKENS never reaches this hook: the platform saves it to a
# `tool-results/` file and swaps in a short notice, which used to be logged as a plain `size-gate`
# passthrough (live 2026-07-24: bytes_in 1463 — the notice, not the 764 KB whale). The hook must now
# tag that notice `platform-overflow` and record the saved whale's path in `spill`, so `--report` can
# pair it with a later json-slim run. Still a passthrough — nothing here is compressible.
OVFP="/Users/dev/.claude/projects/p/sess/tool-results/mcp-plugin_fnd_chrome-devtools-mcp-evaluate_script-1784908372707.txt"
ovfmsg="Error: result (307,533 characters) exceeds maximum allowed tokens. Output has been saved to $OVFP.
Format: Plain text
Use offset and limit parameters to read it."
in="$(jq -n --arg t "$ovfmsg" '{tool_name:"mcp__plugin_fnd_chrome-devtools-mcp__evaluate_script",tool_response:{content:[{type:"text",text:$t}]}}')"

# M31: the notice passes through untouched (no updatedToolOutput) …
assert_eq M31-passthrough "$(run_slim "$in")" ""

# M32: … and DEBUG on logs reason:"platform-overflow" with the extracted spill path (sentence period
# stripped), not the generic size-gate line.
DBG="$TMP/dbg-m32"; mkdir -p "$DBG"
run_dbg "$DBG" "$in" >/dev/null
assert_eq M32-reason "$(jq -r '.reason' "$DBG/$DBGLOG" 2>/dev/null)" "platform-overflow"
assert_eq M32-spill  "$(jq -r '.spill'  "$DBG/$DBGLOG" 2>/dev/null)" "$OVFP"
assert_eq M32-decision "$(jq -r '.decision' "$DBG/$DBGLOG" 2>/dev/null)" "passthrough"

# M33: additive vocabulary only — a payload that merely QUOTES the phrase, with no tool-results path,
# is not an overflow (it stays whatever it was: here a big non-JSON text → non-json).
DBG="$TMP/dbg-m33"; mkdir -p "$DBG"
quote="The docs say a result that exceeds maximum allowed tokens is spilled by the platform. $(printf 'x%.0s' $(seq 1 5000))"
in="$(jq -n --arg t "$quote" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}]}}')"
run_dbg "$DBG" "$in" >/dev/null
assert_eq M33-reason "$(jq -r '.reason' "$DBG/$DBGLOG" 2>/dev/null)" "non-json"

# M34: the tag must never COST a compression. The probe runs only where the result is passing through
# anyway (the size gate, and the no-gain `non-json` branch — see M35); a big compressible result that
# happens to contain the phrase AND a tool-results path (a tool reporting on someone else's overflow, a
# transcript excerpt…) is still compressed exactly as before — and no phantom overflow event is logged
# for `--report` to count as a missed whale.
DBG="$TMP/dbg-m34"; mkdir -p "$DBG"
quoted="$(jq -cn --arg f "$OVFP" '{msg:"exceeds maximum allowed tokens", file:$f, note:("y"*6000)}')"
in="$(jq -n --arg t "$quoted" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}]}}')"
assert_contains M34-still-compressed "$(run_slim "$in")" "updatedToolOutput"
run_dbg "$DBG" "$in" >/dev/null
assert_eq M34-decision "$(jq -r '.decision' "$DBG/$DBGLOG" 2>/dev/null)" "compressed"
assert_eq M34-not-overflow "$(jq -r '.reason' "$DBG/$DBGLOG" 2>/dev/null)" "null"

# M35: the notice is normally ~1.5 KB (under the gate), but the trigger is size-INDEPENDENT — a fatter
# notice (a long quoted preamble, a verbose Format block) must still be tagged, not hidden among the
# generic `non-json` lines, or `--report`'s missed-whale count silently undercounts. That branch is
# already a passthrough (nothing compressed either way), so the re-label costs no compression.
DBG="$TMP/dbg-m35"; mkdir -p "$DBG"
fat="$ovfmsg
$(printf 'x%.0s' $(seq 1 6000))"
in="$(jq -n --arg t "$fat" '{tool_name:"mcp__plugin_fnd_chrome-devtools-mcp__evaluate_script",tool_response:{content:[{type:"text",text:$t}]}}')"
assert_eq M35-passthrough "$(run_slim "$in")" ""
run_dbg "$DBG" "$in" >/dev/null
assert_eq M35-over-gate "$(jq -r '.bytes_in > 4096' "$DBG/$DBGLOG" 2>/dev/null)" "true"
assert_eq M35-reason "$(jq -r '.reason' "$DBG/$DBGLOG" 2>/dev/null)" "platform-overflow"
assert_eq M35-spill  "$(jq -r '.spill'  "$DBG/$DBGLOG" 2>/dev/null)" "$OVFP"
assert_eq M35-decision "$(jq -r '.decision' "$DBG/$DBGLOG" 2>/dev/null)" "passthrough"

# M36: the path probe scans only a 4 KB window after the phrase — the backtracking regex must never
# walk a whale-sized payload (quadratic on URL-dense text: 43 s on 1 MB pre-fix). A tool-results path
# that far from the phrase cannot belong to a real notice (~1.5 KB total), so the text stays a quote.
DBG="$TMP/dbg-m36"; mkdir -p "$DBG"
far="A result that exceeds maximum allowed tokens was mentioned here.
$(printf 'x%.0s' $(seq 1 5000)) $OVFP"
in="$(jq -n --arg t "$far" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}]}}')"
run_dbg "$DBG" "$in" >/dev/null
assert_eq M36-reason "$(jq -r '.reason' "$DBG/$DBGLOG" 2>/dev/null)" "non-json"
assert_eq M36-spill "$(jq -r '.spill' "$DBG/$DBGLOG" 2>/dev/null)" "null"

# ── M37–M52: spill-and-stub guard (M12b) ─────────────────────────────────────
# A result the pipeline cannot shrink under FND_MCP_SLIM_STUB_BYTES (default 32 KB) used to land in
# context RAW. The hook now replaces it with a ~1 KB stub naming the spill + the json-slim command,
# with hard rails: error shapes, non-text blocks (images must render), platform-overflow notices,
# sub-threshold results and a failed spill are NEVER stubbed. `env -u FND_MCP_SLIM_STUB` clears the
# suite-level pin above, so these cases run against the shipped DEFAULT (guard on).
run_stub() { # spill-dir input-json [VAR=val…]
  local dir="$1" in="$2"; shift 2
  printf '%s' "$in" | env -u FND_MCP_SLIM_STUB FND_MCP_SLIM_DIR="$dir" "$@" node "$SLIM" 2>/dev/null
}
STUBBIG="$(printf 'x%.0s' $(seq 1 40000))"   # 40 KB of non-JSON, over the default threshold
SBD="$TMP/stub"; mkdir -p "$SBD"

# M37: big non-JSON content-array result → ONE text block carrying the stub: the spill path (a file on
# disk), the ready-to-run CLI line, the M8 format tag and a shape hint — all inside the ~1 KB cap.
in="$(jq -n --arg t "$STUBBIG" '{tool_name:"mcp__plugin_fnd_chrome-devtools-mcp__evaluate_script",tool_response:{content:[{type:"text",text:$t}]}}')"
out="$(run_stub "$SBD" "$in")"
assert_contains M37-updated "$out" "updatedToolOutput"
text="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedToolOutput.content[0].text' 2>/dev/null)"
assert_contains M37-marker "$text" "<<fnd-mcp-slim stub>>"
assert_contains M37-tool   "$text" "evaluate_script"
assert_contains M37-cmd    "$text" "scripts/json-slim.cjs"
assert_contains M37-format "$text" "format=text"
assert_contains M37-shape  "$text" "shape — starts with:"
p="$(printf '%s' "$text" | grep -o 'full=[^ >]*' | head -1 | sed 's/^full=//')"
if [ -n "$p" ] && [ -f "$p" ]; then ok; else bad M37-fullfile "no existing full= file (p='$p')"; fi
stublen=$(printf '%s' "$text" | wc -c | tr -d ' ')
if [ "$stublen" -le 1200 ]; then ok; else bad M37-cap "stub is $stublen B, over the ~1 KB cap"; fi
assert_eq M37-oneblock "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedToolOutput.content | length' 2>/dev/null)" 1
# the spill holds the PAYLOAD, not the MCP envelope — json-slim on it must see the whale itself
printf '%s' "$STUBBIG" > "$TMP/stub-payload.txt"
if [ -n "$p" ] && cmp -s "$p" "$TMP/stub-payload.txt"; then ok; else bad M37-byte-exact "spill is not the byte-exact payload (p='$p')"; fi

# M38: the arriving SHAPE is mirrored — a raw-string result stubs as a string, not as a content array
in="$(jq -n --arg t "$STUBBIG" '{tool_name:"mcp__x__y",tool_response:$t}')"
text="$(run_stub "$SBD" "$in" | jq -r '.hookSpecificOutput.updatedToolOutput' 2>/dev/null)"
assert_contains M38-string-stub "$text" "<<fnd-mcp-slim stub>>"
p="$(printf '%s' "$text" | grep -o 'full=[^ >]*' | head -1 | sed 's/^full=//')"
if [ -n "$p" ] && cmp -s "$p" "$TMP/stub-payload.txt"; then ok; else bad M38-byte-exact "spill is not the byte-exact original (p='$p')"; fi

# M39: DEBUG on → decision:"stubbed" carrying the reason of the branch it replaced, the M8 format tag,
# the spill path, and bytes_out (the stub) far below bytes_in (the whale)
DBG="$TMP/dbg-m39"; mkdir -p "$DBG"
in="$(jq -n --arg t "$STUBBIG" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}]}}')"
run_stub "$DBG" "$in" FND_MCP_SLIM_DEBUG=1 >/dev/null
assert_eq M39-decision "$(jq -r '.decision' "$DBG/$DBGLOG" 2>/dev/null)" "stubbed"
assert_eq M39-reason   "$(jq -r '.reason'   "$DBG/$DBGLOG" 2>/dev/null)" "non-json"
assert_eq M39-format   "$(jq -r '.format'   "$DBG/$DBGLOG" 2>/dev/null)" "text"
assert_eq M39-shrunk   "$(jq -r '.bytes_out < 1500 and .bytes_in > 32768' "$DBG/$DBGLOG" 2>/dev/null)" "true"
sp="$(jq -r '.spill' "$DBG/$DBGLOG" 2>/dev/null)"
if [ -n "$sp" ] && [ -f "$sp" ]; then ok; else bad M39-spill "stubbed line has no existing spill (sp='$sp')"; fi

# M40: a COMPRESSED result whose body is still over the threshold is stubbed too (a 77 % cut of the
# 260 KB Jira fixture still leaves ~58 KB — no win for context), the payload is on disk exactly ONCE
# (the stub's spill; the compressed body and its `full=` handle are never written), and the debug line
# names the branch `weak-gain` with the stages that did run.
SBW="$TMP/stub-weak"; mkdir -p "$SBW"
textW="$(run_stub "$SBW" "$msin" | jq -r '.hookSpecificOutput.updatedToolOutput.content[0].text' 2>/dev/null)"
assert_contains M40-stub "$textW" "<<fnd-mcp-slim stub>>"
assert_contains M40-json-hint "$textW" "format=json"
assert_eq M40-one-spill "$(ls "$SBW" | grep -c '^fnd-mcp-slim-')" 1
DBG="$TMP/dbg-m40"; mkdir -p "$DBG"
run_stub "$DBG" "$msin" FND_MCP_SLIM_DEBUG=1 >/dev/null
assert_eq M40-decision "$(jq -r '.decision' "$DBG/$DBGLOG" 2>/dev/null)" "stubbed"
assert_eq M40-reason   "$(jq -r '.reason'   "$DBG/$DBGLOG" 2>/dev/null)" "weak-gain"
# the weak-gain line carries the format tag too (the shape hint's, since the payload compressed)
assert_eq M40-format   "$(jq -r '.format'   "$DBG/$DBGLOG" 2>/dev/null)" "json"
if jq -e '.stages | length > 0' "$DBG/$DBGLOG" >/dev/null 2>&1; then ok; else bad M40-stages "stubbed weak-gain line lost its stages"; fi

# M41: never-stub rails — an error result, a content array holding a NON-text block (an image must
# still render) or an error ENVELOPE block (one stub would swallow the failure the write-gating reads
# verbatim), and a platform-overflow notice fatter than the threshold all pass through RAW.
in="$(jq -n --arg t "$STUBBIG" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}],isError:true}}')"
assert_eq M41-iserror "$(run_stub "$SBD" "$in")" ""
in="$(jq -n --arg t "$STUBBIG" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t},{type:"image",data:"iVBORw0KGgo=",mimeType:"image/png"}]}}')"
assert_eq M41-image-block "$(run_stub "$SBD" "$in")" ""
in="$(jq -n --arg t "$STUBBIG" --arg e "$errb" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t},{type:"text",text:$e}]}}')"
assert_eq M41-error-block "$(run_stub "$SBD" "$in")" ""
# same rail on the weak-gain branch: the M10 mixed result (compressible block + error envelope) with a
# threshold it cannot meet still compresses normally, error block byte-identical, no stub
outE="$(run_stub "$SBD" "$(jq -n --arg c "$comp" --arg e "$errb" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$c},{type:"text",text:$e}]}}')" FND_MCP_SLIM_STUB_BYTES=1000)"
assert_absent M41-weak-error-block "$outE" "<<fnd-mcp-slim stub>>"
assert_eq M41-weak-errblock-verbatim "$(printf '%s' "$outE" | jq -r '.hookSpecificOutput.updatedToolOutput.content[1].text' 2>/dev/null)" "$errb"
fatovf="$ovfmsg
$(printf 'x%.0s' $(seq 1 40000))"
in="$(jq -n --arg t "$fatovf" '{tool_name:"mcp__plugin_fnd_chrome-devtools-mcp__evaluate_script",tool_response:{content:[{type:"text",text:$t}]}}')"
assert_eq M41-overflow-notice "$(run_stub "$SBD" "$in")" ""
DBG="$TMP/dbg-m41"; mkdir -p "$DBG"
run_stub "$DBG" "$in" FND_MCP_SLIM_DEBUG=1 >/dev/null
assert_eq M41-overflow-reason "$(jq -r '.reason' "$DBG/$DBGLOG" 2>/dev/null)" "platform-overflow"
assert_eq M41-overflow-decision "$(jq -r '.decision' "$DBG/$DBGLOG" 2>/dev/null)" "passthrough"

# M42: a result under the threshold keeps the old behavior, and FND_MCP_SLIM_STUB=0 turns the guard
# off entirely — the pre-M12b hook, byte-identical, on both branches.
in="$(jq -n --arg t "$bignon" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}]}}')"
assert_eq M42-sub-threshold "$(run_stub "$SBD" "$in")" ""
in="$(jq -n --arg t "$STUBBIG" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}]}}')"
assert_eq M42-stub-off "$(run_stub "$SBD" "$in" FND_MCP_SLIM_STUB=0)" ""
assert_eq M42-off-body-identical "$(sweep_body "$(run_stub "$SBD" "$msin" FND_MCP_SLIM_STUB=0)")" "$(sweep_body "$(run_slim "$msin")")"

# M43: that spill is the only copy of the whale — if it cannot be written the result passes through
# RAW, never as a stub pointing at a file that does not exist (FND_MCP_SLIM_DIR is a FILE here).
NOTDIR="$TMP/stub-notadir"; : > "$NOTDIR"
in="$(jq -n --arg t "$STUBBIG" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}]}}')"
assert_eq M43-spill-failure "$(run_stub "$NOTDIR" "$in")" ""

# M44: FND_MCP_SLIM_STUB_BYTES is honored; any invalid value falls back to the 32 KB default and never
# to 0, which would stub everything above the 4 KB size gate.
in="$(jq -n --arg t "$bignon" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}]}}')"
assert_contains M44-threshold-honored "$(run_stub "$SBD" "$in" FND_MCP_SLIM_STUB_BYTES=1000)" "<<fnd-mcp-slim stub>>"
assert_eq M44-invalid-default "$(run_stub "$SBD" "$in" FND_MCP_SLIM_STUB_BYTES=abc)" ""
assert_eq M44-zero-default    "$(run_stub "$SBD" "$in" FND_MCP_SLIM_STUB_BYTES=0)" ""

# M45: an unrecognized shape has no text payload to replace — the guard declines (same scope boundary
# as the compressor), and the debug line stays a plain passthrough.
DBG="$TMP/dbg-m45"; mkdir -p "$DBG"
in="$(jq -cn '{tool_name:"mcp__x__y",tool_response:{stuff:[range(0;1200)|{id:.,v:"padpadpadpadpadpadpadpadpadpad"}]}}')"
assert_eq M45-unrecognized "$(run_stub "$SBD" "$in")" ""
run_stub "$DBG" "$in" FND_MCP_SLIM_DEBUG=1 >/dev/null
assert_eq M45-reason "$(jq -r '.reason' "$DBG/$DBGLOG" 2>/dev/null)" "unrecognized-shape"

# M46: the error rail is SIZE-INDEPENDENT. A real GraphQL failure (many field errors, a stack, an
# embedded response body) is routinely tens of KB — bigger than any per-block probe would parse — and
# `reason` names only the FIRST non-modifying block, so [whale, error envelope] must be caught by the
# whole-result `anyError` signal instead. Both branches, with the envelope AFTER the whale.
bigerrb="$(jq -cn '{errors:[range(0;300)|{message:("Field \(.) doesn'"'"'t exist on type Product — check the schema and the API version before retrying"),locations:[{line:.,column:7}],extensions:{code:"undefinedField"}}]}')"
if [ "$(printf '%s' "$bigerrb" | wc -c | tr -d ' ')" -gt 8192 ]; then ok; else bad M46-fixture "big error envelope is not over 8 KB"; fi
# (a) not-modified branch: the non-JSON whale reads as `non-json`, but the envelope must still survive
in="$(jq -n --arg t "$STUBBIG" --arg e "$bigerrb" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t},{type:"text",text:$e}]}}')"
assert_eq M46-big-error-block "$(run_stub "$SBD" "$in")" ""
# (b) weak-gain branch: one block compresses, the fat envelope rides along verbatim, no stub
outBE="$(run_stub "$SBD" "$(jq -n --arg c "$comp" --arg e "$bigerrb" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$c},{type:"text",text:$e}]}}')" FND_MCP_SLIM_STUB_BYTES=1000)"
assert_absent M46-weak-big-error "$outBE" "<<fnd-mcp-slim stub>>"
assert_eq M46-weak-big-verbatim "$(printf '%s' "$outBE" | jq -r '.hookSpecificOutput.updatedToolOutput.content[1].text' 2>/dev/null)" "$bigerrb"
assert_eq M46-weak-blocks "$(printf '%s' "$outBE" | jq -r '.hookSpecificOutput.updatedToolOutput.content | length' 2>/dev/null)" 2
# and the string/single shapes keep their own rail: a fat envelope alone is never stubbed
in="$(jq -n --arg e "$bigerrb" '{tool_name:"mcp__x__y",tool_response:$e}')"
assert_eq M46-string-envelope "$(run_stub "$SBD" "$in")" ""
in="$(jq -n --arg e "$bigerrb" '{tool_name:"mcp__x__y",tool_response:{type:"text",text:$e}}')"
assert_eq M46-single-envelope "$(run_stub "$SBD" "$in")" ""

# M47: the stub gate must measure the text PAYLOAD, not the envelope. A CallToolResult can carry the
# bulk in a sibling field (`structuredContent`, MCP spec 2025-06-18; `_meta`) that a stub neither
# replaces nor spills — stubbing there would evict the one text the model needed, point at a
# near-empty spill, and emit MORE bytes than it replaces. Small-payload + fat-sibling → passthrough,
# and the decline is pre-spill (no new file).
SBS="$TMP/stub-sibling"; mkdir -p "$SBS"
in="$(jq -cn '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:"Fetched 4000 rows"}],structuredContent:{rows:[range(0;2000)|{id:.,v:"padpadpadpadpadpadpadpad"}]}}}')"
assert_eq M47-fat-sibling "$(run_stub "$SBS" "$in")" ""
in="$(jq -cn '{tool_name:"mcp__x__y",tool_response:{content:[],structuredContent:{blob:("y"*60000)}}}')"
assert_eq M47-empty-content "$(run_stub "$SBS" "$in")" ""
in="$(jq -cn '{tool_name:"mcp__x__y",tool_response:{type:"text",text:"ok",meta:{blob:("z"*60000)}}}')"
assert_eq M47-single-sibling "$(run_stub "$SBS" "$in")" ""
# (the exit-time sweep drops its .fnd-mcp-slim-sweep marker in the dir — only spill files count)
if ! ls "$SBS"/fnd-mcp-slim-* >/dev/null 2>&1; then ok; else bad M47-no-spill "declined stub left a spill: $(ls "$SBS")"; fi

# M48: …and a big text payload still stubs when a MODEST sibling rides along — the payload gate must
# not require the payload to be the whole envelope. The sibling survives in the emitted value.
in="$(jq -n --arg t "$STUBBIG" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}],_meta:{cursor:"abc123"}}}')"
outS="$(run_stub "$SBS" "$in")"
assert_contains M48-still-stubs "$outS" "<<fnd-mcp-slim stub>>"
assert_eq M48-sibling-kept "$(printf '%s' "$outS" | jq -r '.hookSpecificOutput.updatedToolOutput._meta.cursor' 2>/dev/null)" "abc123"

# M49: a stub collapses a block array into ONE joined text — lossless only for plain {type,text}
# blocks. A block carrying anything more (annotations, a per-block `_meta` pagination cursor) would
# lose that field in BOTH the stub and the spill, while the stub promises the full original on disk:
# such an array is NOT stubbable and passes through raw. A pure-text array of the same size still stubs.
SBR="$TMP/stub-rich"; mkdir -p "$SBR"
half="$(printf 'x%.0s' $(seq 1 46000))"
in="$(jq -n --arg t "$half" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t,annotations:{audience:["user"],priority:1}},{type:"text",text:$t,_meta:{cursor:"nextPage=abc123"}}]}}')"
assert_eq M49-rich-block "$(run_stub "$SBR" "$in")" ""
if ! ls "$SBR"/fnd-mcp-slim-* >/dev/null 2>&1; then ok; else bad M49-no-spill "declined stub left a spill: $(ls "$SBR")"; fi
in="$(jq -n --arg t "$half" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t},{type:"text",text:$t}]}}')"
assert_contains M49-plain-blocks-stub "$(run_stub "$SBR" "$in")" "<<fnd-mcp-slim stub>>"

# M50: the weak-gain gate measures the COMPRESSED BODY, not the envelope. A payload that compresses
# to a few hundred bytes beside a fat `structuredContent` sibling must be handed back COMPRESSED —
# stubbing there would emit more bytes than the compressed result it replaces.
SBG="$TMP/stub-weakgate"; mkdir -p "$SBG"
in="$(jq -cn '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:({rows:[range(0;2600)|{id:.,note:"padding-padding-padding"}]}|tostring)}],structuredContent:{rows:[range(0;1200)|{id:.,v:"padpadpadpadpadpadpadpadpad"}]}}}')"
outG="$(run_stub "$SBG" "$in")"
assert_contains M50-compressed "$outG" "<<full="
assert_absent   M50-not-stubbed "$outG" "<<fnd-mcp-slim stub>>"
assert_eq M50-sibling-kept "$(printf '%s' "$outG" | jq -r '.hookSpecificOutput.updatedToolOutput.structuredContent.rows | length' 2>/dev/null)" 1200

# M51: FND_MCP_SLIM_STUB_BYTES is floored at the stub's own ~1.2 KB size. Below that floor a small
# text beside a fat envelope sibling would be evicted for a stub BIGGER than the text it replaced —
# the guard would add context instead of saving it. Above the floor the switch still moves the gate.
SBF="$TMP/stub-floor"; mkdir -p "$SBF"
in="$(jq -cn --arg t "$(printf 'x%.0s' $(seq 1 300))" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}],structuredContent:{rows:[range(0;250)|{id:.,v:"padpadpadpadpadpadpadpadpad"}]}}}')"
assert_eq M51-below-floor "$(run_stub "$SBF" "$in" FND_MCP_SLIM_STUB_BYTES=200)" ""
if ! ls "$SBF"/fnd-mcp-slim-* >/dev/null 2>&1; then ok; else bad M51-no-spill "floored decline left a spill: $(ls "$SBF")"; fi
in="$(jq -n --arg t "$bignon" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}]}}')"
assert_contains M51-above-floor "$(run_stub "$SBF" "$in" FND_MCP_SLIM_STUB_BYTES=200)" "<<fnd-mcp-slim stub>>"

# M52: the plain-block rail holds on the WEAK-GAIN branch too — a compressed body whose block still
# carries annotations/_meta cannot be stubbed (payloadOf runs the same stubValue probe): the result
# is handed back COMPRESSED, block fields intact. The Jira fixture compresses to ~58 KB, over the
# default threshold, so only the rich block keeps this out of the stub path.
SBA="$TMP/stub-rich-weak"; mkdir -p "$SBA"
in="$(jq -n --rawfile t "$JIRA" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t,annotations:{audience:["user"],priority:1}}]}}')"
outA="$(run_stub "$SBA" "$in")"
assert_contains M52-compressed "$outA" "<<full="
assert_absent   M52-not-stubbed "$outA" "<<fnd-mcp-slim stub>>"
assert_eq M52-annotations-kept "$(printf '%s' "$outA" | jq -r '.hookSpecificOutput.updatedToolOutput.content[0].annotations.audience[0]' 2>/dev/null)" "user"

# ── M53–M55: Figma design-context JSX (M13) ──────────────────────────────────
# A get_design_context result (generated React/Tailwind JSX) is compacted losslessly — className
# dictionary + node-id legend + ×N sibling fold. The trimmed real fixture compresses to well under
# the stub threshold, so it must flow through the NORMAL compressed path: updatedToolOutput + a
# full= recovery spill, never a stub.
FGX="$FIX/figma-design-context.jsx"
in="$(jq -n --rawfile t "$FGX" '{tool_name:"mcp__plugin_fnd_figma-dev-mode__get_design_context",tool_response:{content:[{type:"text",text:$t}]}}')"

# M53: compressed, with a full= spill on disk and the legend header on top
out="$(run_slim "$in")"
assert_contains M53-updated "$out" "updatedToolOutput"
text="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedToolOutput.content[0].text' 2>/dev/null)"
assert_absent   M53-not-stubbed "$out" "<<fnd-mcp-slim stub>>"
if printf '%s' "$text" | head -1 | grep -Fq "<<fnd-jsx-slim>>"; then ok; else bad M53-header "legend header not on top: $(printf '%s' "$text" | head -c 60)"; fi
p="$(printf '%s' "$text" | grep -o '<<full=[^ >]*' | head -1 | sed 's/^<<full=//')"
if [ -n "$p" ] && [ -f "$p" ]; then ok; else bad M53-fullfile "no existing full= file (p='$p')"; fi

# M54: the node-id map spill exists and every #nN the body still shows resolves in it. The map is
# named `ids=`, never `full=` — that handle stays reserved for the original result the hook appends,
# so a loose `full=` scan (the model's, or M1/M25/M27 above) can never grab the id map instead. The
# path is read NAIVELY (up to whitespace): a clause after `ids=` would glue a `;` on and ENOENT.
idf="$(printf '%s' "$text" | head -1 | grep -o 'ids=[^ ]*' | sed 's/^ids=//')"
if [ "$(printf '%s' "$text" | grep -c 'full=')" -eq 1 ]; then ok; else bad M54-full-token-unique "the body carries more than one full= handle"; fi
if [ -n "$idf" ] && [ -f "$idf" ]; then ok; else bad M54-idmap "no node-id map file (idf='$idf')"; fi
printf '%s' "$text" > "$TMP/m54-body.txt"
if node -e '
  const fs=require("fs");
  const body=fs.readFileSync(process.argv[1],"utf8");
  const map=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
  const refs=[...new Set(body.match(/#n\d+/g)||[])];
  process.exit(refs.length && refs.every((r)=>typeof map[r.slice(1)]==="string") ? 0 : 1);
' "$TMP/m54-body.txt" "$idf"; then ok; else bad M54-refs-resolve "a #nN reference is missing from the node-id map"; fi

# M55: DEBUG on → the emitted line is `compressed` and its stages include `jsx`
DBG="$TMP/dbg-m55"; mkdir -p "$DBG"
run_dbg "$DBG" "$in" >/dev/null
assert_eq M55-decision "$(jq -r '.decision' "$DBG/$DBGLOG" 2>/dev/null)" "compressed"
if jq -e '.stages | index("jsx")' "$DBG/$DBGLOG" >/dev/null 2>&1; then ok; else bad M55-jsx-stage "stages=$(jq -c '.stages' "$DBG/$DBGLOG" 2>/dev/null)"; fi

# M56: mixed sibling shapes (an empty element beside text-bearing ones) — the fold used to index past
# its slot list and throw, which the hook swallows: the whale then passed through RAW and every
# folded-away product name went missing from the body. Compressed, and all 59 names still readable.
M56F="$TMP/m56.jsx"
node -e '
  const l=["<div className=\"root bg-[var(--c-bg,#fff)]\" data-node-id=\"1:0\" data-name=\"Root\">"];
  l.push("  <p className=\"lbl bg-[var(--c-fg,#000)]\" data-node-id=\"1:1\" data-name=\"L\"></p>");
  for(let i=2;i<=60;i++) l.push(`  <p className="lbl bg-[var(--c-fg,#000)]" data-node-id="1:${i}" data-name="L">Product variant ${i}</p>`);
  l.push("</div>");
  require("fs").writeFileSync(process.argv[1], l.join("\n"));
' "$M56F"
in56="$(jq -n --rawfile t "$M56F" '{tool_name:"mcp__plugin_fnd_figma-dev-mode__get_design_context",tool_response:{content:[{type:"text",text:$t}]}}')"
out56="$(run_slim "$in56")"
assert_contains M56-updated "$out56" "updatedToolOutput"
t56="$(printf '%s' "$out56" | jq -r '.hookSpecificOutput.updatedToolOutput.content[0].text' 2>/dev/null)"
n56="$(printf '%s' "$t56" | grep -o 'Product variant' | wc -l | tr -d ' ')"
if [ "$n56" -eq 59 ]; then ok; else bad M56-no-loss "only $n56 of 59 product names survived the fold"; fi

# ── M57–M59: data-loss rails (B1.2 / B4.1 / B4.7) ────────────────────────────
# Three ways the pipeline used to drop what the model needed, all seen in live debug-log traffic.

# M57 (B1.2): a FENCED error envelope is never stubbed. A tool that wraps its payload in prose +
# ```json (chrome-devtools evaluate_script) wraps its FAILURES the same way; that body declines every
# stage, so the result reached the generic `non-json` branch, the guard saw no error and replaced a
# 57 KB permission failure with a ~1 KB stub. Error results pass through at ANY size.
FERR="$TMP/m57.txt"
node -e '
  const errs=Array.from({length:300},(_,i)=>({message:`PERMISSION DENIED on field ${i} — the app is missing the read_products scope`,locations:[{line:i,column:7}],extensions:{code:"ACCESS_DENIED"}}));
  require("fs").writeFileSync(process.argv[1], "Script ran on page and returned:\n```json\n"+JSON.stringify({errors:errs})+"\n```");
' "$FERR"
if [ "$(wc -c < "$FERR" | tr -d ' ')" -gt 32768 ]; then ok; else bad M57-fixture "the fenced envelope is not over the 32 KB stub threshold"; fi
in="$(jq -n --rawfile t "$FERR" '{tool_name:"mcp__plugin_fnd_chrome-devtools-mcp__evaluate_script",tool_response:{content:[{type:"text",text:$t}]}}')"
SBE="$TMP/stub-fenced-error"; mkdir -p "$SBE"
assert_eq M57-passthrough "$(run_stub "$SBE" "$in")" ""
if ! ls "$SBE"/fnd-mcp-slim-* >/dev/null 2>&1; then ok; else bad M57-no-spill "a passed-through error envelope left a spill: $(ls "$SBE")"; fi
DBG="$TMP/dbg-m57"; mkdir -p "$DBG"
run_stub "$DBG" "$in" FND_MCP_SLIM_DEBUG=1 >/dev/null
assert_eq M57-decision "$(jq -r '.decision' "$DBG/$DBGLOG" 2>/dev/null)" "passthrough"
assert_eq M57-reason   "$(jq -r '.reason'   "$DBG/$DBGLOG" 2>/dev/null)" "error-shape"

# M58 (B4.1): a UTF-8 BOM must not misroute a compressible result into a stub. JSON.parse rejects a
# leading BOM while every other reader in json-slim strips one, so a 99 %-compressible payload read as
# `non-json` and — over the threshold — left context for a file, for one invisible character. The BOM is
# written as an ESCAPE and the fixture's first three bytes are asserted: an invisible literal that some
# editor or filter drops would turn every M58 check into a duplicate of the plain-payload baseline —
# green with the rail entirely absent.
BOMF="$TMP/m58.json"
node -e '
  const o={rows:Array.from({length:2000},(_,i)=>({id:i,note:"padding-padding-padding"}))};
  require("fs").writeFileSync(process.argv[1], "\uFEFF"+JSON.stringify(o));
' "$BOMF"
if [ "$(wc -c < "$BOMF" | tr -d ' ')" -gt 32768 ] \
   && node -e 'const b=require("fs").readFileSync(process.argv[1]);process.exit(b[0]===0xEF&&b[1]===0xBB&&b[2]===0xBF?0:1)' "$BOMF"; then ok
else bad M58-fixture "the fixture must be a >32 KB payload starting with a 3-byte BOM: $(wc -c < "$BOMF") B, head=$(node -e 'const b=require("fs").readFileSync(process.argv[1]);console.log([...b.subarray(0,3)].join(","))' "$BOMF")"; fi
in="$(jq -n --rawfile t "$BOMF" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}]}}')"
SBB="$TMP/stub-bom"; mkdir -p "$SBB"
outB="$(run_stub "$SBB" "$in")"
assert_contains M58-compressed  "$outB" "<<full="
assert_absent   M58-not-stubbed "$outB" "<<fnd-mcp-slim stub>>"
DBG="$TMP/dbg-m58"; mkdir -p "$DBG"
run_stub "$DBG" "$in" FND_MCP_SLIM_DEBUG=1 >/dev/null
assert_eq M58-decision "$(jq -r '.decision' "$DBG/$DBGLOG" 2>/dev/null)" "compressed"

# M59 (B4.7): a win smaller than the recovery marker is never emitted. The per-block gain gate measures
# the block BEFORE the ~130 B `<<full=… original_result>>` handle and the JSON re-escaping around it, so
# a thin win (here one dropped null in a 12 KB object) came out NET BIGGER than the original — four
# production events logged decision:"compressed" with bytes_out > bytes_in. The original is handed back
# instead, and the spill the discarded marker named is dropped rather than orphaned.
MOF="$TMP/m59.json"
node -e '
  const o={};
  for(let i=0;i<300;i++) o["field_"+i]="value-"+i+"-abcdefghijklmnop";
  o.nullish=null;   // the only thing the pipeline can drop here → a 15 B win, ~8× less than the marker
  require("fs").writeFileSync(process.argv[1], JSON.stringify(o));
' "$MOF"
in="$(jq -n --rawfile t "$MOF" '{tool_name:"mcp__x__y",tool_response:{content:[{type:"text",text:$t}]}}')"
MOD="$TMP/marker-overhead"; mkdir -p "$MOD"
assert_eq M59-passthrough "$(run_stub "$MOD" "$in")" ""
if ! ls "$MOD"/fnd-mcp-slim-* >/dev/null 2>&1; then ok; else bad M59-no-orphan "the discarded marker's spill was left on disk: $(ls "$MOD")"; fi
DBG="$TMP/dbg-m59"; mkdir -p "$DBG"
run_stub "$DBG" "$in" FND_MCP_SLIM_DEBUG=1 >/dev/null
assert_eq M59-decision "$(jq -r '.decision' "$DBG/$DBGLOG" 2>/dev/null)" "passthrough"
assert_eq M59-reason   "$(jq -r '.reason'   "$DBG/$DBGLOG" 2>/dev/null)" "marker-overhead"
assert_eq M59-no-negative-pct "$(jq -r '.bytes_out <= .bytes_in' "$DBG/$DBGLOG" 2>/dev/null)" "true"

# ═══ P — UserPromptSubmit prompt-json-guard ═════════════════════════════════
# Gate (FND_PROMPT_JSON) via the extracted plugin.json command[1]; behavior by piping
# UserPromptSubmit-shaped input to the hook. $shim/$fake come from the G/M scaffolding.
GUARD="$ROOT/plugins/fnd/hooks/prompt-json-guard.cjs"
PJ_GATE="$(jq -r '.hooks.UserPromptSubmit[0].hooks[1].command' "$MANIFEST")"
PJD="$TMP/pj-spill"; mkdir -p "$PJD"

# Build a UserPromptSubmit input: a JSON blob of ~blobBytes wrapped in prose padded so the
# whole prompt is ~promptBytes. Writes the canonical blob to $4 for byte-exact comparison.
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
run_guard() { printf '%s' "$1" | env TMPDIR="$PJD" "${@:2}" node "$GUARD" 2>/dev/null; }
reason_path() { printf '%s' "$1" | jq -r '.reason' 2>/dev/null \
  | grep -oE '/[^[:space:]]+fnd-prompt-json-[^[:space:]]+\.json' | head -1; }

# P1: big prompt + big JSON blob → block; reason names an existing file holding the blob byte-exact
EXP="$PJD/p1.json"
in="$(mk 20000 25000 "$PJD" "$EXP")"
out="$(run_guard "$in")"
assert_contains P1-block "$out" '"decision":"block"'
p="$(reason_path "$out")"
if [ -n "$p" ] && [ -f "$p" ] && cmp -s "$p" "$EXP"; then ok; else bad P1-byteexact "saved blob missing or != prompt blob (p='$p')"; fi
assert_contains P1-offswitch "$out" "FND_PROMPT_JSON=0"

# P2: big prompt but the JSON blob is below the 8 KB gate → passthrough
in="$(mk 4000 15000 "$PJD" "$PJD/p2.json")"
assert_eq P2-blob-below-gate "$(run_guard "$in")" ""

# P3: blob is over the gate but the whole prompt is under the 10 KB gate → passthrough
in="$(mk 8500 9000 "$PJD" "$PJD/p3.json")"
assert_eq P3-prompt-below-gate "$(run_guard "$in")" ""

# P4: big prose, no parseable JSON (a stray unbalanced brace) → passthrough
big="$(printf 'z%.0s' $(seq 1 12000)) and a { broken [ json"
in="$(jq -n --arg p "$big" --arg c "$PJD" '{prompt:$p,cwd:$c}')"
assert_eq P4-no-json "$(run_guard "$in")" ""

# P5: FND_PROMPT_JSON gate — 0 means node never spawns; unset means it runs
run_pj_gate() { : > "$TMP/node.log"; env "$@" NODE_LOG="$TMP/node.log" PATH="$shim:$PATH" \
  CLAUDE_PLUGIN_ROOT="$fake" bash -c "$PJ_GATE" >/dev/null 2>&1; }
run_pj_gate FND_PROMPT_JSON=0; ec=$?
assert_eq P5-off-exit "$ec" 0
if [ -s "$TMP/node.log" ]; then bad P5-off "node ran with FND_PROMPT_JSON=0"; else ok; fi
run_pj_gate; ec=$?
assert_eq P5-default-exit "$ec" 0
if [ -s "$TMP/node.log" ]; then ok; else bad P5-default "node did not run by default"; fi

# P6: braces / brackets / escaped quotes INSIDE string values must not break extraction
EXP6="$PJD/p6.json"
in="$(node -e '
  const fs=require("fs");
  const items=Array.from({length:250},(_,i)=>({id:i,s:"has {curly} and [square] and \"quoted\" and \\slash"}));
  const blob=JSON.stringify({items}); fs.writeFileSync(process.argv[1],blob);
  process.stdout.write(JSON.stringify({prompt:"Analyze this tricky payload:\n\n"+blob+"\n\nDone.",cwd:process.argv[2]}));
' "$EXP6" "$PJD")"
out="$(run_guard "$in")"
assert_contains P6-block "$out" '"decision":"block"'
p="$(reason_path "$out")"
if [ -n "$p" ] && [ -f "$p" ] && cmp -s "$p" "$EXP6"; then ok; else bad P6-byteexact "string-brace blob mis-extracted (p='$p')"; fi

# P7: spill write failure (read-only tmpdir, no workspace) → NEVER block (don't lose the paste)
if [ "$(id -u)" = 0 ]; then ok; else   # root ignores 000 perms — skip there
  RO="$TMP/pj-ro"; mkdir -p "$RO"; chmod 000 "$RO"
  in="$(mk 20000 25000 "$RO/nope" "$PJD/p7.json")"   # cwd under RO → no .claude/fnd, unwritable
  assert_eq P7-spill-fail-passthrough "$(run_guard "$in" TMPDIR="$RO")" ""
  chmod 755 "$RO"
fi

# P8: TWO offloadable blobs (both ≥ gate) → BOTH saved. A block erases the whole prompt,
# so nothing offloadable may be dropped; the reason lists two paths, each byte-exact.
EXP8A="$PJD/p8a.json"; EXP8B="$PJD/p8b.json"
in="$(node -e '
  const fs=require("fs");
  const a=JSON.stringify({a:Array.from({length:400},(_,i)=>({id:i,pad:"x".repeat(40)}))});
  const b=JSON.stringify({b:Array.from({length:600},(_,i)=>({id:i,pad:"y".repeat(40)}))});
  fs.writeFileSync(process.argv[1],a); fs.writeFileSync(process.argv[2],b);
  process.stdout.write(JSON.stringify({prompt:"two responses: "+a+" and "+b+" end",cwd:process.argv[3]}));
' "$EXP8A" "$EXP8B" "$PJD")"
out="$(run_guard "$in")"
assert_contains P8-block "$out" '"decision":"block"'
paths="$(printf '%s' "$out" | jq -r '.reason' 2>/dev/null | grep -oE '/[^[:space:]]+fnd-prompt-json-[^[:space:]]+\.json')"
n=$(printf '%s\n' "$paths" | grep -c .)
assert_eq P8-two-paths "$n" 2
for exp in "$EXP8A" "$EXP8B"; do
  hit=no; for sp in $paths; do cmp -s "$sp" "$exp" && hit=yes; done
  if [ "$hit" = yes ]; then ok; else bad "P8-saved-$(basename "$exp")" "blob not saved byte-exact"; fi
done

# P9: an active task workspace → blob spilled under .claude/fnd/<id>/tmp/, not the tmpdir
WS="$PJD/ws"; mkdir -p "$WS/.claude/fnd/ELC-999"
in="$(mk 20000 25000 "$WS" "$PJD/p9.json")"
out="$(run_guard "$in")"
p="$(reason_path "$out")"
assert_contains P9-block "$out" '"decision":"block"'
case "$p" in *"/.claude/fnd/ELC-999/tmp/"*) ok ;; *) bad P9-workspace "blob not in workspace tmp (p='$p')" ;; esac

# P10: a multibyte JSON blob survives stdin decoding — saved byte-exact, no U+FFFD
EXP10="$PJD/p10.json"
in="$(node -e '
  const fs=require("fs");
  const items=Array.from({length:500},(_,i)=>({id:i,note:"がぎぐげご漢字テスト日本語",emoji:"🍣🎏🍜"}));
  const blob=JSON.stringify({items}); fs.writeFileSync(process.argv[1],blob);
  process.stdout.write(JSON.stringify({prompt:"分析してください:\n\n"+blob+"\n\n以上",cwd:process.argv[2]}));
' "$EXP10" "$PJD")"
out="$(run_guard "$in")"
assert_contains P10-block "$out" '"decision":"block"'
p="$(reason_path "$out")"
if [ -n "$p" ] && [ -f "$p" ] && cmp -s "$p" "$EXP10" \
   && node -e 'const fs=require("fs");process.exit(/�/.test(fs.readFileSync(process.argv[1],"utf8"))?1:0)' "$p"; then ok; else bad P10-multibyte "multibyte blob corrupted (p='$p')"; fi

# P11: a top-level ARRAY blob (not object) over the gate → block
EXP11="$PJD/p11.json"
in="$(node -e '
  const fs=require("fs");
  const arr=JSON.stringify(Array.from({length:600},(_,i)=>({id:i,pad:"z".repeat(40)})));
  fs.writeFileSync(process.argv[1],arr);
  process.stdout.write(JSON.stringify({prompt:"Here is the list:\n\n"+arr+"\n\nsummarize",cwd:process.argv[2]}));
' "$EXP11" "$PJD")"
out="$(run_guard "$in")"
assert_contains P11-array-block "$out" '"decision":"block"'
p="$(reason_path "$out")"
if [ -n "$p" ] && [ -f "$p" ] && cmp -s "$p" "$EXP11"; then ok; else bad P11-array "array blob mis-extracted (p='$p')"; fi

# P12: a stray unbalanced brace in prose BEFORE the blob → conservative passthrough (no false block)
in="$(node -e '
  const big=JSON.stringify({b:Array.from({length:600},(_,i)=>({id:i,pad:"y".repeat(40)}))});
  process.stdout.write(JSON.stringify({prompt:"prose with a stray { brace then "+big+" end",cwd:process.argv[1]}));
' "$PJD")"
assert_eq P12-conservative-passthrough "$(run_guard "$in")" ""

# P13: malformed stdin → passthrough, exit 0 (never break the prompt)
out="$(printf 'not json at all' | env TMPDIR="$PJD" node "$GUARD" 2>/dev/null)"; ec=$?
assert_eq P13-malformed-out "$out" ""
assert_eq P13-malformed-exit "$ec" 0

# P14: TWO active work-id dirs (ambiguous) → fall back to tmpdir, never an arbitrary ticket dir
WS2="$PJD/ws2"; mkdir -p "$WS2/.claude/fnd/ELC-999" "$WS2/.claude/fnd/ELC-1000"
in="$(mk 20000 25000 "$WS2" "$PJD/p14.json")"
out="$(run_guard "$in")"
assert_contains P14-block "$out" '"decision":"block"'
p="$(reason_path "$out")"
case "$p" in
  *"/.claude/fnd/"*) bad P14-ambiguous "ambiguous workspaces spilled into a ticket dir (p='$p')" ;;
  "$PJD"/*)         ok ;;
  *)                bad P14-ambiguous "unexpected spill path (p='$p')" ;;
esac

# P15: a balanced-but-INVALID JSON span (unquoted keys) ≥ gate BEFORE a valid blob → the
# invalid span is skipped (JSON.parse catch), the valid blob still blocks and is saved
EXP15="$PJD/p15.json"
in="$(node -e '
  const fs=require("fs");
  let bad="{"; for(let i=0;i<1200;i++) bad+="unquotedkey"+i+":"+i+","; bad+="last:1}";  // ~18 KB, invalid
  const good=JSON.stringify({items:Array.from({length:600},(_,i)=>({id:i,pad:"z".repeat(40)}))});
  fs.writeFileSync(process.argv[1],good);
  process.stdout.write(JSON.stringify({prompt:"invalid "+bad+" then valid "+good+" end",cwd:process.argv[2]}));
' "$EXP15" "$PJD")"
out="$(run_guard "$in")"
assert_contains P15-block "$out" '"decision":"block"'
p="$(reason_path "$out")"
if [ -n "$p" ] && [ -f "$p" ] && cmp -s "$p" "$EXP15"; then ok; else bad P15-skip-invalid "valid blob after an invalid span not saved (p='$p')"; fi

# P16: a stray closer '}' at depth 0 in prose before a FLAT-array blob → the depth-0
# stray-closer guard keeps the scan armed so the array is still extracted and blocked
EXP16="$PJD/p16.json"
in="$(node -e '
  const fs=require("fs");
  const arr=JSON.stringify(Array.from({length:600},(_,i)=>({id:i,pad:"z".repeat(40)})));
  fs.writeFileSync(process.argv[1],arr);
  process.stdout.write(JSON.stringify({prompt:"result } was "+arr+" end",cwd:process.argv[2]}));
' "$EXP16" "$PJD")"
out="$(run_guard "$in")"
assert_contains P16-block "$out" '"decision":"block"'
p="$(reason_path "$out")"
if [ -n "$p" ] && [ -f "$p" ] && cmp -s "$p" "$EXP16"; then ok; else bad P16-stray-closer "flat array after a stray closer not blocked/saved (p='$p')"; fi

# ═══ T — SubagentStart subagent-conventions (code-convention injection) ══════
# Reuses $fake (CLAUDE_PLUGIN_ROOT with hooks/comment-discipline.md + lean-code.md
# holding MARK-… sentinels) from the S scaffolding.
SUBC="$ROOT/plugins/fnd/hooks/subagent-conventions.sh"
run_subc() { printf '%s' "$1" | env CLAUDE_PLUGIN_ROOT="$fake" "${@:2}" bash "$SUBC" 2>/dev/null; }

# T1: a code-writing agent gets both conventions
out="$(run_subc '{"agent_type":"general-purpose"}')"
assert_contains T1-comment "$out" "MARK-comment-discipline"
assert_contains T1-lean    "$out" "MARK-lean-code"

# T2: unknown / unparsable type errs toward injecting (a code agent without them is the costly miss)
assert_contains T2-unknown   "$(run_subc '{"agent_type":"some-new-writer"}')" "MARK-comment-discipline"
assert_contains T2-malformed "$(run_subc 'not json')"                          "MARK-comment-discipline"

# T3: non-code agents are skipped (no conventions) — jira-writer joins the readers/reviewers
for a in jira-reader jira-writer bug-hunter change-reviewer figma-reader doc-reader theme-explorer; do
  assert_eq "T3-$a-skip" "$(run_subc "{\"agent_type\":\"$a\"}")" ""
done
# a scoped plugin agent_type (e.g. fnd:jira-writer) is still matched by the *…* globs
assert_eq T4-scoped-writer-skip "$(run_subc '{"agent_type":"fnd:jira-writer"}')" ""

# T5: FND_LEAN=0 drops lean-code, keeps comment-discipline
out="$(run_subc '{"agent_type":"general-purpose"}' FND_LEAN=0)"
assert_contains T5-comment "$out" "MARK-comment-discipline"
assert_absent   T5-no-lean "$out" "MARK-lean-code"

# T6: the hook always exits 0 (a hook failure must never block an agent start)
run_subc '{"agent_type":"jira-writer"}'    >/dev/null 2>&1; assert_eq T6-skip-exit   "$?" 0
run_subc '{"agent_type":"general-purpose"}' >/dev/null 2>&1; assert_eq T6-inject-exit "$?" 0

echo "hooks sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  printf '%s' "$failures"
  exit 1
fi
