import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__plugin_fnd_atlassian__searchJiraIssuesUsingJql'
const SID = '0b1c2d3e-sess'
const SPILL = `/Users/me/.claude/projects/-Users-me-repo/${SID}/tool-results/mcp-plugin_fnd_atlassian-searchJiraIssuesUsingJql-1791010865179.txt`
const NOTICE =
  `Error: result (3,196,806 characters across 77,369 lines) exceeds maximum allowed tokens. Output has been saved to ${SPILL}.\n` +
  'Format: Plain text\nUse offset and limit parameters to read specific portions of the file.'
const STATS = 'fnd-mcp-slim: compressed 3,197,763 B → 41,000 B (−98.7%)'
const SLIMMED = `{"issues":[{"key":"ELC-1"}]}\n\n${STATS}\n\n<<full=${SPILL} original_result>>`

type Run = { argv: readonly string[]; init?: { stdin?: string; env?: Record<string, string>; timeoutMs?: number } }

const out = (stdout: string, exitCode = 0) => ({
  exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
})
const slimJson = (value: unknown, systemMessage?: string) =>
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: value },
    ...(systemMessage ? { systemMessage } : {}),
  })

/** Reads fnd's event log from beside it: any plugin reads any value. */
const PEEK_EVENTS = {
  name: 'peek-events',
  register(on: On) {
    on('command.run', { command: 'peek-events' } as any, async ($: any) => ({
      text: JSON.stringify((await $.state.get({ plugin: 'fnd', key: 'events' })).value ?? []),
    }))
  },
}
const logged = async ($: any, kind: string): Promise<{ atMs: number; kind: string; text: string }[]> =>
  (JSON.parse((await $.command.run({ command: 'peek-events', args: '' })).text) as any[]).filter(ev => ev.kind === kind)

