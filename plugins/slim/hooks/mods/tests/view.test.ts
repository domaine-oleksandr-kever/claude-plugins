import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { BAD_ARGS, INLINE, NO_URL, VIEW_DESC, headOf, mediaName, mediaProbe, replyText } from '../view.ts'
import { viewText } from '../events.ts'

type Run = { argv: readonly string[]; init?: { stdin?: string; timeoutMs?: number } }
const VIEW = 'mcp__slim__view'
const PROVIDER = { plugin: 'engine', tier: 'core' } as any
const ok = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const bytes = (s: string) => new TextEncoder().encode(s).length

/** Reads slim's events from beside it. */
const PEEK = {
  name: 'peek',
  register(on: On) {
    on('command.run', { command: 'peek-slim' } as any, async ($: any) => ({
      text: JSON.stringify((await $.state.get({ plugin: 'slim', key: 'events' })).value ?? []),
    }))
  },
}
const events = async ($: any): Promise<any[]> => JSON.parse((await $.command.run({ command: 'peek-slim', args: '' })).text)

const REPLY = {
  v: 1, decision: 'compressed', engine: 'json', figure: 'slim: compressed 118,000 B → 29,000 B (−75.4%)', text: '{"issues":[{"key":"ELC-1"}]}',
  bytesIn: 118_000, bytesOut: 29_000, stages: ['crush'],
}

