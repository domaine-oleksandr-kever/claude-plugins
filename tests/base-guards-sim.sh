#!/usr/bin/env bash
# Simulation harness for base's scratch-path guard script (plugins/base/hooks/scratch-path-guard.cjs)
# and the exclude stamp it buys its allow with (plugins/base/scripts/scratch-hygiene.cjs). The script
# runs as the mod runs it: the event on stdin, the launch root in CLAUDE_PROJECT_DIR (or none, for
# the cwd fallback). The mod side (when it spawns, what it denies with) is plugins/base/hooks/mods/tests/guards.test.ts; base's no-verify-bypass.sh
# rides tests/no-verify-bypass-matrix.sh. Exit 0 = all green.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SPG="$ROOT/plugins/base/hooks/scratch-path-guard.cjs"
HYG="$ROOT/plugins/base/scripts/scratch-hygiene.cjs"
MANIFEST="$ROOT/plugins/base/.claude-plugin/plugin.json"
command -v node >/dev/null 2>&1 || { echo "base-guards-sim: node not found"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "base-guards-sim: jq not found"; exit 1; }

TMP="$(mktemp -d)"; TMP="$(cd "$TMP" && pwd -P)"
trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }
assert_eq() { if [ "$2" = "$3" ]; then ok; else bad "$1" "got '$2', want '$3'"; fi; }
assert_contains() { case "$2" in *"$3"*) ok ;; *) bad "$1" "missing '$3' in: $(printf '%s' "$2" | head -c 300)" ;; esac; }
assert_absent() { case "$2" in *"$3"*) bad "$1" "unexpected '$3' in: $(printf '%s' "$2" | head -c 300)" ;; *) ok ;; esac; }
assert_empty() { if [ -z "$2" ]; then ok; else bad "$1" "denied: $(printf '%s' "$2" | head -c 300)"; fi; }

DPROJ="$TMP/proj"; mkdir -p "$DPROJ/.claude/tasks/ABC-1/tmp" "$DPROJ/sections" "$DPROJ/tmp"
DOUT="$TMP/outside"; mkdir -p "$DOUT/scratchpad"
DOSTMP="$TMP/ostmp"; mkdir -p "$DOSTMP"

run_at() { # cwd payload [VAR=val…] — the script with no launch root: the cwd fallback
  _c="$1"; _p="$2"; shift 2
  printf '%s' "$_p" | (cd "$_c" && env -u CLAUDE_PROJECT_DIR TMPDIR="$DOSTMP" "$@" node "$SPG" 2>/dev/null)
}
run_spg() { run_at "$DPROJ" "$@"; }
ev_at() { # cwd tool key path
  jq -cn --arg t "$2" --arg k "$3" --arg p "$4" --arg cwd "$1" \
    '{hook_event_name:"PreToolUse", tool_name:$t, tool_input:{($k):$p}, cwd:$cwd}'
}
ev() { ev_at "$DPROJ" "$@"; }
nopath_ev() { jq -cn --arg t "$1" --arg cwd "${2:-$DPROJ}" '{tool_name:$t, tool_input:{fullPage:true}, cwd:$cwd}'; }

PW=mcp__plugin_base_playwright__browser_take_screenshot
PWU=mcp__playwright__browser_take_screenshot
CDT=mcp__plugin_base_chrome-devtools-mcp__take_screenshot
CDS=mcp__plugin_base_chrome-devtools-mcp__take_snapshot
CDN=mcp__plugin_base_chrome-devtools-mcp__get_network_request
PRC=mcp__plugin_base_playwright__browser_run_code_unsafe

