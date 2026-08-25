#!/usr/bin/env node
/*
 * gen-host-adapters.cjs — per-host agent, command and MCP adapters for the multi-harness port (M4, M6).
 *
 * Canonical Claude Code content (`agents/*.md`, `skills/<name>/SKILL.md`, `.claude-plugin/plugin.json`
 * → `mcpServers`) is the ONLY input and is never written to. Every other host gets a committed,
 * generated adapter so a `git pull` ships the same agent bodies and the same server list everywhere,
 * and no install step needs Node beyond this script:
 *
 *   agents-cursor/<name>.md      Cursor subagent (md + YAML)
 *   agents-codex/<name>.toml     Codex CLI subagent (TOML, `developer_instructions`)
 *   agents-opencode/<name>.md    OpenCode subagent (md + YAML, `mode: subagent`, no model pin)
 *   commands-opencode/<name>.md  OpenCode `/name` shim per skill (OpenCode invokes skills by model only)
 *   opencode/model-profile.{cloud,local}.example.json   optional, user-editable tiering fragments
 *   references/host-model-map.md tier → model per host, printed from the one tier table below
 *   mcp.json                     Cursor MCP config (all servers, `type: "stdio"` made explicit)
 *   mcp.pruned.json              Cursor reference profile for the reported ~40-tool cap
 *   mcp-codex.json               Codex plugin MCP config (`mcpServers`, carried as-is)
 *   opencode/mcp-fragment.json   OpenCode `mcp` block (array `command`, `environment`, local/remote)
 *
 * Usage:
 *   node gen-host-adapters.cjs            # write the adapters (idempotent)
 *   node gen-host-adapters.cjs --check    # exit 1 if the committed output differs from a fresh run
 *
 * `--check` is what doctor.cjs and CI call: the generated dirs are never hand-edited, so any diff is
 * drift. Output is deterministic — sorted names, LF endings, one trailing newline.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(PLUGIN_ROOT, 'agents');
const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');
// The canonical manifest: its `mcpServers` block is the one server list every host config is
// translated from. Read-only here, like every other canonical input.
const MANIFEST_REL = '.claude-plugin/plugin.json';

const DIR_CURSOR = 'agents-cursor';
const DIR_CODEX = 'agents-codex';
const DIR_OPENCODE = 'agents-opencode';
const DIR_COMMANDS = 'commands-opencode';
const DIR_PROFILES = 'opencode';
// The one generated file that lives among hand-written references — the tier table as prose, so
// skills and references can name a tier instead of repeating an id.
const REF_MAP_REL = 'references/host-model-map.md';

// Generated MCP configs. Each sits where its host looks for it: Cursor auto-discovers `mcp.json` at
// the plugin root, the Codex manifest points at `./mcp-codex.json`, and the OpenCode fragment is
// merged into the user's own opencode.json (no host reads it in place).
// The Codex file is NOT called `.mcp.json`: that name is a Claude Code plugin component, read by
// its loader on top of the manifest's own `mcpServers` block, so a Codex-only transport tweak would
// silently change what Claude Code loads — and Claude Code behavior is frozen for this port. The
// Codex manifest points at the file by name, so any name works there.
const MCP_CURSOR_REL = 'mcp.json';
const MCP_CURSOR_PRUNED_REL = 'mcp.pruned.json';
const MCP_CODEX_REL = 'mcp-codex.json';
const MCP_OPENCODE_REL = 'opencode/mcp-fragment.json';

// Dirs this generator owns completely: a file here that it did not produce is stale and gets
// removed (and reported by --check). `opencode/` is deliberately absent — it also holds
// hand-written adapter code from M5/M6, so only its two named files below are generated.
const OWNED_DIRS = [DIR_CURSOR, DIR_CODEX, DIR_OPENCODE, DIR_COMMANDS];

/*
 * THE tier table — the single home of every non-Claude-Code model pin in the plugin. Four rows,
 * one per row of the plan's "Model policy per host" tables; agents (MODEL_TABLE) and ship-pipeline
 * phases (PHASE_TIERS) both resolve through it, and references/host-model-map.md prints it so no
 * prose file has to repeat an id. A host renaming a model is one edit here + a regeneration.
 *
 * cursor: live-verified 2026-08-23 — subagent frontmatter accepts only `inherit` or an exact
 *   versioned id (no family aliases, no `auto`). Owner decision 2026-08-23, per the Domaine
 *   "Model Selection and Agentic Usage Guidelines" (Notion, v1.0 2026-08-17): the routine tier
 *   pins Cursor's cheapest model (composer-2.5 standard variant, $0.50/$2.50 per 1M;
 *   `[fast=false]` because the Fast variant is the default at ~6x the price), and every reasoning
 *   tier pins claude-sonnet-5 — the guidelines start deep PR review at Sonnet and bar Opus from
 *   standard reviews, so a cheap session can no longer silently degrade the review gates.
 *   `escalate` is the next rung, carried as a comment — a subagent pin cannot escalate itself;
 *   going to Opus is the deliberate manual act the guidelines require. Known host bug:
 *   plugin agents currently ignore `model:` frontmatter on EVERY install route (staff-acknowledged,
 *   forum #168771; live-verified 2026-08-24 on the local symlink too) — every subagent inherits the
 *   session model; pins stay in place and bind once Cursor fixes the bug.
 * codex: PROPOSED — owner sign-off pending (plan, Model policy per host). `effort: null` means the
 *   proposed map fixes no reasoning tier for that row.
 * opencode: intentionally absent — no pin, agents and phases inherit the session model so local
 *   providers (ollama/lmstudio) work; optional tiering ships as the example profiles below.
 */
