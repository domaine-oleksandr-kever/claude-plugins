import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { denyText } from '../intake.ts'

type Run = { argv: readonly string[]; init?: { stdin?: string; env?: Record<string, string>; timeoutMs?: number } }
type Below = Record<string, unknown>

const plain = (n: number) => 'line of plain text\n'.repeat(Math.ceil(n / 19)).slice(0, n)
const json = (n: number) => `{"issues":[${'{"key":"ELC-1","fields":{"summary":"x"}},'.repeat(Math.ceil(n / 41))}{}]}`
const page = (n: number) => `<!doctype html><html><head><title>T</title></head><body>${'<p>x</p>'.repeat(Math.ceil(n / 8))}</body></html>`
const bash = (stdout: string, extra: Record<string, unknown> = {}): Below =>
  ({ result: { stdout, stderr: 'warn', interrupted: false, ...extra }, text: stdout })
const readRec = (content: string, filePath: string, extra: Record<string, unknown> = {}): Below =>
  ({ result: { type: 'text', file: { filePath, content, numLines: 10, startLine: 1, totalLines: 10, ...extra } }, text: content })
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const BASH_VIEW = { stdout: 'slim view', stderr: 'warn', interrupted: false }

/** The core's answer for a compressed call: `result` restored, the record as the contract spells it. */
const compressed = (channel: string, over: Record<string, unknown> = {}) => () =>
  ok(JSON.stringify({
    decision: 'compressed', reason: null, result: BASH_VIEW, figure: 'slim: compressed',
    record: { src: 'slim', channel, entry: 'mod', decision: 'compressed', reason: null, engine: 'json', bytes_in: 120_000, bytes_out: 6_000, pct: 95, stages: [], spill: null, spills: [], ms: 9, ...over },
  }))

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