type Check = 'allow' | 'ask' | 'deny'
type Opts = {
  reply?: Record<string, unknown>
  env?: Record<string, string>
  read?: Check
  write?: Check
  below?: (e: any) => unknown
  agents?: any[]
  answer?: string | null
}
function world(on: On, o: Opts = {}) {
  mock.clock(on, { now: 10_000 })
  mock.store(on)
  mock.env(on, o.env ?? {})
  const w = { views: [] as any[], records: [] as any[], other: [] as Run[], calls: [] as any[], checks: [] as any[], regs: [] as any[], asked: [] as string[] }
  on('session.id', async () => ({ value: 'S' }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('session.root', async () => ({ value: '/repo' }))
  on('agent.list', async () => ({ value: (o.agents ?? [{ id: 'agent-7', description: 'd', type: 'core:jira-reader', status: 'running' }]) as any }))
  on('tool.register', async (_$, e) => {
    w.regs.push(e)
    return { value: { tool: `mcp__slim__${e.name}` } }
  })
  on('tool.check', async (_$, e) => {
    w.checks.push(e)
    const d = e.tool === 'Write' ? (o.write ?? 'allow') : (o.read ?? 'allow')
    return d === 'deny' ? { decision: 'deny', reason: `${e.tool} denied by rule` } : { decision: d }
  })
  on('process.run', async (_$, e) => {
    const stdin = JSON.parse(e.init?.stdin ?? 'null')
    if (e.argv[2] === '--view') {
      w.views.push({ stdin, timeoutMs: e.init?.timeoutMs })
      return { value: ok(JSON.stringify(o.reply ?? REPLY)) }
    }
    if (e.argv[2] === '--record') {
      w.records.push(stdin)
      return { value: ok('') }
    }
    w.other.push(e as Run)
    return { value: ok('') }
  })
  on('tool.call', async (_$, e) => {
    if (e.tool === 'AskUserQuestion') {
      const q = (e as any).questions[0]
      w.asked.push(q.question)
      if (o.answer === null || o.answer === undefined) throw new Error('dismissed')
      return { result: { questions: (e as any).questions, answers: { [q.question]: o.answer } } } as any
    }
    w.calls.push(e)
    if (o.below) return o.below(e) as any
    if (e.tool === 'Write') return { result: { type: 'create', filePath: (e as any).file_path }, text: 'ok' } as any
    if (e.tool === 'Read') return { result: { type: 'text', file: { filePath: (e as any).file_path, content: 'x', numLines: 1, startLine: 1, totalLines: 1 } }, text: 'x' } as any
    return { result: { stdout: 'out', stderr: '', interrupted: false }, text: 'out' } as any
  })
  on('tool.describe', async (_$, e) => (e.isDeferred ? { description: e.description, isDeferred: true } : { description: e.description }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  return w
}
const view = async ($: any, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  String((await $.tool.call({ tool: VIEW, ...args, ...extra })).result)

describe('V1 registration', () => {
  test('pinned into the prompt\'s tool list, under SLIM_LOOKUP=0 too', async ($, on) => {
    world(on, { env: { SLIM_LOOKUP: '0' } })
    const d = await $.tool.describe({ tool: VIEW, description: VIEW_DESC, isDeferred: true, provider: PROVIDER } as any)
    expect(d.isDeferred).toBe(false)
  })
})

describe('V2 path', () => {
  test('Read check, a one-line Read, one --view spawn, the figure and text, a Log line and a report row', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on)
    const text = await view($, { path: '/repo/issues.json' })
    expect(w.checks).toEqual([{ tool: 'Read', input: { file_path: '/repo/issues.json' } }])
    expect(w.calls.map(c => [c.tool, c.file_path, c.limit])).toEqual([['Read', '/repo/issues.json', 1]])
    expect(w.views).toHaveLength(1)
    expect(w.views[0].stdin).toEqual({ v: 1, path: '/repo/issues.json', root: '/repo', cwd: '/repo', session_id: 'S' })
    expect(w.views[0].timeoutMs).toBe(120_000)
    expect(text).toBe(`${REPLY.figure}\n--- head ---\n${REPLY.text}`)
    expect((await events($)).map(e => [e.kind, e.channel, e.text, e.engine, e.bytesIn, e.bytesOut, e.decision])).toEqual([
      ['view', 'view', 'view issues.json: 118 KB → 29 KB (−75%) · json', 'json', 118_000, 29_000, 'compressed'],
    ])
    expect(w.records).toHaveLength(1)
    expect(w.records[0]).toMatchObject({
      channel: 'view', decision: 'compressed', reason: null, rung: 'path', engine: 'json', bytes_in: 118_000, bytes_out: 29_000,
      stages: ['crush'], spill: null, ms: 0, cwd: '/repo',
    })
    expect(typeof w.records[0].tool_use_id).toBe('string')
  })

  test('a subagent\'s call is prefixed with its type', { plugins: [PEEK] }, async ($, on) => {
    world(on)
    await view($, { path: '/repo/issues.json' }, { agentId: 'agent-7' })
    const ev = (await events($))[0]
    expect([ev.text, ev.agentType]).toEqual(['jira-reader · view issues.json: 118 KB → 29 KB (−75%) · json', 'core:jira-reader'])
  })

  test('the Read check denies: its reason, no Read, no spawn, a refused row', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, { read: 'deny' })
    expect(await view($, { path: '/etc/secret.json' })).toBe('Read denied by rule')
    expect(w.calls).toEqual([])
    expect(w.views).toEqual([])
    expect(w.records[0]).toMatchObject({ decision: 'refused', reason: 'read-denied', rung: 'path' })
    expect((await events($))[0].text).toBe('view secret.json: refused (read-denied)')
  })

  test('the Read check asks: a one-line Read opens the dialog; its deny is the answer', async ($, on) => {
    const w = world(on, { read: 'ask', below: e => (e.tool === 'Read' ? { deny: 'user said no' } : { result: {} }) })
    expect(await view($, { path: '/outside/a.json' })).toBe('user said no')
    expect(w.calls.map(c => [c.tool, c.file_path, c.limit])).toEqual([['Read', '/outside/a.json', 1]])
    expect(w.views).toEqual([])
  })

  test('the Read check allows but a guard on the Read denies: its reason, no spawn', async ($, on) => {
    const w = world(on, { below: e => (e.tool === 'Read' ? { deny: 'guard: .env is off limits' } : { result: {} }) })
    expect(await view($, { path: '/repo/.env' })).toBe('guard: .env is off limits')
    expect(w.views).toEqual([])
  })

  test('the core gets the path the Read opened', async ($, on) => {
    const w = world(on, { below: () => ({ result: { type: 'text', file: { filePath: '/repo/real/a.json', content: 'x', numLines: 1, startLine: 1, totalLines: 1 } }, text: 'x' }) })
    await view($, { path: '/repo/link/a.json' })
    expect(w.views[0].stdin.path).toBe('/repo/real/a.json')
  })

  test('a Read error is the answer', async ($, on) => {
    const w = world(on, { below: () => ({ result: 'File does not exist.', text: 'File does not exist.', isError: true }) })
    expect(await view($, { path: '/repo/nope.json' })).toBe('File does not exist.')
    expect(w.views).toEqual([])
  })

  test('a one-line file over the Read token or bytes cap still reaches the core; another Read error does not', async ($, on) => {
    const cap = 'File content (181010 tokens) exceeds maximum allowed tokens (25000). Use offset and limit parameters to read specific portions of the file, or use the GrepTool to search for specific content.'
    let text = cap
    const w = world(on, { below: () => ({ result: text, text, isError: true }) })
    const host = '/Users/me/.claude/projects/-repo/S/tool-results/b8nxu0l2w.txt'
    expect(await view($, { path: host, jq: '.[0]' })).toBe(`${REPLY.figure}\n--- head ---\n${REPLY.text}`)
    expect(w.views[0].stdin).toMatchObject({ path: host, jq: '.[0]', cwd: '/repo' })
    expect(await view($, { path: 'rel/whale.json' })).toBe(`${REPLY.figure}\n--- head ---\n${REPLY.text}`)
    expect(w.views[1].stdin).toMatchObject({ path: 'rel/whale.json', cwd: '/repo' })
    text = 'The requested line range contains over 3.1MB of text, more than a read can return. Use a smaller limit \u2014 or, if a single line is this large, no limit will fit it: search for specific content instead.'
    expect(await view($, { path: host })).toBe(`${REPLY.figure}\n--- head ---\n${REPLY.text}`)
    expect(w.views[2].stdin).toMatchObject({ path: host })
    text = 'EISDIR: illegal operation on a directory, read'
    expect(await view($, { path: '/repo/dir' })).toBe(text)
    expect(w.views).toHaveLength(3)
  })

  test('the Read check asks and the Read passes: the core runs', async ($, on) => {
    const w = world(on, { read: 'ask' })
    await view($, { path: '/outside/a.json' })
    expect(w.views).toHaveLength(1)
  })

  test('jq and engine pass through to the core; the core\'s jq refusal is the answer', async ($, on) => {
    const msg = "jq: unsupported syntax near 'select(' — supported: …"
    const w = world(on, { reply: { v: 1, decision: 'refused', reason: 'jq-unsupported', engine: null, figure: msg, text: msg, bytesIn: 0, bytesOut: 0, stages: [] } })
    expect(await view($, { path: '/repo/a.json', jq: '.a[] | select(.b)', engine: 'json' })).toBe(msg)
    expect(w.views[0].stdin).toMatchObject({ path: '/repo/a.json', jq: '.a[] | select(.b)', engine: 'json' })
    expect(w.records[0]).toMatchObject({ decision: 'refused', reason: 'jq-unsupported' })
  })

  test('a narrowed reply: the Log says so and the row is marked', { plugins: [PEEK] }, async ($, on) => {
    const figure = 'slim view: narrowed by jq to 40 B of a 63,004 B source (no saving figure: jq changed the measured object)'
    const w = world(on, { reply: { ...REPLY, decision: 'narrowed', figure, text: '["ELC-1","ELC-2"]', bytesIn: 63_004, bytesOut: 40, stages: [], narrowed: true } })
    expect(await view($, { path: '/repo/a.json', jq: '.issues[].key' })).toBe(`${figure}\n--- head ---\n["ELC-1","ELC-2"]`)
    expect((await events($))[0].text).toBe('view a.json: 63 KB → 40 B (narrowed by jq) · json')
    expect(w.records[0]).toMatchObject({ decision: 'narrowed', narrowed: true })
  })
})

describe('V3 command', () => {
  test('runs through Bash; a persisted output goes to the core as its host file', async ($, on) => {
    const w = world(on, { below: () => ({ result: { stdout: 'preview', stderr: '', interrupted: false, persistedOutputPath: '/cfg/projects/p/S/tool-results/b1.txt' }, text: 'preview' }) })
    await view($, { command: 'cat big.json' })
    expect(w.calls.map(c => [c.tool, c.command])).toEqual([['Bash', 'cat big.json']])
    expect(w.checks).toEqual([])
    expect(w.views[0].stdin).toMatchObject({ host_path: '/cfg/projects/p/S/tool-results/b1.txt', command: 'cat big.json' })
    expect(w.records[0]).toMatchObject({ rung: 'command' })
  })

  test('its stdout goes as text', async ($, on) => {
    const w = world(on)
    await view($, { command: 'echo hi' })
    expect(w.views[0].stdin).toMatchObject({ text: 'out', command: 'echo hi' })
  })

  test('a Bash deny is the answer', async ($, on) => {
    const w = world(on, { below: () => ({ deny: 'Bash(rm:*) denied' }) })
    expect(await view($, { command: 'rm -rf x' })).toBe('Bash(rm:*) denied')
    expect(w.views).toEqual([])
  })
})

describe('V4 out', () => {
  const OUT = '/repo/.claude/tasks/T1/issues.md'
  const marker = '<<slim view k=0123456789ab engine=json v=0.5.0>>'
  const content = `${marker}\n${REPLY.text}`
  const written = { ...REPLY, out: OUT, lines: 2, pointer: OUT, write: { path: OUT, marker, exists: false } }
  const writes = (w: any) => w.calls.filter((c: any) => c.file_path === OUT)

  test('the core\'s write goes through the Write tool; the reply names the file', async ($, on) => {
    const w = world(on, { reply: written })
    const text = await view($, { path: '/repo/issues.json', out: OUT })
    expect(w.views[0].stdin).toMatchObject({ out: OUT })
    expect(writes(w).map((c: any) => [c.tool, c.file_path, c.content])).toEqual([['Write', OUT, content]])
    expect(text).toBe(`${REPLY.figure}\nout: ${OUT} (2 lines)\n--- head ---\n${REPLY.text}`)
    expect(w.records[0]).toMatchObject({ decision: 'compressed', spill: OUT })
  })

  test('an existing out is Read first, as the Write tool requires', async ($, on) => {
    const w = world(on, { reply: { ...written, write: { ...written.write, exists: true } } })
    await view($, { path: '/repo/issues.json', out: OUT })
    expect(writes(w).map((c: any) => [c.tool, c.file_path, c.limit])).toEqual([['Read', OUT, 1], ['Write', OUT, undefined]])
  })

  test('a Write deny is the answer: nothing else, a refused row', async ($, on) => {
    const w = world(on, { reply: written, below: e => (e.tool === 'Write' ? { deny: 'guard: not there' } : { result: { type: 'text', file: { filePath: e.file_path } } }) })
    expect(await view($, { path: '/repo/issues.json', out: OUT })).toBe('guard: not there')
    expect(w.records[0]).toMatchObject({ decision: 'refused', reason: 'write-denied', engine: 'json' })
  })

  test('an out outside the roots is the core\'s refusal: no Write', async ($, on) => {
    const msg = 'view: out must be under <project>/.claude/tasks/<id>/ or slim\'s spill root (/tmp)'
    const w = world(on, { reply: { v: 1, decision: 'refused', reason: 'out-outside-roots', engine: null, figure: msg, text: msg, bytesIn: 0, bytesOut: 0, stages: [] } })
    expect(await view($, { path: '/repo/issues.json', out: '/etc/x.md' })).toBe(msg)
    expect(w.calls.map(c => c.tool)).toEqual(['Read'])
  })

  test('cached: no write, the figure says so', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, { reply: { v: 1, decision: 'cached', engine: 'json', figure: 'cached', text: REPLY.text, bytesIn: 118_000, bytesOut: 28, stages: [], out: OUT, lines: 2, pointer: OUT } })
    expect(await view($, { path: '/repo/issues.json', out: OUT })).toBe(`cached\nout: ${OUT} (2 lines)\n--- head ---\n${REPLY.text}`)
    expect(writes(w)).toEqual([])
    expect((await events($))[0].text).toBe('view issues.json: cached 28 B · json')
  })
})

