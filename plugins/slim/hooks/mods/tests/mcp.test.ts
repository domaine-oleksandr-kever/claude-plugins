import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__plugin_acme_atlassian__searchJiraIssuesUsingJql'
const BIG = `{"issues":[${'{"key":"ELC-1","fields":{"summary":"x"}},'.repeat(2900)}{}]}`
const SPILL = '/tmp/fnd-mcp-slim-0123456789abcdef.json'
const FIGURE = 'slim: compressed 120,030 B → 30,000 B (−75.0%)'
const SLIMMED = `{"issues":[{"key":"ELC-1"}]}\n\n${FIGURE}\n\n<<full=${SPILL} original_result>>`
const NOTICE =
  'Error: result (3,196,806 characters) exceeds maximum allowed tokens. Output has been saved to ' +
  '/Users/me/.claude/projects/-repo/S/tool-results/mcp-plugin_acme_atlassian-searchJiraIssuesUsingJql-1791010865179.txt.'
const TEXT = 'searchJiraIssuesUsingJql: compressed 120 KB → 30 KB (−75%) · json'
/** The core's stdin keys, in order; agentId, pre and bytes_in only when set. */
const ENVELOPE_KEYS = ['v', 'channel', 'tool', 'tool_use_id', 'tool_input', 'tool_response', 'is_error', 'cwd', 'session_id', 'agentId', 'pre', 'bytes_in']
const AGENTS = [{ id: 'agent-7', description: 'read ELC-1', type: 'fnd:jira-reader', status: 'running' }]

type Run = { argv: readonly string[]; init?: { stdin?: string; env?: Record<string, string>; timeoutMs?: number } }

const out = (stdout: string, exitCode = 0, isStdoutTruncated = false) => ({
  exitCode, stdout, stderr: exitCode ? 'Error: boom\n  at x' : '', isStdoutTruncated, isStderrTruncated: false,
})
const record = (over: Record<string, unknown> = {}) => ({
  src: 'slim', channel: 'mcp', entry: 'hook', tool: TOOL, decision: 'compressed', reason: null, engine: 'json',
  bytes_in: 120_030, bytes_out: 30_000, pct: 75, stages: [], spill: SPILL, spills: [SPILL], ms: 12, ...over,
})
const answer = (over: Record<string, unknown> = {}, rec: Record<string, unknown> = {}) =>
  () => out(JSON.stringify({ decision: 'compressed', reason: null, result: SLIMMED, figure: FIGURE, record: record(rec), ...over }))
const passAnswer = () => out(JSON.stringify({ decision: 'passthrough', reason: 'non-json', record: record({ decision: 'passthrough', engine: null }) }))

/** Reads slim's state from beside it: any plugin reads any value. */
const PEEK = {
  name: 'peek',
  register(on: On) {
    on('command.run', { command: 'peek-slim' } as any, async ($: any, e: any) => ({
      text: JSON.stringify({
        events: (await $.state.get({ plugin: 'slim', key: 'events' })).value ?? [],
        row: (await $.state.get({ plugin: 'slim', key: 'rows', id: e.args })).value ?? null,
      }),
    }))
  },
}
const peek = async ($: any, id = ''): Promise<{ events: any[]; row: any }> =>
  JSON.parse((await $.command.run({ command: 'peek-slim', args: id })).text)

type Answer = (() => ReturnType<typeof out>) | 'reject'

