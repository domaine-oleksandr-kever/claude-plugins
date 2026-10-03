import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { CRIT, cells, glyphText } from '../core/lib.ts'

const MIN = 60_000
const T0 = 1_700_000_000_000
const KEPT = [{ role: 'assistant', text: 'summary', toolUses: [] }]
const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

type Ctx = { window: number; percent?: number; tokens?: number }
type Rate = { kind: string; percentUsed: number; resetsAt?: string }
type Cost = { usd: number }

/** The engine beneath the plugin: clock, a recording store, env, the session ops usage.ts calls and a toast recorder. */
function world(on: On, store: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const w = {
    context: { window: 200_000 } as Ctx,
    rateLimits: [] as Rate[],
    cost: undefined as Cost | undefined,
    model: 'claude-fable-5-1',
    toasts: [] as string[],
    storeSets: [] as { key: string; value: unknown }[],
    compact: (async () => ({ messages: KEPT })) as () => Promise<unknown>,
  }
  const clock = mock.clock(on, { now: T0 })
  // A recording store: mock.store and a second store.set hook cannot both be registered.
  const mem: Record<string, unknown> = { ...store }
  on('store.get', async (_$, e) => ({ value: mem[e.key] }))
  on('store.set', async (_$, e) => {
    w.storeSets.push({ key: e.key, value: e.value })
    mem[e.key] = e.value
    return { value: undefined }
  })
  mock.env(on, env)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', async () => ({ value: { startedAt: T0, context: w.context, rateLimits: w.rateLimits, cost: w.cost } }))
  on('session.model', async () => ({ value: w.model }))
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  on('session.compact', async () => (await w.compact()) as never)
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('ui.focus', async () => ({}))
  on('ui.toast', async (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  return { w, clock }
}

const start = ($: any, surface: Surface = 'terminal') =>
  $.session.start({ cwd: '/repo', surface, isInteractive: true })

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { bodyRows: 10 }, view: {} }

const mount = ($: any, surface: Surface, props: Partial<typeof BAND> = {}) =>
  $.ui.mount({ plugin: 'fnd', surface, component: 'AbovePrompt', props: { ...BAND, ...props } as any })

const measure = ($: any, context: Ctx, rateLimits: Rate[] = [], cost?: Cost) =>
  $.session.measure({ context, rateLimits, ...(cost ? { cost } : {}), changed: ['context', 'rateLimits'] })

const mainTurn = ($: any, agentId?: string) =>
  $.turn.complete({
    answer: '',
    durationMs: 1,
    isAborted: false,
    turnId: 't',
    reason: 'answer',
    ...(agentId ? { agentId } : {}),
    usage: { input_tokens: 1, output_tokens: 1, model: 'claude-fable-5-1' },
  })

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

/** Reads fnd's own state from beside it: any plugin reads any value. */
const peek = {
  name: 'peek',
  register(on: any) {
    on('command.run', { command: 'peek-cache' }, async ($: any) => {
      const { value } = await $.state.get({ plugin: 'fnd', key: 'cache' } as const)
      return { text: JSON.stringify(value ?? null) }
    })
  },
}
const peekCache = async ($: any) => JSON.parse((await $.command.run({ command: 'peek-cache', args: '' })).text)

function modelSwitch(over: Record<string, unknown>) {
  return {
    from_model: 'claude-fable-5-1',
    to_model: 'claude-opus-5-5',
    requested_model: 'opus',
    source: 'command',
    context_tokens: 0,
    estimated_cache_write_usd: 0,
    cache_ttl: '1h',
    prompt_cache_warm: true,
    ...over,
  } as any
}

/** progress.tsx's ops over one workspace, so the band draws its digest. */
function workspace(on: On) {
  const md = ['- [x] Read', '- [x] Plan', '- [x] Branch', '- [ ] Preview themes', '- [ ] QA'].join('\n')
  const shown: { id: string; isShown: boolean; isPlaced: boolean }[] = []
  on('session.root', async () => ({ value: '/repo' }))
  on('session.id', async () => ({ value: 's1' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }) as never)
  on('process.run', async () => ({
    value: { exitCode: 0, stdout: 'feature/ELC-1591-x\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.exists', async (_$, e) => ({ value: e.path.endsWith('/ELC-1591/progress.md') }))
  on('fs.stat', async () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: T0, isLink: false } }) as never)
  on('fs.read', async (_$, e) => ({ value: e.path.endsWith('progress.md') ? md : '' }))
  on('ui.panes', async () => ({ value: shown }) as never)
  on('ui.open', async (_$, e) => {
    shown.push({ id: e.id, isShown: true, isPlaced: true })
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', async () => {
    shown.length = 0
    return { value: undefined }
  })
}

describe('band', () => {
  for (const surface of SURFACES) {
    const isDesktop = surface === 'desktop'
    const cacheRe = isDesktop ? /^⏱ / : /^cache /
    const ctxRe = isDesktop ? /^🧠 / : /^ctx /
    const L = (text: string) => (isDesktop ? glyphText(text) : text)

    test(`${surface}: fresh → cache —, ctx —, no Compact`, async ($, on) => {
      world(on)
      await start($, surface)
      const ui = await mount($, surface)
      expect(await textOf(ui, cacheRe)).toBe(L('cache —'))
      expect(await textOf(ui, ctxRe)).toBe(L('ctx —'))
      expect(await ui.find({ key: 'compact' })).toBeUndefined()
      const progress = await ui.find({ key: 'progress' })
      expect(progress?.props).toMatchObject({ label: 'Progress', dimColor: true })
      // A desktop draws a hotkey as a badge on its native button, so none is set there.
      expect(progress?.props.hotkey).toBe(isDesktop ? undefined : 'p')
      expect(progress?.props.plain).toBeUndefined()
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

    test(`${surface}: the cost sits between the rate windows and the digest, with its card; hidden at zero`, async ($, on) => {
      world(on)
      workspace(on)
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

    test(`${surface}: 85 % → primary Compact and CRIT ctx; 50 % → dim Compact`, async ($, on) => {
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
      expect(quiet?.props).toMatchObject({ dimColor: true, label: 'Compact' })
      expect(quiet?.props.hotkey).toBe(isDesktop ? undefined : 'c')
      expect(quiet?.props.variant).toBeUndefined()
      expect(quiet?.props.plain).toBeUndefined()
      expect((await valueOf(ui, ctxRe))?.props).toMatchObject({ color: 'warning', bold: true })
    })

    test(`${surface}: hotkey letters only while the band holds the keyboard`, async ($, on) => {
      world(on)
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
        expect((await ui.find({ key: 'compact' }))?.props).toMatchObject({ dimColor: true })
        expect((await ui.find({ key: 'compact' }))?.props.plain).toBeUndefined()
        return
      }
      expect((await ui.find({ key: 'compact' }))?.props).toMatchObject({ plain: true, hotkey: 'c' })
      expect((await ui.find({ key: 'progress' }))?.props).toMatchObject({ plain: true, hotkey: 'p' })
      await $.turn.start({ text: 'hi', turnId: 't1' })
      expect((await ui.find({ key: 'compact' }))?.props.plain).toBeUndefined()
      expect((await ui.find({ key: 'compact' }))?.props.dimColor).toBe(true)
      await $.ui.focus({ ...focusIn, element: 'progress' } as never)
      expect((await ui.find({ key: 'progress' }))?.props.plain).toBe(true)
      await ui.press({ key: 'compact' })
      expect((await ui.find({ key: 'progress' }))?.props.plain).toBeUndefined()
    })

    test(`${surface}: isWorking hides Compact and shows cache ●`, async ($, on) => {
      world(on)
      await start($, surface)
      await measure($, { window: 200_000, percent: 60 })
      const ui = await mount($, surface, { isWorking: true })
      expect(await ui.find({ key: 'compact' })).toBeUndefined()
      expect(await textOf(ui, cacheRe)).toBe(L('cache ●'))
    })

    test(`${surface}: hasSurvey → the engine's band`, async ($, on) => {
      world(on)
      await start($, surface)
      const ui = await mount($, surface, { hasSurvey: true })
      expect(await textOf(ui, /engine band/)).toBe('engine band')
      expect(await ui.find({ key: 'progress' })).toBeUndefined()
    })

    test(`${surface}: statusBand off → the engine's band`, { options: { statusBand: false } }, async ($, on) => {
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

    test(`${surface}: session.compact manual → cold and ctx —; precompute and skip → no change`, async ($, on) => {
      const { w } = world(on)
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
      w.compact = async () => ({ messages: KEPT })
      await $.session.compact({ trigger: 'manual', messages: KEPT } as any)
      expect(await textOf(ui, cacheRe)).toBe(L('cache cold'))
      expect(await textOf(ui, ctxRe)).toBe(L('ctx —'))
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
      test(`${surface}: session.end ${reason} → cache —, ctx —, no Compact`, async ($, on) => {
        world(on)
        await start($, surface)
        const ui = await mount($, surface)
        await mainTurn($)
        await measure($, { window: 200_000, percent: 85 })
        await $.session.end({ reason, sessionId: 's1', resume: {} } as any)
        expect(await textOf(ui, cacheRe)).toBe(L('cache —'))
        expect(await textOf(ui, ctxRe)).toBe(L('ctx —'))
        expect(await ui.find({ key: 'compact' })).toBeUndefined()
      })
    }

    test(`${surface}: a model switch → the model segment follows and the cache goes cold`, async ($, on) => {
      const { w } = world(on)
      on('classic.PostModelSwitch', async () => ({}) as never)
      await start($, surface)
      const ui = await mount($, surface)
      await mainTurn($)
      expect(await textOf(ui, /fable-5-1/)).toBe(isDesktop ? '🤖 fable-5-1' : 'fable-5-1')
      w.model = 'claude-opus-5-5'
      await $.classic.PostModelSwitch(modelSwitch({ prompt_cache_warm: true }))
      expect(await textOf(ui, /opus-5-5/)).toBe(isDesktop ? '🤖 opus-5-5' : 'opus-5-5')
      expect(await textOf(ui, /fable-5-1/)).toBeUndefined()
      expect(await textOf(ui, cacheRe)).toBe(L('cache cold'))
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
      test(`${surface}: classic.SessionStart ${source} seeds the anchor`, { plugins: [peek], options: { cacheTtl: '1h' } }, async ($, on) => {
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
      for (const card of cards) expect(card).toMatchObject({ props: { position: 'absolute' }, hover: { display: 'flex' } })
      const cacheCard = 'prompt cache: ~60 min left (estimate: last response + 1 h TTL)'
      expect(await textOf(ui, /^prompt cache: /)).toBe(cacheCard)
      expect(await textOf(ui, /^context: /)).toBe('context: 47% of 200,000 tokens, 94,000 used')
      expect(await textOf(ui, /^5h window: /)).toBe('5h window: 61% used')
      expect(cards.map(c => c.props.width)).toContain(cells(cacheCard))
    })

    test(`${surface}: a narrow band keeps cache, ctx and Compact; a desktop drops nothing`, async ($, on) => {
      world(on)
      workspace(on)
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
        expect(await ui.find({ key: 'progress' })).toBeDefined()
        return
      }
      expect(await textOf(ui, /fable-5-1|^5h|^⏳|ELC-1591/)).toBeUndefined()
      expect(await ui.find({ key: 'progress' })).toBeUndefined()
    })

    test(`${surface}: the digest hides while the pane is shown and returns when it closes`, async ($, on) => {
      world(on)
      workspace(on)
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
    expect(await textOf(term, /fable-5-1/)).toBe('fable-5-1')
    expect(await term.find({ type: 'Text', text: /^[⏱🧠⏳🤖📋]/u })).toBeUndefined()
  })

  test('/fnd-band prints the raw usage, the atoms, the workspace and the last render', async ($, on) => {
    const { w } = world(on)
    workspace(on)
    w.rateLimits = [{ kind: 'five_hour', percentUsed: 61 }]
    await start($, 'desktop')
    await mount($, 'desktop', { bodyColumns: 77 })
    const { text } = await $.command.run({ command: 'fnd-band', args: '' })
    expect(text).toContain('usage(): {"startedAt":')
    expect(text).toContain('"rateLimits":[{"kind":"five_hour","percentUsed":61}]')
    expect(text).toContain('"costUsd":null')
    expect(text).toContain('progress: {"workId":"ELC-1591","branch":"feature/ELC-1591-x"}')
    expect(text).toContain('root: /repo')
    expect(text).toContain('render: {"surface":"desktop","bodyColumns":77,"maxRows":10}')
  })
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

describe('TTL learning (A4)', () => {
  test('PostModelSwitch under auto learns 5m and stores it', { plugins: [peek] }, async ($, on) => {
    const { w } = world(on)
    on('classic.PostModelSwitch', async () => ({}) as never)
    await start($)
    await $.classic.PostModelSwitch(modelSwitch({ to_model: 'claude-fable-5-1', cache_ttl: '5m' }))
    expect(await peekCache($)).toMatchObject({ ttlMs: 300_000, ttlSource: 'model-switch', isCold: false })
    expect(w.storeSets).toEqual([{ key: 'cacheTtlMs', value: 300_000 }])
  })

  test('PostModelSwitch with a forced TTL keeps it and stores nothing', { plugins: [peek], options: { cacheTtl: '1h' } }, async ($, on) => {
    const { w } = world(on)
    on('classic.PostModelSwitch', async () => ({}) as never)
    await start($)
    await $.classic.PostModelSwitch(modelSwitch({ cache_ttl: '5m' }))
    expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'option' })
    expect(w.storeSets).toEqual([])
  })

  test('classic.SessionStart startup changes nothing', { plugins: [peek] }, async ($, on) => {
    world(on)
    on('classic.SessionStart', async () => ({}) as never)
    await start($)
    await $.classic.SessionStart({ source: 'startup', seconds_since_last_response: 600 } as any)
    expect((await peekCache($)).anchorMs).toBeNull()
  })

  test('an Agent result with 1 h cache writes learns 1 h', { plugins: [peek] }, async ($, on) => {
    const { w } = world(on)
    on('tool.call', { tool: 'Agent' }, async () => ({
      result: { usage: { cache_creation: { ephemeral_1h_input_tokens: 1200, ephemeral_5m_input_tokens: 0 } } },
    }) as never)
    await start($)
    await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as any)
    expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'agent' })
    expect(w.storeSets).toEqual([{ key: 'cacheTtlMs', value: 3_600_000 }])
  })

  test('a fresh session.start reads the stored TTL', { plugins: [peek] }, async ($, on) => {
    world(on, { cacheTtlMs: 3_600_000 })
    await start($)
    expect((await peekCache($)).ttlMs).toBe(3_600_000)
  })

  test('without a stored TTL, auto starts at 1 h on a claude.ai account and 5 min under an API key', { plugins: [peek] }, async ($, on) => {
    world(on)
    await start($)
    expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'default' })
  })

  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    test(`${name} set → auto starts at 5 min`, { plugins: [peek] }, async ($, on) => {
      world(on, {}, { [name]: '1' })
      await start($)
      expect(await peekCache($)).toMatchObject({ ttlMs: 300_000, ttlSource: 'default' })
    })
  }

  test('rate windows mean a subscription → 1 h, from the start reading or a measurement', { plugins: [peek] }, async ($, on) => {
    const { w } = world(on)
    w.rateLimits = [{ kind: 'five_hour', percentUsed: 2 }]
    await start($)
    expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'subscription' })
  })

  test('a measurement with rate windows adopts 1 h once; a stored, forced or reported TTL wins', { plugins: [peek] }, async ($, on) => {
    world(on, {}, { ANTHROPIC_API_KEY: 'k' })
    await start($)
    expect(await peekCache($)).toMatchObject({ ttlMs: 300_000, ttlSource: 'default' })
    await measure($, { window: 200_000, percent: 10 }, [{ kind: 'seven_day', percentUsed: 17 }])
    expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'subscription' })
    await measure($, { window: 200_000, percent: 10 }, [])
    expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'subscription' })
  })

  test('a stored TTL is not overridden by the subscription rule', { plugins: [peek] }, async ($, on) => {
    world(on, { cacheTtlMs: 300_000 })
    await start($)
    await measure($, { window: 200_000, percent: 10 }, [{ kind: 'five_hour', percentUsed: 2 }])
    expect(await peekCache($)).toMatchObject({ ttlMs: 300_000, ttlSource: 'store' })
  })
})