const TIERS = {
  routine: {
    label: 'routine — mechanical, predictable work',
    cursor: { model: 'composer-2.5[fast=false]', escalate: 'inherit' },
    codex: { model: 'gpt-5.6-luna', effort: null },
  },
  standard: {
    label: 'standard dev — the default coding and review tier',
    cursor: { model: 'claude-sonnet-5', escalate: 'claude-opus-5' },
    codex: { model: 'gpt-5.6-terra', effort: 'medium' },
  },
  'deep-review': {
    label: 'deep review — large or risky changes, hard reasoning',
    cursor: { model: 'claude-sonnet-5', escalate: 'claude-opus-5' },
    codex: { model: 'gpt-5.6-terra', effort: 'high' },
  },
  precision: {
    label: 'precision — correctness-critical, security-sensitive work',
    cursor: { model: 'claude-sonnet-5', escalate: 'claude-opus-5' },
    codex: { model: 'gpt-5.6-sol', effort: 'xhigh' },
  },
};

// Which tier each agent sits on. `cursorModel` / `cursorEscalate` override the tier's pin or
// next rung for ONE agent: theme-explorer stays on the standard tier for Codex but scouts
// cheaply on Cursor — its briefs are scoped task recon (the guidelines' Composer bar), not the
// broad exploration the tier's Sonnet pin is priced for.
const MODEL_TABLE = {
  'bug-hunter': { tier: 'precision' },
  'change-reviewer': { tier: 'standard' },
  'doc-reader': { tier: 'routine' },
  'figma-reader': { tier: 'routine' },
  'jira-reader': { tier: 'routine' },
  'jira-writer': { tier: 'routine' },
  'theme-explorer': { tier: 'standard', cursorModel: 'composer-2.5[fast=false]', cursorEscalate: 'claude-sonnet-5',
    cursorNote: "scoped task recon sits at the guidelines' Composer bar, not the tier's Sonnet bar" },
};

/*
 * Ship-pipeline phase classes on the same tiers (references/pipeline-mode.md § Phase-agent models
 * owns the phase→class split; this owns what each class pins to off Claude Code). Claude Code's own
 * pins are canonical prose in that file and deliberately absent here.
 */
const PHASE_TIERS = [
  {
    name: 'conductor — the ship session itself',
    tier: 'standard',
    note: 'no per-spawn pin — the session model ship is started on is the dial; on Cursor, Opus only at the guidelines\' "exceptional" bar',
  },
  {
    name: 'reasoning-heavy — implement, qa, the qa-loop and aftercare fix agents',
    tier: 'standard',
    note: 'escalate one tier for a phase that failed twice, per the guidelines\' failure ladder',
  },
  {
    name: 'mechanical — finalize, create-pr, steps-to-test, the aftercare poll/triage agent',
    tier: 'routine',
    note: 'the aftercare fix agents are reasoning-heavy, not mechanical',
  },
];

// A tier whose codex row fixes no reasoning effort falls back to the canonical agent's own
// `effort:` frontmatter; a phase has no frontmatter, so it falls back to this.
const DEFAULT_CODEX_EFFORT = 'medium';

// tierOf(name) — the resolved per-host pins for one agent, with its Cursor escalation override.
function tierOf(name) {
  const entry = MODEL_TABLE[name];
  const tier = TIERS[entry.tier];
  if (!tier) die(name + ': unknown tier "' + entry.tier + '"');
  const escalate = Object.prototype.hasOwnProperty.call(entry, 'cursorEscalate')
    ? entry.cursorEscalate
    : tier.cursor.escalate;
  const cursorModel = Object.prototype.hasOwnProperty.call(entry, 'cursorModel')
    ? entry.cursorModel
    : tier.cursor.model;
  return {
    tier: entry.tier,
    cursorNote: entry.cursorNote,
    cursor: { model: cursorModel, escalate },
    codex: { model: tier.codex.model, effort: tier.codex.effort },
  };
}

// Per-agent capability map. `readOnly` agents never write: Cursor `readonly`, Codex
// `sandbox_mode = "read-only"`, OpenCode denied edit/write tools. The readers DO write their
// extract into the task workspace, so they stay unrestricted.
// `mcpServers`: null = no scoping (the agent needs several servers, or the host default), [] = no
// MCP at all (the canonical `tools:` list is Read/Grep/Glob/Bash — no MCP tool is reachable).
// M1B-VERIFY: Codex's reading of an empty `mcp_servers` array is unconfirmed until the M1b spike.
const CAPABILITIES = {
  'bug-hunter': { readOnly: true, mcpServers: [] },
  'change-reviewer': { readOnly: true, mcpServers: [] },
  'doc-reader': { readOnly: false, mcpServers: null },
  'figma-reader': { readOnly: false, mcpServers: ['figma-dev-mode'] },
  'jira-reader': { readOnly: false, mcpServers: ['atlassian'] },
  'jira-writer': { readOnly: false, mcpServers: ['atlassian'] },
  'theme-explorer': { readOnly: true, mcpServers: [] },
};

// Example ids for the optional OpenCode tiering fragments, keyed by the model table's `tier`.
// Not a pin and not part of the model table: these files are copied into the user's own
// opencode.json and edited there.
const OPENCODE_PROFILE_EXAMPLES = {
  cloud: {
    routine: 'anthropic/claude-haiku-4-5',
    standard: 'anthropic/claude-sonnet-4-5',
    'deep-review': 'anthropic/claude-sonnet-4-5',
    precision: 'anthropic/claude-opus-4-5',
  },
  local: {
    routine: 'ollama/qwen3:8b',
    standard: 'ollama/qwen3-coder:30b',
    'deep-review': 'ollama/qwen3-coder:30b',
    precision: 'ollama/qwen3:32b',
  },
};

