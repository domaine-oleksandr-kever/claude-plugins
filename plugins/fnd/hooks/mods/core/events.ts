// Pure event-log helpers shared by the writer files and the log pane. No `$` here: each writer keeps
// its own `logEvent` wrapper, as the validator follows `$` only within one file.
import type { FndEvent, FndEventKind, FndForeignEvent } from '../../../types'

export const EVENT_CAP = 200
export const LOG_PANE = 'fnd-log'
export const LOG_COMMAND = { name: 'fnd-log', description: 'Open the fnd event log pane', immediate: true } as const

/** Kinds written once per MCP call or prompt: they would otherwise rotate the rare kinds out. */
const ROUTINE: ReadonlySet<FndEventKind> = new Set(['slim', 'prompt'])

/** Appends `ev`, oldest first, at most EVENT_CAP: over the cap the oldest routine line goes, else the oldest. */
export function pushEvent(list: readonly FndEvent[], ev: FndEvent): FndEvent[] {
  if (list.length < EVENT_CAP) return [...list, ev]
  const i = Math.max(0, list.findIndex(e => ROUTINE.has(e.kind)))
  return [...list.slice(0, i), ...list.slice(i + 1), ev]
}

/**
 * fnd's log and another plugin's in one list, oldest first; on equal times fnd's line comes first.
 * A foreign entry without a finite `atMs` or a string `kind`/`text` is dropped: another plugin writes it.
 * Beside slim's lines fnd's own compression lines read `fnd-slim`, so the kind cell names who compressed.
 */
export function merged(fnd: readonly FndEvent[], foreign: readonly unknown[]): FndForeignEvent[] {
  const ok = (ev: unknown): ev is FndForeignEvent => {
    const e = ev as Partial<FndForeignEvent> | null
    return !!e && Number.isFinite(e.atMs) && typeof e.kind === 'string' && typeof e.text === 'string'
  }
  const theirs = Array.isArray(foreign) ? foreign.filter(ok).map(e => ({ atMs: e.atMs, kind: e.kind, text: e.text })) : []
  if (theirs.length === 0) return [...fnd]
  const mine = fnd.map(e => (e.kind === 'slim' ? { ...e, kind: 'fnd-slim' } : e))
  return [...mine, ...theirs].map((e, i) => ({ e, i })).sort((a, b) => a.e.atMs - b.e.atMs || a.i - b.i).map(x => x.e)
}

/** `fnd-mcp-slim: compressed …` → `compressed …`: the kind column already names the source. */
export function bare(text: string): string {
  return text.replace(/^fnd[ -][a-z -]+?: /, '')
}

/** `mcp__plugin_fnd_atlassian__getJiraIssue` → `getJiraIssue`. */
export function toolName(tool: string): string {
  return tool.split('__').pop() ?? tool
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