# G1: a bare filename to a playwright with no --output-dir lands in <cwd>/.playwright-mcp → deny,
# the envelope Claude Code reads, an absolute remediation inside the project, the switch named.
out="$(run_spg "$(ev "$PWU" filename abc-123-cart.jpeg)")"; ec=$?
assert_eq G1-exit "$ec" 0
if printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny" and (.hookSpecificOutput.permissionDecisionReason | type == "string")' >/dev/null 2>&1; then ok
else bad G1-envelope "no deny envelope: $(printf '%s' "$out" | head -c 160)"; fi
assert_contains G1-prefix   "$out" 'base scratch-path guard:'
assert_contains G1-where    "$out" "$DPROJ/.claude/tasks/<work-id>/tmp/abc-123-cart.jpeg"
assert_contains G1-noticket "$out" "$DPROJ/.claude/tmp/abc-123-cart.jpeg"
assert_contains G1-switch   "$out" 'BASE_SCRATCH_GUARD=0'
assert_empty G1b-remediation-allowed "$(run_spg "$(ev "$PWU" filename "$DPROJ/.claude/tmp/abc-123-cart.jpeg")")"

# G2: base's own playwright resolves a bare filename into its pinned output dir — allowed; escaping
# that dir is litter.
assert_empty G2-bundled-allowed "$(run_spg "$(ev "$PW" filename abc-123-cart.jpeg)")"
out="$(run_spg "$(ev "$PW" filename ../../../x.png)")"
assert_contains G2b-bundled-escape "$out" "$DPROJ/x.png"
# another plugin's playwright is not the bundled one: judged as a default-configured server
out="$(run_spg "$(ev mcp__plugin_other_playwright__browser_take_screenshot filename shot.png)")"
assert_contains G2c-foreign-name-not-bundled "$out" '.playwright-mcp'

# G3: in-tree litter, root or subdir, and the project's own tmp/ → deny; `.claude/` paths → allow.
assert_contains G3-root-deny   "$(run_spg "$(ev "$CDT" filePath "$DPROJ/abc-99.png")")" '"permissionDecision":"deny"'
assert_contains G3-subdir-deny "$(run_spg "$(ev "$CDT" filePath sections/shot.png)")" 'would write into the project working tree'
assert_contains G3-tmp-deny    "$(run_spg "$(ev "$CDT" filePath "$DPROJ/tmp/shot.png")")" '"permissionDecision":"deny"'
assert_empty G3-workspace      "$(run_spg "$(ev "$CDT" filePath .claude/tasks/ABC-1/tmp/shot.png)")"
assert_empty G3-claude-tmp     "$(run_spg "$(ev "$CDT" filePath "$DPROJ/.claude/tmp/shot.png")")"
assert_empty G3-base-tmp       "$(run_spg "$(ev "$CDT" filePath "$DPROJ/.claude/base-tmp/shot.png")")"
assert_contains G3-nested-claude "$(run_spg "$(ev "$CDT" filePath .playwright-mcp/.claude/tmp/x.png)")" '"permissionDecision":"deny"'

# G4: outside the project → deny without the opt-out (the server refuses it anyway); a foreign
# checkout's .claude is still outside.
out="$(run_spg "$(ev "$PW" filename "$DOUT/scratchpad/abc-1-pdp.png")")"
assert_contains G4-outside-why   "$out" 'accept only files inside this project'
assert_contains G4-outside-where "$out" "$DPROJ/.claude/tmp/abc-1-pdp.png"
assert_absent   G4-no-optout     "$out" 'BASE_SCRATCH_GUARD=0'
mkdir -p "$TMP/foreign/.claude/tmp"
assert_contains G4b-foreign "$(run_spg "$(ev "$CDT" filePath "$TMP/foreign/.claude/tmp/shot.png")")" 'outside this project'

# G5: no path at all — a per-user playwright still writes into the checkout; base's playwright and
# chrome-devtools do not.
assert_contains G5-nopath-pwu "$(run_spg "$(nopath_ev "$PWU")")" "$DPROJ/.playwright-mcp"
assert_empty G5-nopath-bundled "$(run_spg "$(nopath_ev "$PW")")"
assert_empty G5-nopath-cdt     "$(run_spg "$(nopath_ev "$CDT")")"
assert_empty G5-nonstring      "$(run_spg "$(jq -cn --arg t "$CDT" --arg cwd "$DPROJ" '{tool_name:$t, tool_input:{filePath:7}, cwd:$cwd}')")"

