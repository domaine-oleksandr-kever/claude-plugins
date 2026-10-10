// Pure band helpers: the ctx/rate/cache colour ladders, rate labels, remaining-time text, the one-row
// width model with its drop order, and base's task snapshot read as the generic checklist. No `$` here:
// atoms and engine calls stay in the file that hooks the event.
import type { BandCache, BandRate, BandUsage, Checklist, ChecklistMark, ChecklistRow } from '../../types'

export type Level = 'plain' | 'warning' | 'crit'

/** The alarm look; needs no theme key beyond `warning` until another is proven live on every theme. */
export const CRIT = { color: 'warning', bold: true, inverse: true } as const

/** Text props per level. */
export const LEVEL_PROPS: Record<Level, { color?: string; bold?: boolean; inverse?: boolean }> = {
  plain: {},
  warning: { color: 'warning' },
  crit: CRIT,
}
/** The ctx value alone is green while fine, as the classic notice's 🟢 was; the rest of the band stays plain there. */
export const CTX_PROPS: typeof LEVEL_PROPS = { ...LEVEL_PROPS, plain: { color: 'success' } }

/** ctx % and every rate window: ≤ 30 plain, > 30 warning, ≥ 80 crit, judged on the rounded figure the band shows. */
export function pctLevel(pct: number): Level {
  const shown = Math.round(pct)
  if (shown >= 80) return 'crit'
  if (shown > 30) return 'warning'
  return 'plain'
}

const MIN = 60_000

/**
 * Minutes left of the cache: warning below 10 min, crit below 2 min for a 1 h TTL. A shorter TTL
 * scales both: warning below 40 % of the TTL (when that is under 10 min), crit at a fifth of that.
 */
export function cacheLevel(remainingMs: number, ttlMs: number): Level {
  const warnMs = Math.min(10 * MIN, 0.4 * ttlMs)
  if (remainingMs < warnMs / 5) return 'crit'
  if (remainingMs < warnMs) return 'warning'
  return 'plain'
}

/** Remaining cache time at `nowMs`, or null before the first main-thread response. */
export function cacheRemaining(cache: BandCache, nowMs: number): number | null {
  return cache.anchorMs === null ? null : cache.anchorMs + cache.ttlMs - nowMs
}

/** `42m`, `<1m`; null → `—`. Callers render `cold` for remaining ≤ 0 themselves via cacheView. */
export function fmtRemaining(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < MIN) return '<1m'
  return `${Math.floor(ms / MIN)}m`
}

export type CacheView = { text: string; level: Level }

/** The cache segment: `cache ●` mid-turn, `cache —` unmeasured, `cache cold`, else the countdown. */
export function cacheView(cache: BandCache, nowMs: number, isWorking: boolean): CacheView {
  if (isWorking) return { text: 'cache ●', level: 'plain' }
  const left = cacheRemaining(cache, nowMs)
  if (left === null) return { text: 'cache —', level: 'plain' }
  if (cache.isCold || left <= 0) return { text: 'cache cold', level: 'plain' }
  return { text: `cache ${fmtRemaining(left)}`, level: cacheLevel(left, cache.ttlMs) }
}

export function ctxText(pct: number | null): string {
  return pct === null ? 'ctx —' : `ctx ${Math.round(pct)}%`
}

const KNOWN_KINDS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: '$' }
const LABEL_MAX = 10

/** `five_hour` → `5h`; an unknown kind keeps its raw name, shortened (`seven_day_fable` → `7d·fable`). */
export function rateLabel(kind: string): string {
  const known = KNOWN_KINDS[kind]
  if (known !== undefined) return known
  const short = kind
    .replace(/^five_hour/, '5h')
    .replace(/^seven_day/, '7d')
    .replace(/_+/g, '·')
    .replace(/^·+|·+$/g, '')
  return [...(short || kind)].slice(0, LABEL_MAX).join('')
}

/** Rounded for display; above 100 (a spend limit) reads `>100%`. */
export function fmtPct(pct: number): string {
  return pct > 100 ? '>100%' : `${Math.round(pct)}%`
}

export type RawRate = { kind: string; percentUsed: number; resetsAt?: string }

