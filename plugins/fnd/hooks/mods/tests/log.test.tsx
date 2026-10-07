import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { FndEvent } from '../../../types'
import { EVENT_CAP, PREFIX_COLS, bare, fmtK, hhmm, kindCell, merged, newestFitting, pushEvent, textRows, toolName } from '../core/events.ts'

const NOW = new Date(2027, 0, 15, 9, 5).getTime()
const PANE = 'fnd-log'
const SURFACES = ['terminal', 'desktop'] as const
const MODELS = ['claude-opus-5-5', 'claude-fable-5-1']

type Pane = { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }

/** The engine beneath fnd: a clock, the session ops the writers call, and a pane host that records opens and closes. */
function world(on: On, env: Record<string, string> = {}) {
  const w = {
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
  mock.env(on, env)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.root', async () => {
    throw new Error('no repo')
  })
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
  $.ui.mount({ plugin: 'fnd', surface, component: 'Pane', requestId: PANE, props: { ...PANE_PROPS, ...props } as any })

/** Every Text under an element, in drawing order. */
function texts(el: any): any[] {
  if (el?.type === 'Text') return [el]
  return (el?.children ?? []).flatMap((c: any) => (c && typeof c === 'object' ? texts(c) : []))
}

/** A row Box's three Texts as [time, kind, text]. */
async function rows(ui: any): Promise<{ texts: string[]; props: any[] }[]> {
  const boxes = (await ui.findAll({ type: 'Box' })).filter((b: any) => typeof b.props.key === 'string' && b.props.key.startsWith('ev-'))
  return boxes.map((b: any) => {
    const ts = texts(b)
    return { texts: ts.map((t: any) => t.children.join('')), props: ts.map((t: any) => t.props) }
  })
}

