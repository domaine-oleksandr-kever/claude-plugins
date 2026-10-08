import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { due } from '../prompt.ts'
import { parsePrompt, textKey } from '../node-hook.ts'

const ok = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const PASTE = `Why does this fail?\n\n${JSON.stringify({ issues: Array.from({ length: 400 }, (_, i) => ({ key: `ACME-${i}`, status: 'open' })) })}\n\nThanks.`
const REWRITTEN = 'Why does this fail?\n\n{"issues":[…]}\n\nslim: compressed 12,345 B → 300 B (−97.6%)\n\n<<full=/repo/.claude/slim/prompt/slim-prompt-0123456789abcdef.json original_result>>\n\nThanks.'
const SPILL = '/repo/.claude/slim/prompt/slim-prompt-0123456789abcdef.json'
const ANSWER = { v: 1, decision: 'rewritten', text: REWRITTEN, engine: 'json', form: 'inline', bytesIn: 14_000, bytesOut: 400, stages: [], spans: [{ kind: 'json' }], created: [SPILL] }

/** Settles the submit above slim before slim's hook returns: slim's dispatch is aborted under it. */
const RACE = {
  name: 'race',
  tier: 'prepend' as const,
  register(on: On) {
    const saw: string[] = []
    on('prompt.submit', async (_$: any, e: any, next: any) => {
      saw.push(e.text)
      next(e).catch(() => {})
      return { drop: 'raced' }
    })
    on('command.run', { command: 'race-saw' } as any, async () => ({ text: JSON.stringify(saw) }))
  },
}

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

type Opts = { env?: Record<string, string>; core?: () => unknown; below?: (e: any) => unknown }
function world(on: On, o: Opts = {}) {
  const clock = mock.clock(on, { now: 2_000 })
  mock.store(on)
  const w = { runs: [] as any[], seen: [] as any[], toasts: [] as any[], envReads: [] as string[], clock: null as any }
  on('env.get', async (_$, e) => {
    w.envReads.push(e.name)
    return { value: (o.env ?? {})[e.name] }
  })
  on('session.id', async () => ({ value: 'S' }))
  on('session.cwd', async () => ({ value: '/repo/sub' }))
  on('session.root', async () => ({ value: '/repo' }))
  on('ui.toast', async (_$, e) => {
    w.toasts.push(e)
    return { value: undefined }
  })
  on('process.run', async (_$, e) => {
    w.runs.push({ argv: e.argv, stdin: JSON.parse(e.init?.stdin ?? 'null'), timeoutMs: e.init?.timeoutMs })
    if (e.argv.at(-1) === '--prompt-drop') return { value: ok('') as any }
    return { value: (o.core ? o.core() : ok(JSON.stringify(ANSWER))) as any }
  })
  on('prompt.submit', async (_$, e) => {
    w.seen.push(e)
    return (o.below ? o.below(e) : { text: e.text, context: e.context }) as any
  })
  w.clock = clock
  return w
}
const submit = ($: any, text: string, kind = 'composer', extra: Record<string, unknown> = {}) =>
  $.prompt.submit({ text, origin: { kind }, wait: false, ...extra })

describe('P1 the rewrite', () => {
  test('a big paste: one --prompt run with the text and the project root; the session gets the rewritten text, context as it came', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on)
    const r = await submit($, PASTE, 'composer', { context: ['ctx-a'] })
    expect(w.runs).toHaveLength(1)
    expect(w.runs[0].argv.slice(-1)).toEqual(['--prompt'])
    expect(w.runs[0].stdin).toEqual({ v: 1, text: PASTE, root: '/repo', cwd: '/repo/sub', session_id: 'S' })
    expect(w.runs[0].timeoutMs).toBe(20_000)
    expect(w.seen.map(e => [e.text, e.context])).toEqual([[REWRITTEN, ['ctx-a']]])
    expect(r.text).toBe(REWRITTEN)
    expect(w.toasts).toEqual([{ text: 'prompt: compressed 14 KB → 400 B (−97%) · json', timeoutMs: 5000 }])
    expect((await events($)).map(e => [e.kind, e.channel, e.tool, e.text, e.bytesIn, e.bytesOut, e.engine])).toEqual([
      ['slim', 'prompt', 'prompt', 'prompt: compressed 14 KB → 400 B (−97%) · json', 14_000, 400, 'json'],
    ])
  })

  test('the bridge is hooked too; a head-only rewrite reads stubbed, more spans are counted', { plugins: [PEEK] }, async ($, on) => {
    world(on, { core: () => ok(JSON.stringify({ ...ANSWER, engine: 'stub', form: 'head', spans: [{}, {}] })) })
    await submit($, PASTE, 'bridge')
    expect((await events($))[0].text).toBe('prompt: stubbed 14 KB → 400 B (−97%) · stub · 2 spans')
  })

  test('a drop from beneath: no toast, no Log line, the rewrite\'s spills dropped', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, { below: () => ({ drop: 'blocked by a settings hook' }) })
    const r = await submit($, PASTE)
    expect(r.drop).toBe('blocked by a settings hook')
    expect(w.toasts).toEqual([])
    expect(await events($)).toEqual([])
    expect(w.runs.map(x => [x.argv.at(-1), x.stdin.files, x.stdin.root])).toEqual([['--prompt', undefined, '/repo'], ['--prompt-drop', [SPILL], '/repo']])
  })

  test('a rewrite taken: no drop run', async ($, on) => {
    const w = world(on)
    await submit($, PASTE)
    expect(w.runs.map(x => x.argv.at(-1))).toEqual(['--prompt'])
  })

  test('the dispatch aborted while the core ran: interrupted, nothing beneath, the spills dropped', { plugins: [PEEK, RACE] }, async ($, on) => {
    const w = world(on)
    const r = await submit($, PASTE)
    await w.clock.settle()
    expect(r.drop).toBe('raced')
    expect(JSON.parse((await $.command.run({ command: 'race-saw', args: '' } as any)).text)).toEqual([PASTE])
    expect(w.seen).toEqual([])
    expect(w.toasts).toEqual([])
    expect(await events($)).toEqual([])
    expect(w.runs.map(x => x.argv.at(-1))).toEqual(['--prompt', '--prompt-drop'])
  })

  test('SLIM_TOAST=0 and SLIM_EVENT_LOG=0 keep the rewrite and drop the toast and the line', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, { env: { SLIM_TOAST: '0', SLIM_EVENT_LOG: '0' } })
    expect((await submit($, PASTE)).text).toBe(REWRITTEN)
    expect(w.toasts).toEqual([])
    expect(await events($)).toEqual([])
  })
})

