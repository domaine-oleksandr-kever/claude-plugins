import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { MOVED, bandLive } from '../core/events.ts'

const T0 = 1_800_000_000_000
const ROOT = '/repo'
const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
const KEPT = [{ role: 'assistant', text: 'summary', toolUses: [] }]
const INFO = { v: 1, version: '0.1.0', disabled: false }
const DISABLED = { ...INFO, disabled: true }
const OWN_KINDS = ['session', 'model', 'compact', 'rate']

type Pane = { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }

/** The band plugin as fnd sees it: band.info from SIB_BAND_INFO at session.start, or from the args of `sib-band`. */
const BAND_SIB = {
  name: 'band',
  tier: 'prepend' as const,
  register(on: any) {
    on('session.start', async ($: any, e: any, next: any) => {
      const raw = await $.env.get('SIB_BAND_INFO')
      if (raw) await $.state.set({ plugin: 'band', key: 'info' }, JSON.parse(raw))
      return next(e)
    })
    on('command.run', { command: 'sib-band' }, async ($: any, e: any) => {
      await $.state.set({ plugin: 'band', key: 'info' }, JSON.parse(e.args))
      return { text: 'ok' }
    })
  },
}

/** Reads fnd's own state from beside it. */
const PEEK = {
  name: 'peek',
  register(on: any) {
    const answer = (value: unknown) => ({ text: JSON.stringify(value ?? null) })
    on('command.run', { command: 'peek-usage' }, async ($: any) => answer((await $.state.get({ plugin: 'fnd', key: 'usage' } as const)).value))
    on('command.run', { command: 'peek-tick' }, async ($: any) => answer((await $.state.get({ plugin: 'fnd', key: 'tick' } as const)).value))
    on('command.run', { command: 'peek-events' }, async ($: any) => answer((await $.state.get({ plugin: 'fnd', key: 'events' } as const)).value))
    on('command.run', { command: 'peek-pin' }, async ($: any) => answer((await $.state.get({ plugin: 'fnd', key: 'pin' } as const)).value))
    on('command.run', { command: 'peek-focused' }, async ($: any) => answer((await $.state.get({ plugin: 'fnd', key: 'bandFocused' } as const)).value))
  },
}
const PLUGINS = [BAND_SIB, PEEK]

