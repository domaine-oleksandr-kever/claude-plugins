#!/usr/bin/env bash
# Reference lint for plugins/fe: the checks the one-off fnd → fe rewrite ran, kept as a test.
# Every name comes from the manifests (the plugin's own `name`, its first `dependencies` entry as
# the base plugin), never a literal, so a rename that misses one place fails here:
#   a. no fnd / host / old-compressor name survives (exact-line allow-list below);
#   b. fe calls no MCP server of its own: every mcp__plugin_<x>_ names the base plugin, and every
#      mcp__plugin_<base>_<server> names a server in base's mcpServers;
#   c. every ${CLAUDE_PLUGIN_ROOT}/…, <plugin root>/… and <fe root>/… path exists in plugins/fe,
#      every <base root>/… path in plugins/base;
#   d. every fe:<x> in a markdown file, code fences included, names an fe agent or skill (or a toml
#      marker tag), every base:<x> a base agent or skill; a gh `--search` query is skipped, since
#      `base:<branch>` is GitHub's own qualifier there;
#   e. every /fe:<x> names an fe skill, every /base:<x> a base skill, /qa:qa-preflight is the one
#      foreign skill named before its plugin ships; /fe-doctor, /base-progress and /base-doctor
#      are the only hyphen commands of the two;
#   f. no bare /<skill> of either plugin, and no unqualified agent name in a markdown file (code
#      fences included);
#   g. every FE_* token is a row of plugins/fe/README.md → Environment switches, every BASE_*
#      token a row of plugins/base/README.md's;
#   h. every relative markdown link under plugins/fe resolves;
#   i. every agents/<name>.md and skills/<name>/SKILL.md opens with frontmatter whose `name:` is
#      <name> and carries a `description:`;
#   j. every references/*.md is cited by a skill, the agent or another reference;
#   k. every agent is a read-only scout: its `tools:` line lists no write tool.
# The same checker runs against a planted fixture first (plugins named kit and hub), so a rule
# that stopped firing — or one that only fires for the literal name fe — fails here.
# Exit 0 = all green.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "fe-refs-lint: node not found"; exit 1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

LINT="$TMP/lint.cjs"
cat > "$LINT" <<'JS'
'use strict';
const fs = require('fs');
const path = require('path');
const [dir, depDir, foreign, allowFile] = process.argv.slice(2);
const out = [];
const bad = (rule, where, what) => out.push(`${rule}\t${where}\t${what}`);