describe('V5 media', () => {
  test('an image: a one-line Read, the Write check on the first output, then the core gets it as allowed_out', async ($, on) => {
    const figure = 'media: 5000 B → 900 B (-82%) frames=1'
    const w = world(on, { reply: { v: 1, decision: 'compressed', engine: 'media', figure, text: 'image png 4000×3000 → 1568×1176, metadata stripped (ffmpeg)\n/repo/a/shot.1568.png', bytesIn: 5000, bytesOut: 900, stages: [], frames: 1 } })
    const text = await view($, { path: '/repo/a/shot.webp' })
    expect(w.checks).toEqual([{ tool: 'Read', input: { file_path: '/repo/a/shot.webp' } }, { tool: 'Write', input: { file_path: '/repo/a/shot.1568.png' } }])
    expect(w.calls.map(c => [c.tool, c.file_path, c.limit])).toEqual([['Read', '/repo/a/shot.webp', 1]])
    expect(w.asked).toEqual([])
    expect(w.views[0].stdin).toMatchObject({ path: '/repo/a/shot.webp', media: true, allowed_out: '/repo/a/shot.1568.png' })
    expect(text).toBe(`${figure}\nimage png 4000×3000 → 1568×1176, metadata stripped (ffmpeg)\n/repo/a/shot.1568.png`)
    expect(w.records[0]).toMatchObject({ engine: 'media', frames: 1 })
  })

  test('a video: no Read (the Read tool cannot open one); its probe is its first frame; a relative path is made absolute', async ($, on) => {
    const w = world(on)
    await view($, { path: 'clips/demo.MOV' })
    expect(w.checks).toEqual([{ tool: 'Read', input: { file_path: 'clips/demo.MOV' } }, { tool: 'Write', input: { file_path: '/repo/clips/demo.frames/001.jpg' } }])
    expect(w.calls).toEqual([])
    expect(w.views[0].stdin.allowed_out).toBe('/repo/clips/demo.frames/001.jpg')
    expect(w.views[0].stdin.media).toBe(true)
  })

  test('a Write check that asks: one Yes/No; yes runs the core', async ($, on) => {
    const w = world(on, { write: 'ask', answer: 'Yes' })
    await view($, { path: '/repo/shot.png' })
    expect(w.asked).toEqual(['Let slim read /repo/shot.png and write a resized copy /repo/shot.1568.png?'])
    expect(w.views[0].stdin).toMatchObject({ path: '/repo/shot.png', allowed_out: '/repo/shot.1568.png' })
  })

  const NOT_CONFIRMED = 'view: not confirmed — reading /repo/shot.png and writing a resized copy /repo/shot.1568.png needs a yes'
  test('a Write check that asks and a no: refused before any spawn', async ($, on) => {
    const w = world(on, { write: 'ask', answer: 'No' })
    expect(await view($, { path: '/repo/shot.png' })).toBe(NOT_CONFIRMED)
    expect(w.views).toEqual([])
    expect(w.records[0]).toMatchObject({ decision: 'refused', reason: 'not-confirmed' })
  })

  test('a Write check that asks and a dismissed question: refused before any spawn', async ($, on) => {
    const w = world(on, { write: 'ask', answer: null })
    expect(await view($, { path: '/repo/shot.png' })).toBe(NOT_CONFIRMED)
    expect(w.views).toEqual([])
  })

  test('a video whose Read and Write checks both ask: one question for both', async ($, on) => {
    const w = world(on, { read: 'ask', write: 'ask', answer: 'Yes' })
    await view($, { path: '/repo/rec.mov' })
    expect(w.asked).toEqual(['Let slim read /repo/rec.mov and write frames into /repo/rec.frames/?'])
    expect(w.calls).toEqual([])
    expect(w.views).toHaveLength(1)
  })

  test('a guard that denies an image\'s Read: refused, no Write check, no spawn', async ($, on) => {
    const w = world(on, { below: e => (e.tool === 'Read' ? { deny: 'guard: not that image' } : { result: {} }) })
    expect(await view($, { path: '/repo/shot.png' })).toBe('guard: not that image')
    expect(w.checks.map(c => c.tool)).toEqual(['Read'])
    expect(w.views).toEqual([])
  })

  test('a Write check that denies: its reason, no spawn', async ($, on) => {
    const w = world(on, { write: 'deny' })
    expect(await view($, { path: '/repo/shot.png' })).toBe('view: writing /repo/shot.1568.png is denied (Write denied by rule)')
    expect(w.views).toEqual([])
  })

  test('a text name is never Write-checked', async ($, on) => {
    const w = world(on)
    await view($, { path: '/repo/a.json' })
    expect(w.checks.map(c => c.tool)).toEqual(['Read'])
    expect(w.views[0].stdin.allowed_out).toBeUndefined()
    expect(w.views[0].stdin.media).toBeUndefined()
  })
})