/** Mocks plus op stubs; `below` is what the tool itself answers, `answer` the mcp-slim child's run. */
function setup(
  on: On,
  below: Record<string, unknown>,
  answer: (() => ReturnType<typeof out>) | 'reject' = () => out(''),
  env: Record<string, string> = {},
) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, env)
  const runs: Run[] = []
  const toasts: { text: string; timeoutMs?: number }[] = []
  on('session.id', async () => ({ value: SID }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('ui.toast', async (_$, e) => {
    toasts.push(e)
    return { value: undefined }
  })
  on('process.run', async (_$, e) => {
    if (!String(e.argv[1] ?? '').endsWith('/hooks/mcp-slim.cjs')) return { value: out('', 1) }
    runs.push(e as Run)
    if (answer === 'reject') throw new Error('spawn ENOENT')
    return { value: answer() }
  })
  on('tool.call', async () => below as any)
  return { runs, toasts }
}

describe('C1 host-stub replacement', () => {
  test('a probe-shaped stub → mcp-slim --overflow=expand, a fresh {result}, one toast', async ($, on) => {
    const { runs, toasts } = setup(on, { result: NOTICE }, () => out(slimJson(SLIMMED, STATS)))
    const r = await $.tool.call({ tool: TOOL, jql: 'project = ELC' } as any)
    expect(r).toEqual({ result: SLIMMED })
    expect(runs.length).toBe(1)
    const [run] = runs
    expect(run.argv[0]).toBe('node')
    expect(run.argv[1]).toEndWith('/hooks/mcp-slim.cjs')
    expect(run.argv.slice(2)).toEqual(['--from-mod', '--overflow=expand'])
    expect(run.init?.timeoutMs).toBe(120_000)
    expect(run.init?.env?.FND_HOST).toBe('claude')
    expect(run.argv[1]).toStartWith(`${run.init?.env?.CLAUDE_PLUGIN_ROOT}/`)
    const stdin = JSON.parse(run.init?.stdin ?? '')
    expect(stdin).toEqual({
      hook_event_name: 'PostToolUse',
      tool_name: TOOL,
      tool_input: { jql: 'project = ELC' },
      tool_response: NOTICE,
      cwd: '/repo',
      session_id: SID,
    })
    expect(toasts).toEqual([{ text: STATS, timeoutMs: 5000 }])
  })

  test('in a subagent: the same answer, no toast, stdin session_id = the session id', async ($, on) => {
    const { runs, toasts } = setup(on, { result: NOTICE }, () => out(slimJson(SLIMMED, STATS)))
    const r = await $.tool.call({ tool: TOOL, agentId: 'agent-7', jql: 'x' } as any)
    expect(r).toEqual({ result: SLIMMED })
    expect(toasts.length).toBe(0)
    const stdin = JSON.parse(runs[0]?.init?.stdin ?? '')
    expect(stdin.session_id).toBe(SID)
    expect(stdin.tool_input).toEqual({ jql: 'x' })
  })

  test('in a subagent the C2 figure is not toasted either', async ($, on) => {
    const { toasts } = setup(on, { result: SLIMMED, text: SLIMMED })
    await $.tool.call({ tool: TOOL, agentId: 'agent-7' } as any)
    expect(toasts.length).toBe(0)
  })

  test('the stub in a text block, and the MCP output field, are read too', async ($, on) => {
    const blocks = [{ type: 'text', text: SLIMMED }]
    const { runs } = setup(on, { result: [{ type: 'text', text: NOTICE }] }, () =>
      out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedMCPToolOutput: blocks } })),
    )
    expect(await $.tool.call({ tool: TOOL } as any)).toEqual({ result: blocks })
    expect(runs.length).toBe(1)
  })

  test('the stub on the error arm is replaced as well', async ($, on) => {
    const { runs } = setup(on, { result: NOTICE, text: NOTICE, isError: true }, () => out(slimJson(SLIMMED)))
    expect(await $.tool.call({ tool: TOOL } as any)).toEqual({ result: SLIMMED })
    expect(runs.length).toBe(1)
  })

  test("a hook beneath's context is carried over", async ($, on) => {
    setup(on, { result: NOTICE, context: ['lower plugin note'] }, () => out(slimJson(SLIMMED)))
    expect(await $.tool.call({ tool: TOOL } as any)).toEqual({ result: SLIMMED, context: ['lower plugin note'] })
  })

  test('no systemMessage → no toast', async ($, on) => {
    const { toasts } = setup(on, { result: NOTICE }, () => out(slimJson(SLIMMED)))
    expect(await $.tool.call({ tool: TOOL } as any)).toEqual({ result: SLIMMED })
    expect(toasts.length).toBe(0)
  })

  for (const [name, answer] of [
    ['a reject', 'reject'],
    ['exit 1', () => out(slimJson(SLIMMED, STATS), 1)],
    ['garbage', () => out('{not json')],
    ['empty stdout', () => out('')],
    ['no output field', () => out('{"hookSpecificOutput":{"hookEventName":"PostToolUse"}}')],
  ] as const) {
    test(`${name} → the host stub stands, no toast`, async ($, on) => {
      const below = { result: NOTICE, text: NOTICE }
      const { runs, toasts } = setup(on, below, answer as any)
      const r = await $.tool.call({ tool: TOOL } as any)
      expect(r.result).toBe(NOTICE)
      expect(r.text).toBe(NOTICE)
      expect(runs.length).toBe(1)
      expect(toasts.length).toBe(0)
    })
  }
})

describe('passthrough', () => {
  test('a deny passes through, no spawn', async ($, on) => {
    const { runs } = setup(on, { deny: 'nope' }, () => out(slimJson(SLIMMED, STATS)))
    expect((await $.tool.call({ tool: TOOL } as any)).deny).toBe('nope')
    expect(runs.length).toBe(0)
  })

  test('a plain result is unchanged, no spawn, no toast', async ($, on) => {
    const below = { result: '{"issues":[]}', text: '{"issues":[]}' }
    const { runs, toasts } = setup(on, below, () => out(slimJson(SLIMMED, STATS)))
    const r = await $.tool.call({ tool: TOOL } as any)
    expect(r.result).toBe('{"issues":[]}')
    expect(runs.length).toBe(0)
    expect(toasts.length).toBe(0)
  })

  test('FND_MCP_SLIM=0 → the stub is unchanged, no spawn', async ($, on) => {
    const { runs, toasts } = setup(on, { result: NOTICE }, () => out(slimJson(SLIMMED, STATS)), { FND_MCP_SLIM: '0' })
    expect((await $.tool.call({ tool: TOOL } as any)).result).toBe(NOTICE)
    expect(runs.length).toBe(0)
    expect(toasts.length).toBe(0)
  })

  test('FND_SLIM_TOAST=0 → the stub is still replaced, no toast', async ($, on) => {
    const { runs, toasts } = setup(on, { result: NOTICE }, () => out(slimJson(SLIMMED, STATS)), { FND_SLIM_TOAST: '0' })
    expect(await $.tool.call({ tool: TOOL } as any)).toEqual({ result: SLIMMED })
    expect(runs.length).toBe(1)
    expect(toasts).toEqual([])
  })

  test('a non-MCP tool is not touched', async ($, on) => {
    const { runs, toasts } = setup(on, { result: NOTICE }, () => out(slimJson(SLIMMED, STATS)))
    expect((await $.tool.call({ tool: 'Read', file_path: '/repo/a' } as any)).result).toBe(NOTICE)
    expect(runs.length).toBe(0)
    expect(toasts.length).toBe(0)
  })
})

