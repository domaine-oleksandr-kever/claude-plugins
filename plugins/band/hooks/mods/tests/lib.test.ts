import { describe, expect, test } from 'claude-code/testing'
import {
  CACHE_INIT,
  CRIT,
  CTX_PROPS,
  LEVEL_PROPS,
  USAGE_INIT,
  alarmRate,
  bandSegs,
  buttonText,
  cacheCard,
  compactButton,
  compactToast,
  costCard,
  costText,
  compactedUsage,
  ctxCard,
  fmtInt,
  fmtUsd,
  fmtResetIn,
  glyphText,
  keepCtx,
  oneHourCacheTokens,
  rateCard,
  toUsage,
  ttlMsOf,
  ttlText,
  cacheLevel,
  cacheView,
  cells,
  ctxText,
  digestOf,
  fmtPct,
  fmtRemaining,
  layout,
  modelOptions,
  pctLevel,
  rateLabel,
  rowText,
  shortModel,
  splitLabel,
  toChecklist,
  toRates,
} from '../lib.ts'
import type { BandSegs } from '../lib.ts'

const MIN = 60_000
const HOUR = 60 * MIN

describe('ladders', () => {
  test('ctx and rate ladder at 30/31/79/80', () => {
    expect(pctLevel(0)).toBe('plain')
    expect(pctLevel(30)).toBe('plain')
    expect(pctLevel(31)).toBe('warning')
    expect(pctLevel(79)).toBe('warning')
    expect(pctLevel(80)).toBe('crit')
    expect(pctLevel(120.4)).toBe('crit')
    expect(pctLevel(30.4)).toBe('plain')
    expect(pctLevel(30.5)).toBe('warning')
    expect(pctLevel(79.6)).toBe('crit')
    expect(CTX_PROPS.plain).toEqual({ color: 'success' })
    expect(CTX_PROPS.warning).toEqual(LEVEL_PROPS.warning)
    expect(CTX_PROPS.crit).toEqual(LEVEL_PROPS.crit)
    expect(LEVEL_PROPS.plain).toEqual({})
  })

  test('cache ladder at 10/9/2/1 min for a 1 h TTL', () => {
    expect(cacheLevel(10 * MIN, HOUR)).toBe('plain')
    expect(cacheLevel(9 * MIN, HOUR)).toBe('warning')
    expect(cacheLevel(2 * MIN, HOUR)).toBe('warning')
    expect(cacheLevel(1 * MIN, HOUR)).toBe('crit')
  })

  test('cache ladder scales to a 5 min TTL', () => {
    const ttl = 5 * MIN
    expect(cacheLevel(3 * MIN, ttl)).toBe('plain')
    expect(cacheLevel(2 * MIN, ttl)).toBe('plain')
    expect(cacheLevel(1.5 * MIN, ttl)).toBe('warning')
    expect(cacheLevel(20_000, ttl)).toBe('crit')
  })

  test('crit needs no theme key beyond warning', () => {
    expect(LEVEL_PROPS.plain).toEqual({})
    expect(LEVEL_PROPS.warning).toEqual({ color: 'warning' })
    expect(LEVEL_PROPS.crit).toEqual({ color: 'warning', bold: true, inverse: true })
  })

  test('CRIT is the one constant every crit level uses', () => {
    expect(LEVEL_PROPS.crit).toBe(CRIT)
  })
})

