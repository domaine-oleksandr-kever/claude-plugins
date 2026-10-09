// be's event list and its file on disk, `<log dir>/<session-id>/be.jsonl`, under the contract base, band and
// slim write theirs by. No `$` here: each writer file keeps its own wrapper, which pushes the line to be.events
// and then hands it to `logLine` with a `Disk` it built, as the validator follows `$` only within one file.
// be never sweeps old session directories: base owns that.
import type { BeEvent } from '../../types'

export const EVENT_CAP = 200
export const FILE_LINES = 2000
export const FILE_BYTES = 256 * 1024

/** Appends `ev`, oldest first, at most EVENT_CAP: past the cap the oldest line goes. */
export function pushEvent(list: readonly BeEvent[], ev: BeEvent): BeEvent[] {
  return list.length < EVENT_CAP ? [...list, ev] : [...list.slice(1), ev]
}

const trimSlash = (p: string) => p.replace(/\/+$/, '')

/** A name the engine could not have made a session id of never becomes a path segment. */
export function isSessionName(name: string): boolean {
  return /^[\w.-]+$/.test(name) && !/^\.+$/.test(name)
}

/** `<DOMAINE_LOG_DIR>/<session>` when the override is absolute, else `$HOME/.claude/domaine/log/<session>`; null with neither. */
export function logDir(home: string | undefined, override: string | undefined, session: string): string | null {
  if (!isSessionName(session)) return null
  const o = override?.trim() ?? ''
  if (o.startsWith('/')) return `${trimSlash(o)}/${session}`
  const h = home?.trim() ?? ''
  return h.startsWith('/') ? `${trimSlash(h)}/.claude/domaine/log/${session}` : null
}

/** One be.jsonl line; `plugin` is be's own name, never taken from another plugin's state. */
export function fileLine(ev: BeEvent, version: string, session: string): string {
  return JSON.stringify({ ts: new Date(ev.atMs).toISOString(), plugin: 'be', version, session, kind: ev.kind, agent: 'main', text: ev.text })
}

export function utf8Bytes(s: string): number {
  let n = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return n
}

/** Drops the oldest lines past FILE_LINES lines or FILE_BYTES bytes; the newest line always stays. */
function trimFront(out: string[]): string[] {
  let bytes = 0
  for (const l of out) bytes += utf8Bytes(l) + 1
  let cut = 0
  while (out.length - cut > 1 && (out.length - cut > FILE_LINES || bytes > FILE_BYTES)) bytes -= utf8Bytes(out[cut++]!) + 1
  return cut ? out.slice(cut) : out
}

/** Appends `line` within the cap. */
export function capLines(lines: readonly string[], line: string): string[] {
  return trimFront([...lines, line])
}

/** The lines of a be.jsonl that belong to `session`, oldest first, within the cap: what a reload goes on from. */
export function seedLines(text: string, session: string): string[] {
  return trimFront(text.split('\n').filter(l => {
    try {
      return (JSON.parse(l) as { session?: unknown }).session === session
    } catch {
      return false
    }
  }))
}

const hasStart = (lines: readonly string[]) => lines.some(l => l.includes('"kind":"start"'))

/**
 * The file's lines after `ev`: the start line first in every session (a /clear's new id gets one before its
 * first event, as no session.start announces it), and one start line per session.
 */
export function nextLines(lines: readonly string[], ev: BeEvent, version: string, session: string): string[] | null {
  if (ev.kind === 'start') return hasStart(lines) ? null : capLines(lines, fileLine(ev, version, session))
  const head = lines.length ? lines : [fileLine({ atMs: ev.atMs, kind: 'start', text: `be ${version}` }, version, session)]
  return capLines(head, fileLine(ev, version, session))
}

/** What the writer needs from `$`, built by each writer file's `diskOf`. */
export type Disk = {
  session: () => Promise<string>
  home: () => Promise<string | undefined>
  override: () => Promise<string | undefined>
  manifest: () => Promise<string>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  toast: (text: string) => void
}

type Sink = { path: string; lines: string[] }

// Module-local, so a hot reload starts from the file: the lines already on disk for this session.
let sink: Promise<Sink | null> | null = null
let sinkSession = ''
let version: Promise<string> | null = null
let writes: Promise<void> = Promise.resolve()
let toasted = ''

async function readVersion(disk: Disk): Promise<string> {
  try {
    const v = (JSON.parse(await disk.manifest()) as { version?: unknown }).version
    return typeof v === 'string' && v ? v : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function openSink(disk: Disk, session: string): Promise<Sink | null> {
  const dir = logDir(await disk.home(), await disk.override(), session)
  if (dir === null) return null
  const path = `${dir}/be.jsonl`
  let lines: string[] = []
  try {
    lines = seedLines(await disk.read(path), session)
  } catch {}
  return { path, lines }
}

/**
 * Rewrites this session's be.jsonl with `ev` appended (`$.fs.write` has no append), after the line went to
 * be.events. Never throws; one toast per session when a write fails.
 */
export async function logLine(disk: Disk, ev: BeEvent): Promise<void> {
  let session = ''
  try {
    session = await disk.session()
    if (!sink || sinkSession !== session) {
      sinkSession = session
      sink = openSink(disk, session).catch(() => null)
    }
    version ??= readVersion(disk)
    const v = await version
    const s = await sink
    if (!s) return
    // Read, append and write inside one queue: two events in flight never build on the same snapshot.
    const w = writes.then(async () => {
      const lines = nextLines(s.lines, ev, v, session)
      if (!lines) return
      s.lines = lines
      await disk.write(s.path, `${lines.join('\n')}\n`)
    })
    writes = w.catch(() => {})
    await w
  } catch (err) {
    if (toasted === session) return
    toasted = session
    const reason = String((err as { message?: unknown } | null)?.message ?? err).replace(/\s+/g, ' ').slice(0, 120)
    try {
      disk.toast(`be: event log not written: ${reason}`)
    } catch {}
  }
}