/** Every window the API reports, in its order. */
export function toRates(list: readonly RawRate[] | undefined): BandRate[] {
  return (list ?? []).map(r => ({
    kind: r.kind,
    label: rateLabel(r.kind),
    pct: r.percentUsed,
    resetsAt: r.resetsAt ?? null,
  }))
}

export function rateText(r: BandRate): string {
  return `${r.label} ${fmtPct(r.pct)}`
}

type BandButton = { key: string; label: string; hotkey: string; plain: boolean }

/** The band's segments in row order; null/empty = not drawn. */
export type BandSegs = {
  /** null while a rate window is at or past 100 %: in overage the TTL is unknown, so nothing is shown. */
  cache: string | null
  model: string | null
  ctx: string
  rates: BandRate[]
  /** `cost $1.23`; null without a ledger or at zero. */
  cost: string | null
  digest: string | null
  compact: BandButton
  clear: BandButton | null
  progress: BandButton | null
  log: BandButton | null
}

export const SEP = ' │ '
/** The dim rule drawn above the row, one cell repeated across the band. */
export const RULE = '─'
const RATE_GAP = ' · '
const BUTTON_GAP = '  '

/** Width sample: the focused form `c: Compact` (letters show only while the band holds the keyboard) or `[ Compact ]`; they differ by one cell. */
export function buttonText(b: BandButton): string {
  return b.plain ? `${b.hotkey}: ${b.label}` : `[ ${b.label} ]`
}

/** The row as the terminal draws it: groups joined by ` │ `. */
export function rowText(s: BandSegs): string {
  const groups: string[] = s.cache === null ? [] : [s.cache]
  if (s.model !== null) groups.push(`${s.model}${MODEL_MARK}`)
  groups.push(s.ctx)
  if (s.rates.length) groups.push(s.rates.map(rateText).join(RATE_GAP))
  if (s.cost !== null) groups.push(s.cost)
  if (s.digest !== null) groups.push(s.digest)
  const buttons = [s.compact, s.clear, s.progress, s.log].filter((b): b is BandButton => b !== null)
  groups.push(buttons.map(buttonText).join(BUTTON_GAP))
  return groups.join(SEP)
}

/** Width in cells, one per code point. */
export function cells(text: string): number {
  return [...text].length
}

/**
 * Drops segments until the row fits `bodyColumns`: the Log button (/band-log stays), the Clear button (/clear
 * stays), the digest, the cost, then rate windows beyond the fullest (least full first), then the last rate,
 * the model, the Progress button.
 * Cache, ctx and Compact are never dropped. 0 or absent columns = a surface that did not measure: kept whole.
 */
export function layout(segs: BandSegs, bodyColumns: number | undefined): BandSegs {
  if (!bodyColumns || bodyColumns <= 0) return segs
  let s: BandSegs = segs
  const fits = () => cells(rowText(s)) <= bodyColumns
  if (fits()) return s
  if (s.log !== null) s = { ...s, log: null }
  if (!fits() && s.clear !== null) s = { ...s, clear: null }
  if (!fits() && s.digest !== null) s = { ...s, digest: null }
  if (!fits() && s.cost !== null) s = { ...s, cost: null }
  while (!fits() && s.rates.length > 1) {
    const fullest = s.rates.reduce((a, b) => (b.pct > a.pct ? b : a))
    const victim = s.rates.reduce((a, b) => (b !== fullest && (a === fullest || b.pct <= a.pct) ? b : a))
    s = { ...s, rates: s.rates.filter(r => r !== victim) }
  }
  if (!fits() && s.rates.length) s = { ...s, rates: [] }
  if (!fits() && s.model !== null) s = { ...s, model: null }
  if (!fits() && s.progress !== null) s = { ...s, progress: null }
  return s
}

const HOUR = 60 * MIN
const DEFAULT_TTL_MS = 5 * MIN

export const USAGE_INIT: BandUsage = { ctxPct: null, ctxTokens: null, window: 0, rates: [], costUsd: null }
export const CACHE_INIT: BandCache = { anchorMs: null, ttlMs: DEFAULT_TTL_MS, ttlSource: 'default', isCold: false }