describe('remaining time', () => {
  const cache = { anchorMs: 1_000_000, ttlMs: HOUR, ttlSource: 'option' as const, isCold: false }

  test('formatting', () => {
    expect(fmtRemaining(null)).toBe('—')
    expect(fmtRemaining(42 * MIN)).toBe('42m')
    expect(fmtRemaining(42 * MIN + 59_000)).toBe('42m')
    expect(fmtRemaining(59_000)).toBe('<1m')
  })

  test('segment states', () => {
    expect(cacheView({ ...cache, anchorMs: null }, 0, false)).toEqual({ text: 'cache —', level: 'plain' })
    expect(cacheView(cache, cache.anchorMs + 18 * MIN, false)).toEqual({ text: 'cache 42m', level: 'plain' })
    expect(cacheView(cache, cache.anchorMs + 59 * MIN, false)).toEqual({ text: 'cache 1m', level: 'crit' })
    expect(cacheView(cache, cache.anchorMs + 59.5 * MIN, false)).toEqual({ text: 'cache <1m', level: 'crit' })
    expect(cacheView(cache, cache.anchorMs + 61 * MIN, false).text).toBe('cache cold')
    expect(cacheView({ ...cache, isCold: true }, cache.anchorMs, false).text).toBe('cache cold')
    expect(cacheView(cache, cache.anchorMs, true).text).toBe('cache ●')
  })

  test('ctx text', () => {
    expect(ctxText(null)).toBe('ctx —')
    expect(ctxText(47)).toBe('ctx 47%')
  })
})

describe('rate labels', () => {
  test('known kinds', () => {
    expect(rateLabel('five_hour')).toBe('5h')
    expect(rateLabel('seven_day')).toBe('7d')
    expect(rateLabel('spend_limit')).toBe('$')
  })

  test('unknown kind is shortened', () => {
    expect(rateLabel('seven_day_fable')).toBe('7d·fable')
    expect(rateLabel('seven_day_opus')).toBe('7d·opus')
    expect(cells(rateLabel('monthly_organization_cap'))).toBeLessThanOrEqual(10)
  })

  test('percent display', () => {
    expect(fmtPct(61.4)).toBe('61%')
    expect(fmtPct(100)).toBe('100%')
    expect(fmtPct(120.4)).toBe('>100%')
  })

  test('every window in API order; empty list → none', () => {
    const rates = toRates([
      { kind: 'five_hour', percentUsed: 61, resetsAt: '2026-10-03T14:05:00Z' },
      { kind: 'seven_day', percentUsed: 34 },
      { kind: 'seven_day_fable', percentUsed: 12 },
    ])
    expect(rates.map(r => r.label)).toEqual(['5h', '7d', '7d·fable'])
    expect(rates[0]).toEqual({ kind: 'five_hour', label: '5h', pct: 61, resetsAt: '2026-10-03T14:05:00Z' })
    expect(rates[1]?.resetsAt).toBeNull()
    expect(toRates([])).toEqual([])
    expect(toRates(undefined)).toEqual([])
  })
})