/** The world beneath the mod: `below` is what the tool answers, `core` the slim.cjs child, `errCore` its --error run. */
function world(on: On, below: Record<string, unknown>, core: Answer = answer(), env: Record<string, string> = {}, errCore: Answer = () => out('')) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, env)
  const w = { runs: [] as Run[], errors: [] as Run[], toasts: [] as { text: string; timeoutMs?: number }[], ids: [] as string[], listThrows: false }
  on('session.id', async () => ({ value: 'S' }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('agent.list', async () => {
    if (w.listThrows) throw new Error('boom')
    return { value: AGENTS as any }
  })
  on('ui.toast', async (_$, e) => {
    w.toasts.push(e)
    return { value: undefined }
  })
  on('process.run', async (_$, e) => {
    const isErr = e.argv[2] === '--error'
    ;(isErr ? w.errors : w.runs).push(e as Run)
    const a = isErr ? errCore : core
    if (a === 'reject') throw new Error('spawn ENOENT')
    return { value: a() }
  })
  on('tool.call', async (_$, e) => {
    w.ids.push(e.tool_use_id)
    return below as any
  })
  return w
}
const stdinOf = (run: Run | undefined) => JSON.parse(run?.init?.stdin ?? 'null')

describe('M1 a big result goes through the core', () => {
  test('envelope, fresh {result}, toast, event, row', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, { result: BIG, text: BIG })
    const r = await $.tool.call({ tool: TOOL, jql: 'x' } as any)
    expect(r).toEqual({ result: SLIMMED })
    expect(w.runs.length).toBe(1)
    const [run] = w.runs
    expect(run!.argv.length).toBe(2)
    expect(run!.argv[0]).toBe('node')
    expect(run!.argv[1]).toEndWith('/scripts/slim.cjs')
    expect(run!.init?.timeoutMs).toBe(120_000)
    const stdin = stdinOf(run)
    expect(Object.keys(stdin)).toEqual(ENVELOPE_KEYS.filter(k => !['agentId', 'pre', 'bytes_in'].includes(k)))
    expect(stdin).toEqual({
      v: 1, channel: 'mcp', tool: TOOL, tool_use_id: w.ids[0], tool_input: { jql: 'x' }, tool_response: BIG,
      is_error: false, cwd: '/repo', session_id: 'S',
    })
    expect(w.toasts).toEqual([{ text: TEXT, timeoutMs: 5000 }])
    expect(w.errors).toEqual([])
    const seen = await peek($, w.ids[0])
    expect(seen.events).toEqual([
      { v: 1, atMs: 1_000_000, kind: 'slim', text: TEXT, src: 'slim', tool: TOOL, channel: 'mcp', bytesIn: 120_030, bytesOut: 30_000, engine: 'json', ms: 12 },
    ])
    expect(seen.row).toEqual({ engine: 'json', bytesIn: 120_030, bytesOut: 30_000 })
  })

  test('M2 context from beneath is carried over', async ($, on) => {
    world(on, { result: BIG, text: BIG, context: ['lower plugin note'] })
    expect(await $.tool.call({ tool: TOOL } as any)).toEqual({ result: SLIMMED, context: ['lower plugin note'] })
  })

  test('M12 a stubbed answer → a stubbed event, engine stub', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, { result: BIG, text: BIG }, answer({ decision: 'stubbed', reason: 'weak-gain' }, { decision: 'stubbed', engine: 'stub', bytes_out: 1_500 }))
    expect(await $.tool.call({ tool: TOOL } as any)).toEqual({ result: SLIMMED })
    expect(w.toasts.map(t => t.text)).toEqual(['searchJiraIssuesUsingJql: stubbed 120 KB → 2 KB (−99%) · stub'])
    expect((await peek($, w.ids[0])).row).toEqual({ engine: 'stub', bytesIn: 120_030, bytesOut: 1_500 })
  })
})

