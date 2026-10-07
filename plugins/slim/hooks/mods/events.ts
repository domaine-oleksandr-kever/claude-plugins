// Pure helpers for slim's event list and the ToolResult line. No `$` here.
import type { SlimEngine, SlimEvent, SlimRow } from '../../types'

export const EVENT_CAP = 200

/** Kinds written once per tool call: they go first over the cap, so rarer kinds would stay. */
const ROUTINE: ReadonlySet<string> = new Set(['slim'])

/** Appends `ev`, oldest first, at most EVENT_CAP: over the cap the oldest routine entry goes, else the oldest. */
export function pushEvent(list: readonly SlimEvent[], ev: SlimEvent): SlimEvent[] {
  if (list.length < EVENT_CAP) return [...list, ev]
  const i = Math.max(0, list.findIndex(e => ROUTINE.has(e.kind)))
  return [...list.slice(0, i), ...list.slice(i + 1), ev]
}

/** `mcp__plugin_fnd_atlassian__getJiraIssue` → `getJiraIssue`. */
export function toolName(tool: string): string {
  return tool.split('__').pop() ?? tool
}

/** 812 → `812 B`, 118_400 → `118 KB`, 2_340_000 → `2.3 MB`. */
export function fmtSize(b: number): string {
  if (b < 1000) return `${b} B`
  if (b < 999_500) return `${Math.round(b / 1000)} KB`
  return `${(b / 1e6).toFixed(1)} MB`
}

/** Whole percent saved, never negative. */
export function pctSaved(bytesIn: number, bytesOut: number): number {
  return bytesIn > 0 ? Math.max(0, Math.round((1 - bytesOut / bytesIn) * 100)) : 0
}

/** `<type> · ` for a subagent (plugin prefix dropped), `agent · ` when unlisted, '' on the main loop. */
export function agentPrefix(type: string | undefined, isSub: boolean): string {
  if (!isSub) return ''
  return type ? `${type.replace(/^[^:]+:/, '')} · ` : 'agent · '
}

/** `jira-reader · getJiraIssue: compressed 118 KB → 29 KB (−75%) · json`. */
export function eventText(
  prefix: string,
  tool: string,
  decision: 'compressed' | 'stubbed',
  engine: SlimEngine,
  bytesIn: number,
  bytesOut: number,
): string {
  return `${prefix}${toolName(tool)}: ${decision} ${fmtSize(bytesIn)} → ${fmtSize(bytesOut)} (−${pctSaved(bytesIn, bytesOut)}%) · ${engine}`
}

/** `slim  json  118 KB → 29 KB  −75%`. */
export function rowLine(row: SlimRow): string {
  return `slim  ${row.engine}  ${fmtSize(row.bytesIn)} → ${fmtSize(row.bytesOut)}  −${pctSaved(row.bytesIn, row.bytesOut)}%`
}