const ALLOW = new Set(allowFile && fs.existsSync(allowFile)
  ? fs.readFileSync(allowFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : []);
const FOREIGN = new Set((foreign || '').split(/\s+/).filter(Boolean));

const walk = (d, acc = []) => {
  for (const n of fs.readdirSync(d).sort()) {
    const p = path.join(d, n);
    if (path.relative(dir, p) === path.join('.claude-plugin', 'types')) continue;
    const st = fs.lstatSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (st.isFile()) acc.push(p);
  }
  return acc;
};
const text = (p) => { try { const b = fs.readFileSync(p); return b.includes(0) ? null : b.toString('utf8'); } catch { return null; } };
const manifestOf = (d) => { try { return JSON.parse(fs.readFileSync(path.join(d, '.claude-plugin', 'plugin.json'), 'utf8')); } catch { return {}; } };
const okName = (n) => typeof n === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(n);
const esc = (s) => s.replace(/[-]/g, '\\-');

const own = manifestOf(dir);
const dep = manifestOf(depDir);
const NAME = okName(own.name) ? own.name : '';
const DEP = okName(dep.name) ? dep.name : '';
if (!NAME) bad('b', path.join('.claude-plugin', 'plugin.json'), 'name');
if (!DEP || !Array.isArray(own.dependencies) || !own.dependencies.includes(DEP)) {
  bad('b', path.join('.claude-plugin', 'plugin.json'), `dependencies ${DEP || '(base unnamed)'}`);
}
const depServers = new Set(Object.keys(dep.mcpServers || {}));
const ownServers = new Set(Object.keys(own.mcpServers || {}));

const listing = (d, sub, pick) => (fs.existsSync(path.join(d, sub)) ? fs.readdirSync(path.join(d, sub)).filter((n) => pick(path.join(d, sub, n), n)) : []);
const agentsIn = (d) => new Set(listing(d, 'agents', (p, n) => n.endsWith('.md')).map((n) => n.slice(0, -3)));
const skillsIn = (d) => new Set(listing(d, 'skills', (p) => fs.statSync(p).isDirectory()));
const ownAgents = agentsIn(dir); const ownSkills = skillsIn(dir);
const depAgents = agentsIn(depDir); const depSkills = skillsIn(depDir);

const envRowsOf = (d, prefix) => {
  const readme = text(path.join(d, 'README.md')) || '';
  const section = (readme.split(/^## Environment switches[ \t]*$/m)[1] || '').split(/^## /m)[0];
  return new Set([...section.matchAll(new RegExp(`^\\|\\s*\`(${prefix}_[A-Z0-9_]+)\``, 'gm'))].map((m) => m[1]));
};
const OWN_ENV = NAME.toUpperCase().replace(/-/g, '_');
const DEP_ENV = DEP.toUpperCase().replace(/-/g, '_');
const ownEnv = envRowsOf(dir, OWN_ENV);
const depEnv = envRowsOf(depDir, DEP_ENV);

const MARKERS = new Set([`${NAME}:superseded`, `${NAME}:session-theme`]);
const BANNED = [
  ['plugin_fnd_', /plugin_fnd_/], ['FND_', /FND_/], ['fnd:', /\bfnd:/], ['/fnd', /\/fnd\b/],
  ['fnd-tmp', /fnd-tmp/], ['fnd-review', /fnd-review/], ['figma-node-slim', /figma-node-slim/],
  ['json-slim', /json-slim/], ['log-slim', /log-slim/], ['adf-to-md', /adf-to-md/],
  ['agents-', /\bagents-/], ['.mdc', /\.mdc\b/], ['Cursor', /\bCursor\b/], ['Codex', /\bCodex\b/],
  ['OpenCode', /\bOpenCode\b/], ['host-model-map', /host-model-map/],
  ['host-orchestration', /host-orchestration/], ['gen-host-adapters', /gen-host-adapters/],
];
const OWN_PATH_RE = new RegExp(`(?:\\$\\{CLAUDE_PLUGIN_ROOT\\}|<plugin root>|<${esc(NAME)} root>)\\/([A-Za-z0-9_.\\/-]*)`, 'g');
const DEP_PATH_RE = new RegExp(`<${esc(DEP)} root>\\/([A-Za-z0-9_.\\/-]*)`, 'g');
const REF_RE = new RegExp(`(^|[^\\/A-Za-z0-9_-])(${esc(NAME)}|${esc(DEP)}):([a-z][a-z0-9-]*)`, 'g');
const SLASH_RE = /(^|[^A-Za-z0-9_.:\/-])\/([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)/g;
const CMD_LEAD = '(^|[^A-Za-z0-9_.:\\/<>}-])';
const HYPHEN_RE = new RegExp(`${CMD_LEAD}\\/((?:${esc(NAME)}|${esc(DEP)})-[A-Za-z0-9_-]+)`, 'g');
const COMMANDS = new Set([`${NAME}-doctor`, `${DEP}-progress`, `${DEP}-doctor`]);
const ALL_SKILLS = [...ownSkills, ...depSkills];
const BARE_SKILL_RE = ALL_SKILLS.length
  ? new RegExp(`${CMD_LEAD}\\/(${ALL_SKILLS.map(esc).join('|')})(?![-A-Za-z0-9_:/])`, 'g') : null;
const ALL_AGENTS = [...ownAgents, ...depAgents];
const BARE_AGENT_RE = ALL_AGENTS.length
  ? new RegExp(`(^|[^-:\\/.A-Za-z0-9_])(${ALL_AGENTS.map(esc).join('|')})(?![-A-Za-z0-9_]|\\.md)`, 'g') : null;

const SEARCH_RE = /--search(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/g;
const searchSpans = (line) => [...line.matchAll(SEARCH_RE)].map((m) => [m.index, m.index + m[0].length]);

const files = walk(dir);
const corpus = [];
for (const f of files) {
  const rel = path.relative(dir, f);
  const t = text(f);
  if (t === null) continue;
  const isMd = f.endsWith('.md');
  if (/^(skills|agents|references)\//.test(rel)) corpus.push([rel, t]);
  let fence = false;
  let fm = false;
  t.split('\n').forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    if (i === 0 && line === '---') fm = true;
    else if (fm && line === '---') fm = false;
    const fenceLine = isMd && /^\s*(```|~~~)/.test(line);
    if (fenceLine) fence = !fence;
    const prose = isMd && !fence && !fenceLine;
    const allowed = ALLOW.has(line.trim());
    if (!allowed) for (const [name, re] of BANNED) if (re.test(line)) bad('a', at, name);
    for (const m of line.matchAll(/mcp__plugin_([A-Za-z0-9-]+?)_([A-Za-z0-9-]+)/g)) {
      if (m[1] === DEP) { if (!depServers.has(m[2])) bad('b', at, `mcp__plugin_${DEP}_${m[2]}`); }
      else if (m[1] === NAME) { if (!ownServers.has(m[2])) bad('b', at, `mcp__plugin_${NAME}_${m[2]}`); }
      else bad('b', at, `mcp__plugin_${m[1]}_`);
    }
    for (const m of line.matchAll(OWN_PATH_RE)) {
      const p = m[1].replace(/[.,:;]+$/, '');
      if (p && !fs.existsSync(path.join(dir, p))) bad('c', at, p);
    }
    for (const m of line.matchAll(DEP_PATH_RE)) {
      const p = m[1].replace(/[.,:;]+$/, '');
      if (p && !fs.existsSync(path.join(depDir, p))) bad('c', at, `<${DEP} root>/${p}`);
    }
    if (isMd) {
      const spans = searchSpans(line);
      for (const m of line.matchAll(REF_RE)) {
        const ref = `${m[2]}:${m[3]}`;
        if (MARKERS.has(ref)) continue;
        if (spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
        const [agents, skills] = m[2] === NAME ? [ownAgents, ownSkills] : [depAgents, depSkills];
        if (!agents.has(m[3]) && !skills.has(m[3])) bad('d', at, ref);
      }
    }
    for (const m of line.matchAll(SLASH_RE)) {
      const ref = `/${m[2]}:${m[3]}`;
      if (m[2] === NAME) { if (!ownSkills.has(m[3])) bad('e', at, ref); }
      else if (m[2] === DEP) { if (!depSkills.has(m[3])) bad('e', at, ref); }
      else if (!FOREIGN.has(ref)) bad('e', at, ref);
    }
    for (const m of line.matchAll(HYPHEN_RE)) {
      if (!COMMANDS.has(m[2])) bad('e', at, `/${m[2]}`);
    }
    if (BARE_SKILL_RE) for (const m of line.matchAll(BARE_SKILL_RE)) bad('f', at, `/${m[2]}`);
    if (isMd && BARE_AGENT_RE && !(fm && /^name:/.test(line))) {
      for (const m of line.matchAll(BARE_AGENT_RE)) bad('f', at, m[2]);
    }
    if (!allowed) {
      for (const m of line.matchAll(new RegExp(`\\b${OWN_ENV}_[A-Z0-9_]+`, 'g'))) if (!ownEnv.has(m[0])) bad('g', at, m[0]);
    }
    if (isMd) {
      for (const m of line.matchAll(new RegExp(`\\b${DEP_ENV}_[A-Z0-9_]+`, 'g'))) if (!depEnv.has(m[0])) bad('g', at, m[0]);
    }
    if (prose) {
      for (const m of line.replace(/`[^`]*`/g, '').matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('<')) continue;
        const file = decodeURIComponent(target.split('#')[0]);
        if (file && !fs.existsSync(path.resolve(path.dirname(f), file))) bad('h', at, target);
      }
    }
  });
}
const frontmatter = (p) => (/^---\n([\s\S]*?)\n---\n/.exec(text(p) || '') || [])[1] || '';
const checkFm = (p, want, where) => {
  const fm = frontmatter(p);
  const name = (/^name:\s*(\S+)\s*$/m.exec(fm) || [])[1];
  if (name !== want) bad('i', where, `name: ${name || '(none)'}`);
  if (!/^description:\s*\S/m.test(fm)) bad('i', where, 'description');
  return fm;
};
for (const a of ownAgents) {
  const fm = checkFm(path.join(dir, 'agents', `${a}.md`), a, `agents/${a}.md`);
  const tools = (/^tools:[ \t]*(.*)$/m.exec(fm) || [])[1];
  if (tools === undefined) { bad('k', `agents/${a}.md`, 'no tools line'); continue; }
  for (const t of tools.split(',').map((x) => x.trim())) {
    if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t) || /^mcp__/.test(t)) bad('k', `agents/${a}.md`, t);
  }
}
for (const s of ownSkills) {
  const p = path.join(dir, 'skills', s, 'SKILL.md');
  if (!fs.existsSync(p)) { bad('i', `skills/${s}`, 'SKILL.md missing'); continue; }
  checkFm(p, s, `skills/${s}/SKILL.md`);
}
for (const r of listing(dir, 'references', (p, n) => n.endsWith('.md'))) {
  const cited = corpus.some(([rel, t]) => rel !== path.join('references', r) && t.includes(r));
  if (!cited) bad('j', `references/${r}`, 'not cited');
}
process.stdout.write(out.join('\n') + (out.length ? '\n' : ''));
JS