/** The world beneath slim, its env counted read by read. */
function world(on: On, below: Below | ((e: any) => Below), core: () => ReturnType<typeof ok> = compressed('bash'), env: Record<string, string> = {}, agents: any[] = []) {
  mock.clock(on, { now: 5_000 })
  mock.store(on)
  const w = { runs: [] as Run[], other: [] as Run[], toasts: [] as unknown[], calls: [] as any[], envReads: [] as string[] }
  on('env.get', async (_$, e) => {
    w.envReads.push(e.name)
    return { value: env[e.name] }
  })
  on('session.id', async () => ({ value: 'S' }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('agent.list', async () => ({ value: agents as any }))
  on('ui.toast', async (_$, e) => {
    w.toasts.push(e)
    return { value: undefined }
  })
  on('process.run', async (_$, e) => {
    ;(e.argv[2] === undefined ? w.runs : w.other).push(e as Run)
    return { value: core() }
  })
  on('tool.call', async (_$, e) => {
    w.calls.push(e)
    return (typeof below === 'function' ? below(e) : below) as any
  })
  return w
}
const stdinOf = (run: Run | undefined) => JSON.parse(run?.init?.stdin ?? 'null')

describe('K1 Bash JSON', () => {
  test('120 KB → one core run on channel bash, restored result, row and event by bytes_seen, no toast', { plugins: [PEEK] }, async ($, on) => {
    const big = json(120_000)
    const w = world(on, bash(big), compressed('bash', { bytes_seen: 100_000 }))
    const r = await $.tool.call({ tool: 'Bash', command: 'curl -s https://x.io/api' } as any)
    expect(r).toEqual({ result: BASH_VIEW })
    expect(w.runs.length).toBe(1)
    const stdin = stdinOf(w.runs[0])
    expect(stdin).toMatchObject({ v: 1, channel: 'bash', tool: 'Bash', tool_input: { command: 'curl -s https://x.io/api' }, is_error: false, cwd: '/repo', session_id: 'S' })
    expect(stdin.tool_response).toEqual({ stdout: big, stderr: 'warn', interrupted: false })
    expect('pre' in stdin).toBe(false)
    expect(w.toasts).toEqual([])
    const seen = await peek($, w.calls[0].tool_use_id)
    expect(seen.row).toEqual({ engine: 'json', bytesIn: 100_000, bytesOut: 6_000 })
    expect(seen.events).toEqual([{
      v: 1, atMs: 5_000, kind: 'slim', text: 'Bash: compressed 100 KB → 6 KB (−94%) · json', src: 'slim', tool: 'Bash',
      channel: 'bash', bytesIn: 100_000, bytesOut: 6_000, engine: 'json', ms: 9,
    }])
  })

  test('the host\'s bashOutputMaxChars setting reaches the core; an unset or bad one does not', async ($, on) => {
    let settings: Record<string, unknown> = { bashOutputMaxChars: 12_000 }
    on('settings.read', async () => ({ value: settings }))
    const w = world(on, bash(json(120_000)))
    await $.tool.call({ tool: 'Bash', command: 'curl -s https://x.io/api' } as any)
    expect(stdinOf(w.runs[0]).bash_output_max_chars).toBe(12_000)
    settings = { bashOutputMaxChars: '12000' }
    await $.tool.call({ tool: 'Bash', command: 'curl -s https://x.io/api' } as any)
    expect('bash_output_max_chars' in stdinOf(w.runs[1])).toBe(false)
  })
})

describe('K2–K4 Bash plain text and non-text', () => {
  test('K2 plain 40 KB: no spawn at any level', async ($, on) => {
    const w = world(on, bash(plain(40_000)), compressed('bash'), { SLIM_DEBUG: '2' })
    expect((await $.tool.call({ tool: 'Bash', command: 'npm test' } as any)).result).toEqual(bash(plain(40_000)).result)
    expect(w.runs.length + w.other.length).toBe(0)
  })

  test('K2 plain 70 KB: spawned', async ($, on) => {
    const w = world(on, bash(plain(70_000)))
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as any)
    expect(w.runs.length).toBe(1)
  })

  test('K2 SLIM_PLAIN_BYTES=100000 keeps 70 KB plain away from the core', async ($, on) => {
    const w = world(on, bash(plain(70_000)), compressed('bash'), { SLIM_PLAIN_BYTES: '100000' })
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as any)
    expect(w.runs.length).toBe(0)
  })

  test('K3 a persisted output with a 2 KB preview: spawned', async ($, on) => {
    const below = bash(plain(2048), { persistedOutputPath: '/u/.claude/projects/p/S/tool-results/b1.txt', persistedOutputSize: 70_000 })
    const w = world(on, below)
    expect(await $.tool.call({ tool: 'Bash', command: 'go test ./...' } as any)).toEqual({ result: BASH_VIEW })
    expect(stdinOf(w.runs[0]).tool_response.persistedOutputPath).toBe('/u/.claude/projects/p/S/tool-results/b1.txt')
  })

  for (const [name, extra] of [['isImage', { isImage: true }], ['structuredContent', { structuredContent: [{ type: 'image' }] }], ['backgroundTaskId', { backgroundTaskId: 'b7' }]] as const) {
    test(`K4 ${name}: no spawn`, async ($, on) => {
      const w = world(on, bash(json(9000), extra))
      const r = await $.tool.call({ tool: 'Bash', command: 'x' } as any)
      expect(r.result).toEqual(bash(json(9000), extra).result)
      expect(w.runs.length).toBe(0)
    })
  }

  test('K4 at SLIM_DEBUG=2: pre not-text, tool_response null, the answer ignored', async ($, on) => {
    const w = world(on, bash(json(9000), { isImage: true }), compressed('bash'), { SLIM_DEBUG: '2' })
    const r = await $.tool.call({ tool: 'Bash', command: 'x' } as any)
    expect((r.result as any).isImage).toBe(true)
    const stdin = stdinOf(w.runs[0])
    expect([stdin.pre, stdin.tool_response]).toEqual(['not-text', null])
    expect(stdin.bytes_in).toBe(new TextEncoder().encode(json(9000)).length)
  })
})

