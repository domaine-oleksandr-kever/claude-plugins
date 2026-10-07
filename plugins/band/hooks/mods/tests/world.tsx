// Shared test kit for band's suites: the engine beneath band, the fnd and slim plugins beside it (inline, fed
// from env), and a reader of band's own state. Not a test file itself: only *.test.ts(x) run.
import { mock, test as kitTest } from 'claude-code/testing'
import type { On } from 'claude-code'

export const MIN = 60_000
export const T0 = 1_700_000_000_000
export const KEPT = [{ role: 'assistant', text: 'summary', toolUses: [] }]
export const SURFACES = ['terminal', 'desktop'] as const
export type Surface = (typeof SURFACES)[number]

/**
 * fnd beside band: writes the fnd.events and fnd.progress it owns from SIB_FND_EVENTS / SIB_FND_PROGRESS
 * (JSON; unset → not written) at session start and on /sib-fnd. An inline plugin closes over nothing of
 * the test file and the validator follows `$` into no helper, so each hook spells its calls out.
 */
export const FND_SIBLING = {
  name: 'fnd',
  register(on: On) {
    on('session.start', async ($: any, e: any, next: any) => {
      const events = await $.env.get('SIB_FND_EVENTS')
      if (events) await $.state.set({ plugin: 'fnd', key: 'events' }, JSON.parse(events))
      const progress = await $.env.get('SIB_FND_PROGRESS')
      if (progress) await $.state.set({ plugin: 'fnd', key: 'progress' }, JSON.parse(progress))
      return next(e)
    })
    on('command.run', { command: 'sib-fnd' } as any, async ($: any) => {
      const events = await $.env.get('SIB_FND_EVENTS')
      if (events) await $.state.set({ plugin: 'fnd', key: 'events' }, JSON.parse(events))
      const progress = await $.env.get('SIB_FND_PROGRESS')
      if (progress) await $.state.set({ plugin: 'fnd', key: 'progress' }, JSON.parse(progress))
      return { text: 'ok' }
    })
  },
}

/** slim beside band: writes slim.events from SIB_SLIM_EVENTS at session start and on /sib-slim. */
export const SLIM_SIBLING = {
  name: 'slim',
  register(on: On) {
    on('session.start', async ($: any, e: any, next: any) => {
      const events = await $.env.get('SIB_SLIM_EVENTS')
      if (events) await $.state.set({ plugin: 'slim', key: 'events' }, JSON.parse(events))
      return next(e)
    })
    on('command.run', { command: 'sib-slim' } as any, async ($: any) => {
      const events = await $.env.get('SIB_SLIM_EVENTS')
      if (events) await $.state.set({ plugin: 'slim', key: 'events' }, JSON.parse(events))
      return { text: 'ok' }
    })
  },
}

/** Reads band's own state from beside it: any plugin reads any value. */
export const PEEK = {
  name: 'peek',
  register(on: On) {
    on('command.run', { command: 'peek' } as any, async ($: any) => ({
      text: JSON.stringify({
        info: (await $.state.get({ plugin: 'band', key: 'info' })).value ?? null,
        usage: (await $.state.get({ plugin: 'band', key: 'usage' })).value ?? null,
        model: (await $.state.get({ plugin: 'band', key: 'model' })).value ?? null,
        cache: (await $.state.get({ plugin: 'band', key: 'cache' })).value ?? null,
        tick: (await $.state.get({ plugin: 'band', key: 'tick' })).value ?? null,
        paneShown: (await $.state.get({ plugin: 'band', key: 'paneShown' })).value ?? null,
        bandFocused: (await $.state.get({ plugin: 'band', key: 'bandFocused' })).value ?? null,
        events: (await $.state.get({ plugin: 'band', key: 'events' })).value ?? [],
      }),
    }))
  },
}

export const SIBLINGS = [FND_SIBLING, SLIM_SIBLING, PEEK]

/** The kit's test with fnd, slim and the reader loaded beside band in every test, and a test's own plugins after them. */
export const test = (name: string, ...rest: any[]): void => {
  const [options, body] = rest.length === 1 ? [{}, rest[0]] : [rest[0], rest[1]]
  kitTest(name, { ...options, plugins: [...SIBLINGS, ...(options.plugins ?? [])] }, body)
}

