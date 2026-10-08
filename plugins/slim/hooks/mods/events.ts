// Pure helpers for slim's event list and the lines it draws. No `$` here.
import type { SlimEngine, SlimEvent, SlimRow } from '../../types'

export const EVENT_CAP = 200

/** Kinds written once per tool call: they go first over the cap, so rarer kinds (lookup) would stay. */
const ROUTINE: ReadonlySet<string> = new Set(['slim'])

/** Appends `ev`, oldest first, at most EVENT_CAP: over the cap the oldest routine entry goes, else the oldest. */
export function pushEvent(list: readonly SlimEvent[], ev: SlimEvent): SlimEvent[] {
  if (list.length < EVENT_CAP) return [...list, ev]
  const i = Math.max(0, list.findIndex(e => ROUTINE.has(e.kind)))
  return [...list.slice(0, i), ...list.slice(i + 1), ev]
}

/** `mcp__plugin_acme_atlassian__getJiraIssue` → `getJiraIssue`; a built-in tool keeps its name. */
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

/**
 * `−75%`, or `+74%` when the view grew: a persisted Bash output's window is measured against the
 * host's 2 KB preview, so it can be bigger than what the model would have seen.
 */
export function pctCell(bytesIn: number, bytesOut: number): string {
  if (bytesOut <= bytesIn || bytesIn <= 0) return `−${pctSaved(bytesIn, bytesOut)}%`
  return `+${Math.round((bytesOut / bytesIn - 1) * 100)}%`
}

/** `<type> · ` for a subagent (plugin prefix dropped), `agent · ` when unlisted, '' on the main loop. */
export function agentPrefix(type: string | undefined, isSub: boolean): string {
  if (!isSub) return ''
  return type ? `${type.replace(/^[^:]+:/, '')} · ` : 'agent · '
}

/** `jira-reader · getJiraIssue: compressed 118 KB → 29 KB (−75%) · json`; `windowed … (+74%)` when the view grew. */
export function eventText(
  prefix: string,
  tool: string,
  decision: 'compressed' | 'stubbed',
  engine: SlimEngine,
  bytesIn: number,
  bytesOut: number,
): string {
  const verb = bytesOut > bytesIn ? 'windowed' : decision
  return `${prefix}${toolName(tool)}: ${verb} ${fmtSize(bytesIn)} → ${fmtSize(bytesOut)} (${pctCell(bytesIn, bytesOut)}) · ${engine}`
}

/** 812 → `812`, 1_240 → `1.2k`. */
export function fmtTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`
}

/** `lookup: <question, 60 chars at most…> · haiku · 1.2k tok`, or `… · haiku · failed (<reason>)`. */
export function lookupText(prefix: string, question: string, model: string, tokens: number | null, failed?: string): string {
  const q = question.replace(/\s+/g, ' ').trim()
  const shown = q.length > 60 ? `${q.slice(0, 60)}…` : q
  const tail = failed !== undefined ? `failed (${failed})` : tokens === null ? 'no tokens' : `${fmtTokens(tokens)} tok`
  return `${prefix}lookup: ${shown} · ${model} · ${tail}`
}

/**
 * `jira-reader · view issues.json: 118 KB → 29 KB (−75%) · json`; `… (narrowed by jq) · json`,
 * `… cached 29 KB · json` and `… refused (<reason>)` for the other outcomes.
 */
export function viewText(prefix: string, source: string, decision: string, engine: string | null, bytesIn: number, bytesOut: number, reason?: string | null): string {
  const s = source.replace(/\s+/g, ' ').trim()
  const head = `${prefix}view ${s.length > 48 ? `${s.slice(0, 48)}…` : s}:`
  if (decision === 'refused') return `${head} refused (${reason ?? 'refused'})`
  if (decision === 'cached') return `${head} cached ${fmtSize(bytesOut)} · ${engine ?? '?'}`
  const how = decision === 'narrowed' ? 'narrowed by jq' : pctCell(bytesIn, bytesOut)
  return `${head} ${fmtSize(bytesIn)} → ${fmtSize(bytesOut)} (${how}) · ${engine ?? '?'}`
}

/** `slim  json  118 KB → 29 KB  −75%`. */
export function rowLine(row: SlimRow): string {
  return `slim  ${row.engine}  ${fmtSize(row.bytesIn)} → ${fmtSize(row.bytesOut)}  ${pctCell(row.bytesIn, row.bytesOut)}`
}

/** ` · 2 compressed, −118 KB`: the suffix a folded tool group's line gets. */
export function groupSuffix(n: number, saved: number): string {
  return ` · ${n} compressed, −${fmtSize(Math.max(0, saved))}`
}