describe('K5 Read', () => {
  const rows: [string, Below, Record<string, unknown>, boolean][] = [
    ['.json truncated by the token cap', readRec(json(20_000), '/r/orders.json', { truncatedByTokenCap: true }), { file_path: '/r/orders.json' }, true],
    ['.json not truncated, 64 KB', readRec(json(64_000), '/r/orders.json'), { file_path: '/r/orders.json' }, false],
    ['with offset', readRec(json(64_000), '/r/orders.json', { truncatedByTokenCap: true }), { file_path: '/r/orders.json', offset: 100 }, false],
    ['a spill file', readRec(json(64_000), '/tmp/fnd-mcp-slim-0123456789abcdef.json', { truncatedByTokenCap: true }), { file_path: '/tmp/fnd-mcp-slim-0123456789abcdef.json' }, false],
    ['templates/product.json truncated', readRec(json(64_000), '/r/templates/product.json', { truncatedByTokenCap: true }), { file_path: '/r/templates/product.json' }, false],
    ['a .ts file, 64 KB', readRec(plain(64_000), '/r/src/app.ts'), { file_path: '/r/src/app.ts' }, false],
    ['a .log file, 40 KB', readRec(plain(40_000), '/r/app.log'), { file_path: '/r/app.log' }, true],
    ['a .log file cut at the token cap, 30 KB shown', readRec(plain(30_000), '/r/app.log', { truncatedByTokenCap: true }), { file_path: '/r/app.log' }, true],
    ['a user file named fnd-*, 40 KB', readRec(plain(40_000), '/r/fnd-export.log'), { file_path: '/r/fnd-export.log' }, true],
  ]
  for (const [name, below, input, spawn] of rows) {
    test(`${name} → ${spawn ? 'spawn' : 'no spawn'}`, async ($, on) => {
      const w = world(on, below, compressed('read'))
      await $.tool.call({ tool: 'Read', ...input } as any)
      expect(w.runs.length).toBe(spawn ? 1 : 0)
      if (spawn) expect(stdinOf(w.runs[0]).channel).toBe('read')
    })
  }

  test('a Read of a spill at SLIM_DEBUG=2 is reported spill-read and passes through untouched', async ($, on) => {
    const below = readRec(json(64_000), '/tmp/fnd-mcp-slim-0123456789abcdef.json', { truncatedByTokenCap: true })
    const w = world(on, below, compressed('read'), { SLIM_DEBUG: '2' })
    const r = await $.tool.call({ tool: 'Read', file_path: '/tmp/fnd-mcp-slim-0123456789abcdef.json' } as any)
    expect(r.result).toEqual(below.result)
    expect(stdinOf(w.runs[0]).pre).toBe('spill-read')
  })
})

describe('K6–K9 WebFetch, WebSearch, Grep/Glob, Agent', () => {
  const rec = (result: string): Below => ({ result: { bytes: 1, code: 200, codeText: 'OK', result, durationMs: 3, url: 'https://x.io' }, text: result })
  test('K6 WebFetch 40 KB HTML → spawn; 40 KB prose → none', async ($, on) => {
    const w = world(on, e => (e.url.endsWith('html') ? rec(page(40_000)) : rec(plain(40_000))), compressed('webfetch'))
    await $.tool.call({ tool: 'WebFetch', url: 'https://x.io/html', prompt: 'p' } as any)
    await $.tool.call({ tool: 'WebFetch', url: 'https://x.io/prose', prompt: 'p' } as any)
    expect(w.runs.map(r => stdinOf(r).channel)).toEqual(['webfetch'])
  })

  test('K7 WebSearch with one 100 KB string → spawn', async ($, on) => {
    const w = world(on, { result: { query: 'q', results: [plain(100_000), { tool_use_id: 't', content: [] }], durationSeconds: 1 }, text: 'x' }, compressed('websearch'))
    await $.tool.call({ tool: 'WebSearch', query: 'q' } as any)
    expect(stdinOf(w.runs[0]).channel).toBe('websearch')
  })

  test("K8 'Grep' content 30 KB → spawn; a 3000-file listing from Grep or Glob → none", async ($, on) => {
    const files = Array.from({ length: 3000 }, (_, i) => `/r/src/file-${i}.ts`)
    const w = world(on, e => (e.tool === 'Grep' && e.output_mode === 'content'
      ? { result: { mode: 'content', numFiles: 4, filenames: [], content: plain(30_000), numLines: 1500, numMatches: 1500 }, text: 'x' }
      : { result: { durationMs: 1, numFiles: 3000, filenames: files, truncated: false }, text: 'x' }), compressed('grep'))
    await $.tool.call({ tool: 'Grep', pattern: 'x', output_mode: 'content' } as any)
    await $.tool.call({ tool: 'Grep', pattern: 'x' } as any)
    await $.tool.call({ tool: 'Glob', pattern: '**/*.ts' } as any)
    expect(w.runs.map(r => stdinOf(r).channel)).toEqual(['grep'])
  })

  test('K9 Agent completed 100 KB → spawn; async_launched → none', async ($, on) => {
    const w = world(on, e => (e.description === 'done'
      ? { result: { status: 'completed', content: [{ type: 'text', text: plain(100_000) }] }, text: 'x' }
      : { result: { status: 'async_launched', agentId: 'a1' }, text: 'x' }), compressed('agent'))
    await $.tool.call({ tool: 'Agent', description: 'done', prompt: 'p' } as any)
    await $.tool.call({ tool: 'Agent', description: 'bg', prompt: 'p' } as any)
    expect(w.runs.map(r => stdinOf(r).channel)).toEqual(['agent'])
  })
})

