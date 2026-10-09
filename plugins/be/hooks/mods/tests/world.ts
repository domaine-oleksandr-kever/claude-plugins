// The engine beneath be in a test: an in-memory project, the doctor spawn, the command and tool lists, toasts.
import { mock } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

export const ROOT = '/repo'
export const NOW = 1_800_000_000_000
export const HOME = '/home/dev'
export const LOG = `${HOME}/.claude/domaine/log`
export const SLIM_VIEW = 'mcp__slim__view'
/** base as the command list shows it: its skills carry its name. */
export const BASE_COMMANDS: [string, string][] = [['base:commit', 'base'], ['base-doctor', 'base']]

type File = { text: string; mtimeMs: number }
type Init = { stdin?: string; env?: Record<string, string>; timeoutMs?: number } | undefined
export type World = {
  sid: string
  root: string
  files: Record<string, File>
  tools: string[]
  /** `[name, plugin]` pairs $.command.list answers; null rejects the listing */
  commands: [string, string][] | null
  env: Record<string, string>
  /** answers doctor.cjs; null rejects it */
  doctor: ((argv: readonly string[], init: Init) => ProcessRunResult | null) | null
  manifest: string
  /** every $.fs.write rejects with this message while set */
  writeFails: string | null
  /** what the prompt.compose and SubagentStart hooks beneath be answer */
  composeBelow: { id: string; text: string; scope: 'shared' | 'session' }[]
  subagentBelow: string[] | undefined
}

/** A finished spawn: exit code, stdout, stderr. */
export const ran = (exitCode: number, stdout = '', stderr = ''): ProcessRunResult =>
  ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }) as ProcessRunResult

/** Stubs every op be calls; `calls` records what reached the bottom. */
export function world(on: On, over: Partial<World> = {}) {
  const w: World = {
    sid: 's1',
    root: ROOT,
    files: {},
    tools: ['Bash', 'Read', SLIM_VIEW],
    commands: BASE_COMMANDS,
    env: {},
    doctor: null,
    manifest: '{ "name": "be", "version": "0.1.0", "dependencies": ["base"] }',
    writeFails: null,
    composeBelow: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }],
    subagentBelow: undefined,
    ...over,
  }
  const calls = {
    toasts: [] as string[],
    doctors: [] as { argv: readonly string[]; init: Init }[],
    commands: [] as string[],
    writes: [] as { path: string; text: string }[],
  }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, w.env)
  const enoent = (path: string) => new Error(`ENOENT: ${path}`)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('session.root', async () => ({ value: w.root }))
  on('session.cwd', async () => ({ value: w.root }))
  on('session.id', async () => ({ value: w.sid }))
  on('tool.list', async () => ({ value: w.tools.map(name => ({ name, description: name, mcp: name.startsWith('mcp__') })) }))
  on('command.list', async () => {
    if (!w.commands) throw new Error('no command list')
    return { value: w.commands.map(([name, plugin]) => ({ name, description: name, source: 'plugin', plugin }) as any) }
  })
  on('process.run', async (_$, e) => {
    const init = (e as any).init as Init
    const script = String(e.argv[1] ?? '')
    if (script.endsWith('/scripts/doctor.cjs')) {
      calls.doctors.push({ argv: e.argv, init })
      const r = w.doctor ? w.doctor(e.argv, init) : null
      if (!r) throw new Error(`spawn ${e.argv[0]} ENOENT`)
      return { value: r }
    }
    throw new Error(`unexpected spawn ${e.argv.join(' ')}`)
  })
  on('fs.exists', async (_$, e) => ({ value: e.path in w.files }))
  on('fs.write', async (_$, e) => {
    if (w.writeFails) throw new Error(w.writeFails)
    calls.writes.push({ path: e.path, text: e.text })
    w.files[e.path] = { text: e.text, mtimeMs: clock.now() }
    return { value: undefined }
  })
  on('fs.read', async (_$, e) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: w.manifest }
    const f = w.files[e.path]
    if (!f) throw enoent(e.path)
    return { value: f.text }
  })
  on('command.register', async (_$, e) => {
    calls.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.toast', async (_$, e) => {
    calls.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.compose', async () => ({ sections: w.composeBelow }))
  on('classic.SubagentStart', async () => (w.subagentBelow ? { additionalContext: w.subagentBelow } : {}) as never)
  return { w, calls, clock }
}

/** Reads be's atoms through a plugin of the test's own: any plugin reads any value. */
export const PEEK = {
  name: 'peek',
  register(on: On) {
    on('tool.call', { tool: 'PeekState' } as any, async ($: any) => ({
      result: JSON.stringify({
        events: (await $.state.get({ plugin: 'be', key: 'events' })).value ?? [],
        started: (await $.state.get({ plugin: 'be', key: 'started' })).value ?? null,
        armed: (await $.state.get({ plugin: 'be', key: 'armed' })).value ?? null,
      }),
    }))
  },
}

export async function peek($: any) {
  const r = await $.tool.call({ tool: 'PeekState' })
  return JSON.parse(r.result)
}

export const start = ($: any) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
export const submit = ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
export const doctor = ($: any) =>
  $.command.run({ command: 'be-doctor', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
const INPUT = { model: 'claude-test', promptModel: 'claude-test', surfaces: ['terminal'], tools: ['Bash'], outputStyle: null, traits: [] }
export const compose = ($: any) => $.prompt.compose(INPUT)
export const ours = (r: { sections: readonly { id: string; text: string; scope: string }[] }) => r.sections.filter(s => s.id.startsWith('be:'))
export const subagent = ($: any, agent_type: string) => $.classic.SubagentStart({ agent_id: 'a1', agent_type })
export const eventsOf = async ($: any, kind?: string): Promise<{ atMs: number; kind: string; text: string }[]> =>
  ((await peek($)).events as { atMs: number; kind: string; text: string }[]).filter(ev => !kind || ev.kind === kind)
