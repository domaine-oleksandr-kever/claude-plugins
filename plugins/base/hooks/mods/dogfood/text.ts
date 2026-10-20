// Dogfood mode's pure parts: the plugin_defect tool's schema, the report file's name and
// body, the install-record readings, the plugin-script failure test and the index parser. No `$` here.
import { utf8Bytes } from '../events.ts'

export const PLUGINS = ['slim', 'band', 'base', 'fe', 'be', 'qa', 'pm'] as const
export const KINDS = ['skill', 'script', 'hook', 'mod', 'doctor', 'output', 'docs', 'other'] as const
export const SUSPECTS = ['plugin', 'project', 'unsure'] as const
export const TOOL_NAME = 'plugin_defect'
export const TOOL = `mcp__base__${TOOL_NAME}`
export const EVIDENCE_BYTES = 2048
/** Every other free-text field; the model's text is data and never grows a report without bound. */
export const FIELD_CHARS = 4000
export const TITLE_CHARS = 120
export const SLUG_CHARS = 40
export const WINDOW_DAYS = 7
export const NUDGE = 'base dogfood: a plugin script failed — report it with plugin_defect (not among your tools: in your reply) before working around it'

export const TOOL_DESC = `Report a defect in a Domaine plugin (${PLUGINS.join(', ')}) you hit while working: a script that failed or returned odd output, a hook or mod that threw, a skill that contradicts the code, a doctor FAIL, wrong slim output, a convention wrong for this host. Writes a report under the project's .claude/plugin-defects/ and returns its path; github: true also files a GitHub issue (only when the person asked). Where no surface draws (a cloud session, claude -p) it returns the whole report and files the issue unless github: false. Never put secrets, tokens or passwords in any field.`

export const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    plugin: { type: 'string', enum: [...PLUGINS], description: 'The plugin at fault.' },
    kind: { type: 'string', enum: [...KINDS], description: 'What part of it.' },
    title: { type: 'string', description: `One line, at most ${TITLE_CHARS} characters.` },
    path: { type: 'string', description: "The plugin file at fault as file:line, or ''." },
    observed: { type: 'string', description: 'What happened.' },
    expected: { type: 'string', description: 'What should have happened.' },
    reproduce: { type: 'string', description: 'The commands or the tool call that show it.' },
    evidence: { type: 'string', description: `The raw output, error or stub; cut at ${EVIDENCE_BYTES} bytes.` },
    suspect: { type: 'string', enum: [...SUSPECTS], description: 'Whose fault it looks like.' },
    github: { type: 'boolean', description: 'Also file a GitHub issue; true only when the person asked. Default false; where no surface draws, default true.' },
  },
  required: ['plugin', 'kind', 'title', 'observed', 'expected'],
} as const

export type Plugin = (typeof PLUGINS)[number]
export type Defect = {
  plugin: Plugin
  kind: (typeof KINDS)[number]
  title: string
  path: string
  observed: string
  expected: string
  reproduce: string
  evidence: string
  suspect: (typeof SUSPECTS)[number]
  /** null = not given: the session decides (no surface draws → file). */
  github: boolean | null
}

// C0 but tab and newline, DEL, C1: an ESC or NUL must not reach a file name, a heading, the index or gh's argv.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(CONTROL, '') : '')
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => (list as readonly unknown[]).includes(v) ? (v as T) : null
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} [cut at ${n} characters]` : s)

/** The tool's arguments checked and capped, or the reason they are refused. */
export function parseDefect(a: Record<string, unknown>): Defect | string {
  const plugin = oneOf(PLUGINS, a.plugin)
  if (!plugin) return `plugin_defect: plugin must be one of ${PLUGINS.join(', ')}`
  const kind = oneOf(KINDS, a.kind)
  if (!kind) return `plugin_defect: kind must be one of ${KINDS.join(', ')}`
  const title = str(a.title).replace(/\s+/g, ' ').trim().slice(0, TITLE_CHARS)
  if (!title) return 'plugin_defect: title is empty'
  return {
    plugin,
    kind,
    title,
    path: str(a.path).replace(/\s+/g, ' ').trim().slice(0, 300),
    observed: cut(str(a.observed).trim(), FIELD_CHARS),
    expected: cut(str(a.expected).trim(), FIELD_CHARS),
    reproduce: cut(str(a.reproduce).trim(), FIELD_CHARS),
    evidence: capEvidence(str(a.evidence)),
    suspect: oneOf(SUSPECTS, a.suspect) ?? 'unsure',
    github: typeof a.github === 'boolean' ? a.github : null,
  }
}

/** At most EVIDENCE_BYTES UTF-8 bytes, with a line saying how much was given when cut. */
export function capEvidence(text: string): string {
  const total = utf8Bytes(text)
  if (total <= EVIDENCE_BYTES) return text
  let out = ''
  let n = 0
  for (const ch of text) {
    n += utf8Bytes(ch)
    if (n > EVIDENCE_BYTES) break
    out += ch
  }
  return `${out}\n[evidence truncated at 2 KB: ${total} bytes given]`
}

/** `[a-z0-9-]`, at most SLUG_CHARS, never empty: no path separator or dot survives. */
export function slugOf(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SLUG_CHARS).replace(/-+$/, '')
  return s || 'defect'
}

/** `<date>-<plugin>-<slug>`, `-2`, `-3`… for the n-th clash. */
export function fileName(date: string, plugin: Plugin, slug: string, n: number): string {
  return `${date}-${plugin}-${slug}${n > 1 ? `-${n}` : ''}.md`
}

/** A fence longer than any backtick run in `text`: the text cannot close it and forge a section after it. */
export function fenced(text: string, lang = 'text'): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(m => m[0].length))
  const f = '`'.repeat(longest + 1)
  return `${f}${lang}\n${text}\n${f}`
}

