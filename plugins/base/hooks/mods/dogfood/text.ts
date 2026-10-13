// Dogfood mode's pure parts: the convention text, the plugin_defect tool's schema, the report file's name and
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
export const NUDGE = 'base dogfood: a plugin script failed — report it with plugin_defect before working around it'

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
const IN_REPO = new RegExp(`${RUN}(?:[^\\s"';|&()]*/)?plugins/(?:${NAMES})/scripts/[^\\s"';|&)]+`)
const IN_CACHE = new RegExp(`${RUN}[^\\s"';|&()]*/\\.claude/plugins/cache/[^/\\s"']+/(?:${NAMES})/[^/\\s"']+/scripts/[^\\s"';|&)]+`)

/** The basename of the Domaine plugin script a command runs (repo `plugins/<name>/scripts/` or the plugin cache), else null; a path merely named (grep, cat, ls) is not a run. */
export function pluginScript(command: string): string | null {
  const p = (IN_CACHE.exec(command) ?? IN_REPO.exec(command))?.[0]
  return p ? p.slice(p.lastIndexOf('/') + 1) : null
}

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
 * A refusal the script printed on purpose — `<stem>: <why>` (a base script's die) or an `error=<reason>` line
 * (an fe script's fail) — with no crash signature after it: the script did its job, nothing to report.
 */
export function designedRefusal(text: string, script: string): boolean {
  const stem = script.replace(/\.[a-z]+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^(?:${stem}: |error=)`, 'm').test(text) && !/\bError\b/.test(text)
}

/** A crash signature in the output: `Error` (an exception, a node stack) — what a compound line's exit code cannot tell. */
export const crashed = (text: string): boolean => /\bError\b/.test(text)

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

/** The claude.ai account ids dogfood.json lists (`accounts`: id → name); [] for a missing or malformed file. */
export function dogfoodAccounts(json: string | null): string[] {
  try {
    const a = (JSON.parse(json ?? '') as { accounts?: unknown }).accounts
    return a && typeof a === 'object' && !Array.isArray(a) ? Object.keys(a) : []
  } catch {
    return []
  }
}

const RULE_DRAWN = `Offer a GitHub issue (\`github: true\`); never create one unasked.`
const RULE_SURFACELESS = `No surface draws in this session (a cloud session, \`claude -p\`): the report file
and \`~\` do not outlive it. \`plugin_defect\` returns the whole report and files the GitHub issue
itself unless you pass \`github: false\`. Paste the whole report into your reply, in a fenced block
under the \`Plugin defect:\` line, so the owner can copy it into a session in the plugin repo.`

export const dogfoodSection = (versions: string, surfaceless = false) => `## base convention — dogfood mode

The Domaine plugins in this session are unstable development builds: ${versions}. You are
dogfooding them: a plugin defect is a finding to report, not noise to route around.

**A defect:** a plugin script failed or returned odd output; a hook or mod threw or showed a
notice; a skill contradicts the code or itself; a \`/<plugin>-doctor\` row FAILs; slim's output is
wrong (a stub where data was expected, \`lookup\` with no answer, a window missing the part
needed); a convention sentence is wrong for this host.

**Rule:** ALWAYS report a defect with the \`plugin_defect\` tool before or while you work
around it — never silently. Your reply then carries one line \`Plugin defect: <title> → <path>\`.
${surfaceless ? RULE_SURFACELESS : RULE_DRAWN} Never put secrets, tokens or storefront passwords in a
report.`