describe('C2-toast (classic hook slimmed it beneath)', () => {
  test('stats line + <<full= handle → one toast, no spawn, result unchanged', async ($, on) => {
    const { runs, toasts } = setup(on, { result: SLIMMED, text: SLIMMED })
    const r = await $.tool.call({ tool: TOOL } as any)
    expect(r.result).toBe(SLIMMED)
    expect(runs.length).toBe(0)
    expect(toasts).toEqual([{ text: STATS, timeoutMs: 5000 }])
  })

  test('read from the result blocks when core gives no text', async ($, on) => {
    const { toasts } = setup(on, { result: [{ type: 'text', text: '{"a":1}' }, { type: 'text', text: SLIMMED }] })
    await $.tool.call({ tool: TOOL } as any)
    expect(toasts.length).toBe(1)
  })

  test('a payload over the biggest emission quoting both marks → no toast', async ($, on) => {
    const quoted = `${'x'.repeat(34_000)}\n${SLIMMED}`
    const { toasts } = setup(on, { result: quoted, text: quoted })
    await $.tool.call({ tool: TOOL } as any)
    expect(toasts.length).toBe(0)
  })

  test('FND_SLIM_TOAST_MS sets how long the figure stays', async ($, on) => {
    const { toasts } = setup(on, { result: SLIMMED, text: SLIMMED }, undefined, { FND_SLIM_TOAST_MS: '10000' })
    await $.tool.call({ tool: TOOL } as any)
    expect(toasts).toEqual([{ text: STATS, timeoutMs: 10_000 }])
  })

  test('FND_SLIM_TOAST=0 → the figure is not toasted', async ($, on) => {
    const { runs, toasts } = setup(on, { result: SLIMMED, text: SLIMMED }, undefined, { FND_SLIM_TOAST: '0' })
    expect((await $.tool.call({ tool: TOOL } as any)).result).toBe(SLIMMED)
    expect(runs.length).toBe(0)
    expect(toasts).toEqual([])
  })

  test('FND_MCP_SLIM_STUB_BYTES raises that bound', async ($, on) => {
    const big = `${'x'.repeat(34_000)}\n${SLIMMED}`
    const { toasts } = setup(on, { result: big, text: big }, undefined, { FND_MCP_SLIM_STUB_BYTES: '65536' })
    await $.tool.call({ tool: TOOL } as any)
    expect(toasts).toEqual([{ text: STATS, timeoutMs: 5000 }])
  })

  test('the stats line and the handle in different blocks → no toast', async ($, on) => {
    const { toasts } = setup(on, { result: [{ type: 'text', text: STATS }, { type: 'text', text: `<<full=${SPILL} original_result>>` }] })
    await $.tool.call({ tool: TOOL } as any)
    expect(toasts.length).toBe(0)
  })

  test('a payload quoting the stats line without a handle → no toast', async ($, on) => {
    const quoted = `{"body":"see"}\n${STATS}`
    const { runs, toasts } = setup(on, { result: quoted, text: quoted })
    await $.tool.call({ tool: TOOL } as any)
    expect(runs.length).toBe(0)
    expect(toasts.length).toBe(0)
  })
})

