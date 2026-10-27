import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { BAD_ARGS, INLINE, NO_VERDICT_WRITE, PLACEHOLDER, VIEW_DESC, noUrlText, headOf, mediaName, mediaProbe, replyText, scratchProbe } from '../view.ts'
import { viewText } from '../events.ts'
import { textKey } from '../node-hook.ts'

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
/** Reads the Read guard's mark (its state id as args) from beside slim. */
const PEEK_IMAGE = {
  name: 'peek-image',
  register(on: On) {
    on('command.run', { command: 'peek-image' } as any, async ($: any, e: any) => ({
      text: String((await $.state.get({ plugin: 'slim', key: 'imageDenied', id: e.args })).value === true),
    }))
  },
}
const NO_RESIZE = 'view could not resize /repo/shot.png — Read /repo/shot.png to see it as is'
const events = async ($: any): Promise<any[]> => JSON.parse((await $.command.run({ command: 'peek-slim', args: '' })).text)

const REPLY = {
  v: 1, decision: 'compressed', engine: 'json', figure: 'slim: compressed 118,000 B → 29,000 B (−75.4%)', text: '{"issues":[{"key":"ELC-1"}]}',
  bytesIn: 118_000, bytesOut: 29_000, stages: ['crush'],
}

type Check = 'allow' | 'ask' | 'deny'
type Opts = {
  reply?: Record<string, unknown> | ((stdin: any) => Record<string, unknown>)
  env?: Record<string, string>
  read?: Check
  write?: Check
  below?: (e: any) => unknown
  agents?: any[]
  answer?: string | null
  cwd?: string
  root?: string
}
function world(on: On, o: Opts = {}) {
  mock.clock(on, { now: 10_000 })
  mock.store(on)
  mock.env(on, o.env ?? {})
  const w = { views: [] as any[], records: [] as any[], other: [] as Run[], calls: [] as any[], checks: [] as any[], regs: [] as any[], asked: [] as string[] }
  on('session.id', async () => ({ value: 'S' }))
  on('session.cwd', async () => ({ value: o.cwd ?? '/repo' }))
  on('session.root', async () => ({ value: o.root ?? '/repo' }))
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
      return { value: ok(JSON.stringify((typeof o.reply === 'function' ? o.reply(stdin) : o.reply) ?? REPLY)) }
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
  test('left deferred: slim does not pin it into the prompt\'s tool list', async ($, on) => {
    world(on)
    const d = await $.tool.describe({ tool: VIEW, description: VIEW_DESC, isDeferred: true, provider: PROVIDER } as any)
    expect(d.isDeferred).toBe(true)
  })

  test('the description names both out roots: the session root and the working directory', () => {
    expect(VIEW_DESC).toContain('a JPEG copy at most 1568 px on its long edge and about 150 KB (one already within both stays as it is)')
    expect(VIEW_DESC).toContain('out writes the compact text to a file under .claude/tasks/<id>/ or .claude/tmp/ of the session root or the working directory (or slim\'s spill root)')
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

  test('a Read error is the answer, naming the path', async ($, on) => {
    const host = 'File does not exist. Note: your current working directory is /home/claude.\nsecond line'
    const w = world(on, { below: () => ({ result: host, text: host, isError: true }) })
    expect(await view($, { path: '/repo/nope.json' })).toBe('view: /repo/nope.json: File does not exist. Note: your current working directory is /home/claude.')
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
    expect(await view($, { path: '/repo/dir' })).toBe(`view: /repo/dir: ${text}`)
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
  const written = { ...REPLY, out: OUT, lines: 2, pointer: OUT }
  const touches = (w: any) => w.calls.filter((c: any) => c.file_path === OUT)

  test('a Write check on out, then the core writes it: no host Write or Read; the reply names the file', async ($, on) => {
    const w = world(on, { write: 'ask', reply: written })
    const text = await view($, { path: '/repo/issues.json', out: OUT })
    expect(w.checks).toEqual([{ tool: 'Read', input: { file_path: '/repo/issues.json' } }, { tool: 'Write', input: { file_path: OUT } }])
    expect(w.views[0].stdin).toMatchObject({ path: '/repo/issues.json', out: OUT })
    expect(touches(w)).toEqual([])
    expect(w.asked).toEqual([])
    expect(text).toBe(`${REPLY.figure}\nout: ${OUT} (2 lines)\n--- head ---\n${REPLY.text}`)
    expect(w.records[0]).toMatchObject({ decision: 'compressed', spill: OUT, reason: null })
  })

  test('a relative out is checked as the absolute path under the session cwd; the core gets it as given', async ($, on) => {
    const w = world(on, { reply: written })
    await view($, { command: 'cat x.json', out: '.claude/tasks/T1/issues.md' })
    expect(w.checks).toEqual([{ tool: 'Write', input: { file_path: OUT } }])
    expect(w.views[0].stdin).toMatchObject({ out: '.claude/tasks/T1/issues.md', command: 'cat x.json' })
  })

  test('a Write check that denies: the core runs without out, the compact text stays, one line says why', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, { write: 'deny' })
    const text = await view($, { path: '/repo/issues.json', out: OUT })
    expect(w.views[0].stdin.out).toBeUndefined()
    expect(touches(w)).toEqual([])
    expect(text).toBe(`${REPLY.figure}\nout: not written — writing ${OUT} is denied (Write denied by rule)\n--- head ---\n${REPLY.text}`)
    expect(w.records[0]).toMatchObject({ decision: 'compressed', reason: 'out-not-written' })
    expect((await events($))[0].text).toBe('view issues.json: 118 KB → 29 KB (−75%) · json · out not written')
  })

  test('the core could not write out: its reason is the out line, the text and the pointer stay', async ($, on) => {
    const failed = { ...REPLY, outFailed: `writing ${OUT} failed (EACCES)`, pointer: '/spill/slim-rows-1.txt' }
    world(on, { reply: failed })
    expect(await view($, { path: '/repo/issues.json', out: OUT })).toBe(`${REPLY.figure}\nout: not written — writing ${OUT} failed (EACCES)\n--- head ---\n${REPLY.text}`)
  })

  test('a deny with a refusal from the core: the refusal alone', async ($, on) => {
    const msg = 'view: jq found nothing at .nope'
    world(on, { write: 'deny', reply: { v: 1, decision: 'refused', reason: 'jq-miss', engine: null, figure: msg, text: msg, bytesIn: 0, bytesOut: 0, stages: [] } })
    expect(await view($, { path: '/repo/issues.json', out: OUT, jq: '.nope' })).toBe(msg)
  })

  test('an out outside the roots is the core\'s refusal: no Write', async ($, on) => {
    const msg = 'view: out must be under .claude/tasks/<id>/ of the session root or the working directory, or slim\'s spill root (/tmp)'
    const w = world(on, { reply: { v: 1, decision: 'refused', reason: 'out-outside-roots', engine: null, figure: msg, text: msg, bytesIn: 0, bytesOut: 0, stages: [] } })
    expect(await view($, { path: '/repo/issues.json', out: '/etc/x.md' })).toBe(msg)
    expect(w.calls.map(c => c.tool)).toEqual(['Read'])
  })

  test('cached: no write, the figure says so', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, { reply: { v: 1, decision: 'cached', engine: 'json', figure: 'cached', text: REPLY.text, bytesIn: 118_000, bytesOut: 28, stages: [], out: OUT, lines: 2, pointer: OUT } })
    expect(await view($, { path: '/repo/issues.json', out: OUT })).toBe(`cached\nout: ${OUT} (2 lines)\n--- head ---\n${REPLY.text}`)
    expect(touches(w)).toEqual([])
    expect((await events($))[0].text).toBe('view issues.json: cached 28 B · json')
  })

  test('out on an image is the core\'s media-args refusal: the Write check on out never runs', async ($, on) => {
    const msg = 'view: jq and out do not apply to an image or a video — its outputs land beside the input'
    const w = world(on, { reply: { v: 1, decision: 'refused', reason: 'media-args', engine: null, figure: msg, text: msg, bytesIn: 0, bytesOut: 0, stages: [] } })
    expect(await view($, { path: '/repo/a/shot.png', out: OUT })).toBe(msg)
    expect(w.checks.filter((c: any) => c.input.file_path === OUT)).toEqual([])
  })
})