describe('M3 passthrough without a spawn', () => {
  const HANDLE = `<<full=${SPILL} original_result>>`
  const fndSlim = `{"a":"${'1'.repeat(5000)}"}\n\nfnd-mcp-slim: compressed 110,794 B → 22,179 B (−80.0%)\n\n${HANDLE}`
  const ownSlim = `{"a":"${'1'.repeat(5000)}"}\n\nslim: compressed 110,794 B → 22,179 B (−80.0%)\n\n${HANDLE}`
  const fndStub = `<<fnd-mcp-slim stub>> ${TOOL} returned 50,000 B (format=json) — ${'s'.repeat(6000)}`
  // fnd's output with its stub off: bigger than any stub, its figure its own size.
  let exact = ''
  for (let n = 0, i = 0; i < 10; i++) {
    exact = `${'y'.repeat(50_000)}\n\nfnd-mcp-slim: compressed 200,000 B → ${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} B (−75.0%)\n\n${HANDLE}`
    n = new TextEncoder().encode(exact).length
  }
  const cases: [string, Record<string, unknown>, string, Record<string, string>?][] = [
    ['SLIM_MCP=0', { result: BIG, text: BIG }, TOOL, { SLIM_MCP: '0' }],
    ['SLIM_MCP=0 with a host notice', { result: NOTICE, text: NOTICE }, TOOL, { SLIM_MCP: '0' }],
    ['the error arm', { result: BIG, text: BIG, isError: true }, TOOL],
    ['fnd stats + handle', { result: fndSlim, text: fndSlim }, TOOL],
    ['the fnd stub mark', { result: fndStub, text: fndStub }, TOOL],
    ["slim's own stats + handle", { result: ownSlim, text: ownSlim }, TOOL],
    ['under the gate', { result: '{"issues":[]}', text: '{"issues":[]}' }, TOOL],
  ]
  for (const [name, below, tool, env] of cases) {
    test(name, { plugins: [PEEK] }, async ($, on) => {
      const w = world(on, below, answer(), env)
      const r = await $.tool.call({ tool } as any)
      expect(r.result).toBe(below.result)
      expect(r.text).toBe(below.text as string)
      expect(w.runs.length + w.errors.length).toBe(0)
      expect(w.toasts).toEqual([])
      expect((await peek($)).events).toEqual([])
    })
  }

  test('over the bound a figure equal to its size goes to the core, which checks the handle', { plugins: [PEEK] }, async ($, on) => {
    const core = () => out(JSON.stringify({ decision: 'passthrough', reason: 'already-slim', record: record({ decision: 'passthrough', reason: 'already-slim', engine: null }) }))
    const w = world(on, { result: exact, text: exact }, core)
    const r = await $.tool.call({ tool: TOOL } as any)
    expect(r.result).toBe(exact)
    expect(w.runs.length).toBe(1)
    const stdin = stdinOf(w.runs[0])
    expect(stdin.tool_response).toBe(exact)
    expect('pre' in stdin).toBe(false)
    expect(w.toasts).toEqual([])
    expect((await peek($)).events).toEqual([])
  })

  test('a deny passes through', async ($, on) => {
    const w = world(on, { deny: 'nope' })
    expect((await $.tool.call({ tool: TOOL } as any)).deny).toBe('nope')
    expect(w.runs.length).toBe(0)
  })

  test('a non-channel tool (Edit, 200 KB) never spawns', async ($, on) => {
    const huge = 'e'.repeat(200_000)
    const w = world(on, { result: huge, text: huge }, answer(), { SLIM_DEBUG: '2' })
    expect((await $.tool.call({ tool: 'Edit', file_path: '/repo/a', old_string: 'a', new_string: 'b' } as any)).result).toBe(huge)
    expect(w.runs.length + w.errors.length).toBe(0)
  })
})

describe('M4 debug levels spawn the core to log a pre-decided passthrough', () => {
  const small = { result: '{"issues":[]}', text: '{"issues":[]}' }
  const slimmed = { result: SLIMMED, text: SLIMMED }
  const cases: [string, Record<string, unknown>, Record<string, string>, string | null][] = [
    ['SLIM_DEBUG=1, error arm', { result: BIG, text: BIG, isError: true }, { SLIM_DEBUG: '1' }, 'error-shape'],
    ['SLIM_DEBUG=1, already slim', slimmed, { SLIM_DEBUG: '1' }, null],
    ['SLIM_DEBUG=2, already slim', slimmed, { SLIM_DEBUG: '2' }, 'already-slim'],
    ['SLIM_DEBUG=1, small', small, { SLIM_DEBUG: '1' }, null],
    ['SLIM_DEBUG=2, small', small, { SLIM_DEBUG: '2' }, 'size-gate'],
  ]
  for (const [name, below, env, pre] of cases) {
    test(name, async ($, on) => {
      // The core answering `compressed` proves a pre-decided call never takes its result.
      const w = world(on, below, answer(), env)
      const r = await $.tool.call({ tool: TOOL } as any)
      expect(r.result).toBe(below.result)
      expect(w.toasts).toEqual([])
      expect(w.runs.length).toBe(pre ? 1 : 0)
      if (pre) {
        const stdin = stdinOf(w.runs[0])
        expect(Object.keys(stdin)).toEqual(ENVELOPE_KEYS.filter(k => k !== 'agentId'))
        expect(stdin.pre).toBe(pre)
        expect(stdin.tool_response).toBeNull()
        expect(typeof stdin.bytes_in).toBe('number')
        expect(stdin.is_error).toBe(pre === 'error-shape')
      }
    })
  }
})

