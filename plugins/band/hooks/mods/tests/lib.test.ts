import { describe, expect, test } from 'claude-code/testing'
import {
  CACHE_INIT,
  GLYPH,
  accountCard,
  accountLabel,
  accountMode,
  creditGate,
  groupResets,
  loginAccount,
  loginPaths,
  planName,
  profileAccount,
  CRIT,
  CTX_PROPS,
  LEVEL_PROPS,
  USAGE_INIT,
  alarmRate,
  bandSegs,
  buttonText,
  cacheCard,
  compactQuestion,
  compactButton,
  compactToast,
  costCard,
  costText,
  compactedUsage,
  ctxCard,
  fmtInt,
  fmtUsd,
  fmtResetIn,
  fmtResetShort,
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
  endpointRates,
  mergeRates,
  fmtPct,
  fmtRemaining,
  layout,
  modelFamily,
  modelOptions,
  pctLevel,
  rateLabel,
  rateText,
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

describe('compact question', () => {
  const cache = { anchorMs: 1_000_000, ttlMs: HOUR, ttlSource: 'option' as const, isCold: false }

  test('warm or unmeasured → none; 5 min left, run out or cold → the one full-price text', () => {
    expect(compactQuestion({ ...cache, anchorMs: null }, 0)).toBeNull()
    expect(compactQuestion(cache, cache.anchorMs + 18 * MIN)).toBeNull()
    expect(compactQuestion(cache, cache.anchorMs + 54 * MIN)).toBeNull()
    expect(compactQuestion(cache, cache.anchorMs + 55 * MIN)).toMatch(/^Prompt cache is cold or ends within 5 min: .*full price.*Compact anyway\?$/)
    expect(compactQuestion(cache, cache.anchorMs + 61 * MIN)).toBe(compactQuestion(cache, cache.anchorMs + 55 * MIN))
    expect(compactQuestion({ ...cache, isCold: true }, cache.anchorMs)).toBe(compactQuestion(cache, cache.anchorMs + 61 * MIN))
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

describe('usage endpoint windows', () => {
  const win = (utilization: unknown, resets_at: unknown = null) => ({ utilization, resets_at })
  const scoped = (name: unknown, percent: unknown, kind = 'weekly_scoped') => ({ kind, group: 'g', percent, resets_at: null, scope: { model: { display_name: name } }, severity: 'ok', is_active: true })

  test('top-level windows in order, then per-model weekly rows; null and non-number windows skipped', () => {
    const body = {
      seven_day_sonnet: win(5),
      seven_day: win(34, '2026-10-20T00:00:00Z'),
      five_hour: win(61.5),
      seven_day_opus: null,
      seven_day_oauth_apps: win(3),
      limits: [scoped('Fable', 12), scoped('Fable 5.1', 7), scoped('Opus', 2, 'weekly_all'), { kind: 'session', percent: 61, scope: null }],
    }
    expect(endpointRates(body)).toEqual([
      { kind: 'five_hour', percentUsed: 61.5 },
      { kind: 'seven_day', percentUsed: 34, resetsAt: '2026-10-20T00:00:00Z' },
      { kind: 'seven_day_sonnet', percentUsed: 5 },
      { kind: 'seven_day_fable', percentUsed: 12 },
      { kind: 'seven_day_fable_5_1', percentUsed: 7 },
    ])
    expect(endpointRates({ five_hour: win(null), seven_day: win('34'), seven_day_sonnet: win(Number.NaN), limits: [scoped('Fable', '12'), scoped(5, 1), scoped('  ', 1)] })).toEqual([])
  })

  test('a malformed body reads no window; a model named like a top-level window keeps the first', () => {
    for (const body of [null, 'x', 5, [], {}, { limits: 'x' }, { limits: [null, 'row', { kind: 'weekly_scoped', scope: null, percent: 1 }] }]) {
      expect(endpointRates(body)).toEqual([])
    }
    expect(endpointRates({ seven_day_opus: win(9), limits: [scoped('Opus', 2)] })).toEqual([{ kind: 'seven_day_opus', percentUsed: 9 }])
  })

  test('labels: opus, sonnet and a model id read as the band shows them', () => {
    expect(toRates(endpointRates({ seven_day_opus: win(1), seven_day_sonnet: win(1), limits: [scoped('Fable', 1), scoped('Fable 5.1', 1)] })).map(r => r.label)).toEqual([
      '7d·opus',
      '7d·sonnet',
      '7d·fable',
      '7d·fable·5',
    ])
  })

  test('mergeRates: the measured windows lead and win their kind; the endpoint adds the rest in its order', () => {
    const measured = toRates([{ kind: 'seven_day', percentUsed: 30 }, { kind: 'five_hour', percentUsed: 70 }])
    const endpoint = toRates([{ kind: 'five_hour', percentUsed: 61 }, { kind: 'seven_day_fable', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 34 }])
    expect(mergeRates(measured, endpoint).map(r => `${r.kind} ${r.pct}`)).toEqual(['seven_day 30', 'five_hour 70', 'seven_day_fable 12'])
    expect(mergeRates([], endpoint)).toEqual(endpoint)
    expect(mergeRates(measured, [])).toEqual(measured)
  })
})

describe('layout', () => {
  const full: BandSegs = {
    account: null,
    cache: 'cache 42m',
    model: 'Fable 5.1',
    ctx: 'ctx 47%',
    rates: toRates([
      { kind: 'five_hour', percentUsed: 61 },
      { kind: 'seven_day', percentUsed: 34 },
      { kind: 'seven_day_fable', percentUsed: 12 },
    ]),
    resetsNowMs: null,
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

  test('reset times: shown on a wide row, dropped right after Clear and before the digest', () => {
    const now = Date.parse('2026-10-03T12:00:00Z')
    const s: BandSegs = {
      ...full,
      resetsNowMs: now,
      rates: toRates([
        { kind: 'five_hour', percentUsed: 61, resetsAt: '2026-10-03T14:05:00Z' },
        { kind: 'seven_day', percentUsed: 34, resetsAt: '2026-10-06T16:00:00Z' },
        { kind: 'seven_day_fable', percentUsed: 12 },
      ]),
    }
    const wide = 'cache 42m │ Fable 5.1 ▾ │ ctx 47% │ 5h 61% ↻2h05m · 7d 34% ↻3d4h · 7d·fable 12% │ cost $139.14 │ ELC-1591 3/5 ▶ Preview themes │ c: Compact  x: Clear  p: Progress  l: Log'
    expect(rowText(s)).toBe(wide)
    expect(cells(wide)).toBe(170)
    expect(rowText(layout(s, 170))).toBe(wide)
    expect(rowText(layout(s, 152))).toBe('cache 42m │ Fable 5.1 ▾ │ ctx 47% │ 5h 61% ↻2h05m · 7d 34% ↻3d4h · 7d·fable 12% │ cost $139.14 │ ELC-1591 3/5 ▶ Preview themes │ c: Compact  p: Progress')
    expect(rowText(layout(s, 151))).toBe('cache 42m │ Fable 5.1 ▾ │ ctx 47% │ 5h 61% · 7d 34% · 7d·fable 12% │ cost $139.14 │ ELC-1591 3/5 ▶ Preview themes │ c: Compact  p: Progress')
    expect(layout(s, 151).resetsNowMs).toBeNull()
    expect(layout(s, 138).digest).toBeNull()
    expect(layout(s, undefined)).toBe(s)
    expect(layout(s, 0)).toBe(s)
  })

  test('weekly windows sharing a reset show it once; a narrow row still drops it first', () => {
    const now = Date.parse('2026-10-03T12:00:00Z')
    const s: BandSegs = {
      ...full,
      resetsNowMs: now,
      rates: toRates([
        { kind: 'five_hour', percentUsed: 61, resetsAt: '2026-10-03T14:05:00Z' },
        { kind: 'seven_day', percentUsed: 34, resetsAt: '2026-10-06T16:00:00Z' },
        { kind: 'seven_day_fable', percentUsed: 12, resetsAt: '2026-10-06T16:00:20Z' },
      ]),
    }
    expect(rowText(s)).toContain('│ 5h 61% ↻2h05m · 7d 34% · 7d·fable 12% ↻3d4h │')
    const narrow = layout(s, cells(rowText(s)) - 1 - 'x: Clear  l: Log  '.length)
    expect(narrow.resetsNowMs).toBeNull()
    expect(rowText(narrow)).toContain('│ 5h 61% · 7d 34% · 7d·fable 12% │')
  })

  test('the account leads the row and goes right after the reset times, before the digest', () => {
    const now = Date.parse('2026-10-03T12:00:00Z')
    const s: BandSegs = {
      ...full,
      account: 'work',
      resetsNowMs: now,
      rates: toRates([{ kind: 'five_hour', percentUsed: 61, resetsAt: '2026-10-03T14:05:00Z' }]),
    }
    const wide = rowText(s)
    expect(wide).toStartWith('work │ cache 42m │ Fable 5.1 ▾ │')
    expect(rowText({ ...s, account: 'personal' })).toStartWith('personal │ cache 42m │')
    expect(rowText({ ...s, account: 'work', cache: null })).toStartWith('work │ Fable 5.1 ▾ │')
    const noButtons = cells(wide) - cells('  x: Clear  l: Log')
    expect(layout(s, noButtons).account).toBe('work')
    expect(layout(s, noButtons).resetsNowMs).toBe(now)
    const noResets = layout(s, noButtons - 1)
    expect(noResets.resetsNowMs).toBeNull()
    expect(noResets.account).toBe('work')
    const noAccount = layout(s, cells(rowText(noResets)) - 1)
    expect(noAccount.account).toBeNull()
    expect(noAccount.digest).toBe(full.digest)
    expect(layout(s, cells(rowText(noAccount)) - 1).digest).toBeNull()
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
    // The picker offers families, not dated ids: /model <alias> is the family's newest model.
    expect(modelFamily('claude-haiku-5-5')).toBe('haiku')
    expect(modelFamily('claude-opus-5-5[1m]')).toBe('opus')
    expect(modelOptions('claude-opus-5-5').map(o => o.label)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(modelOptions('claude-opus-5-5').map(o => o.hotkey)).toEqual(['f', 'o', 's', 'h'])
    expect(modelOptions('claude-opus-5-5').map(o => o.current)).toEqual([false, true, false, false])
    expect(modelOptions('claude-haiku-5-5').map(o => o.current)).toEqual([false, false, false, true])
    expect(modelOptions(null)).toHaveLength(4)
    expect(modelOptions(null).some(o => o.current)).toBe(false)
    // A pinned id leads as the current one and takes its letter; the alias it shadows goes without one.
    const pinned = modelOptions('claude-opus-5-5[1m]')
    expect(pinned[0]).toEqual({ value: 'claude-opus-5-5[1m]', label: 'opus-5-5[1m]', current: true, hotkey: 'o' })
    expect(pinned[2]).toEqual({ value: 'opus', label: 'opus', current: false })
    // A family outside the list leads the same way.
    expect(modelOptions('claude-zephyr-1-0')[0]).toEqual({ value: 'claude-zephyr-1-0', label: 'zephyr-1-0', current: true, hotkey: 'z' })
    // A hidden family is left out; letters are dealt after the filter, so each keeps its own.
    expect(modelOptions('claude-opus-5-5', ['fable']).map(o => [o.label, o.hotkey, o.current])).toEqual([
      ['opus', 'o', true],
      ['sonnet', 's', false],
      ['haiku', 'h', false],
    ])
    // The session's own family stays listed, marked current, even when hidden.
    expect(modelOptions('claude-fable-5-1', ['fable']).map(o => [o.label, o.current])).toEqual([
      ['fable', true],
      ['opus', false],
      ['sonnet', false],
      ['haiku', false],
    ])
    // A pinned id of a hidden family leads; the alias goes, so the id keeps `f` and nothing shadows it.
    expect(modelOptions('claude-fable-5-1[1m]', ['fable']).map(o => [o.label, o.hotkey])).toEqual([
      ['fable-5-1[1m]', 'f'],
      ['opus', 'o'],
      ['sonnet', 's'],
      ['haiku', 'h'],
    ])
    expect(modelOptions(null, ['fable', 'opus']).map(o => o.label)).toEqual(['sonnet', 'haiku'])
    expect(splitLabel('cache 42m')).toEqual(['cache', '42m'])
    expect(splitLabel('ELC-1591 3/5 ▶ Preview')).toEqual(['ELC-1591', '3/5 ▶ Preview'])
    expect(splitLabel('slim-mods')).toEqual(['slim-mods', ''])
  })

  test('cache, ctx and Compact survive 30 columns', () => {
    const narrow = layout({ ...full, account: 'personal', compact: { ...full.compact, plain: false } }, 30)
    expect(rowText(narrow)).toBe('cache 42m │ ctx 47% │ [ Compact ]')
    expect(narrow.account).toBeNull()
    expect(narrow.model).toBeNull()
    expect(narrow.rates).toEqual([])
    expect(narrow.cost).toBeNull()
    expect(narrow.digest).toBeNull()
    expect(narrow.resetsNowMs).toBeNull()
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

  test('fmtResetShort: the band row form', () => {
    expect(fmtResetShort(null, NOW)).toBeNull()
    expect(fmtResetShort('', NOW)).toBeNull()
    expect(fmtResetShort('not a date', NOW)).toBeNull()
    expect(fmtResetShort('2026-10-03T12:00:00Z', NOW)).toBe('0m')
    expect(fmtResetShort('2026-10-03T11:00:00Z', NOW)).toBe('0m')
    expect(fmtResetShort('2026-10-03T12:42:00Z', NOW)).toBe('42m')
    expect(fmtResetShort('2026-10-03T13:00:00Z', NOW)).toBe('1h00m')
    expect(fmtResetShort('2026-10-03T14:05:00Z', NOW)).toBe('2h05m')
    expect(fmtResetShort('2026-10-04T11:59:00Z', NOW)).toBe('23h59m')
    expect(fmtResetShort('2026-10-04T12:00:00Z', NOW)).toBe('1d0h')
    expect(fmtResetShort('2026-10-06T16:00:00Z', NOW)).toBe('3d4h')
  })

  test('rateText appends the reset time only when known', () => {
    const [r] = toRates([{ kind: 'five_hour', percentUsed: 14, resetsAt: '2026-10-03T14:05:00Z' }])
    expect(rateText(r!)).toBe('5h 14%')
    expect(rateText(r!, null)).toBe('5h 14%')
    expect(rateText(r!, fmtResetShort(r!.resetsAt, NOW))).toBe('5h 14% ↻2h05m')
  })

  test('groupResets: adjacent windows within 60 s of each other show one reset, after the last of them', () => {
    const W = '2026-10-06T16:00:00Z'
    const plus = (s: number) => new Date(Date.parse(W) + s * 1000).toISOString()
    const shorts = (list: { kind: string; percentUsed: number; resetsAt?: string }[]) => groupResets(toRates(list), NOW)
    // two equal resets, after a window with its own
    expect(shorts([
      { kind: 'five_hour', percentUsed: 61, resetsAt: '2026-10-03T14:05:00Z' },
      { kind: 'seven_day', percentUsed: 34, resetsAt: W },
      { kind: 'seven_day_fable', percentUsed: 12, resetsAt: W },
    ])).toEqual(['2h05m', null, '3d4h'])
    // three equal resets
    expect(shorts([
      { kind: 'seven_day', percentUsed: 34, resetsAt: W },
      { kind: 'seven_day_sonnet', percentUsed: 5, resetsAt: plus(30) },
      { kind: 'seven_day_fable', percentUsed: 12, resetsAt: W },
    ])).toEqual([null, null, '3d4h'])
    // the 60 s boundary: 59 s apart is one instant, 61 s apart is two
    expect(shorts([{ kind: 'seven_day', percentUsed: 1, resetsAt: W }, { kind: 'seven_day_fable', percentUsed: 2, resetsAt: plus(59) }])).toEqual([null, '3d4h'])
    expect(shorts([{ kind: 'seven_day', percentUsed: 1, resetsAt: W }, { kind: 'seven_day_fable', percentUsed: 2, resetsAt: plus(61) }])).toEqual(['3d4h', '3d4h'])
    // mixed order: equal resets that are not adjacent keep one each
    expect(shorts([
      { kind: 'seven_day', percentUsed: 34, resetsAt: W },
      { kind: 'five_hour', percentUsed: 61, resetsAt: '2026-10-03T14:05:00Z' },
      { kind: 'seven_day_fable', percentUsed: 12, resetsAt: W },
    ])).toEqual(['3d4h', '2h05m', '3d4h'])
    // no resets, a window without one beside one with one, no clock
    expect(shorts([{ kind: 'five_hour', percentUsed: 1 }, { kind: 'seven_day', percentUsed: 2 }])).toEqual([null, null])
    expect(shorts([{ kind: 'seven_day', percentUsed: 1, resetsAt: W }, { kind: 'seven_day_fable', percentUsed: 2 }])).toEqual(['3d4h', null])
    expect(shorts([{ kind: 'seven_day', percentUsed: 1, resetsAt: 'x' }, { kind: 'seven_day_fable', percentUsed: 2, resetsAt: 'x' }])).toEqual([null, null])
    expect(groupResets(toRates([{ kind: 'seven_day', percentUsed: 1, resetsAt: W }]), null)).toEqual([null])
    expect(groupResets([], NOW)).toEqual([])
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
    for (const g of Object.values(GLYPH)) expect([...g]).toHaveLength(1)
    expect(GLYPH.work).toBe('🏢')
    expect(GLYPH.personal).toBe('🏠')
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
      usage: { ...USAGE_INIT, ctxPct: 47, rates: toRates([{ kind: 'five_hour', percentUsed: 61, resetsAt: new Date(18 * MIN + 125 * MIN).toISOString() }]), costUsd: 0.4920822 },
      model: 'claude-fable-5-1',
      cache: { ...CACHE_INIT, anchorMs: 0, ttlMs: HOUR },
      nowMs: 18 * MIN,
      isWorking: false,
      digest: 'ELC-1591 3/5 ▶ Preview themes',
      hasChecklist: true,
      hasEvents: true,
    })
    expect(rowText(s)).toBe(
      'cache 42m │ fable-5-1 ▾ │ ctx 47% │ 5h 61% ↻2h05m │ cost $0.49 │ ELC-1591 3/5 ▶ Preview themes │ c: Compact  x: Clear  p: Progress  l: Log',
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

describe('account', () => {
  const RECORD = (oauthAccount: unknown) => ({ numStartups: 3, oauthAccount })

  test('classification: Team and Enterprise are work; Max, Pro, free and any other plan personal; no plan none', () => {
    for (const [plan, label] of [
      ['claude_team', 'work'],
      ['claude_enterprise', 'work'],
      ['claude_max', 'personal'],
      ['claude_pro', 'personal'],
      ['free', 'personal'],
      ['claude_something_new', 'personal'],
      [null, null],
    ] as const) {
      expect(accountLabel(plan)).toBe(label)
    }
  })

  test('loginAccount reads oauthAccount; its absence, a non-object, malformed fields → null or the field null', () => {
    expect(loginAccount(RECORD({ organizationType: 'claude_team', emailAddress: 'a@b.co', organizationName: 'Domaine Worldwide (2)', organizationRole: 'user', seatTier: 'x', displayName: 'A' }))).toEqual({
      plan: 'claude_team',
      email: 'a@b.co',
      org: 'Domaine Worldwide (2)',
      role: 'user',
    })
    expect(loginAccount(RECORD({ organizationType: 'claude_max', emailAddress: 7, organizationName: '', organizationRole: null }))).toEqual({ plan: 'claude_max', email: null, org: null, role: null })
    expect(loginAccount(RECORD({}))).toEqual({ plan: null, email: null, org: null, role: null })
    for (const bad of [null, 'x', [], {}, { oauthAccount: null }, { oauthAccount: 'claude_team' }, { oauthAccount: [] }]) expect(loginAccount(bad)).toBeNull()
    // one line, capped
    const long = loginAccount(RECORD({ organizationType: 'claude_team', organizationName: `Line\nbreak\t${'x'.repeat(300)}` }))
    expect(long?.org).toStartWith('Line break x')
    expect([...(long?.org ?? '')]).toHaveLength(120)
  })

  test('creditGate: the families of additionalModelOptionsCache the lattice flag bills to credits, hidden while extra usage is unusable; anything unknown hides nothing', () => {
    const GATED = [{ value: 'claude-fable-5-1[1m]', label: 'Fable', description: 'x' }]
    const lattice = (flag: unknown) => ({ cachedGrowthBookFeatures: { tengu_saffron_lattice: flag } })
    const BILLED = lattice({ enabled: true, planLimitsEndDate: '2026-07-20T07:00:00Z' })
    const team = { additionalModelOptionsCache: GATED, cachedExtraUsageDisabledReason: 'out_of_credits', oauthAccount: { organizationType: 'claude_team', hasExtraUsageEnabled: true }, modelAccessCache: [], ...BILLED }
    expect(creditGate(team)).toEqual({ hiddenModels: ['fable'], hiddenReason: 'out_of_credits' })
    expect(creditGate({ additionalModelOptionsCache: GATED, oauthAccount: { hasExtraUsageEnabled: false }, ...BILLED })).toEqual({ hiddenModels: ['fable'], hiddenReason: 'extra_usage_off' })
    // Ids without a [1m], aliases, several families: MODEL_ALIASES order, once each.
    expect(
      creditGate({ additionalModelOptionsCache: [{ value: 'opus' }, { value: 'claude-fable-5-1' }, { value: 'claude-fable-5-1[1m]' }], cachedExtraUsageDisabledReason: 'out_of_credits', ...BILLED }),
    ).toEqual({ hiddenModels: ['fable', 'opus'], hiddenReason: 'out_of_credits' })
    const none = { hiddenModels: [], hiddenReason: null }
    // Extra usage usable or unknown: nothing hidden.
    expect(creditGate({ ...team, cachedExtraUsageDisabledReason: null })).toEqual(none)
    expect(creditGate({ ...team, cachedExtraUsageDisabledReason: '' })).toEqual(none)
    expect(creditGate({ additionalModelOptionsCache: GATED })).toEqual(none)
    expect(creditGate({ additionalModelOptionsCache: GATED, cachedExtraUsageDisabledReason: 7, oauthAccount: { hasExtraUsageEnabled: 'false' } })).toEqual(none)
    // No gated model, a family outside the aliases, non-string values, a cache that is not a list.
    expect(creditGate({ ...team, additionalModelOptionsCache: [] })).toEqual(none)
    expect(creditGate({ ...team, additionalModelOptionsCache: [{ value: 'claude-zephyr-1-0' }] })).toEqual(none)
    expect(creditGate({ ...team, additionalModelOptionsCache: [{ value: 5 }, { label: 'Fable' }, null, 'claude-fable-5-1'] })).toEqual(none)
    expect(creditGate({ ...team, additionalModelOptionsCache: { value: 'claude-fable-5-1' } })).toEqual(none)
    // The plan includes the model (the Max record: plan-wide off), or its perModel entry is off: nothing hidden.
    const max = { additionalModelOptionsCache: GATED, cachedExtraUsageDisabledReason: 'org_level_disabled', oauthAccount: { organizationType: 'claude_max', hasExtraUsageEnabled: false } }
    expect(creditGate({ ...max, ...lattice({ enabled: false }) })).toEqual(none)
    expect(creditGate({ ...team, ...lattice({ enabled: false }) })).toEqual(none)
    expect(creditGate({ ...team, ...lattice({ enabled: true, planLimitsEndDate: 'x', perModel: { 'claude-fable-5-1[1m]': { enabled: false } } }) })).toEqual(none)
    // A perModel entry that bills the model beats a plan-wide off; overageConsentRequired bills it too.
    expect(creditGate({ ...team, ...lattice({ enabled: false, perModel: { 'claude-fable-5-1': { enabled: true } } }) })).toEqual({ hiddenModels: ['fable'], hiddenReason: 'out_of_credits' })
    expect(creditGate({ ...max, ...lattice({ overageConsentRequired: true }) })).toEqual({ hiddenModels: ['fable'], hiddenReason: 'org_level_disabled' })
    // No flag, or a malformed one: nothing hidden.
    for (const flags of [undefined, null, 'x', {}, { tengu_saffron_lattice: 'on' }]) expect(creditGate({ ...team, cachedGrowthBookFeatures: flags })).toEqual(none)
    expect(creditGate({ ...team, ...lattice({ enabled: true }) })).toEqual(none)
    // The personal record carries none of these keys.
    for (const bad of [undefined, null, 'x', [], {}, RECORD({ organizationType: 'claude_max' })]) expect(creditGate(bad)).toEqual(none)
  })

  test('profileAccount: account.email and organization.organization_type / name; neither plan nor email → null', () => {
    expect(profileAccount({ account: { email: 'a@b.co', uuid: 'u' }, organization: { organization_type: 'claude_enterprise', name: 'Acme' } })).toEqual({ plan: 'claude_enterprise', email: 'a@b.co', org: 'Acme', role: null })
    expect(profileAccount({ account: { email: 'a@b.co' } })).toEqual({ plan: null, email: 'a@b.co', org: null, role: null })
    for (const bad of [null, [], 'x', {}, { account: 'a', organization: 5 }, { organization: { name: 'Acme' } }]) expect(profileAccount(bad)).toBeNull()
  })

  test('accountMode: 0 off; work and personal force; unset or anything else on', () => {
    expect(accountMode('0')).toBe('off')
    expect(accountMode('work')).toBe('work')
    expect(accountMode(' Personal ')).toBe('personal')
    for (const v of [undefined, '', '1', 'yes', 'off', 'team']) expect(accountMode(v)).toBe('on')
  })

  test('loginPaths: CLAUDE_CONFIG_DIR wins, else HOME; ~ for HOME; empty counts as unset; other relative values never fall back to HOME', () => {
    expect(loginPaths('/Users/me', undefined)).toEqual({ file: '/Users/me/.claude.json', configDir: '~/.claude' })
    expect(loginPaths('/Users/me', '/Users/me/.claude-cloudcon/')).toEqual({ file: '/Users/me/.claude-cloudcon/.claude.json', configDir: '~/.claude-cloudcon' })
    expect(loginPaths('/Users/me', '/opt/claude')).toEqual({ file: '/opt/claude/.claude.json', configDir: '/opt/claude' })
    expect(loginPaths('/Users/me', '')).toEqual({ file: '/Users/me/.claude.json', configDir: '~/.claude' })
    expect(loginPaths('/Users/me', '~/.claude-x')).toEqual({ file: '/Users/me/.claude-x/.claude.json', configDir: '~/.claude-x' })
    expect(loginPaths('/Users/me', '~')).toEqual({ file: '/Users/me/.claude.json', configDir: '~' })
    expect(loginPaths(undefined, '~/.claude-x')).toEqual({ file: null, configDir: '~/.claude-x' })
    expect(loginPaths('/Users/me', '.claude-x')).toEqual({ file: null, configDir: '.claude-x' })
    expect(loginPaths('/Users/me', '~other/.claude')).toEqual({ file: null, configDir: '~other/.claude' })
    expect(loginPaths(undefined, undefined)).toEqual({ file: null, configDir: null })
    expect(loginPaths('relative', undefined)).toEqual({ file: null, configDir: null })
    expect(loginPaths(undefined, '/c')).toEqual({ file: '/c/.claude.json', configDir: '/c' })
  })

  test('the card: label with the plan, the facts present, config and source; a forced label says so', () => {
    expect(planName('claude_team')).toBe('Claude Team')
    expect(planName('free')).toBe('Free')
    expect(
      accountCard({ label: 'work', plan: 'claude_team', email: 'a@b.co', org: 'Domaine Worldwide (2)', role: 'user', configDir: '~/.claude-cloudcon', source: 'login record', hiddenModels: [], hiddenReason: null }),
    ).toBe('account: work (Claude Team) · email: a@b.co · org: Domaine Worldwide (2) · role: user · config: ~/.claude-cloudcon · source: login record')
    expect(accountCard({ label: 'personal', plan: 'claude_max', email: null, org: null, role: null, configDir: '~/.claude', source: 'profile endpoint', hiddenModels: [], hiddenReason: null })).toBe(
      'account: personal (Claude Max) · config: ~/.claude · source: profile endpoint',
    )
    expect(accountCard({ label: 'work', plan: null, email: null, org: null, role: null, configDir: null, source: 'BAND_ACCOUNT', hiddenModels: [], hiddenReason: null })).toBe(
      'account: work (forced by BAND_ACCOUNT) · source: BAND_ACCOUNT',
    )
    // A hidden family adds one models part.
    const gated = { label: 'work' as const, plan: 'claude_team', email: null, org: null, role: null, configDir: null, source: 'login record' as const, hiddenModels: ['fable'], hiddenReason: 'out_of_credits' }
    expect(accountCard(gated)).toBe('account: work (Claude Team) · models: opus, sonnet, haiku (fable needs credits) · source: login record')
    expect(accountCard({ ...gated, hiddenModels: ['fable', 'opus'] })).toBe('account: work (Claude Team) · models: sonnet, haiku (fable, opus need credits) · source: login record')
  })

  test('bandSegs takes the atom\'s label; absent or null → no segment', () => {
    const base = { usage: USAGE_INIT, model: null, cache: CACHE_INIT, nowMs: 0, isWorking: false, digest: null, hasChecklist: false, hasEvents: false }
    const work = { label: 'work' as const, plan: 'claude_team', email: null, org: null, role: null, configDir: null, source: 'login record' as const, hiddenModels: [], hiddenReason: null }
    expect(rowText(bandSegs({ ...base, account: work }))).toStartWith('work │ cache — │ ctx — │')
    expect(rowText(bandSegs({ ...base, account: { ...work, label: null } }))).toStartWith('cache — │')
    expect(rowText(bandSegs({ ...base, account: null }))).toStartWith('cache — │')
    expect(rowText(bandSegs(base))).toStartWith('cache — │')
  })
})

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
      'no task workspace — /base:save-task-context',
    ])
    expect(toChecklist({ ...SNAP, done: 0, total: 0, rows: [] })?.footer).toEqual(['no progress.md yet — /base:save-task-context', '- two', '- three'])
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
    expect(c?.footer).toEqual(['no progress.md yet — /base:save-task-context', '- ok'])
    expect(toChecklist({ workId: 'ELC-1', rows: 'x', notesTail: 'y' })).toEqual({ v: 1, title: 'ELC-1', rows: [], footer: ['no progress.md yet — /base:save-task-context'] })
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