describe('V6 arguments', () => {
  test('url is refused without a call; path and command together or neither: BAD_ARGS; an unknown engine', async ($, on) => {
    const w = world(on)
    expect(await view($, { url: 'https://x.example' })).toBe(NO_URL)
    expect(await view($, { url: 'https://x.example', path: '/repo/a.json' })).toBe(NO_URL)
    expect(await view($, { path: '/repo/a.json', command: 'ls' })).toBe(BAD_ARGS)
    expect(await view($, {})).toBe(BAD_ARGS)
    expect(await view($, { path: '  ' })).toBe(BAD_ARGS)
    expect(await view($, { path: '/repo/a.json', engine: 'xml' })).toMatch(/^view: unknown engine 'xml' — one of json, /)
    expect([w.calls, w.checks, w.views, w.records]).toEqual([[], [], [], []])
  })

  test('a broken core answer is a refusal, never a throw', async ($, on) => {
    world(on, { reply: { nope: 1 } })
    expect(await view($, { path: '/repo/a.json' })).toBe('view failed: core bad-output')
  })
})

describe('V7 the result is not slimmed again', () => {
  test('a 200 KB view answer passes the intake untouched: no core run but --view and --record', async ($, on) => {
    const big = `{"rows":[${'{"a":1},'.repeat(25_000)}{}]}`
    const w = world(on, { reply: { ...REPLY, text: big, bytesOut: bytes(big), pointer: '/tmp/fnd-mcp-slim-0123456789abcdef.txt' } })
    const text = await view($, { path: '/repo/a.json' })
    expect(w.other).toEqual([])
    expect(bytes(text)).toBeLessThanOrEqual(INLINE)
    expect(text.endsWith('… 1 lines in all — read /tmp/fnd-mcp-slim-0123456789abcdef.txt windowed (offset/limit)')).toBe(true)
  })
})