describe('layout', () => {
  const full: BandSegs = {
    cache: 'cache 42m',
    model: 'Fable 5.1',
    ctx: 'ctx 47%',
    rates: toRates([
      { kind: 'five_hour', percentUsed: 61 },
      { kind: 'seven_day', percentUsed: 34 },
      { kind: 'seven_day_fable', percentUsed: 12 },
    ]),
    cost: 'cost $139.14',
    digest: 'ELC-1591 3/5 ▶ Preview themes',
    compact: { key: 'compact', label: 'Compact', hotkey: 'c', plain: true },
    clear: { key: 'clear', label: 'Clear', hotkey: 'x', plain: true },
    progress: { key: 'progress', label: 'Progress', hotkey: 'p', plain: true },
    log: { key: 'log', label: 'Log', hotkey: 'l', plain: true },
  }
  const at = (w: number) => rowText(layout(full, w))

  test('width model', () => {
    expect(buttonText({ key: 'compact', label: 'Compact', hotkey: 'c', plain: true })).toBe('c: Compact')
    expect(buttonText({ key: 'compact', label: 'Compact', hotkey: 'c', plain: false })).toBe('[ Compact ]')
    expect(rowText(full)).toBe(
      'cache 42m │ Fable 5.1 ▾ │ ctx 47% │ 5h 61% · 7d 34% · 7d·fable 12% │ cost $139.14 │ ELC-1591 3/5 ▶ Preview themes │ c: Compact  x: Clear  p: Progress  l: Log',
    )
    expect(cells(rowText(full))).toBe(157)
  })

  test('drop order 1→8', () => {
    expect(at(160)).toBe(rowText(full))
    expect(at(157)).toBe(rowText(full))
    expect(at(149)).toBe('cache 42m │ Fable 5.1 ▾ │ ctx 47% │ 5h 61% · 7d 34% · 7d·fable 12% │ cost $139.14 │ ELC-1591 3/5 ▶ Preview themes │ c: Compact  x: Clear  p: Progress')
    expect(at(139)).toBe('cache 42m │ Fable 5.1 ▾ │ ctx 47% │ 5h 61% · 7d 34% · 7d·fable 12% │ cost $139.14 │ ELC-1591 3/5 ▶ Preview themes │ c: Compact  p: Progress')
    expect(at(110)).toBe('cache 42m │ Fable 5.1 ▾ │ ctx 47% │ 5h 61% · 7d 34% · 7d·fable 12% │ cost $139.14 │ c: Compact  p: Progress')
    expect(at(100)).toBe('cache 42m │ Fable 5.1 ▾ │ ctx 47% │ 5h 61% · 7d 34% · 7d·fable 12% │ c: Compact  p: Progress')
    expect(at(80)).toBe('cache 42m │ Fable 5.1 ▾ │ ctx 47% │ 5h 61% · 7d 34% │ c: Compact  p: Progress')
    expect(at(70)).toBe('cache 42m │ Fable 5.1 ▾ │ ctx 47% │ 5h 61% │ c: Compact  p: Progress')
    expect(at(60)).toBe('cache 42m │ Fable 5.1 ▾ │ ctx 47% │ c: Compact  p: Progress')
    expect(at(50)).toBe('cache 42m │ ctx 47% │ c: Compact  p: Progress')
    expect(at(40)).toBe('cache 42m │ ctx 47% │ c: Compact')
  })

  test('the fullest window outlives the others wherever it sits', () => {
    const s = { ...full, log: null, clear: null, digest: null, cost: null, rates: toRates([
      { kind: 'five_hour', percentUsed: 10 },
      { kind: 'seven_day', percentUsed: 90 },
    ]) }
    expect(layout(s, cells(rowText(s)) - 1).rates.map(r => r.label)).toEqual(['7d'])
  })

  test('overage hides the cache; the model drops its claude- prefix', () => {
    expect(rowText({ ...full, cache: null })).toStartWith('Fable 5.1 ▾ │ ctx 47% │')
    expect(shortModel('claude-fable-5-1')).toBe('fable-5-1')
    expect(shortModel('claude-opus-5-5')).toBe('opus-5-5')
    expect(shortModel(null)).toBeNull()
    expect(modelOptions('claude-opus-5-5').map(o => o.label)).toEqual(['fable-5-1', 'opus-5-5', 'sonnet-5-5', 'haiku-4-5-20251001'])
    expect(modelOptions('claude-opus-5-5').map(o => o.hotkey)).toEqual(['f', 'o', 's', 'h'])
    expect(modelOptions(null)).toHaveLength(4)
    // A pinned id leads and takes its letter; the listed id it shadows goes without one.
    const pinned = modelOptions('claude-opus-5-5[1m]')
    expect(pinned[0]).toEqual({ value: 'claude-opus-5-5[1m]', label: 'opus-5-5[1m]', hotkey: 'o' })
    expect(pinned[2]).toEqual({ value: 'claude-opus-5-5', label: 'opus-5-5' })
    expect(splitLabel('cache 42m')).toEqual(['cache', '42m'])
    expect(splitLabel('ELC-1591 3/5 ▶ Preview')).toEqual(['ELC-1591', '3/5 ▶ Preview'])
    expect(splitLabel('fnd-mods')).toEqual(['fnd-mods', ''])
  })

  test('cache, ctx and Compact survive 30 columns', () => {
    const narrow = layout({ ...full, compact: { ...full.compact, plain: false } }, 30)
    expect(rowText(narrow)).toBe('cache 42m │ ctx 47% │ [ Compact ]')
    expect(narrow.model).toBeNull()
    expect(narrow.rates).toEqual([])
    expect(narrow.cost).toBeNull()
    expect(narrow.digest).toBeNull()
    expect(narrow.clear).toBeNull()
    expect(narrow.progress).toBeNull()
    expect(narrow.log).toBeNull()
  })

  test('an unmeasured width keeps the row whole', () => {
    expect(layout(full, 0)).toBe(full)
    expect(layout(full, undefined)).toBe(full)
  })
})