describe('event log', () => {
  test('a stub expansion logs one slim line: the tool and the toast without its prefix', { plugins: [PEEK_EVENTS] }, async ($, on) => {
    const { toasts } = setup(on, { result: NOTICE }, () => out(slimJson(SLIMMED, STATS)))
    await $.tool.call({ tool: TOOL } as any)
    expect(toasts.map(t => t.text)).toEqual([STATS])
    expect(await logged($, 'slim')).toEqual([{ atMs: 1_000_000, kind: 'slim', text: 'searchJiraIssuesUsingJql: compressed 3,197,763 B → 41,000 B (−98.7%)' }])
  })

  test('the figure of a result slimmed beneath logs one slim line', { plugins: [PEEK_EVENTS] }, async ($, on) => {
    setup(on, { result: SLIMMED, text: SLIMMED })
    await $.tool.call({ tool: TOOL } as any)
    expect((await logged($, 'slim')).map(ev => ev.text)).toEqual(['searchJiraIssuesUsingJql: compressed 3,197,763 B → 41,000 B (−98.7%)'])
  })

  const AGENTS = [{ id: 'agent-7', description: 'read ELC-1', type: 'fnd:jira-reader', status: 'running' }]
  for (const [name, below] of [['an expansion', { result: NOTICE }], ['a figure', { result: SLIMMED, text: SLIMMED }]] as const) {
    test(`in a subagent ${name} logs one line prefixed with its type, no toast`, { plugins: [PEEK_EVENTS] }, async ($, on) => {
      const { toasts } = setup(on, below, () => out(slimJson(SLIMMED, STATS)))
      on('agent.list', async () => ({ value: AGENTS as any }))
      await $.tool.call({ tool: TOOL, agentId: 'agent-7' } as any)
      expect(toasts).toEqual([])
      expect((await logged($, 'slim')).map(ev => ev.text)).toEqual(['jira-reader · searchJiraIssuesUsingJql: compressed 3,197,763 B → 41,000 B (−98.7%)'])
    })
  }

  test('an agent id the list does not name → `agent · `', { plugins: [PEEK_EVENTS] }, async ($, on) => {
    setup(on, { result: SLIMMED, text: SLIMMED })
    on('agent.list', async () => ({ value: AGENTS as any }))
    await $.tool.call({ tool: TOOL, agentId: 'agent-fork' } as any)
    expect((await logged($, 'slim')).map(ev => ev.text)).toEqual(['agent · searchJiraIssuesUsingJql: compressed 3,197,763 B → 41,000 B (−98.7%)'])
  })

  test('a failing agent list → `agent · `, the result unchanged', { plugins: [PEEK_EVENTS] }, async ($, on) => {
    setup(on, { result: NOTICE }, () => out(slimJson(SLIMMED, STATS)))
    on('agent.list', async () => {
      throw new Error('boom')
    })
    expect(await $.tool.call({ tool: TOOL, agentId: 'agent-7' } as any)).toEqual({ result: SLIMMED })
    expect((await logged($, 'slim')).map(ev => ev.text)).toEqual(['agent · searchJiraIssuesUsingJql: compressed 3,197,763 B → 41,000 B (−98.7%)'])
  })

  test('on the main loop the line stays unprefixed beside its toast', { plugins: [PEEK_EVENTS] }, async ($, on) => {
    const { toasts } = setup(on, { result: SLIMMED, text: SLIMMED })
    on('agent.list', async () => ({ value: AGENTS as any }))
    await $.tool.call({ tool: TOOL } as any)
    expect(toasts).toEqual([{ text: STATS, timeoutMs: 5000 }])
    expect((await logged($, 'slim')).map(ev => ev.text)).toEqual(['searchJiraIssuesUsingJql: compressed 3,197,763 B → 41,000 B (−98.7%)'])
  })

  test('FND_SLIM_TOAST=0 → no toast, the line is still logged', { plugins: [PEEK_EVENTS] }, async ($, on) => {
    const { toasts } = setup(on, { result: NOTICE }, () => out(slimJson(SLIMMED, STATS)), { FND_SLIM_TOAST: '0' })
    await $.tool.call({ tool: TOOL } as any)
    expect(toasts).toEqual([])
    expect((await logged($, 'slim')).map(ev => ev.text)).toEqual(['searchJiraIssuesUsingJql: compressed 3,197,763 B → 41,000 B (−98.7%)'])
  })

  test('FND_EVENT_LOG=0 → the toast unchanged, nothing logged', { plugins: [PEEK_EVENTS] }, async ($, on) => {
    const { toasts } = setup(on, { result: NOTICE }, () => out(slimJson(SLIMMED, STATS)), { FND_EVENT_LOG: '0' })
    await $.tool.call({ tool: TOOL } as any)
    expect(toasts).toEqual([{ text: STATS, timeoutMs: 5000 }])
    expect(await logged($, 'slim')).toEqual([])
  })
})

