// Pure event-log and pane helpers: band's own ring buffer, the merge of every publisher's list, the
// pane's row model and the lines of band's file on disk. No `$` here: the writer keeps its own
// `logEvent` wrapper, as the validator follows `$` only within one file.
import type { BandEvent, ForeignEvent, LogLine, LogSource, TeamSource } from '../../types'

export const EVENT_CAP = 200
export const LOG_PANE = 'band-log'
export const LOG_COMMAND = { name: 'band-log', description: 'Open the band event log pane', immediate: true } as const
export const CHECKLIST_PANE = 'band-progress'
export const CHECKLIST_COMMAND = { name: 'band-progress', description: 'Open the band task checklist pane', immediate: true } as const
export const DEBUG_COMMAND = { name: 'band-debug', description: 'Show the raw figures behind the status band (debug)' } as const

/** Appends `ev`, oldest first, at most EVENT_CAP: past the cap the oldest line goes. */
export function pushEvent(list: readonly BandEvent[], ev: BandEvent): BandEvent[] {
  return list.length < EVENT_CAP ? [...list, ev] : [...list.slice(1), ev]
}

/** Another plugin writes the list: an entry without a finite `atMs` or a string `kind`/`text` is dropped, extra fields too. */
export function take(list: unknown): ForeignEvent[] {
  if (!Array.isArray(list)) return []
  const out: ForeignEvent[] = []
  for (const ev of list) {
    const e = ev as Partial<ForeignEvent> | null
    if (e && typeof e === 'object' && Number.isFinite(e.atMs) && typeof e.kind === 'string' && typeof e.text === 'string') {
      out.push({ atMs: e.atMs as number, kind: e.kind, text: e.text })
    }
  }
  return out
}

const tag = (plugin: LogSource) => (e: ForeignEvent): LogLine => ({ ...e, plugin })

/** The team plugins on base, in the order their lines follow slim's on a tie. */
export const TEAM_SOURCES: readonly TeamSource[] = ['fe', 'qa', 'be', 'pm']

/**
 * band's, base's, slim's and the team plugins' lines in one list, oldest first, each tagged with the list it
 * came from; on equal times band → base → slim → fe → qa → be → pm, each list in its own order.
 */
export function merged(own: unknown, base: unknown, slim: unknown, teams: Partial<Record<TeamSource, unknown>> = {}): LogLine[] {
  const t = TEAM_SOURCES.flatMap(p => take(teams[p]).map(tag(p)))
  return [...take(own).map(tag('band')), ...take(base).map(tag('base')), ...take(slim).map(tag('slim')), ...t]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.atMs - b.e.atMs || a.i - b.i)
    .map(x => x.e)
}

/** Whether any of the lists holds a valid line, without merging them. */
export function anyEvent(...lists: unknown[]): boolean {
  return lists.some(l => take(l).length > 0)
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** Local `09:05`. */
export function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 412_345 → `412k`; below 1000 the number as is. */
export function fmtK(n: number): string {
  return n < 1000 ? String(n) : `${Math.round(n / 1000)}k`
}

/** The source list padded to 5, so the kinds line up. */
export function pluginCell(plugin: string): string {
  return plugin.padEnd(5)
}

/** The kind padded to the longest kind, `workspace`, so the texts line up. */
export function kindCell(kind: string): string {
  return kind.padEnd(9)
}

/** The newest lines `/band-log` answers with as text, where no pane draws. */
export const TEXT_LOG_ROWS = 40

/** One line of `/band-log`'s text answer: `09:05  base   guard      Bash: --no-verify`. */
export function logRow(ev: LogLine): string {
  return `${hhmm(ev.atMs)}  ${pluginCell(ev.plugin)}  ${kindCell(ev.kind)}  ${ev.text}`
}

/** Cells the time, plugin and kind columns take before the text: `09:05  `, `base   ` and `workspace  `. */
export const PREFIX_COLS = 7 + 7 + 9 + 2

/** Rows one text takes wrapped at `cols` cells, at least one. */
export function textRows(text: string, cols: number): number {
  return Math.max(1, Math.ceil(text.length / Math.max(1, cols)))
}

/**
 * The newest events whose wrapped rows fit in `rows` (all of them when `rows` is 0 or they all fit);
 * when some are left out, one row is kept for the `… N earlier` line.
 */
export function newestFitting<T extends { text: string }>(list: readonly T[], rows: number, cols: number): T[] {
  if (rows <= 0) return [...list]
  let used = 0
  let i = list.length
  while (i > 0 && used + textRows(list[i - 1]!.text, cols) <= rows) used += textRows(list[--i]!.text, cols)
  if (i === 0) return [...list]
  while (i < list.length && used > rows - 1) used -= textRows(list[i++]!.text, cols)
  return list.slice(i)
}

export const FILE_CAP_LINES = 2000
export const FILE_CAP_BYTES = 256 * 1024

const trimSlash = (p: string) => p.replace(/\/+$/, '')

/**
 * `<DOMAINE_LOG_DIR>/<session>` when the override is absolute, else `$HOME/.claude/domaine/log/<session>`; null
 * with neither, or for a session id that is no plain name. Same rule as base and slim, so one session's files
 * share one directory.
 */
export function logDir(home: string | undefined, override: string | undefined, sessionId: string): string | null {
  if (!/^[\w.-]+$/.test(sessionId) || /^\.+$/.test(sessionId)) return null
  const o = override?.trim() ?? ''
  const h = home?.trim() ?? ''
  const root = o.startsWith('/') ? trimSlash(o) : h.startsWith('/') ? `${trimSlash(h)}/.claude/domaine/log` : null
  return root === null ? null : `${root}/${sessionId}`
}

/** One line of `band.jsonl`; `plugin` is band's own name, never taken from another plugin's state. */
export function fileLine(atMs: number, version: string, session: string, kind: string, text: string): string {
  return JSON.stringify({ ts: new Date(atMs).toISOString(), plugin: 'band', version, session, kind, agent: 'main', text })
}

/** The lines of an existing file that belong to `session`; anything unparsable or another session's goes. */
export function seedLines(fileText: string, session: string): string[] {
  return fileText.split('\n').filter(l => {
    try {
      return (JSON.parse(l) as { session?: unknown }).session === session
    } catch {
      return false
    }
  })
}

function utf8Bytes(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c < 0xdc00) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** Oldest lines dropped until at most FILE_CAP_LINES remain and the file, newlines counted, fits FILE_CAP_BYTES. */
export function capLines(lines: readonly string[]): string[] {
  const out = lines.slice(-FILE_CAP_LINES)
  let bytes = out.reduce((n, l) => n + utf8Bytes(l) + 1, 0)
  let drop = 0
  while (bytes > FILE_CAP_BYTES && drop < out.length) bytes -= utf8Bytes(out[drop++]!) + 1
  return out.slice(drop)
}