describe('usage and TTL', () => {
  test('ttlMsOf: the picker values and the API cache_ttl; auto → null', () => {
    expect(ttlMsOf('5m')).toBe(5 * MIN)
    expect(ttlMsOf('1h')).toBe(HOUR)
    expect(ttlMsOf('auto')).toBeNull()
    expect(ttlMsOf(undefined)).toBeNull()
  })

  test('initial atoms: no reading, 5 min default TTL', () => {
    expect(USAGE_INIT).toEqual({ ctxPct: null, ctxTokens: null, window: 0, rates: [], costUsd: null })
    expect(CACHE_INIT).toEqual({ anchorMs: null, ttlMs: 5 * MIN, ttlSource: 'default', isCold: false })
  })

  test('compactedUsage: tokensAfter over the known window; absent count or window → no reading', () => {
    const u = toUsage({ window: 200_000, percent: 47, tokens: 94_000 }, [])
    expect(compactedUsage(u, 26_300)).toEqual({ ...u, ctxPct: 13.15, ctxTokens: 26_300 })
    expect(compactedUsage(u, undefined)).toEqual({ ...u, ctxPct: null, ctxTokens: null })
    expect(compactedUsage(USAGE_INIT, 26_300)).toEqual({ ...USAGE_INIT, ctxPct: null, ctxTokens: 26_300 })
  })

  test('keepCtx: a reading without a fill keeps the last fill; a measured one replaces it', () => {
    const prev = compactedUsage(toUsage({ window: 200_000, percent: 47 }, []), 26_300)
    const bare = toUsage({ window: 200_000 }, [{ kind: 'five_hour', percentUsed: 61 }], { usd: 1 })
    expect(keepCtx(prev, bare)).toEqual({ ...bare, ctxPct: 13.15, ctxTokens: 26_300 })
    const measured = toUsage({ window: 200_000, percent: 15, tokens: 30_000 }, [])
    expect(keepCtx(prev, measured)).toBe(measured)
    expect(keepCtx(USAGE_INIT, bare)).toEqual(bare)
  })

  test('toUsage: absent percent, tokens and cost stay null', () => {
    expect(toUsage({ window: 200_000 }, [])).toEqual({ ctxPct: null, ctxTokens: null, window: 200_000, rates: [], costUsd: null })
    const u = toUsage({ window: 200_000, percent: 47, tokens: 94_000 }, [{ kind: 'five_hour', percentUsed: 61 }], { usd: 139.1386989 })
    expect(u).toMatchObject({ ctxPct: 47, ctxTokens: 94_000, window: 200_000, costUsd: 139.1386989 })
    expect(u.rates.map(r => r.label)).toEqual(['5h'])
  })

  test('cost: two decimals, hidden at zero or without a ledger; a glyph on desktop', () => {
    expect(fmtUsd(139.1386989)).toBe('$139.14')
    expect(fmtUsd(0.4920822)).toBe('$0.49')
    expect(costText(139.1386989)).toBe('cost $139.14')
    expect(costText(0)).toBeNull()
    expect(costText(null)).toBeNull()
    expect(costCard(0.4920822)).toBe('session cost: $0.49 at API prices, as /cost counts it (a subscription is not billed per request)')
    expect(glyphText('cost $0.49')).toBe('\u{1F4B0} $0.49')
  })

  test('oneHourCacheTokens reads an Agent result defensively', () => {
    expect(oneHourCacheTokens({ usage: { cache_creation: { ephemeral_1h_input_tokens: 12 } } })).toBe(12)
    expect(oneHourCacheTokens({ usage: { cache_creation: null } })).toBe(0)
    expect(oneHourCacheTokens('text')).toBe(0)
    expect(oneHourCacheTokens(null)).toBe(0)
  })
})