FOREIGN_REFS="/qa:qa-preflight"
ALLOW_FILE="$TMP/allow.txt"
# The README's one migration line names fnd's uninstall command and its old profile key.
cat > "$ALLOW_FILE" <<'TXT'
To move from fnd, run `/plugin uninstall fnd@domaine`, install the set above, and rename every `FND_` key fe reads to its `FE_` name (`FND_PROFILE`, `FND_GQL_PROBE_CACHE`, `FND_CPT_THROTTLE_WAITS`, `FND_CPT_OVERLAY_VERIFY`, `FND_CPT_OVERLAY_VERIFY_WAIT`, `FND_THEME_JSON_VERIFY`, `FND_THEME_JSON_VERIFY_WAIT`) in `.claude/domaine.env`, `~/.config/domaine/env` and `~/.claude/settings.json` → `env`: fe does not read the old keys.
TXT
run_lint() { "$NODE_BIN" "$LINT" "$1" "$2" "$FOREIGN_REFS" "$ALLOW_FILE"; }

# ------------------------------------------------------- the checker fires on a planted fixture --
HUB="$TMP/hub"; KIT="$TMP/kit"
mkdir -p "$HUB/.claude-plugin" "$HUB/agents" "$HUB/skills/commit" "$HUB/skills/save-task-context" "$HUB/skills/worktree" "$HUB/skills/report" "$HUB/references" "$HUB/scripts"
printf '{ "name": "hub", "mcpServers": { "atlassian": {} } }\n' > "$HUB/.claude-plugin/plugin.json"
printf -- '---\nname: jira-reader\ndescription: x\n---\n' > "$HUB/agents/jira-reader.md"
printf -- '---\nname: figma-reader\ndescription: x\n---\n' > "$HUB/agents/figma-reader.md"
: > "$HUB/references/task-workspace.md"; : > "$HUB/scripts/md-to-adf.cjs"
printf '# hub\n\n## Environment switches\n\n| Variable | Default | Effect |\n|---|---|---|\n| `HUB_KNOWN` | on | x |\n' > "$HUB/README.md"
mkdir -p "$KIT/.claude-plugin/types/hub" "$KIT/agents" "$KIT/skills/ship" "$KIT/skills/misdir" "$KIT/references" "$KIT/scripts"
printf '{ "name": "kit", "dependencies": ["hub"] }\n' > "$KIT/.claude-plugin/plugin.json"
printf 'reads FND_SECRET and KIT_UNDOCUMENTED\n' > "$KIT/.claude-plugin/types/hub/index.d.ts"
printf '# kit\n\n## Environment switches\n\n| Variable | Default | Effect |\n|---|---|---|\n| `KIT_KNOWN` | on | x |\n' > "$KIT/README.md"
printf -- '---\nname: ship\ndescription: x\n---\n' > "$KIT/skills/ship/SKILL.md"
printf -- '---\nname: other\n---\n' > "$KIT/skills/misdir/SKILL.md"
printf -- '---\nname: scout\ndescription: a fixture scout\ntools: Read, Grep, Write\n---\nUses [cited](../references/cited.md).\n' > "$KIT/agents/scout.md"
: > "$KIT/references/cited.md"; : > "$KIT/references/orphan.md"; : > "$KIT/scripts/present.sh"
cat > "$KIT/skills/ship/SKILL.md" <<'MD'
---
name: ship
description: a fixture skill
---
Spawn kit:scout, kit:ghost, hub:jira-reader and hub:ghost; bare jira-reader and scout here.
Run /kit:ship, /kit:nope, /hub:commit, /hub:nope, /qa:qa-preflight, /qa:other, /kit-doctor, /kit-bogus, /hub-progress.
Bare /commit and /ship. Paths ${CLAUDE_PLUGIN_ROOT}/scripts/present.sh <kit root>/references/absent.md
<hub root>/references/task-workspace.md <hub root>/scripts/gone.sh <plugin root>/scripts/present.sh.
Old names: plugin_fnd_x, FND_X, fnd:jira-reader, /fnd-progress, .claude/fnd-tmp, json-slim, Codex, host-model-map.
Servers: mcp__plugin_hub_atlassian__getJiraIssue mcp__plugin_hub_ghost__x mcp__plugin_kit_own__x mcp__plugin_other_x__y.
Switches: KIT_KNOWN, KIT_UNKNOWN, HUB_KNOWN, HUB_UNKNOWN. Markers: # kit:superseded and kit:session-theme.
Links: [ok](../../README.md) [gone](missing.md) [web](https://x.test) `[code](span.md)`.
.claude/hub-tmp/x is a path, agents/scout.md a file, http://localhost:9292 a URL.
Then **/save-task-context** and →/worktree, */kit-stray* here; ${ROOT}/report here.
```bash
gh pr list --search "merged:>2026-01-01 hub:main"
Agent(subagent_type: "figma-reader", prompt: "then spawn kit:phantom")
```
MD
printf 'const HUB_MISSING = 1\n' > "$KIT/scripts/constants.ts"
printf '%s\n' 'To move from fnd, run `/plugin uninstall fnd@domaine`, install the set above, and rename every `FND_` key fe reads to its `FE_` name (`FND_PROFILE`, `FND_GQL_PROBE_CACHE`, `FND_CPT_THROTTLE_WAITS`, `FND_CPT_OVERLAY_VERIFY`, `FND_CPT_OVERLAY_VERIFY_WAIT`, `FND_THEME_JSON_VERIFY`, `FND_THEME_JSON_VERIFY_WAIT`) in `.claude/domaine.env`, `~/.config/domaine/env` and `~/.claude/settings.json` → `env`: fe does not read the old keys.' >> "$KIT/README.md"
run_lint "$KIT" "$HUB" > "$TMP/fx.out"
OUTF="$TMP/fx.out"
want() { # want <rule> <what>
  if awk -F'\t' -v r="$1" -v w="$2" '$1 == r && $3 == w { f = 1 } END { exit !f }' "$OUTF"; then ok
  else bad "fixture-$1" "rule $1 did not flag '$2': $(tr '\n' ';' < "$OUTF" | head -c 600)"; fi
}
dont() { # dont <rule> <what>
  if awk -F'\t' -v r="$1" -v w="$2" '$1 == r && $3 == w { f = 1 } END { exit f }' "$OUTF"; then ok
  else bad "fixture-$1-false" "rule $1 flagged '$2'"; fi
}
for w in plugin_fnd_ FND_ fnd: /fnd fnd-tmp json-slim Codex host-model-map; do want a "$w"; done
want b mcp__plugin_hub_ghost;            dont b mcp__plugin_hub_atlassian
want b mcp__plugin_kit_own;              want b mcp__plugin_other_
want c references/absent.md;             dont c scripts/present.sh
want c "<hub root>/scripts/gone.sh";     dont c "<hub root>/references/task-workspace.md"
want d kit:ghost;                        dont d kit:scout
want d hub:ghost;                        dont d hub:jira-reader;  dont d hub:main
dont d kit:superseded;                   dont d kit:session-theme
want e /kit:nope;                        dont e /kit:ship
want e /hub:nope;                        dont e /hub:commit
want e /qa:other;                        dont e /qa:qa-preflight
want e /kit-bogus;                       dont e /kit-doctor;      dont e /hub-progress
dont e /hub-tmp;                         dont e /localhost
want f /commit;                          want f /ship
want f jira-reader;                      want f scout
want f /save-task-context;               want f /worktree;        dont f /report
want f figma-reader;                     want d kit:phantom;      want e /kit-stray
want g KIT_UNKNOWN;                      dont g KIT_KNOWN
want g HUB_UNKNOWN;                      dont g HUB_KNOWN;        dont g FE_PROFILE
dont g HUB_MISSING
want h missing.md;                       dont h ../../README.md;  dont h span.md
want i "name: other";                    want i description;      dont i "name: ship"
if awk -F'\t' '$1 == "j" && $2 == "references/orphan.md" { f = 1 } END { exit !f }' "$OUTF"; then ok
else bad fixture-j "rule j did not flag references/orphan.md"; fi
if awk -F'\t' '$1 == "j" && $2 == "references/cited.md" { f = 1 } END { exit f }' "$OUTF"; then ok
else bad fixture-j-false "rule j flagged references/cited.md"; fi
want k Write;                            dont k Read
# the migration line is allowed by its exact text only, and the laid contract is not linted
if awk -F'\t' '$1 == "a" && $2 ~ /^README\.md:/ { f = 1 } END { exit f }' "$OUTF"; then ok
else bad fixture-allow "the allow-listed README line was flagged"; fi
if ! grep -qF 'types/hub' "$TMP/fx.out"; then ok; else bad fixture-laid-types "the laid contract was linted"; fi

# A literal-name lint passes the fixture above only by luck: the same text under fe's names must
# still be judged by kit's rules, so a stray `fe` default shows up as a missed flag.
KIT2="$TMP/kit2"; cp -R "$KIT" "$KIT2"
printf '{ "name": "kit", "dependencies": ["base"] }\n' > "$KIT2/.claude-plugin/plugin.json"
run_lint "$KIT2" "$HUB" > "$TMP/fx2.out"; OUTF="$TMP/fx2.out"
want b "dependencies hub"

# ------------------------------------------------------------------------------- plugins/fe --
FE="$ROOT/plugins/fe"; BASE="$ROOT/plugins/base"
if [ -d "$FE" ] && [ -d "$BASE" ]; then
  run_lint "$FE" "$BASE" > "$TMP/fe.out"
  for r in a b c d e f g h i j k; do
    hits="$(awk -F'\t' -v r="$r" '$1 == r { printf "%s %s; ", $2, $3 }' "$TMP/fe.out")"
    if [ -z "$hits" ]; then ok; else bad "fe-$r" "$(printf '%s' "$hits" | head -c 800)"; fi
  done
  # the exact skill set fe ships, and the ones it must leave to base and the qa plugin
  want_skills="create-pull-request develop-feature-or-fix fix-accessibility-issue fix-breaking-changes get-breaking-changes preflight-checks preview-theme qa-feature-or-fix ship update-translations write-steps-to-test write-technical-approach"
  have_skills="$(cd "$FE/skills" 2>/dev/null && find . -mindepth 1 -maxdepth 1 -type d | sed 's|^\./||' | sort | tr '\n' ' ' | sed 's/ $//')"
  if [ "$have_skills" = "$want_skills" ]; then ok; else bad fe-skill-set "skills: $have_skills"; fi
  if [ "$(cd "$FE/agents" 2>/dev/null && ls)" = "theme-explorer.md" ]; then ok; else bad fe-agent-set "agents: $(ls "$FE/agents" 2>/dev/null | tr '\n' ' ')"; fi
  if [ -f "$FE/skills/fix-breaking-changes/scripts/fix-breaking-changes.template.js" ]; then ok
  else bad fe-fbc-template "skills/fix-breaking-changes/scripts/fix-breaking-changes.template.js missing"; fi
else
  bad fe-present "plugins/fe or plugins/base missing"
fi

echo "fe-refs-lint: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
