// Pure event-log helpers shared by the writer files and the log pane. No `$` here: each writer keeps
// its own `logEvent` wrapper, as the validator follows `$` only within one file.
import type { FndEvent, FndEventKind } from '../../../types'

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