describe('cards and toasts', () => {
  const NOW = Date.parse('2026-10-03T12:00:00Z')

  test('fmtResetIn', () => {
    expect(fmtResetIn(null, NOW)).toBeNull()
    expect(fmtResetIn('not a date', NOW)).toBeNull()
    expect(fmtResetIn('2026-10-03T12:42:00Z', NOW)).toBe('in 42m')
    expect(fmtResetIn('2026-10-03T14:05:00Z', NOW)).toBe('in 2h 05m')
    expect(fmtResetIn('2026-10-06T16:00:00Z', NOW)).toBe('in 3d 4h')
    expect(fmtResetIn('2026-10-03T11:00:00Z', NOW)).toBe('in 0m')
  })

  test('rate card and the alarm line', () => {
    const [r] = toRates([{ kind: 'five_hour', percentUsed: 91, resetsAt: '2026-10-03T14:05:00Z' }])
    expect(rateCard(r!, NOW)).toBe('5h window: 91% used, resets in 2h 05m')
    expect(rateCard({ ...r!, resetsAt: null }, NOW)).toBe('5h window: 91% used')
    expect(alarmRate(toRates([{ kind: 'five_hour', percentUsed: 89.4 }]))).toBeNull()
    expect(alarmRate(toRates([{ kind: 'five_hour', percentUsed: 89.9 }]))?.label).toBe('5h')
    expect(alarmRate(toRates([{ kind: 'five_hour', percentUsed: 50 }, { kind: 'seven_day', percentUsed: 90 }]))?.label).toBe('7d')
  })

  test('cache and ctx cards', () => {
    const cache = { anchorMs: 0, ttlMs: HOUR, ttlSource: 'option' as const, isCold: false }
    expect(ttlText(HOUR)).toBe('1 h')
    expect(ttlText(5 * MIN)).toBe('5 min')
    expect(cacheCard({ ...cache, anchorMs: null }, 0)).toBe('prompt cache: no response yet')
    expect(cacheCard(cache, 18 * MIN)).toBe('prompt cache: ~42 min left (estimate: last response + 1 h TTL)')
    expect(cacheCard(cache, 59.5 * MIN)).toBe('prompt cache: <1 min left (estimate: last response + 1 h TTL)')
    expect(cacheCard(cache, 61 * MIN)).toMatch(/^prompt cache: cold/)
    expect(ctxCard(USAGE_INIT)).toMatch(/^context: no reading yet/)
    expect(ctxCard({ ...USAGE_INIT, ctxPct: 47, ctxTokens: 94_000, window: 200_000 })).toBe(
      'context: 47% of 200,000 tokens, 94,000 used',
    )
    expect(fmtInt(1_234_567)).toBe('1,234,567')
  })

  test('compact toasts', () => {
    expect(compactToast({ skip: 'turn running' })).toBe('compact skipped: turn running')
    expect(compactToast({ tokensBefore: 150_000, tokensAfter: 20_000 })).toBe('compacted 150,000 → 20,000 tokens')
    expect(compactToast({})).toBe('compacted ? → ? tokens')
  })

  test('desktop glyph labels are single code points', () => {
    expect(glyphText('cache 42m')).toBe('⏱ 42m')
    expect(glyphText('ctx 47%')).toBe('\u{1F9E0} 47%')
    expect(glyphText('Fable 5.1')).toBe('Fable 5.1')
    for (const g of ['⏱', '\u{1F9E0}', '⏳']) expect([...g]).toHaveLength(1)
  })
})

