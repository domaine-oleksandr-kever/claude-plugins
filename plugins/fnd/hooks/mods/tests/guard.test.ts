import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { DENY_FALLBACK, guardNote } from '../fnd/guard.ts'

const GUARDED = [
  'mcp__plugin_fnd_chrome-devtools-mcp__take_screenshot',
  'mcp__plugin_fnd_playwright__browser_take_screenshot',
  'mcp__plugin_fnd_chrome-devtools-mcp__take_snapshot',
  'mcp__plugin_fnd_chrome-devtools-mcp__get_network_request',
  'mcp__plugin_fnd_playwright__browser_run_code_unsafe',
]
const SHOT = GUARDED[0]
const PROVIDER = { plugin: 'mcp:chrome-devtools', tier: 'user' } as any

type Run = { argv: readonly string[]; init?: { stdin?: string; env?: Record<string, string>; timeoutMs?: number } }

const out = (stdout: string, exitCode = 0) => ({
  exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
})
const denyJson = (reason?: string) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      ...(reason === undefined ? {} : { permissionDecisionReason: reason }),
    },
  })

/**
 * Mocks plus the op stubs the guard calls. `answer` is the guard child's result (or a reject);
 * any other spawn exits 1. `live.root` is what `session.root` answers at the moment of the call.
 */