const PROFILE_COMMENT =
  'OPTIONAL model tiering for OpenCode — PROPOSED map, owner sign-off pending (plan: Model policy ' +
  'per host). Generated agents-opencode/*.md carry NO model pin so every agent inherits the ' +
  'session model and local providers work. To opt into tiering, copy the "agent" block into your ' +
  'own opencode.json (yours wins on merge) and replace the ids with ones your provider config ' +
  'actually exposes. Caveat: the fnd review bar (bug-hunter, pre-commit-review) was calibrated on ' +
  'frontier models — a small local model will run, but finding quality is the model choice.';

/*
 * Cursor MCP pruning (M6). Cursor is community-reported to stop exposing tools past ~40 across all
 * connected servers; the plugin bundles six servers whose tool counts add up to roughly three times
 * that. The full list still ships as `mcp.json` — a cap we have not measured is no reason to hand
 * users a smaller plugin — and this ranking drives `mcp.pruned.json`, the profile to fall back to
 * when the cap turns out to bite.
 *
 * The order is the plan's (M6): atlassian > shopify-dev > ONE of chrome-devtools/playwright >
 * figma > notion. `keep` is the cut: everything ranked above it stays, everything below is dropped.
 * Moving the cut is a one-number edit plus a regeneration.
 *
 * M1A-VERIFY: both the cap and these tool counts are unmeasured on Cursor. The counts were observed
 * on 2026-08-22 from the servers as a live Claude Code session exposed them and move with server
 * versions — they are here to show WHY the cut sits where it does, and nothing asserts them.
 */
const CURSOR_TOOL_CAP = 40;
const CURSOR_KEEP_RANKS = 4;
const CURSOR_PRIORITY = [
  {
    server: 'atlassian',
    tools: 31,
    why: 'Jira is the spine of every workflow — ticket read, TA, steps to test, comments, transitions',
  },
  {
    server: 'shopify-dev-mcp',
    tools: 5,
    why: 'the whole Shopify docs + validator surface for five tools — the cheapest server on the list',
  },
  {
    server: 'chrome-devtools-mcp',
    tools: 29,
    why: 'in-browser validation; chosen over playwright for console/network/performance access',
  },
  {
    server: 'figma-dev-mode',
    tools: 10,
    why: 'design context for develop + QA; local Dev Mode server, no auth, small tool surface',
  },
  {
    server: 'playwright',
    tools: 24,
    why: 'DROPPED — second browser stack, capability overlaps chrome-devtools; the plan picks one',
  },
  {
    server: 'notion-mcp',
    tools: 29,
    why: 'DROPPED — doc-reader reaches a shared Notion page over the web when the server is absent',
  },
];

const GEN_NOTE = 'GENERATED by scripts/gen-host-adapters.cjs — do not edit; change the source and re-run.';

// Every generated MCP config carries this instead of the comments JSON cannot hold. M1A/M1B-VERIFY:
// the `_comment` key sits beside `mcpServers`/`mcp`, never inside a server definition, so the worst
// a strict host loader can do is ignore it — a spawn config is never handed an invented key.
const MCP_GEN_NOTE =
  GEN_NOTE +
  ' Source: the canonical Claude Code manifest (' +
  MANIFEST_REL +
  ' -> mcpServers) — the one server list all hosts translate from.';

// `${CLAUDE_PLUGIN_ROOT}` is expanded by Claude Code and by nothing else, so the canonical agents
// keep it (they are the Claude Code copy) and every generated body gets the host-neutral form the
// skills and references already use: `<plugin root>/…` plus an anchor sentence naming where the
// file sits, because a subagent reads its instructions with no skill body around them.
const PLUGIN_ROOT_TOKEN = '${CLAUDE_PLUGIN_ROOT}';

// ------------------------------------------------------------------ frontmatter parsing --

function unquote(v) {
  if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/*
 * Minimal frontmatter reader for the shapes the canonical files actually use: top-level scalars,
 * folded/literal block scalars (`description: >`), and nested blocks whose value we never read
 * (`arguments:` lists) — those collapse to an empty string and are skipped over.
 */
function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  const head = lines.slice(1, end);
  const data = {};
  for (let i = 0; i < head.length; i++) {
    const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(head[i]);
    if (!m) continue;
    const key = m[1];
    const raw = m[2].trim();
    if (raw === '' || /^[>|][-+]?$/.test(raw)) {
      const block = [];
      let j = i + 1;
      for (; j < head.length; j++) {
        if (head[j].trim() === '') {
          block.push('');
          continue;
        }
        if (!/^[ \t]/.test(head[j])) break;
        block.push(head[j].trim());
      }
      i = j - 1;
      data[key] = raw === '' ? '' : block.join(' ').replace(/\s+/g, ' ').trim();
      continue;
    }
    data[key] = unquote(raw);
  }
  return { data, body: lines.slice(end + 1).join('\n') };
}

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function die(msg) {
  process.stderr.write('gen-host-adapters: ' + msg + '\n');
  process.exit(2);
}

// ------------------------------------------------------------------------- serializers --

// YAML double-quoted scalars accept JSON's escape set, so this is safe for any description text.
function yamlStr(s) {
  return JSON.stringify(String(s));
}

function tomlBasicStr(s) {
  return JSON.stringify(String(s));
}

/*
 * TOML multi-line string for an agent body. A literal (''') block keeps backslashes and quotes
 * verbatim, which is what markdown bodies need; a body that contains `'''` (or ends in a quote)
 * cannot be expressed that way, so it falls back to an escaped basic (""") block.
 */