describe('K10 @-mentioned files', () => {
  const framed = (file: string, body: string) =>
    `Called the Read tool with the following input: {"file_path":"${file}"}\nResult of calling the Read tool: ` +
    body.split('\n').map((l, i) => `${String(i + 1).padStart(6)}→${l}`).join('\n')
  const rows = Array.from({ length: 900 }, (_, i) => `{"key":"ACME-${i}","status":"open","summary":"row ${i}"}`).join('\n')
  const DATA = framed('/repo/export/issues.jsonl', rows)
  const SOURCE = framed('/repo/src/big.ts', Array.from({ length: 3000 }, (_, i) => `const v${i} = ${i}`).join('\n'))
  const attached = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'file', text, origin: { kind: 'engine' }, ...extra }) as any
  const COMPACT = 'Called the Read tool …\nResult of calling the Read tool: [compact]\n\nslim: compressed 60,000 B → 900 B (−98.5%)'
  const core = () => ok(JSON.stringify({
    decision: 'compressed', reason: null, result: { text: COMPACT }, figure: 'slim: compressed',
    record: { src: 'slim', channel: 'attachment', entry: 'hook', decision: 'compressed', reason: null, engine: 'jsonl', bytes_in: 55_000, bytes_seen: 61_000, bytes_out: 900, pct: 98.5, stages: [], spill: null, spills: [], ms: 7 },
  }))
  const echo = (on: On) => on('prompt.attachment', async (_$, e) => ({ text: e.text }))

  test('a data file: one core run with the framed text and its path, the compact text back, one Log line', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, {}, core)
    echo(on)
    const d = await $.prompt.attachment(attached(DATA))
    expect(d.text).toBe(COMPACT)
    expect(w.runs.length).toBe(1)
    expect(stdinOf(w.runs[0])).toEqual({
      v: 1, channel: 'attachment', tool: 'Attachment',
      tool_input: { type: 'file', origin: 'engine', shape: 'numbered', path: '/repo/export/issues.jsonl' },
      tool_response: { text: DATA }, is_error: false, cwd: '/repo', session_id: 'S',
    })
    expect((await peek($)).events.map((e: any) => [e.kind, e.channel, e.tool, e.text, e.bytesIn, e.bytesOut, e.engine])).toEqual([
      ['slim', 'attachment', 'Attachment', '@issues.jsonl: compressed 61 KB → 900 B (−99%) · jsonl', 61_000, 900, 'jsonl'],
    ])
  })

  test('the same content asked again (a compaction, an invalidate): the same answer, one Log line, no second report line', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, {}, core)
    echo(on)
    expect((await $.prompt.attachment(attached(DATA))).text).toBe(COMPACT)
    expect((await $.prompt.attachment(attached(DATA))).text).toBe(COMPACT)
    expect(w.runs.length).toBe(2)
    expect([stdinOf(w.runs[0]).record, stdinOf(w.runs[1]).record]).toEqual([undefined, false])
    expect((await peek($)).events).toHaveLength(1)
  })

  test('SLIM_EVENT_LOG=0: no Log line, and a second ask still skips the report line', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, {}, core, { SLIM_EVENT_LOG: '0' })
    echo(on)
    await $.prompt.attachment(attached(DATA))
    await $.prompt.attachment(attached(DATA))
    expect([stdinOf(w.runs[0]).record, stdinOf(w.runs[1]).record]).toEqual([undefined, false])
    expect((await peek($)).events).toEqual([])
  })

  test('a subagent\'s attachment carries its type', { plugins: [PEEK] }, async ($, on) => {
    world(on, {}, core, {}, [{ id: 'a9', description: 'd', type: 'core:jira-reader', status: 'running' }])
    echo(on)
    await $.prompt.attachment(attached(DATA, { agentId: 'a9' }))
    const ev = (await peek($)).events[0]
    expect([ev.text, ev.agentType]).toEqual(['jira-reader · @issues.jsonl: compressed 61 KB → 900 B (−99%) · jsonl', 'core:jira-reader'])
  })

  for (const level of ['', '1', '2']) {
    test(`a source file at SLIM_DEBUG=${level || 'unset'}: unchanged; a read-guard line only at 2`, async ($, on) => {
      const w = world(on, {}, core, level ? { SLIM_DEBUG: level } : {})
      echo(on)
      expect((await $.prompt.attachment(attached(SOURCE))).text).toBe(SOURCE)
      expect(w.runs.length).toBe(level === '2' ? 1 : 0)
      if (level === '2') {
        expect(stdinOf(w.runs[0])).toEqual({
          v: 1, channel: 'attachment', tool: 'Attachment', tool_input: { type: 'file', origin: 'engine', shape: 'numbered', path: '/repo/src/big.ts' },
          tool_response: null, is_error: false, cwd: '/repo', session_id: 'S', pre: 'read-guard', bytes_in: new TextEncoder().encode(SOURCE).length,
        })
      }
    })
  }

  test('no framing: numbered lines go to the core, which decides by content; its passthrough keeps the text', async ($, on) => {
    const bare = DATA.slice(DATA.indexOf('\n') + 1)
    const w = world(on, {}, () => ok(JSON.stringify({ decision: 'passthrough', reason: 'read-guard', record: { engine: null, bytes_in: 1, bytes_out: 1, ms: 1 } })))
    echo(on)
    expect((await $.prompt.attachment(attached(bare))).text).toBe(bare)
    expect(stdinOf(w.runs[0]).tool_input).toEqual({ type: 'file', origin: 'engine', shape: 'numbered' })
  })

  test('raw text, SLIM_ATTACH=0, a failed core: unchanged', async ($, on) => {
    const raw = rows
    const w = world(on, {}, () => ({ ...ok(''), exitCode: 1 }))
    echo(on)
    expect((await $.prompt.attachment(attached(raw))).text).toBe(raw)
    expect(w.runs.length).toBe(0)
    expect((await $.prompt.attachment(attached(DATA))).text).toBe(DATA)
    expect(w.runs.length).toBe(1)
  })

  test('SLIM_ATTACH=0: no spawn', async ($, on) => {
    const w = world(on, {}, core, { SLIM_ATTACH: '0' })
    echo(on)
    expect((await $.prompt.attachment(attached(DATA))).text).toBe(DATA)
    expect(w.runs.length + w.other.length).toBe(0)
  })

  test('a small attachment reads no env', async ($, on) => {
    const w = world(on, {})
    echo(on)
    await $.prompt.attachment({ type: 'file', text: 'tiny', origin: { kind: 'engine' } } as any)
    expect(w.envReads).toEqual([])
  })
})