export type Environment = {
  root: string
  remote: string | null
  branch: string | null
  commit: string | null
  versions: string
  surfaces: string
  claudeCode: string | null
  session: string
  workId: string | null
}

export type Meta = { version: string; date: string; session: string; workId: string | null }

export function defectBody(d: Defect, m: Meta, env: Environment): string {
  const or = (s: string, none = '(none given)') => s || none
  return [
    '---',
    `plugin: ${d.plugin}`,
    `version: ${JSON.stringify(m.version)}`,
    `kind: ${d.kind}`,
    `suspect: ${d.suspect}`,
    `date: ${m.date}`,
    `session: ${JSON.stringify(m.session)}`,
    `work_id: ${m.workId === null ? 'null' : JSON.stringify(m.workId)}`,
    '---',
    '',
    `# [${d.plugin}] ${d.title}`,
    '',
    `Path: ${or(d.path, '(not given)')}`,
    '',
    '## Observed',
    '',
    d.observed ? fenced(d.observed) : '(none given)',
    '',
    '## Expected',
    '',
    d.expected ? fenced(d.expected) : '(none given)',
    '',
    '## Reproduce',
    '',
    d.reproduce ? fenced(d.reproduce) : '(none given)',
    '',
    '## Evidence',
    '',
    d.evidence ? fenced(d.evidence) : '(none given)',
    '',
    '## Environment',
    '',
    `- project root: ${env.root}`,
    `- git: ${env.remote?.replace(/^([a-z][\w+.-]*:\/\/)[^@/]*@/i, '$1') ?? '(no remote)'} · ${env.branch ?? '(no branch)'} · ${env.commit ?? '(no commit)'}`,
    `- plugins: ${env.versions}`,
    `- surfaces: ${env.surfaces}`,
    `- Claude Code: ${env.claudeCode ?? 'unknown'}`,
    `- session: ${env.session}`,
    `- work id: ${env.workId ?? 'none'}`,
    '',
  ].join('\n')
}

export const indexLine = (date: string, d: Defect, path: string) => `- ${date} ${d.plugin} ${d.title} → ${path}`

type Record_ = { installPath?: unknown; version?: unknown }

/** installed_plugins.json's records as `[name, marketplace, record]`; [] when unreadable. */
function records(installed: string | null): [string, string, Record_][] {
  try {
    const plugins = (JSON.parse(installed ?? '') as { plugins?: Record<string, Record_[]> }).plugins ?? {}
    return Object.entries(plugins).flatMap(([key, list]) => {
      const at = key.lastIndexOf('@')
      return Array.isArray(list) && at > 0 ? list.map(r => [key.slice(0, at), key.slice(at + 1), r] as [string, string, Record_]) : []
    })
  } catch {
    return []
  }
}

/** The marketplace base was installed from: the record whose install path is base's root; null for a --plugin-dir or synced load. */
export function marketplaceOf(installed: string | null, root: string): string | null {
  return records(installed).find(([name, , r]) => name === 'base' && r.installPath === root)?.[1] ?? null
}