describe('P2 left as typed', () => {
  test('a small prompt: no env read, no spawn', async ($, on) => {
    const w = world(on)
    await submit($, 'short question')
    expect(w.envReads).toEqual([])
    expect(w.runs).toEqual([])
    expect(w.seen[0].text).toBe('short question')
  })

  for (const text of [`/review ${PASTE}`, `! cat ${PASTE}`]) {
    test(`a command line (${text.slice(0, 8)}…): no spawn`, async ($, on) => {
      const w = world(on)
      await submit($, text)
      expect(w.runs).toEqual([])
      expect(w.seen[0].text).toBe(text)
    })
  }

  for (const kind of ['sdk', 'task-notification', 'scheduled-trigger', 'coordinator', 'observer']) {
    test(`origin ${kind}: not hooked`, async ($, on) => {
      const w = world(on)
      await submit($, PASTE, kind)
      expect(w.runs).toEqual([])
      expect(w.seen[0].text).toBe(PASTE)
    })
  }

  test('SLIM_PROMPT=0: no spawn', async ($, on) => {
    const w = world(on, { env: { SLIM_PROMPT: '0' } })
    await submit($, PASTE)
    expect(w.runs).toEqual([])
    expect(w.seen[0].text).toBe(PASTE)
  })

  for (const [name, core] of [
    ['a passthrough', () => ok(JSON.stringify({ v: 1, decision: 'passthrough', reason: 'no-span', bytesIn: 1, bytesOut: 1, spans: [] }))],
    ['exit 1', () => ok('', 1)],
    ['bad JSON', () => ok('{nope')],
    ['a rewrite with no text', () => ok(JSON.stringify({ ...ANSWER, text: '' }))],
    ['a rejected spawn', () => { throw new Error('spawn failed') }],
  ] as const) {
    test(`${name}: the prompt as typed, never a drop`, { plugins: [PEEK] }, async ($, on) => {
      const w = world(on, { core })
      const r = await submit($, PASTE)
      expect(r.drop).toBeUndefined()
      expect(w.seen.map(e => e.text)).toEqual([PASTE])
      expect(w.toasts).toEqual([])
      expect(await events($)).toEqual([])
    })
  }
})

describe('P3 pure helpers', () => {
  test('due: size first, then no slash or bang command', () => {
    expect([due('x'.repeat(3413)), due('x'.repeat(3414)), due(`/cmd ${'x'.repeat(5000)}`), due(`  !ls ${'x'.repeat(5000)}`), due(`a /cmd ${'x'.repeat(5000)}`)])
      .toEqual([false, true, false, false, true])
  })

  test('parsePrompt takes a complete rewrite only', () => {
    expect(parsePrompt(ok(JSON.stringify(ANSWER)) as any)).toEqual({ text: REWRITTEN, engine: 'json', form: 'inline', bytesIn: 14_000, bytesOut: 400, spans: 1, created: [SPILL] })
    expect(parsePrompt(ok(JSON.stringify({ ...ANSWER, created: [SPILL, 7] })) as any)!.created).toEqual([SPILL])
    expect(parsePrompt(ok(JSON.stringify({ ...ANSWER, engine: 'zip' })) as any)!.engine).toBe('json')
    expect(parsePrompt(ok(JSON.stringify({ ...ANSWER, spans: [] })) as any)).toBeNull()
    expect(parsePrompt({ ...ok(JSON.stringify(ANSWER)), isStdoutTruncated: true } as any)).toBeNull()
  })

  test('textKey: 16 hex, stable, content-sensitive', () => {
    expect(textKey('abc')).toMatch(/^[0-9a-f]{16}$/)
    expect(textKey('abc')).toBe(textKey('abc'))
    expect(textKey('abc')).not.toBe(textKey('abd'))
  })
})