describe('K11 each switch stops its own channels only', () => {
  const below = (e: any): Below => {
    switch (e.tool) {
      case 'Bash': return bash(json(120_000))
      case 'Read': return readRec(json(20_000), '/r/orders.json', { truncatedByTokenCap: true })
      case 'WebFetch': return { result: { bytes: 1, code: 200, codeText: 'OK', result: page(40_000), durationMs: 1, url: 'u' }, text: 'x' }
      case 'WebSearch': return { result: { query: 'q', results: [plain(100_000)], durationSeconds: 1 }, text: 'x' }
      case 'Grep': return { result: { mode: 'content', numFiles: 4, filenames: [], content: plain(30_000), numLines: 1500 }, text: 'x' }
      case 'Agent': return { result: { status: 'completed', content: [{ type: 'text', text: plain(100_000) }] }, text: 'x' }
      default: return { result: json(120_000), text: 'x' }
    }
  }
  const calls = [
    { tool: 'mcp__x__search' }, { tool: 'Bash', command: 'curl -s https://x.io/api' }, { tool: 'Read', file_path: '/r/orders.json' },
    { tool: 'WebFetch', url: 'https://x.io', prompt: 'p' }, { tool: 'WebSearch', query: 'q' }, { tool: 'Grep', pattern: 'x' },
    { tool: 'Agent', description: 'd', prompt: 'p' },
  ]
  const ALL = ['mcp', 'bash', 'read', 'webfetch', 'websearch', 'grep', 'agent']
  const cases: [string, string[]][] = [
    ['SLIM_MCP', ['mcp']], ['SLIM_BASH', ['bash']], ['SLIM_READ', ['read']], ['SLIM_WEB', ['webfetch', 'websearch']],
    ['SLIM_GREP', ['grep']], ['SLIM_AGENT', ['agent']],
  ]
  test('all on: every channel reaches the core', async ($, on) => {
    const w = world(on, below)
    for (const c of calls) await $.tool.call(c as any)
    expect(w.runs.map(r => stdinOf(r).channel)).toEqual(ALL)
  })
  for (const [name, stopped] of cases) {
    test(`${name}=0 stops ${stopped.join(' + ')}`, async ($, on) => {
      const w = world(on, below, compressed('bash'), { [name]: '0' })
      for (const c of calls) await $.tool.call(c as any)
      expect(w.runs.map(r => stdinOf(r).channel)).toEqual(ALL.filter(ch => !stopped.includes(ch)))
    })
  }
})

