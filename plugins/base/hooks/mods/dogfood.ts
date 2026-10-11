// Dogfood mode (BASE_DOGFOOD=1): the plugin_defect tool and its report files, the nudge on a failed plugin
// script, the one blocked stop while that failure is unreported, and /base-defects. Off, every hook passes.
// The convention section is conventions.ts's; the doctor's `defects` row is doctor.ts's.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { BaseDogfood, BaseEvent } from '../../types'
import {
  NUDGE,
  TOOL,
  TOOL_DESC,
  TOOL_NAME,
  TOOL_SCHEMA,
  bashFailed,
  defectBody,
  enabledNames,
  fileName,
  indexLine,
  isRepo,
  isoDate,
  marketplaceOf,
  parseDefect,
  pluginScript,
  repoOf,
  seen,
  slugOf,
  versionsLine,
  versionsOf,
} from './dogfood/text.ts'
import type { Defect, Plugin } from './dogfood/text.ts'
import { logLine, pushEvent } from './events.ts'
import type { Disk } from './events.ts'

export const COMMAND = {
  name: 'base-defects',
  description: 'List the plugin defects reported in dogfood mode, newest first',
  immediate: true,
} as const
const MAX_CLASH = 99

const events = atom({ plugin: 'base', key: 'events' } as const, [] as BaseEvent[])
const dogfood = atom({ plugin: 'base', key: 'dogfood' } as const, null as BaseDogfood | null)
const progress = atom({ plugin: 'base', key: 'progress' } as const, null)
const slimInfo = atom({ plugin: 'slim', key: 'info' } as const, null)

type $ = EngineInterface

/** events.ts's file writer reaches `$` through this: the validator follows `$` only within one file. */
function diskOf($: $): Disk {
  return {
    session: () => $.session.id(),
    home: () => $.env.get('HOME'),
    override: () => $.env.get('DOMAINE_LOG_DIR'),
    manifest: () => $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    toast: text => $.ui.toast(text),
  }
}

async function logDefect($: $, text: string): Promise<void> {
  try {
    if ((await $.env.get('BASE_EVENT_LOG')) === '0') return
    const ev: BaseEvent = { atMs: await $.clock.now(), kind: 'defect', text }
    await update($, events, l => pushEvent(l, ev))
    await logLine(diskOf($), ev)
  } catch {}
}

const isOn = async ($: $) => (await $.env.get('BASE_DOGFOOD')) === '1'

/** `$HOME/.claude/plugin-defects`, or null without an absolute HOME (a cloud session). */
async function homeDir($: $): Promise<string | null> {
  const h = (await $.env.get('HOME'))?.trim() ?? ''
  return h.startsWith('/') ? `${h.replace(/\/+$/, '')}/.claude/plugin-defects` : null
}

async function configDir($: $): Promise<string | null> {
  const c = (await $.env.get('CLAUDE_CONFIG_DIR'))?.trim() ?? ''
  if (c.startsWith('/')) return c.replace(/\/+$/, '')
  const h = (await $.env.get('HOME'))?.trim() ?? ''
  return h.startsWith('/') ? `${h.replace(/\/+$/, '')}/.claude` : null
}

const readOrNull = ($: $, path: string | null) => (path ? $.fs.read(path).catch(() => null) : Promise.resolve(null))

