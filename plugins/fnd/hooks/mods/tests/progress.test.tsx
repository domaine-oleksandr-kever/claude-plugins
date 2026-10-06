import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { digestText } from '../core/progress-parse.ts'

const ROOT = '/repo'
const TASKS = `${ROOT}/.claude/tasks`
const NOW = 1_800_000_000_000
const HOUR = 3_600_000
const PANE = 'fnd-progress'
const MD = ['# ELC-1591', '- [x] Read the ticket', '- [x] Plan approved', '- [x] Branch', '- [ ] Preview themes', '- [ ] QA'].join('\n')
const NOTES = ['## log', '- one', '- two', '- three', '- four'].join('\n')

type File = { text: string; mtimeMs: number }
type Pane = { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }
type World = {
  branch: string | null
  gitRejects: boolean
  /** the next git run answers this much later on the mocked clock */
  gitDelayMs: number
  sid: string
  files: Record<string, File>
  panes: Pane[]
  openResult: { isPlaced: true } | { isPlaced: false; reason: string }
}

const progressMd = (id: string) => `${TASKS}/${id}/progress.md`

function addWorkspace(w: World, id: string, text = MD, mtimeMs = NOW - 60_000): void {
  w.files[progressMd(id)] = { text, mtimeMs }
}

/** Stubs every op the module calls over an in-memory repo; `calls` records what reached the bottom. */
function world(on: On, over: Partial<World> = {}) {
  const w: World = { branch: 'feature/ELC-1591-x', gitRejects: false, gitDelayMs: 0, sid: 's1', files: {}, panes: [], openResult: { isPlaced: true }, ...over }
  const calls = { git: 0, fs: [] as string[], reads: [] as string[], registers: 0, logRegisters: 0, opens: [] as unknown[], closes: [] as unknown[], toasts: [] as string[] }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, {})
  const enoent = (path: string) => new Error(`ENOENT: ${path}`)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('classic.CwdChanged', async () => ({}))
  on('session.root', async () => ({ value: ROOT }))
  on('session.cwd', async () => ({ value: ROOT }))
  on('session.id', async () => ({ value: w.sid }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', async () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('env.set', async () => ({ value: undefined }))
  on('settings.read', async () => ({ value: { env: {} } as any }))
  on('process.run', async (_$, e) => {
    if (e.argv[0] !== 'git') throw new Error(`unexpected spawn ${e.argv[0]}`)
    calls.git++
    if (w.gitDelayMs) {
      const ms = w.gitDelayMs
      w.gitDelayMs = 0
      await clock.sleep(ms)
    }
    if (w.gitRejects) throw new Error('spawn git ENOENT')
    const ok = w.branch !== null
    return { value: { exitCode: ok ? 0 : 128, stdout: ok ? `${w.branch}\n` : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // A directory exists while a file lies under it, as on disk.
  const isDir = (path: string) => Object.keys(w.files).some(p => p.startsWith(`${path}/`))
  on('fs.exists', async (_$, e) => {
    calls.fs.push(`exists ${e.path}`)
    return { value: e.path in w.files || isDir(e.path) }
  })
  on('fs.stat', async (_$, e) => {
    calls.fs.push(`stat ${e.path}`)
    const f = w.files[e.path]
    if (!f && isDir(e.path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    if (!f) throw enoent(e.path)
    return { value: { kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
  })
  on('fs.list', async (_$, e) => {
    calls.fs.push(`list ${e.path}`)
    const names = new Set(Object.keys(w.files).filter(p => p.startsWith(`${e.path}/`)).map(p => p.slice(e.path.length + 1).split('/')[0] ?? ''))
    if (names.size === 0) throw enoent(e.path)
    return { value: [...names].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', async (_$, e) => {
    calls.fs.push(`read ${e.path}`)
    calls.reads.push(e.path)
    const f = w.files[e.path]
    if (!f) throw enoent(e.path)
    return { value: f.text }
  })
  on('command.register', async (_$, e) => {
    if (e.name === 'fnd-progress') calls.registers++
    if (e.name === 'fnd-log') calls.logRegisters++
    return { value: { command: e.name } }
  })
  on('ui.open', async (_$, e) => {
    calls.opens.push(e)
    return { value: w.openResult }
  })
  on('ui.panes', async () => ({ value: w.panes }))
  on('ui.close', async (_$, e) => {
    calls.closes.push(e)
    return { value: undefined }
  })
  on('ui.toast', async (_$, e) => {
    calls.toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', async (_$, e) => {
    const a = e as any
    if (a.tool === 'Write') w.files[a.file_path] = { text: a.content, mtimeMs: NOW + 1 }
    if (a.tool === 'Bash') {
      const m = /git (?:checkout|switch) (\S+)/.exec(a.command)
      if (m) w.branch = m[1] ?? null
    }
    return { result: 'ok' }
  })
  return { w, calls, clock }
}

/** Reads the fnd atoms through a plugin of the test's own: any plugin reads any value. */
const PEEK = {
  name: 'peek',
  register(on: On) {
    on('tool.call', { tool: 'PeekState' } as any, async ($: any) => ({
      result: JSON.stringify({
        progress: (await $.state.get({ plugin: 'fnd', key: 'progress' })).value ?? null,
        paneShown: (await $.state.get({ plugin: 'fnd', key: 'paneShown' })).value ?? null,
        pin: (await $.state.get({ plugin: 'fnd', key: 'pin' })).value ?? null,
        lastKey: (await $.state.get({ plugin: 'fnd', key: 'lastKey' })).value ?? null,
        sessionId: (await $.state.get({ plugin: 'fnd', key: 'sessionId' })).value ?? null,
        events: (await $.state.get({ plugin: 'fnd', key: 'events' })).value ?? [],
      }),
    }))
  },
}

async function peek($: any) {
  const r = await $.tool.call({ tool: 'PeekState' })
  return JSON.parse(r.result)
}
const start = ($: any) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
const submit = ($: any, text: string, kind = 'composer') => $.prompt.submit({ text, wait: false, origin: { kind } })
const run = ($: any, args: string) =>
  $.command.run({ command: 'fnd-progress', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
const reset = (calls: ReturnType<typeof world>['calls']) => {
  calls.git = 0
  calls.fs.length = 0
  calls.reads.length = 0
}
const BAND = { bodyColumns: 200, hasSurvey: false, isWorking: false, maxRows: 4, scroll: { offset: 0, bodyRows: 1 }, view: {} }
const PANE_PROPS = { title: 'Progress', isFocused: false, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 10 }, view: {} }

const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)

describe('resolver', () => {
  t('git plus fs → the digest', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ELC-1591')
    await start($)
    const { progress } = await peek($)
    expect(progress.workId).toBe('ELC-1591')
    expect(progress.branch).toBe('feature/ELC-1591-x')
    expect(digestText(progress.workId, progress)).toBe('ELC-1591 3/5 ▶ Preview themes')
  })

  t('pin beats the branch key', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ELC-1591')
    addWorkspace(w, 'OTHER-1')
    await start($)
    await run($, 'OTHER-1')
    expect((await peek($)).progress.workId).toBe('OTHER-1')
  })

  t('the conversation key beats the branch key', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ELC-1591')
    addWorkspace(w, 'ELC-77')
    await start($)
    expect((await peek($)).progress.workId).toBe('ELC-1591')
    await submit($, 'see ELC-77')
    const s = await peek($)
    expect(s.lastKey).toBe('ELC-77')
    expect(s.progress.workId).toBe('ELC-77')
    expect(s.progress.hasWorkspace).toBe(true)
  })

  t('conversation key on main', async ($, on) => {
    const { w } = world(on, { branch: 'main' })
    addWorkspace(w, 'ELC-77')
    addWorkspace(w, 'main', MD, NOW - 13 * HOUR)
    await start($)
    expect((await peek($)).progress.workId).toBe('main')
    await submit($, 'see ELC-77')
    expect((await peek($)).progress.workId).toBe('ELC-77')
  })

  t('a conversation key without a workspace still names the task: the bare id, over the branch key', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ELC-1591')
    await start($)
    await submit($, 'see ELC-77')
    const s = await peek($)
    expect(s.lastKey).toBe('ELC-77')
    expect(s.progress).toMatchObject({ workId: 'ELC-77', branch: 'feature/ELC-1591-x', hasWorkspace: false, total: 0, rows: [], notesTail: [] })
    expect(digestText(s.progress.workId, s.progress)).toBe('ELC-77')
    // Its workspace written later is picked up: the band gains the rows.
    addWorkspace(w, 'ELC-77', MD, NOW + 1)
    await $.tool.call({ tool: 'Write', file_path: progressMd('ELC-77'), content: MD })
    expect((await peek($)).progress).toMatchObject({ workId: 'ELC-77', hasWorkspace: true, total: 5 })
  })

  t('a bare key of an unknown project is not a ticket; a /browse/ URL makes it one', async ($, on) => {
    world(on, { branch: 'main' })
    await start($)
    await submit($, 'see ELC-77')
    let s = await peek($)
    expect(s.lastKey).toBeNull()
    expect(s.progress).toEqual({ workId: null, branch: 'main' })
    await submit($, 'https://meetdomaine.atlassian.net/browse/ELC-77 look at the comment')
    s = await peek($)
    expect(s.lastKey).toBe('ELC-77')
    expect(s.progress).toMatchObject({ workId: 'ELC-77', hasWorkspace: false })
  })

  t('conversation key beats the branch slug', async ($, on) => {
    const { w } = world(on, { branch: 'feature/header-refactor' })
    addWorkspace(w, 'header-refactor')
    addWorkspace(w, 'ELC-77', MD, NOW - 20 * HOUR)
    await start($)
    expect((await peek($)).progress.workId).toBe('header-refactor')
    await submit($, 'ELC-77 please')
    expect((await peek($)).progress.workId).toBe('ELC-77')
  })

  t('a non-ticket token keeps the conversation key; an earlier key in the prompt still counts', async ($, on) => {
    const { w } = world(on, { branch: 'main' })
    addWorkspace(w, 'ELC-77', MD, NOW - 20 * HOUR)
    addWorkspace(w, 'fnd-mods', MD, NOW - HOUR)
    await start($)
    await submit($, 'work on ELC-77')
    expect((await peek($)).progress.workId).toBe('ELC-77')
    await submit($, 'format the dates as ISO-8601 and save as UTF-8')
    let s = await peek($)
    expect(s.lastKey).toBe('ELC-77')
    expect(s.progress.workId).toBe('ELC-77')
    await submit($, 'ELC-77 wants SHA-256 next')
    s = await peek($)
    expect(s.lastKey).toBe('ELC-77')
    expect(s.progress.workId).toBe('ELC-77')
  })

  t('a key in a notification or a peer message is not the conversation key', async ($, on) => {
    const { w } = world(on, { branch: 'main' })
    addWorkspace(w, 'ELC-77', MD, NOW - 20 * HOUR)
    addWorkspace(w, 'ELC-88', MD, NOW - 20 * HOUR)
    await start($)
    await submit($, 'work on ELC-77')
    for (const kind of ['task-notification', 'peer', 'scheduled-trigger']) {
      await submit($, 'ELC-88 finished', kind)
      const s = await peek($)
      expect(s.lastKey).toBe('ELC-77')
      expect(s.progress.workId).toBe('ELC-77')
    }
  })

  t('a rejected git run falls through to the newest workspace', async ($, on) => {
    const { w, calls } = world(on, { gitRejects: true })
    addWorkspace(w, 'ELC-1591', MD, NOW - 2 * HOUR)
    addWorkspace(w, 'fnd-mods', MD, NOW - HOUR)
    await start($)
    expect(calls.git).toBe(1)
    const { progress } = await peek($)
    expect(progress.workId).toBe('fnd-mods')
    expect(progress.branch).toBeNull()
  })

  t('newest progress.md only within 12 h', async ($, on) => {
    const { w } = world(on, { branch: 'main' })
    addWorkspace(w, 'fnd-mods', MD, NOW - 11 * HOUR)
    addWorkspace(w, 'older', MD, NOW - 11.5 * HOUR)
    await start($)
    expect((await peek($)).progress.workId).toBe('fnd-mods')
  })

  t('nothing within 12 h → no digest', async ($, on) => {
    const { w } = world(on, { branch: 'main' })
    addWorkspace(w, 'fnd-mods', MD, NOW - 13 * HOUR)
    await start($)
    expect((await peek($)).progress).toEqual({ workId: null, branch: 'main' })
  })

  t('a ticket dir without progress.md → the bare id, no rows, the notes tail', async ($, on) => {
    const { w } = world(on, { branch: 'bugfix/ELC-1588' })
    w.files[`${TASKS}/ELC-1588/notes.md`] = { text: NOTES, mtimeMs: NOW - HOUR }
    w.files[`${TASKS}/ELC-1588/ticket.md`] = { text: '# ELC-1588', mtimeMs: NOW - HOUR }
    addWorkspace(w, 'fnd-mods', MD, NOW - HOUR)
    await start($)
    const { progress } = await peek($)
    expect(progress.workId).toBe('ELC-1588')
    expect(progress.total).toBe(0)
    expect(progress.rows).toEqual([])
    expect(progress.notesTail).toEqual(['- two', '- three', '- four'])
    expect(digestText(progress.workId, progress)).toBe('ELC-1588')
    // progress.md written later is picked up by the tick.
    w.files[progressMd('ELC-1588')] = { text: MD, mtimeMs: NOW + 1 }
    await $.tool.call({ tool: 'Write', file_path: progressMd('ELC-1588'), content: MD })
    expect(digestText('ELC-1588', (await peek($)).progress)).toBe('ELC-1588 3/5 ▶ Preview themes')
  })

  t('a stray file named like a key is not a workspace', async ($, on) => {
    const { w } = world(on)
    w.files[`${TASKS}/ELC-1591`] = { text: 'x', mtimeMs: NOW }
    await start($)
    expect((await peek($)).progress).toEqual({ workId: null, branch: 'feature/ELC-1591-x' })
  })

  t('no workspace at all → no digest', async ($, on) => {
    world(on)
    await start($)
    expect((await peek($)).progress).toEqual({ workId: null, branch: 'feature/ELC-1591-x' })
  })
})

describe('refresh', () => {
  t('session.end clear → progress null, no process or fs call', async ($, on) => {
    const { w, calls } = world(on)
    addWorkspace(w, 'ELC-1591')
    await start($)
    await submit($, 'ELC-1591')
    reset(calls)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    expect(calls.git).toBe(0)
    expect(calls.fs).toEqual([])
    const s = await peek($)
    expect(s.progress).toBeNull()
    expect(s.lastKey).toBeNull()
  })

  t('the next tick after a clear resolves again', async ($, on) => {
    const { w, clock } = world(on)
    addWorkspace(w, 'ELC-1591')
    await start($)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await clock.advance(30_000)
    expect((await peek($)).progress.workId).toBe('ELC-1591')
  })

  t('session.start registers the command before a slow git run', async ($, on) => {
    const { w, calls, clock } = world(on, { gitDelayMs: 4_000 })
    addWorkspace(w, 'ELC-1591')
    const started = start($)
    await clock.settle()
    expect(calls.git).toBe(1)
    expect(calls.registers).toBe(1)
    await clock.advance(4_000)
    await started
    expect((await peek($)).progress.workId).toBe('ELC-1591')
  })

  t('a new session id → the command again and a fresh resolve', async ($, on) => {
    const { w, calls } = world(on)
    addWorkspace(w, 'ELC-1591')
    await start($)
    expect(calls.registers).toBe(1)
    expect(calls.logRegisters).toBe(1)
    reset(calls)
    await submit($, 'hello')
    expect(calls.registers).toBe(1)
    expect(calls.logRegisters).toBe(1)
    expect(calls.git).toBe(0)
    w.sid = 's2'
    await submit($, 'hello again')
    expect(calls.registers).toBe(2)
    expect(calls.logRegisters).toBe(2)
    expect(calls.git).toBe(1)
    const s = await peek($)
    expect(s.sessionId).toBe('s2')
    expect(s.progress.workId).toBe('ELC-1591')
  })

  t('a deleted progress.md falls through on the next tick', async ($, on) => {
    const { w, clock } = world(on, { branch: 'main' })
    addWorkspace(w, 'fnd-mods', MD, NOW - HOUR)
    addWorkspace(w, 'older', MD, NOW - 2 * HOUR)
    await start($)
    expect((await peek($)).progress.workId).toBe('fnd-mods')
    delete w.files[progressMd('fnd-mods')]
    await clock.advance(30_000)
    expect((await peek($)).progress.workId).toBe('older')
  })

  t('a resolve tick in flight does not overwrite a newer pin', async ($, on) => {
    const { w, clock } = world(on)
    addWorkspace(w, 'ELC-1591')
    addWorkspace(w, 'ELC-2')
    await start($)
    w.gitDelayMs = 60_000
    await clock.advance(120_000)
    expect(await run($, 'ELC-2')).toEqual({ text: 'Progress pane opened.' })
    await clock.advance(60_000)
    expect((await peek($)).progress.workId).toBe('ELC-2')
  })

  t('a resolve tick in flight does not bring back the cleared conversation', async ($, on) => {
    const { w, clock } = world(on, { branch: 'main' })
    addWorkspace(w, 'ELC-77', MD, NOW - 20 * HOUR)
    await start($)
    await submit($, 'work on ELC-77')
    w.gitDelayMs = 60_000
    await clock.advance(120_000)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await clock.advance(60_000)
    expect((await peek($)).progress).toEqual({ workId: null, branch: 'main' })
  })

  t('a tick re-parses only when the mtime changed', async ($, on) => {
    const { w, calls, clock } = world(on)
    addWorkspace(w, 'ELC-1591')
    await start($)
    reset(calls)
    await clock.advance(30_000)
    expect(calls.reads).toEqual([])
    w.files[progressMd('ELC-1591')] = { text: MD.replace('- [ ] Preview', '- [x] Preview'), mtimeMs: NOW + 10_000 }
    await clock.advance(30_000)
    expect(calls.reads.filter(p => p === progressMd('ELC-1591'))).toHaveLength(1)
    expect(calls.git).toBe(0)
    const { progress } = await peek($)
    expect(digestText(progress.workId, progress)).toBe('ELC-1591 4/5 ▶ QA')
  })

  t('every fourth tick resolves the branch again', async ($, on) => {
    const { w, calls, clock } = world(on)
    addWorkspace(w, 'ELC-1591')
    addWorkspace(w, 'ELC-77')
    await start($)
    reset(calls)
    w.branch = 'feature/ELC-77-y'
    await clock.advance(90_000)
    expect(calls.git).toBe(0)
    await clock.advance(30_000)
    expect(calls.git).toBe(1)
    expect((await peek($)).progress.workId).toBe('ELC-77')
  })

  for (const tool of ['Write', 'Edit'] as const) {
    t(`${tool} on the workspace → exactly one re-read`, async ($, on) => {
      const { w, calls } = world(on)
      addWorkspace(w, 'ELC-1591')
      await start($)
      reset(calls)
      const path = progressMd('ELC-1591')
      const input =
        tool === 'Write'
          ? { tool, file_path: path, content: '- [x] a\n- [ ] b\n' }
          : { tool, file_path: path, old_string: 'x', new_string: 'y' }
      await $.tool.call(input)
      expect(calls.reads.filter(p => p === path)).toHaveLength(1)
      expect(calls.git).toBe(0)
    })
  }

  t('a Write elsewhere → zero reads', async ($, on) => {
    const { w, calls } = world(on)
    addWorkspace(w, 'ELC-1591')
    await start($)
    reset(calls)
    await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/a.ts`, content: 'x' })
    expect(calls.fs).toEqual([])
    expect(calls.git).toBe(0)
  })

  t('a Write into another workspace resolves again', async ($, on) => {
    const { w, calls } = world(on, { branch: 'main' })
    await start($)
    expect((await peek($)).progress.workId).toBeNull()
    reset(calls)
    await $.tool.call({ tool: 'Write', file_path: progressMd('fnd-mods'), content: '- [ ] first\n' })
    expect(calls.git).toBe(1)
    expect((await peek($)).progress.workId).toBe('fnd-mods')
  })

  t('git checkout in Bash resolves again; other commands do not', async ($, on) => {
    const { w, calls } = world(on)
    addWorkspace(w, 'ELC-1591')
    addWorkspace(w, 'ELC-77')
    await start($)
    reset(calls)
    await $.tool.call({ tool: 'Bash', command: 'ls -la' })
    expect(calls.git).toBe(0)
    await $.tool.call({ tool: 'Bash', command: 'git checkout feature/ELC-77-y' })
    expect(calls.git).toBe(1)
    expect((await peek($)).progress.workId).toBe('ELC-77')
  })

  t('CwdChanged resolves again', async ($, on) => {
    const { w, calls } = world(on)
    addWorkspace(w, 'ELC-1591')
    await start($)
    reset(calls)
    await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: `${ROOT}/sub` })
    expect(calls.git).toBe(1)
  })
})

describe('workspace event', () => {
  const workspaceEvents = async ($: any) =>
    ((await peek($)).events as { atMs: number; kind: string; text: string }[]).filter(ev => ev.kind === 'workspace')

  t('the first resolve logs the work id; a re-read of the same workspace logs nothing', async ($, on) => {
    const { w, clock } = world(on)
    addWorkspace(w, 'ELC-1591')
    await start($)
    expect(await workspaceEvents($)).toEqual([{ atMs: NOW, kind: 'workspace', text: 'ELC-1591' }])
    await $.tool.call({ tool: 'Write', file_path: progressMd('ELC-1591'), content: MD })
    await clock.advance(4 * 30_000)
    expect(await workspaceEvents($)).toHaveLength(1)
  })

  t('a branch switch to another workspace logs it; leaving every workspace logs none', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ELC-1591')
    addWorkspace(w, 'ELC-77')
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'git checkout feature/ELC-77-y' })
    w.files = {}
    await $.tool.call({ tool: 'Bash', command: 'git checkout main' })
    expect((await workspaceEvents($)).map(ev => ev.text)).toEqual(['ELC-1591', 'ELC-77', 'none'])
  })

  t('/clear and the re-resolve on the next prompt log no second line for the same workspace', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ELC-1591')
    addWorkspace(w, 'ELC-77')
    await start($)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    w.sid = 's2'
    await submit($, 'hi')
    expect((await workspaceEvents($)).map(ev => ev.text)).toEqual(['ELC-1591'])
    await $.tool.call({ tool: 'Bash', command: 'git checkout feature/ELC-77-y' })
    expect((await workspaceEvents($)).map(ev => ev.text)).toEqual(['ELC-1591', 'ELC-77'])
  })

  t('no workspace at start → no workspace event', async ($, on) => {
    world(on)
    await start($)
    expect(await workspaceEvents($)).toEqual([])
  })
})

describe('command and pane', () => {
  t('/fnd-progress ELC-9 pins; - clears the pin', async ($, on) => {
    const { w, calls } = world(on)
    addWorkspace(w, 'ELC-1591')
    addWorkspace(w, 'ELC-9')
    await start($)
    expect(calls.registers).toBe(1)
    expect(await run($, 'ELC-9')).toEqual({ text: 'Progress pane opened.' })
    let s = await peek($)
    expect(s.pin).toBe('ELC-9')
    expect(s.progress.workId).toBe('ELC-9')
    await run($, '-')
    s = await peek($)
    expect(s.pin).toBeNull()
    expect(s.progress.workId).toBe('ELC-1591')
  })

  t('/fnd-progress refuses a path and says when the pin has no workspace', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ELC-1591')
    await start($)
    expect(await run($, '../../etc')).toEqual({ text: 'Not a work id: ../../etc' })
    expect((await peek($)).pin).toBeNull()
    const r = await run($, 'ELC-9')
    expect(r.text).toContain('ELC-9 has no task workspace')
    expect((await peek($)).progress.workId).toBe('ELC-1591')
  })

  t('/fnd-progress with no argument toggles the pane', async ($, on) => {
    const { w, calls } = world(on)
    await start($)
    expect(await run($, '')).toEqual({ text: 'Progress pane opened.' })
    w.panes = [{ id: PANE, title: 'Progress', isShown: true, isFocused: true, isPlaced: true }]
    expect(await run($, '')).toEqual({ text: 'Progress pane closed.' })
    expect(calls.closes).toEqual([expect.objectContaining({ id: PANE })])
  })

  t('p press → ui.open as a dialog without holdToasts; a placed open sets paneShown; a close clears it', async ($, on) => {
    const { w, calls } = world(on)
    addWorkspace(w, 'ELC-1591')
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) {
      calls.opens.length = 0
      w.panes = []
      const ui = await $.ui.mount({ plugin: 'fnd', surface, component: 'AbovePrompt', props: BAND })
      await ui.press({ key: 'progress' })
      expect(calls.opens).toEqual([{ id: PANE, title: 'Progress', focus: true, closeOnEscape: true }])
      expect(calls.opens[0]).not.toHaveProperty('holdToasts')
      expect((await peek($)).paneShown).toBe(true)
      w.panes = [{ id: PANE, title: 'Progress', isShown: true, isFocused: false, isPlaced: true }]
      await ui.press({ key: 'progress' })
      expect(calls.opens).toHaveLength(1)
      expect((await peek($)).paneShown).toBe(false)
      await ui.unmount()
    }
    expect(calls.closes).toHaveLength(2)
  })

  t('an unplaced open → one toast, paneShown stays false', async ($, on) => {
    const { calls } = world(on, { openResult: { isPlaced: false, reason: 'below 144 columns' } })
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) {
      calls.toasts.length = 0
      const ui = await $.ui.mount({ plugin: 'fnd', surface, component: 'AbovePrompt', props: BAND })
      await ui.press({ key: 'progress' })
      expect(calls.toasts).toEqual(['progress pane not placed: below 144 columns'])
      expect((await peek($)).paneShown).toBe(false)
      await ui.unmount()
    }
  })

  t('session.start re-seeds paneShown from panes()', async ($, on) => {
    world(on, { panes: [{ id: PANE, title: 'Progress', isShown: false, isFocused: false, isPlaced: true }] })
    await start($)
    expect((await peek($)).paneShown).toBe(true)
  })

  t('session.start with no pane → paneShown false', async ($, on) => {
    world(on, { panes: [{ id: 'other', title: 'x', isShown: true, isFocused: false, isPlaced: true }] })
    await start($)
    expect((await peek($)).paneShown).toBe(false)
  })

  t('Pane: header, ✓/▶/☐ rows, notes footer', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ELC-1591')
    w.files[`${TASKS}/ELC-1591/notes.md`] = { text: NOTES, mtimeMs: NOW - 60_000 }
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'fnd', surface, component: 'Pane', requestId: PANE, props: PANE_PROPS as any })
      const header = await ui.find({ type: 'Text', text: 'ELC-1591 · feature/ELC-1591-x · 3/5' })
      expect(header?.props).toMatchObject({ bold: true, wrap: 'truncate-end' })
      expect((await ui.find({ type: 'Text', text: '✓ Read the ticket' }))?.props).toMatchObject({ dimColor: true })
      expect((await ui.find({ type: 'Text', text: '▶ Preview themes' }))?.props).toMatchObject({ bold: true })
      const todo = await ui.find({ type: 'Text', text: '☐ QA' })
      expect(todo?.props.bold).toBeFalsy()
      expect(todo?.props.dimColor).toBeFalsy()
      const footer = await ui.findAll({ type: 'Text', text: /^- (two|three|four)$/ })
      expect(footer.map(f => f.text)).toEqual(['- two', '- three', '- four'])
      expect(footer.every(f => f.props.dimColor === true)).toBe(true)
      await ui.unmount()
    }
  })

  t('Pane: ◌ dim for an unchecked row above the frontier, digest picks the frontier row', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ELC-1591', ['- [x] Read the ticket', '- [ ] Owner: reinstall', '- [x] Branch', '- [ ] Preview themes', '- [ ] QA'].join('\n'))
    await start($)
    const progress = (await peek($)).progress
    expect(digestText(progress.workId, progress)).toBe('ELC-1591 2/5 ▶ Preview themes')
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'fnd', surface, component: 'Pane', requestId: PANE, props: PANE_PROPS as any })
      const waiting = await ui.find({ type: 'Text', text: '◌ Owner: reinstall' })
      expect(waiting?.props).toMatchObject({ dimColor: true })
      expect(waiting?.props.bold).toBeFalsy()
      expect((await ui.find({ type: 'Text', text: '▶ Preview themes' }))?.props).toMatchObject({ bold: true })
      expect(await ui.find({ type: 'Text', text: '☐ QA' })).toBeTruthy()
      await ui.unmount()
    }
  })

  t('Pane fallback: an unchecked row above a trailing checked row stays ☐, not ◌', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ELC-1591', ['- [x] a', '- [ ] b', '- [ ] c', '- [x] d'].join('\n'))
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'fnd', surface, component: 'Pane', requestId: PANE, props: PANE_PROPS as any })
      expect((await ui.find({ type: 'Text', text: '▶ b' }))?.props).toMatchObject({ bold: true })
      const todo = await ui.find({ type: 'Text', text: '☐ c' })
      expect(todo?.props.dimColor).toBeFalsy()
      expect(await ui.find({ type: 'Text', text: /^◌/ })).toBeFalsy()
      await ui.unmount()
    }
  })

  t('Pane for a named ticket without a workspace: header, then the no-workspace line', async ($, on) => {
    const { w } = world(on)
    addWorkspace(w, 'ELC-1591')
    await start($)
    await submit($, 'see ELC-77')
    const ui = await $.ui.mount({ plugin: 'fnd', surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS as any })
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.map(x => x.text)).toEqual(['ELC-77 · feature/ELC-1591-x', 'no task workspace — /fnd:save-task-context'])
    await ui.unmount()
  })

  t('Pane with no workspace: one line', async ($, on) => {
    world(on)
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'fnd', surface, component: 'Pane', requestId: PANE, props: PANE_PROPS as any })
      const texts = await ui.findAll({ type: 'Text' })
      expect(texts.map(x => x.text)).toEqual(['no task workspace — /fnd:save-task-context'])
      await ui.unmount()
    }
  })
})