describe('K12 SLIM_CURL=deny', () => {
  test('a bare curl of a page is denied and never reaches the tool', async ($, on) => {
    const w = world(on, bash('x'), compressed('bash'), { SLIM_CURL: 'deny' })
    const r = await $.tool.call({ tool: 'Bash', command: 'curl -s https://x.io/p' } as any)
    expect(r.deny).toBe(denyText(true))
    expect(w.calls.length).toBe(0)
  })

  test('SLIM_LOOKUP=0: the refusal names WebFetch only', async ($, on) => {
    world(on, bash('x'), compressed('bash'), { SLIM_CURL: 'deny', SLIM_LOOKUP: '0' })
    const r = await $.tool.call({ tool: 'Bash', command: 'curl -s https://x.io/p' } as any)
    expect(r.deny).toBe(denyText(false))
    expect(r.deny).not.toContain('lookup')
  })

  for (const [name, command, env] of [
    ['a piped curl', 'curl -s https://x.io/p | jq .', { SLIM_CURL: 'deny' }],
    ['SLIM_CURL unset', 'curl -s https://x.io/p', {}],
    ['SLIM_CURL=1', 'curl -s https://x.io/p', { SLIM_CURL: '1' }],
  ] as const) {
    test(`${name} runs`, async ($, on) => {
      const w = world(on, bash('ok'), compressed('bash'), env)
      const r = await $.tool.call({ tool: 'Bash', command } as any)
      expect(r.deny).toBeUndefined()
      expect(w.calls.length).toBe(1)
    })
  }
})

