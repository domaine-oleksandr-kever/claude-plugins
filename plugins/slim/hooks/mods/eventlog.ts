// slim.jsonl: every line slim publishes to slim.events also goes to this session's file on disk,
// `<dir>/<session-id>/slim.jsonl`, one JSON object per line, rewritten whole after each. The file follows
// the list through slim's own state.set hook, so SLIM_EVENT_LOG=0, which stops the list, stops the file.
import type { EngineInterface, On } from 'claude-code'
import type { SlimEvent } from '../../types'
import { agentLabel } from './events.ts'
import { utf8Bytes } from './node-hook.ts'

type $ = EngineInterface

export const FILE_LINES = 2000
export const FILE_BYTES = 256 * 1024

/** `$DOMAINE_LOG_DIR/<session>` when the override is absolute, else `$HOME/.claude/domaine/log/<session>`; null with neither. */
export function logDir(home: string | undefined, override: string | undefined, session: string): string | null {
  if (!/^[\w.-]+$/.test(session) || /^\.+$/.test(session)) return null
  const o = override?.trim() ?? ''
  const h = home?.trim() ?? ''
  const base = o.startsWith('/') ? o.replace(/\/+$/, '') : h.startsWith('/') ? `${h.replace(/\/+$/, '')}/.claude/domaine/log` : null
  return base === null ? null : `${base}/${session}`
}

/** One slim.jsonl line; `agent` is the subagent type slim labels the event's text with, else `main`. */
export function fileLine(ev: SlimEvent, version: string, session: string): string {
  const type = 'agentType' in ev ? ev.agentType : undefined
  return JSON.stringify({
    ts: new Date(ev.atMs).toISOString(),
    plugin: 'slim',
    version,
    session,
    kind: ev.kind,
    agent: type ? agentLabel(type) : 'main',
    text: ev.text,
  })
}

/** A session's lines, oldest first, and their bytes in the file (each line plus its newline). */
export type Kept = { lines: string[]; bytes: number }

/** Appends `line`, dropping the oldest past FILE_LINES lines or FILE_BYTES bytes; the newest line always stays. */
export function keep(k: Kept, line: string): void {
  k.lines.push(line)
  k.bytes += utf8Bytes(line) + 1
  while (k.lines.length > 1 && (k.lines.length > FILE_LINES || k.bytes > FILE_BYTES)) k.bytes -= utf8Bytes(k.lines.shift()!) + 1
}

/** The newest lines of a file slim wrote that belong to `session` and fit the cap: what a reload goes on from. */
export function seedLines(text: string, session: string): Kept {
  const mine = text.split('\n').filter(l => {
    try {
      return (JSON.parse(l) as { session?: unknown }).session === session
    } catch {
      return false
    }
  })
  let i = mine.length
  let bytes = 0
  while (i > 0 && mine.length - i < FILE_LINES) {
    const b = utf8Bytes(mine[i - 1]!) + 1
    if (i < mine.length && bytes + b > FILE_BYTES) break
    bytes += b
    i--
  }
  return { lines: mine.slice(i), bytes }
}

type Sink = Kept & { session: string; path: string; version: string }

// Module-local, so a hot reload starts from the file: the lines already on disk for this session.
let sink: Promise<Sink | null> | null = null
let sinkSession = ''
let writes: Promise<void> = Promise.resolve()
let toasted = ''

/** slim's own plugin.json version, read once per sink, else `unknown`. */
async function version($: $): Promise<string> {
  try {
    const v = (JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }).version
    return typeof v === 'string' && v ? v : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function openSink($: $, session: string): Promise<Sink | null> {
  const dir = logDir(await $.env.get('HOME'), await $.env.get('DOMAINE_LOG_DIR'), session)
  if (dir === null) return null
  const path = `${dir}/slim.jsonl`
  let kept: Kept = { lines: [], bytes: 0 }
  try {
    kept = seedLines(await $.fs.read(path), session)
  } catch {}
  return { ...kept, session, path, version: await version($) }
}

/** Appends the event's line to the session's file; never throws, one toast per session when a write fails. */
async function logLine($: $, ev: SlimEvent): Promise<void> {
  let session = ''
  try {
    session = await $.session.id()
    // A start line reopens the file: the version is new, and a /clear or resume may find lines there.
    if (!sink || sinkSession !== session || ev.kind === 'start') {
      sinkSession = session
      // After the queued writes: one still pending would land after the file was read.
      sink = writes.then(() => openSink($, session)).catch(() => null)
    }
    const s = await sink
    if (!s) return
    // One start line per session, first: a /clear's new id has no session.start, a resumed id may have one on disk.
    if (ev.kind === 'start' && s.lines.some(l => l.includes('"kind":"start"'))) return
    if (ev.kind !== 'start' && !s.lines.length) keep(s, fileLine({ v: 1, atMs: ev.atMs, kind: 'start', text: `slim ${s.version}`, src: 'slim' }, s.version, session))
    keep(s, fileLine(ev, s.version, session))
    const text = `${s.lines.join('\n')}\n`
    // Queued, so an older snapshot never lands after a newer one.
    const w = writes.then(() => $.fs.write(s.path, text))
    writes = w.catch(() => {})
    await w
  } catch (err) {
    if (toasted === session) return
    toasted = session
    const reason = String((err as { message?: unknown } | null)?.message ?? err).replace(/\s+/g, ' ').replace(/^slim: \$\.[\w.]+: /, '').slice(0, 120)
    try {
      $.ui.toast(`slim: event log not written: ${reason}`)
    } catch {}
  }
}

export function registerEventLog(on: On): void {
  // Every slim.events write appends one event (pushEvent), so the newest is the one to log.
  on('state.set', { plugin: 'slim', key: 'events' }, async ($, e, next) => {
    const r = await next(e)
    if ('value' in r && r.value.isSet) {
      const list = e.value as readonly SlimEvent[] | null
      const ev = list?.[list.length - 1]
      if (ev) await logLine($, ev)
    }
    return r
  })
}