/** Every op fnd's modules call, over one workspace `ELC-1591` on its branch; `w` records what reached the bottom. */
function world(on: On, env: Record<string, string> = {}) {
  const w = {
    surfaces: ['terminal'] as string[],
    panes: [] as Pane[],
    opens: [] as unknown[],
    toasts: [] as string[],
    markers: [] as string[],
    registered: [] as string[],
    bottom: 0,
    compact: (async () => ({ messages: KEPT })) as () => Promise<unknown>,
    model: 'claude-fable-5-1',
  }
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  mock.env(on, { TMPDIR: '/sandbox', ...env })
  const files: Record<string, string> = { [`${ROOT}/.claude/tasks/ELC-1591/progress.md`]: '- [x] Read\n- [ ] QA' }
  const isDir = (path: string) => Object.keys(files).some(p => p.startsWith(`${path}/`))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('session.root', async () => ({ value: ROOT }))
  on('session.cwd', async () => ({ value: ROOT }))
  on('session.id', async () => ({ value: 's1' }))
  on('session.model', async () => ({ value: w.model }))
  on('session.surfaces', async () => ({ value: w.surfaces }))
  on('session.usage', async () => ({ value: { startedAt: T0, context: { window: 200_000, percent: 40 }, rateLimits: [] } }))
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  on('session.compact', async () => (await w.compact()) as never)
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('classic.PostModelSwitch', async () => ({}) as never)
  on('classic.PostCompact', async () => ({}) as never)
  on('classic.SessionStart', async () => ({}) as never)
  on('prompt.submit', async (_$, e) => {
    w.bottom++
    return { text: e.text }
  })
  on('command.register', async (_$, e) => {
    w.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('process.run', async () => ({
    value: { exitCode: 0, stdout: 'feature/ELC-1591-x\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.write', async (_$, e: any) => {
    if (String(e.path).includes('/fnd-mod-session-')) w.markers.push(e.path)
    return { value: undefined }
  })
  on('fs.stat', async (_$, e) => {
    if (e.path in files) return { value: { kind: 'file' as const, size: 1, mtimeMs: T0 - 60_000, isLink: false } }
    if (isDir(e.path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.list', async (_$, e) => {
    const names = new Set(Object.keys(files).filter(p => p.startsWith(`${e.path}/`)).map(p => p.slice(e.path.length + 1).split('/')[0] ?? ''))
    if (names.size === 0) throw new Error(`ENOENT: ${e.path}`)
    return { value: [...names].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', async (_$, e) => {
    if (!(e.path in files)) throw new Error(`ENOENT: ${e.path}`)
    return { value: files[e.path]! }
  })
  on('ui.focus', async () => ({}))
  on('ui.panes', async () => ({ value: w.panes }))
  on('ui.open', async (_$, e) => {
    w.opens.push(e)
    w.panes.push({ id: e.id, title: e.title ?? '', isShown: true, isFocused: true, isPlaced: true })
    return { value: { isPlaced: true } }
  })
  on('ui.close', async () => ({ value: undefined }))
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

const start = ($: any, surface: Surface = 'terminal') => $.session.start({ cwd: ROOT, surface, isInteractive: true })
const run = async ($: any, command: string, args = ''): Promise<string> =>
  (await $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })).text
const peek = async ($: any, what: string) => JSON.parse(await run($, `peek-${what}`))
const ownKinds = async ($: any): Promise<string[]> =>
  ((await peek($, 'events')) ?? []).filter((ev: any) => OWN_KINDS.includes(ev.kind)).map((ev: any) => `${ev.kind} ${ev.text}`)
const submit = ($: any, text = 'hi') => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as any)
const measure = ($: any, percent: number, rateLimits: { kind: string; percentUsed: number }[] = []) =>
  $.session.measure({ context: { window: 200_000, percent }, rateLimits, changed: ['context', 'rateLimits'] })

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { bodyRows: 10 }, view: {} }
const mount = ($: any, surface: Surface) =>
  $.ui.mount({ plugin: 'fnd', surface, component: 'AbovePrompt', props: BAND_PROPS as any })
const strOf = (n: any): string => (n?.children ?? []).filter((c: any) => typeof c === 'string').join('')
const allText = (n: any): string[] =>
  !n || typeof n !== 'object' ? [] : [...(n.type === 'Text' ? [strOf(n)] : []), ...(n.children ?? []).flatMap(allText)]
const drawsEngineBand = async (ui: any) => allText(await ui.drawn()).includes('engine band')

const withBand = (info: unknown, env: Record<string, string> = {}) => ({ ...env, SIB_BAND_INFO: JSON.stringify(info) })

describe('without band: fnd as before', () => {
  test('fnd draws the band, writes the marker, /fnd-log opens its pane', { plugins: PLUGINS }, async ($, on) => {
    const { w } = world(on)
    await start($)
    await measure($, 40)
    const ui = await mount($, 'terminal')
    expect(await drawsEngineBand(ui)).toBe(false)
    expect(await ui.find({ key: 'compact' })).toBeDefined()
    await submit($)
    expect(w.markers).toEqual(['/sandbox/fnd-mod-session-s1'])
    expect(await run($, 'fnd-log')).toBe('Log pane opened.')
    expect(await run($, 'fnd-band')).toMatch(/^fnd band debug\n/)
    expect(await ownKinds($)).toEqual(['session start'])
  })
})

describe('band loaded: fnd yields', () => {
  for (const surface of SURFACES) {
    for (const info of [INFO, DISABLED]) {
      test(`${surface}, disabled ${info.disabled}: AbovePrompt passes to the hook beneath`, { plugins: PLUGINS }, async ($, on) => {
        world(on, withBand(info))
        await start($, surface)
        await measure($, 60)
        const ui = await mount($, surface)
        expect(await drawsEngineBand(ui)).toBe(true)
        expect(await ui.find({ key: 'compact' })).toBeUndefined()
      })
    }

    for (const statusBand of [true, false]) {
      test(`${surface}: statusBand ${statusBand} still yields`, { plugins: PLUGINS, options: { statusBand } }, async ($, on) => {
        world(on, withBand(INFO))
        await start($, surface)
        await measure($, 60)
        expect(await drawsEngineBand(await mount($, surface))).toBe(true)
      })
    }

    test(`${surface}: band.info written after the first draw → the band redraws and yields`, { plugins: PLUGINS }, async ($, on) => {
      world(on)
      await start($, surface)
      await measure($, 60)
      const ui = await mount($, surface)
      expect(await drawsEngineBand(ui)).toBe(false)
      await run($, 'sib-band', JSON.stringify(INFO))
      expect(await drawsEngineBand(ui)).toBe(true)
    })
  }

  for (const info of [INFO, DISABLED]) {
    test(`marker not written (disabled ${info.disabled}); the prompt still reaches the bottom`, { plugins: PLUGINS }, async ($, on) => {
      const { w } = world(on, withBand(info))
      await start($)
      await submit($)
      await submit($, 'again')
      expect(w.markers).toEqual([])
      expect(w.bottom).toBe(2)
    })
  }

  test('/fnd-log answers the pointer and opens nothing', { plugins: PLUGINS }, async ($, on) => {
    const { w } = world(on, withBand(INFO))
    await start($)
    expect(w.registered).toContain('fnd-log')
    expect(await run($, 'fnd-log')).toBe(MOVED.log)
    w.surfaces = ['web']
    expect(await run($, 'fnd-log')).toBe(MOVED.log)
    expect(w.opens).toEqual([])
  })

  test("/fnd-progress → the pointer; <KEY> pins and refreshes, opens nothing; '-' unpins", { plugins: PLUGINS }, async ($, on) => {
    const { w } = world(on, withBand(INFO))
    await start($)
    expect(await run($, 'fnd-progress')).toBe(MOVED.progress)
    expect(await run($, 'fnd-progress', 'ELC-1591')).toBe(`Pinned ELC-1591. ${MOVED.progress}`)
    expect(await peek($, 'pin')).toBe('ELC-1591')
    expect(await run($, 'fnd-progress', 'ELC-9')).toBe(`Pinned ELC-9. ${MOVED.progress} ELC-9 has no task workspace.`)
    expect(await run($, 'fnd-progress', '-')).toBe(`Unpinned. ${MOVED.progress}`)
    expect(await peek($, 'pin')).toBe(null)
    expect(await run($, 'fnd-progress', 'not an id')).toBe('Not a work id: not an id')
    expect(w.opens).toEqual([])
  })

  test('measure writes no fnd.usage, no rate toast, no rate event', { plugins: PLUGINS }, async ($, on) => {
    const { w } = world(on, withBand(INFO))
    await start($)
    const before = await peek($, 'usage')
    await measure($, 60, [{ kind: 'five_hour', percentUsed: 95 }])
    expect(await peek($, 'usage')).toEqual(before)
    expect(w.toasts).toEqual([])
    expect(await ownKinds($)).toEqual([])
  })

  test('session start / clear / resume / model switch / compact log no fnd.events of band kinds', { plugins: PLUGINS }, async ($, on) => {
    const { w } = world(on, withBand(INFO))
    await start($)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 60 } as any)
    w.model = 'claude-opus-5-5'
    await $.classic.PostModelSwitch({ from_model: 'claude-fable-5-1', to_model: 'claude-opus-5-5', source: 'command', cache_ttl: '1h', prompt_cache_warm: true } as any)
    w.compact = async () => ({ messages: KEPT, tokensBefore: 412_345, tokensAfter: 38_000 })
    await $.session.compact({ trigger: 'manual', messages: KEPT } as any)
    await $.classic.PostCompact({ session_id: 's1', transcript_path: '/t.jsonl', cwd: ROOT, trigger: 'auto', compact_summary: 's' } as any)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as any)
    expect(await ownKinds($)).toEqual([])
    expect(await peek($, 'tick')).toBe(null)
  })

  test('/fnd-band is registered and answers the pointer', { plugins: PLUGINS }, async ($, on) => {
    const { w } = world(on, withBand(DISABLED))
    await start($)
    expect(w.registered).toContain('fnd-band')
    expect(await run($, 'fnd-band')).toBe(MOVED.debug)
  })

  test('ui.focus on the band never writes fnd.bandFocused', { plugins: PLUGINS }, async ($, on) => {
    world(on, withBand(INFO))
    await start($)
    await mount($, 'terminal')
    const r = await $.ui.focus({ component: 'AbovePrompt', requestId: 'band', origin: { kind: 'person' }, element: 'compact' } as never)
    expect(r.deny).toBeUndefined()
    expect(await peek($, 'focused')).toBe(null)
  })

  test('band loads after fnd started: the tick, the measure and the rate alarm stand down from then on', { plugins: PLUGINS }, async ($, on) => {
    const { w, clock } = world(on)
    await start($)
    const tick = await peek($, 'tick')
    expect(tick).toBe(T0)
    await run($, 'sib-band', JSON.stringify(INFO))
    const usage = await peek($, 'usage')
    await clock.advance(30_000)
    expect(await peek($, 'tick')).toBe(tick)
    await measure($, 70, [{ kind: 'five_hour', percentUsed: 95 }])
    expect(await peek($, 'usage')).toEqual(usage)
    expect(w.toasts).toEqual([])
    expect(await ownKinds($)).toEqual(['session start'])
  })
})

/** A band that loads beneath fnd and draws as the real one does: its own row unless disabled, the hook beneath then. */
const DRAWING_BAND = {
  name: 'band',
  tier: 'append' as const,
  register(on: any) {
    on('session.start', async ($: any, e: any, next: any) => {
      const raw = await $.env.get('SIB_BAND_INFO')
      if (raw) await $.state.set({ plugin: 'band', key: 'info' }, JSON.parse(raw))
      return next(e)
    })
    on('ui.render', { component: 'AbovePrompt' }, async ($: any, e: any, next: any) => {
      const info = (await $.state.get({ plugin: 'band', key: 'info' } as const)).value
      if (!info || info.disabled) return next(e)
      const { Text } = $.ui.resolve(e)
      return <Text>band plugin row</Text>
    })
  },
}

describe('fnd beside a band that draws beneath it', () => {
  const drawn = async (ui: any) => {
    const texts = allText(await ui.drawn())
    return { band: texts.includes('band plugin row'), engine: texts.includes('engine band'), fnd: (await ui.find({ key: 'compact' })) !== undefined }
  }
  for (const surface of SURFACES) {
    test(`${surface}: band.info seeded → band's row shows, fnd's does not`, { plugins: [DRAWING_BAND] }, async ($, on) => {
      world(on, withBand(INFO))
      await start($, surface)
      await measure($, 60)
      expect(await drawn(await mount($, surface))).toEqual({ band: true, engine: false, fnd: false })
    })
    test(`${surface}: band disabled → neither draws; the engine's band shows`, { plugins: [DRAWING_BAND] }, async ($, on) => {
      world(on, withBand(DISABLED))
      await start($, surface)
      await measure($, 60)
      expect(await drawn(await mount($, surface))).toEqual({ band: false, engine: true, fnd: false })
    })
    test(`${surface}: band.info null → fnd draws its own band`, { plugins: [DRAWING_BAND] }, async ($, on) => {
      world(on)
      await start($, surface)
      await measure($, 60)
      expect(await drawn(await mount($, surface))).toEqual({ band: false, engine: false, fnd: true })
    })
  }
})

describe('bandLive', () => {
  test('null / undefined / a string → false; an object → true', () => {
    expect(bandLive(null)).toBe(false)
    expect(bandLive(undefined)).toBe(false)
    expect(bandLive('0.1.0')).toBe(false)
    expect(bandLive(INFO)).toBe(true)
    expect(bandLive({})).toBe(true)
  })
})
