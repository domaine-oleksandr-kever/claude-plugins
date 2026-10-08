#!/usr/bin/env bash
# Reference lint for plugins/base: the checks the one-off fnd → base rewrite ran, kept as a test.
#   a. no fnd / host / old-compressor name survives (exact-line allow-list below);
#   b. every mcp__plugin_<x>_ carries the plugin's own name (read from its plugin.json, so a rename
#      that misses one entry fails), and every mcp__plugin_<name>_<server> names a server in its
#      mcpServers;
#   c. every ${CLAUDE_PLUGIN_ROOT}/…, <plugin root>/… and <base root>/… path exists in plugins/base;
#   d. every <name>:<x> in a markdown file names a base agent or skill;
#   e. every /<name>:<x> names a base skill, and /<name>-progress and /<name>-doctor are the only
#      hyphen commands;
#   f. no bare /commit, /save-task-context, /report-plugin-issue, /pre-commit-review, /worktree;
#   g. every BASE_* token is a row of plugins/base/README.md → Environment switches;
#   h. every relative markdown link under plugins/base resolves;
#   i. every agents/<name>.md opens with frontmatter whose `name:` is <name> and carries a
#      `description:` — the spawn name base:<name> is that field;
#   k. the readers and the writer keep their write denylists: every Jira/Confluence/Notion write tool
#      a role must not call is in its disallowedTools under the plugin's own prefix and as the
#      user-scope twin (mcp__atlassian__…, mcp__notion__…), or its whole server is.
# The same checker runs against a planted fixture first, so a rule that stopped firing fails here.
# Exit 0 = all green.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "base-refs-lint: node not found"; exit 1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

# The universal skills base ships (§11 decision 6, §11.5 item 2): a /base:<name> outside this set is
# a reference to a skill base does not have.
BASE_SKILL_SET="commit save-task-context report-plugin-issue pre-commit-review worktree"

LINT="$TMP/lint.cjs"
cat > "$LINT" <<'JS'
'use strict';
const fs = require('fs');
const path = require('path');
const [dir, skillSet] = process.argv.slice(2);
const out = [];
const bad = (rule, where, what) => out.push(`${rule}\t${where}\t${what}`);

const ALLOW = new Set([]);

const files = [];
const walk = (d) => {
  for (const n of fs.readdirSync(d).sort()) {
    const p = path.join(d, n);
    const rel = path.relative(dir, p);
    if (rel === path.join('.claude-plugin', 'types')) continue;
    const st = fs.lstatSync(p);
    if (st.isDirectory()) walk(p);
    else if (st.isFile()) files.push(p);
  }
};
walk(dir);
const text = (p) => { try { const b = fs.readFileSync(p); return b.includes(0) ? null : b.toString('utf8'); } catch { return null; } };

let manifest = {};
try { manifest = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')); } catch {}
const servers = new Set(Object.keys(manifest.mcpServers || {}));
const NAME = typeof manifest.name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(manifest.name) ? manifest.name : '';
if (!NAME) bad('b', path.join('.claude-plugin', 'plugin.json'), 'name');
const esc = (s) => s.replace(/[-]/g, '\\-');
const PFX = `mcp__plugin_${NAME}_`;
const OWN_SERVER_RE = new RegExp(`mcp__plugin_${esc(NAME)}_([A-Za-z0-9-]+)`, 'g');
const AGENT_REF_RE = new RegExp(`(^|[^\\/A-Za-z0-9_-])${esc(NAME)}:([a-z][a-z0-9-]*)`, 'g');
const SKILL_REF_RE = new RegExp(`\\/${esc(NAME)}:([a-z][a-z0-9-]*)`, 'g');
const HYPHEN_CMD_RE = new RegExp(`(^|[\\s\`(\\[])\\/(${esc(NAME)}-[A-Za-z0-9_-]+)`, 'g');
const agents = new Set(fs.existsSync(path.join(dir, 'agents'))
  ? fs.readdirSync(path.join(dir, 'agents')).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)) : []);
const skillDirs = fs.existsSync(path.join(dir, 'skills'))
  ? fs.readdirSync(path.join(dir, 'skills')).filter((n) => fs.statSync(path.join(dir, 'skills', n)).isDirectory()) : [];
const skills = new Set([...skillSet.split(/\s+/).filter(Boolean), ...skillDirs]);
const COMMANDS = new Set([`${NAME}-progress`, `${NAME}-doctor`]);