describe('K13 lookup calls tools through slim untouched', () => {
  const distilled = () => ok(JSON.stringify({ v: 1, decision: 'compressed', engine: 'json', text: 'distilled', bytesIn: 200_000, bytesOut: 9 }))
  function lookupWorld(on: On, env: Record<string, string>) {
    const w = world(on, bash(json(200_000)), distilled, env)
    on('model.complete', async () => ({
      value: { isAnswered: true, text: '{"answer":"yes","evidence":"x"}', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as any,
    }))
    return w
  }

  test('the inner Bash call: no compression run, no row; the raw 200 KB reaches --distill', { plugins: [PEEK] }, async ($, on) => {
    const w = lookupWorld(on, {})
    const r = await $.tool.call({ tool: 'mcp__slim__lookup', command: 'cat big.json', question: 'q?' } as any)
    expect(String(r.result)).toContain('yes')
    expect(w.calls.map(c => c.tool)).toEqual(['Bash'])
    expect(w.runs.length).toBe(0)
    const distill = w.other.find(x => x.argv[2] === '--distill')
    expect(stdinOf(distill).text).toBe(json(200_000))
    expect((await peek($, w.calls[0].tool_use_id)).row).toBeNull()
  })

  test('under SLIM_CURL=deny lookup({ command: curl }) still reaches Bash: the origin guard runs first', async ($, on) => {
    const w = lookupWorld(on, { SLIM_CURL: 'deny' })
    await $.tool.call({ tool: 'mcp__slim__lookup', command: 'curl -s https://x.io/p', question: 'q?' } as any)
    expect(w.calls.map(c => [c.tool, c.command])).toEqual([['Bash', 'curl -s https://x.io/p']])
  })
})

/** Another plugin that runs Bash for its own use and hands the record back as text. */
const SIBLING = {
  name: 'sibling',
  register(on: On) {
    on('command.run', { command: 'sibling-bash' } as any, async ($: any) => {
      const r = await $.tool.call({ tool: 'Bash', command: 'gh api repos/x/y/pulls' })
      return { text: JSON.stringify(r.result) }
    })
  },
}

describe('K13b another plugin\'s tool call', () => {
  test('a 120 KB Bash JSON another plugin asked for comes back untouched: no run, no row', { plugins: [SIBLING, PEEK] }, async ($, on) => {
    const big = json(120_000)
    const w = world(on, bash(big))
    const out = JSON.parse((await $.command.run({ command: 'sibling-bash' } as any)).text)
    expect(out).toEqual(bash(big).result)
    expect(w.runs.length + w.other.length).toBe(0)
    expect((await peek($, w.calls[0].tool_use_id)).row).toBeNull()
  })
})

describe('K14 already slim on Bash', () => {
  const slimmed = `{"a":1}\n\nslim: compressed 70,000 B → 9,000 B (−87.1%)\n\n<<full=/tmp/fnd-mcp-slim-0123456789abcdef.json original_result>>${' '.repeat(5000)}`
  test('bounded: no spawn by default', async ($, on) => {
    const w = world(on, bash(slimmed))
    expect((await $.tool.call({ tool: 'Bash', command: 'cat x' } as any)).result).toEqual(bash(slimmed).result)
    expect(w.runs.length).toBe(0)
  })
  test('at SLIM_DEBUG=2 pre already-slim', async ($, on) => {
    const w = world(on, bash(slimmed), compressed('bash'), { SLIM_DEBUG: '2' })
    await $.tool.call({ tool: 'Bash', command: 'cat x' } as any)
    expect(stdinOf(w.runs[0]).pre).toBe('already-slim')
  })
})

describe('K15 cost below the floor', () => {
  test('a 1 KB Bash output and an Edit read no env and spawn nothing', async ($, on) => {
    const w = world(on, e => (e.tool === 'Bash' ? bash(plain(1024)) : { result: 'ok', text: 'ok' }))
    await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
    await $.tool.call({ tool: 'Edit', file_path: '/r/a', old_string: 'a', new_string: 'b' } as any)
    expect(w.envReads).toEqual([])
    expect(w.runs.length + w.other.length).toBe(0)
  })
})
