import { describe, expect } from 'claude-code/testing'
import { CRIT, cells, glyphText } from '../lib.ts'
import { KEPT, MIN, SNAP, SURFACES, T0, TASK, logged, mainTurn, measure, modelSwitch, peek, peekCache, postCompact, sibFnd, sibSlim, start, test, world } from './world.tsx'
import type { Surface } from './world.tsx'

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { bodyRows: 10 }, view: {} }

const mount = ($: any, surface: Surface, props: Partial<typeof BAND> = {}) =>
  $.ui.mount({ plugin: 'band', surface, component: 'AbovePrompt', props: { ...BAND, ...props } as any })

const nodes = (n: any): any[] =>
  n && typeof n === 'object' ? [n, ...(n.children ?? []).flatMap(nodes)] : []

/**
 * The band's readable units: a keyed `seg-*` Box reads as one string (dim label + bold value, its hover card
 * excluded; the card's own Text is a unit of its own), every other Text as itself. `node` is the value Text.
 */
type Unit = { text: string; node: any }
const strOf = (n: any): string => (n?.children ?? []).filter((c: any) => typeof c === 'string').join('')
const texts = (n: any, inCard = false): { node: any; inCard: boolean }[] => {
  if (!n || typeof n !== 'object') return []
  if (n.type === 'Text') return [{ node: n, inCard }]
  return (n.children ?? []).flatMap((c: any) => texts(c, inCard || n.props?.position === 'absolute'))
}
const units = (n: any): Unit[] => {
  if (!n || typeof n !== 'object') return []
  if (n.type === 'Box' && typeof n.props?.key === 'string' && n.props.key.startsWith('seg-')) {
    const all = texts(n)
    const own = all.filter(t => !t.inCard).map(t => t.node)
    const cards = all.filter(t => t.inCard).map(t => ({ text: strOf(t.node), node: t.node }))
    return [{ text: own.map(strOf).join(''), node: own[own.length - 1] }, ...cards]
  }
  if (n.type === 'Text') return [{ text: strOf(n), node: n }]
  return (n.children ?? []).flatMap(units)
}
const unitsOf = async (ui: any): Promise<Unit[]> => units(await ui.drawn())
const textOf = async (ui: any, re: RegExp) => (await unitsOf(ui)).find(u => re.test(u.text))?.text
const valueOf = async (ui: any, re: RegExp) => (await unitsOf(ui)).find(u => re.test(u.text))?.node
/** The model the band shows, short: the desktop's text, or the label of the terminal picker's folded button. */
const shownModel = async (ui: any, surface: Surface): Promise<string | undefined> => {
  if (surface === 'desktop') return (await textOf(ui, /^🤖 /))?.replace(/^🤖 /, '')
  return (await ui.find({ key: 'model' }))?.props.label?.replace(/ ▾$/, '')
}
/** The unfolded picker's model buttons, in row order; none while folded. */
const modelButtons = async (ui: any): Promise<any[]> =>
  nodes(await ui.drawn()).filter(n => n.type === 'Button' && String(n.props.key).startsWith('model:'))