describe('V8 pure helpers', () => {
  test('mediaName and mediaProbe from the name alone', () => {
    expect([mediaName('/a/b.PNG'), mediaName('/a/b.mp4'), mediaName('/a/b.json'), mediaName('/a/.png')]).toEqual([true, true, false, false])
    expect(mediaProbe('/a/b.JPG')).toBe('/a/b.1568.jpg')
    expect(mediaProbe('/a/b.webp')).toBe('/a/b.1568.png')
    expect(mediaProbe('/a/x.y.gif')).toBe('/a/x.y.1568.gif')
    expect(mediaProbe('/a/clip.webm')).toBe('/a/clip.frames/001.jpg')
    expect(mediaProbe('/shot.png')).toBe('/shot.1568.png')
  })

  test('headOf: at most N lines and B bytes, a long line cut with …', () => {
    expect(headOf('a\nb\nc', 2, 100)).toBe('a\nb')
    const cut = headOf(`${'é'.repeat(100)}\nz`, 40, 50)
    expect(bytes(cut)).toBeLessThanOrEqual(50)
    expect(cut.endsWith('…')).toBe(true)
  })

  test('replyText: whole up to 16 KB, else 40 lines and where to read on', () => {
    const base = { decision: 'compressed', engine: 'log', figure: 'F', bytesIn: 1, bytesOut: 1, stages: [] } as any
    expect(replyText({ ...base, text: 'x' })).toBe('F\n--- head ---\nx')
    const long = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'y'.repeat(20)}`).join('\n')
    const t = replyText({ ...base, text: long, out: '/o.md', lines: 2001, pointer: '/o.md' })
    expect(t.split('\n').slice(0, 3)).toEqual(['F', 'out: /o.md (2001 lines)', '--- head ---'])
    expect(t.split('\n')).toHaveLength(3 + 40 + 1)
    expect(t.endsWith('… 2000 lines in all — read /o.md windowed (offset/limit)')).toBe(true)
    expect(replyText({ ...base, decision: 'refused', text: 'why' })).toBe('why')
  })

  test('viewText for each outcome', () => {
    expect(viewText('', 'a.json', 'compressed', 'json', 118_400, 29_000)).toBe('view a.json: 118 KB → 29 KB (−76%) · json')
    expect(viewText('doc-reader · ', 'a.json', 'refused', null, 0, 0, 'write-denied')).toBe('doc-reader · view a.json: refused (write-denied)')
    expect(viewText('', 'a.json', 'cached', 'log', 0, 2_000)).toBe('view a.json: cached 2 KB · log')
    expect(viewText('', `cat ${'x'.repeat(80)}`, 'passthrough', 'text', 900, 900)).toBe(`view cat ${'x'.repeat(44)}…: 900 B → 900 B (−0%) · text`)
  })
})