/**
 * Each Domaine plugin this session can name, with its version where known: base's own manifest, slim's info
 * atom, then the install record (base's marketplace first); a plugin enabled in settings without a record
 * stands without a version.
 */
export function versionsOf(installed: string | null, root: string, own: string, slim: string | null, enabled: readonly string[]): Map<Plugin, string | null> {
  const mk = marketplaceOf(installed, root)
  const recs = records(installed)
  const out = new Map<Plugin, string | null>()
  for (const p of PLUGINS) {
    const rec = recs.find(([n, m]) => n === p && m === mk) ?? recs.find(([n]) => n === p)
    const v = p === 'base' ? own : p === 'slim' && slim ? slim : typeof rec?.[2].version === 'string' ? rec[2].version : null
    if (v !== null || p === 'base' || enabled.includes(p)) out.set(p, v)
  }
  return out
}

export function versionsLine(v: Map<Plugin, string | null>): string {
  return [...v].map(([p, ver]) => (ver ? `${p} ${ver}` : `${p} (version unknown)`)).join(', ')
}

/** The enabledPlugins names of settings that are switched on. */
export function enabledNames(settings: unknown): string[] {
  const e = (settings as { enabledPlugins?: unknown } | null)?.enabledPlugins
  if (!e || typeof e !== 'object') return []
  return Object.entries(e as Record<string, unknown>).filter(([, on]) => on === true).map(([k]) => (k.lastIndexOf('@') > 0 ? k.slice(0, k.lastIndexOf('@')) : k))
}

const REPO = /^[\w.-]+\/[\w.-]+$/

/** `owner/repo` of a marketplace with a github source; null otherwise. */
export function repoOf(known: string | null, marketplace: string | null): string | null {
  if (!marketplace) return null
  try {
    const src = (JSON.parse(known ?? '') as Record<string, { source?: { source?: unknown; repo?: unknown } }>)[marketplace]?.source
    return src?.source === 'github' && typeof src.repo === 'string' && REPO.test(src.repo) ? src.repo : null
  } catch {
    return null
  }
}

export const isRepo = (s: string) => REPO.test(s)

const NAMES = PLUGINS.join('|')
// A path runs only in command position: a command's first word, or the script argument of an interpreter that is one.
const RUN = `(?:^|[;&|(\`])\\s*(?:(?:\\w+=\\S*|env|exec|time)\\s+)*(?:[^\\s;&|()]*/)?(?:(?:node|bash|sh|zsh|python3?)(?:\\s+-\\S+)*\\s+)?["']?`
const IN_REPO = new RegExp(`${RUN}(?:[^\\s"';|&()]*/)?plugins/(?:${NAMES})/scripts/[^\\s"';|&)<>\`]+`)
const IN_CACHE = new RegExp(
  `${RUN}[^\\s"';|&()]*/\\.claude[^/\\s"']*/plugins/(?:cache/[^/\\s"']+/(?:${NAMES})/[^/\\s"']+|synced/[^/\\s"']+/(?:${NAMES})(?:~[^/\\s"']*)?)/scripts/[^\\s"';|&)<>\`]+`,
)
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/** The basename of the Domaine plugin script a command runs (repo `plugins/<name>/scripts/`, the plugin cache of any config dir or its synced copy), else null; a path merely named (grep, cat, ls) is not a run. */
export function pluginScript(command: string): string | null {
  const p = (IN_CACHE.exec(command) ?? IN_REPO.exec(command))?.[0]
  return p ? base(p) : null
}

/** The basenames of every Domaine plugin script a command runs, in no particular order. */
export const pluginScripts = (command: string): string[] =>
  [IN_CACHE, IN_REPO].flatMap(re => [...command.matchAll(new RegExp(re.source, 'g'))].map(m => base(m[0])))

/**
 * True when the plugin script's command is the line's last: the exit code is then the script's own. After
 * `script; echo done` or `script | head` it belongs to another command (`2>&1` redirects are not a `&`).
 */
export function scriptLast(command: string): boolean {
  const m = IN_CACHE.exec(command) ?? IN_REPO.exec(command)
  if (!m) return false
  const tail = command.slice(m.index + m[0].length).replace(/\d*>&\d+/g, '')
  return !/[;&|\n]/.test(tail)
}

/** The stdout and stderr of a Bash result as one text. */
export function bashText(r: { result?: unknown; text?: unknown }): string {
  if (typeof r.result === 'string') return r.result
  const o = (r.result ?? {}) as { stdout?: unknown; stderr?: unknown }
  const parts = [o.stdout, o.stderr].filter((s): s is string => typeof s === 'string')
  return parts.length ? parts.join('\n') : typeof r.text === 'string' ? r.text : ''
}