describe('band', () => {
  for (const surface of SURFACES) {
    const isDesktop = surface === 'desktop'
    const cacheRe = isDesktop ? /^⏱ / : /^cache /
    const ctxRe = isDesktop ? /^🧠 / : /^ctx /
    const L = (text: string) => (isDesktop ? glyphText(text) : text)

    test(`${surface}: fresh with a task → cache —, ctx —, Compact first and pressable`, async ($, on) => {
      world(on, {}, TASK)
      await start($, surface)
      const ui = await mount($, surface)
      expect(await textOf(ui, cacheRe)).toBe(L('cache —'))
      expect(await textOf(ui, ctxRe)).toBe(L('ctx —'))
      const compact = await ui.find({ key: 'compact' })
      expect(compact?.props.label).toBe('Compact')
      expect(compact?.props.dimColor).toBeUndefined()
      expect(compact?.props.variant).toBeUndefined()
      const clear = await ui.find({ key: 'clear' })
      expect(clear?.props).toMatchObject({ label: 'Clear', dimColor: true })
      // A desktop draws a hotkey as a badge on its native button, so none is set there.
      expect(clear?.props.hotkey).toBe(isDesktop ? undefined : 'x')
      const progress = await ui.find({ key: 'progress' })
      expect(progress?.props).toMatchObject({ label: 'Progress', dimColor: true })
      expect(progress?.props.hotkey).toBe(isDesktop ? undefined : 'p')
      expect(progress?.props.plain).toBeUndefined()
      const log = await ui.find({ key: 'log' })
      expect(log?.props).toMatchObject({ label: 'Log', dimColor: true })
      expect(log?.props.hotkey).toBe(isDesktop ? undefined : 'l')
      expect(log?.props.plain).toBeUndefined()
      // On the terminal the model segment is a Button too, before the action buttons.
      const keys = nodes(await ui.drawn()).filter(n => n.type === 'Button').map(n => n.props.key)
      expect(keys).toEqual(isDesktop ? ['compact', 'clear', 'progress', 'log'] : ['model', 'compact', 'clear', 'progress', 'log'])
    })

    test(`${surface}: a rule above the row (terminal only); dim label, bold value; the cache hides in overage`, async ($, on) => {
      world(on)
      await start($, surface)
      const ui = await mount($, surface, { bodyColumns: 120 })
      await mainTurn($)
      await measure($, { window: 200_000, percent: 47 }, [{ kind: 'five_hour', percentUsed: 61 }])
      // The desktop frames its panel itself, so the band adds no rule there.
      expect(await textOf(ui, /^─+$/)).toBe(isDesktop ? undefined : '─'.repeat(120))
      const value = await valueOf(ui, cacheRe)
      expect(strOf(value)).toBe('60m')
      expect(value?.props).toMatchObject({ bold: true })
      const labelNode = (await unitsOf(ui)).length && texts(await ui.drawn()).map(t => t.node).find((n: any) => /^(cache|⏱) $/.test(strOf(n)))
      expect(labelNode?.props.dimColor).toBe(isDesktop ? undefined : true)
      await measure($, { window: 200_000, percent: 47 }, [{ kind: 'five_hour', percentUsed: 100 }])
      expect(await textOf(ui, cacheRe)).toBeUndefined()
      expect(await textOf(ui, ctxRe)).toBe(L('ctx 47%'))
      expect(await textOf(ui, /^5h /)).toBe('5h 100%')
    })

    test(`${surface}: a measurement redraws ctx and shows Compact`, async ($, on) => {
      world(on)
      await start($, surface)
      const ui = await mount($, surface)
      await measure($, { window: 200_000, percent: 47, tokens: 94_000 })
      expect(await textOf(ui, ctxRe)).toBe(L('ctx 47%'))
      expect(await ui.find({ key: 'compact' })).toBeDefined()
    })

    test(`${surface}: BAND_COST=1 → the cost sits between the rate windows and the digest, with its card; hidden at zero`, async ($, on) => {
      world(on, {}, { BAND_COST: '1', ...TASK })
      await start($, surface)
      const ui = await mount($, surface)
      const costRe = isDesktop ? /^💰 / : /^cost /
      await measure($, { window: 200_000, percent: 47 }, [{ kind: 'five_hour', percentUsed: 61 }], { usd: 0 })
      expect(await textOf(ui, costRe)).toBeUndefined()
      await measure($, { window: 200_000, percent: 47 }, [{ kind: 'five_hour', percentUsed: 61 }], { usd: 139.1386989 })
      expect(await textOf(ui, costRe)).toBe(L('cost $139.14'))
      expect((await valueOf(ui, costRe))?.props).toMatchObject({ bold: true })
      expect(await textOf(ui, /^session cost: /)).toBe('session cost: $139.14 at API prices, as /cost counts it (a subscription is not billed per request)')
      const order = (await unitsOf(ui)).map(u => u.text).filter(t => /^(5h \d|cost |💰 |📋 |ELC-1591)/.test(t))
      expect(order).toEqual(['5h 61%', L('cost $139.14'), isDesktop ? '📋 ELC-1591 3/5 ▶ Preview themes' : 'ELC-1591 3/5 ▶ Preview themes'])
    })

    test(`${surface}: 85 % → primary Compact and CRIT ctx; 50 % and 10 % → normal Compact`, async ($, on) => {
      world(on)
      await start($, surface)
      const ui = await mount($, surface)
      await measure($, { window: 200_000, percent: 85 })
      const loud = await ui.find({ key: 'compact' })
      expect(loud?.props.plain).toBeUndefined()
      expect(loud?.props.variant).toBe('primary')
      expect((await valueOf(ui, ctxRe))?.props).toMatchObject(CRIT)
      await measure($, { window: 200_000, percent: 50 })
      const quiet = await ui.find({ key: 'compact' })
      expect(quiet?.props.label).toBe('Compact')
      expect(quiet?.props.dimColor).toBeUndefined()
      expect(quiet?.props.hotkey).toBe(isDesktop ? undefined : 'c')
      expect(quiet?.props.variant).toBeUndefined()
      expect(quiet?.props.plain).toBeUndefined()
      expect((await valueOf(ui, ctxRe))?.props).toMatchObject({ color: 'warning', bold: true })
      await measure($, { window: 200_000, percent: 10 })
      expect((await valueOf(ui, ctxRe))?.props).toMatchObject({ color: 'success', bold: true })
      const low = await ui.find({ key: 'compact' })
      expect(low?.props.label).toBe('Compact')
      expect(low?.props.dimColor).toBeUndefined()
      expect(low?.props.variant).toBeUndefined()
    })

    test(`${surface}: hotkey letters only while the band holds the keyboard`, async ($, on) => {
      world(on, {}, TASK)
      await start($, surface)
      const ui = await mount($, surface)
      await measure($, { window: 200_000, percent: 50 })
      expect((await ui.find({ key: 'compact' }))?.props.plain).toBeUndefined()
      // The kit dispatches an op's input as the event unchanged, so the event's own shape is sent.
      const focusIn = { component: 'AbovePrompt', requestId: 'band', origin: { kind: 'person' } }
      const r = await $.ui.focus({ ...focusIn, element: 'compact' } as never)
      expect(r.deny).toBeUndefined()
      if (isDesktop) {
        // No letters on a desktop, and no redraw either: the focus-in before a click must not swallow the press.
        expect((await ui.find({ key: 'compact' }))?.props.label).toBe('Compact')
        expect((await ui.find({ key: 'compact' }))?.props.plain).toBeUndefined()
        return
      }
      expect((await ui.find({ key: 'compact' }))?.props).toMatchObject({ plain: true, hotkey: 'c' })
      expect((await ui.find({ key: 'clear' }))?.props).toMatchObject({ plain: true, hotkey: 'x' })
      expect((await ui.find({ key: 'progress' }))?.props).toMatchObject({ plain: true, hotkey: 'p' })
      expect((await ui.find({ key: 'log' }))?.props).toMatchObject({ plain: true, hotkey: 'l' })
      await $.turn.start({ text: 'hi', turnId: 't1' })
      expect((await ui.find({ key: 'compact' }))?.props.plain).toBeUndefined()
      expect((await ui.find({ key: 'compact' }))?.props.dimColor).toBeUndefined()
      await $.ui.focus({ ...focusIn, element: 'progress' } as never)
      expect((await ui.find({ key: 'progress' }))?.props.plain).toBe(true)
      await ui.press({ key: 'compact' })
      expect((await ui.find({ key: 'progress' }))?.props.plain).toBeUndefined()
      await $.ui.focus({ ...focusIn, element: 'model' } as never)
      expect((await ui.find({ key: 'model' }))?.props).toMatchObject({ plain: true, hotkey: 'm', label: 'fable-5-1 ▾' })
      // Unfolding keeps the keyboard on the band: the models take letters of their own; a pick lets go.
      await ui.press({ key: 'model' })
      expect((await modelButtons(ui)).map(b => b.props.hotkey)).toEqual(['f', 'o', 's', 'h'])
      await ui.press({ key: 'model:claude-fable-5-1' })
      expect((await ui.find({ key: 'progress' }))?.props.plain).toBeUndefined()
      expect((await ui.find({ key: 'model' }))?.props.hotkey).toBeUndefined()
    })

    test(`${surface}: isWorking keeps Compact first and pressable, no accent, and shows cache ●`, async ($, on) => {
      world(on)
      await start($, surface)
      await measure($, { window: 200_000, percent: 85 })
      const ui = await mount($, surface, { isWorking: true })
      const compact = await ui.find({ key: 'compact' })
      expect(compact?.props.dimColor).toBeUndefined()
      expect(compact?.props.variant).toBeUndefined()
      expect(nodes(await ui.drawn()).filter(n => n.type === 'Button' && n.props.key !== 'model').map(n => n.props.key)[0]).toBe('compact')
      expect(await textOf(ui, cacheRe)).toBe(L('cache ●'))
    })

    test(`${surface}: hasSurvey → the engine's band`, async ($, on) => {
      world(on)
      await start($, surface)
      const ui = await mount($, surface, { hasSurvey: true })
      expect(await textOf(ui, /engine band/)).toBe('engine band')
      expect(await ui.find({ key: 'progress' })).toBeUndefined()
    })

    test(`${surface}: disabled → the engine's band`, { options: { disabled: true } }, async ($, on) => {
      world(on)
      await start($, surface)
      await measure($, { window: 200_000, percent: 60 })
      const ui = await mount($, surface)
      expect(await textOf(ui, /engine band/)).toBe('engine band')
    })

    test(`${surface}: three rate windows → three segments in API order`, async ($, on) => {
      world(on)
      await start($, surface)
      const ui = await mount($, surface)
      await measure($, { window: 200_000, percent: 10 }, [
        { kind: 'five_hour', percentUsed: 61 },
        { kind: 'seven_day', percentUsed: 34 },
        { kind: 'seven_day_fable', percentUsed: 12 },
      ])
      const rates = (await unitsOf(ui)).filter(u => /^(5h|7d|7d·fable) \d+%$/.test(u.text))
      expect(rates.map(u => u.text)).toEqual(['5h 61%', '7d 34%', '7d·fable 12%'])
      expect(rates[0].node.props).toMatchObject({ color: 'warning', bold: true })
    })

    test(`${surface}: main turn + 18 min with a 1 h TTL → 42m; +59 → CRIT; +61 → cold`, { options: { cacheTtl: '1h' } }, async ($, on) => {
      const { clock } = world(on)
      await start($, surface)
      const ui = await mount($, surface)
      await mainTurn($)
      await clock.advance(18 * MIN)
      expect(await textOf(ui, cacheRe)).toBe(L('cache 42m'))
      expect((await valueOf(ui, cacheRe))?.props.color).toBeUndefined()
      await clock.advance(41 * MIN)
      const crit = (await unitsOf(ui)).find(u => cacheRe.test(u.text))
      expect(crit?.text).toBe(L('cache 1m'))
      expect(crit?.node.props).toMatchObject(CRIT)
      await clock.advance(2 * MIN)
      expect(await textOf(ui, cacheRe)).toBe(L('cache cold'))
    })

    test(`${surface}: a subagent turn does not move the anchor`, async ($, on) => {
      world(on)
      await start($, surface)
      const ui = await mount($, surface)
      await mainTurn($, 'agent-1')
      expect(await textOf(ui, cacheRe)).toBe(L('cache —'))
    })

    test(`${surface}: session.compact manual → cold and ctx from tokensAfter; precompute and skip → no change`, async ($, on) => {
      const { w, clock } = world(on)
      await start($, surface)
      const ui = await mount($, surface)
      await mainTurn($)
      await measure($, { window: 200_000, percent: 47 })
      await $.session.compact({ trigger: 'precompute', messages: KEPT } as any)
      expect(await textOf(ui, cacheRe)).toBe(L('cache 60m'))
      expect(await textOf(ui, ctxRe)).toBe(L('ctx 47%'))
      w.compact = async () => ({ skip: 'blocked by PreCompact' })
      await $.session.compact({ trigger: 'manual', messages: KEPT } as any)
      expect(await textOf(ui, cacheRe)).toBe(L('cache 60m'))
      expect(await textOf(ui, ctxRe)).toBe(L('ctx 47%'))
      w.compact = async () => ({ messages: KEPT, tokensBefore: 94_000, tokensAfter: 26_300 })
      await $.session.compact({ trigger: 'manual', messages: KEPT } as any)
      expect(await textOf(ui, cacheRe)).toBe(L('cache cold'))
      expect(await textOf(ui, ctxRe)).toBe(L('ctx 13%'))
      expect((await ui.find({ key: 'compact' }))?.props.variant).toBeUndefined()
      await clock.advance(MIN)
      w.compact = async () => ({ messages: KEPT })
      await $.session.compact({ trigger: 'auto', messages: KEPT } as any)
      expect(await textOf(ui, ctxRe)).toBe(L('ctx —'))
    })

    test(`${surface}: classic.PostCompact alone → cold and ctx —; with the session.compact chain in either order it is one compaction`, async ($, on) => {
      const { w, clock } = world(on)
      on('classic.PostCompact', async () => ({}) as never)
      await start($, surface)
      const ui = await mount($, surface)
      await mainTurn($)
      await measure($, { window: 200_000, percent: 47 })
      await $.classic.PostCompact(postCompact({ trigger: 'auto', agent_id: 'a1' }))
      expect(await textOf(ui, cacheRe)).toBe(L('cache 60m'))
      expect(await textOf(ui, ctxRe)).toBe(L('ctx 47%'))
      await $.classic.PostCompact(postCompact({ trigger: 'manual' }))
      expect(await textOf(ui, cacheRe)).toBe(L('cache cold'))
      expect(await textOf(ui, ctxRe)).toBe(L('ctx —'))
      // The chain's report of the same compaction refines the context and logs nothing more.
      w.compact = async () => ({ messages: KEPT, tokensBefore: 94_000, tokensAfter: 26_300 })
      await $.session.compact({ trigger: 'manual', messages: KEPT } as any)
      expect(await textOf(ui, ctxRe)).toBe(L('ctx 13%'))
      // Chain first, classic second: the count stays.
      await clock.advance(MIN)
      await mainTurn($)
      await measure($, { window: 200_000, percent: 60 })
      expect(await textOf(ui, cacheRe)).toBe(L('cache 60m'))
      await $.session.compact({ trigger: 'auto', messages: KEPT } as any)
      await $.classic.PostCompact(postCompact({ trigger: 'auto' }))
      expect(await textOf(ui, cacheRe)).toBe(L('cache cold'))
      expect(await textOf(ui, ctxRe)).toBe(L('ctx 13%'))
      expect(await logged($)).toEqual(['session start · band 9.9.9', 'compact manual', 'compact auto 94k → 26k'])
    })

    test(`${surface}: a window-only measure or tick after a compaction keeps its count; a measured fill replaces it`, async ($, on) => {
      const { w, clock } = world(on)
      await start($, surface)
      const ui = await mount($, surface)
      await measure($, { window: 200_000, percent: 47 })
      w.compact = async () => ({ messages: KEPT, tokensBefore: 94_000, tokensAfter: 26_300 })
      await $.session.compact({ trigger: 'manual', messages: KEPT } as any)
      expect(await textOf(ui, ctxRe)).toBe(L('ctx 13%'))
      await measure($, { window: 200_000 })
      expect(await textOf(ui, ctxRe)).toBe(L('ctx 13%'))
      w.context = { window: 200_000 }
      await clock.advance(MIN)
      expect(await textOf(ui, ctxRe)).toBe(L('ctx 13%'))
      await measure($, { window: 200_000, percent: 15 })
      expect(await textOf(ui, ctxRe)).toBe(L('ctx 15%'))
    })

    test(`${surface}: after /clear a window-only measure leaves ctx —`, async ($, on) => {
      world(on)
      await start($, surface)
      const ui = await mount($, surface)
      await mainTurn($)
      await measure($, { window: 200_000, percent: 85 })
      await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as any)
      await measure($, { window: 200_000 })
      expect(await textOf(ui, ctxRe)).toBe(L('ctx —'))
    })

    test(`${surface}: a seed with no model → the first measure fills the model segment`, async ($, on) => {
      const { w } = world(on)
      w.model = null
      await start($, surface)
      const ui = await mount($, surface)
      await mainTurn($)
      expect(await shownModel(ui, surface)).toBeUndefined()
      w.model = 'claude-fable-5-1'
      await measure($, { window: 200_000, percent: 11 })
      expect(await shownModel(ui, surface)).toBe('fable-5-1')
    })

    test(`${surface}: the model segment unfolds into a row of models on the terminal, text on the desktop`, async ($, on) => {
      const { w } = world(on)
      const runs: string[] = []
      on('command.run', { command: 'model' }, async (_$, e) => {
        runs.push(e.args)
        return { text: `Set model to ${e.args}` }
      })
      await start($, surface)
      const ui = await mount($, surface)
      await mainTurn($)
      const btn = await ui.find({ key: 'model' })
      if (isDesktop) {
        expect(btn).toBeUndefined()
        expect(await textOf(ui, /^🤖 /)).toBe('🤖 fable-5-1')
        return
      }
      expect(btn?.type).toBe('Button')
      expect(btn?.props).toMatchObject({ label: 'fable-5-1 ▾', plain: true })
      expect(btn?.props.hotkey).toBeUndefined()
      await ui.press({ key: 'model' })
      // Unfolded: the band stays two rows and the row holds the models alone, the current at full strength.
      expect(await ui.find({ key: 'model' })).toBeUndefined()
      expect(await textOf(ui, /ctx/)).toBeUndefined()
      expect(await ui.find({ key: 'compact' })).toBeUndefined()
      expect(nodes(await ui.drawn()).filter(n => n.type === 'Text' && /^─+$/.test(strOf(n)))).toHaveLength(1)
      const opts = await modelButtons(ui)
      expect(opts.map(b => b.props.label)).toEqual(['fable-5-1', 'opus-5-5', 'sonnet-5-5', 'haiku-4-5-20251001'])
      expect(opts.map(b => b.props.dimColor)).toEqual([undefined, true, true, true])
      expect(opts.every(b => b.props.plain === true && b.props.hotkey === undefined)).toBe(true)
      await ui.press({ key: 'model:claude-opus-5-5' })
      expect(runs).toEqual(['claude-opus-5-5'])
      expect(w.toasts).toEqual(['Set model to claude-opus-5-5'])
      // Folded again; the segment moves with the switch event, not the press.
      expect(await modelButtons(ui)).toHaveLength(0)
      expect(await shownModel(ui, surface)).toBe('fable-5-1')
      expect(await textOf(ui, /ctx/)).toBeDefined()
      // The current model only folds: no /model run.
      await ui.press({ key: 'model' })
      await ui.press({ key: 'model:claude-fable-5-1' })
      expect(runs).toEqual(['claude-opus-5-5'])
      expect(await shownModel(ui, surface)).toBe('fable-5-1')
    })

    test(`${surface}: a pinned id the picker does not list leads its row; a refused /model toasts`, async ($, on) => {
      const { w } = world(on)
      w.model = 'claude-opus-5-5[1m]'
      // No command.run hook beneath: the engine rejects the run, as it does an unknown command.
      await start($, surface)
      const ui = await mount($, surface)
      await mainTurn($)
      expect(await shownModel(ui, surface)).toBe('opus-5-5[1m]')
      if (isDesktop) return
      await ui.press({ key: 'model' })
      const opts = await modelButtons(ui)
      expect(opts).toHaveLength(5)
      expect(opts[0].props).toMatchObject({ key: 'model:claude-opus-5-5[1m]', label: 'opus-5-5[1m]' })
      expect(opts[0].props.dimColor).toBeUndefined()
      await ui.press({ key: 'model:claude-sonnet-5-5' })
      expect(w.toasts).toHaveLength(1)
      expect(w.toasts[0]).toStartWith('model refused: ')
      expect(await modelButtons(ui)).toHaveLength(0)
    })

    test(`${surface}: a turn and /clear fold the picker`, async ($, on) => {
      world(on)
      await start($, surface)
      const ui = await mount($, surface)
      await mainTurn($)
      if (isDesktop) return
      await ui.press({ key: 'model' })
      expect(await modelButtons(ui)).toHaveLength(4)
      await $.turn.start({ text: 'hi', turnId: 't1' })
      expect(await modelButtons(ui)).toHaveLength(0)
      expect(await shownModel(ui, surface)).toBe('fable-5-1')
      await ui.press({ key: 'model' })
      expect(await modelButtons(ui)).toHaveLength(4)
      await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as any)
      expect(await modelButtons(ui)).toHaveLength(0)
    })

    test(`${surface}: a subagent compaction leaves the main figures`, async ($, on) => {
      world(on)
      await start($, surface)
      const ui = await mount($, surface)
      await mainTurn($)
      await $.session.compact({ trigger: 'auto', agentId: 'agent-1', messages: KEPT } as any)
      expect(await textOf(ui, cacheRe)).toBe(L('cache 60m'))
    })

    for (const reason of ['clear', 'resume'] as const) {
      test(`${surface}: session.end ${reason} → cache —, ctx —, Compact loses its accent`, async ($, on) => {
        world(on)
        await start($, surface)
        const ui = await mount($, surface)
        await mainTurn($)
        await measure($, { window: 200_000, percent: 85 })
        await $.session.end({ reason, sessionId: 's1', resume: {} } as any)
        expect(await textOf(ui, cacheRe)).toBe(L('cache —'))
        expect(await textOf(ui, ctxRe)).toBe(L('ctx —'))
        const compact = await ui.find({ key: 'compact' })
        expect(compact?.props.label).toBe('Compact')
        expect(compact?.props.variant).toBeUndefined()
      })
    }

    test(`${surface}: a model switch → the model segment follows and the cache goes cold`, async ($, on) => {
      const { w } = world(on)
      on('classic.PostModelSwitch', async () => ({}) as never)
      await start($, surface)
      const ui = await mount($, surface)
      await mainTurn($)
      expect(await shownModel(ui, surface)).toBe('fable-5-1')
      w.model = 'claude-opus-5-5'
      await $.classic.PostModelSwitch(modelSwitch({ prompt_cache_warm: true }))
      expect(await shownModel(ui, surface)).toBe('opus-5-5')
      expect(await textOf(ui, cacheRe)).toBe(L('cache cold'))
    })

    test(`${surface}: a switch takes the event's to_model while session.model() still lags`, async ($, on) => {
      world(on)
      on('classic.PostModelSwitch', async () => ({}) as never)
      await start($, surface)
      const ui = await mount($, surface)
      await mainTurn($)
      await $.classic.PostModelSwitch(modelSwitch({ source: 'picker' }))
      expect(await shownModel(ui, surface)).toBe('opus-5-5')
    })

    test(`${surface}: a measure adopts a model the session changed without a PostModelSwitch`, async ($, on) => {
      const { w } = world(on)
      await start($, surface)
      const ui = await mount($, surface)
      await mainTurn($)
      expect(await shownModel(ui, surface)).toBe('fable-5-1')
      w.model = 'claude-opus-5-5'
      await measure($, { window: 200_000, percent: 12 })
      expect(await shownModel(ui, surface)).toBe('opus-5-5')
    })

    test(`${surface}: a cold switch to the same model → cache cold`, async ($, on) => {
      world(on)
      on('classic.PostModelSwitch', async () => ({}) as never)
      await start($, surface)
      const ui = await mount($, surface)
      await mainTurn($)
      await $.classic.PostModelSwitch(modelSwitch({ to_model: 'claude-fable-5-1', prompt_cache_warm: false }))
      expect(await textOf(ui, cacheRe)).toBe(L('cache cold'))
    })

    test(`${surface}: a warm same-model switch and a resume restore keep the countdown`, async ($, on) => {
      world(on)
      on('classic.PostModelSwitch', async () => ({}) as never)
      await start($, surface)
      const ui = await mount($, surface)
      await mainTurn($)
      await $.classic.PostModelSwitch(modelSwitch({ to_model: 'claude-fable-5-1', cache_ttl: '5m' }))
      expect(await textOf(ui, cacheRe)).toBe(L('cache 5m'))
      await $.classic.PostModelSwitch(modelSwitch({ source: 'resume', cache_ttl: '5m', prompt_cache_warm: false }))
      expect(await textOf(ui, cacheRe)).toBe(L('cache 5m'))
    })

    for (const source of ['resume', 'fork'] as const) {
      test(`${surface}: classic.SessionStart ${source} seeds the anchor`, { options: { cacheTtl: '1h' } }, async ($, on) => {
        world(on)
        on('classic.SessionStart', async () => ({}) as never)
        await start($, surface)
        const ui = await mount($, surface)
        await $.classic.SessionStart({ source, seconds_since_last_response: 600 } as any)
        expect((await peekCache($)).anchorMs).toBe(T0 - 10 * MIN)
        expect(await textOf(ui, cacheRe)).toBe(L('cache 50m'))
        await $.classic.SessionStart({ source, seconds_since_last_response: 600, prompt_cache_likely_expired: true } as any)
        expect(await textOf(ui, cacheRe)).toBe(L('cache cold'))
      })
    }

    test(`${surface}: Compact press: skip, refusal and tokens each toast`, async ($, on) => {
      const { w } = world(on)
      await start($, surface)
      await measure($, { window: 200_000, percent: 60 })
      const ui = await mount($, surface)
      w.compact = async () => ({ skip: 'turn running' })
      await ui.press({ key: 'compact' })
      w.compact = async () => {
        throw new Error('busy')
      }
      await ui.press({ key: 'compact' })
      w.compact = async () => ({ messages: KEPT, tokensBefore: 150_000, tokensAfter: 20_000 })
      await ui.press({ key: 'compact' })
      expect(w.toasts[0]).toBe('compact skipped: turn running')
      expect(w.toasts[1]).toMatch(/^compact refused: \S/)
      expect(w.toasts[2]).toBe('compacted 150,000 → 20,000 tokens')
      expect(w.toasts).toHaveLength(3)
    })

    test(`${surface}: Compact press in a headless session falls back to /compact; its refusal toasts`, async ($, on) => {
      const { w } = world(on)
      const runs: string[] = []
      let fails = false
      on('command.run', { command: 'compact' }, async (_$, e) => {
        runs.push(e.args)
        if (fails) throw new Error('compact unavailable')
        return { text: 'Compacted (ctrl+o to see full summary)' }
      })
      await start($, surface)
      await measure($, { window: 200_000, percent: 60 })
      const ui = await mount($, surface)
      w.compact = async () => {
        throw new Error('$.session.compact: not available in a headless (-p / SDK) session yet')
      }
      await ui.press({ key: 'compact' })
      expect(runs).toEqual([''])
      expect(w.toasts).toEqual(['Compacted (ctrl+o to see full summary)'])
      fails = true
      await ui.press({ key: 'compact' })
      expect(runs).toHaveLength(2)
      expect(w.toasts[1]).toMatch(/^compact refused: \S/)
      expect(w.toasts[1]).not.toContain('headless')
      expect(w.toasts).toHaveLength(2)
    })

    test(`${surface}: Compact pressed during a main turn only toasts; a subagent turn's end keeps it; the main end re-arms it`, async ($, on) => {
      const { w } = world(on)
      let calls = 0
      w.compact = async () => {
        calls++
        return { messages: KEPT, tokensBefore: 90_000, tokensAfter: 10_000 }
      }
      await start($, surface)
      await measure($, { window: 200_000, percent: 45 })
      const ui = await mount($, surface)
      await $.turn.start({ text: 'hi', turnId: 't' })
      await ui.press({ key: 'compact' })
      await mainTurn($, 'agent-1')
      await ui.press({ key: 'compact' })
      expect(calls).toBe(0)
      await mainTurn($)
      await ui.press({ key: 'compact' })
      expect(calls).toBe(1)
      const busy = 'turn is running — press Compact again when it ends'
      expect(w.toasts).toEqual([busy, busy, 'compacted 90,000 → 10,000 tokens'])
    })

    test(`${surface}: a draw with isWorking false clears a flag stuck by a missed turn.complete`, async ($, on) => {
      const { w } = world(on)
      let calls = 0
      w.compact = async () => {
        calls++
        return { messages: KEPT, tokensBefore: 90_000, tokensAfter: 10_000 }
      }
      await start($, surface)
      await measure($, { window: 200_000, percent: 45 })
      await $.turn.start({ text: 'hi', turnId: 't' })
      const ui = await mount($, surface, { isWorking: false })
      await ui.press({ key: 'compact' })
      expect(calls).toBe(1)
      expect(w.toasts).toEqual(['compacted 90,000 → 10,000 tokens'])
    })

    test(`${surface}: a draw with isWorking true and no turn.start seen (a reload mid-turn) → the busy toast`, async ($, on) => {
      const { w } = world(on)
      let calls = 0
      w.compact = async () => {
        calls++
        return { messages: KEPT }
      }
      await start($, surface)
      await measure($, { window: 200_000, percent: 45 })
      const ui = await mount($, surface, { isWorking: true })
      await ui.press({ key: 'compact' })
      expect(calls).toBe(0)
      expect(w.toasts).toEqual(['turn is running — press Compact again when it ends'])
    })

    test(`${surface}: Clear press asks Yes/No first; only Yes runs /clear`, async ($, on) => {
      const { w } = world(on)
      const asked: { question: string; options: string[] }[] = []
      let answer: string | null = 'No'
      on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e: any) => {
        const q = e.questions[0]
        asked.push({ question: q.question, options: q.options.map((o: any) => o.label) })
        if (answer === null) throw new Error('dismissed')
        return { result: { questions: e.questions, answers: { [q.question]: answer } } } as any
      })
      const runs: string[] = []
      on('command.run', { command: 'clear' }, async () => {
        runs.push('clear')
        return { text: 'cleared' }
      })
      await start($, surface)
      await measure($, { window: 200_000, percent: 60 })
      const ui = await mount($, surface)
      await ui.press({ key: 'clear' })
      expect(asked).toEqual([{ question: 'Clear the conversation?', options: ['Yes', 'No'] }])
      expect(runs).toEqual([])
      answer = null
      await ui.press({ key: 'clear' })
      expect(runs).toEqual([])
      expect(w.toasts).toEqual([])
      answer = 'Yes'
      await ui.press({ key: 'clear' })
      expect(asked).toHaveLength(3)
      expect(runs).toEqual(['clear'])
      expect(w.toasts).toEqual(['cleared'])
    })

    test(`${surface}: Clear pressed during a turn only toasts; a refused /clear toasts`, async ($, on) => {
      const { w } = world(on)
      let asks = 0
      on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e: any) => {
        asks++
        return { result: { questions: e.questions, answers: { [e.questions[0].question]: 'Yes' } } } as any
      })
      on('command.run', { command: 'clear' }, async () => {
        throw new Error('clear unavailable')
      })
      await start($, surface)
      await measure($, { window: 200_000, percent: 60 })
      const ui = await mount($, surface)
      await $.turn.start({ text: 'hi', turnId: 't' })
      await ui.press({ key: 'clear' })
      expect(asks).toBe(0)
      expect(w.toasts).toEqual(['turn is running — press Clear again when it ends'])
      await mainTurn($)
      await ui.press({ key: 'clear' })
      expect(asks).toBe(1)
      expect(w.toasts[1]).toMatch(/^clear refused: \S/)
      expect(w.toasts).toHaveLength(2)
    })

    test(`${surface}: a Compact press at 10 % still runs /compact`, async ($, on) => {
      const { w } = world(on)
      let calls = 0
      w.compact = async () => {
        calls++
        return { messages: KEPT, tokensBefore: 20_000, tokensAfter: 8_000 }
      }
      await start($, surface)
      await measure($, { window: 200_000, percent: 10 })
      const ui = await mount($, surface)
      await ui.press({ key: 'compact' })
      expect(calls).toBe(1)
      expect(w.toasts).toEqual(['compacted 20,000 → 8,000 tokens'])
    })

    test(`${surface}: a desktop draws the buttons on their own row under the figures; the terminal keeps one row`, async ($, on) => {
      world(on, {}, TASK)
      await start($, surface)
      await measure($, { window: 200_000, percent: 47 }, [{ kind: 'five_hour', percentUsed: 61 }])
      const ui = await mount($, surface)
      const drawn = await ui.drawn()
      const rows = nodes(drawn).filter(n => n.type === 'Box' && n.props?.flexDirection === 'row' && nodes(n).some(c => c.type === 'Button'))
      const buttonRow = rows[rows.length - 1]
      const buttonKeys = (buttonRow.children ?? []).filter((c: any) => c?.type === 'Button').map((c: any) => c.props.key)
      // The terminal's one row carries the model Button among the figures, before the action buttons.
      expect(buttonKeys).toEqual(isDesktop ? ['compact', 'clear', 'progress', 'log'] : ['model', 'compact', 'clear', 'progress', 'log'])
      if (isDesktop) {
        // A column of two rows: the figures, then the buttons alone, with no separator before Compact.
        expect(drawn.props).toMatchObject({ flexDirection: 'column', gap: 1, padding: 1 })
        expect(drawn.children).toHaveLength(2)
        expect(drawn.children[1]).toBe(buttonRow)
        expect(nodes(buttonRow).some(n => n.type === 'Text' && /│/.test(strOf(n)))).toBe(false)
        expect(nodes(drawn.children[0]).some(n => n.type === 'Button')).toBe(false)
        return
      }
      // One row: `cache — │ fable-5-1 │ ctx 47% │ 5h 61% │ ELC-1591 … │ [ Compact ] …`, the buttons after the last separator.
      expect(nodes(buttonRow).some(n => n.type === 'Text' && /ctx/.test(strOf(n)))).toBe(true)
      expect(nodes(buttonRow).filter(n => n.type === 'Text' && /│/.test(strOf(n)))).toHaveLength(5)
    })

    test(`${surface}: keyed hover Boxes with hidden, card-wide cards`, async ($, on) => {
      world(on)
      await start($, surface)
      await mainTurn($)
      const ui = await mount($, surface)
      await measure($, { window: 200_000, percent: 47, tokens: 94_000 }, [{ kind: 'five_hour', percentUsed: 61 }])
      for (const key of ['seg-cache', 'seg-ctx', 'seg-rate-five_hour']) {
        expect(await ui.find({ type: 'Box', key })).toBeDefined()
      }
      // `hover` is carried beside the props in the drawn tree, so the cards are read from it.
      const cards = nodes(await ui.drawn()).filter(n => n.props?.display === 'none')
      expect(cards).toHaveLength(3)
      // The terminal clips an absolute card to its segment's columns, so there it rises onto the rule row above.
      const top = surface === 'desktop' ? 0 : -1
      for (const card of cards) expect(card).toMatchObject({ props: { position: 'absolute', top }, hover: { display: 'flex' } })
      // No overflow="hidden" on the row: it would clip that risen card.
      for (const n of nodes(await ui.drawn())) expect(n.props?.overflow).not.toBe('hidden')
      const cacheCard = 'prompt cache: ~60 min left (estimate: last response + 1 h TTL)'
      expect(await textOf(ui, /^prompt cache: /)).toBe(cacheCard)
      expect(await textOf(ui, /^context: /)).toBe('context: 47% of 200,000 tokens, 94,000 used')
      expect(await textOf(ui, /^5h window: /)).toBe('5h window: 61% used')
      expect(cards.map(c => c.props.width)).toContain(cells(cacheCard))
    })

    test(`${surface}: a narrow band keeps cache, ctx and Compact; a desktop drops nothing`, async ($, on) => {
      world(on, {}, TASK)
      await start($, surface)
      await measure($, { window: 200_000, percent: 60 }, [{ kind: 'five_hour', percentUsed: 61 }])
      const ui = await mount($, surface, { bodyColumns: 30 })
      expect(await textOf(ui, cacheRe)).toBe(L('cache —'))
      expect(await textOf(ui, ctxRe)).toBe(L('ctx 60%'))
      expect(await ui.find({ key: 'compact' })).toBeDefined()
      if (isDesktop) {
        // Proportional text: bodyColumns do not measure the row, so the width model stays out of it.
        expect(await textOf(ui, /^🤖 /)).toBe('🤖 fable-5-1')
        expect(await textOf(ui, /^5h /)).toBe('5h 61%')
        expect(await textOf(ui, /^📋 /)).toBe('📋 ELC-1591 3/5 ▶ Preview themes')
        expect(await ui.find({ key: 'clear' })).toBeDefined()
        expect(await ui.find({ key: 'progress' })).toBeDefined()
        expect(await ui.find({ key: 'log' })).toBeDefined()
        return
      }
      expect(await textOf(ui, /^5h|^⏳|ELC-1591/)).toBeUndefined()
      expect(await shownModel(ui, surface)).toBeUndefined()
      expect(await ui.find({ key: 'clear' })).toBeUndefined()
      expect(await ui.find({ key: 'progress' })).toBeUndefined()
      expect(await ui.find({ key: 'log' })).toBeUndefined()
    })

    test(`${surface}: Log drops first, then Clear, before the model`, async ($, on) => {
      world(on, {}, TASK)
      await start($, surface)
      await measure($, { window: 200_000, percent: 60 })
      // `cache — │ fable-5-1 ▾ │ ctx 60% │ ELC-1591 3/5 ▶ Preview themes │ c: Compact  x: Clear  p: Progress  l: Log` is 107
      // cells; without Log 99, without Clear too 89.
      const wide = await mount($, surface, { bodyColumns: 100 })
      expect(await wide.find({ key: 'clear' })).toBeDefined()
      if (isDesktop) expect(await wide.find({ key: 'log' })).toBeDefined()
      else expect(await wide.find({ key: 'log' })).toBeUndefined()
      const ui = await mount($, surface, { bodyColumns: 90 })
      expect(await ui.find({ key: 'compact' })).toBeDefined()
      expect(await ui.find({ key: 'progress' })).toBeDefined()
      expect(await shownModel(ui, surface)).toBe('fable-5-1')
      if (isDesktop) {
        expect(await ui.find({ key: 'clear' })).toBeDefined()
        expect(await ui.find({ key: 'log' })).toBeDefined()
        return
      }
      expect(await ui.find({ key: 'clear' })).toBeUndefined()
      expect(await ui.find({ key: 'log' })).toBeUndefined()
    })

    test(`${surface}: the digest hides while the pane is shown and returns when it closes`, async ($, on) => {
      world(on, {}, TASK)
      await start($, surface)
      await measure($, { window: 200_000, percent: 47 }, [{ kind: 'five_hour', percentUsed: 61 }])
      const ui = await mount($, surface)
      const digest = isDesktop ? '📋 ELC-1591 3/5 ▶ Preview themes' : 'ELC-1591 3/5 ▶ Preview themes'
      const digestRe = /ELC-1591/
      const others = async () => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).filter((t: string) => t !== digest)
      expect(await textOf(ui, digestRe)).toBe(digest)
      const before = await others()
      await ui.press({ key: 'progress' })
      expect(await textOf(ui, digestRe)).toBeUndefined()
      // The test $ has no ui.close: the second press closes it through the plugin (origin plugin).
      await ui.press({ key: 'progress' })
      expect(await textOf(ui, digestRe)).toBe(digest)
      expect(await others()).toEqual(before)
    })
  }

  test('desktop labels are glyphs; the terminal keeps the words', async ($, on) => {
    world(on)
    await start($, 'desktop')
    await mainTurn($)
    await measure($, { window: 200_000, percent: 47 }, [{ kind: 'five_hour', percentUsed: 61 }])
    const desk = await mount($, 'desktop')
    expect(await textOf(desk, /^⏱ /)).toBe('⏱ 60m')
    expect(await textOf(desk, /^🧠 /)).toBe('🧠 47%')
    expect(await textOf(desk, /^⏳/)).toBe('⏳ ')
    expect(await textOf(desk, /^🤖 /)).toBe('🤖 fable-5-1')
    const term = await mount($, 'terminal')
    expect(await textOf(term, /^cache /)).toBe('cache 60m')
    expect(await shownModel(term, 'terminal')).toBe('fable-5-1')
    expect(await term.find({ type: 'Text', text: /^[⏱🧠⏳🤖📋]/u })).toBeUndefined()
  })

  test('/band-debug prints the raw usage, the atoms, the info, the task and the last render', async ($, on) => {
    const { w } = world(on, {}, TASK)
    w.rateLimits = [{ kind: 'five_hour', percentUsed: 61 }]
    await start($, 'desktop')
    await mount($, 'desktop', { bodyColumns: 77 })
    const { text } = await $.command.run({ command: 'band-debug', args: '' })
    expect(text).toStartWith('band debug\n')
    expect(text).toMatch(/^info: \{"v":1,"version":"[^"]+","disabled":false\}$/m)
    expect(text).toContain('usage(): {"startedAt":')
    expect(text).toContain('"rateLimits":[{"kind":"five_hour","percentUsed":61}]')
    expect(text).toContain('"costUsd":null')
    expect(text).toContain('progress: {"workId":"ELC-1591","branch":"feature/ELC-1591-x"}')
    expect(text).toContain('root: /repo')
    expect(text).toContain('render: {"surface":"desktop","bodyColumns":77,"maxRows":10}')
    expect(text).toMatch(/^tick: \d+$/m)
  })

  test('without BAND_COST the cost never reaches the band', async ($, on) => {
    const { w } = world(on)
    w.cost = { usd: 139.14 }
    await start($, 'terminal')
    const ui = await mount($, 'terminal')
    await measure($, { window: 200_000, percent: 47 }, [{ kind: 'five_hour', percentUsed: 61 }], { usd: 139.14 })
    expect(await textOf(ui, /^cost /)).toBeUndefined()
    expect((await $.command.run({ command: 'band-debug', args: '' })).text).toContain('"costUsd":null')
  })
})

