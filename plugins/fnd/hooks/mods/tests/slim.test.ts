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