/**
 * Whether session.start seeds the TTL again. A reload (a /config change) keeps a learned one; a forced TTL is
 * applied, and leaving a forced one seeds from the store or the default again.
 */
export function seedsTtl(reloaded: boolean, forcedTtl: number | null, source: BandCache['ttlSource']): boolean {
  return !reloaded || forcedTtl !== null || source === 'option'
}

/** `5m` / `1h` (the userConfig picker and the API's `cache_ttl`) in ms; anything else (`auto`) → null. */
export function ttlMsOf(v: unknown): number | null {
  if (v === '5m') return 5 * MIN
  if (v === '1h') return HOUR
  return null
}

export type RawContext = { tokens?: number; window: number; percent?: number }

export type RawCost = { usd: number }

/** `$.session.usage()` / `session.measure` figures as the usage atom holds them. */
export function toUsage(context: RawContext, rateLimits: readonly RawRate[] | undefined, cost?: RawCost): BandUsage {
  return {
    ctxPct: context.percent ?? null,
    ctxTokens: context.tokens ?? null,
    window: context.window,
    rates: toRates(rateLimits),
    costUsd: typeof cost?.usd === 'number' ? cost.usd : null,
  }
}

/** `$0.49`, `$139.14`: the host's /cost total, cents kept so a small session still moves. */
export function fmtUsd(usd: number): string {
  return `$${usd.toFixed(2)}`
}

/** `cost $139.14`; null without a ledger and while the session has cost nothing. */
export function costText(usd: number | null): string | null {
  return usd === null || usd <= 0 ? null : `cost ${fmtUsd(usd)}`
}

/** The cost hover card. */
export function costCard(usd: number): string {
  return `session cost: ${fmtUsd(usd)} at API prices, as /cost counts it (a subscription is not billed per request)`
}