describe('M5 the host overflow notice', () => {
  test('a small notice → spawned without pre → {result}', async ($, on) => {
    const w = world(on, { result: NOTICE, text: NOTICE })
    expect(await $.tool.call({ tool: TOOL } as any)).toEqual({ result: SLIMMED })
    const stdin = stdinOf(w.runs[0])
    expect(stdin.tool_response).toBe(NOTICE)
    expect(stdin.is_error).toBe(false)
    expect('pre' in stdin).toBe(false)
  })

  test('on the error arm the core passes it through → r unchanged, no toast or row', { plugins: [PEEK] }, async ($, on) => {
    const core = () => out(JSON.stringify({ decision: 'passthrough', reason: 'error-shape', record: record({ decision: 'passthrough', reason: 'error-shape', engine: null }) }))
    const w = world(on, { result: NOTICE, text: NOTICE, isError: true }, core)
    const r = await $.tool.call({ tool: TOOL } as any)
    expect(r.result).toBe(NOTICE)
    expect(r.isError).toBe(true)
    const stdin = stdinOf(w.runs[0])
    expect([stdin.tool_response, stdin.is_error, 'pre' in stdin]).toEqual([NOTICE, true, false])
    expect(w.toasts).toEqual([])
    expect(await peek($, w.ids[0])).toEqual({ events: [], row: null })
  })

  for (const label of ['fnd-mcp-slim', 'slim']) {
    test(`${label} output quoting the phrase above its host-file handle is no notice: no spawn`, async ($, on) => {
      const host = '/Users/me/.claude/projects/-repo/S/tool-results/mcp-x-y-1791010865179.txt'
      const quoted = `{"issues":[{"summary":"MCP result exceeds maximum allowed tokens"}]}\n\n${label}: compressed 110,794 B → 3,395 B (−96.9%)\n\n<<full=${host} original_result>>`
      const w = world(on, { result: quoted, text: quoted })
      const r = await $.tool.call({ tool: TOOL } as any)
      expect(r.result).toBe(quoted)
      expect(w.runs.length + w.errors.length).toBe(0)
    })
  }

  test('in a text block too', async ($, on) => {
    const w = world(on, { result: [{ type: 'text', text: NOTICE }] })
    expect(await $.tool.call({ tool: TOOL } as any)).toEqual({ result: SLIMMED })
    expect(stdinOf(w.runs[0]).tool_response).toEqual([{ type: 'text', text: NOTICE }])
  })
})

test('M6 the core passes through → r unchanged, no toast, event or row', { plugins: [PEEK] }, async ($, on) => {
  const w = world(on, { result: BIG, text: BIG }, passAnswer)
  const r = await $.tool.call({ tool: TOOL } as any)
  expect(r.result).toBe(BIG)
  expect(r.text).toBe(BIG)
  expect(w.runs.length).toBe(1)
  expect(w.toasts).toEqual([])
  expect(await peek($, w.ids[0])).toEqual({ events: [], row: null })
})

describe('M7 subagents', () => {
  test('a listed agent: no toast, its type in the text and the event, agentId on stdin', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, { result: BIG, text: BIG })
    expect(await $.tool.call({ tool: TOOL, agentId: 'agent-7' } as any)).toEqual({ result: SLIMMED })
    expect(w.toasts).toEqual([])
    const stdin = stdinOf(w.runs[0])
    expect(stdin.agentId).toBe('agent-7')
    expect(Object.keys(stdin)).toEqual(ENVELOPE_KEYS.filter(k => k !== 'pre' && k !== 'bytes_in'))
    const [ev] = (await peek($)).events
    expect(ev.text).toBe(`jira-reader · ${TEXT}`)
    expect(ev.agentType).toBe('fnd:jira-reader')
  })

  test('an unlisted agent → `agent · `, agentType agent', { plugins: [PEEK] }, async ($, on) => {
    world(on, { result: BIG, text: BIG })
    await $.tool.call({ tool: TOOL, agentId: 'agent-fork' } as any)
    const [ev] = (await peek($)).events
    expect(ev.text).toBe(`agent · ${TEXT}`)
    expect(ev.agentType).toBe('agent')
  })

  test('a failing agent list → `agent · `, the result still replaced', { plugins: [PEEK] }, async ($, on) => {
    world(on, { result: BIG, text: BIG }).listThrows = true
    expect(await $.tool.call({ tool: TOOL, agentId: 'agent-7' } as any)).toEqual({ result: SLIMMED })
    expect((await peek($)).events.map(ev => ev.text)).toEqual([`agent · ${TEXT}`])
  })
})