function setup(
  on: On,
  answer: (() => ReturnType<typeof out>) | 'reject',
  { env = {}, siblingFails = false }: { env?: Record<string, string>; siblingFails?: boolean } = {},
) {
  mock.clock(on, { now: 1_000_000 })
  // The status band's session.start reads the store: a throw there skips every fnd session.start hook.
  if (siblingFails) on('store.get', async () => { throw new Error('store down') })
  else mock.store(on)
  mock.env(on, env)
  const runs: Run[] = []
  const below: unknown[] = []
  const live = { root: '/repo' }
  on('session.root', async () => ({ value: live.root }))
  on('session.cwd', async () => ({ value: '/repo/sub' }))
  on('process.run', async (_$, e) => {
    if (!String(e.argv[1] ?? '').endsWith('/hooks/scratch-path-guard.cjs')) return { value: out('', 1) }
    runs.push(e as Run)
    if (answer === 'reject') throw new Error('spawn ENOENT')
    return { value: answer() }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  // The band and progress session.start hooks share the chain: answered, so a skip of theirs cannot hide the latch.
  on('session.id', async () => ({ value: 'sess-1' }))
  on('session.model', async () => ({ value: 'claude-test' }))
  on('session.usage', async () => ({ value: { context: { window: 200_000 }, rateLimits: [] } as any }))
  on('command.register', async () => ({ value: undefined as any }))
  on('ui.panes', async () => ({ value: [] }))
  on('fs.exists', async () => ({ value: false }))
  on('fs.list', async () => ({ value: [] }))
  on('tool.call', async (_$, e) => {
    below.push(e)
    return { result: 'shot saved' }
  })
  return { runs, below, live }
}

const noSettings = (on: On, env?: Record<string, string>) =>
  on('settings.read', async () => ({ value: env ? { env } : {} }))

describe('B1 tool.describe', () => {
  test('appends the note on all five tools and keeps isDeferred as given', async ($, on) => {
    mock.env(on, {})
    noSettings(on)
    on('tool.describe', async (_$, e) => (e.isDeferred ? { description: e.description, isDeferred: true } : { description: e.description }))
    for (const tool of GUARDED) {
      const deferred = await $.tool.describe({ tool, description: 'Take a screenshot.', isDeferred: true, provider: PROVIDER })
      expect(deferred.description).toBe(`Take a screenshot.${guardNote(tool)}`)
      expect(deferred.isDeferred).toBe(true)
      const listed = await $.tool.describe({ tool, description: 'Take a screenshot.', provider: PROVIDER })
      expect(listed.description).toBe(`Take a screenshot.${guardNote(tool)}`)
      expect(listed.isDeferred).toBeUndefined()
    }
  })

  test('the note is constant and names the accepted dirs', async ($, on) => {
    mock.env(on, {})
    noSettings(on)
    on('tool.describe', async (_$, e) => ({ description: e.description }))
    const a = await $.tool.describe({ tool: SHOT, description: 'd', provider: PROVIDER })
    const b = await $.tool.describe({ tool: SHOT, description: 'd', provider: PROVIDER })
    expect(a.description).toBe(b.description)
    expect(a.description).toContain('.claude/tasks/<work-id>/tmp/')
    expect(a.description).toContain('.claude/tmp/')
    expect(guardNote(SHOT)).toContain('OS temp dir')
    expect(guardNote(GUARDED[1])).not.toContain('OS temp dir')
    expect(guardNote(GUARDED[4])).not.toContain('OS temp dir')
  })

  test('other tools are unchanged with the guard on', async ($, on) => {
    mock.env(on, {})
    noSettings(on)
    on('tool.describe', async (_$, e) => ({ description: e.description }))
    for (const tool of [
      'mcp__plugin_fnd_chrome-devtools-mcp__navigate_page',
      'mcp__x__browser_take_screenshot_extra',
      'mcp__plugin_fnd_playwright__browser_navigate',
    ]) {
      expect((await $.tool.describe({ tool, description: 'd', provider: PROVIDER })).description).toBe('d')
    }
  })

  test('FND_SCRATCH_GUARD=0 → unchanged', async ($, on) => {
    mock.env(on, { FND_SCRATCH_GUARD: '0' })
    noSettings(on)
    on('tool.describe', async (_$, e) => ({ description: e.description }))
    expect((await $.tool.describe({ tool: SHOT, description: 'd', provider: PROVIDER })).description).toBe('d')
  })

  test('FND_SCRATCH_GUARD=0 only in the settings env → unchanged', async ($, on) => {
    mock.env(on, {})
    noSettings(on, { FND_SCRATCH_GUARD: '0' })
    on('tool.describe', async (_$, e) => ({ description: e.description }))
    expect((await $.tool.describe({ tool: SHOT, description: 'd', provider: PROVIDER })).description).toBe('d')
  })
})

describe('B2 tool.call delegation', () => {
  test('a deny from the child denies with its reason; the tool beneath never runs', async ($, on) => {
    const { runs, below } = setup(on, () => out(denyJson('outside the project')))
    const r = await $.tool.call({ tool: SHOT, filePath: '/etc/x.png' } as any)
    expect(r.deny).toBe('outside the project')
    expect(runs.length).toBe(1)
    expect(below.length).toBe(0)
  })

  test('a deny with no reason (or a blank one) gets the fallback text', async ($, on) => {
    let reason: string | undefined
    setup(on, () => out(denyJson(reason)))
    expect((await $.tool.call({ tool: SHOT, filePath: '/etc/x.png' } as any)).deny).toBe(DENY_FALLBACK)
    reason = '  '
    expect((await $.tool.call({ tool: SHOT, filePath: '/etc/x.png' } as any)).deny).toBe(DENY_FALLBACK)
  })

  for (const [name, answer] of [
    ['empty stdout', () => out('')],
    ['exit 2', () => out(denyJson('x'), 2)],
    ['garbage', () => out('not json {')],
    ['an allow', () => out('{}')],
    ['a reject', 'reject'],
  ] as const) {
    test(`fails open on ${name}`, async ($, on) => {
      const { runs, below } = setup(on, answer as any)
      const r = await $.tool.call({ tool: SHOT, filePath: '/repo/.claude/tmp/x.png' } as any)
      expect(r.deny).toBeUndefined()
      expect(r.result).toBe('shot saved')
      expect(runs.length).toBe(1)
      expect(below.length).toBe(1)
    })
  }

  test('call shape: --from-mod, launch root latched at session.start, stdin without engine fields', async ($, on) => {
    const { runs, live } = setup(on, () => out(''))
    live.root = '/launch'
    await $.session.start({ cwd: '/launch', surface: 'terminal', isInteractive: true })
    live.root = '/moved'
    await $.tool.call({ tool: SHOT, tool_use_id: 'toolu_1', filePath: '/tmp/a.png', format: 'png' } as any)
    expect(runs.length).toBe(1)
    const [run] = runs
    expect(run.argv[0]).toBe('node')
    expect(run.argv[1]).toEndWith('/hooks/scratch-path-guard.cjs')
    expect(run.argv.slice(2)).toEqual(['--from-mod'])
    expect(run.init?.timeoutMs).toBe(10_000)
    expect(run.init?.env?.FND_HOST).toBe('claude')
    expect(run.init?.env?.CLAUDE_PROJECT_DIR).toBe('/launch')
    expect(run.argv[1]).toStartWith(`${run.init?.env?.CLAUDE_PLUGIN_ROOT}/`)
    const stdin = JSON.parse(run.init?.stdin ?? '')
    expect(stdin.hook_event_name).toBe('PreToolUse')
    expect(stdin.tool_name).toBe(SHOT)
    expect(stdin.tool_input).toEqual({ filePath: '/tmp/a.png', format: 'png' })
    expect(stdin.cwd).toBe('/repo/sub')
  })

  test('a second session.start keeps the first root', async ($, on) => {
    const { runs, live } = setup(on, () => out(''))
    live.root = '/launch'
    await $.session.start({ cwd: '/launch', surface: 'terminal', isInteractive: true })
    live.root = '/moved'
    await $.session.start({ cwd: '/moved', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: SHOT, filePath: '/tmp/a.png' } as any)
    expect(runs[0]?.init?.env?.CLAUDE_PROJECT_DIR).toBe('/launch')
  })

  test('a sibling session.start failure: the first call latches the root', async ($, on) => {
    const { runs, live } = setup(on, () => out(''), { siblingFails: true })
    live.root = '/launch'
    await $.session.start({ cwd: '/launch', surface: 'terminal', isInteractive: true }).catch(() => undefined)
    await $.tool.call({ tool: SHOT, filePath: '/tmp/a.png' } as any)
    live.root = '/moved'
    await $.tool.call({ tool: SHOT, filePath: '/tmp/a.png' } as any)
    expect(runs.map(r => r.init?.env?.CLAUDE_PROJECT_DIR)).toEqual(['/launch', '/launch'])
  })

  test('with no session.start the live root is used', async ($, on) => {
    const { runs, live } = setup(on, () => out(''))
    live.root = '/live'
    await $.tool.call({ tool: SHOT, filePath: '/tmp/a.png' } as any)
    expect(runs[0]?.init?.env?.CLAUDE_PROJECT_DIR).toBe('/live')
  })

  test('FND_SCRATCH_GUARD=0 → no spawn', async ($, on) => {
    const { runs, below } = setup(on, () => out(denyJson('x')), { env: { FND_SCRATCH_GUARD: '0' } })
    const r = await $.tool.call({ tool: SHOT, filePath: '/etc/x.png' } as any)
    expect(r.result).toBe('shot saved')
    expect(runs.length).toBe(0)
    expect(below.length).toBe(1)
  })

  test('a tool outside the matcher → no spawn', async ($, on) => {
    const { runs, below } = setup(on, () => out(denyJson('x')))
    const r = await $.tool.call({ tool: 'mcp__plugin_fnd_chrome-devtools-mcp__navigate_page', url: 'https://x' } as any)
    expect(r.result).toBe('shot saved')
    expect(runs.length).toBe(0)
    expect(below.length).toBe(1)
  })
})