/** A Bash result that failed: an error result, or `Error` in its stderr. */
export function bashFailed(r: { isError?: true; result?: unknown }): boolean {
  if (r.isError) return true
  const stderr = (r.result as { stderr?: unknown } | null)?.stderr
  return typeof stderr === 'string' && /\bError\b/.test(stderr)
}

/**
 * The `error=` reasons that are refusals: the caller's input or usage, the checkout or toml, a store state a guard
 * stops at, a named thing that is not there, a designed degrade rung, a credential not set up. Every other
 * reason — a tool or the plugin's own file missing, a credential set but rejected, a remote call, the script's own
 * machinery — is a failure. Matched against the text after `error=`; a free-text reason (`unknown arg: x`) counts too.
 */
const REFUSAL = new RegExp(`^(?:${[
  'usage', 'unknown[_ ]', 'unexpected_', 'missing[_ ]', 'too many ', '(?:--)?[a-z][a-z-]* (?:requires|needs) ', 'conflicting_', 'ambiguous_',
  'not_a_', 'not_applied', 'upload_rejected\\b', 'unusable_', 'unsupported_', 'no uncommented ', 'config not found',
  'no_(?:store|such_dir|origin|free_port|jira_credentials|(?:admin|theme|figma)_token)\\b', 'bad_(?:theme_id|file|build_script)\\b',
  'file_not_writable\\b', '(?:\\w+_)?invalid_(?!\\w*(?:token|credentials)\\b)',
  '\\w+_(?:refused|mismatch|drift|limit|missing|dirty|detached|taken|elsewhere|not_a_symlink|not_in_repo|not_ignored)\\b',
  '(?!\\w*(?:cli|jq|curl|runner|lib)_not)\\w+_not_found',
].join('|')})`)

const errorReasons = (text: string) => [...text.matchAll(/^error=(.*)$/gm)].map(m => m[1]!)

/** An `error=` line that is a failure, not a refusal: worth a report even when the line's exit code is another command's. */
export const failureLine = (text: string): boolean => errorReasons(text).some(r => !REFUSAL.test(r))

/** The host's own `Exit code N` line (`Error: Exit code N` on an error result): never the script's words. */
const EXIT_LINE = /^\s*(?:Error:\s*)?Exit code \d+\s*$/

/**
 * The line that names a failure: the first failing `error=` line, else the first with `Error`, else the first
 * non-empty line; the host's `Exit code N` line never counts; at most 160 chars.
 */
export function errorLine(text: string): string {
  const reason = errorReasons(text).find(r => !REFUSAL.test(r))
  if (reason !== undefined) return `error=${reason}`.trim().slice(0, 160)
  const lines = text.split('\n').filter(l => l.trim() && !EXIT_LINE.test(l))
  return (lines.find(l => /Error\b/.test(l)) ?? lines[0] ?? '').trim().slice(0, 160)
}

/** One unreported plugin-script failure of the main loop, as dogfood-state.json's `errors` lists them. */
export type ScriptError = { script: string; line: string; ms: number }

/** The `errors` of a prior dogfood-state.json text that belong to session `sid` and came after the report at `reportMs`. */
export function priorErrors(json: string | null, sid: string, reportMs: number): ScriptError[] {
  try {
    const s = JSON.parse(json ?? '') as { sid?: unknown; errors?: unknown }
    if (s.sid !== sid || !Array.isArray(s.errors)) return []
    return s.errors.filter(
      (e): e is ScriptError => !!e && typeof e.script === 'string' && typeof e.line === 'string' && typeof e.ms === 'number' && e.ms > reportMs,
    )
  } catch {
    return []
  }
}

/**
 * A refusal the script printed on purpose, with no crash signature: its `error=` lines all refusals, or, with
 * none, a `<stem>: <why>` line (a base script's die). The script did its job, nothing to report.
 */