# G6: the switch, and fail-open on a broken event.
assert_empty G6-off "$(run_spg "$(ev "$PWU" filename x.png)" BASE_SCRATCH_GUARD=0)"
out="$(printf 'not json' | (cd "$DPROJ" && node "$SPG" 2>/dev/null))"; ec=$?
assert_eq G6-malformed-exit "$ec" 0
assert_empty G6-malformed "$out"

# G7: the deny creates the directories it recommends.
DF="$TMP/fresh"; mkdir -p "$DF/.claude/tasks/ABC-7"
out="$(run_at "$DF" "$(ev_at "$DF" "$PWU" filename x.png)")"
assert_contains G7-deny "$out" '"permissionDecision":"deny"'
if [ -d "$DF/.claude/tmp" ] && [ -d "$DF/.claude/tasks/ABC-7/tmp" ]; then ok; else bad G7-dirs "the deny did not create .claude/tmp and the workspace tmp/"; fi

# G8: the launch root the mod passes wins over the cwd — a Bash `cd` out of the project does not move it.
run_root() { # root cwd payload
  printf '%s' "$3" | (cd "$2" && env TMPDIR="$DOSTMP" CLAUDE_PROJECT_DIR="$1" node "$SPG" 2>/dev/null)
}
assert_empty G8-root-from-outside "$(run_root "$DPROJ" "$DOUT/scratchpad" "$(ev_at "$DOUT/scratchpad" "$CDT" filePath "$DPROJ/.claude/tmp/x.png")")"
assert_contains G8b-root-where "$(run_root "$DPROJ" "$DOUT/scratchpad" "$(ev_at "$DOUT/scratchpad" "$CDT" filePath "$DOUT/scratchpad/x.png")")" "$DPROJ/.claude/tmp/x.png"
# …and without it, a cwd inside .claude/tasks/<id>/tmp is cut back to the project
DC="$DPROJ/.claude/tasks/ABC-1/tmp"
assert_empty G8c-cut-workspace "$(run_at "$DC" "$(ev_at "$DC" "$CDT" filePath "$DC/shot.png")")"
out="$(run_at "$DC" "$(ev_at "$DC" "$CDT" filePath "$DPROJ/shot.png")")"
assert_contains G8d-cut-where "$out" "$DPROJ/.claude/tasks/<work-id>/tmp/shot.png"
assert_absent   G8d-no-double "$out" '.claude/tasks/ABC-1/tmp/.claude'

# G9: a git worktree — `.claude/tasks` links into the main checkout, which the servers refuse; the
# remediation is the worktree's own .claude/tmp/<work-id>/.
DM="$TMP/main"; DW="$TMP/wt"
mkdir -p "$DM/.claude/tasks/ABC-1/tmp" "$DW/.claude"; git -C "$DM" init -q 2>/dev/null
ln -s "$DM/.claude/tasks" "$DW/.claude/tasks"
out="$(run_root "$DW" "$DW" "$(ev_at "$DW" "$CDT" filePath "$DW/.claude/tasks/ABC-1/tmp/shot.png")")"
assert_contains G9-wt-deny  "$out" "$DW/.claude/tmp/ABC-1/shot.png"
assert_absent   G9-wt-no-tasks "$out" '.claude/tasks'
if [ -d "$DW/.claude/tmp/ABC-1" ]; then ok; else bad G9b-wt-dir "the deny did not create .claude/tmp/ABC-1"; fi
assert_empty G9c-wt-remediation "$(run_root "$DW" "$DW" "$(ev_at "$DW" "$CDT" filePath "$DW/.claude/tmp/ABC-1/shot.png")")"

# G10: chrome-devtools' OS temp dir passes for its writing tools; playwright and a read are denied.
assert_empty G10-cdt-ostmp      "$(run_spg "$(ev "$CDT" filePath "$DOSTMP/shot.png")")"
assert_empty G10-snapshot-ostmp "$(run_spg "$(ev "$CDS" filePath "$DOSTMP/snap.txt")")"
assert_contains G10-pw-ostmp   "$(run_spg "$(ev "$PWU" filename "$DOSTMP/shot.png")")" 'outside this project'
assert_contains G10-prc-ostmp  "$(run_spg "$(ev "$PRC" filename "$DOSTMP/m.js")")" 'outside this project'