/** `1,234,567`. */
export function fmtInt(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** `in 42m`, `in 2h 05m`, `in 3d 4h`; null when absent or unparsable. */
export function fmtResetIn(resetsAt: string | null, nowMs: number): string | null {
  if (!resetsAt) return null
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return null
  const mins = Math.max(0, Math.round((at - nowMs) / MIN))
  if (mins < 60) return `in ${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return `in ${h}h ${String(mins % 60).padStart(2, '0')}m`
  return `in ${Math.floor(h / 24)}d ${h % 24}h`
}

/** `5h window: 61% used, resets in 2h 05m`: the rate hover card and the ≥ 90 % toast. */
export function rateCard(r: BandRate, nowMs: number): string {
  const reset = fmtResetIn(r.resetsAt, nowMs)
  return `${r.label} window: ${fmtPct(r.pct)} used${reset ? `, resets ${reset}` : ''}`
}

const RATE_ALARM_PCT = 90

/** The first window whose shown percentage is at or past the alarm line, or null. */
export function alarmRate(rates: readonly BandRate[]): BandRate | null {
  return rates.find(r => Math.round(r.pct) >= RATE_ALARM_PCT) ?? null
}

/** `1 h`, `5 min`. */
export function ttlText(ms: number): string {
  return ms % HOUR === 0 ? `${ms / HOUR} h` : `${Math.round(ms / MIN)} min`
}

export function cacheCard(cache: BandCache, nowMs: number): string {
  const left = cacheRemaining(cache, nowMs)
  if (left === null) return 'prompt cache: no response yet'
  if (cache.isCold || left <= 0) return 'prompt cache: cold, the next request writes it again'
  const mins = left < MIN ? '<1' : `~${Math.floor(left / MIN)}`
  return `prompt cache: ${mins} min left (estimate: last response + ${ttlText(cache.ttlMs)} TTL)`
}

/**
 * The context right after a compaction: the engine's own count of the kept conversation over the
 * window already known. It holds until a response reports a measured reading.
 */
export function compactedUsage(u: BandUsage, tokensAfter: number | undefined): BandUsage {
  const known = typeof tokensAfter === 'number' && tokensAfter >= 0
  return { ...u, ctxTokens: known ? tokensAfter : null, ctxPct: known && u.window > 0 ? (tokensAfter / u.window) * 100 : null }
}

/** A measurement without a context reading (window only, as right after a compaction) keeps the last one. */
export function keepCtx(prev: BandUsage, next: BandUsage): BandUsage {
  return next.ctxPct === null ? { ...next, ctxPct: prev.ctxPct, ctxTokens: prev.ctxTokens } : next
}

export function ctxCard(u: BandUsage): string {
  if (u.ctxPct === null) return 'context: no reading yet (fresh session or just compacted)'
  const used = u.ctxTokens === null ? '' : `, ${fmtInt(u.ctxTokens)} used`
  return `context: ${Math.round(u.ctxPct)}% of ${fmtInt(u.window)} tokens${used}`
}

/** Single code points only: a VS16/ZWJ sequence has no settled cell width. */
export const GLYPH = { cache: '⏱', ctx: '\u{1F9E0}', rates: '⏳', model: '\u{1F916}', digest: '\u{1F4CB}', cost: '\u{1F4B0}' } as const

/** The desktop label: the leading word of `cache 42m` / `ctx 47%` / `cost $1.23` becomes its glyph. */
export function glyphText(text: string): string {
  return text
    .replace(/^cache /, `${GLYPH.cache} `)
    .replace(/^ctx /, `${GLYPH.ctx} `)
    .replace(/^cost /, `${GLYPH.cost} `)
}

const COMPACT_LOUD_PCT = 80

/** Always drawn first and always pressable, so the buttons never shift; `plain` = the normal look (never dim), the primary button from 80 % between turns. */
export function compactButton(ctxPct: number | null, isWorking: boolean): BandButton {
  const loud = ctxPct !== null && !isWorking && Math.round(ctxPct) >= COMPACT_LOUD_PCT
  return { key: 'compact', label: 'Compact', hotkey: 'c', plain: !loud }
}

export const CLEAR_BUTTON: BandButton = { key: 'clear', label: 'Clear', hotkey: 'x', plain: true }
export const PROGRESS_BUTTON: BandButton = { key: 'progress', label: 'Progress', hotkey: 'p', plain: true }
export const LOG_BUTTON: BandButton = { key: 'log', label: 'Log', hotkey: 'l', plain: true }

export type CompactOutcome = { skip?: string; tokensBefore?: number; tokensAfter?: number }

export function compactToast(r: CompactOutcome): string {
  if (r.skip !== undefined) return `compact skipped: ${r.skip}`
  const n = (v: number | undefined) => (v === undefined ? '?' : fmtInt(v))
  return `compacted ${n(r.tokensBefore)} → ${n(r.tokensAfter)} tokens`
}

export type BandInput = {
  usage: BandUsage
  model: string | null
  cache: BandCache
  nowMs: number
  isWorking: boolean
  digest: string | null
  /** a task checklist is published: the Progress button is drawn only then */
  hasChecklist: boolean
  /** some event list is non-empty: the Log button is drawn only then */
  hasEvents: boolean
}

/** `claude-fable-5-1` → `fable-5-1`: every model id carries the prefix, so it says nothing. */
export function shortModel(m: string | null): string | null {
  return m === null ? null : m.replace(/^claude-/, '')
}

/** The ids the terminal's model picker offers, as `/model <id>` takes them; the engine lists no models itself. */
export const MODEL_IDS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'] as const

/** The mark after the model id on the terminal: the segment is the picker's button. */
export const MODEL_MARK = ' ▾'

export type ModelOption = { value: string; label: string; hotkey?: string }

/**
 * The picker's options: the known ids plus the session's own when it is none of them (a pinned or dated id).
 * Each takes its label's first letter as hotkey when it is one and still free (`f`, `o`, `s`, `h`).
 */
export function modelOptions(current: string | null): ModelOption[] {
  const ids: string[] = current !== null && !MODEL_IDS.includes(current as (typeof MODEL_IDS)[number]) ? [current, ...MODEL_IDS] : [...MODEL_IDS]
  const taken = new Set<string>()
  return ids.map(value => {
    const label = shortModel(value) as string
    const letter = label[0]
    if (!/^[a-z]$/.test(letter) || taken.has(letter)) return { value, label }
    taken.add(letter)
    return { value, label, hotkey: letter }
  })
}

/** `cache 42m` → [`cache`, `42m`]: the dim label and the bold value; no space → the whole text is the label. */
export function splitLabel(text: string): [string, string] {
  const i = text.indexOf(' ')
  return i < 0 ? [text, ''] : [text.slice(0, i), text.slice(i + 1)]
}

/** Every segment before the width drop. */
export function bandSegs(i: BandInput): BandSegs {
  return {
    cache: i.usage.rates.some(r => r.pct >= 100) ? null : cacheView(i.cache, i.nowMs, i.isWorking).text,
    model: shortModel(i.model),
    ctx: ctxText(i.usage.ctxPct),
    rates: i.usage.rates,
    cost: costText(i.usage.costUsd),
    digest: i.digest,
    compact: compactButton(i.usage.ctxPct, i.isWorking),
    clear: CLEAR_BUTTON,
    progress: i.hasChecklist ? PROGRESS_BUTTON : null,
    log: i.hasEvents ? LOG_BUTTON : null,
  }
}

export const HOUR_MS = HOUR

/** `ephemeral_1h_input_tokens` of an Agent result's usage; 0 when absent. */
export function oneHourCacheTokens(result: unknown): number {
  const usage = (result as { usage?: { cache_creation?: { ephemeral_1h_input_tokens?: unknown } | null } } | null)?.usage
  const n = usage?.cache_creation?.ephemeral_1h_input_tokens
  return typeof n === 'number' ? n : 0
}

const NO_WORKSPACE_HINT = 'no task workspace — /base:save-task-context'
const NO_PROGRESS_HINT = 'no progress.md yet — /base:save-task-context'

const MARKS: ReadonlySet<string> = new Set<ChecklistMark>(['done', 'current', 'waiting', 'todo'])

type Snapshot = Record<string, unknown> & { workId: string }

/** Another plugin writes the snapshot, so every field is checked: a value that is not a finite number reads 0. */
function snapshotOf(p: unknown): Snapshot | null {
  if (p === null || typeof p !== 'object') return null
  const s = p as Record<string, unknown>
  return typeof s.workId === 'string' && s.workId !== '' ? (s as Snapshot) : null
}

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0)

/** base's published task as the generic checklist the Progress pane draws; null while no task resolves. */
export function toChecklist(p: unknown): Checklist | null {
  const s = snapshotOf(p)
  if (s === null) return null
  const done = num(s.done)
  const total = num(s.total)
  const branch = typeof s.branch === 'string' && s.branch !== '' ? s.branch : null
  const subtitle = [branch, total ? `${done}/${total}` : null].filter(Boolean).join(' · ')
  const rows: ChecklistRow[] = (Array.isArray(s.rows) ? s.rows : [])
    .filter((r): r is { mark?: unknown; text: string } => r !== null && typeof r === 'object' && typeof (r as { text?: unknown }).text === 'string')
    .map(r => ({ mark: typeof r.mark === 'string' && MARKS.has(r.mark) ? (r.mark as ChecklistMark) : 'todo', text: r.text }))
  const hint = s.hasWorkspace === false ? NO_WORKSPACE_HINT : total === 0 ? NO_PROGRESS_HINT : null
  const notes = Array.isArray(s.notesTail) ? s.notesTail.filter((l): l is string => typeof l === 'string') : []
  const footer = [...(hint === null ? [] : [hint]), ...notes]
  return { v: 1, title: s.workId, ...(subtitle ? { subtitle } : {}), rows, ...(footer.length ? { footer } : {}) }
}

/** Band digest: `ELC-1591 3/5 ▶ Preview themes`, `ELC-1591 ✓ 5/5` when every row is checked, the id alone with no rows. */
export function digestOf(p: unknown): string | null {
  const s = snapshotOf(p)
  if (s === null) return null
  const done = num(s.done)
  const total = num(s.total)
  const current = typeof s.current === 'string' ? s.current : null
  if (total === 0) return s.workId
  if (current === null) return `${s.workId} ✓ ${done}/${total}`
  return `${s.workId} ${done}/${total} ▶ ${current}`
}