const readme = text(path.join(dir, 'README.md')) || '';
const envSection = (readme.split(/^## Environment switches[ \t]*$/m)[1] || '').split(/^## /m)[0];
const envRows = new Set([...envSection.matchAll(/^\|\s*`(BASE_[A-Z0-9_]+)`/gm)].map((m) => m[1]));

const BANNED = [
  ['plugin_fnd_', /plugin_fnd_/], ['FND_', /FND_/], ['fnd:', /\bfnd:/], ['/fnd', /\/fnd\b/],
  ['fnd-tmp', /fnd-tmp/], ['figma-node-slim', /figma-node-slim/], ['json-slim', /json-slim/],
  ['log-slim', /log-slim/], ['adf-to-md', /adf-to-md/], ['agents-', /\bagents-/], ['.mdc', /\.mdc\b/],
  ['Cursor', /\bCursor\b/], ['Codex', /\bCodex\b/], ['OpenCode', /\bOpenCode\b/],
];
const PATH_RE = /(?:\$\{CLAUDE_PLUGIN_ROOT\}|<plugin root>|<base root>)\/([A-Za-z0-9_.\/-]*)/g;

for (const f of files) {
  const rel = path.relative(dir, f);
  const t = text(f);
  if (t === null) continue;
  const isMd = f.endsWith('.md');
  let fence = false;
  t.split('\n').forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    if (!ALLOW.has(line.trim())) {
      for (const [name, re] of BANNED) if (re.test(line)) bad('a', at, name);
    }
    for (const m of line.matchAll(/mcp__plugin_([A-Za-z0-9-]+)_/g)) {
      if (m[1] !== NAME) bad('b', at, `mcp__plugin_${m[1]}_`);
    }
    for (const m of line.matchAll(OWN_SERVER_RE)) {
      if (!servers.has(m[1])) bad('b', at, `${PFX}${m[1]}`);
    }
    for (const m of line.matchAll(PATH_RE)) {
      const p = m[1].replace(/[.,:;]+$/, '');
      if (p && !fs.existsSync(path.join(dir, p))) bad('c', at, p);
    }
    if (isMd) {
      for (const m of line.matchAll(AGENT_REF_RE)) {
        if (!agents.has(m[2]) && !skills.has(m[2])) bad('d', at, `${NAME}:${m[2]}`);
      }
    }
    for (const m of line.matchAll(SKILL_REF_RE)) {
      if (!skills.has(m[1])) bad('e', at, `/${NAME}:${m[1]}`);
    }
    for (const m of line.matchAll(HYPHEN_CMD_RE)) {
      if (!COMMANDS.has(m[2])) bad('e', at, `/${m[2]}`);
    }
    for (const m of line.matchAll(/(^|[\s`(\["'])\/(commit|save-task-context|report-plugin-issue|pre-commit-review|worktree)\b/g)) {
      bad('f', at, `/${m[2]}`);
    }
    for (const m of line.matchAll(/\bBASE_[A-Z0-9_]+/g)) {
      if (!envRows.has(m[0])) bad('g', at, m[0]);
    }
    if (isMd) {
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
      if (fence) return;
      for (const m of line.replace(/`[^`]*`/g, '').matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('<')) continue;
        const file = decodeURIComponent(target.split('#')[0]);
        if (file && !fs.existsSync(path.resolve(path.dirname(f), file))) bad('h', at, target);
      }
    }
  });
}
const frontmatter = (a) => (/^---\n([\s\S]*?)\n---\n/.exec(text(path.join(dir, 'agents', `${a}.md`)) || '') || [])[1] || '';
for (const a of agents) {
  const fm = frontmatter(a);
  const name = (/^name:\s*(\S+)\s*$/m.exec(fm) || [])[1];
  if (name !== a) bad('i', `agents/${a}.md`, `name: ${name || '(none)'}`);
  if (!/^description:\s*\S/m.test(fm)) bad('i', `agents/${a}.md`, 'description');
}
const JIRA_WRITES = ['editJiraIssue', 'addCommentToJiraIssue', 'transitionJiraIssue', 'createJiraIssue',
  'createIssueLink', 'addWorklogToJiraIssue', 'createConfluencePage', 'updateConfluencePage',
  'createConfluenceFooterComment', 'createConfluenceInlineComment'];
const NOTION_WRITES = ['notion-create-pages', 'notion-update-page', 'notion-create-comment', 'notion-move-pages',
  'notion-duplicate-page', 'notion-create-database', 'notion-update-data-source', 'notion-create-view',
  'notion-update-view', 'notion-create-folder', 'notion-update-folder', 'notion-create-file-upload',
  'notion-create-attachment', 'notion-spawn-session', 'notion-send-message-to-session', 'notion-stop-session'];
const WHOLE = '*';
const DENY = {
  'jira-reader': { atlassian: JIRA_WRITES, 'notion-mcp': NOTION_WRITES },
  'doc-reader': { atlassian: JIRA_WRITES, 'notion-mcp': NOTION_WRITES },
  'jira-writer': {
    atlassian: JIRA_WRITES.filter((t) => t !== 'editJiraIssue' && t !== 'addCommentToJiraIssue'),
    'notion-mcp': NOTION_WRITES,
  },
  'figma-reader': { atlassian: WHOLE, 'notion-mcp': WHOLE },
};
const TWIN = { atlassian: 'mcp__atlassian', 'notion-mcp': 'mcp__notion' };
const listOf = (fm, key) => {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(fm);
  if (!m) return [];
  let items = m[1].split(',');
  if (!m[1].trim()) {
    items = [];
    for (const l of fm.slice(m.index + m[0].length).split('\n').slice(1)) {
      const li = /^\s*-\s*(.+)$/.exec(l);
      if (!li) break;
      items.push(li[1]);
    }
  }
  return items.map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
};
for (const [a, rule] of Object.entries(DENY)) {
  if (!agents.has(a)) { bad('k', `agents/${a}.md`, `${a} missing`); continue; }
  const denied = new Set(listOf(frontmatter(a), 'disallowedTools'));
  for (const [server, tools] of Object.entries(rule)) {
    for (const base of [`${PFX}${server}`, TWIN[server]]) {
      if (denied.has(base)) continue;
      if (tools === WHOLE) { bad('k', `agents/${a}.md`, `${a} ${base}`); continue; }
      for (const t of tools) if (!denied.has(`${base}__${t}`)) bad('k', `agents/${a}.md`, `${a} ${base}__${t}`);
    }
  }
}
process.stdout.write(out.join('\n') + (out.length ? '\n' : ''));
JS

run_lint() { "$NODE_BIN" "$LINT" "$1" "$BASE_SKILL_SET"; }

# ------------------------------------------------------- the checker fires on a planted fixture --
FX="$TMP/fixture"; mkdir -p "$FX/.claude-plugin" "$FX/agents" "$FX/references" "$FX/scripts" "$FX/.claude-plugin/types/slim"
printf '{ "name": "base", "mcpServers": { "atlassian": {} } }\n' > "$FX/.claude-plugin/plugin.json"
printf '# base\n\n## Environment switches\n\n| Variable | Default | Effect |\n|---|---|---|\n| `BASE_KNOWN` | on | x |\n' > "$FX/README.md"
printf 'reads FND_SECRET and BASE_KNOWN\n' > "$FX/.claude-plugin/types/slim/index.d.ts"
printf -- '---\nname: other\n---\nno description\n' > "$FX/agents/misnamed.md"
cat > "$FX/agents/reader.md" <<'MD'
---
name: reader
description: a fixture reader
disallowedTools: mcp__plugin_base_atlassian__editJiraIssue, mcp__plugin_base_ghost__x
---
Spawn base:reader and base:missing-agent; run /base:commit, /base:nope, /base-doctor, /base-bogus.
Run /commit here. Uses ${CLAUDE_PLUGIN_ROOT}/scripts/present.sh and <plugin root>/references/absent.md.
Old names: plugin_fnd_x, FND_X, fnd:jira-reader, /fnd-progress, .claude/fnd-tmp, json-slim, Codex.
Switches: BASE_KNOWN and BASE_UNKNOWN. Links: [ok](../README.md) [gone](missing.md) [web](https://x.test) `[code](span.md)`.
.claude/base-tmp/playwright is a path, not a command.
MD
: > "$FX/scripts/present.sh"
cat > "$FX/agents/jira-reader.md" <<'MD'
---
name: jira-reader
description: a fixture reader with a gap in its denylist
disallowedTools: Edit, mcp__plugin_kore_atlassian__editJiraIssue, mcp__atlassian__editJiraIssue, mcp__plugin_base_atlassian__addCommentToJiraIssue, mcp__atlassian__addCommentToJiraIssue, mcp__plugin_base_atlassian__transitionJiraIssue, mcp__plugin_base_atlassian__createJiraIssue, mcp__atlassian__createJiraIssue, mcp__plugin_base_atlassian__createIssueLink, mcp__atlassian__createIssueLink, mcp__plugin_base_atlassian__addWorklogToJiraIssue, mcp__atlassian__addWorklogToJiraIssue, mcp__plugin_base_atlassian__createConfluencePage, mcp__atlassian__createConfluencePage, mcp__plugin_base_atlassian__updateConfluencePage, mcp__atlassian__updateConfluencePage, mcp__plugin_base_atlassian__createConfluenceFooterComment, mcp__atlassian__createConfluenceFooterComment, mcp__plugin_base_atlassian__createConfluenceInlineComment, mcp__atlassian__createConfluenceInlineComment, mcp__plugin_base_notion-mcp, mcp__notion
---
MD
cat > "$FX/agents/figma-reader.md" <<'MD'
---
name: figma-reader
description: a fixture reader denying whole servers, one twin short
disallowedTools:
  - mcp__plugin_base_atlassian
  - mcp__atlassian
  - mcp__plugin_base_notion-mcp
---
MD
run_lint "$FX" > "$TMP/fx.out"
OUTF="$TMP/fx.out"
want() { # want <rule> <what>
  if awk -F'\t' -v r="$1" -v w="$2" '$1 == r && $3 == w { f = 1 } END { exit !f }' "$OUTF"; then ok
  else bad "fixture-$1" "rule $1 did not flag '$2': $(tr '\n' ';' < "$OUTF" | head -c 400)"; fi
}
dont() { # dont <rule> <what>
  if awk -F'\t' -v r="$1" -v w="$2" '$1 == r && $3 == w { f = 1 } END { exit f }' "$OUTF"; then ok
  else bad "fixture-$1-false" "rule $1 flagged '$2'"; fi
}
for w in plugin_fnd_ FND_ fnd: /fnd fnd-tmp json-slim Codex; do want a "$w"; done
want b mcp__plugin_base_ghost;           dont b mcp__plugin_base_atlassian
want c references/absent.md;             dont c scripts/present.sh
want d base:missing-agent;               dont d base:reader
want e /base:nope;                       dont e /base:commit
want e /base-bogus;                      dont e /base-doctor;     dont e /base-tmp
want f /commit
want g BASE_UNKNOWN;                     dont g BASE_KNOWN
want h missing.md;                       dont h ../README.md;     dont h span.md
want i "name: other";                    want i description;      dont i "name: reader"
want b mcp__plugin_kore_;                dont b mcp__plugin_base_
want k "jira-reader mcp__plugin_base_atlassian__editJiraIssue"
want k "jira-reader mcp__atlassian__transitionJiraIssue"
dont k "jira-reader mcp__plugin_base_atlassian__createJiraIssue"
dont k "jira-reader mcp__plugin_base_notion-mcp__notion-update-page"
want k "figma-reader mcp__notion";       dont k "figma-reader mcp__plugin_base_notion-mcp"
dont k "figma-reader mcp__atlassian";    want k "doc-reader missing"
want k "jira-writer missing"

# The prefix is the manifest's name, not a literal: under another name the old prefix is stale.
FX2="$TMP/renamed"; mkdir -p "$FX2/.claude-plugin" "$FX2/references"
printf '{ "name": "kit", "mcpServers": { "atlassian": {} } }\n' > "$FX2/.claude-plugin/plugin.json"
printf 'deny mcp__plugin_base_atlassian__editJiraIssue and mcp__plugin_kit_atlassian__createJiraIssue\nspawn kit:ghost, run /kit:nope and /kit-bogus\n' > "$FX2/references/x.md"
run_lint "$FX2" > "$TMP/fx2.out"; OUTF="$TMP/fx2.out"
want b mcp__plugin_base_;                dont b mcp__plugin_kit_
want d kit:ghost;                        want e /kit:nope;        want e /kit-bogus
OUTF="$TMP/fx.out"
# the laid dependency contract is the engine's copy, not base's text
if ! grep -qF 'types/slim' "$TMP/fx.out"; then ok; else bad fixture-laid-types "the laid contract was linted"; fi

# ------------------------------------------------------------------------------ plugins/base --
BASE="$ROOT/plugins/base"
if [ -d "$BASE" ]; then
  run_lint "$BASE" > "$TMP/base.out"
  for r in a b c d e f g h i k; do
    hits="$(awk -F'\t' -v r="$r" '$1 == r { printf "%s %s; ", $2, $3 }' "$TMP/base.out")"
    if [ -z "$hits" ]; then ok; else bad "base-$r" "$(printf '%s' "$hits" | head -c 600)"; fi
  done
else
  bad base-present "plugins/base missing"
fi

echo "base-refs-lint: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