# G11: the tools beside the screenshots — every path key is judged; an in-tree script is only read.
out="$(run_spg "$(jq -cn --arg t "$CDN" --arg a "$DPROJ/.claude/tmp/req.json" --arg b "$DOUT/scratchpad/res.json" --arg cwd "$DPROJ" \
  '{tool_name:$t, tool_input:{requestFilePath:$a, responseFilePath:$b}, cwd:$cwd}')")"
assert_contains G11-second-key "$out" "$DOUT/scratchpad/res.json"
assert_empty G11-runcode-in-tree "$(run_spg "$(ev "$PRC" filename sections/measure.js)")"
assert_contains G11-runcode-base "$(run_spg "$(ev "$PRC" filename ../measure.js)")" 'outside this project'
assert_empty G11-runcode-inline "$(run_spg "$(jq -cn --arg t "$PRC" --arg cwd "$DPROJ" '{tool_name:$t, tool_input:{code:"async (page) => page.title()"}, cwd:$cwd}')")"

# G12: the output dir is spelled three times — manifest args, the guard, the stamp module.
PW_OUT="$(jq -r '.mcpServers.playwright.args | index("--output-dir") as $i | if $i == null then "" else .[$i+1] end' "$MANIFEST")"
assert_eq G12-manifest "$PW_OUT" '.claude/base-tmp/playwright'
assert_eq G12-hygiene "$(node -e 'process.stdout.write(require(process.argv[1]).PLAYWRIGHT_OUT_REL)' "$HYG")" "$PW_OUT"
if grep -Fq "'$PW_OUT'" "$SPG"; then ok; else bad G12-guard "scratch-path-guard.cjs does not carry '$PW_OUT'"; fi

# G13: the bundled allows stamp .git/info/exclude once (idempotent); a deny stamps nothing; a project
# in a repo subdir gets the prefixed line.
excl_hits() { [ -f "$1/.git/info/exclude" ] || { printf 0; return; }; grep -c "^$2\$" "$1/.git/info/exclude" | tr -d ' \n'; }
DG="$TMP/git1"; mkdir -p "$DG/.claude/base-tmp/playwright"; git -C "$DG" init -q 2>/dev/null
assert_empty G13-nopath-allowed "$(run_at "$DG" "$(nopath_ev "$PW" "$DG")")"
assert_eq G13-stamped "$(excl_hits "$DG" '/\.claude/base-tmp/')" 1
assert_empty G13b-name-allowed "$(run_at "$DG" "$(ev_at "$DG" "$PW" filename shot.png)")"
assert_eq G13b-idempotent "$(excl_hits "$DG" '/\.claude/base-tmp/')" 1
DG2="$TMP/git2"; mkdir -p "$DG2"; git -C "$DG2" init -q 2>/dev/null
assert_contains G13c-deny "$(run_at "$DG2" "$(ev_at "$DG2" "$PWU" filename shot.png)")" '"permissionDecision":"deny"'
assert_eq G13c-no-stamp "$(excl_hits "$DG2" '/\.claude/base-tmp/')" 0
DG3="$TMP/git3"; mkdir -p "$DG3/web"; git -C "$DG3" init -q 2>/dev/null
printf 'node_modules' > "$DG3/.git/info/exclude"
node -e 'require(process.argv[1]).ensureCoreTmpExcluded(process.argv[2])' "$HYG" "$DG3/web"
assert_eq G13d-prefixed "$(excl_hits "$DG3" '/web/\.claude/base-tmp/')" 1
assert_eq G13d-bridge "$(excl_hits "$DG3" 'node_modules')" 1
# …and outside any repo the stamp is a silent no-op
DNG="$TMP/nogit"; mkdir -p "$DNG"
node -e 'require(process.argv[1]).ensureCoreTmpExcluded(process.argv[2])' "$HYG" "$DNG"; ec=$?
assert_eq G13e-nogit "$ec" 0

echo "base-guards-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
