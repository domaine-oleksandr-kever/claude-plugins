// The engine beneath base in a test: an in-memory repo, git, the tool and command lists, settings, toasts.
import { mock } from 'claude-code/testing'
import type { EngineInterface, On, ProcessRunResult } from 'claude-code'

type McpConnectResult = Awaited<ReturnType<EngineInterface['mcp']['connect']>>

export const ROOT = '/repo'
export const TASKS = `${ROOT}/.claude/tasks`
export const NOW = 1_800_000_000_000
export const HOUR = 3_600_000
export const MD = ['# ABC-1591', '- [x] Read the ticket', '- [x] Plan approved', '- [x] Branch', '- [ ] Preview themes', '- [ ] QA'].join('\n')
export const NOTES = ['## log', '- one', '- two', '- three', '- four'].join('\n')
export const SLIM_VIEW = 'mcp__slim__view'

type File = { text: string; mtimeMs: number }
export type World = {
  branch: string | null
  gitRejects: boolean
  /** the next git run answers this much later on the mocked clock */
  gitDelayMs: number
  sid: string
  /** what $.session.root() and $.session.cwd() answer now */
  root: string
  files: Record<string, File>
  /** the tool names $.tool.list answers */
  tools: string[]
  /** `[name, plugin]` pairs $.command.list answers */
  commands: [string, string][]
  /** the merged settings' enabledPlugins */
  enabledPlugins: Record<string, unknown>
  env: Record<string, string>
  /** the merged settings' env */
  settingsEnv: Record<string, unknown>
  /** answers every spawn but git; null rejects it as a spawn that cannot start */
  run: ((argv: readonly string[], init: { stdin?: string; env?: Record<string, string>; timeoutMs?: number } | undefined) => ProcessRunResult | null) | null
  /** what the plugin's own manifest reads as */
  manifest: string
  /** what $.mcp.connect answers per server; `hang` never answers, absent rejects */
  mcp: Record<string, McpConnectResult | 'hang'>
  /** a base-tmp sweep is answered once this settles */
  sweepGate: Promise<void>
  /** every $.fs.write rejects with this message while set */
  writeFails: string | null
  /** paths whose $.fs.read rejects while $.fs.stat still answers: a file over the engine's 4 MiB read cap */
  readFails: string[]
  /** `$.fs.stat(path, { resolve: true })` lands here instead of on the path itself: a symbolic link */
  realPaths: Record<string, string>
}

export const progressMd = (id: string) => `${TASKS}/${id}/progress.md`

export function addWorkspace(w: World, id: string, text = MD, mtimeMs = NOW - 60_000): void {
  w.files[progressMd(id)] = { text, mtimeMs }
}

