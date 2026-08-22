#!/usr/bin/env bash
# Generator + drift assertions for the per-host agent/command adapters (M4).
# `plugins/fnd/agents-*/`, `commands-opencode/` and the two OpenCode model-profile examples are
# GENERATED and committed: the only thing standing between a hand-edit and a silently divergent
# host is `gen-host-adapters.cjs --check`, which doctor.cjs and CI call. This suite proves the
# generator is deterministic, that --check actually catches every drift shape (edited, deleted,
# stale leftover), and that each host's adapter carries the capability + model facts the plan
# assigns it. Mutations happen only in a scratch copy — the repo tree is read-only here.
# Exit 0 = adapters green.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$ROOT/plugins/fnd"
GEN_REL="scripts/gen-host-adapters.cjs"
GEN="$PLUGIN_DIR/$GEN_REL"
PLAN="$ROOT/HARNESS-PORT-PLAN.md"
NODE_BIN="$(command -v node)"
READONLY_AGENTS="bug-hunter change-reviewer theme-explorer"
GEN_DIRS="agents-cursor agents-codex agents-opencode commands-opencode"
MAP_REL="references/host-model-map.md"
CANON_REL=".claude-plugin/plugin.json"
CANON_MANIFEST="$PLUGIN_DIR/$CANON_REL"
# generated MCP configs living at the plugin root — one per host, plus the Cursor priority profile
MCP_ROOT_FILES="mcp.json mcp.pruned.json mcp-codex.json"
MCP_FRAGMENT_REL="opencode/mcp-fragment.json"

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/gen-adapters-sim.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# fm <file> — the YAML frontmatter block of a markdown file (empty when there is none)
fm() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    const l = fs.readFileSync(process.argv[1], "utf8").split("\n");
    if (l[0] !== "---") process.exit(0);
    for (let i = 1; i < l.length; i++) {
      if (l[i] === "---") break;
      process.stdout.write(l[i] + "\n");
    }
  ' "$1" 2>/dev/null
}

# toml <file> — `key<TAB>value` per top-level key; exits non-zero (with a reason) on anything the
# TOML grammar we emit does not cover. This is the "TOML parses" gate: no TOML library exists in a
# dependency-free repo, so the accepted grammar is spelled out here instead.
toml() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    const lines = fs.readFileSync(process.argv[1], "utf8").split("\n");
    const out = [];
    const seen = new Set();
    const SQ3 = "\u0027\u0027\u0027";
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === "" || l.trimStart().startsWith("#")) continue;
      const m = /^([A-Za-z0-9_]+) = (.*)$/.exec(l);
      if (!m) { console.error("unparseable line " + (i + 1) + ": " + l); process.exit(1); }
      const k = m[1];
      const v = m[2];
      if (seen.has(k)) { console.error("duplicate key: " + k); process.exit(1); }
      seen.add(k);
      if (v === SQ3 || v === "\"\"\"") {
        let j = i + 1;
        for (; j < lines.length; j++) if (lines[j] === v) break;
        if (j >= lines.length) { console.error("unterminated multi-line string: " + k); process.exit(1); }
        out.push(k + "\t<multiline:" + (j - i - 1) + ">");
        i = j;
        continue;
      }
      if (v.startsWith("[")) {
        if (!v.endsWith("]")) { console.error("unterminated array: " + k); process.exit(1); }
        const inner = v.slice(1, -1).trim();
        const items = inner === "" ? [] : inner.split(",").map((s) => s.trim());
        for (const it of items) {
          if (!/^"[^"]*"$/.test(it)) { console.error("bad array item for " + k + ": " + it); process.exit(1); }
        }
        out.push(k + "\t" + items.map((s) => s.slice(1, -1)).join(","));
        continue;
      }
      if (!/^".*"$/.test(v)) { console.error("bad value for " + k + ": " + v); process.exit(1); }
      let parsed;
      try { parsed = JSON.parse(v); } catch (e) { console.error("bad string for " + k); process.exit(1); }
      out.push(k + "\t" + parsed);
    }
    process.stdout.write(out.join("\n") + "\n");
  ' "$1"
}

tval() { toml "$1" 2>/dev/null | awk -F'\t' -v k="$2" '$1 == k { print $2 }'; }

# jnode <file> <expr> [extra…] — evaluate a JS expression against the parsed JSON (bound to `m`) and
# print it. Objects come back as JSON so two of them can be compared with a plain string test; a
# missing value is the empty string, so an assertion never passes on `undefined`. Extra arguments
# reach the expression as `process.argv[3…]` — an expression comparing two files needs the second
# one, and a swallowed argument would make the whole assertion pass vacuously.
jnode() {
  "$NODE_BIN" -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    let v;
    // a throwing expression prints a marker rather than nothing: an assertion that reads "" as
    // "the file is clean" would otherwise pass on a broken probe
    try { v = eval(process.argv[2]); } catch (e) { process.stdout.write("jnode-error: " + e.message); process.exit(0); }
    if (v === undefined || v === null) process.exit(0);
    process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
  ' "$@" 2>/dev/null
}

# fingerprint <plugin-dir> — one sha line per generated file, sorted; the byte-stability probe
fingerprint() {
  # a read loop, not xargs: with no files at all xargs would still run shasum once, on stdin,
  # and the empty tree would fingerprint as a real digest
  ( cd "$1" 2>/dev/null || return 0
    { find $GEN_DIRS opencode -type f 2>/dev/null
      [ -f "$MAP_REL" ] && echo "$MAP_REL"
      for f in $MCP_ROOT_FILES; do [ -f "$f" ] && echo "$f"; done; } |
      sort | while IFS= read -r f; do shasum "$f"; done )
}

# ------------------------------------------------------------------------ generator present --
if [ -x "$GEN" ]; then ok; else bad generator "missing or not executable: $GEN_REL"; fi
if [ -n "$NODE_BIN" ]; then ok; else bad node "node not on PATH"; fi
if [ -z "$NODE_BIN" ] || [ ! -f "$GEN" ]; then
  echo "gen-adapters-sim: $pass passed, $fail failed"
  printf '%s' "$failures"
  exit 1
fi

# ---------------------------------------------------------- committed tree is in sync (--check) --
if "$NODE_BIN" "$GEN" --check >"$TMP/check.out" 2>&1; then ok
else bad check-tree "--check reports drift in the committed tree: $(head -1 "$TMP/check.out")"; fi