export const peek = async ($: any): Promise<any> => JSON.parse((await $.command.run({ command: 'peek', args: '' })).text)
export const peekCache = async ($: any) => (await peek($)).cache
export const peekEvents = async ($: any): Promise<{ atMs: number; kind: string; text: string }[]> => (await peek($)).events
export const logged = async ($: any) => (await peekEvents($)).map(ev => `${ev.kind} ${ev.text}`)
export const sibFnd = ($: any) => $.command.run({ command: 'sib-fnd', args: '' })
export const sibSlim = ($: any) => $.command.run({ command: 'sib-slim', args: '' })

/** fnd's resolved task as fnd 0.134.0 writes it: ELC-1591, three of five rows done. */
export const SNAP = {
  workId: 'ELC-1591',
  branch: 'feature/ELC-1591-x',
  hasWorkspace: true,
  done: 3,
  total: 5,
  current: 'Preview themes',
  rows: [
    { mark: 'done', text: 'Read' },
    { mark: 'done', text: 'Plan' },
    { mark: 'done', text: 'Branch' },
    { mark: 'current', text: 'Preview themes' },
    { mark: 'todo', text: 'QA' },
  ],
  notesTail: [],
  mtimeMs: T0,
}
export const TASK = { SIB_FND_PROGRESS: JSON.stringify(SNAP) }

type Ctx = { window: number; percent?: number; tokens?: number }
type Rate = { kind: string; percentUsed: number; resetsAt?: string }
type Cost = { usd: number }
type PaneRow = { id: string; isShown: boolean; isPlaced: boolean }

/**
 * The engine beneath band: clock, a recording store, a mutable env (`vars`), the session ops usage.ts
 * calls, a pane host and a toast recorder.
 */
export function world(on: On, store: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const w = {
    context: { window: 200_000 } as Ctx,
    rateLimits: [] as Rate[],
    cost: undefined as Cost | undefined,
    model: 'claude-fable-5-1' as string | null,
    toasts: [] as string[],
    storeSets: [] as { key: string; value: unknown }[],
    compact: (async () => ({ messages: KEPT })) as () => Promise<unknown>,
    panes: [] as PaneRow[],
    vars: { ...env } as Record<string, string>,
    surfaces: ['terminal'] as string[],
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
  on('env.get', async (_$, e) => ({ value: w.vars[e.name] }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  // band's own manifest, as info.ts reads it for band.info and the start line.
  on('fs.read', async () => ({ value: JSON.stringify({ name: 'band', version: '9.9.9' }) }))
  on('session.id', async () => ({ value: 's1' }))
  on('session.root', async () => ({ value: '/repo' }))
  on('session.surfaces', async () => ({ value: w.surfaces }) as never)
  on('session.usage', async () => ({ value: { startedAt: T0, context: w.context, rateLimits: w.rateLimits, cost: w.cost } }))
  on('session.model', async () => ({ value: w.model }))
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  on('session.compact', async () => (await w.compact()) as never)
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }) as never)
  on('ui.focus', async () => ({}))
  on('ui.toast', async (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.panes', async () => ({ value: w.panes }) as never)
  on('ui.open', async (_$, e) => {
    w.panes.push({ id: e.id, isShown: true, isPlaced: true })
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', async () => {
    w.panes.length = 0
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  return { w, clock }
}

export const start = ($: any, surface: Surface = 'terminal') =>
  $.session.start({ cwd: '/repo', surface, isInteractive: true })

export const measure = ($: any, context: Ctx, rateLimits: Rate[] = [], cost?: Cost) =>
  $.session.measure({ context, rateLimits, ...(cost ? { cost } : {}), changed: ['context', 'rateLimits'] })

export const mainTurn = ($: any, agentId?: string) =>
  $.turn.complete({
    answer: '',
    durationMs: 1,
    isAborted: false,
    turnId: 't',
    reason: 'answer',
    ...(agentId ? { agentId } : {}),
    usage: { input_tokens: 1, output_tokens: 1, model: 'claude-fable-5-1' },
  })

export function modelSwitch(over: Record<string, unknown>) {
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

export function postCompact(over: Record<string, unknown>) {
  return { session_id: 's1', transcript_path: '/t.jsonl', cwd: '/repo', trigger: 'manual', compact_summary: 'summary', ...over } as any
}