/** Stubs every op base calls; `calls` records what reached the bottom. */
export function world(on: On, over: Partial<World> = {}) {
  const w: World = {
    branch: 'feature/ABC-1591-x',
    gitRejects: false,
    gitDelayMs: 0,
    sid: 's1',
    root: ROOT,
    files: {},
    tools: ['Bash', 'Read', SLIM_VIEW],
    commands: [],
    enabledPlugins: { 'slim@domaine': true, 'band@domaine': true, 'base@domaine': true },
    env: {},
    settingsEnv: {},
    run: null,
    manifest: '{ "name": "base", "version": "0.1.0" }',
    mcp: {},
    sweepGate: Promise.resolve(),
    writeFails: null,
    readFails: [],
    realPaths: {},
    ...over,
  }
  const calls = {
    git: 0,
    fs: [] as string[],
    reads: [] as string[],
    registers: 0,
    toasts: [] as string[],
    spawned: [] as string[],
    runs: [] as { argv: readonly string[]; init?: { stdin?: string; env?: Record<string, string>; timeoutMs?: number } }[],
    /** the base-tmp sweeps: their argv, answered apart from `runs` */
    sweeps: [] as (readonly string[])[],
    /** every command name registered, in order */
    commands: [] as string[],
    connects: [] as string[],
    below: [] as unknown[],
    /** every $.fs.write, in order */
    writes: [] as { path: string; text: string }[],
    /** the directories an `rm -rf` removed */
    removed: [] as string[],
    /** every prompt that reached the bottom, as it arrived */
    prompts: [] as { text: string; context?: readonly string[] }[],
  }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, w.env)
  const enoent = (path: string) => new Error(`ENOENT: ${path}`)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', async (_$, e) => {
    calls.prompts.push(e)
    return { text: e.text }
  })
  on('classic.CwdChanged', async () => ({}))
  on('classic.SessionStart', async () => ({}) as never)
  on('classic.UserPromptSubmit', async () => ({}) as never)
  on('classic.Stop', async () => ({}))
  on('classic.PreCompact', async () => ({}))
  on('session.root', async () => ({ value: w.root }))
  on('session.cwd', async () => ({ value: w.root }))
  on('session.id', async () => ({ value: w.sid }))
  on('settings.read', async () => ({ value: { env: w.settingsEnv, enabledPlugins: w.enabledPlugins } as any }))
  on('tool.list', async () => ({ value: w.tools.map(name => ({ name, description: name, mcp: name.startsWith('mcp__') })) }))
  on('command.list', async () => ({
    value: w.commands.map(([name, plugin]) => ({ name, description: name, source: 'plugin', plugin }) as any),
  }))
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'rm') {
      const dir = e.argv[e.argv.length - 1] ?? ''
      calls.removed.push(dir)
      for (const p of Object.keys(w.files)) if (p.startsWith(`${dir}/`)) delete w.files[p]
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[1]?.endsWith('/scripts/scratch-hygiene.cjs')) {
      await w.sweepGate
      calls.sweeps.push(e.argv)
      return { value: { exitCode: 0, stdout: 'swept=0 kept=0\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] !== 'git') {
      calls.runs.push(e as any)
      const r = w.run ? w.run(e.argv, (e as any).init) : null
      if (!r) throw new Error(`spawn ${e.argv[0]} ENOENT`)
      return { value: r }
    }
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
    const realPath = (e as { resolve?: boolean }).resolve ? (w.realPaths[e.path] ?? e.path) : undefined
    if (!f && isDir(e.path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath } }
    if (!f) throw enoent(e.path)
    return { value: { kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false, realPath } }
  })
  on('fs.list', async (_$, e) => {
    calls.fs.push(`list ${e.path}`)
    const names = new Set(Object.keys(w.files).filter(p => p.startsWith(`${e.path}/`)).map(p => p.slice(e.path.length + 1).split('/')[0] ?? ''))
    if (names.size === 0) throw enoent(e.path)
    return {
      value: [...names].map(name => {
        const f = w.files[`${e.path}/${name}`]
        return f
          ? { name, kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false }
          : { name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }
      }),
    }
  })
  on('fs.write', async (_$, e) => {
    calls.fs.push(`write ${e.path}`)
    if (w.writeFails) throw new Error(w.writeFails)
    calls.writes.push({ path: e.path, text: e.text })
    w.files[e.path] = { text: e.text, mtimeMs: clock.now() }
    return { value: undefined }
  })
  on('fs.read', async (_$, e) => {
    calls.fs.push(`read ${e.path}`)
    calls.reads.push(e.path)
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: w.manifest }
    const f = w.files[e.path]
    if (!f) throw enoent(e.path)
    if (w.readFails.includes(e.path)) throw new Error(`file too large: ${e.path}`)
    return { value: f.text }
  })
  on('command.register', async (_$, e) => {
    calls.commands.push(e.name)
    if (e.name === 'base-progress') calls.registers++
    return { value: { command: e.name } }
  })
  on('mcp.connect', async (_$, e) => {
    calls.connects.push(e.server)
    const r = w.mcp[e.server]
    if (r === 'hang') return new Promise<never>(() => undefined)
    if (!r) throw new Error(`no such server ${e.server}`)
    return { value: r }
  })
  on('ui.toast', async (_$, e) => {
    calls.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  on('classic.SubagentStart', async () => ({}) as never)
  on('tool.describe', async (_$, e) => ({ description: e.description }))
  on('agent.spawn', async (_$, e) => {
    calls.spawned.push(e.subagentType)
    return { model: 'claude-test', agentId: `agent-${calls.spawned.length}` } as any
  })
  on('tool.call', async (_$, e) => {
    const a = e as any
    calls.below.push(a)
    if (a.tool === 'Write') w.files[a.file_path] = { text: a.content, mtimeMs: NOW + 1 }
    if (a.tool === 'Bash') {
      const m = /git (?:checkout|switch) (\S+)/.exec(a.command)
      if (m) w.branch = m[1] ?? null
    }
    return { result: a.tool.startsWith('mcp__') && typeof a.reply === 'string' ? a.reply : 'ok' }
  })
  return { w, calls, clock }
}

/** Reads base's atoms through a plugin of the test's own: any plugin reads any value. */
export const PEEK = {
  name: 'peek',
  register(on: On) {
    on('tool.call', { tool: 'PeekState' } as any, async ($: any) => ({
      result: JSON.stringify({
        progress: (await $.state.get({ plugin: 'base', key: 'progress' })).value ?? null,
        pin: (await $.state.get({ plugin: 'base', key: 'pin' })).value ?? null,
        lastKey: (await $.state.get({ plugin: 'base', key: 'lastKey' })).value ?? null,
        sessionId: (await $.state.get({ plugin: 'base', key: 'sessionId' })).value ?? null,
        events: (await $.state.get({ plugin: 'base', key: 'events' })).value ?? [],
        started: (await $.state.get({ plugin: 'base', key: 'started' })).value ?? null,
        checked: (await $.state.get({ plugin: 'base', key: 'checked' })).value ?? null,
        titled: (await $.state.get({ plugin: 'base', key: 'titled' })).value ?? null,
        guardRoot: (await $.state.get({ plugin: 'base', key: 'guardRoot' })).value ?? null,
        swept: (await $.state.get({ plugin: 'base', key: 'swept' })).value ?? null,
      }),
    }))
  },
}

export async function peek($: any) {
  const r = await $.tool.call({ tool: 'PeekState' })
  return JSON.parse(r.result)
}

export const start = ($: any) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
export const submit = ($: any, text: string, kind = 'composer') => $.prompt.submit({ text, wait: false, origin: { kind } })
export const run = ($: any, args: string, command = 'base-progress') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
/** A finished spawn: exit code, stdout, stderr. */
export const ran = (exitCode: number, stdout = '', stderr = ''): ProcessRunResult =>
  ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }) as ProcessRunResult

export const reset = (calls: ReturnType<typeof world>['calls']) => {
  calls.git = 0
  calls.fs.length = 0
  calls.reads.length = 0
}
export const eventsOf = async ($: any, kind: string): Promise<{ atMs: number; kind: string; text: string }[]> =>
  ((await peek($)).events as { atMs: number; kind: string; text: string }[]).filter(ev => ev.kind === kind)