describe('V5 media', () => {
  test('an image: a one-line Read, the Write check on the first output, then the core gets it as allowed_out', async ($, on) => {
    const figure = 'view shot.webp: 5 KB → 900 B (-82%) · 1568 px · jpeg'
    const w = world(on, { reply: { v: 1, decision: 'compressed', engine: 'media', figure, text: 'image webp 4000×3000 → 1568×1176 jpeg q60, metadata stripped (ffmpeg)\nRead /repo/a/shot.1568.jpg once to see it', bytesIn: 5000, bytesOut: 900, stages: [], frames: 1 } })
    const text = await view($, { path: '/repo/a/shot.webp' })
    expect(w.checks).toEqual([{ tool: 'Read', input: { file_path: '/repo/a/shot.webp' } }, { tool: 'Write', input: { file_path: '/repo/a/shot.1568.jpg' } }])
    expect(w.calls.map(c => [c.tool, c.file_path, c.limit])).toEqual([['Read', '/repo/a/shot.webp', 1]])
    expect(w.asked).toEqual([])
    expect(w.views[0].stdin).toMatchObject({ path: '/repo/a/shot.webp', media: true, allowed_out: '/repo/a/shot.1568.jpg' })
    expect(text).toBe(`${figure}\nimage webp 4000×3000 → 1568×1176 jpeg q60, metadata stripped (ffmpeg)\nRead /repo/a/shot.1568.jpg once to see it`)
    expect(w.records[0]).toMatchObject({ engine: 'media', frames: 1 })
  })

  test('a small png under the byte cap: the Write check names the .1568.jpg copy, the core passes the input as itself', async ($, on) => {
    const figure = 'view small.png: 90 KB · 1000 px — fits, no copy'
    const w = world(on, { reply: { v: 1, decision: 'passthrough', engine: 'media', figure, text: 'image png 1000×800, not re-encoded (ffmpeg)\nRead /repo/a/small.png', bytesIn: 92160, bytesOut: 92160, stages: [], frames: 1 } })
    const text = await view($, { path: '/repo/a/small.png' })
    expect(w.checks).toEqual([{ tool: 'Read', input: { file_path: '/repo/a/small.png' } }, { tool: 'Write', input: { file_path: '/repo/a/small.1568.jpg' } }])
    expect(w.views[0].stdin).toMatchObject({ path: '/repo/a/small.png', media: true, allowed_out: '/repo/a/small.1568.jpg' })
    expect(text).toBe(`${figure}\nimage png 1000×800, not re-encoded (ffmpeg)\nRead /repo/a/small.png`)
  })

  test('a linked folder: the core gets the path as given though the host Read resolves it, and its note follows the figure', async ($, on) => {
    const figure = 'view big.png: 570 KB → 128 KB (-77%) · 1200 px · jpeg'
    const body = 'note=out_symlink out=/wt/.claude/tasks/t physical=/main/.claude/tasks/t\nimage png 1200×834 → 1200×834 (no resize) jpeg q60, metadata stripped (ffmpeg)\nRead /wt/.claude/tasks/t/big.1568.jpg once to see it'
    const w = world(on, { below: e => (e.tool === 'Read' ? { result: { type: 'text', file: { filePath: '/main/.claude/tasks/t/big.png' } }, text: 'x' } : undefined), reply: { v: 1, decision: 'compressed', engine: 'media', figure, text: body, bytesIn: 583680, bytesOut: 131072, stages: [], frames: 1 } })
    const text = await view($, { path: '/wt/.claude/tasks/t/big.png' })
    expect(w.views[0].stdin).toMatchObject({ path: '/wt/.claude/tasks/t/big.png', allowed_out: '/wt/.claude/tasks/t/big.1568.jpg' })
    expect(text).toBe(`${figure}\n${body}`)
  })

  test('an image that is already a copy: no Write check and no question, the input is its own allowed_out', async ($, on) => {
    const figure = 'view shot.1568.jpg: 900 B · 1568 px — fits, no copy'
    const w = world(on, { write: 'ask', reply: { v: 1, decision: 'passthrough', engine: 'media', figure, text: 'image jpeg 1568×1176, not re-encoded (ffmpeg)\nRead /repo/a/shot.1568.jpg', bytesIn: 900, bytesOut: 900, stages: [], frames: 1 } })
    const text = await view($, { path: 'a/shot.1568.jpg' })
    expect(w.checks).toEqual([{ tool: 'Read', input: { file_path: 'a/shot.1568.jpg' } }])
    expect(w.asked).toEqual([])
    expect(w.views[0].stdin).toMatchObject({ path: 'a/shot.1568.jpg', media: true, allowed_out: '/repo/a/shot.1568.jpg' })
    expect(text).toBe(`${figure}\nimage jpeg 1568×1176, not re-encoded (ffmpeg)\nRead /repo/a/shot.1568.jpg`)
    expect(w.records[0]).toMatchObject({ decision: 'passthrough', engine: 'media' })
  })

  test('a video: no Read (the Read tool cannot open one); its probe is its first frame; a relative path is made absolute', async ($, on) => {
    const w = world(on)
    await view($, { path: 'clips/demo.MOV' })
    expect(w.checks).toEqual([{ tool: 'Read', input: { file_path: 'clips/demo.MOV' } }, { tool: 'Write', input: { file_path: '/repo/clips/demo.frames/001.jpg' } }])
    expect(w.calls).toEqual([])
    expect(w.views[0].stdin.allowed_out).toBe('/repo/clips/demo.frames/001.jpg')
    expect(w.views[0].stdin.media).toBe(true)
  })

  const readOk = (e: any) => ({ result: { type: 'text', file: { filePath: e.file_path, content: '', numLines: 0, startLine: 1, totalLines: 0 } }, text: '' })
  const imageRead = { result: { type: 'image', file: { base64: '', type: 'image/png', originalSize: 4096 } }, text: '' }
  const refusal = (msg: string) => ({ isError: true, result: msg, text: `<tool_use_error>${msg}</tool_use_error>` })
  /** The Write tool's input-validation refusals of a file this session has not read: before the decider. */
  const UNREAD = [
    'File has not been read yet. Read it first before writing to it.',
    'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
    'File content has changed since it was last read. This commonly happens when a linter or formatter run via Bash rewrites the file. Call Read on this file to refresh, then retry the edit.',
  ]
  /** The Write tool's refusals of a binary file: after the decider allowed. */
  const BINARY = [
    'File is not valid UTF-8: it uses a legacy encoding such as Windows-1252, Shift-JIS or GBK, or it is binary. These tools write UTF-8 (or UTF-16LE behind its byte-order mark) and never convert a file\'s encoding on their own, so nothing was written.',
    'File has NUL bytes in its first 8 KB: binary data, UTF-16/UTF-32 without a byte-order mark, or text with embedded NULs. These tools write UTF-8 (or UTF-16LE behind its byte-order mark) and never convert a file\'s encoding on their own, so nothing was written.',
    'File is UTF-16 big-endian, which these tools do not write, so nothing was written.',
  ]
  /**
   * A host with a file at the probe: the n-th Write answers `writes[n]` (a refusal text, `{ deny }`, or
   * undefined = written); a Read of a frames marker succeeds when `marker`, any other Read answers an image.
   */
  const taken = (writes: (string | { deny: string } | undefined)[], marker = true) => {
    let n = 0
    return (e: any) => {
      if (e.tool === 'Write') {
        const r = writes[n++]
        return r === undefined ? { result: { type: 'update', filePath: e.file_path }, text: 'ok' } : typeof r === 'string' ? refusal(r) : r
      }
      if (String(e.file_path).endsWith('/.slim-frames')) return marker ? readOk(e) : refusal('File does not exist.')
      return imageRead
    }
  }
  const trail = (w: any) => w.calls.map((c: any) => [c.tool, c.file_path, c.limit ?? c.content])

  test('a Write check that asks: no question; the host Write puts the placeholder on the probe, then the core', async ($, on) => {
    const w = world(on, { write: 'ask' })
    await view($, { path: '/repo/shot.png' })
    expect(w.asked).toEqual([])
    expect(trail(w)).toEqual([['Read', '/repo/shot.png', 1], ['Write', '/repo/shot.1568.jpg', PLACEHOLDER]])
    expect(w.views[0].stdin).toMatchObject({ path: '/repo/shot.png', media: true, allowed_out: '/repo/shot.1568.jpg' })
  })

  test('the host denies the placeholder Write: its reason, no spawn', async ($, on) => {
    const w = world(on, { write: 'ask', below: e => (e.tool === 'Write' ? { deny: 'Permission to write /repo/shot.1568.jpg was denied' } : readOk(e)) })
    expect(await view($, { path: '/repo/shot.png' })).toBe(`Permission to write /repo/shot.1568.jpg was denied\n${NO_RESIZE}`)
    expect(w.asked).toEqual([])
    expect(w.views).toEqual([])
    expect(w.records[0]).toMatchObject({ decision: 'refused', reason: 'write-denied' })
  })

  test('the placeholder Write fails: refused write-failed, no spawn', async ($, on) => {
    const w = world(on, { write: 'ask', below: e => (e.tool === 'Write' ? { isError: true, result: 'EACCES: permission denied', text: 'EACCES: permission denied' } : readOk(e)) })
    expect(await view($, { path: '/repo/shot.png' })).toBe(`EACCES: permission denied\n${NO_RESIZE}`)
    expect(w.asked).toEqual([])
    expect(w.views).toEqual([])
    expect(w.records[0]).toMatchObject({ decision: 'refused', reason: 'write-failed' })
  })

  const CACHED = { v: 1, decision: 'cached', engine: 'media', figure: 'view shot.png: 5 KB → 900 B (-82%) · 1568 px · jpeg', text: 'image png 4000×3000 → the copy an earlier view made, newer than the input\nRead /repo/shot.1568.jpg once to see it', bytesIn: 5000, bytesOut: 900, stages: [], frames: 1 }
  const NOT_REUSED = { v: 1, decision: 'refused', reason: 'not-reused', engine: 'media', figure: 'media: no output', text: 'media: no output', bytesIn: 0, bytesOut: 0, stages: [] }
  /** The core's reply: `first` for the reuse-only request, REPLY for a writing one. */
  const reuseThen = (first: Record<string, unknown>) => (stdin: any) => (stdin.reuse === true ? first : REPLY)

  for (const msg of UNREAD) {
    test(`a fresh copy at the probe the session has not read (${msg.slice(0, 32)}…): reused, no question, no second Write`, async ($, on) => {
      const w = world(on, { write: 'ask', below: taken([msg]), reply: reuseThen(CACHED) })
      const text = await view($, { path: '/repo/shot.png' })
      expect(trail(w)).toEqual([['Read', '/repo/shot.png', 1], ['Write', '/repo/shot.1568.jpg', PLACEHOLDER]])
      expect(w.asked).toEqual([])
      expect(w.views).toHaveLength(1)
      expect(w.views[0].stdin).toMatchObject({ path: '/repo/shot.png', media: true, allowed_out: '/repo/shot.1568.jpg', reuse: true })
      expect(text).toBe(`${CACHED.figure}\n${CACHED.text}`)
      expect(w.records[0]).toMatchObject({ decision: 'cached', engine: 'media' })
    })
  }

  for (const msg of BINARY) {
    test(`a binary file at the probe after the decider allowed (${msg.slice(0, 32)}…): the writing core, no reuse, no question`, async ($, on) => {
      const w = world(on, { write: 'ask', below: taken([msg]) })
      await view($, { path: '/repo/shot.png' })
      expect(trail(w)).toEqual([['Read', '/repo/shot.png', 1], ['Write', '/repo/shot.1568.jpg', PLACEHOLDER]])
      expect(w.asked).toEqual([])
      expect(w.views.map(v => v.stdin.reuse)).toEqual([undefined])
      expect(w.views[0].stdin).toMatchObject({ path: '/repo/shot.png', media: true, allowed_out: '/repo/shot.1568.jpg' })
    })
  }

  const STALE = [['Read', '/repo/shot.png', 1], ['Write', '/repo/shot.1568.jpg', PLACEHOLDER], ['Read', '/repo/shot.1568.jpg', 1], ['Write', '/repo/shot.1568.jpg', PLACEHOLDER]]

  test('a stale copy the session has not read: Read through the host, the Write again, then the writing core; no question', async ($, on) => {
    const w = world(on, { write: 'ask', answer: 'Yes', below: taken([UNREAD[1]!, undefined]), reply: reuseThen(NOT_REUSED) })
    await view($, { path: '/repo/shot.png' })
    expect(trail(w)).toEqual(STALE)
    expect(w.asked).toEqual([])
    expect(w.views.map(v => v.stdin.reuse)).toEqual([true, undefined])
    expect(w.views[1].stdin).toMatchObject({ path: '/repo/shot.png', media: true, allowed_out: '/repo/shot.1568.jpg' })
  })

  test('a stale binary copy: Read, the Write again refused as binary after the decider allowed, then the writing core', async ($, on) => {
    const w = world(on, { write: 'ask', answer: 'Yes', below: taken([UNREAD[0]!, BINARY[1]!]), reply: reuseThen(NOT_REUSED) })
    await view($, { path: '/repo/shot.png' })
    expect(trail(w)).toEqual(STALE)
    expect(w.asked).toEqual([])
    expect(w.views.map(v => v.stdin.reuse)).toEqual([true, undefined])
  })

  test('the Write still unread after the Read: refused write-failed, no writing spawn, no question', async ($, on) => {
    const w = world(on, { write: 'ask', answer: 'Yes', below: taken([UNREAD[0]!, UNREAD[1]!]), reply: reuseThen(NOT_REUSED) })
    expect(await view($, { path: '/repo/shot.png' })).toBe(`view: the Write tool still refuses /repo/shot.1568.jpg after reading it\n${NO_RESIZE}`)
    expect(trail(w)).toEqual(STALE)
    expect(w.asked).toEqual([])
    expect(w.views.map(v => v.stdin.reuse)).toEqual([true])
    expect(w.records[0]).toMatchObject({ decision: 'refused', reason: 'write-failed' })
  })

  test('the host denies the second Write: refused write-denied, no writing spawn, no question', async ($, on) => {
    const w = world(on, { write: 'ask', answer: 'Yes', below: taken([UNREAD[0]!, { deny: 'Permission to write /repo/shot.1568.jpg was denied' }]), reply: reuseThen(NOT_REUSED) })
    expect(await view($, { path: '/repo/shot.png' })).toBe(`Permission to write /repo/shot.1568.jpg was denied\n${NO_RESIZE}`)
    expect(w.asked).toEqual([])
    expect(w.views.map(v => v.stdin.reuse)).toEqual([true])
    expect(w.records[0]).toMatchObject({ decision: 'refused', reason: 'write-denied' })
  })

  test('the Read of the copy is denied: refused read-denied, no second Write', async ($, on) => {
    const w = world(on, { write: 'ask', answer: 'Yes', below: e => (e.tool === 'Write' ? refusal(UNREAD[0]!) : e.file_path === '/repo/shot.1568.jpg' ? { deny: 'guard: not that file' } : imageRead), reply: reuseThen(NOT_REUSED) })
    expect(await view($, { path: '/repo/shot.png' })).toBe('guard: not that file')
    expect(trail(w)).toEqual(STALE.slice(0, 3))
    expect(w.asked).toEqual([])
    expect(w.views).toHaveLength(1)
  })

  test('the reuse-only core refuses for another reason: that is the answer, no question', async ($, on) => {
    const noBackend = { ...NOT_REUSED, reason: 'no-backend', figure: 'media: no backend (install ffmpeg)', text: 'media: no backend (install ffmpeg)' }
    const w = world(on, { write: 'ask', answer: 'Yes', below: taken([UNREAD[0]!]), reply: reuseThen(noBackend) })
    expect(await view($, { path: '/repo/shot.png' })).toBe(`media: no backend (install ffmpeg)\n${NO_RESIZE}`)
    expect(w.asked).toEqual([])
    expect(w.views).toHaveLength(1)
  })

  test('a video\'s fresh frames the session has not read: reused, no question', async ($, on) => {
    const w = world(on, { write: 'ask', below: taken([UNREAD[0]!]), reply: reuseThen({ ...CACHED, frames: 4 }) })
    await view($, { path: '/repo/rec.mov' })
    expect(trail(w)).toEqual([['Write', '/repo/rec.frames/001.jpg', PLACEHOLDER]])
    expect(w.asked).toEqual([])
    expect(w.views.map(v => [v.stdin.allowed_out, v.stdin.reuse])).toEqual([['/repo/rec.frames/001.jpg', true]])
  })

  test('a video\'s stale frames in a folder slim marked: the marker and 001.jpg Read, the Write again, the writing core; no question', async ($, on) => {
    const w = world(on, { write: 'ask', answer: 'Yes', below: taken([UNREAD[0]!, undefined]), reply: reuseThen(NOT_REUSED) })
    await view($, { path: '/repo/rec.mov' })
    expect(trail(w)).toEqual([
      ['Write', '/repo/rec.frames/001.jpg', PLACEHOLDER], ['Read', '/repo/rec.frames/.slim-frames', 1],
      ['Read', '/repo/rec.frames/001.jpg', 1], ['Write', '/repo/rec.frames/001.jpg', PLACEHOLDER],
    ])
    expect(w.asked).toEqual([])
    expect(w.views.map(v => v.stdin.reuse)).toEqual([true, undefined])
  })

  test('a video\'s frames folder slim did not mark: refused out-taken, no Read of 001.jpg, no second Write, no question', async ($, on) => {
    const w = world(on, { write: 'ask', answer: 'Yes', below: taken([UNREAD[0]!, undefined], false), reply: reuseThen(NOT_REUSED) })
    expect(await view($, { path: '/repo/rec.mov' })).toBe('view: /repo/rec.frames holds files slim did not write — not overwritten')
    expect(trail(w)).toEqual([['Write', '/repo/rec.frames/001.jpg', PLACEHOLDER], ['Read', '/repo/rec.frames/.slim-frames', 1]])
    expect(w.asked).toEqual([])
    expect(w.views.map(v => v.stdin.reuse)).toEqual([true])
    expect(w.records[0]).toMatchObject({ decision: 'refused', reason: 'out-taken' })
  })

  test('a video whose Read and Write checks both ask: one question for both, no placeholder Write', async ($, on) => {
    const w = world(on, { read: 'ask', write: 'ask', answer: 'Yes' })
    await view($, { path: '/repo/rec.mov' })
    expect(w.asked).toEqual(['Let slim read /repo/rec.mov and write frames into /repo/rec.frames/?'])
    expect(w.calls).toEqual([])
    expect(w.views).toHaveLength(1)
  })

  test('a video whose Read check asks and the Write check allows: the same one question', async ($, on) => {
    const w = world(on, { read: 'ask', answer: 'Yes' })
    await view($, { path: '/repo/rec.mov' })
    expect(w.asked).toEqual(['Let slim read /repo/rec.mov and write frames into /repo/rec.frames/?'])
    expect(w.calls).toEqual([])
    expect(w.views).toHaveLength(1)
  })

  const NOT_CONFIRMED = 'view: not confirmed — reading /repo/rec.mov and writing frames into /repo/rec.frames/ needs a yes'
  test('a video\'s question answered no: refused before any spawn', async ($, on) => {
    const w = world(on, { read: 'ask', write: 'ask', answer: 'No' })
    expect(await view($, { path: '/repo/rec.mov' })).toBe(NOT_CONFIRMED)
    expect(w.views).toEqual([])
    expect(w.records[0]).toMatchObject({ decision: 'refused', reason: 'not-confirmed' })
  })

  test('a video\'s question dismissed: refused before any spawn', async ($, on) => {
    const w = world(on, { read: 'ask', answer: null })
    expect(await view($, { path: '/repo/rec.mov' })).toBe(NOT_CONFIRMED)
    expect(w.views).toEqual([])
  })

  test('a guard that denies an image\'s Read: refused, no Write check, no spawn', async ($, on) => {
    const w = world(on, { below: e => (e.tool === 'Read' ? { deny: 'guard: not that image' } : { result: {} }) })
    expect(await view($, { path: '/repo/shot.png' })).toBe('guard: not that image')
    expect(w.checks.map(c => c.tool)).toEqual(['Read'])
    expect(w.views).toEqual([])
  })

  test('a Write check that denies: its reason, no spawn', async ($, on) => {
    const w = world(on, { write: 'deny' })
    expect(await view($, { path: '/repo/shot.png' })).toBe(`view: writing /repo/shot.1568.jpg is denied (Write denied by rule)\n${NO_RESIZE}`)
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
    expect(await view($, { url: 'https://x.example' })).toBe(noUrlText(true))
    expect(await view($, { url: 'https://x.example', path: '/repo/a.json' })).toBe(noUrlText(true))
    expect(await view($, { path: '/repo/a.json', command: 'ls' })).toBe(BAD_ARGS)
    expect(await view($, {})).toBe(BAD_ARGS)
    expect(await view($, { path: '  ' })).toBe(BAD_ARGS)
    expect(await view($, { path: '/repo/a.json', engine: 'yaml' })).toMatch(/^view: unknown engine 'yaml' — one of json, /)
    expect([w.calls, w.checks, w.views, w.records]).toEqual([[], [], [], []])
  })

  test('SLIM_LOOKUP=0: the url answer names WebFetch only', async ($, on) => {
    world(on, { env: { SLIM_LOOKUP: '0' } })
    expect(await view($, { url: 'https://x.example' })).toBe(noUrlText(false))
    expect(noUrlText(false)).not.toContain('lookup')
  })

  test('a broken core answer is a refusal, never a throw', async ($, on) => {
    world(on, { reply: { nope: 1 } })
    expect(await view($, { path: '/repo/a.json' })).toBe('view failed: core bad-output')
  })
})

