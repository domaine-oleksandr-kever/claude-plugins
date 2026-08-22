#!/usr/bin/env node
/*
 * gen-host-adapters.cjs — per-host agent + command adapters for the multi-harness port (M4).
 *
 * Canonical Claude Code content (`agents/*.md`, `skills/<name>/SKILL.md`) is the ONLY input and is
 * never written to. Every other host gets a committed, generated adapter so a `git pull` ships the
 * same agent bodies everywhere and no install step needs Node beyond this script:
 *
 *   agents-cursor/<name>.md      Cursor subagent (md + YAML)
 *   agents-codex/<name>.toml     Codex CLI subagent (TOML, `developer_instructions`)
 *   agents-opencode/<name>.md    OpenCode subagent (md + YAML, `mode: subagent`, no model pin)
 *   commands-opencode/<name>.md  OpenCode `/name` shim per skill (OpenCode invokes skills by model only)
 *   opencode/model-profile.{cloud,local}.example.json   optional, user-editable tiering fragments
 *   references/host-model-map.md tier → model per host, printed from the one tier table below
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

const DIR_CURSOR = 'agents-cursor';
const DIR_CODEX = 'agents-codex';
const DIR_OPENCODE = 'agents-opencode';
const DIR_COMMANDS = 'commands-opencode';
const DIR_PROFILES = 'opencode';
// The one generated file that lives among hand-written references — the tier table as prose, so
// skills and references can name a tier instead of repeating an id.
const REF_MAP_REL = 'references/host-model-map.md';

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
 * cursor: Domaine "Model Selection and Agentic Usage Guidelines" v1.0 scenario rows. `model` is the
 *   START of the ladder, pinned in the least-versioned form the guidelines allow (`composer`,
 *   `sonnet`, `gpt-5.5`, `opus`) per the Model-churn policy; id forms unverified until M1a.
 *   `escalate` is the next rung, carried as a comment — a subagent pin cannot escalate itself.
 * codex: PROPOSED — owner sign-off pending (plan, Model policy per host). `effort: null` means the
 *   proposed map fixes no reasoning tier for that row.
 * opencode: intentionally absent — no pin, agents and phases inherit the session model so local
 *   providers (ollama/lmstudio) work; optional tiering ships as the example profiles below.
 */
const TIERS = {
  routine: {
    label: 'routine — mechanical, predictable work',
    cursor: { model: 'composer', escalate: 'sonnet' },
    codex: { model: 'gpt-5.6-luna', effort: null },
  },
  standard: {
    label: 'standard dev — the default coding and review tier',
    cursor: { model: 'sonnet', escalate: 'gpt-5.5' },
    codex: { model: 'gpt-5.6-terra', effort: 'medium' },
  },
  'deep-review': {
    label: 'deep review — large or risky changes, hard reasoning',
    cursor: { model: 'gpt-5.5', escalate: 'opus' },
    codex: { model: 'gpt-5.6-terra', effort: 'high' },
  },
  precision: {
    label: 'precision — correctness-critical, security-sensitive work',
    cursor: { model: 'gpt-5.5', escalate: 'opus' },
    codex: { model: 'gpt-5.6-sol', effort: 'xhigh' },
  },
};

// Which tier each agent sits on. `cursorEscalate` overrides the tier's next rung where the
// guidelines row names none (theme-explorer is "Sonnet", full stop); bug-hunter sits on the
// proposed map's "Opus (bug-hunter bar)" row even though its Cursor ladder starts a rung lower.
const MODEL_TABLE = {
  'bug-hunter': { tier: 'precision' },
  'change-reviewer': { tier: 'standard' },
  'doc-reader': { tier: 'routine' },
  'figma-reader': { tier: 'routine' },
  'jira-reader': { tier: 'routine' },
  'jira-writer': { tier: 'routine' },
  'theme-explorer': { tier: 'standard', cursorEscalate: null },
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
    note: 'the strongest session model the host offers; on Cursor, Opus only at the guidelines\' "exceptional" bar',
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
  return {
    tier: entry.tier,
    cursor: { model: tier.cursor.model, escalate },
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

const GEN_NOTE = 'GENERATED by scripts/gen-host-adapters.cjs — do not edit; change the source and re-run.';

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

// ---------------------------------------------------------------------------- emitters --

function cursorAgent(agent) {
  const { model, escalate } = agent.model.cursor;
  const lines = [
    '---',
    '# ' + GEN_NOTE,
    '# source: agents/' + agent.file,
    '# model: Domaine Model Selection and Agentic Usage Guidelines v1.0, scenario row for this agent;',
    '#        pinned in least-versioned form — id forms unverified until M1a.',
  ];
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
  lines.push(
    '',
    'Cursor pins are the Domaine "Model Selection and Agentic Usage Guidelines" v1.0 scenario rows, ' +
      'in the least-versioned form the doc allows; the escalate column is the next rung of the ' +
      'ladder, taken after a failed attempt, never as a starting point.',
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
  return jsonFile({ _comment: PROFILE_COMMENT, agent });
}

// ------------------------------------------------------------------------------ output --

function buildOutputs() {
  const agents = collectAgents();
  const skills = collectSkills();
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
  return { files, agents, skills };
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
  const { files, agents, skills } = buildOutputs();
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
    'agents: ' + agents.length + ', skills: ' + skills.length + ', files: ' + files.size +
      ' (' + written + ' written, ' + removed + ' stale removed)\n'
  );
}

main(process.argv.slice(2));