describe('M8 switches', () => {
  test('SLIM_TOAST=0 → no toast, the event written', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, { result: BIG, text: BIG }, answer(), { SLIM_TOAST: '0' })
    expect(await $.tool.call({ tool: TOOL } as any)).toEqual({ result: SLIMMED })
    expect(w.toasts).toEqual([])
    expect((await peek($)).events.map(ev => ev.text)).toEqual([TEXT])
  })

  test('SLIM_TOAST_MS sets how long the toast stays', async ($, on) => {
    const w = world(on, { result: BIG, text: BIG }, answer(), { SLIM_TOAST_MS: '2500' })
    await $.tool.call({ tool: TOOL } as any)
    expect(w.toasts).toEqual([{ text: TEXT, timeoutMs: 2500 }])
  })

  test('SLIM_EVENT_LOG=0 → no event, the row still written', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, { result: BIG, text: BIG }, answer(), { SLIM_EVENT_LOG: '0' })
    expect(await $.tool.call({ tool: TOOL } as any)).toEqual({ result: SLIMMED })
    const seen = await peek($, w.ids[0])
    expect(seen.events).toEqual([])
    expect(seen.row).toEqual({ engine: 'json', bytesIn: 120_030, bytesOut: 30_000 })
  })
})

describe('M9 a failed core run → r unchanged and one --error spawn', () => {
  const cases: [string, Answer, string][] = [
    ['a reject', 'reject', 'spawn-rejected'],
    ['exit 1', () => out(JSON.stringify({ decision: 'compressed', result: SLIMMED, record: record() }), 1), 'exit-1'],
    ['truncated stdout', () => out('{"decision":"compressed"', 0, true), 'stdout-truncated'],
    ['garbage', () => out('{bad'), 'bad-output'],
    ['empty stdout', () => out(''), 'bad-output'],
    ['an unknown engine', answer({}, { engine: 'xml' }), 'bad-output'],
  ]
  for (const [name, core, reason] of cases) {
    test(name, { plugins: [PEEK] }, async ($, on) => {
      const w = world(on, { result: BIG, text: BIG }, core)
      const r = await $.tool.call({ tool: TOOL } as any)
      expect(r.result).toBe(BIG)
      expect(r.text).toBe(BIG)
      expect(w.toasts).toEqual([])
      expect((await peek($)).events).toEqual([])
      expect(w.errors.length).toBe(1)
      const [err] = w.errors
      expect(err!.argv[1]).toEndWith('/scripts/slim.cjs')
      expect(err!.init?.timeoutMs).toBe(10_000)
      const payload = stdinOf(err)
      expect(payload).toMatchObject({ v: 1, channel: 'mcp', tool: TOOL, tool_use_id: w.ids[0], cwd: '/repo', error: { name: reason } })
      expect(typeof payload.error.message).toBe('string')
      expect(payload.error.message.length).toBeLessThanOrEqual(200)
    })
  }

  test('M10 the core answering error → r unchanged, no --error spawn', async ($, on) => {
    const w = world(on, { result: BIG, text: BIG }, () => out(JSON.stringify({ decision: 'error', reason: 'TypeError', record: record({ decision: 'error', engine: null }) })))
    expect((await $.tool.call({ tool: TOOL } as any)).result).toBe(BIG)
    expect(w.errors.length).toBe(0)
    expect(w.toasts).toEqual([])
  })

  test('M11 the --error spawn rejecting too → r returned, nothing thrown', async ($, on) => {
    const w = world(on, { result: BIG, text: BIG }, 'reject', {}, 'reject')
    expect((await $.tool.call({ tool: TOOL } as any)).result).toBe(BIG)
    expect(w.errors.length).toBe(1)
  })
})