describe('event helpers', () => {
  test('the buffer keeps the newest 200, oldest first', () => {
    let list: FndEvent[] = []
    for (let i = 1; i <= EVENT_CAP + 1; i++) list = pushEvent(list, { atMs: i, kind: 'guard', text: `#${i}` })
    expect(list).toHaveLength(EVENT_CAP)
    expect(EVENT_CAP).toBe(200)
    expect(list[0]?.text).toBe('#2')
    expect(list[EVENT_CAP - 1]?.text).toBe(`#${EVENT_CAP + 1}`)
  })

  test('over the cap routine slim/prompt lines go first, so rare lines between them stay', () => {
    let list: FndEvent[] = []
    list = pushEvent(list, { atMs: 0, kind: 'guard', text: 'first' })
    for (let i = 1; i <= EVENT_CAP + 10; i++) list = pushEvent(list, { atMs: i, kind: i % 2 ? 'slim' : 'prompt', text: `#${i}` })
    list = pushEvent(list, { atMs: EVENT_CAP + 11, kind: 'compact', text: 'last' })
    expect(list).toHaveLength(EVENT_CAP)
    expect(list[0]?.text).toBe('first')
    expect(list[1]?.text).toBe('#13')
    expect(list[EVENT_CAP - 2]?.text).toBe(`#${EVENT_CAP + 10}`)
    expect(list[EVENT_CAP - 1]?.text).toBe('last')
    expect(list.map(e => e.atMs)).toEqual([...list.map(e => e.atMs)].sort((x, y) => x - y))
  })

  test('bare drops the fnd source prefix only; toolName keeps the part after the last __', () => {
    expect(bare('fnd-mcp-slim: compressed 1 B → 0 B')).toBe('compressed 1 B → 0 B')
    expect(bare('fnd scratch-path guard: "/x" would write: here')).toBe('"/x" would write: here')
    expect(bare('outside: the project')).toBe('outside: the project')
    expect(toolName('mcp__plugin_fnd_atlassian__getJiraIssue')).toBe('getJiraIssue')
  })

  test('local HH:MM, k-rounded tokens, a fixed kind column', () => {
    expect(hhmm(NOW)).toBe('09:05')
    expect(hhmm(new Date(2027, 0, 15, 23, 59).getTime())).toBe('23:59')
    expect(fmtK(412_345)).toBe('412k')
    expect(fmtK(38_000)).toBe('38k')
    expect(fmtK(950)).toBe('950')
    expect(kindCell('rate')).toBe('rate     ')
    expect(kindCell('workspace')).toBe('workspace')
  })

  test('wrapped rows: a text takes ceil(len / cols) rows, the newest that fit are kept, one row for the "earlier" line', () => {
    expect(PREFIX_COLS).toBe(18)
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

describe('/fnd-log', () => {
  test('opens the pane, closes it when shown, reopens a pane behind a tab', async ($, on) => {
    const w = world(on)
    await start($)
    expect(await run($, 'fnd-log')).toEqual({ text: 'Log pane opened.' })
    expect(w.opens).toEqual([{ id: PANE, title: 'Log', focus: true, closeOnEscape: true }])
    w.panes = [{ id: PANE, title: 'Log', isShown: true, isFocused: true, isPlaced: true }]
    expect(await run($, 'fnd-log')).toEqual({ text: 'Log pane closed.' })
    expect(w.closes).toEqual([expect.objectContaining({ id: PANE })])
    w.panes = [{ id: PANE, title: 'Log', isShown: false, isFocused: false, isPlaced: true }]
    expect(await run($, 'fnd-log')).toEqual({ text: 'Log pane opened.' })
    expect(w.opens).toHaveLength(2)
    expect(w.closes).toHaveLength(1)
  })

  test('where no surface draws panes (cloud, VS Code chat, -p) the command answers with the log as text', async ($, on) => {
    const w = world(on)
    w.surfaces = []
    await start($)
    expect((await run($, 'fnd-log')).text).toBe('09:05  session    start')
    await switches($, w, 2)
    expect((await run($, 'fnd-log')).text).toBe(
      ['09:05  session    start', '09:05  model      claude-opus-5-5', '09:05  model      claude-fable-5-1'].join('\n'),
    )
    expect(w.opens).toEqual([])
    w.surfaces = ['mobile']
    expect((await run($, 'fnd-log')).text).toContain('claude-fable-5-1')
    expect(w.opens).toEqual([])
  })

  test('an unplaced open → one toast', async ($, on) => {
    const w = world(on)
    w.openResult = { isPlaced: false, reason: 'below 144 columns' }
    await start($)
    expect(await run($, 'fnd-log')).toEqual({ text: 'Log pane not placed: below 144 columns' })
    expect(w.toasts).toEqual(['log pane not placed: below 144 columns'])
  })

  test('both panes open at once: opening Log closes nothing', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, 'fnd-progress')
    w.panes = [{ id: 'fnd-progress', title: 'Progress', isShown: true, isFocused: true, isPlaced: true }]
    await run($, 'fnd-log')
    expect(w.opens.map((o: any) => o.id)).toEqual(['fnd-progress', PANE])
    expect(w.closes).toEqual([])
  })
})

describe('Log button', () => {
  for (const surface of SURFACES) {
    test(`${surface}: a press toggles the pane once each way`, async ($, on) => {
      const w = world(on)
      await start($)
      const ui = await $.ui.mount({ plugin: 'fnd', surface, component: 'AbovePrompt', props: BAND as any })
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
    test(`${surface}: one row per event, oldest first; dim time and kind, the text wraps`, async ($, on) => {
      const w = world(on)
      await start($)
      await switches($, w, 2)
      const ui = await mountPane($, surface)
      const r = await rows(ui)
      expect(r.map(x => x.texts)).toEqual([
        ['09:05  ', 'session    ', 'start'],
        ['09:05  ', 'model      ', 'claude-opus-5-5'],
        ['09:05  ', 'model      ', 'claude-fable-5-1'],
      ])
      expect(r[0]?.props[0]).toMatchObject({ dimColor: true })
      expect(r[0]?.props[1]).toMatchObject({ dimColor: true })
      expect(r[0]?.props[2]).toMatchObject({ wrap: 'wrap' })
      expect(r[0]?.props[2].dimColor).toBeFalsy()
      await ui.unmount()
    })

    test(`${surface}: more events than rows → "… N earlier" and the newest rows`, async ($, on) => {
      const w = world(on)
      await start($)
      await switches($, w, 4)
      const ui = await mountPane($, surface, { scroll: { offset: 0, bodyRows: 3 } })
      const more = await ui.find({ type: 'Text', text: '… 3 earlier' })
      expect(more?.props).toMatchObject({ dimColor: true })
      expect((await rows(ui)).map(x => x.texts[2])).toEqual(['claude-opus-5-5', 'claude-fable-5-1'])
      await ui.unmount()
    })

    test(`${surface}: a text wider than the pane wraps and counts as two rows in the window`, async ($, on) => {
      const w = world(on)
      await start($)
      await switches($, w, 2)
      // bodyColumns 30 → 12 text cells: each model name wraps onto a second row, `start` does not.
      // 4 rows: fable (2) + opus (2) fill them, so opus gives way to the "earlier" row.
      const ui = await mountPane($, surface, { bodyColumns: 30, scroll: { offset: 0, bodyRows: 4 } })
      const more = await ui.find({ type: 'Text', text: '… 2 earlier' })
      expect(more?.props).toMatchObject({ dimColor: true })
      const r = await rows(ui)
      expect(r.map(x => x.texts[2])).toEqual(['claude-fable-5-1'])
      expect(r[0]?.props[2]).toMatchObject({ wrap: 'wrap' })
      const text = (await ui.findAll({ type: 'Box' })).find((b: any) => b.props.width === 12)
      expect(text).toBeTruthy()
      await ui.unmount()
    })

    test(`${surface}: FND_EVENT_LOG=0 → nothing recorded, the pane says so`, async ($, on) => {
      const w = world(on, { FND_EVENT_LOG: '0' })
      await start($)
      await switches($, w, 2)
      const ui = await mountPane($, surface)
      expect((await ui.findAll({ type: 'Text' })).map((t: any) => t.text)).toEqual(['no events yet'])
      expect((await ui.find({ type: 'Text', text: 'no events yet' }))?.props).toMatchObject({ dimColor: true })
      await ui.unmount()
    })
  }
})

/**
 * The slim plugin beside fnd: at session start it writes the slim.events list it owns from the test's
 * SLIM_EVENTS_JSON (an inline plugin's register cannot close over the test's values); unset, nothing.
 */
const SLIM_SIBLING = {
  name: 'slim',
  register(on: On) {
    on('session.start', async ($: any, e: any, next: any) => {
      const raw = await $.env.get('SLIM_EVENTS_JSON')
      if (raw) await $.state.set({ plugin: 'slim', key: 'events' }, JSON.parse(raw))
      return next(e)
    })
  },
}
const SLIM_LINE = 'getJiraIssue: compressed 90,000 B → 7,000 B (−92.2%)'
const LOOKUP_LINE = 'lookup: is the widget loaded? · haiku · 1.2k tok'
const SLIM_EVENTS = [
  { v: 1, atMs: NOW + 30_000, kind: 'slim', text: SLIM_LINE, src: 'slim', tool: 'mcp__x__getJiraIssue', ms: 40, channel: 'mcp', bytesIn: 90_000, bytesOut: 7000, engine: 'json' },
  { v: 1, atMs: NOW + 90_000, kind: 'lookup', text: LOOKUP_LINE, src: 'slim', tool: 'mcp__slim__lookup', ms: 900, model: 'haiku', tokens: null, answered: true },
]
const MERGED_TEXT = [
  '09:05  session    start',
  `09:05  slim       ${SLIM_LINE}`,
  '09:06  model      claude-opus-5-5',
  `09:06  lookup     ${LOOKUP_LINE}`,
].join('\n')

/** fnd's session line at NOW, slim's line at +30 s, fnd's model line at +60 s, slim's lookup at +90 s. */
async function interleave($: any, w: ReturnType<typeof world>): Promise<void> {
  await start($)
  await w.clock.advance(60_000)
  await switches($, w, 1)
}

describe('slim.events in the log', () => {
  test('merged: oldest first, fnd first on a tie, malformed foreign entries dropped', () => {
    const fnd = [
      { atMs: 10, kind: 'session' as const, text: 'start' },
      { atMs: 30, kind: 'model' as const, text: 'm' },
    ]
    const foreign = [
      { atMs: 30, kind: 'slim', text: 'tie' },
      { atMs: 20, kind: 'lookup', text: 'mid', extra: 1 },
      { atMs: 'x', kind: 'slim', text: 'bad time' },
      { atMs: 5, kind: 3, text: 'bad kind' },
      { atMs: Number.NaN, kind: 'slim', text: 'nan' },
      null,
    ]
    expect(merged(fnd, foreign).map(e => e.text)).toEqual(['start', 'mid', 'm', 'tie'])
    expect(merged(fnd, foreign)[1]).toEqual({ atMs: 20, kind: 'lookup', text: 'mid' })
    expect(merged(fnd, [])).toEqual(fnd)
    expect(merged(fnd, null as any)).toEqual(fnd)
  })

  test("merged: beside slim's lines fnd's own compression line reads fnd-slim; alone it stays slim", () => {
    const fnd = [{ atMs: 10, kind: 'slim' as const, text: 'getJiraIssue: compressed 9 B → 1 B' }]
    expect(merged(fnd, [{ atMs: 20, kind: 'slim', text: 'Bash: compressed' }]).map(e => e.kind)).toEqual(['fnd-slim', 'slim'])
    expect(merged(fnd, []).map(e => e.kind)).toEqual(['slim'])
    expect(kindCell('fnd-slim')).toBe('fnd-slim ')
  })

  test('where no surface draws panes the text answer interleaves both logs', { plugins: [SLIM_SIBLING] }, async ($, on) => {
    const w = world(on, { SLIM_EVENTS_JSON: JSON.stringify(SLIM_EVENTS) })
    w.surfaces = []
    await interleave($, w)
    expect((await run($, 'fnd-log')).text).toBe(MERGED_TEXT)
  })

  for (const surface of SURFACES) {
    test(`${surface}: slim's lines sit between fnd's by time, their kind in the kind cell`, { plugins: [SLIM_SIBLING] }, async ($, on) => {
      const w = world(on, { SLIM_EVENTS_JSON: JSON.stringify(SLIM_EVENTS) })
      await interleave($, w)
      const ui = await mountPane($, surface)
      expect((await rows(ui)).map(x => x.texts)).toEqual([
        ['09:05  ', 'session    ', 'start'],
        ['09:05  ', 'slim       ', SLIM_LINE],
        ['09:06  ', 'model      ', 'claude-opus-5-5'],
        ['09:06  ', 'lookup     ', LOOKUP_LINE],
      ])
      await ui.unmount()
    })

    test(`${surface}: "… N earlier" counts the merged list`, { plugins: [SLIM_SIBLING] }, async ($, on) => {
      const w = world(on, { SLIM_EVENTS_JSON: JSON.stringify(SLIM_EVENTS) })
      await interleave($, w)
      const ui = await mountPane($, surface, { bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 } })
      expect(await ui.find({ type: 'Text', text: '… 2 earlier' })).toBeTruthy()
      expect((await rows(ui)).map(x => x.texts[2])).toEqual(['claude-opus-5-5', LOOKUP_LINE])
      await ui.unmount()
    })

    for (const [name, env] of [
      ['slim absent', {}],
      ['slim.events empty', { SLIM_EVENTS_JSON: '[]' }],
      ['slim.events malformed', { SLIM_EVENTS_JSON: JSON.stringify([{ atMs: 'x', kind: 'slim', text: 'bad' }, { kind: 'slim' }]) }],
    ] as const) {
      test(`${surface}: ${name} → fnd's lines only`, { plugins: [SLIM_SIBLING] }, async ($, on) => {
        const w = world(on, env)
        await interleave($, w)
        const ui = await mountPane($, surface)
        expect((await rows(ui)).map(x => x.texts[1])).toEqual(['session    ', 'model      '])
        await ui.unmount()
      })
    }
  }
})