describe('disabled', () => {
  for (const surface of SURFACES) {
    test(`${surface}: no tree, the figures still measured, a focus-in leaves bandFocused false`, { options: { disabled: true } }, async ($, on) => {
      world(on, {}, TASK)
      await start($, surface)
      await measure($, { window: 200_000, percent: 47 }, [{ kind: 'five_hour', percentUsed: 61 }])
      const ui = await mount($, surface)
      expect(await textOf(ui, /engine band/)).toBe('engine band')
      expect(await ui.find({ key: 'compact' })).toBeUndefined()
      expect((await peek($)).usage).toMatchObject({ ctxPct: 47, rates: [{ kind: 'five_hour', pct: 61 }] })
      await $.ui.focus({ component: 'AbovePrompt', requestId: 'band', origin: { kind: 'person' }, element: 'compact' } as never)
      expect((await peek($)).bandFocused).toBeFalsy()
    })
  }
})

describe('buttons from published state', () => {
  const keys = async (ui: any) => nodes(await ui.drawn()).filter(n => n.type === 'Button' && n.props.key !== 'model').map(n => n.props.key)

  for (const surface of SURFACES) {
    test(`${surface}: Progress only while fnd.progress names a task; it follows fnd's writes`, async ($, on) => {
      const { w } = world(on, {}, { SIB_FND_PROGRESS: JSON.stringify({ workId: null, branch: 'main' }) })
      await start($, surface)
      await measure($, { window: 200_000, percent: 47 })
      const ui = await mount($, surface)
      expect(await keys(ui)).toEqual(['compact', 'clear', 'log'])
      w.vars.SIB_FND_PROGRESS = JSON.stringify({ workId: 7, done: 1, total: 2 })
      await sibFnd($)
      expect(await ui.find({ key: 'progress' })).toBeUndefined()
      w.vars.SIB_FND_PROGRESS = JSON.stringify(SNAP)
      await sibFnd($)
      expect(await keys(ui)).toEqual(['compact', 'clear', 'progress', 'log'])
      expect(await textOf(ui, /ELC-1591/)).toBe(`${surface === 'desktop' ? '📋 ' : ''}ELC-1591 3/5 ▶ Preview themes`)
      w.vars.SIB_FND_PROGRESS = 'null'
      await sibFnd($)
      expect(await keys(ui)).toEqual(['compact', 'clear', 'log'])
      expect(await textOf(ui, /ELC-1591/)).toBeUndefined()
    })

    test(`${surface}: no fnd at all → no Progress button`, async ($, on) => {
      world(on)
      await start($, surface)
      await measure($, { window: 200_000, percent: 47 })
      expect(await keys(await mount($, surface))).toEqual(['compact', 'clear', 'log'])
    })

    test(`${surface}: Log only while some event list holds a line; fnd's band-kind lines do not count`, async ($, on) => {
      // band records nothing of its own here, so only the siblings' lists decide.
      const { w } = world(on, {}, { BAND_EVENT_LOG: '0' })
      await start($, surface)
      await measure($, { window: 200_000, percent: 47 })
      const ui = await mount($, surface)
      expect(await ui.find({ key: 'log' })).toBeUndefined()
      w.vars.SIB_FND_EVENTS = JSON.stringify([{ atMs: T0, kind: 'session', text: 'start' }, { atMs: T0, kind: 'rate', text: 'x' }])
      await sibFnd($)
      expect(await ui.find({ key: 'log' })).toBeUndefined()
      w.vars.SIB_FND_EVENTS = JSON.stringify([{ atMs: T0, kind: 'workspace', text: 'ELC-1591' }])
      await sibFnd($)
      expect(await ui.find({ key: 'log' })).toBeDefined()
      w.vars.SIB_FND_EVENTS = '[]'
      await sibFnd($)
      expect(await ui.find({ key: 'log' })).toBeUndefined()
      w.vars.SIB_SLIM_EVENTS = JSON.stringify([{ v: 1, atMs: T0, kind: 'lookup', text: 'q' }])
      await sibSlim($)
      expect(await ui.find({ key: 'log' })).toBeDefined()
      w.vars.SIB_SLIM_EVENTS = JSON.stringify([{ atMs: 'x', kind: 'slim', text: 'malformed' }])
      await sibSlim($)
      expect(await ui.find({ key: 'log' })).toBeUndefined()
    })

    test(`${surface}: band's own session line alone draws Log`, async ($, on) => {
      world(on)
      await start($, surface)
      await measure($, { window: 200_000, percent: 47 })
      expect(await (await mount($, surface)).find({ key: 'log' })).toBeDefined()
      expect(await logged($)).toEqual(['session start · band 9.9.9'])
    })
  }
})

