// Pure event-log and pane helpers: band's own ring buffer, the merge of every publisher's list, and the
// pane's row model. No `$` here: the writer keeps its own `logEvent` wrapper, as the validator follows
// `$` only within one file.
import type { BandEvent, ForeignEvent } from '../../types'

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

/** The kinds band writes itself; an fnd that predates the yield writes them too, and they would show twice. Dropped from base's list as well. */
const OWN_KINDS: ReadonlySet<string> = new Set(['session', 'model', 'compact', 'rate'])

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

/**
 * band's, base's, fnd's and slim's lines in one list, oldest first; on equal times band → base → fnd → slim,
 * each list in its own order. Beside slim's lines fnd's own compression lines read `fnd-slim`, so the kind
 * cell names who compressed.
 */
export function merged(own: unknown, base: unknown, fnd: unknown, slim: unknown): ForeignEvent[] {
  const s = take(slim)
  const c = take(base).filter(e => !OWN_KINDS.has(e.kind))
  const f = take(fnd)
    .filter(e => !OWN_KINDS.has(e.kind))
    .map(e => (s.length && e.kind === 'slim' ? { ...e, kind: 'fnd-slim' } : e))
  return [...take(own), ...c, ...f, ...s].map((e, i) => ({ e, i })).sort((a, b) => a.e.atMs - b.e.atMs || a.i - b.i).map(x => x.e)
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

/** The kind padded to the longest kind, `workspace`, so the texts line up. */
export function kindCell(kind: string): string {
  return kind.padEnd(9)
}

/** Cells the time and kind columns take before the text: `09:05  ` and `workspace  `. */
export const PREFIX_COLS = 7 + 9 + 2

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