/**
 * The slim plugin beside fnd, as far as fnd can see it: the slim.info snapshot it owns, taken from the
 * test's SLIM_INFO_JSON (an inline plugin's register cannot close over the test's values).
 */
const SLIM_SIBLING = {
  name: 'slim',
  register(on: On) {
    on('session.start', async ($: any, e: any, next: any) => {
      const raw = await $.env.get('SLIM_INFO_JSON')
      await $.state.set({ plugin: 'slim', key: 'info' }, raw ? JSON.parse(raw) : null)
      return next(e)
    })
  },
}
const withInfo = (info: unknown, env: Record<string, string> = {}) => ({ ...env, SLIM_INFO_JSON: JSON.stringify(info) })
const PROXY = { FND_COMPRESSION: 'proxy' }
const PROXY_ON = withInfo({ v: 1, version: '0.3.0', channels: ['mcp', 'bash', 'read'] }, PROXY)
async function startSession($: any, on: On): Promise<void> {
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.root', async () => {
    throw new Error('no repo')
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}
const PLAIN = 'line of plain text\n'.repeat(2800)
const NOT_LOADED = 'FND_COMPRESSION=proxy, but slim is not loaded (or older than 0.3.0) — fnd compresses'
const MCP_OFF = "FND_COMPRESSION=proxy, but slim's MCP channel is off (SLIM_MCP=0) — fnd compresses"
const compressRuns = (runs: Run[]) => runs.filter(r => r.argv.includes('--from-mod'))
const sweepRuns = (runs: Run[]) => runs.filter(r => !r.argv.includes('--from-mod'))

describe('builtin with slim beneath', () => {
  test("a small slim output quoting the overflow phrase above this session's spill path is no host stub: no run", async ($, on) => {
    const quoting = [{ type: 'text', text: `{"note":"${NOTICE.replace(/"/g, "'").replace(/\n/g, ' ')}"}\n\nslim: compressed 9,000 B → 900 B (−90.0%)\n\n<<full=/tmp/fnd-mcp-slim-0123456789abcdef.json original_result>>` }]
    const { runs, toasts } = setup(on, { result: quoting, text: quoting[0]!.text }, () => out(slimJson(SLIMMED, STATS)))
    expect((await $.tool.call({ tool: TOOL } as any)).result).toEqual(quoting)
    expect(runs).toEqual([])
    expect(toasts).toEqual([])
  })

  test("fnd's own figure beneath is still toasted (fnd's label is not slim's)", async ($, on) => {
    const { runs, toasts } = setup(on, { result: SLIMMED, text: SLIMMED }, () => out(''))
    expect((await $.tool.call({ tool: TOOL } as any)).result).toBe(SLIMMED)
    expect(runs).toEqual([])
    expect(toasts.map(t => t.text)).toEqual([STATS])
  })
})