async function ownVersion($: $): Promise<string> {
  try {
    const v = (JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }).version
    return typeof v === 'string' && v ? v : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function versions($: $, installed: string | null): Promise<Map<Plugin, string | null>> {
  const slim = (await read($, slimInfo).catch(() => null))?.version ?? null
  const enabled = enabledNames(await $.settings.read().catch(() => null))
  return versionsOf(installed, $.plugin.root, await ownVersion($), slim, enabled)
}

async function git($: $, root: string, args: string[]): Promise<string | null> {
  const r = await $.process.run(['git', ...args], { cwd: root, timeoutMs: 5000 }).catch(() => null)
  const out = r?.exitCode === 0 ? r.stdout.trim() : ''
  return out || null
}

/** Registers the command on every session start and at the first prompt of a new session id; a new id starts clean. */
async function arm($: $, start: boolean): Promise<void> {
  try {
    if (!(await isOn($))) return
    const sid = String(await $.session.id())
    const fresh = (await read($, dogfood))?.sid !== sid
    if (start || fresh) await $.command.register(COMMAND).catch(() => undefined)
    if (fresh) await update($, dogfood, () => ({ sid, failMs: 0, script: '', blockedMs: 0, reportMs: 0 }))
  } catch {}
}

/** The repo an issue goes to: BASE_DOGFOOD_REPO, else the github marketplace base was installed from. */
async function issueRepo($: $, installed: string | null, config: string | null): Promise<string | null> {
  const env = (await $.env.get('BASE_DOGFOOD_REPO'))?.trim() ?? ''
  if (env) return isRepo(env) ? env : null
  const known = await readOrNull($, config && `${config}/plugins/known_marketplaces.json`)
  return repoOf(known, marketplaceOf(installed, $.plugin.root))
}

async function fileIssue($: $, d: Defect, path: string, installed: string | null, config: string | null): Promise<string> {
  const repo = await issueRepo($, installed, config)
  if (!repo) return 'GitHub issue not created: no repo known — set BASE_DOGFOOD_REPO=<owner>/<repo> (the marketplace base came from is not a github one this session can read)'
  const argv = ['gh', 'issue', 'create', '--repo', repo, '--title', `[${d.plugin}] ${d.title}`, '--body-file', path]
  let r
  try {
    r = await $.process.run(argv, { timeoutMs: 60_000 })
  } catch (err) {
    return `GitHub issue not created: gh did not run (${String((err as Error)?.message ?? err).slice(0, 160)})`
  }
  if (r.exitCode !== 0) return `GitHub issue not created: gh exited ${r.exitCode}: ${(r.stderr.trim().split('\n')[0] ?? '').slice(0, 200)}`
  const url = r.stdout.match(/https:\/\/\S+/g)?.pop()
  return url ? `GitHub issue: ${url}` : `GitHub issue created in ${repo}; gh printed no URL`
}

// Reports run one at a time: the free-name probe and the index read-modify-write would race in parallel calls.
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(job: () => Promise<T>): Promise<T> => {
  const next = queue.then(job, job)
  queue = next.catch(() => undefined)
  return next
}

/** Writes the report and its index line; the result names the path (and the issue). */
async function report($: $, d: Defect): Promise<string> {
  const root = await $.session.root()
  const now = await $.clock.now()
  const date = isoDate(now)
  const dir = `${root}/.claude/plugin-defects`
  const slug = slugOf(d.title)
  let path = ''
  for (let n = 1; n <= MAX_CLASH && !path; n++) {
    const p = `${dir}/${fileName(date, d.plugin, slug, n)}`
    if (!(await $.fs.exists(p))) path = p
  }
  if (!path) return `plugin_defect: ${MAX_CLASH} reports named ${date}-${d.plugin}-${slug} already: give a different title`
  const config = await configDir($)
  const installed = await readOrNull($, config && `${config}/plugins/installed_plugins.json`)
  const v = await versions($, installed)
  const sid = String(await $.session.id())
  const p = await read($, progress).catch(() => null)
  const workId = p?.workId ?? null
  const [remote, branch, commit] = await Promise.all([
    git($, root, ['remote', 'get-url', 'origin']),
    git($, root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git($, root, ['rev-parse', '--short', 'HEAD']),
  ])
  const surfaces = await $.session.surfaces().catch(() => [] as readonly string[])
  const claudeCode = (await $.session.version().catch(() => null))?.version ?? null
  const body = defectBody(d, { version: v.get(d.plugin) ?? 'unknown', date, session: sid, workId }, {
    root,
    remote,
    branch,
    commit,
    versions: versionsLine(v),
    surfaces: surfaces.length ? surfaces.join(', ') : 'none (nothing draws)',
    claudeCode,
    session: sid,
    workId,
  })
  try {
    await $.fs.write(path, body)
  } catch (err) {
    return `plugin_defect: the report was not written to ${path}: ${String((err as Error)?.message ?? err).slice(0, 160)}`
  }
  await update($, dogfood, s => (s ? { ...s, reportMs: now } : { sid, failMs: 0, script: '', blockedMs: 0, reportMs: now })).catch(() => undefined)
  await logDefect($, `${d.plugin}: ${d.title}`)
  const lines = [`Plugin defect: ${d.title} → ${path}`]
  const home = await homeDir($)
  if (home) {
    try {
      const index = `${home}/index.md`
      const prior = (await $.fs.read(index).catch(() => '')) as string
      await $.fs.write(index, `${prior}${prior && !prior.endsWith('\n') ? '\n' : ''}${indexLine(date, d, path)}\n`)
      lines.push(`Index: ${index}`)
    } catch {}
  }
  if (d.github) lines.push(await fileIssue($, d, path, installed, config))
  return lines.join('\n')
}

async function listing($: $): Promise<string> {
  const home = await homeDir($)
  const index = home ? ((await $.fs.read(`${home}/index.md`).catch(() => '')) as string) : ''
  const dir = `${await $.session.root()}/.claude/plugin-defects`
  const names = (await $.fs.list(dir).catch(() => [])).filter(f => f.kind === 'file').map(f => f.name)
  const fromIndex = seen(index, dir, [])
  const fromProject = seen('', dir, names)
  return [
    home ? `~/.claude/plugin-defects/index.md — ${fromIndex.length || 'none'}${fromIndex.length ? ', newest first:' : ''}` : 'no home index here (no HOME)',
    ...fromIndex.map(s => `  ${s.date} ${s.plugin} ${s.title} → ${s.path}`),
    `${dir}/ — ${fromProject.length || 'none'}${fromProject.length ? ', newest first:' : ''}`,
    ...fromProject.map(s => `  ${s.path.slice(dir.length + 1)}`),
  ].join('\n')
}

export function registerDogfood(on: On): void {
  // Matchers apart from base's other start and prompt hooks: one unmatched hook per event per plugin.
  on('session.start', { cwd: /(?:)/ }, async ($, e, next) => {
    try {
      if (await isOn($)) await $.tool.register({ name: TOOL_NAME, description: TOOL_DESC, inputSchema: TOOL_SCHEMA, isDeferred: false })
    } catch {}
    await arm($, true)
    return next(e)
  })

  on('prompt.submit', { text: /^(?:)/ }, async ($, e, next) => {
    const r = await next(e)
    await arm($, false)
    return r
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (!(await isOn($))) return { result: 'plugin_defect: dogfood mode is off (BASE_DOGFOOD=1 turns it on)' }
    const d = parseDefect(e as unknown as Record<string, unknown>)
    if (typeof d === 'string') return { result: d }
    return { result: await serial(() => report($, d)).catch(err => `plugin_defect failed: ${String((err as Error)?.message ?? err).slice(0, 160)}`) }
  })

  on('tool.call', { tool: 'Bash', command: /plugins\// }, async ($, e, next) => {
    const r = await next(e)
    if (e.tool !== 'Bash' || r.deny !== undefined || !bashFailed(r)) return r
    const script = pluginScript(e.command)
    if (!script || !(await isOn($).catch(() => false))) return r
    try {
      await logDefect($, `script failed: ${script}`)
      if (e.agentId === undefined) {
        const now = await $.clock.now()
        await update($, dogfood, s => (s ? { ...s, failMs: now, script } : s))
      }
    } catch {}
    return { ...r, context: [...(r.context ?? []), NUDGE] }
  })

  on('classic.Stop', { stop_hook_active: false }, async ($, e, next) => {
    const r = await next(e)
    if (r.block) return r
    try {
      if (!(await isOn($))) return r
      const s = await read($, dogfood)
      if (!s || s.sid !== String(await $.session.id()) || !s.failMs || s.reportMs >= s.failMs || s.blockedMs === s.failMs) return r
      await update($, dogfood, t => (t ? { ...t, blockedMs: s.failMs } : t))
      return { ...r, block: `base dogfood: a plugin script failed (${s.script}) and no plugin_defect report followed — report it with plugin_defect, then stop` }
    } catch {
      return r
    }
  })

  on('command.run', { command: COMMAND.name }, async $ => ({ text: await listing($) }))
}