export function designedRefusal(text: string, script: string): boolean {
  if (crashed(text)) return false
  const reasons = errorReasons(text)
  if (reasons.length) return reasons.every(r => REFUSAL.test(r))
  return new RegExp(`^${esc(script.replace(/\.[a-z]+$/, ''))}: `, 'm').test(text)
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A crash signature in the output: `Error` (an exception, a node stack) outside the host's `Exit code N` line; never a refusal. */
export const crashed = (text: string): boolean => text.split('\n').some(l => /\bError\b/.test(l) && !EXIT_LINE.test(l))

/**
 * A crash the script's own trace names: `Error` (`TypeError`, …) with a stack frame `<script>:12`, or a shell's `<script>: line 12:`.
 * In a compound line another command's `Error` (tsc, git, a husky hook) is in the same output and is not the script's.
 */
export function crashedIn(text: string, script: string): boolean {
  const s = esc(script)
  return (/Error\b/.test(text) && new RegExp(`(?:^|[/\\s(])${s}:\\d+`, 'm').test(text)) || new RegExp(`(?:^|/)${s}: line \\d+: `, 'm').test(text)
}

/**
 * A result the permission layer wrote in place of the command's (its text opens with the denial, `Error: ` allowed):
 * nothing ran, so no script failed. Covers the interactive denials and the headless ones (`claude -p`, cron, cloud).
 */
export const deniedNotRun = (text: string): boolean =>
  /^\s*(?:Error:\s*)?(?:Permission (?:for|to) .* denied|The user doesn't want to proceed with this tool use|This command requires approval|Claude requested permissions? to .* but you haven't granted it yet)/.test(text)

export type Seen = { date: string; plugin: string; title: string; path: string }

const LINE = /^- (\d{4}-\d{2}-\d{2}) (\S+) (.*) → (\/.*)$/
const NAME = /^(\d{4}-\d{2}-\d{2})-([a-z]+)-([a-z0-9-]+)\.md$/

/**
 * The index lines and the project folder's report files as one list, newest first, a path once (the
 * index's title wins over a file name's slug).
 */
export function seen(index: string, projectDir: string, names: readonly string[]): Seen[] {
  const out = new Map<string, Seen>()
  for (const l of index.split('\n')) {
    const m = LINE.exec(l.trim())
    if (m) out.set(m[4]!, { date: m[1]!, plugin: m[2]!, title: m[3]!, path: m[4]! })
  }
  for (const n of names) {
    const m = NAME.exec(n)
    const path = `${projectDir}/${n}`
    if (m && !out.has(path)) out.set(path, { date: m[1]!, plugin: m[2]!, title: m[3]!, path })
  }
  // Within a day, a later line or name was written later.
  return [...out.values()].map((s, i) => ({ s, i })).sort((a, b) => b.s.date.localeCompare(a.s.date) || b.i - a.i).map(x => x.s)
}

/** The reports of the last WINDOW_DAYS days, `now` included. */
export function recent(list: readonly Seen[], nowMs: number): Seen[] {
  const from = new Date(nowMs - (WINDOW_DAYS - 1) * 86_400_000).toISOString().slice(0, 10)
  return list.filter(s => s.date >= from)
}

export const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/**
 * Dogfood mode: on under BASE_DOGFOOD=1; else, unless BASE_DOGFOOD=0, for a claude.ai account dogfood.json lists —
 * the file follows the plugin into every synced sandbox, where no environment variable of the person's can be set.
 */
export function dogfoodMode(sw: string, account: string, json: string | null): boolean {
  if (sw === '1') return true
  if (sw === '0') return false
  const id = account.trim()
  return id !== '' && dogfoodAccounts(json).includes(id)
}

/** The login file the account id comes from: `$HOME/.claude.json` for the default config dir, else `<CLAUDE_CONFIG_DIR>/.claude.json`. */
export function loginFile(home: string | undefined, configDir: string | undefined): string | null {
  const abs = (p: string | undefined) => (p?.trim().startsWith('/') ? p.trim().replace(/\/+$/, '') : '')
  const h = abs(home)
  const c = abs(configDir)
  return c && c !== `${h}/.claude` ? `${c}/.claude.json` : h ? `${h}/.claude.json` : null
}

/** A login file's `oauthAccount.accountUuid`; '' for a missing or malformed file. */
export function loginAccount(json: string | null): string {
  try {
    const id = (JSON.parse(json ?? '') as { oauthAccount?: { accountUuid?: unknown } }).oauthAccount?.accountUuid
    return typeof id === 'string' ? id : ''
  } catch {
    return ''
  }
}

/** The claude.ai account ids dogfood.json lists (`accounts`: id → name); [] for a missing or malformed file. */
export function dogfoodAccounts(json: string | null): string[] {
  try {
    const a = (JSON.parse(json ?? '') as { accounts?: unknown }).accounts
    return a && typeof a === 'object' && !Array.isArray(a) ? Object.keys(a) : []
  } catch {
    return []
  }
}