describe('V7 the result is not slimmed again', () => {
  test('a 200 KB view answer passes the intake untouched: no core run but --view and --record', async ($, on) => {
    const big = `{"rows":[${'{"a":1},'.repeat(25_000)}{}]}`
    const w = world(on, { reply: { ...REPLY, text: big, bytesOut: bytes(big), pointer: '/tmp/slim-mcp-0123456789abcdef.txt' } })
    const text = await view($, { path: '/repo/a.json' })
    expect(w.other).toEqual([])
    expect(bytes(text)).toBeLessThanOrEqual(INLINE)
    expect(text.endsWith('… 1 lines in all — read /tmp/slim-mcp-0123456789abcdef.txt windowed (offset/limit)')).toBe(true)
  })
})

describe('V8 pure helpers', () => {
  test('mediaName and mediaProbe from the name alone', () => {
    expect([mediaName('/a/b.PNG'), mediaName('/a/b.mp4'), mediaName('/a/b.json'), mediaName('/a/.png')]).toEqual([true, true, false, false])
    expect(mediaProbe('/a/b.JPG')).toBe('/a/b.1568.jpg')
    expect(mediaProbe('/a/b.webp')).toBe('/a/b.1568.jpg')
    expect(mediaProbe('/a/x.y.gif')).toBe('/a/x.y.1568.jpg')
    expect(mediaProbe('/a/clip.webm')).toBe('/a/clip.frames/001.jpg')
    expect(mediaProbe('/shot.png')).toBe('/shot.1568.jpg')
    for (const p of ['/a/b.JPG', '/a/b.webp', '/a/x.y.gif', '/shot.png', '/a/b']) expect(mediaProbe(mediaProbe(p))).toBe(mediaProbe(p))
    expect([mediaProbe('/a/b.1568.JPG'), mediaProbe('/a/b.1568.jpeg'), mediaProbe('/a/b.1568.png'), mediaProbe('/a/b.1568.webp'), mediaProbe('/a/b.800.png')])
      .toEqual(['/a/b.1568.JPG', '/a/b.1568.jpeg', '/a/b.1568.1568.jpg', '/a/b.1568.1568.jpg', '/a/b.800.1568.jpg'])
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

describe('V9 a scratch output and a view that could not resize', () => {
  const SCR = '/repo/.claude/tasks/T1/tmp/attachments/shot.png'
  const SCR_OUT = '/repo/.claude/tasks/T1/tmp/attachments/shot.1568.jpg'
  const NOT_SCRATCH = { v: 1, decision: 'refused', reason: 'not-scratch', engine: 'media', figure: 'view: not scratch', text: 'view: not scratch', bytesIn: 0, bytesOut: 0, stages: [] }
  const trail = (w: any) => w.calls.map((c: any) => [c.tool, c.file_path, c.limit ?? c.content])
  const NO_VERDICT = 'The server-side auto mode classifier gave no verdict for Write'
  /** The guard's state key for the model's next Read of `path` in session S. */
  const passed = async ($: any, path: string) => (await $.command.run({ command: 'peek-image', args: textKey(`S\n${path}`) })).text === 'true'

  test('V-SCR-1 a Write check that asks on a probe under the root\'s tasks: no Write, no question, the core gets scratch', async ($, on) => {
    const w = world(on, { write: 'ask' })
    await view($, { path: SCR })
    expect(trail(w)).toEqual([['Read', SCR, 1]])
    expect(w.asked).toEqual([])
    expect(w.views.map(v => v.stdin)).toEqual([{ v: 1, path: SCR, media: true, allowed_out: SCR_OUT, scratch: true, root: '/repo', cwd: '/repo', session_id: 'S' }])
  })

  test('V-SCR-2 under the working directory\'s tasks (a repo below the root): the same', async ($, on) => {
    const w = world(on, { write: 'ask', cwd: '/repo/sub' })
    await view($, { path: '.claude/tasks/T2/rec.mov' })
    expect(w.calls).toEqual([])
    expect(w.views.map(v => [v.stdin.allowed_out, v.stdin.scratch])).toEqual([['/repo/sub/.claude/tasks/T2/rec.frames/001.jpg', true]])
  })

  test('V-SCR-3 a Write check that denies a scratch probe: write-denied, no spawn', async ($, on) => {
    const w = world(on, { write: 'deny' })
    expect((await view($, { path: SCR })).split('\n')[0]).toBe(`view: writing ${SCR_OUT} is denied (Write denied by rule)`)
    expect(w.views).toEqual([])
    expect(w.records[0]).toMatchObject({ decision: 'refused', reason: 'write-denied' })
  })

  test('V-SCR-4 the core finds the probe lands outside the zone: the placeholder Write, then the writing core', async ($, on) => {
    const w = world(on, { write: 'ask', reply: (stdin: any) => (stdin.scratch === true ? NOT_SCRATCH : REPLY) })
    await view($, { path: SCR })
    expect(trail(w)).toEqual([['Read', SCR, 1], ['Write', SCR_OUT, PLACEHOLDER]])
    expect(w.views.map(v => v.stdin.scratch)).toEqual([true, undefined])
    expect(w.views[1].stdin).toMatchObject({ path: SCR, media: true, allowed_out: SCR_OUT })
  })

  for (const p of ['/repo/.claude/tasks/shot.png', '/repo/a/shot.png']) {
    test(`V-SCR-5 no id segment, or outside tasks (${p}): the placeholder Write as before`, async ($, on) => {
      const w = world(on, { write: 'ask' })
      await view($, { path: p })
      expect(trail(w)).toEqual([['Read', p, 1], ['Write', mediaProbe(p), PLACEHOLDER]])
      expect(w.views[0].stdin.scratch).toBeUndefined()
    })
  }

  test('V-SCR-6 scratchProbe from the path alone', () => {
    expect([
      scratchProbe('/repo/.claude/tasks/T1/a.1568.jpg'),
      scratchProbe('/x/.claude/tasks/T1/a.frames/001.jpg'),
      scratchProbe('/repo/.claude/tasks/T1/../../../a.1568.jpg'),
      scratchProbe('/repo/.claude/tasksX/T1/a.1568.jpg'),
      scratchProbe('/repo/.claude/tasks//a.1568.jpg'),
      scratchProbe('/repo/.claude/tasks/a.1568.jpg'),
      scratchProbe('/repo/.claude/tasks/T1/./a.1568.jpg'),
      scratchProbe('repo/.claude/tasks/T1/a.1568.jpg'),
      scratchProbe('/repo/a/a.1568.jpg'),
      scratchProbe('/wt/.claude/tmp/ELC-1/a.1568.jpg'),
      scratchProbe('/wt/.claude/tmp/a.1568.jpg'),
      scratchProbe('/wt/.claude/tmp//a.1568.jpg'),
      scratchProbe('/wt/.claude/tmpX/a.1568.jpg'),
      scratchProbe('/wt/.claude/tmp'),
    ]).toEqual([true, true, false, false, false, false, false, false, false, true, true, false, false, false])
  })

  test('V-SCR-8 a worktree screenshot under .claude/tmp/<work-id>/ (base\'s scratch path): no Write, the core gets scratch', async ($, on) => {
    const shot = '/wt/.claude/tmp/ELC-1754/nc15-pdp.png'
    const w = world(on, { write: 'ask', root: '/wt', cwd: '/wt' })
    await view($, { path: shot })
    expect(trail(w)).toEqual([['Read', shot, 1]])
    expect(w.asked).toEqual([])
    expect(w.views.map(v => v.stdin)).toEqual([{ v: 1, path: shot, media: true, allowed_out: '/wt/.claude/tmp/ELC-1754/nc15-pdp.1568.jpg', scratch: true, root: '/wt', cwd: '/wt', session_id: 'S' }])
  })

  test('V-SCR-7 a worktree whose .claude/tasks links to the main checkout: the resolved path is scratch', async ($, on) => {
    const main = '/main/.claude/tasks/T1/tmp/attachments/shot.png'
    const w = world(on, { write: 'ask', root: '/wt', cwd: '/wt' })
    await view($, { path: main })
    expect(trail(w)).toEqual([['Read', main, 1]])
    expect(w.views.map(v => v.stdin)).toEqual([{ v: 1, path: main, media: true, allowed_out: '/main/.claude/tasks/T1/tmp/attachments/shot.1568.jpg', scratch: true, root: '/wt', cwd: '/wt', session_id: 'S' }])
  })

  test('V-FAIL-1 the classifier gives the placeholder Write no verdict: the hint, the Read line last, the next Read passes', { plugins: [PEEK_IMAGE] }, async ($, on) => {
    const w = world(on, { write: 'ask', below: (e: any) => (e.tool === 'Write' ? { deny: NO_VERDICT } : { result: { type: 'image' }, text: '' }) })
    const text = await view($, { path: 'a/shot.png' })
    expect(text.split('\n')).toEqual([NO_VERDICT, NO_VERDICT_WRITE, 'view could not resize a/shot.png — Read a/shot.png to see it as is'])
    expect(w.views).toEqual([])
    expect([await passed($, 'a/shot.png'), await passed($, '/repo/a/shot.png')]).toEqual([true, true])
  })

  test('V-FAIL-1b a core refusal (no backend): the Read line, no hint', { plugins: [PEEK_IMAGE] }, async ($, on) => {
    const noBackend = { v: 1, decision: 'refused', reason: 'no-backend', engine: 'media', figure: 'media: no backend', text: 'media: no backend', bytesIn: 0, bytesOut: 0, stages: [] }
    world(on, { reply: noBackend })
    expect(await view($, { path: '/repo/shot.png' })).toBe('media: no backend\nview could not resize /repo/shot.png — Read /repo/shot.png to see it as is')
    expect(await passed($, '/repo/shot.png')).toBe(true)
  })

  test('V-FAIL-2 a denied Read of the image: no Read line, no key set', { plugins: [PEEK_IMAGE] }, async ($, on) => {
    world(on, { below: (e: any) => (e.tool === 'Read' ? { deny: 'guard: not that image' } : { result: {} }) })
    expect(await view($, { path: '/repo/shot.png' })).toBe('guard: not that image')
    expect(await passed($, '/repo/shot.png')).toBe(false)
  })

  for (const reason of ['media-args', 'copy-unfit', 'not-media'])
    test(`V-FAIL-2b a usage refusal (${reason}): no Read line, no key set`, { plugins: [PEEK_IMAGE] }, async ($, on) => {
      const usage = { v: 1, decision: 'refused', reason, engine: null, figure: `view: ${reason}`, text: `view: ${reason}`, bytesIn: 0, bytesOut: 0, stages: [] }
      world(on, { reply: usage })
      expect(await view($, { path: '/repo/shot.png', jq: '.a' })).toBe(`view: ${reason}`)
      expect(await passed($, '/repo/shot.png')).toBe(false)
    })

  test('V-FAIL-3 a video refusal: no Read line (the Read tool cannot open one)', async ($, on) => {
    world(on, { write: 'deny' })
    expect(await view($, { path: '/repo/rec.mov' })).toBe('view: writing /repo/rec.frames/001.jpg is denied (Write denied by rule)')
  })
})