# ------------------------------------------------------------ every canonical agent has 3 variants --
agents=""
for f in "$PLUGIN_DIR"/agents/*.md; do
  [ -f "$f" ] || continue
  n="$(basename "$f" .md)"
  agents="$agents $n"
  [ -f "$PLUGIN_DIR/agents-cursor/$n.md" ] && ok || bad "cursor-$n" "agents-cursor/$n.md missing"
  [ -f "$PLUGIN_DIR/agents-codex/$n.toml" ] && ok || bad "codex-$n" "agents-codex/$n.toml missing"
  [ -f "$PLUGIN_DIR/agents-opencode/$n.md" ] && ok || bad "opencode-$n" "agents-opencode/$n.md missing"
done
n_agents="$(printf '%s\n' $agents | wc -w | tr -d ' ')"
if [ "$n_agents" -ge 7 ]; then ok; else bad agent-count "only $n_agents canonical agents found"; fi
for d in agents-cursor agents-codex agents-opencode; do
  c="$(ls -1 "$PLUGIN_DIR/$d" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$c" = "$n_agents" ]; then ok; else bad "count-$d" "$d holds $c files, canonical agents: $n_agents"; fi
done

# ------------------------------------------------------------ every skill has a command shim --
n_skills=0
for d in "$PLUGIN_DIR"/skills/*/; do
  [ -f "$d/SKILL.md" ] || continue
  n="$(basename "$d")"
  n_skills=$((n_skills + 1))
  shim="$PLUGIN_DIR/commands-opencode/$n.md"
  if [ -f "$shim" ]; then ok; else bad "shim-$n" "commands-opencode/$n.md missing"; continue; fi
  if grep -qF "Load and follow the fnd \`$n\` skill, with \$ARGUMENTS as its input." "$shim"; then ok
  else bad "shim-body-$n" "$n shim does not ask for the $n skill with \$ARGUMENTS"; fi
  if grep -qF "\`<plugin root>/skills/$n/SKILL.md\`" "$shim"; then ok
  else bad "shim-path-$n" "$n shim names no bundled fallback path for the skill body"; fi
  # a bare `../skills/…` resolves against the session's cwd, not against the shim — the anchored
  # `<plugin root>/…` form is the only one that survives the symlink install
  if grep -qF '../skills/' "$shim"; then bad "shim-relpath-$n" "$n shim uses an unanchored ../skills/ path"
  else ok; fi
  if fm "$shim" | grep -q '^description: "'; then ok
  else bad "shim-desc-$n" "$n shim carries no description line"; fi
done
c="$(ls -1 "$PLUGIN_DIR/commands-opencode" 2>/dev/null | wc -l | tr -d ' ')"
if [ "$c" = "$n_skills" ]; then ok; else bad shim-count "commands-opencode holds $c shims for $n_skills skills"; fi
# smoke-test is the M4 addition to the skill set — its shim is the one a fresh install runs first
if [ -f "$PLUGIN_DIR/commands-opencode/smoke-test.md" ]; then ok
else bad shim-smoke-test "no /smoke-test shim"; fi

# ------------------------------------------------- adapters are host-neutral about plugin paths --
# `${CLAUDE_PLUGIN_ROOT}` expands on Claude Code and nowhere else: the canonical agents keep it, and
# the generator has to hand every other host the `<plugin root>/…` form plus the anchor sentence
# (same contract as tests/reference-neutral-lint.sh — a subagent reads these bodies standalone).
anchored() { grep -qF "**Plugin root** = the plugin's own directory" "$1"; }
for n in $agents; do
  src="$PLUGIN_DIR/agents/$n.md"
  for f in "$PLUGIN_DIR/agents-cursor/$n.md" "$PLUGIN_DIR/agents-codex/$n.toml" "$PLUGIN_DIR/agents-opencode/$n.md"; do
    [ -f "$f" ] || continue
    lbl="$(basename "$(dirname "$f")")/$n"
    if grep -qF 'CLAUDE_PLUGIN_ROOT' "$f"; then bad "root-var-$lbl" "$lbl leaks \${CLAUDE_PLUGIN_ROOT} — it expands on Claude Code only"
    else ok; fi
    if grep -qF 'CLAUDE_PLUGIN_ROOT' "$src"; then
      grep -qF '<plugin root>/' "$f" && ok || bad "root-form-$lbl" "$lbl dropped the plugin-root paths its source carries"
      anchored "$f" && ok || bad "root-anchor-$lbl" "$lbl uses \`<plugin root>/\` but never defines it"
    else
      # nothing to anchor: the note may not appear where no path needs it
      anchored "$f" && bad "root-anchor-$lbl" "$lbl anchors a plugin root it never uses" || ok
    fi
  done