describe('segments', () => {
  test('Compact: always drawn, normal look until 80 % between turns, loud from 80', () => {
    for (const pct of [null, 0, 10, 30, 50, 79, 79.4]) {
      expect(compactButton(pct, false)).toEqual({ key: 'compact', label: 'Compact', hotkey: 'c', plain: true })
    }
    expect(compactButton(80, false).plain).toBe(false)
    expect(compactButton(79.6, false).plain).toBe(false)
    expect(compactButton(90, true).plain).toBe(true)
    expect(compactButton(null, true).plain).toBe(true)
  })

  test('bandSegs from the atoms', () => {
    const s = bandSegs({
      usage: { ...USAGE_INIT, ctxPct: 47, rates: toRates([{ kind: 'five_hour', percentUsed: 61 }]), costUsd: 0.4920822 },
      model: 'claude-fable-5-1',
      cache: { ...CACHE_INIT, anchorMs: 0, ttlMs: HOUR },
      nowMs: 18 * MIN,
      isWorking: false,
      digest: 'ELC-1591 3/5 ▶ Preview themes',
      hasChecklist: true,
      hasEvents: true,
    })
    expect(rowText(s)).toBe(
      'cache 42m │ fable-5-1 ▾ │ ctx 47% │ 5h 61% │ cost $0.49 │ ELC-1591 3/5 ▶ Preview themes │ c: Compact  x: Clear  p: Progress  l: Log',
    )
  })

  test('Compact leads the buttons before the first reading, at 10 % and mid-turn', () => {
    const base = { model: null, cache: CACHE_INIT, nowMs: 0, digest: null, hasChecklist: true, hasEvents: true }
    for (const [ctxPct, isWorking] of [[null, false], [10, false], [50, true], [85, true]] as const) {
      const s = bandSegs({ ...base, usage: { ...USAGE_INIT, ctxPct }, isWorking })
      expect(s.compact.key).toBe('compact')
      expect(rowText(s)).toEndWith('│ c: Compact  x: Clear  p: Progress  l: Log')
    }
  })

  test('bandSegs drops Progress without a checklist and Log without events', () => {
    const base = { usage: USAGE_INIT, model: null, cache: CACHE_INIT, nowMs: 0, isWorking: false, digest: null }
    expect(rowText(bandSegs({ ...base, hasChecklist: false, hasEvents: false }))).toEndWith('│ c: Compact  x: Clear')
    expect(rowText(bandSegs({ ...base, hasChecklist: true, hasEvents: false }))).toEndWith('│ c: Compact  x: Clear  p: Progress')
    expect(rowText(bandSegs({ ...base, hasChecklist: false, hasEvents: true }))).toEndWith('│ c: Compact  x: Clear  l: Log')
  })
})

const SNAP = {
  workId: 'ELC-1591',
  branch: 'feature/ELC-1591-x',
  hasWorkspace: true,
  done: 3,
  total: 5,
  current: 'Preview themes',
  rows: [
    { mark: 'done', text: 'Read' },
    { mark: 'waiting', text: 'Owner' },
    { mark: 'current', text: 'Preview themes' },
    { mark: 'todo', text: 'QA' },
  ],
  notesTail: ['- two', '- three'],
  mtimeMs: 1,
}