describe('rate alarm', () => {
  const five = (percentUsed: number) => [{ kind: 'five_hour', percentUsed }]

  test('a window held at ≥ 90 % toasts once', async ($, on) => {
    const { w } = world(on)
    await start($)
    await measure($, { window: 200_000, percent: 10 }, five(91))
    await measure($, { window: 200_000, percent: 11 }, five(92))
    expect(w.toasts).toEqual(['5h window: 91% used'])
  })

  test('the alarm re-arms once every window drops below 90 %', async ($, on) => {
    const { w } = world(on)
    await start($)
    await measure($, { window: 200_000, percent: 10 }, five(91))
    await measure($, { window: 200_000, percent: 10 }, five(3))
    await measure($, { window: 200_000, percent: 10 }, five(92))
    expect(w.toasts).toEqual(['5h window: 91% used', '5h window: 92% used'])
  })

  test('/clear re-arms it', async ($, on) => {
    const { w } = world(on)
    await start($)
    await measure($, { window: 200_000, percent: 10 }, five(91))
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as any)
    await measure($, { window: 200_000, percent: 10 }, five(92))
    expect(w.toasts).toHaveLength(2)
  })

  test('the alarm toast names the reset time', async ($, on) => {
    const { w } = world(on)
    await start($)
    const resetsAt = new Date(T0 + 125 * MIN).toISOString()
    await measure($, { window: 200_000, percent: 10 }, [{ kind: 'seven_day', percentUsed: 95, resetsAt }])
    expect(w.toasts).toEqual(['7d window: 95% used, resets in 2h 05m'])
  })
})
