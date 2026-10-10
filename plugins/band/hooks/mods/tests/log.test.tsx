import { describe, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { BandEvent } from '../../types'
import { EVENT_CAP, PREFIX_COLS, TEXT_LOG_ROWS, anyEvent, fmtK, hhmm, kindCell, logRow, merged, newestFitting, pluginCell, pushEvent, take, textRows } from '../events.ts'
import { SNAP, baseState, sibBase, sibSlim, teamState, test } from './world.tsx'

const NOW = new Date(2027, 0, 15, 9, 5).getTime()
const PANE = 'band-log'
const SURFACES = ['terminal', 'desktop'] as const
const MODELS = ['claude-opus-5-5', 'claude-fable-5-1']

type Pane = { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }

/** The engine beneath band: a clock, a mutable env, the session ops the writers call, and a pane host that records opens and closes. */
function world(on: On, env: Record<string, string> = {}) {
  const w = {
    vars: { ...env } as Record<string, string>,
    model: 'claude-fable-5-1',
    panes: [] as Pane[],
    openResult: { isPlaced: true } as { isPlaced: true } | { isPlaced: false; reason: string },
    opens: [] as unknown[],
    closes: [] as unknown[],
    toasts: [] as string[],
    surfaces: ['terminal'] as string[],
    clock: mock.clock(on, { now: NOW }),
  }
  mock.store(on)
  on('env.get', async (_$, e) => ({ value: w.vars[e.name] }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.root', async () => {
    throw new Error('no repo')
  })
  // band's own manifest, as info.ts reads it for band.info and the start line.
  on('fs.read', async () => ({ value: JSON.stringify({ name: 'band', version: '9.9.9' }) }))
  on('session.id', async () => ({ value: 's1' }))
  on('session.model', async () => ({ value: w.model }))
  on('session.usage', async () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.surfaces', async () => ({ value: w.surfaces }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('classic.PostModelSwitch', async () => ({}) as never)
  on('ui.panes', async () => ({ value: w.panes }))
  on('ui.open', async (_$, e) => {
    w.opens.push(e)
    return { value: w.openResult }
  })
  on('ui.close', async (_$, e) => {
    w.closes.push(e)
    return { value: undefined }
  })
  on('ui.toast', async (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  return w
}

const start = ($: any) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const run = ($: any, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

/** One `model` event per call: each switch alternates the model the session reports. */
async function switches($: any, w: ReturnType<typeof world>, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    w.model = MODELS[i % 2]!
    await $.classic.PostModelSwitch({ from_model: 'x', to_model: w.model, source: 'command', prompt_cache_warm: true } as any)
  }
}

const PANE_PROPS = { title: 'Log', isFocused: false, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 10 }, view: {} }
const BAND = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 200, scroll: { offset: 0, bodyRows: 1 }, view: {} }
const mountPane = ($: any, surface: (typeof SURFACES)[number], props: Partial<typeof PANE_PROPS> = {}) =>
  $.ui.mount({ plugin: 'band', surface, component: 'Pane', requestId: PANE, props: { ...PANE_PROPS, ...props } as any })

/** Every Text under an element, in drawing order. */
function texts(el: any): any[] {
  if (el?.type === 'Text') return [el]
  return (el?.children ?? []).flatMap((c: any) => (c && typeof c === 'object' ? texts(c) : []))
}

/** A row Box's four Texts as [time, plugin, kind, text]. */
async function rows(ui: any): Promise<{ texts: string[]; props: any[] }[]> {
  const boxes = (await ui.findAll({ type: 'Box' })).filter((b: any) => typeof b.props.key === 'string' && b.props.key.startsWith('ev-'))
  return boxes.map((b: any) => {
    const ts = texts(b)
    return { texts: ts.map((t: any) => t.children.join('')), props: ts.map((t: any) => t.props) }
  })
}

describe('event helpers', () => {
  test('the buffer keeps the newest 200, oldest first; past the cap the oldest line goes, whatever its kind', () => {
    let list: BandEvent[] = [{ atMs: 0, kind: 'rate', text: 'first' }]
    for (let i = 1; i <= EVENT_CAP; i++) list = pushEvent(list, { atMs: i, kind: 'model', text: `#${i}` })
    expect(list).toHaveLength(EVENT_CAP)
    expect(EVENT_CAP).toBe(200)
    expect(list[0]?.text).toBe('#1')
    expect(list[EVENT_CAP - 1]?.text).toBe(`#${EVENT_CAP}`)
    expect(list.map(e => e.atMs)).toEqual([...list.map(e => e.atMs)].sort((x, y) => x - y))
  })

  test('local HH:MM, k-rounded tokens, fixed plugin and kind columns', () => {
    expect(hhmm(NOW)).toBe('09:05')
    expect(hhmm(new Date(2027, 0, 15, 23, 59).getTime())).toBe('23:59')
    expect(fmtK(412_345)).toBe('412k')
    expect(fmtK(38_000)).toBe('38k')
    expect(fmtK(950)).toBe('950')
    expect(kindCell('rate')).toBe('rate     ')
    expect(kindCell('workspace')).toBe('workspace')
    expect(kindCell('profile')).toBe('profile  ')
    expect(pluginCell('band')).toBe('band ')
    expect(pluginCell('slim')).toBe('slim ')
    expect(pluginCell('base')).toBe('base ')
    expect(logRow({ atMs: NOW, plugin: 'base', kind: 'guard', text: 'Bash: --no-verify' })).toBe('09:05  base   guard      Bash: --no-verify')
  })

  test('wrapped rows: a text takes ceil(len / cols) rows, the newest that fit are kept, one row for the "earlier" line', () => {
    expect(PREFIX_COLS).toBe(25)
    expect(textRows('', 10)).toBe(1)
    expect(textRows('a'.repeat(10), 10)).toBe(1)
    expect(textRows('a'.repeat(11), 10)).toBe(2)
    const ev = (n: number, len: number) => ({ atMs: n, kind: 'slim' as const, text: `${n}`.padEnd(len, 'x') })
    const list = [ev(1, 5), ev(2, 25), ev(3, 5), ev(4, 15)]
    expect(newestFitting(list, 0, 10)).toEqual(list)
    expect(newestFitting(list, 10, 10)).toEqual(list)
    // 4 rows: #4 (2) + #3 (1) = 3, #2 (3) would overflow; the "earlier" row still fits.
    expect(newestFitting(list, 4, 10)).toEqual([ev(3, 5), ev(4, 15)])
    // 3 rows: #4 + #3 fill all three, so #3 gives way to the "earlier" row.
    expect(newestFitting(list, 3, 10)).toEqual([ev(4, 15)])
    expect(newestFitting(list, 1, 10)).toEqual([])
  })
})

describe('merged', () => {
  test('oldest first; on a tie band → base → slim, each list in its own order', () => {
    const own = [{ atMs: 10, kind: 'session', text: 'start' }, { atMs: 30, kind: 'model', text: 'm' }]
    const base = [{ atMs: 30, kind: 'refuse', text: 'c1' }, { atMs: 2, kind: 'start', text: 'base 0.1.0' }, { atMs: 30, kind: 'guard', text: 'g1' }, { atMs: 5, kind: 'install', text: 'p' }]
    const slim = [{ atMs: 30, kind: 'lookup', text: 'tie' }, { atMs: 20, kind: 'lookup', text: 'mid' }]
    expect(merged(own, base, slim).map(e => e.text)).toEqual(['base 0.1.0', 'p', 'start', 'mid', 'm', 'c1', 'g1', 'tie'])
    expect(merged(own, [], slim).map(e => e.text)).toEqual(['start', 'mid', 'm', 'tie'])
  })

  test('each line is tagged with the list it came from and keeps its kind', () => {
    const own = [{ atMs: 1, kind: 'session', text: 'start · band 9.9.9' }]
    const base = [{ atMs: 2, kind: 'start', text: 'base 0.1.0' }, { atMs: 3, kind: 'slim', text: 'not slim' }]
    const slim = [{ atMs: 4, kind: 'start', text: 'slim 0.5.1' }]
    expect(merged(own, base, slim).map(e => [e.plugin, e.kind])).toEqual([
      ['band', 'session'],
      ['base', 'start'],
      ['base', 'slim'],
      ['slim', 'start'],
    ])
  })

  test('the team plugins follow slim on a tie, fe → qa → be → pm, each tagged with its own name', () => {
    const slim = [{ atMs: 10, kind: 'slim', text: 's' }]
    const teams = {
      pm: [{ atMs: 10, kind: 'start', text: 'pm 0.1.0' }],
      qa: [{ atMs: 10, kind: 'start', text: 'qa 0.1.0' }, { atMs: 4, kind: 'install', text: 'needs the base plugin' }],
      be: [{ atMs: 'x', kind: 'start', text: 'malformed' }],
      fe: [{ atMs: 10, kind: 'doctor', text: '9 PASS' }],
    }
    expect(merged([], [], slim, teams).map(e => [e.plugin, e.text])).toEqual([
      ['qa', 'needs the base plugin'],
      ['slim', 's'],
      ['fe', '9 PASS'],
      ['qa', 'qa 0.1.0'],
      ['pm', 'pm 0.1.0'],
    ])
    expect(merged([], [], [], { qa: null, be: { not: 'a list' } })).toEqual([])
    expect(['fe', 'qa', 'be', 'pm'].map(pluginCell)).toEqual(['fe   ', 'qa   ', 'be   ', 'pm   '])
  })

  test('malformed entries are dropped and extra fields stripped; absent, null or non-array lists add nothing', () => {
    const bad = [
      { atMs: 20, kind: 'lookup', text: 'mid', extra: 1, v: 1 },
      { atMs: 'x', kind: 'slim', text: 'bad time' },
      { atMs: 5, kind: 3, text: 'bad kind' },
      { atMs: 6, kind: 'slim' },
      { atMs: Number.NaN, kind: 'slim', text: 'nan' },
      { atMs: Number.POSITIVE_INFINITY, kind: 'slim', text: 'inf' },
      null,
      'line',
    ]
    expect(take(bad)).toEqual([{ atMs: 20, kind: 'lookup', text: 'mid' }])
    for (const absent of [undefined, null, {}, 'x', 3]) {
      expect(merged(absent, absent, absent)).toEqual([])
      expect(take(absent)).toEqual([])
    }
    expect(merged([{ atMs: 1, kind: 'session', text: 'start' }], null, undefined)).toEqual([{ atMs: 1, kind: 'session', text: 'start', plugin: 'band' }])
    expect(merged([], bad, [])).toEqual([{ atMs: 20, kind: 'lookup', text: 'mid', plugin: 'base' }])
  })
})

describe('anyEvent', () => {
  test('true at the first list with a valid line; absent, empty and malformed lists count as none', () => {
    expect(anyEvent()).toBe(false)
    expect(anyEvent([], null, undefined, { not: 'a list' }, [{ atMs: 'x', kind: 'slim', text: 'bad' }, { kind: 'slim' }])).toBe(false)
    expect(anyEvent([], [{ atMs: 1, kind: 'session', text: 'start' }])).toBe(true)
    expect(anyEvent([{ atMs: 1, kind: 'guard', text: 'g' }], 'x')).toBe(true)
  })
})

describe('/band-log', () => {
  test('opens the pane, closes it when shown, reopens a pane behind a tab', async ($, on) => {
    const w = world(on)
    await start($)
    expect(await run($, 'band-log')).toEqual({ text: 'Log pane opened.' })
    expect(w.opens).toEqual([{ id: PANE, title: 'Log', focus: true, closeOnEscape: true }])
    w.panes = [{ id: PANE, title: 'Log', isShown: true, isFocused: true, isPlaced: true }]
    expect(await run($, 'band-log')).toEqual({ text: 'Log pane closed.' })
    expect(w.closes).toEqual([expect.objectContaining({ id: PANE })])
    w.panes = [{ id: PANE, title: 'Log', isShown: false, isFocused: false, isPlaced: true }]
    expect(await run($, 'band-log')).toEqual({ text: 'Log pane opened.' })
    expect(w.opens).toHaveLength(2)
    expect(w.closes).toHaveLength(1)
  })

  test('where no surface draws panes (cloud, VS Code chat, -p) the command answers with the log as text', async ($, on) => {
    const w = world(on)
    w.surfaces = []
    await start($)
    expect((await run($, 'band-log')).text).toBe('09:05  band   session    start · band 9.9.9')
    await switches($, w, 2)
    expect((await run($, 'band-log')).text).toBe(
      ['09:05  band   session    start · band 9.9.9', '09:05  band   model      claude-opus-5-5', '09:05  band   model      claude-fable-5-1'].join('\n'),
    )
    expect(w.opens).toEqual([])
    w.surfaces = ['mobile']
    expect((await run($, 'band-log')).text).toContain('claude-fable-5-1')
    expect(w.opens).toEqual([])
  })

  test(`the text answer holds the newest ${TEXT_LOG_ROWS} lines and counts the rest, pointing at the session's log folder`, async ($, on) => {
    const lines = Array.from({ length: 45 }, (_, i) => ({ atMs: NOW + (i + 1) * 1000, kind: 'guard', text: `g${i + 1}` }))
    const w = world(on, { SIB_BASE_EVENTS: JSON.stringify(lines), HOME: '/home/u' })
    w.surfaces = []
    await start($)
    const text: string[] = (await run($, 'band-log')).text.split('\n')
    expect(text).toHaveLength(TEXT_LOG_ROWS + 1)
    expect(text[0]).toBe('… 6 earlier — full log: /home/u/.claude/domaine/log/s1/')
    expect(text[1]).toContain('g6')
    expect(text[TEXT_LOG_ROWS]).toContain('g45')
    delete w.vars.HOME
    expect((await run($, 'band-log')).text.split('\n')[0]).toBe('… 6 earlier')
  })

  test('an unplaced open → one toast', async ($, on) => {
    const w = world(on)
    w.openResult = { isPlaced: false, reason: 'below 144 columns' }
    await start($)
    expect(await run($, 'band-log')).toEqual({ text: 'Log pane not placed: below 144 columns' })
    expect(w.toasts).toEqual(['log pane not placed: below 144 columns'])
  })

  test('both panes open at once: opening Log closes nothing', async ($, on) => {
    const w = world(on, { SIB_BASE_PROGRESS: JSON.stringify(SNAP) })
    await start($)
    await run($, 'band-progress')
    w.panes = [{ id: 'band-progress', title: 'Progress', isShown: true, isFocused: true, isPlaced: true }]
    await run($, 'band-log')
    expect(w.opens.map((o: any) => o.id)).toEqual(['band-progress', PANE])
    expect(w.closes).toEqual([])
  })
})

describe('Log button', () => {
  for (const surface of SURFACES) {
    test(`${surface}: a press toggles the pane once each way`, async ($, on) => {
      const w = world(on)
      await start($)
      const ui = await $.ui.mount({ plugin: 'band', surface, component: 'AbovePrompt', props: BAND as any })
      await ui.press({ key: 'log' })
      expect(w.opens).toEqual([{ id: PANE, title: 'Log', focus: true, closeOnEscape: true }])
      w.panes = [{ id: PANE, title: 'Log', isShown: true, isFocused: false, isPlaced: true }]
      await ui.press({ key: 'log' })
      expect(w.opens).toHaveLength(1)
      expect(w.closes).toHaveLength(1)
    })
  }
})

describe('Log pane', () => {
  for (const surface of SURFACES) {
    test(`${surface}: one row per event, oldest first; dim time, plugin and kind, the text wraps`, async ($, on) => {
      const w = world(on)
      await start($)
      await switches($, w, 2)
      const ui = await mountPane($, surface)
      const r = await rows(ui)
      expect(r.map(x => x.texts)).toEqual([
        ['09:05  ', 'band   ', 'session    ', 'start · band 9.9.9'],
        ['09:05  ', 'band   ', 'model      ', 'claude-opus-5-5'],
        ['09:05  ', 'band   ', 'model      ', 'claude-fable-5-1'],
      ])
      expect(r[0]?.props[0]).toMatchObject({ dimColor: true })
      expect(r[0]?.props[1]).toMatchObject({ dimColor: true })
      expect(r[0]?.props[2]).toMatchObject({ dimColor: true })
      expect(r[0]?.props[3]).toMatchObject({ wrap: 'wrap' })
      expect(r[0]?.props[3].dimColor).toBeFalsy()
      expect((await ui.findAll({ type: 'Box' })).find((b: any) => b.props.width === PREFIX_COLS)).toBeTruthy()
      await ui.unmount()
    })

    test(`${surface}: more events than rows → "… N earlier" and the newest rows`, async ($, on) => {
      const w = world(on)
      await start($)
      await switches($, w, 4)
      const ui = await mountPane($, surface, { scroll: { offset: 0, bodyRows: 3 } })
      const more = await ui.find({ type: 'Text', text: '… 3 earlier' })
      expect(more?.props).toMatchObject({ dimColor: true })
      expect((await rows(ui)).map(x => x.texts[3])).toEqual(['claude-opus-5-5', 'claude-fable-5-1'])
      await ui.unmount()
    })

    test(`${surface}: a text wider than the pane wraps and counts as two rows in the window`, async ($, on) => {
      const w = world(on)
      await start($)
      await switches($, w, 2)
      // bodyColumns 37 → 12 text cells after the 25-cell prefix: each model name wraps onto a second row.
      // 4 rows: fable (2) + opus (2) fill them, so opus gives way to the "earlier" row.
      const ui = await mountPane($, surface, { bodyColumns: 37, scroll: { offset: 0, bodyRows: 4 } })
      const more = await ui.find({ type: 'Text', text: '… 2 earlier' })
      expect(more?.props).toMatchObject({ dimColor: true })
      const r = await rows(ui)
      expect(r.map(x => x.texts[3])).toEqual(['claude-fable-5-1'])
      expect(r[0]?.props[3]).toMatchObject({ wrap: 'wrap' })
      const text = (await ui.findAll({ type: 'Box' })).find((b: any) => b.props.width === 12)
      expect(text).toBeTruthy()
      await ui.unmount()
    })

    test(`${surface}: BAND_EVENT_LOG=0 and no sibling lines → nothing recorded, the pane says so`, async ($, on) => {
      const w = world(on, { BAND_EVENT_LOG: '0' })
      await start($)
      await switches($, w, 2)
      const ui = await mountPane($, surface)
      expect((await ui.findAll({ type: 'Text' })).map((t: any) => t.text)).toEqual(['no events yet'])
      expect((await ui.find({ type: 'Text', text: 'no events yet' }))?.props).toMatchObject({ dimColor: true })
      await ui.unmount()
    })
  }
})

const SLIM_LINE = 'getJiraIssue: compressed 90,000 B → 7,000 B (−92.2%)'
const LOOKUP_LINE = 'lookup: is the widget loaded? · haiku · 1.2k tok'
const SLIM_EVENTS = [
  { v: 1, atMs: NOW + 30_000, kind: 'slim', text: SLIM_LINE, src: 'slim', tool: 'mcp__x__getJiraIssue', ms: 40, channel: 'mcp', bytesIn: 90_000, bytesOut: 7000, engine: 'json' },
  { v: 1, atMs: NOW + 90_000, kind: 'lookup', text: LOOKUP_LINE, src: 'slim', tool: 'mcp__slim__lookup', ms: 900, model: 'haiku', tokens: null, answered: true },
]
/** base's lines as the base sibling writes them: a workspace tie with band's start, a guard tie with the lookup. */
const SIB_BASE_LINES = [
  { atMs: NOW, kind: 'workspace', text: 'ELC-1591' },
  { atMs: NOW + 90_000, kind: 'guard', text: 'outside the project: /etc/hosts' },
]
const SIBLING_ENV = { SIB_BASE_EVENTS: JSON.stringify(SIB_BASE_LINES), SIB_SLIM_EVENTS: JSON.stringify(SLIM_EVENTS) }
const MERGED = [
  ['09:05', 'band', 'session', 'start · band 9.9.9'],
  ['09:05', 'base', 'workspace', 'ELC-1591'],
  ['09:05', 'slim', 'slim', SLIM_LINE],
  ['09:06', 'band', 'model', 'claude-opus-5-5'],
  ['09:06', 'base', 'guard', 'outside the project: /etc/hosts'],
  ['09:06', 'slim', 'lookup', LOOKUP_LINE],
]
const textLine = ([t, p, k, x]: string[]) => `${t}  ${pluginCell(p!)}  ${kindCell(k!)}  ${x}`

/** band's session line at NOW, its model line at +60 s; the siblings' lines as above. */
async function interleave($: any, w: ReturnType<typeof world>): Promise<void> {
  await start($)
  await w.clock.advance(60_000)
  await switches($, w, 1)
}

describe("band's, base's and slim's lines in one log", () => {
  test('where no surface draws panes the text answer interleaves all three', async ($, on) => {
    const w = world(on, SIBLING_ENV)
    w.surfaces = []
    await interleave($, w)
    expect((await run($, 'band-log')).text).toBe(MERGED.map(textLine).join('\n'))
  })

  for (const surface of SURFACES) {
    test(`${surface}: the siblings' lines sit between band's by time, their source in the plugin cell, their kind in the kind cell`, async ($, on) => {
      const w = world(on, SIBLING_ENV)
      await interleave($, w)
      const ui = await mountPane($, surface)
      expect((await rows(ui)).map(x => x.texts)).toEqual(MERGED.map(([t, p, k, x]) => [`${t}  `, `${pluginCell(p!)}  `, `${kindCell(k!)}  `, x]))
      await ui.unmount()
    })

    test(`${surface}: "… N earlier" counts the merged list`, async ($, on) => {
      const w = world(on, SIBLING_ENV)
      await interleave($, w)
      const ui = await mountPane($, surface, { bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 } })
      expect(await ui.find({ type: 'Text', text: '… 4 earlier' })).toBeTruthy()
      expect((await rows(ui)).map(x => x.texts[3])).toEqual(['outside the project: /etc/hosts', LOOKUP_LINE])
      await ui.unmount()
    })

    test(`${surface}: a sibling's write redraws the open pane`, async ($, on) => {
      const w = world(on)
      await start($)
      const ui = await mountPane($, surface)
      expect((await rows(ui)).map(x => x.texts[3])).toEqual(['start · band 9.9.9'])
      w.vars.SIB_SLIM_EVENTS = JSON.stringify(SLIM_EVENTS)
      await sibSlim($)
      expect((await rows(ui)).map(x => x.texts[3])).toEqual(['start · band 9.9.9', SLIM_LINE, LOOKUP_LINE])
      w.vars.SIB_BASE_EVENTS = JSON.stringify([{ atMs: NOW + 60_000, kind: 'guard', text: 'g' }])
      await sibBase($)
      expect((await rows(ui)).map(x => x.texts[3])).toEqual(['start · band 9.9.9', SLIM_LINE, 'g', LOOKUP_LINE])
      await ui.unmount()
    })

    for (const [name, env] of [
      ['no siblings', {}],
      ['empty sibling lists', { SIB_BASE_EVENTS: '[]', SIB_SLIM_EVENTS: '[]' }],
      ['malformed sibling lists', { SIB_BASE_EVENTS: JSON.stringify({ not: 'a list' }), SIB_SLIM_EVENTS: JSON.stringify([{ atMs: 'x', kind: 'slim', text: 'bad' }, { kind: 'slim' }]) }],
    ] as const) {
      test(`${surface}: ${name} → band's lines only`, async ($, on) => {
        const w = world(on, env)
        await interleave($, w)
        const ui = await mountPane($, surface)
        expect((await rows(ui)).map(x => x.texts[2])).toEqual(['session    ', 'model      '])
        await ui.unmount()
      })
    }

    test(`${surface}: only siblings' lines (BAND_EVENT_LOG=0) still fill the pane`, async ($, on) => {
      const w = world(on, { BAND_EVENT_LOG: '0', ...SIBLING_ENV })
      await interleave($, w)
      const ui = await mountPane($, surface)
      expect((await rows(ui)).map(x => x.texts[3])).toEqual(MERGED.filter(([, p]) => p !== 'band').map(([, , , x]) => x))
      await ui.unmount()
    })
  }
})

/** base's lines as base writes them: its start line, a tie with band's start, and a guard a minute later. */
const BASE_EVENTS = [
  { atMs: NOW, kind: 'start', text: 'base 0.1.0' },
  { atMs: NOW + 90_000, kind: 'guard', text: 'Bash: --no-verify' },
]

describe("base's lines in the log", () => {
  for (const surface of SURFACES) {
    test(`${surface}: base alone (no slim) fills the pane beside band's lines`, async ($, on) => {
      const w = world(on)
      baseState(on, { events: BASE_EVENTS })
      await interleave($, w)
      const ui = await mountPane($, surface)
      expect((await rows(ui)).map(x => [x.texts[1], x.texts[3]])).toEqual([
        ['band   ', 'start · band 9.9.9'],
        ['base   ', 'base 0.1.0'],
        ['band   ', 'claude-opus-5-5'],
        ['base   ', 'Bash: --no-verify'],
      ])
      await ui.unmount()
    })

    for (const [name, events] of [
      ['an empty base list', []],
      ['a malformed base list', { not: 'a list' }],
    ] as const) {
      test(`${surface}: ${name} → band's lines only`, async ($, on) => {
        const w = world(on)
        baseState(on, { events })
        await interleave($, w)
        const ui = await mountPane($, surface)
        expect((await rows(ui)).map(x => x.texts[2])).toEqual(['session    ', 'model      '])
        await ui.unmount()
      })
    }
  }
})

/** qa's lines as qa writes them: its start line, a tie with band's start, and a doctor run a minute later. */
const QA_EVENTS = [
  { atMs: NOW, kind: 'start', text: 'qa 0.1.0' },
  { atMs: NOW + 90_000, kind: 'doctor', text: '7 PASS · 1 SKIP' },
]

describe("a team plugin's lines in the log", () => {
  test('where no surface draws panes the text answer names fe, qa and be in the plugin column, after base on a tie', async ($, on) => {
    const w = world(on)
    baseState(on, { events: BASE_EVENTS })
    teamState(on, 'fe', { events: [{ atMs: NOW + 90_000, kind: 'profile', text: 'theme (project-profile.sh)' }] })
    teamState(on, 'qa', { events: QA_EVENTS })
    teamState(on, 'be', { events: [{ atMs: NOW, kind: 'start', text: 'be 0.1.0' }] })
    w.surfaces = []
    await interleave($, w)
    expect((await run($, 'band-log')).text).toBe(
      [
        ['09:05', 'band', 'session', 'start · band 9.9.9'],
        ['09:05', 'base', 'start', 'base 0.1.0'],
        ['09:05', 'qa', 'start', 'qa 0.1.0'],
        ['09:05', 'be', 'start', 'be 0.1.0'],
        ['09:06', 'band', 'model', 'claude-opus-5-5'],
        ['09:06', 'base', 'guard', 'Bash: --no-verify'],
        ['09:06', 'fe', 'profile', 'theme (project-profile.sh)'],
        ['09:06', 'qa', 'doctor', '7 PASS · 1 SKIP'],
      ]
        .map(textLine)
        .join('\n'),
    )
  })

  for (const surface of SURFACES) {
    test(`${surface}: pm alone beside band fills the pane; an empty fe list adds nothing`, async ($, on) => {
      const w = world(on)
      teamState(on, 'pm', { events: [{ atMs: NOW + 90_000, kind: 'install', text: 'needs the base plugin — claude plugin install base@domaine' }] })
      teamState(on, 'fe', { events: [] })
      await interleave($, w)
      const ui = await mountPane($, surface, { bodyColumns: 120 })
      expect((await rows(ui)).map(x => [x.texts[1], x.texts[2], x.texts[3]])).toEqual([
        ['band   ', 'session    ', 'start · band 9.9.9'],
        ['band   ', 'model      ', 'claude-opus-5-5'],
        ['pm     ', 'install    ', 'needs the base plugin — claude plugin install base@domaine'],
      ])
      await ui.unmount()
    })
  }
})
