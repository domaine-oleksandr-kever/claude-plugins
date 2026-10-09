// /qa-doctor: runs scripts/doctor.cjs for what a node process sees and adds what only a session answers —
// base loaded, slim's view tool registered — then the tail of qa.events.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { QaEvent } from '../../types'
import { logDir, logLine, pushEvent } from './events.ts'
import type { Disk } from './events.ts'
import { BASE_MISSING } from './session.ts'

export const COMMAND = {
  name: 'qa-doctor',
  description: 'Check the qa install: node, manifest, scripts, base, the QA store registry, gh, chrome-devtools, slim, event log',
  immediate: true,
} as const
export const SLIM_VIEW = 'mcp__slim__view'
const TAIL = 10

type Status = 'PASS' | 'FAIL' | 'SKIP' | 'WARN'
export type Row = { status: Status; name: string; detail: string }

const armed = atom({ plugin: 'qa', key: 'armed' } as const, null)
const events = atom({ plugin: 'qa', key: 'events' } as const, [] as QaEvent[])

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

/** The command on every session start (a reload or a re-enable drops it) and at the first prompt of a new session id. */
async function arm($: $, start: boolean): Promise<void> {
  try {
    const sid = String(await $.session.id())
    const fresh = (await read($, armed)) !== sid
    if (!start && !fresh) return
    await $.command.register(COMMAND).catch(() => undefined)
    if (fresh) await update($, armed, () => sid)
  } catch {}
}

const STATUSES = new Set(['PASS', 'FAIL', 'SKIP', 'WARN'])

/** doctor.cjs --json rows, or null when its stdout is not that shape. */
export function parseStatic(stdout: string): Row[] | null {
  try {
    const rows = (JSON.parse(stdout) as { rows?: unknown }).rows
    if (!Array.isArray(rows)) return null
    return rows.filter(
      (r): r is Row => !!r && STATUSES.has(r.status) && typeof r.name === 'string' && typeof r.detail === 'string',
    )
  } catch {
    return null
  }
}

async function staticRows($: $): Promise<Row[]> {
  const root = $.plugin.root
  let r
  try {
    const argv = ['node', `${root}/scripts/doctor.cjs`, '--json', '--root', root, '--project', await $.session.root()]
    const dir = logDir(await $.env.get('HOME'), await $.env.get('DOMAINE_LOG_DIR'), await $.session.id())
    if (dir) argv.push('--log-dir', dir)
    r = await $.process.run(argv, { timeoutMs: 60_000 })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return [{ status: 'SKIP', name: 'static', detail: `scripts/doctor.cjs did not run (${why}): the static checks need node` }]
  }
  const rows = parseStatic(r.stdout)
  if (rows?.length) return rows
  const why = (r.stderr.trim().split('\n')[0] ?? '') || 'no rows on stdout'
  return [{ status: 'FAIL', name: 'static', detail: `scripts/doctor.cjs exited ${r.exitCode}: ${why}` }]
}

async function liveRows($: $): Promise<Row[]> {
  const rows: Row[] = []
  try {
    rows.push((await $.command.list()).some(c => c.plugin === 'base')
      ? { status: 'PASS', name: 'base-live', detail: "base's skills are loaded" }
      : { status: 'FAIL', name: 'base-live', detail: `qa ${BASE_MISSING}` })
  } catch {
    rows.push({ status: 'SKIP', name: 'base-live', detail: 'the command list did not answer' })
  }
  try {
    rows.push((await $.tool.list()).some(t => t.name === SLIM_VIEW)
      ? { status: 'PASS', name: 'slim-live', detail: `${SLIM_VIEW} registered` }
      : { status: 'FAIL', name: 'slim-live', detail: 'slim is not loaded — claude plugin install slim@domaine; base refuses its readers until it is' })
  } catch {
    rows.push({ status: 'SKIP', name: 'slim-live', detail: 'the tool list did not answer' })
  }
  return rows
}

/**
 * A static `base` FAIL for a base that is loaded anyway (a `--plugin-dir` load has no install record) reads as
 * a warning.
 */
export function reconcile(rows: Row[]): Row[] {
  const live = rows.find(r => r.name === 'base-live')?.status === 'PASS'
  return rows.map(r =>
    live && r.name === 'base' && r.status === 'FAIL' && r.detail.startsWith('not installed')
      ? { status: 'WARN', name: 'base', detail: 'not in installed_plugins.json, yet loaded this session (a --plugin-dir load?)' }
      : r,
  )
}

export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 48 * 3600) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function summary(rows: Row[]): string {
  const n = { PASS: 0, FAIL: 0, SKIP: 0, WARN: 0 }
  for (const r of rows) n[r.status]++
  return `${n.PASS} passed, ${n.FAIL} failed, ${n.SKIP} skipped${n.WARN ? `, ${n.WARN} warned` : ''}`
}

export function render(root: string, rows: Row[], tail: string[]): string {
  const width = rows.reduce((w, r) => Math.max(w, r.name.length), 0)
  return [
    `qa doctor — plugin root: ${root}`,
    ...rows.map(r => `${r.status}  ${r.name.padEnd(width)}  ${r.detail}`),
    `doctor: ${summary(rows)}`,
    '',
    ...tail,
  ].join('\n')
}

async function eventTail($: $): Promise<string[]> {
  if ((await $.env.get('QA_EVENT_LOG')) === '0') return ['qa events: off (QA_EVENT_LOG=0)']
  const list = await read($, events)
  if (!list.length) return ['qa events: none yet']
  const now = await $.clock.now()
  const shown = list.slice(-TAIL)
  return [
    `qa events (last ${shown.length} of ${list.length}, newest last):`,
    ...shown.map(ev => `  ${age(now - ev.atMs).padStart(4)}  ${ev.kind.padEnd(9)}  ${ev.text}`),
  ]
}

async function logDoctor($: $, text: string): Promise<void> {
  try {
    if ((await $.env.get('QA_EVENT_LOG')) === '0') return
    const ev: QaEvent = { atMs: await $.clock.now(), kind: 'doctor', text }
    await update($, events, l => pushEvent(l, ev))
    await logLine(diskOf($), ev)
  } catch {}
}

export function registerDoctor(on: On): void {
  // A matcher apart from session.ts's start hook: one unmatched hook per event per plugin.
  on('session.start', { cwd: /$/ }, async ($, e, next) => {
    const r = await next(e)
    await arm($, true)
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    await arm($, false)
    return r
  })

  on('command.run', { command: COMMAND.name }, async $ => {
    const [fixed, live] = await Promise.all([staticRows($), liveRows($)])
    const rows = reconcile([...fixed, ...live])
    const tail = await eventTail($)
    await logDoctor($, summary(rows))
    return { text: render($.plugin.root, rows, tail) }
  })
}