done
for f in "$PLUGIN_DIR"/commands-opencode/*.md; do
  [ -f "$f" ] || continue
  if grep -qF 'CLAUDE_PLUGIN_ROOT' "$f"; then bad "root-var-shim-$(basename "$f")" "shim leaks \${CLAUDE_PLUGIN_ROOT}"
  else ok; fi
done

# ----------------------------------------------------- OpenCode agents carry no model pin ever --
for n in $agents; do
  f="$PLUGIN_DIR/agents-opencode/$n.md"
  [ -f "$f" ] || continue
  if fm "$f" | grep -q '^model:'; then bad "opencode-model-$n" "$n.md pins a model — OpenCode inherits the session model"
  else ok; fi
  if fm "$f" | grep -q '^mode: subagent$'; then ok; else bad "opencode-mode-$n" "$n.md is not mode: subagent"; fi
done

# --------------------------------------------------------- read-only trio, one shape per host --
is_readonly() { case " $READONLY_AGENTS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
for n in $agents; do
  cur="$PLUGIN_DIR/agents-cursor/$n.md"
  oc="$PLUGIN_DIR/agents-opencode/$n.md"
  cx="$PLUGIN_DIR/agents-codex/$n.toml"
  [ -f "$cur" ] && [ -f "$oc" ] && [ -f "$cx" ] || continue
  if is_readonly "$n"; then
    fm "$cur" | grep -q '^readonly: true$' && ok || bad "ro-cursor-$n" "$n.md has no 'readonly: true'"
    [ "$(tval "$cx" sandbox_mode)" = "read-only" ] && ok || bad "ro-codex-$n" "$n.toml sandbox_mode is not read-only"
    fm "$oc" | grep -q '^  edit: false$' && ok || bad "ro-oc-edit-$n" "$n.md does not disable the edit tool"
    fm "$oc" | grep -q '^  write: false$' && ok || bad "ro-oc-write-$n" "$n.md does not disable the write tool"
    fm "$oc" | grep -q '^  edit: deny$' && ok || bad "ro-oc-perm-$n" "$n.md has no 'permission: edit: deny'"
  else
    fm "$cur" | grep -q '^readonly:' && bad "rw-cursor-$n" "$n.md is marked readonly but writes its extract" || ok
    [ -z "$(tval "$cx" sandbox_mode)" ] && ok || bad "rw-codex-$n" "$n.toml sandboxes a writing agent"
    fm "$oc" | grep -q '^permission:' && bad "rw-oc-$n" "$n.md denies edits to a writing agent" || ok
  fi
done

# ------------------------------------------------------------------- Codex TOML is well-formed --
for n in $agents; do
  f="$PLUGIN_DIR/agents-codex/$n.toml"
  [ -f "$f" ] || continue
  if toml "$f" >"$TMP/toml.out" 2>"$TMP/toml.err"; then ok
  else bad "toml-$n" "$n.toml does not parse: $(head -1 "$TMP/toml.err")"; fi
  for k in name description model model_reasoning_effort developer_instructions; do
    if awk -F'\t' -v k="$k" '$1 == k { found = 1 } END { exit !found }' "$TMP/toml.out"; then ok
    else bad "toml-key-$n-$k" "$n.toml has no $k"; fi
  done
  [ "$(tval "$f" name)" = "$n" ] && ok || bad "toml-name-$n" "$n.toml name is not $n"
  case "$(tval "$f" developer_instructions)" in
    '<multiline:'*) ok ;;
    *) bad "toml-body-$n" "$n.toml developer_instructions is not a multi-line block" ;;
  esac
done

# mcp_servers scoping — the readers/writer are pinned to the server their canonical tools imply
[ "$(tval "$PLUGIN_DIR/agents-codex/jira-reader.toml" mcp_servers)" = "atlassian" ] && ok \
  || bad mcp-jira-reader "jira-reader.toml is not scoped to the atlassian server"
[ "$(tval "$PLUGIN_DIR/agents-codex/jira-writer.toml" mcp_servers)" = "atlassian" ] && ok \
  || bad mcp-jira-writer "jira-writer.toml is not scoped to the atlassian server"
[ "$(tval "$PLUGIN_DIR/agents-codex/figma-reader.toml" mcp_servers)" = "figma-dev-mode" ] && ok \
  || bad mcp-figma-reader "figma-reader.toml is not scoped to the figma server"
if toml "$PLUGIN_DIR/agents-codex/doc-reader.toml" 2>/dev/null | grep -q '^mcp_servers'; then
  bad mcp-doc-reader "doc-reader.toml scopes MCP — it reads Confluence, Notion and the web"
else ok; fi
# every scoped server must exist in the canonical MCP list, or the scoping silently disables the agent
for n in $agents; do
  f="$PLUGIN_DIR/agents-codex/$n.toml"
  [ -f "$f" ] || continue
  v="$(tval "$f" mcp_servers)"
  [ -n "$v" ] || continue
  for s in $(printf '%s' "$v" | tr ',' ' '); do
    if "$NODE_BIN" -e '
      const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.exit(Object.keys(m.mcpServers || {}).includes(process.argv[2]) ? 0 : 1);
    ' "$PLUGIN_DIR/.claude-plugin/plugin.json" "$s"; then ok
    else bad "mcp-unknown-$n" "$n.toml scopes unknown MCP server '$s'"; fi
  done
done

# --------------------------------------------------------------- model table vs the plan tables --
cursor_model() { fm "$PLUGIN_DIR/agents-cursor/$1.md" | awk -F': ' '$1 == "model" { print $2 }'; }
for n in $agents; do
  case "$(cursor_model "$n")" in
    composer|sonnet|gpt-5.5|opus) ok ;;
    *) bad "cursor-model-$n" "$n pins '$(cursor_model "$n")' — not a least-versioned guidelines id" ;;
  esac
  case "$(tval "$PLUGIN_DIR/agents-codex/$n.toml" model_reasoning_effort)" in
    low|medium|high|xhigh) ok ;;
    *) bad "codex-effort-$n" "$n.toml reasoning effort is not a Codex tier" ;;
  esac
done
# per-agent rows: the Cursor scenario table is the source of truth for the pins
check_row() {
  [ "$(cursor_model "$1")" = "$2" ] && ok || bad "row-cursor-$1" "$1 pins '$(cursor_model "$1")', plan says '$2'"
  m="$(tval "$PLUGIN_DIR/agents-codex/$1.toml" model)"
  [ "$m" = "$3" ] && ok || bad "row-codex-$1" "$1.toml pins '$m', proposed map says '$3'"
}
check_row bug-hunter gpt-5.5 gpt-5.6-sol
check_row change-reviewer sonnet gpt-5.6-terra
check_row theme-explorer sonnet gpt-5.6-terra
check_row doc-reader composer gpt-5.6-luna
check_row figma-reader composer gpt-5.6-luna
check_row jira-reader composer gpt-5.6-luna
check_row jira-writer composer gpt-5.6-luna
# bug-hunter is the one agent whose ladder escalates past its pin — the rung is recorded in the file
if fm "$PLUGIN_DIR/agents-cursor/bug-hunter.md" | grep -q '^# escalate: opus'; then ok
else bad escalate-bug-hunter "bug-hunter.md does not record the Opus escalation rung"; fi
# the Codex column is unsigned-off — every generated file must say so where a reader will see it
for n in $agents; do
  if grep -q 'proposed — owner sign-off pending' "$PLUGIN_DIR/agents-codex/$n.toml"; then ok
  else bad "codex-proposed-$n" "$n.toml does not mark the model map as proposed"; fi
done

if [ -f "$PLAN" ]; then
  for id in gpt-5.6-luna gpt-5.6-terra gpt-5.6-sol; do
    if grep -qF "$id" "$PLAN"; then ok; else bad "plan-codex-$id" "$id is not in the plan's proposed map"; fi
  done
  for n in $agents; do
    m="$(tval "$PLUGIN_DIR/agents-codex/$n.toml" model)"
    if grep -qF "$m" "$PLAN"; then ok; else bad "plan-codex-$n" "$n.toml pins '$m', absent from the plan"; fi
  done
  if grep -qF 'Composer 2.5 → Claude Sonnet → GPT-5.5 → Claude Opus' "$PLAN"; then ok
  else bad plan-ladder "the plan's Cursor ladder changed — re-check MODEL_TABLE"; fi
else
  ok
fi

# ------------------------------------------- the generated map is the only prose home for a pin --
# The generator's tier table is the single point of change for model churn. That only holds while
# no OTHER file spells an id out: a stale copy in a skill or reference survives a rename, ships a
# retired model to a live phase, and every suite stays green. So: the map must exist, agree with
# the adapters it was generated from, and be the only place outside agents-codex/ + the generator
# where a Codex id appears.
MAP="$PLUGIN_DIR/references/host-model-map.md"
if [ -f "$MAP" ]; then ok; else bad map-missing "references/host-model-map.md not generated"; fi
if [ -f "$MAP" ]; then
  if head -5 "$MAP" | grep -qF 'GENERATED by scripts/gen-host-adapters.cjs'; then ok
  else bad map-genmark "the map does not mark itself generated"; fi
  for n in $agents; do
    m="$(tval "$PLUGIN_DIR/agents-codex/$n.toml" model)"
    if grep -q "^| \`$n\` .*\`$m\`" "$MAP"; then ok
    else bad "map-codex-$n" "the map's $n row does not carry the pinned '$m'"; fi
    c="$(cursor_model "$n")"
    if grep -q "^| \`$n\` .*\`$c\`" "$MAP"; then ok
    else bad "map-cursor-$n" "the map's $n row does not carry the pinned '$c'"; fi
  done
  for t in routine standard deep-review precision; do
    if grep -q "^| \`$t\`" "$MAP"; then ok; else bad "map-tier-$t" "the map has no '$t' tier row"; fi
  done
  for class in conductor reasoning-heavy mechanical; do
    if grep -q "^| $class —" "$MAP"; then ok
    else bad "map-phase-$class" "the map has no '$class' ship-phase row"; fi
  done
  if grep -qF 'PROPOSED' "$MAP"; then ok; else bad map-proposed "the map does not mark the Codex column proposed"; fi
fi
# pipeline-mode.md hands the ship conductor its phase models: it must point at the map, not repeat it
PIPELINE="$PLUGIN_DIR/references/pipeline-mode.md"
if [ -f "$PIPELINE" ]; then
  if grep -qF 'host-model-map.md' "$PIPELINE"; then ok
  else bad pipeline-map-link "pipeline-mode.md does not point at host-model-map.md for the off-Claude pins"; fi
fi
# the second-home guard itself
strays="$(grep -rlE 'gpt-5\.6-[a-z]+' "$PLUGIN_DIR" 2>/dev/null |
  grep -v "^$PLUGIN_DIR/agents-codex/" |
  grep -v "^$PLUGIN_DIR/$GEN_REL$" |
  grep -v "^$MAP$" || true)"
if [ -z "$strays" ]; then ok
else bad model-id-second-home "a Codex model id is pinned outside the generator + its output: $(printf '%s' "$strays" | tr '\n' ' ')"; fi

# ---------------------------------------------------- OpenCode model-profile example fragments --
for v in cloud local; do
  f="$PLUGIN_DIR/opencode/model-profile.$v.example.json"
  if [ -f "$f" ]; then ok; else bad "profile-$v" "opencode/model-profile.$v.example.json missing"; continue; fi
  "$NODE_BIN" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$f" 2>/dev/null \
    && ok || bad "profile-json-$v" "$v profile is not valid JSON"
  keys="$("$NODE_BIN" -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(Object.keys(m.agent || {}).join(" "));
  ' "$f" 2>/dev/null)"
  if [ "$(printf '%s\n' $keys | wc -w | tr -d ' ')" = "$n_agents" ]; then ok
  else bad "profile-agents-$v" "$v profile covers '$keys', expected $n_agents agents"; fi
  if grep -q '"_comment"' "$f" && grep -q 'PROPOSED' "$f"; then ok
  else bad "profile-comment-$v" "$v profile does not mark the map proposed/user-editable"; fi
done
if grep -q 'anthropic/' "$PLUGIN_DIR/opencode/model-profile.cloud.example.json" 2>/dev/null; then ok
else bad profile-cloud-ids "the cloud profile carries no anthropic ids"; fi
if grep -q 'ollama/' "$PLUGIN_DIR/opencode/model-profile.local.example.json" 2>/dev/null; then ok
else bad profile-local-ids "the local profile carries no ollama ids"; fi

# ------------------------------------------------------- generated MCP configs, one per host (M6) --
# The canonical `mcpServers` block is the single server list; mcp.json (Cursor), mcp-codex.json (Codex)
# and opencode/mcp-fragment.json are translations of it, and mcp.pruned.json is the Cursor priority
# profile for the reported ~40-tool cap. What matters and is asserted here: nothing is lost in
# translation (server parity), each host gets ITS shape (array command + `environment` on OpenCode,
# explicit `type: "stdio"` on Cursor, carried-as-is on Codex), and the passthrough values that carry
# auth — env, headers, urls — come through byte-identical instead of being re-typed.
MCP_CURSOR="$PLUGIN_DIR/mcp.json"
MCP_PRUNED="$PLUGIN_DIR/mcp.pruned.json"
MCP_CODEX="$PLUGIN_DIR/mcp-codex.json"
MCP_OPENCODE="$PLUGIN_DIR/$MCP_FRAGMENT_REL"

for f in "$MCP_CURSOR" "$MCP_PRUNED" "$MCP_CODEX" "$MCP_OPENCODE"; do
  lbl="$(basename "$f")"
  if [ -f "$f" ]; then ok; else bad "mcp-missing-$lbl" "$lbl not generated"; continue; fi
  "$NODE_BIN" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$f" 2>/dev/null \
    && ok || bad "mcp-json-$lbl" "$lbl is not valid JSON"
  # the generated marker has to survive into every host file, or a hand-edit looks legitimate
  if grep -qF 'GENERATED by scripts/gen-host-adapters.cjs' "$f"; then ok
  else bad "mcp-genmark-$lbl" "$lbl does not mark itself generated"; fi
  # `_comment` is the only place JSON can hold a note; it must never sit INSIDE a server definition,
  # where a strict host loader would hand an invented key to a spawn config
  stray="$(jnode "$f" '
    (() => {
      const out = [];
      for (const block of [m.mcpServers, m.mcp]) {
        if (!block) continue;
        for (const [k, v] of Object.entries(block)) {
          for (const key of Object.keys(v)) if (key.startsWith("_")) out.push(k + "." + key);
        }
      }
      return out.join(" ");
    })()')"
  if [ -z "$stray" ]; then ok; else bad "mcp-comment-$lbl" "$lbl puts a note inside a server def: $stray"; fi
done

canon_servers="$(jnode "$CANON_MANIFEST" 'Object.keys(m.mcpServers).sort().join(" ")')"
n_mcp="$(printf '%s\n' $canon_servers | wc -w | tr -d ' ')"
if [ "$n_mcp" -ge 6 ]; then ok; else bad mcp-canon-count "only $n_mcp canonical MCP servers found"; fi

# server-count parity: a server that never reaches a host config is a tool that is simply absent in
# a live session, with nothing anywhere saying why
for pair in "$MCP_CURSOR:mcpServers" "$MCP_CODEX:mcpServers" "$MCP_OPENCODE:mcp"; do
  f="${pair%:*}"; key="${pair##*:}"
  [ -f "$f" ] || continue
  lbl="$(basename "$f")"
  got="$(jnode "$f" "Object.keys(m.$key).sort().join(' ')")"
  if [ "$got" = "$canon_servers" ]; then ok
  else bad "mcp-parity-$lbl" "$lbl carries '$got', canonical is '$canon_servers'"; fi
done

# Cursor: transports are explicit, because a file holding both stdio and remote entries should not
# leave one of them relying on a host default
if [ -f "$MCP_CURSOR" ]; then
  bad_shape="$(jnode "$MCP_CURSOR" '
    (() => {
      const c = JSON.parse(require("fs").readFileSync(process.argv[3] || "", "utf8"));
      const out = [];
      for (const [n, v] of Object.entries(m.mcpServers)) {
        const src = c.mcpServers[n];
        if (src.command) {
          if (v.type !== "stdio") out.push(n + ":type=" + v.type);
          if (v.command !== src.command) out.push(n + ":command");
          if (JSON.stringify(v.args || []) !== JSON.stringify(src.args || [])) out.push(n + ":args");
        } else {
          if (v.type !== (src.type || "http")) out.push(n + ":type=" + v.type);
          if (v.url !== src.url) out.push(n + ":url");
        }
      }
      return out.join(" ");
    })()' "$CANON_MANIFEST")"
  if [ -z "$bad_shape" ]; then ok; else bad mcp-cursor-shape "mcp.json entries diverge: $bad_shape"; fi
fi

# Codex: a plain translation — the plugin bundles the Claude `mcpServers` shape, so a command server
# must NOT grow a type key the canonical list does not have, and the SSE server rides as-is
if [ -f "$MCP_CODEX" ]; then
  bad_shape="$(jnode "$MCP_CODEX" '
    (() => {
      const c = JSON.parse(require("fs").readFileSync(process.argv[3] || "", "utf8"));
      const out = [];
      for (const [n, v] of Object.entries(m.mcpServers)) {
        const src = c.mcpServers[n];
        if (JSON.stringify(v) !== JSON.stringify(src)) out.push(n);
      }
      return out.join(" ");
    })()' "$CANON_MANIFEST")"
  if [ -z "$bad_shape" ]; then ok; else bad mcp-codex-verbatim "mcp-codex.json entries are not carried as-is: $bad_shape"; fi
  if [ "$(jnode "$MCP_CODEX" 'm.mcpServers["figma-dev-mode"].type')" = "sse" ]; then ok
  else bad mcp-codex-sse "the figma SSE server is not carried as an sse entry"; fi
  # the one unverified transport has to say so, with the manual route spelled out
  if grep -qF 'M1B-VERIFY' "$MCP_CODEX" && grep -qF 'codex mcp add' "$MCP_CODEX"; then ok
  else bad mcp-codex-sse-note "mcp-codex.json records no SSE verify item + manual fallback"; fi
  # and the Codex manifest pointer must land on it
  ptr="$(jnode "$PLUGIN_DIR/.codex-plugin/plugin.json" 'm.mcpServers')"
  if [ -f "$PLUGIN_DIR/${ptr#./}" ]; then ok
  else bad mcp-codex-pointer "the Codex manifest points at '$ptr', which does not exist"; fi
  # …and it may NOT be called `.mcp.json`: that name is a Claude Code plugin component, loaded on
  # top of the canonical manifest's own mcpServers block, so a Codex-only edit would change what
  # Claude Code loads — the one behavior this port freezes.
  case "$ptr" in *.mcp.json) bad mcp-codex-name "the Codex config uses Claude Code's .mcp.json component name" ;; *) ok ;; esac
fi
if [ -e "$PLUGIN_DIR/.mcp.json" ]; then
  bad mcp-claude-collision "plugins/fnd/.mcp.json exists — Claude Code would load it beside the canonical mcpServers block"
else ok; fi

# OpenCode: the one host with a different shape — argv ARRAY, `environment`, local/remote
if [ -f "$MCP_OPENCODE" ]; then
  bad_shape="$(jnode "$MCP_OPENCODE" '
    (() => {
      const c = JSON.parse(require("fs").readFileSync(process.argv[3] || "", "utf8"));
      const out = [];
      for (const [n, v] of Object.entries(m.mcp)) {
        const src = c.mcpServers[n];
        if (v.env) out.push(n + ":env-not-environment");
        if (src.command) {
          if (v.type !== "local") out.push(n + ":type=" + v.type);
          if (!Array.isArray(v.command)) out.push(n + ":command-not-array");
          else if (JSON.stringify(v.command) !== JSON.stringify([src.command].concat(src.args || [])))
            out.push(n + ":command-argv");
        } else {
          if (v.type !== "remote") out.push(n + ":type=" + v.type);
          if (v.url !== src.url) out.push(n + ":url");
          if (v.command) out.push(n + ":remote-with-command");
        }
      }
      return out.join(" ");
    })()' "$CANON_MANIFEST")"
  if [ -z "$bad_shape" ]; then ok; else bad mcp-opencode-shape "the fragment diverges: $bad_shape"; fi
  # it is a fragment, not a config: the block a user pastes is `mcp`, and nothing else may claim it
  if [ -n "$(jnode "$MCP_OPENCODE" 'm.mcp')" ] && [ -z "$(jnode "$MCP_OPENCODE" 'm.mcpServers')" ]; then ok
  else bad mcp-opencode-key "the fragment does not use the OpenCode `mcp` key"; fi
  if grep -qF 'M1C-VERIFY' "$MCP_OPENCODE"; then ok
  else bad mcp-opencode-note "the fragment records no verify item for the SSE endpoint"; fi
fi

# env / headers / urls travel verbatim. The canonical list holds plain switches today and passthrough
# forms tomorrow; either way, a value re-typed on the way to a host is how a server quietly stops
# authenticating, and no suite would notice.
carried="$("$NODE_BIN" -e '
  const fs = require("fs");
  const [canon, cursor, codex, oc] = process.argv.slice(1).map((p) => JSON.parse(fs.readFileSync(p, "utf8")));
  const out = [];
  const eq = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  for (const [n, src] of Object.entries(canon.mcpServers)) {
    if (!eq(cursor.mcpServers[n].env, src.env)) out.push("cursor:" + n + ":env");
    if (!eq(codex.mcpServers[n].env, src.env)) out.push("codex:" + n + ":env");
    if (!eq(oc.mcp[n].environment, src.env)) out.push("opencode:" + n + ":environment");
    for (const [label, v] of [["cursor", cursor.mcpServers[n]], ["codex", codex.mcpServers[n]], ["opencode", oc.mcp[n]]]) {
      if (!eq(v.headers, src.headers)) out.push(label + ":" + n + ":headers");
      if (src.url && v.url !== src.url) out.push(label + ":" + n + ":url");
    }
  }
  process.stdout.write(out.join(" "));
' "$CANON_MANIFEST" "$MCP_CURSOR" "$MCP_CODEX" "$MCP_OPENCODE" 2>/dev/null)"
if [ -z "$carried" ]; then ok; else bad mcp-passthrough "a passthrough value was rewritten: $carried"; fi

# no secret ever enters a generated config. The canonical list authenticates through the host's own
# OAuth/keychain and through passthrough placeholders — a literal credential in any of these files
# would be committed to a public repo by the next regeneration.
leaked="$("$NODE_BIN" -e '
  const fs = require("fs");
  const SECRETISH = /(sk-[A-Za-z0-9]{8}|ghp_[A-Za-z0-9]|xox[baprs]-|shpat_|shpss_|-----BEGIN |eyJ[A-Za-z0-9_-]{10})/;
  const NAMED = /(token|secret|password|passwd|api[-_]?key|credential|auth)/i;
  const out = [];
  for (const p of process.argv.slice(1)) {
    const walk = (node, trail) => {
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) walk(v, trail ? trail + "." + k : k);
        return;
      }
      if (typeof node !== "string") return;
      const leaf = trail.split(".").pop();
      if (SECRETISH.test(node)) out.push(p.split("/").pop() + ":" + trail + ":literal");
      // A credential-shaped KEY may only carry an explicit passthrough reference — `${VAR}` or
      // `$VAR`. A bare word is rejected on purpose: most secrets are bare words, and a config that
      // wants an env var can always say so with the dollar.
      if (NAMED.test(leaf) && !/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(node)) {
        out.push(p.split("/").pop() + ":" + trail + ":inline");
      }
    };
    walk(JSON.parse(fs.readFileSync(p, "utf8")), "");
  }
  process.stdout.write(out.join(" "));
' "$MCP_CURSOR" "$MCP_PRUNED" "$MCP_CODEX" "$MCP_OPENCODE" 2>/dev/null)"
if [ -z "$leaked" ]; then ok; else bad mcp-secret-leak "a generated MCP config carries a credential: $leaked"; fi

# --------------------------------------------------- the Cursor priority profile (~40-tool cap) --
# No evidence exists for a per-server disable key in Cursor's mcp.json, so the pruned list ships as
# its own file: a reference profile no host loads. It has to be a genuine PREFIX of the plan's
# ranking (atlassian > shopify-dev > one browser > figma > notion) and byte-identical to mcp.json for
# every server it keeps — a profile that quietly re-types an entry is worse than no profile.
if [ -f "$MCP_PRUNED" ] && [ -f "$MCP_CURSOR" ]; then
  kept="$(jnode "$MCP_PRUNED" 'Object.keys(m.mcpServers).join(" ")')"
  n_kept="$(printf '%s\n' $kept | wc -w | tr -d ' ')"
  if [ "$n_kept" -ge 2 ] && [ "$n_kept" -lt "$n_mcp" ]; then ok
  else bad mcp-pruned-size "the profile keeps $n_kept of $n_mcp servers — that is not a pruning"; fi
  # the plan's ranking, highest first: walk it and note the first absentee — nothing kept may
  # appear after it, or the profile is no longer the priority list it claims to be
  prefix_ok=1; seen_gap=0
  for s in atlassian shopify-dev-mcp chrome-devtools-mcp figma-dev-mode playwright notion-mcp; do
    case " $kept " in
      *" $s "*) [ "$seen_gap" = 1 ] && prefix_ok=0 ;;
      *) seen_gap=1 ;;
    esac
  done
  if [ "$prefix_ok" = 1 ]; then ok
  else bad mcp-pruned-order "the kept set '$kept' is not a prefix of the plan's priority ranking"; fi
  case " $kept " in
    *" atlassian "*) ok ;;
    *) bad mcp-pruned-atlassian "the profile drops atlassian — the top-priority server" ;;
  esac
  # exactly one browser stack survives: keeping both is what the cap makes impossible
  browsers=0
  case " $kept " in *" chrome-devtools-mcp "*) browsers=$((browsers + 1)) ;; esac
  case " $kept " in *" playwright "*) browsers=$((browsers + 1)) ;; esac
  if [ "$browsers" -le 1 ]; then ok
  else bad mcp-pruned-browsers "the profile keeps both browser servers"; fi
  same="$("$NODE_BIN" -e '
    const fs = require("fs");
    const [full, pruned] = process.argv.slice(1).map((p) => JSON.parse(fs.readFileSync(p, "utf8")));
    const out = [];
    for (const [n, v] of Object.entries(pruned.mcpServers)) {
      if (JSON.stringify(v) !== JSON.stringify(full.mcpServers[n])) out.push(n);
    }
    process.stdout.write(out.join(" "));
  ' "$MCP_CURSOR" "$MCP_PRUNED" 2>/dev/null)"
  if [ -z "$same" ]; then ok; else bad mcp-pruned-drift "the profile re-types entries: $same"; fi
  # the rationale + the way back travel with the file, not only in the README
  if [ "$(jnode "$MCP_PRUNED" 'Array.isArray(m._priority) ? m._priority.length : 0')" = "$n_mcp" ]; then ok
  else bad mcp-pruned-rationale "the profile does not rank all $n_mcp servers with a reason each"; fi
  if grep -qF 'M1A-VERIFY' "$MCP_PRUNED" && grep -qF 'M1A-VERIFY' "$MCP_CURSOR"; then ok
  else bad mcp-pruned-verify "the unmeasured cap is not marked as a verify item"; fi
  # every dropped server must be named where the user reads about the cap, or the profile is a
  # silent downgrade
  dropped_named=1
  for s in $canon_servers; do
    case " $kept " in *" $s "*) continue ;; esac
    grep -qF "$s" "$MCP_CURSOR" || dropped_named=0
  done
  if [ "$dropped_named" = 1 ]; then ok
  else bad mcp-pruned-dropnames "mcp.json does not name the servers the profile drops"; fi
fi

# README owns the human-facing half: which servers get pruned on Cursor and how to get one back
if grep -qF 'mcp.pruned.json' "$ROOT/README.md"; then ok
else bad mcp-readme "README does not document the Cursor pruning profile"; fi

# ------------------------------------------------------------------- scratch copy: mutations --
COPY="$TMP/fnd"
mkdir -p "$COPY"
cp -R "$PLUGIN_DIR/agents" "$PLUGIN_DIR/skills" "$PLUGIN_DIR/scripts" "$PLUGIN_DIR/.claude-plugin" "$COPY/" 2>/dev/null
for d in $GEN_DIRS; do cp -R "$PLUGIN_DIR/$d" "$COPY/"; done
cp -R "$PLUGIN_DIR/opencode" "$COPY/"
# only the generated reference travels: the rest of references/ is hand-written and untouched here
mkdir -p "$COPY/references"
cp "$PLUGIN_DIR/$MAP_REL" "$COPY/$MAP_REL" 2>/dev/null
# the generated MCP configs sit at the plugin root, next to hand-written files, so they are copied
# by name rather than by directory
for f in $MCP_ROOT_FILES; do cp "$PLUGIN_DIR/$f" "$COPY/$f" 2>/dev/null; done
CGEN="$COPY/$GEN_REL"

# byte-stability: a second run over an already-generated tree must not touch a single byte
before="$(fingerprint "$COPY")"
"$NODE_BIN" "$CGEN" >/dev/null 2>&1
mid="$(fingerprint "$COPY")"
"$NODE_BIN" "$CGEN" >/dev/null 2>&1
after="$(fingerprint "$COPY")"
if [ "$before" = "$mid" ] && [ "$mid" = "$after" ]; then ok
else bad idempotent "regeneration is not byte-stable"; fi
if [ -n "$before" ]; then ok; else bad fingerprint "no generated files found in the scratch copy"; fi

# a hand-edit is drift
printf '\nhand-edited\n' >> "$COPY/agents-cursor/bug-hunter.md"
if "$NODE_BIN" "$CGEN" --check >"$TMP/m1" 2>&1; then bad drift-edit "--check passed an edited adapter"
else grep -q 'agents-cursor/bug-hunter.md differs' "$TMP/m1" && ok \
  || bad drift-edit-msg "--check named no edited file: $(head -1 "$TMP/m1")"; fi

# a deleted adapter is drift
rm -f "$COPY/agents-codex/jira-reader.toml"
if "$NODE_BIN" "$CGEN" --check >"$TMP/m2" 2>&1; then bad drift-missing "--check passed a deleted adapter"
else grep -q 'agents-codex/jira-reader.toml is missing' "$TMP/m2" && ok \
  || bad drift-missing-msg "--check did not report the deletion: $(head -1 "$TMP/m2")"; fi

# the generated reference is drift-checked like any adapter — it lives among hand-written files,
# so an "obvious little fix" to a model id there is exactly the edit that must not survive
printf '\nhand-edited\n' >> "$COPY/$MAP_REL"
if "$NODE_BIN" "$CGEN" --check >"$TMP/m2b" 2>&1; then bad drift-map "--check passed an edited host-model-map.md"
else grep -q "$MAP_REL differs" "$TMP/m2b" && ok \
  || bad drift-map-msg "--check did not report the edited map: $(head -1 "$TMP/m2b")"; fi

# a leftover from a renamed source is drift too — nothing canonical produces it any more
printf 'stale\n' > "$COPY/commands-opencode/removed-skill.md"
if "$NODE_BIN" "$CGEN" --check >"$TMP/m3" 2>&1; then bad drift-stale "--check passed a stale adapter"
else grep -q 'commands-opencode/removed-skill.md is stale' "$TMP/m3" && ok \
  || bad drift-stale-msg "--check did not report the leftover: $(head -1 "$TMP/m3")"; fi

# regenerating repairs all three shapes, including deleting the leftover
"$NODE_BIN" "$CGEN" >/dev/null 2>&1
if "$NODE_BIN" "$CGEN" --check >"$TMP/m4" 2>&1; then ok
else bad repair "a regeneration did not restore sync: $(head -1 "$TMP/m4")"; fi
if [ -f "$COPY/commands-opencode/removed-skill.md" ]; then bad repair-prune "the stale shim survived a regeneration"
else ok; fi
if [ "$(fingerprint "$COPY")" = "$after" ]; then ok; else bad repair-bytes "the repaired tree differs from the committed one"; fi

# a new skill gets a shim without touching the generator
mkdir -p "$COPY/skills/zz-probe"
printf -- '---\nname: zz-probe\ndescription: Probe skill for the adapter generator test.\n---\n\nbody\n' \
  > "$COPY/skills/zz-probe/SKILL.md"
"$NODE_BIN" "$CGEN" >/dev/null 2>&1
if [ -f "$COPY/commands-opencode/zz-probe.md" ]; then ok; else bad new-skill "a new skill got no command shim"; fi
rm -rf "$COPY/skills/zz-probe"
"$NODE_BIN" "$CGEN" >/dev/null 2>&1
if [ -f "$COPY/commands-opencode/zz-probe.md" ]; then bad new-skill-prune "the probe shim survived its skill"
else ok; fi

# a plugin-root path added to a canonical agent is neutralized on the way out, not carried through
"$NODE_BIN" -e '
  const fs = require("fs"), p = process.argv[1];
  const t = fs.readFileSync(p, "utf8");
  fs.writeFileSync(p, t + "\nProbe: read `${CLAUDE_PLUGIN_ROOT}/references/zz-probe.md` first.\n");
' "$COPY/agents/theme-explorer.md"
"$NODE_BIN" "$CGEN" >/dev/null 2>&1
probe_ok=1
for f in "$COPY/agents-cursor/theme-explorer.md" "$COPY/agents-codex/theme-explorer.toml" "$COPY/agents-opencode/theme-explorer.md"; do
  grep -qF 'CLAUDE_PLUGIN_ROOT' "$f" && probe_ok=0
  grep -qF '<plugin root>/references/zz-probe.md' "$f" || probe_ok=0
  grep -qF "**Plugin root** = the plugin's own directory" "$f" || probe_ok=0
done
[ "$probe_ok" = 1 ] && ok || bad root-rewrite "a canonical \${CLAUDE_PLUGIN_ROOT} path reached the adapters unneutralized"
"$NODE_BIN" -e '
  const fs = require("fs"), p = process.argv[1];
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/\nProbe: read [^\n]*\n$/, ""));
' "$COPY/agents/theme-explorer.md"
"$NODE_BIN" "$CGEN" >/dev/null 2>&1
if [ "$(fingerprint "$COPY")" = "$after" ]; then ok
else bad root-rewrite-restore "the probe left the scratch tree changed"; fi

# the TOML fallback path: an agent body carrying ''' cannot ship as a literal block, so the
# generator switches to an escaped basic block. No canonical body triggers it today, which is
# exactly why it needs a test — the day a fenced example lands, a broken escape would show up
# only as a Codex subagent behaving oddly at runtime.
"$NODE_BIN" -e '
  const fs = require("fs"), p = process.argv[1];
  const probe = "\nProbe fence:\n\u0027\u0027\u0027\nliteral \u0027\u0027\u0027 inside\n" +
    "C:\\path\\to\\thing and a lone quote\"\n\u0027\u0027\u0027\n";
  fs.writeFileSync(p, fs.readFileSync(p, "utf8") + probe);
' "$COPY/agents/theme-explorer.md"
"$NODE_BIN" "$CGEN" >/dev/null 2>&1
TOML_PROBE="$COPY/agents-codex/theme-explorer.toml"
if grep -q '^developer_instructions = """$' "$TOML_PROBE"; then ok
else bad toml-escape-branch "a body containing ''' did not switch to the escaped block"; fi
if toml "$TOML_PROBE" >/dev/null 2>&1; then ok
else bad toml-escape-parse "the escaped block does not parse: $(toml "$TOML_PROBE" 2>&1 | head -1)"; fi
"$NODE_BIN" -e '
  const fs = require("fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").split("\n");
  const start = lines.indexOf("developer_instructions = \"\"\"");
  if (start === -1) process.exit(1);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) if (lines[i] === "\"\"\"") { end = i; break; }
  if (end === -1) process.exit(1);
  // TOML basic-string unescaping, restricted to the escapes this generator emits
  const body = lines.slice(start + 1, end).join("\n").replace(/\\(["\\])/g, "$1");
  const want = "Probe fence:\n\u0027\u0027\u0027\nliteral \u0027\u0027\u0027 inside\n" +
    "C:\\path\\to\\thing and a lone quote\"\n\u0027\u0027\u0027";
  process.exit(body.endsWith(want) ? 0 : 1);
' "$TOML_PROBE" && ok || bad toml-escape-roundtrip "the escaped block does not decode back to the agent body"
"$NODE_BIN" -e '
  const fs = require("fs"), p = process.argv[1];
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/\nProbe fence:[\s\S]*$/, "\n"));
' "$COPY/agents/theme-explorer.md"
"$NODE_BIN" "$CGEN" >/dev/null 2>&1
if [ "$(fingerprint "$COPY")" = "$after" ]; then ok
else bad toml-escape-restore "the TOML probe left the scratch tree changed"; fi

# an agent with no row in the model table must stop the generator, never ship unpinned
cp "$COPY/agents/jira-reader.md" "$COPY/agents/zz-unpinned.md"
"$NODE_BIN" -e '
  const fs = require("fs"), p = process.argv[1];
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("name: jira-reader", "name: zz-unpinned"));
' "$COPY/agents/zz-unpinned.md"
"$NODE_BIN" "$CGEN" >"$TMP/m5" 2>&1
rc=$?
if [ "$rc" != 0 ] && grep -q 'MODEL_TABLE' "$TMP/m5"; then ok
else bad unpinned-agent "an agent absent from MODEL_TABLE generated anyway (exit $rc)"; fi
rm -f "$COPY/agents/zz-unpinned.md"
"$NODE_BIN" "$CGEN" >/dev/null 2>&1

# ------------------------------------------------- scratch copy: the MCP configs are drift-checked --
# The host configs are generated like every adapter, but they sit among hand-written files at the
# plugin root, where "just add the server here" is the obvious thing to do — and an edit that only
# lands in one host's file is exactly the divergence this repo has no other guard against.
printf '{"mcpServers":{}}\n' > "$COPY/mcp.json"
if "$NODE_BIN" "$CGEN" --check >"$TMP/m6" 2>&1; then bad drift-mcp "--check passed an edited mcp.json"
else grep -q 'mcp.json differs' "$TMP/m6" && ok \
  || bad drift-mcp-msg "--check named no edited MCP config: $(head -1 "$TMP/m6")"; fi
rm -f "$COPY/mcp-codex.json" "$COPY/opencode/mcp-fragment.json"
if "$NODE_BIN" "$CGEN" --check >"$TMP/m7" 2>&1; then bad drift-mcp-missing "--check passed deleted MCP configs"
else
  grep -q 'mcp-codex.json is missing' "$TMP/m7" && ok || bad drift-mcp-missing-codex "--check missed the deleted Codex config"
  grep -q 'opencode/mcp-fragment.json is missing' "$TMP/m7" && ok \
    || bad drift-mcp-missing-oc "--check missed the deleted OpenCode fragment"
fi
"$NODE_BIN" "$CGEN" >/dev/null 2>&1
if [ "$(fingerprint "$COPY")" = "$after" ]; then ok
else bad drift-mcp-repair "a regeneration did not restore the MCP configs byte-for-byte"; fi

# a canonical server change reaches all three hosts from the one edit, in each host's own spelling.
# This is the whole point of generating them: the manifest is edited, nothing else is.
"$NODE_BIN" -e '
  const fs = require("fs"), p = process.argv[1];
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  m.mcpServers["shopify-dev-mcp"].env = { LIQUID: "true", ZZ_PROBE: "${ZZ_PROBE_TOKEN}" };
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
' "$COPY/.claude-plugin/plugin.json"
"$NODE_BIN" "$CGEN" >/dev/null 2>&1
prop_ok=1
[ "$(jnode "$COPY/mcp.json" 'm.mcpServers["shopify-dev-mcp"].env.ZZ_PROBE')" = '${ZZ_PROBE_TOKEN}' ] || prop_ok=0
[ "$(jnode "$COPY/mcp-codex.json" 'm.mcpServers["shopify-dev-mcp"].env.ZZ_PROBE')" = '${ZZ_PROBE_TOKEN}' ] || prop_ok=0
# OpenCode renames the key, and must carry the passthrough form through the rename untouched
[ "$(jnode "$COPY/opencode/mcp-fragment.json" 'm.mcp["shopify-dev-mcp"].environment.ZZ_PROBE')" = '${ZZ_PROBE_TOKEN}' ] || prop_ok=0
[ -z "$(jnode "$COPY/opencode/mcp-fragment.json" 'm.mcp["shopify-dev-mcp"].env')" ] || prop_ok=0
if [ "$prop_ok" = 1 ]; then ok
else bad mcp-propagation "an env passthrough added to the canonical manifest did not reach all three hosts verbatim"; fi

# a server nobody ranked must stop the generator: it would otherwise ship to every host EXCEPT the
# Cursor priority profile, and the one host with a tool cap is the one that needed the decision
"$NODE_BIN" -e '
  const fs = require("fs"), p = process.argv[1];
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  delete m.mcpServers["shopify-dev-mcp"].env.ZZ_PROBE;
  m.mcpServers["zz-probe-mcp"] = { command: "npx", args: ["-y", "zz-probe"] };
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
' "$COPY/.claude-plugin/plugin.json"
"$NODE_BIN" "$CGEN" >"$TMP/m8" 2>&1
rc=$?
if [ "$rc" != 0 ] && grep -q 'CURSOR_PRIORITY' "$TMP/m8"; then ok
else bad mcp-unranked "an unranked MCP server generated anyway (exit $rc)"; fi

# and a ranking that outlives its server is the same defect from the other side
"$NODE_BIN" -e '
  const fs = require("fs"), p = process.argv[1];
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  delete m.mcpServers["zz-probe-mcp"];
  delete m.mcpServers["notion-mcp"];
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
' "$COPY/.claude-plugin/plugin.json"
"$NODE_BIN" "$CGEN" >"$TMP/m9" 2>&1
rc=$?
if [ "$rc" != 0 ] && grep -q 'absent from' "$TMP/m9"; then ok
else bad mcp-stale-rank "a ranking for a removed server generated anyway (exit $rc)"; fi

echo "gen-adapters-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