describe('FND_COMPRESSION=proxy', () => {
  test('slim.info lists mcp → the result untouched, no compression, no toast; one sweep run per session', { plugins: [SLIM_SIBLING, PEEK_EVENTS] }, async ($, on) => {
    const { runs, toasts } = setup(on, { result: NOTICE, text: NOTICE }, () => out(slimJson(SLIMMED, STATS)), PROXY_ON)
    await startSession($, on)
    const r = await $.tool.call({ tool: TOOL } as any)
    expect(r.result).toBe(NOTICE)
    await $.tool.call({ tool: TOOL } as any)
    expect(compressRuns(runs)).toEqual([])
    expect(toasts).toEqual([])
    const sweeps = sweepRuns(runs)
    expect(sweeps.length).toBe(1)
    expect(sweeps[0]!.argv.slice(2)).toEqual([])
    expect(sweeps[0]!.init?.env?.FND_HOST).toBe('claude')
    expect(sweeps[0]!.init?.env?.FND_COMPRESSION).toBe('proxy')
    expect(JSON.parse(sweeps[0]!.init?.stdin ?? '')).toEqual({ cwd: '/repo', tool_name: TOOL })
    expect(await logged($, 'slim')).toEqual([])
  })

  test('a failing sweep run never reaches the result', { plugins: [SLIM_SIBLING] }, async ($, on) => {
    const { runs } = setup(on, { result: NOTICE, text: NOTICE }, 'reject', PROXY_ON)
    await startSession($, on)
    expect((await $.tool.call({ tool: TOOL } as any)).result).toBe(NOTICE)
    expect(sweepRuns(runs).length).toBe(1)
  })

  test('slim not loaded → fnd compresses the whole result, one notice toast + one event per session', { plugins: [PEEK_EVENTS] }, async ($, on) => {
    const { runs, toasts } = setup(on, { result: PLAIN, text: PLAIN }, () => out(slimJson(SLIMMED)), PROXY)
    expect(await $.tool.call({ tool: TOOL, jql: 'x' } as any)).toEqual({ result: SLIMMED })
    expect(await $.tool.call({ tool: TOOL, jql: 'y' } as any)).toEqual({ result: SLIMMED })
    expect(runs.length).toBe(2)
    expect(runs[0]!.argv.slice(2)).toEqual(['--from-mod', '--overflow=expand'])
    expect(JSON.parse(runs[0]!.init?.stdin ?? '').tool_response).toBe(PLAIN)
    expect(toasts).toEqual([{ text: NOT_LOADED }])
    expect((await logged($, 'slim')).map(ev => ev.text)).toEqual([NOT_LOADED])
  })

  test('slim not loaded: the compression figure is still toasted beside the notice', async ($, on) => {
    const { toasts } = setup(on, { result: PLAIN, text: PLAIN }, () => out(slimJson(SLIMMED, STATS)), PROXY)
    await $.tool.call({ tool: TOOL } as any)
    expect(toasts.map(t => t.text)).toEqual([NOT_LOADED, STATS])
  })

  test('slim not loaded, the host stub → expanded as under builtin', async ($, on) => {
    const { runs } = setup(on, { result: NOTICE }, () => out(slimJson(SLIMMED)), PROXY)
    expect(await $.tool.call({ tool: TOOL } as any)).toEqual({ result: SLIMMED })
    expect(runs.length).toBe(1)
  })

  test('slim not loaded, a result at or under 4 KB → no run, no notice', async ($, on) => {
    const small = 'x'.repeat(2048)
    const { runs, toasts } = setup(on, { result: small, text: small }, () => out(slimJson(SLIMMED)), PROXY)
    expect((await $.tool.call({ tool: TOOL } as any)).result).toBe(small)
    expect(runs.length).toBe(0)
    expect(toasts).toEqual([])
  })

  for (const [name, text] of [
    ["slim's stats line + handle", `${'{"a":1}\n'.repeat(800)}\nslim: compressed 90,000 B → 7,000 B (−92.2%)\n\n<<full=/tmp/fnd-mcp-slim-0123456789abcdef.json original_result>>`],
    ["slim's stub", `<<slim stub>> ${'y'.repeat(6000)}`],
  ] as const) {
    test(`slim not loaded, ${name} → passes through, no run`, async ($, on) => {
      const { runs } = setup(on, { result: text, text }, () => out(slimJson(SLIMMED)), PROXY)
      expect((await $.tool.call({ tool: TOOL } as any)).result).toBe(text)
      expect(runs.length).toBe(0)
    })
  }

  test("slim not loaded, slim's tail inside a text block → passes through, no run", async ($, on) => {
    const block = [{ type: 'text', text: `${'{"a":1}\n'.repeat(800)}\n\nslim: compressed 50,000 B → 2,000 B (−96.0%)\n\n<<full=/tmp/fnd-mcp-slim-0123456789abcdef.json original_result>>` }]
    const { runs } = setup(on, { result: block, text: block[0]!.text }, () => out(slimJson(SLIMMED)), PROXY)
    expect((await $.tool.call({ tool: TOOL } as any)).result).toEqual(block)
    expect(runs.length).toBe(0)
  })

  test('a subagent first, then the main loop: one Log line, and the toast still shown once on the main call', { plugins: [PEEK_EVENTS] }, async ($, on) => {
    const { toasts } = setup(on, { result: PLAIN, text: PLAIN }, () => out(slimJson(SLIMMED)), PROXY)
    await $.tool.call({ tool: TOOL, agentId: 'agent-7' } as any)
    await $.tool.call({ tool: TOOL } as any)
    await $.tool.call({ tool: TOOL } as any)
    await $.tool.call({ tool: TOOL, agentId: 'agent-8' } as any)
    expect(toasts).toEqual([{ text: NOT_LOADED }])
    expect((await logged($, 'slim')).map(ev => ev.text)).toEqual([NOT_LOADED])
  })

  test('two first calls in parallel: one toast, one Log line', { plugins: [PEEK_EVENTS] }, async ($, on) => {
    const { toasts } = setup(on, { result: PLAIN, text: PLAIN }, () => out(slimJson(SLIMMED)), PROXY)
    await Promise.all([$.tool.call({ tool: TOOL, jql: 'a' } as any), $.tool.call({ tool: TOOL, jql: 'b' } as any)])
    expect(toasts).toEqual([{ text: NOT_LOADED }])
    expect((await logged($, 'slim')).map(ev => ev.text)).toEqual([NOT_LOADED])
  })

  test("slim loaded with its MCP channel off → fnd compresses, the SLIM_MCP=0 notice", { plugins: [SLIM_SIBLING, PEEK_EVENTS] }, async ($, on) => {
    const env = withInfo({ v: 1, version: '0.3.0', channels: ['bash'] }, PROXY)
    const { runs, toasts } = setup(on, { result: PLAIN, text: PLAIN }, () => out(slimJson(SLIMMED)), env)
    await startSession($, on)
    expect(await $.tool.call({ tool: TOOL } as any)).toEqual({ result: SLIMMED })
    expect(compressRuns(runs).length).toBe(1)
    expect(sweepRuns(runs)).toEqual([])
    expect(toasts).toEqual([{ text: MCP_OFF }])
    expect((await logged($, 'slim')).map(ev => ev.text)).toEqual([MCP_OFF])
  })

  test('in a subagent the notice is logged, never toasted', { plugins: [PEEK_EVENTS] }, async ($, on) => {
    const { toasts } = setup(on, { result: PLAIN, text: PLAIN }, () => out(slimJson(SLIMMED)), PROXY)
    await $.tool.call({ tool: TOOL, agentId: 'agent-7' } as any)
    expect(toasts).toEqual([])
    expect((await logged($, 'slim')).map(ev => ev.text)).toEqual([NOT_LOADED])
  })

  test('FND_MCP_SLIM=0 still wins: no run, no sweep, no notice', { plugins: [SLIM_SIBLING] }, async ($, on) => {
    const { runs, toasts } = setup(on, { result: PLAIN, text: PLAIN }, () => out(slimJson(SLIMMED)), { ...PROXY_ON, FND_MCP_SLIM: '0' })
    await startSession($, on)
    expect((await $.tool.call({ tool: TOOL } as any)).result).toBe(PLAIN)
    expect(runs).toEqual([])
    expect(toasts).toEqual([])
  })

  for (const value of ['builtin', 'junk', '']) {
    test(`FND_COMPRESSION=${JSON.stringify(value)} reads as builtin: a big plain result is left to the classic hook, even with slim loaded`, { plugins: [SLIM_SIBLING] }, async ($, on) => {
      const { runs, toasts } = setup(on, { result: PLAIN, text: PLAIN }, () => out(slimJson(SLIMMED, STATS)), withInfo({ v: 1, version: '0.3.0', channels: ['mcp'] }, { FND_COMPRESSION: value }))
      await startSession($, on)
      expect((await $.tool.call({ tool: TOOL } as any)).result).toBe(PLAIN)
      expect(runs).toEqual([])
      expect(toasts).toEqual([])
    })
  }
})