describe('toChecklist', () => {
  test('no task → null: null, a non-object, workId null or empty', () => {
    expect(toChecklist(null)).toBeNull()
    expect(toChecklist(undefined)).toBeNull()
    expect(toChecklist('ELC-1')).toBeNull()
    expect(toChecklist([])).toBeNull()
    expect(toChecklist({ workId: null, branch: 'main' })).toBeNull()
    expect(toChecklist({ ...SNAP, workId: '' })).toBeNull()
    expect(toChecklist({ ...SNAP, workId: 7 })).toBeNull()
  })

  test('title = workId, subtitle = branch · done/total, rows as given, notesTail as the footer', () => {
    expect(toChecklist(SNAP)).toEqual({
      v: 1,
      title: 'ELC-1591',
      subtitle: 'feature/ELC-1591-x · 3/5',
      rows: SNAP.rows,
      footer: ['- two', '- three'],
    })
  })

  test('no branch → the ratio alone; total 0 → no ratio; neither → no subtitle', () => {
    expect(toChecklist({ ...SNAP, branch: null })?.subtitle).toBe('3/5')
    expect(toChecklist({ ...SNAP, branch: '' })?.subtitle).toBe('3/5')
    expect(toChecklist({ ...SNAP, done: 0, total: 0, rows: [] })?.subtitle).toBe('feature/ELC-1591-x')
    expect(toChecklist({ ...SNAP, branch: null, done: 0, total: 0, rows: [] })).not.toHaveProperty('subtitle')
  })

  test('no workspace → the no-workspace hint leads the footer; total 0 → the no-progress.md hint', () => {
    expect(toChecklist({ workId: 'ELC-77', branch: 'main', hasWorkspace: false, done: 0, total: 0, current: null, rows: [], notesTail: [], mtimeMs: 0 })?.footer).toEqual([
      'no task workspace — /fnd:save-task-context',
    ])
    expect(toChecklist({ ...SNAP, done: 0, total: 0, rows: [] })?.footer).toEqual(['no progress.md yet — /fnd:save-task-context', '- two', '- three'])
    expect(toChecklist({ ...SNAP, notesTail: [] })).not.toHaveProperty('footer')
  })

  test('tolerant: an unknown mark → todo, a row without a string text dropped, non-finite figures → 0, a bad notesTail ignored', () => {
    const c = toChecklist({
      ...SNAP,
      done: Number.NaN,
      total: '5',
      rows: [{ mark: 'skipped', text: 'a' }, { mark: 'done' }, null, 'b', { text: 'c' }, { mark: 'done', text: 3 }],
      notesTail: ['- ok', 4, null],
    })
    expect(c?.rows).toEqual([
      { mark: 'todo', text: 'a' },
      { mark: 'todo', text: 'c' },
    ])
    expect(c?.subtitle).toBe('feature/ELC-1591-x')
    expect(c?.footer).toEqual(['no progress.md yet — /fnd:save-task-context', '- ok'])
    expect(toChecklist({ workId: 'ELC-1', rows: 'x', notesTail: 'y' })).toEqual({ v: 1, title: 'ELC-1', rows: [], footer: ['no progress.md yet — /fnd:save-task-context'] })
  })
})

describe('digestOf', () => {
  test('the id alone with no rows; ✓ n/n when every row is done; n/m ▶ current otherwise', () => {
    expect(digestOf(SNAP)).toBe('ELC-1591 3/5 ▶ Preview themes')
    expect(digestOf({ ...SNAP, done: 5, current: null })).toBe('ELC-1591 ✓ 5/5')
    expect(digestOf({ ...SNAP, done: 0, total: 0, current: null, rows: [] })).toBe('ELC-1591')
  })

  test('malformed → null or the safe reading', () => {
    expect(digestOf(null)).toBeNull()
    expect(digestOf({ workId: null, branch: 'main' })).toBeNull()
    expect(digestOf('ELC-1')).toBeNull()
    expect(digestOf({ workId: 'ELC-1', total: 2, done: 1, current: 9 })).toBe('ELC-1 ✓ 1/2')
    expect(digestOf({ workId: 'ELC-1' })).toBe('ELC-1')
  })
})