function tomlMultiline(bodyIn) {
  const body = bodyIn.replace(/\s+$/, '');
  if (!body.includes("'''") && !body.endsWith("'")) return "'''\n" + body + "\n'''";
  const escaped = body
    .replace(/\\/g, '\\\\')
    .replace(/"""/g, '\\"\\"\\"')
    .replace(/"$/, '\\"');
  return '"""\n' + escaped + '\n"""';
}

function bodyOf(parsed) {
  return parsed.body.replace(/^\n+/, '').replace(/\s+$/, '');
}

/*
 * hostBody — the agent body as the given host must read it. `selfPath` is the adapter's own place
 * in the bundle and `note` any host-specific caveat about reaching it (OpenCode installs single
 * files by symlink). Bodies that never name the plugin root come through untouched, so the anchor
 * only ever appears where a path actually needs it.
 */
function hostBody(agent, selfPath, note) {
  if (!agent.body.includes(PLUGIN_ROOT_TOKEN)) return agent.body;
  const anchor =
    "**Plugin root** = the plugin's own directory — this agent is `<plugin root>/" + selfPath + '`' +
    (note || '') + ', and every `<plugin root>/…` path below resolves the same way; substitute its ' +
    'absolute path when a command has to run.';
  return anchor + '\n\n' + agent.body.split(PLUGIN_ROOT_TOKEN).join('<plugin root>');
}

function jsonFile(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

// --------------------------------------------------------------------------- collection --

function collectAgents() {
  let files;
  try {
    files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')).sort();
  } catch (e) {
    die('cannot read ' + AGENTS_DIR + ': ' + e.message);
  }
  if (!files.length) die('no agents found in ' + AGENTS_DIR);
  return files.map((file) => {
    const parsed = parseFrontmatter(readText(path.join(AGENTS_DIR, file)));
    if (!parsed) die(file + ': no YAML frontmatter');
    const name = parsed.data.name;
    const slug = file.replace(/\.md$/, '');
    if (!name) die(file + ': frontmatter has no `name`');
    if (name !== slug) die(file + ': frontmatter name "' + name + '" does not match the filename');
    if (!parsed.data.description) die(file + ': frontmatter has no `description`');
    if (!MODEL_TABLE[name]) die(name + ': missing from MODEL_TABLE — add the plan row before generating');
    if (!CAPABILITIES[name]) die(name + ': missing from CAPABILITIES');
    return {
      name,
      file,
      description: parsed.data.description,
      effort: parsed.data.effort || DEFAULT_CODEX_EFFORT,
      body: bodyOf(parsed),
      model: tierOf(name),
      caps: CAPABILITIES[name],
    };
  });
}

function collectSkills() {
  let dirs;
  try {
    dirs = fs
      .readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, d.name, 'SKILL.md')))
      .map((d) => d.name)
      .sort();
  } catch (e) {
    die('cannot read ' + SKILLS_DIR + ': ' + e.message);
  }
  if (!dirs.length) die('no skills found in ' + SKILLS_DIR);
  return dirs.map((dir) => {
    const parsed = parseFrontmatter(readText(path.join(SKILLS_DIR, dir, 'SKILL.md')));
    if (!parsed) die(dir + '/SKILL.md: no YAML frontmatter');
    if (parsed.data.name && parsed.data.name !== dir) {
      die(dir + '/SKILL.md: frontmatter name "' + parsed.data.name + '" does not match the directory');
    }
    if (!parsed.data.description) die(dir + '/SKILL.md: frontmatter has no `description`');
    return { name: dir, description: parsed.data.description };
  });
}

/*
 * collectMcpServers — the canonical `mcpServers` block as an ordered list, one entry per server,
 * classified by transport so each host emitter can translate rather than guess. Canonical key order
 * is preserved (it is deterministic and it is the order a reviewer sees in the manifest).
 *
 * Everything here is a hard stop rather than a skip: a server this script does not understand would
 * otherwise be silently missing from three host configs, which shows up as "the tool just isn't
 * there" in a live session and nowhere else.
 */
function collectMcpServers() {
  const abs = path.join(PLUGIN_ROOT, MANIFEST_REL);
  let manifest;
  try {
    manifest = JSON.parse(readText(abs));
  } catch (e) {
    die('cannot read ' + MANIFEST_REL + ': ' + e.message);
  }
  const canonical = manifest.mcpServers;
  if (!canonical || typeof canonical !== 'object') die(MANIFEST_REL + ': no mcpServers block');
  const names = Object.keys(canonical);
  if (!names.length) die(MANIFEST_REL + ': mcpServers is empty');

  const ranked = new Map(CURSOR_PRIORITY.map((p, i) => [p.server, i]));
  for (const p of CURSOR_PRIORITY) {
    if (!Object.prototype.hasOwnProperty.call(canonical, p.server)) {
      die('CURSOR_PRIORITY ranks "' + p.server + '", absent from ' + MANIFEST_REL);
    }
  }

  return names.map((name) => {
    const def = canonical[name];
    if (!def || typeof def !== 'object') die(name + ': server definition is not an object');
    if (!ranked.has(name)) {
      die(name + ': missing from CURSOR_PRIORITY — rank the server before generating');
    }
    let transport;
    if (def.command) {
      if (typeof def.command !== 'string') die(name + ': `command` must be a string');
      if (def.type && def.type !== 'stdio') die(name + ': has a `command` but type "' + def.type + '"');
      transport = 'stdio';
    } else if (def.url) {
      transport = def.type || 'http';
      if (transport !== 'http' && transport !== 'sse') die(name + ': unsupported remote type "' + transport + '"');
    } else {
      die(name + ': server has neither `command` nor `url`');
    }
    const args = def.args || [];
    if (!Array.isArray(args)) die(name + ': `args` must be an array');
    return {
      name,
      transport,
      rank: ranked.get(name),
      keep: ranked.get(name) < CURSOR_KEEP_RANKS,
      command: def.command,
      args,
      url: def.url,
      // env/headers are carried through verbatim — the canonical list holds no literal secret, only
      // plain switches and whatever passthrough form a server needs, and re-typing either shape here
      // is how a config quietly stops authenticating.
      env: def.env,
      headers: def.headers,
    };
  });
}

// ---------------------------------------------------------------------------- emitters --

function cursorAgent(agent) {
  const { model, escalate } = agent.model.cursor;
  const tierPin = TIERS[agent.model.tier].cursor.model;
  const lines = [
    '---',
    '# ' + GEN_NOTE,
    '# source: agents/' + agent.file,
    '# model: pinned per references/host-model-map.md — the `' + agent.model.tier + '` tier pin' +
      (model === tierPin ? '' : ', overridden per-agent'),
    '#        (Domaine guidelines). Ids verified 2026-08-23.',
  ];
  if (agent.model.cursorNote) {
    lines.push('# override: ' + agent.model.cursorNote + ' — the tier still governs its Codex pin');
  }
  if (escalate) lines.push('# escalate: ' + escalate + ' (next rung of the ladder — the pin is where it starts)');
  lines.push('name: ' + agent.name);
  lines.push('description: ' + yamlStr(agent.description));
  lines.push('model: ' + model);
  if (agent.caps.readOnly) lines.push('readonly: true');
  lines.push('---', '', hostBody(agent, DIR_CURSOR + '/' + agent.name + '.md'), '');
  return lines.join('\n');
}

function codexAgent(agent) {
  const { model, effort } = agent.model.codex;
  const lines = [
    '# ' + GEN_NOTE,
    '# source: agents/' + agent.file,
    '# model / model_reasoning_effort: (proposed — owner sign-off pending, plan Model policy).',
    'name = ' + tomlBasicStr(agent.name),
    'description = ' + tomlBasicStr(agent.description),
    'model = ' + tomlBasicStr(model),
    'model_reasoning_effort = ' + tomlBasicStr(effort || agent.effort),
  ];
  if (agent.caps.readOnly) lines.push('sandbox_mode = "read-only"');
  if (agent.caps.mcpServers) {
    lines.push('mcp_servers = [' + agent.caps.mcpServers.map(tomlBasicStr).join(', ') + ']');
  }
  lines.push(
    'developer_instructions = ' + tomlMultiline(hostBody(agent, DIR_CODEX + '/' + agent.name + '.toml')),
    ''
  );
  return lines.join('\n');
}

function opencodeAgent(agent) {
  const lines = [
    '---',
    '# ' + GEN_NOTE,
    '# source: agents/' + agent.file,
    '# no `model:` key by design — the agent inherits the session model so local providers work;',
    '#        optional tiering: opencode/model-profile.{cloud,local}.example.json.',
    'description: ' + yamlStr(agent.description),
    'mode: subagent',
  ];
  if (agent.caps.readOnly) {
    lines.push('tools:', '  edit: false', '  patch: false', '  write: false');
    lines.push('permission:', '  edit: deny');
  }
  const note = ' (the installer symlinks it into the OpenCode config dir — resolve the link to reach the bundle)';
  lines.push('---', '', hostBody(agent, DIR_OPENCODE + '/' + agent.name + '.md', note), '');
  return lines.join('\n');
}

/*
 * OpenCode invokes skills by model only, so each skill gets a `/name` shim. The shim asks for the
 * skill by name first — the host's own skill lookup knows where it installed it — and names the
 * bundled path only as the fallback, anchored: a bare `../skills/…` would resolve against whatever
 * directory the session happens to sit in, not against this file.
 */
function opencodeCommand(skill) {
  return [
    '---',
    '# ' + GEN_NOTE,
    '# source: skills/' + skill.name + '/SKILL.md',
    'description: ' + yamlStr(skill.description),
    '---',
    '',
    'Load and follow the fnd `' + skill.name + '` skill, with $ARGUMENTS as its input.',
    '',
    'Load it by name through the host\'s skill lookup. If that does not resolve, read the skill body ' +
      'directly: `<plugin root>/skills/' + skill.name + "/SKILL.md`, where **plugin root** = the plugin's " +
      'own directory — this shim is `<plugin root>/' + DIR_COMMANDS + '/' + skill.name + '.md`, symlinked ' +
      'into the OpenCode config dir by the installer.',
    '',
  ].join('\n');
}

/*
 * The tier table as a reference file: skills and references name a TIER and point here, so a model
 * rename never has to be chased through prose. Host-neutral wording (tests/reference-neutral-lint.sh
 * reads this file like any other reference) and no Claude Code row — those pins are canonical.
 */
function hostModelMap(agents) {
  const codexCell = (t) =>
    '`' + TIERS[t].codex.model + '` (' + (TIERS[t].codex.effort || DEFAULT_CODEX_EFFORT) + ' reasoning)';
  const cursorCell = (cursor) =>
    '`' + cursor.model + '`' + (cursor.escalate ? ' → `' + cursor.escalate + '`' : ' (no next rung)');
  const lines = [
    '# Host model map — which model each fnd tier pins to, per host',
    '',
    '<!-- ' + GEN_NOTE + ' -->',
    '',
    'Generated from the tier table in `<plugin root>/scripts/gen-host-adapters.cjs`, where **plugin ' +
      "root** = the plugin's own directory — this file is `<plugin root>/" + REF_MAP_REL + '`. That ' +
      'table is the single home of every model pin outside Claude Code: when a host renames a model, ' +
      'it changes there and this file is regenerated. Never pin an id in prose.',
    '',
    '**Claude Code is not in this file.** Its pins are canonical and live where they always have — ' +
      'each agent\'s own frontmatter and `<plugin root>/references/pipeline-mode.md`.',
    '',
    '**Codex ids are PROPOSED** — owner sign-off pending. **OpenCode pins nothing**: agents and ' +
      'phases inherit the session model so local providers work, and tiering is opt-in by copying ' +
      '`<plugin root>/opencode/model-profile.cloud.example.json` (or `.local.`) into your own ' +
      'opencode.json.',
    '',
    '## Tiers',
    '',
    '| Tier | Cursor (start → escalate) | Codex (proposed) |',
    '| --- | --- | --- |',
  ];
  for (const t of Object.keys(TIERS)) {
    lines.push('| `' + t + '` — ' + TIERS[t].label.split('— ')[1] + ' | ' + cursorCell(TIERS[t].cursor) + ' | ' + codexCell(t) + ' |');
  }
  const overridden = Object.keys(MODEL_TABLE)
    .filter((n) => Object.prototype.hasOwnProperty.call(MODEL_TABLE[n], 'cursorModel'));
  lines.push(
    '',
    'Cursor pins every agent (verified against cursor.com docs 2026-08-23: frontmatter takes ' +
      'only `inherit` or an exact versioned id — no family aliases, no `auto`): the routine tier ' +
      "pins Cursor's cheapest model — `composer-2.5[fast=false]`, the standard variant, since Fast " +
      'is the pricier default — and the reasoning tiers pin `claude-sonnet-5`, where the Domaine ' +
      'model-selection guidelines start deep PR review (they also bar Opus from standard reviews, ' +
      'so the pin is both a floor under cheap sessions and the guidelines\' ceiling for routine ' +
      'gates).' +
      (overridden.length
        ? ' Per-agent overrides in the generator\'s tier table move ' +
          overridden.map((n) => '`' + n + '`').join(', ') +
          ' off its tier\'s Cursor pin (rationale in that agent\'s generated header) — the ' +
          'Subagents table below is authoritative per agent.'
        : '') +
      ' The escalate column is the next rung of the ladder, taken after a failed attempt ' +
      'or at the guidelines\' high-risk bar, never as a starting point. Caveat: Cursor currently ignores subagent ' +
      '`model:` frontmatter on every install route (staff-acknowledged bug; live-verified 2026-08-24 on the ' +
      'local-symlink install too) — every agent inherits the session model until Cursor fixes it; the pins stay ' +
      'in place and bind the moment that fix ships.',
    '',
    '## Subagents',
    '',
    '| Agent | Tier | Cursor | Codex (proposed) |',
    '| --- | --- | --- | --- |'
  );
  for (const a of agents) {
    lines.push(
      '| `' + a.name + '` | `' + a.model.tier + '` | ' + cursorCell(a.model.cursor) + ' | ' +
        '`' + a.model.codex.model + '` (' + (a.model.codex.effort || a.effort) + ' reasoning) |'
    );
  }
  lines.push(
    '',
    'These are already pinned in the generated agent files (`agents-cursor/`, `agents-codex/`) — the ' +
      'table is here so a reader can see the whole map in one place.',
    '',
    '## Ship-pipeline phases',
    '',
    'Phase classes come from `<plugin root>/references/pipeline-mode.md`; the conductor passes the ' +
      "phase's model on every spawn.",
    '',
    '| Phase class | Tier | Cursor | Codex (proposed) |',
    '| --- | --- | --- | --- |'
  );
  for (const p of PHASE_TIERS) {
    lines.push(
      '| ' + p.name + ' | `' + p.tier + '` | ' + cursorCell(TIERS[p.tier].cursor) + ' | ' + codexCell(p.tier) + ' |'
    );
  }
  lines.push('');
  for (const p of PHASE_TIERS) lines.push('- **' + p.name.split(' —')[0] + '**: ' + p.note);
  lines.push('');
  return lines.join('\n');
}

function opencodeProfile(variant, agents) {
  const ids = OPENCODE_PROFILE_EXAMPLES[variant];
  const agent = {};
  for (const a of agents) {
    const id = ids[a.model.tier];
    if (!id) die(a.name + ': tier "' + a.model.tier + '" has no ' + variant + ' example id');
    agent[a.name] = { model: id };
  }
  // GEN_NOTE leads, as it does on every other generated file — this one is user-editable only
  // after it has been copied out, and editing it in place is overwritten by the next run.
  return jsonFile({ _comment: GEN_NOTE + ' ' + PROFILE_COMMENT, agent });
}

// --------------------------------------------------------------------------- MCP configs --

/*
 * Cursor. Its config is the Claude shape with the transport spelled out: `type: "stdio"` is implicit
 * in the canonical manifest (Claude Code infers it from `command`) and explicit here, because a
 * remote entry in the same file makes the omission look like an oversight rather than a default.
 * env/args/headers are carried verbatim.
 */
function cursorEntry(s) {
  if (s.transport === 'stdio') {
    const e = { type: 'stdio', command: s.command, args: s.args };
    if (s.env) e.env = s.env;
    return e;
  }
  const e = { type: s.transport, url: s.url };
  if (s.headers) e.headers = s.headers;
  return e;
}

function cursorMcp(servers) {
  const mcpServers = {};
  for (const s of servers) mcpServers[s.name] = cursorEntry(s);
  const dropped = servers.filter((s) => !s.keep).map((s) => s.name);
  return jsonFile({
    _comment:
      MCP_GEN_NOTE +
      ' All ' +
      servers.length +
      ' bundled servers, which is what a Cursor install gets by default. Cursor is community-reported' +
      ' to stop exposing tools past ~' +
      CURSOR_TOOL_CAP +
      ' across all connected servers (unmeasured — M1A-VERIFY). If you hit that, switch to the' +
      ' priority profile in mcp.pruned.json, which keeps ' +
      (servers.length - dropped.length) +
      ' servers and drops ' +
      dropped.join(', ') +
      '. Re-enabling a dropped server is a per-server toggle in Cursor Settings -> MCP, or a' +
      ' regeneration of this file; see the README section "Bundled MCP servers".',
    mcpServers,
  });
}

/*
 * The pruned Cursor profile. Emitted in priority-rank order so the file reads as the ranking it is,
 * with each kept server's reason and each dropped one named in the header. No host loads it: it is
 * the reference for which servers to keep, and the paste source for anyone who prefers to prune by
 * file rather than by Cursor's per-server toggles.
 */
function cursorMcpPruned(servers) {
  const byRank = servers.slice().sort((a, b) => a.rank - b.rank);
  const mcpServers = {};
  let running = 0;
  const ladder = [];
  for (const s of byRank) {
    const meta = CURSOR_PRIORITY[s.rank];
    if (s.keep) {
      mcpServers[s.name] = cursorEntry(s);
      running += meta.tools;
    }
    ladder.push(
      (s.rank + 1) +
        '. ' +
        s.name +
        ' (~' +
        meta.tools +
        ' tools' +
        (s.keep ? ', running total ~' + running : '') +
        ') — ' +
        (s.keep ? 'KEPT' : 'dropped') +
        ': ' +
        meta.why.replace(/^DROPPED — /, '')
    );
  }
  return jsonFile({
    _comment:
      MCP_GEN_NOTE +
      ' PRIORITY PROFILE for Cursor, not loaded by any host — the fallback list for the reported' +
      ' ~' +
      CURSOR_TOOL_CAP +
      '-tool cap (M1A-VERIFY: neither the cap nor the counts below are measured; they show why the' +
      ' cut sits where it does). Two ways to apply it: (a) leave mcp.json alone and turn the dropped' +
      ' servers off in Cursor Settings -> MCP — nothing in the checkout changes; (b) copy this' +
      ' block over mcp.json in your clone, which is deliberate local drift that doctor.cjs and' +
      ' gen-host-adapters.cjs --check will both report, and `node scripts/gen-host-adapters.cjs`' +
      ' undoes. To change the cut for everyone, move CURSOR_KEEP_RANKS in the generator and re-run —' +
      ' note that if ~' +
      CURSOR_TOOL_CAP +
      ' turns out to be a hard ceiling the running totals below say only ranks 1-2 fit. The cut sits' +
      ' at ' +
      CURSOR_KEEP_RANKS +
      " because the plan's ranking keeps one browser server and figma usable; the measured cap" +
      ' behaviour (M1a) decides which of the two wins.',
    _priority: ladder,
    mcpServers,
  });
}

/*
 * Codex. A plugin bundles JSON in the Claude `mcpServers` shape, so this is a near-plain
 * translation. The one rewrite is SSE — M1b MEASURED live 2026-08-23: Codex drives every remote
 * `url` entry through its streamable-HTTP client (no SSE client), so figma's `/sse` endpoint
 * answered HTTP 404 to the initialize POST. The same Figma desktop server speaks streamable HTTP
 * at `/mcp`, so an sse entry is emitted as `type: "http"` with a trailing `/sse` swapped for
 * `/mcp`; the manual fallback stays in the header because JSON has nowhere else to put it.
 */
function codexEntry(s) {
  if (s.transport === 'stdio') {
    const e = { command: s.command, args: s.args };
    if (s.env) e.env = s.env;
    return e;
  }
  const e = {
    type: 'http',
    url: s.transport === 'sse' ? s.url.replace(/\/sse$/, '/mcp') : s.url,
  };
  if (s.headers) e.headers = s.headers;
  return e;
}

function codexMcp(servers) {
  const mcpServers = {};
  for (const s of servers) mcpServers[s.name] = codexEntry(s);
  const sse = servers.filter((s) => s.transport === 'sse').map((s) => s.name);
  return jsonFile({
    _comment:
      MCP_GEN_NOTE +
      ' Loaded through the ' +
      '.codex-plugin/plugin.json' +
      ' `mcpServers` pointer — deliberately NOT named .mcp.json, which Claude Code reads as a plugin' +
      ' MCP component of its own, on top of the mcpServers block its own manifest already declares.' +
      ' stdio and streamable-HTTP servers are documented Codex transports and' +
      ' are carried as-is. M1b MEASURED 2026-08-23: Codex has no SSE client — it drives every' +
      ' remote url through its streamable-HTTP client, so an /sse endpoint answers HTTP 404 at' +
      ' initialize; ' +
      (sse.join(', ') || 'no server') +
      ' is therefore re-pointed at the streamable `/mcp` path the same server serves. If it still' +
      ' does not connect, remove it from this file and add it per-user instead' +
      ' (`codex mcp add figma-dev-mode --url http://127.0.0.1:3845/mcp`, adjusting for the syntax the' +
      ' installed CLI accepts); everything else keeps working. Codex documents no tool-count cap, so' +
      ' no pruning is applied here — per-server `enabled_tools`/`disabled_tools` is the lever if one' +
      ' appears. Codex has no per-tool trust prompt for MCP config, but hook wiring is trust-reviewed' +
      ' separately (`/hooks`).',
    mcpServers,
  });
}

/*
 * OpenCode. The one host with a different shape: `command` is an argv ARRAY (no shell splitting),
 * `environment` rather than `env`, and transport is `type: local | remote` with the wire protocol
 * inferred from the URL rather than declared.
 */
function opencodeEntry(s) {
  if (s.transport === 'stdio') {
    const e = { type: 'local', command: [s.command].concat(s.args) };
    if (s.env) e.environment = s.env;
    return e;
  }
  const e = { type: 'remote', url: s.url };
  if (s.headers) e.headers = s.headers;
  return e;
}

function opencodeMcp(servers) {
  const mcp = {};
  for (const s of servers) mcp[s.name] = opencodeEntry(s);
  const sse = servers.filter((s) => s.transport === 'sse').map((s) => s.name);
  return jsonFile({
    _comment:
      MCP_GEN_NOTE +
      ' FRAGMENT, not a config: merge the `mcp` block into your own opencode.json (~/.config/opencode/' +
      'opencode.json or the project one) and drop this `_comment` key. OpenCode shapes differ from the' +
      ' other hosts — `command` is an argv array, `environment` replaces `env`, and a server is' +
      ' `type: "local"` or `type: "remote"`. M1C-VERIFY: ' +
      (sse.join(', ') || 'no server') +
      ' is an SSE endpoint carried as a plain `remote` url because OpenCode documents no separate SSE' +
      ' type; if the transport is not negotiated, that server needs a host-side answer, and the rest' +
      ' are unaffected. No tool-count cap is documented for OpenCode, so all servers ship; per-tool' +
      ' pruning, if you want it, is a `"tools": {"<server>_*": false}` glob in your own config.',
    mcp,
  });
}

// ------------------------------------------------------------------------------ output --

function buildOutputs() {
  const agents = collectAgents();
  const skills = collectSkills();
  const servers = collectMcpServers();
  const files = new Map();
  for (const a of agents) {
    files.set(path.join(DIR_CURSOR, a.name + '.md'), cursorAgent(a));
    files.set(path.join(DIR_CODEX, a.name + '.toml'), codexAgent(a));
    files.set(path.join(DIR_OPENCODE, a.name + '.md'), opencodeAgent(a));
  }
  for (const s of skills) files.set(path.join(DIR_COMMANDS, s.name + '.md'), opencodeCommand(s));
  for (const variant of Object.keys(OPENCODE_PROFILE_EXAMPLES)) {
    files.set(path.join(DIR_PROFILES, 'model-profile.' + variant + '.example.json'), opencodeProfile(variant, agents));
  }
  files.set(REF_MAP_REL, hostModelMap(agents));
  files.set(MCP_CURSOR_REL, cursorMcp(servers));
  files.set(MCP_CURSOR_PRUNED_REL, cursorMcpPruned(servers));
  files.set(MCP_CODEX_REL, codexMcp(servers));
  files.set(MCP_OPENCODE_REL, opencodeMcp(servers));
  return { files, agents, skills, servers };
}

function ownedOnDisk() {
  const found = [];
  for (const dir of OWNED_DIRS) {
    const abs = path.join(PLUGIN_ROOT, dir);
    let entries = [];
    try {
      entries = fs.readdirSync(abs);
    } catch (e) {
      continue;
    }
    for (const e of entries) {
      if (e.startsWith('.')) continue;
      found.push(path.join(dir, e));
    }
  }
  return found.sort();
}

function write(files) {
  let written = 0;
  for (const [rel, content] of files) {
    const abs = path.join(PLUGIN_ROOT, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    let current = null;
    try {
      current = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      /* new file */
    }
    if (current === content) continue;
    fs.writeFileSync(abs, content);
    written++;
  }
  let removed = 0;
  for (const rel of ownedOnDisk()) {
    if (files.has(rel)) continue;
    fs.rmSync(path.join(PLUGIN_ROOT, rel), { recursive: true, force: true });
    removed++;
  }
  return { written, removed };
}

function check(files) {
  const problems = [];
  for (const [rel, content] of files) {
    let current;
    try {
      current = fs.readFileSync(path.join(PLUGIN_ROOT, rel), 'utf8');
    } catch (e) {
      problems.push(rel + ' is missing — re-run scripts/gen-host-adapters.cjs');
      continue;
    }
    if (current !== content) problems.push(rel + ' differs from the generator output');
  }
  for (const rel of ownedOnDisk()) {
    if (!files.has(rel)) problems.push(rel + ' is stale — no canonical source produces it');
  }
  return problems;
}

function main(argv) {
  const checkOnly = argv.includes('--check');
  for (const a of argv) {
    if (a !== '--check') die('unknown argument ' + a + ' (usage: gen-host-adapters.cjs [--check])');
  }
  const { files, agents, skills, servers } = buildOutputs();
  if (checkOnly) {
    const problems = check(files);
    if (problems.length) {
      process.stderr.write(problems.join('\n') + '\n');
      process.exit(1);
    }
    process.stdout.write('generated adapters in sync (' + files.size + ' files)\n');
    return;
  }
  const { written, removed } = write(files);
  process.stdout.write(
    'agents: ' + agents.length + ', skills: ' + skills.length + ', mcp servers: ' + servers.length +
      ', files: ' + files.size + ' (' + written + ' written, ' + removed + ' stale removed)\n'
  );
}

main(process.argv.slice(2));
