import { describe, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { NO_CHECKLIST_TEXT } from '../checklist.tsx'
import { SNAP, SURFACES, peek, sibBase, test } from './world.tsx'

const NOW = 1_800_000_000_000
const PANE = 'band-progress'

type Pane = { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }

/** The engine beneath band, with base's task snapshot fed from `vars`, and a pane host that records opens, closes and toasts. */
function world(on: On, o: { progress?: unknown; panes?: Pane[] } = {}) {
  const w = {
    vars: (o.progress === undefined ? {} : { SIB_BASE_PROGRESS: JSON.stringify(o.progress) }) as Record<string, string>,
    panes: o.panes ?? ([] as Pane[]),
    openResult: { isPlaced: true } as { isPlaced: true } | { isPlaced: false; reason: string },
    opens: [] as unknown[],
    closes: [] as unknown[],
    toasts: [] as string[],
    surfaces: ['terminal'] as string[],
  }
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('env.get', async (_$, e) => ({ value: w.vars[e.name] }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 's1' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', async () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.surfaces', async () => ({ value: w.surfaces }))
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
const run = ($: any) =>
  $.command.run({ command: 'band-progress', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
const shown = (): Pane => ({ id: PANE, title: 'Progress', isShown: true, isFocused: true, isPlaced: true })
const BAND = { bodyColumns: 200, hasSurvey: false, isWorking: false, maxRows: 4, scroll: { offset: 0, bodyRows: 1 }, view: {} }
const PANE_PROPS = { title: 'Progress', isFocused: false, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 10 }, view: {} }
const mountPane = ($: any, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({ plugin: 'band', surface, component: 'Pane', requestId: PANE, props: PANE_PROPS as any })
const textsOf = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)

describe('/band-progress', () => {
  for (const [name, progress] of [
    ['no base', undefined],
    ['base published null', null],
    ['base resolved no task', { workId: null, branch: 'main' }],
    ['a malformed snapshot', { workId: 42 }],
  ] as const) {
    test(`${name} → the no-checklist answer, nothing opened`, async ($, on) => {
      const w = world(on, { progress })
      await start($)
      expect(await run($)).toEqual({ text: NO_CHECKLIST_TEXT })
      expect(w.opens).toEqual([])
      expect((await peek($)).paneShown).toBeFalsy()
    })
  }

  test('the no-checklist answer names the base pin command', () => {
    expect(NO_CHECKLIST_TEXT).toContain('/base-progress <KEY>')
  })

  test('opens the pane as a dialog without holdToasts and sets paneShown; a second run closes it', async ($, on) => {
    const w = world(on, { progress: SNAP })
    await start($)
    expect(await run($)).toEqual({ text: 'Progress pane opened.' })
    expect(w.opens).toEqual([{ id: PANE, title: 'Progress', focus: true, closeOnEscape: true }])
    expect((await peek($)).paneShown).toBe(true)
    w.panes = [shown()]
    expect(await run($)).toEqual({ text: 'Progress pane closed.' })
    expect(w.closes).toEqual([expect.objectContaining({ id: PANE })])
    expect((await peek($)).paneShown).toBe(false)
  })

  test('a shown pane closes even after the task went away', async ($, on) => {
    const w = world(on, { progress: SNAP })
    await start($)
    await run($)
    w.panes = [shown()]
    w.vars.SIB_BASE_PROGRESS = 'null'
    await sibBase($)
    expect(await run($)).toEqual({ text: 'Progress pane closed.' })
  })

  test('where no surface draws panes (cloud, VS Code chat, -p) it answers with the checklist as text', async ($, on) => {
    const w = world(on, { progress: { ...SNAP, notesTail: ['- decision: keep the toggle'] } })
    w.surfaces = []
    await start($)
    expect(await run($)).toEqual({
      text: [
        'ELC-1591 · feature/ELC-1591-x · 3/5',
        '✓ Read',
        '✓ Plan',
        '✓ Branch',
        '▶ Preview themes',
        '☐ QA',
        '- decision: keep the toggle',
      ].join('\n'),
    })
    w.surfaces = ['mobile']
    w.vars.SIB_BASE_PROGRESS = 'null'
    await sibBase($)
    expect(await run($)).toEqual({ text: NO_CHECKLIST_TEXT })
    expect(w.opens).toEqual([])
    expect((await peek($)).paneShown).toBeFalsy()
  })

  test('an unplaced open → one toast, paneShown stays false', async ($, on) => {
    const w = world(on, { progress: SNAP })
    w.openResult = { isPlaced: false, reason: 'below 144 columns' }
    await start($)
    expect(await run($)).toEqual({ text: 'Progress pane not placed: below 144 columns' })
    expect(w.toasts).toEqual(['progress pane not placed: below 144 columns'])
    expect((await peek($)).paneShown).toBeFalsy()
  })
})

describe('disabled', () => {
  test('the band is hidden, the panes and their commands are not', { options: { disabled: true } }, async ($, on) => {
    const w = world(on, { progress: SNAP })
    await start($)
    expect(await run($)).toEqual({ text: 'Progress pane opened.' })
    expect((await peek($)).paneShown).toBe(true)
    const log = await $.command.run({ command: 'band-log', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    expect(log).toEqual({ text: 'Log pane opened.' })
    expect(w.opens.map((o: any) => o.id)).toEqual([PANE, 'band-log'])
  })
})

describe('Progress button', () => {
  for (const surface of SURFACES) {
    test(`${surface}: a p press toggles the pane once each way`, async ($, on) => {
      const w = world(on, { progress: SNAP })
      await start($)
      const ui = await $.ui.mount({ plugin: 'band', surface, component: 'AbovePrompt', props: BAND as any })
      await ui.press({ key: 'progress' })
      expect(w.opens).toHaveLength(1)
      expect((await peek($)).paneShown).toBe(true)
      w.panes = [shown()]
      await ui.press({ key: 'progress' })
      expect(w.opens).toHaveLength(1)
      expect(w.closes).toHaveLength(1)
      expect((await peek($)).paneShown).toBe(false)
      await ui.unmount()
    })
  }
})

describe('paneShown', () => {
  test('session.start seeds it from a placed pane', async ($, on) => {
    world(on, { progress: SNAP, panes: [{ ...shown(), isShown: false }] })
    await start($)
    expect((await peek($)).paneShown).toBe(true)
  })

  test('session.start with no band-progress pane → false', async ($, on) => {
    world(on, { progress: SNAP, panes: [{ id: 'other', title: 'x', isShown: true, isFocused: false, isPlaced: true }] })
    await start($)
    expect((await peek($)).paneShown).toBe(false)
  })
})

describe('the pane', () => {
  const ROWS = [
    { mark: 'done', text: 'Read the ticket' },
    { mark: 'waiting', text: 'Owner: reinstall' },
    { mark: 'done', text: 'Branch' },
    { mark: 'current', text: 'Preview themes' },
    { mark: 'todo', text: 'QA' },
  ]

  for (const surface of SURFACES) {
    test(`${surface}: bold title · subtitle, ✓ ◌ dim, ▶ bold, ☐ plain, the footer dim`, async ($, on) => {
      world(on, { progress: { ...SNAP, done: 2, rows: ROWS, notesTail: ['- two', '- three'] } })
      await start($)
      const ui = await mountPane($, surface)
      expect(await textsOf(ui)).toEqual([
        'ELC-1591 · feature/ELC-1591-x · 2/5',
        '✓ Read the ticket',
        '◌ Owner: reinstall',
        '✓ Branch',
        '▶ Preview themes',
        '☐ QA',
        '- two',
        '- three',
      ])
      expect((await ui.find({ type: 'Text', text: 'ELC-1591 · feature/ELC-1591-x · 2/5' }))?.props).toMatchObject({ bold: true, wrap: 'truncate-end' })
      expect((await ui.find({ type: 'Text', text: '✓ Read the ticket' }))?.props).toMatchObject({ dimColor: true })
      const waiting = await ui.find({ type: 'Text', text: '◌ Owner: reinstall' })
      expect(waiting?.props).toMatchObject({ dimColor: true })
      expect(waiting?.props.bold).toBeFalsy()
      expect((await ui.find({ type: 'Text', text: '▶ Preview themes' }))?.props).toMatchObject({ bold: true })
      const todo = await ui.find({ type: 'Text', text: '☐ QA' })
      expect(todo?.props.bold).toBeFalsy()
      expect(todo?.props.dimColor).toBeFalsy()
      const footer = await ui.findAll({ type: 'Text', text: /^- / })
      expect(footer.every((f: any) => f.props.dimColor === true)).toBe(true)
      await ui.unmount()
    })

    test(`${surface}: a named ticket without a workspace → the header, then the no-workspace hint`, async ($, on) => {
      world(on, { progress: { workId: 'ELC-77', branch: 'feature/ELC-1591-x', hasWorkspace: false, done: 0, total: 0, current: null, rows: [], notesTail: [], mtimeMs: 0 } })
      await start($)
      const ui = await mountPane($, surface)
      expect(await textsOf(ui)).toEqual(['ELC-77 · feature/ELC-1591-x', 'no task workspace — /base:save-task-context'])
      expect((await ui.find({ type: 'Text', text: /^no task workspace/ }))?.props).toMatchObject({ dimColor: true })
      await ui.unmount()
    })

    test(`${surface}: a workspace without progress.md → the no-progress.md hint`, async ($, on) => {
      world(on, { progress: { ...SNAP, branch: null, done: 0, total: 0, current: null, rows: [], notesTail: [] } })
      await start($)
      const ui = await mountPane($, surface)
      expect(await textsOf(ui)).toEqual(['ELC-1591', 'no progress.md yet — /base:save-task-context'])
      await ui.unmount()
    })

    test(`${surface}: the task nulled while the pane is open → 'no task checklist'; a new one redraws it`, async ($, on) => {
      const w = world(on, { progress: SNAP })
      await start($)
      const ui = await mountPane($, surface)
      expect((await textsOf(ui))[0]).toBe('ELC-1591 · feature/ELC-1591-x · 3/5')
      w.vars.SIB_BASE_PROGRESS = JSON.stringify({ workId: null, branch: 'main' })
      await sibBase($)
      expect(await textsOf(ui)).toEqual(['no task checklist'])
      expect((await ui.find({ type: 'Text', text: 'no task checklist' }))?.props).toMatchObject({ dimColor: true })
      w.vars.SIB_BASE_PROGRESS = JSON.stringify({ ...SNAP, workId: 'ELC-9', done: 5, current: null })
      await sibBase($)
      expect((await textsOf(ui))[0]).toBe('ELC-9 · feature/ELC-1591-x · 5/5')
      await ui.unmount()
    })
  }
})
