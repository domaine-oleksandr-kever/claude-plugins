import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SID = '0b1c2d3e-sess'
const BIG = 'q\n' + '{"a":"' + 'x'.repeat(12000) + '"}'
const RW = {
  text: 'q\n<<fnd-mcp-slim stub>>',
  context: 'fnd prompt-slim: the developer\'s prompt carried 1 pasted JSON blob (12,010 B)',
  summary: 'fnd-prompt-slim: 12,010 B → 300 B (−97.5%)',
}

type Run = { argv: readonly string[]; init?: { stdin?: string; env?: Record<string, string>; timeoutMs?: number } }
type Bottom = { text: string; context?: readonly string[]; turnId?: string; wait?: boolean }
type Answer = (() => ReturnType<typeof out>) | 'reject'

const out = (stdout: string, exitCode = 0, isStdoutTruncated = false) => ({
  exitCode, stdout, stderr: '', isStdoutTruncated, isStderrTruncated: false,
})
const ok = (v: unknown = RW) => () => out(JSON.stringify(v))

/** `rootThrows`: only the first session.root call throws — prompt-slim's; progress reads the root after its next. */
type Opts = { env?: Record<string, string>; drop?: boolean; noProgress?: boolean; rootThrows?: boolean }

/** Every op the module touches on a prompt; `runs` records the guard spawns, `bottom` what reached the engine. */
function world(on: On, answer: Answer = ok(), o: Opts = {}) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, o.env ?? {})
  const runs: Run[] = []
  const toasts: { text: string; timeoutMs?: number }[] = []
  const bottom: Bottom[] = []
  if (!o.noProgress) {
    on('session.id', async () => ({ value: SID }))
    on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  }
  on('session.cwd', async () => ({ value: '/repo' }))
  let roots = 0
  on('session.root', async () => {
    if (o.rootThrows && roots++ === 0) throw new Error('no root')
    return { value: '/repo' }
  })
  on('ui.toast', async (_$, e) => {
    toasts.push(e as any)
    return { value: undefined }
  })
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'git') return { value: out('main\n') }
    if (!String(e.argv[1] ?? '').endsWith('/hooks/prompt-json-guard.cjs')) return { value: out('', 1) }
    runs.push(e as Run)
    if (answer === 'reject') throw new Error('spawn ENOENT')
    return { value: answer() }
  })
  on('prompt.submit', async (_$, e) => {
    bottom.push({ text: e.text, context: e.context, turnId: e.turnId, wait: e.wait })
    if (o.drop) return { drop: 'blocked' } as any
    return { text: e.text, ...(e.context ? { context: e.context } : {}) }
  })
  return { runs, toasts, bottom }
}

/** Reads progress's lastKey through a plugin of the test's own: any plugin reads any value. */
const PEEK = {
  name: 'peek',
  register(on: On) {
    on('tool.call', { tool: 'PeekState' } as any, async ($: any) => ({
      result: JSON.stringify((await $.state.get({ plugin: 'fnd', key: 'lastKey' })).value ?? null),
    }))
  },
}

async function lastKey($: any): Promise<unknown> {
  const r = await $.tool.call({ tool: 'PeekState' })
  return JSON.parse(r.result)
}

const submit = ($: any, text: string, kind = 'composer', extra: Record<string, unknown> = {}) =>
  $.prompt.submit({ text, wait: false, origin: { kind }, ...extra } as any)

describe('rewrite', () => {
  test('a big JSON paste → the guard --from-mod, the rewrite below, context, one toast', async ($, on) => {
    const { runs, toasts, bottom } = world(on)
    await submit($, BIG)
    expect(bottom).toEqual([{ text: RW.text, context: [RW.context], turnId: undefined, wait: false }])
    expect(toasts).toEqual([{ text: RW.summary, timeoutMs: 10_000 }])
    expect(runs.length).toBe(1)
    const [run] = runs
    expect(run.argv[0]).toBe('node')
    expect(run.init?.env?.CLAUDE_PLUGIN_ROOT).toMatch(/\/plugins\/fnd$/)
    expect(run.argv[1]).toBe(`${run.init?.env?.CLAUDE_PLUGIN_ROOT}/hooks/prompt-json-guard.cjs`)
    expect(run.argv.slice(2)).toEqual(['--from-mod'])
    expect(run.init?.timeoutMs).toBe(20_000)
    expect(run.init?.env?.FND_HOST).toBe('claude')
    expect(JSON.parse(run.init?.stdin ?? '')).toEqual({ prompt: BIG, cwd: '/repo' })
  })

  test('an incoming context is kept, the line appended', async ($, on) => {
    const { bottom } = world(on)
    await submit($, BIG, 'composer', { context: ['prior'] })
    expect(bottom.map(b => b.context)).toEqual([['prior', RW.context]])
  })

  test('bridge and sdk origins are rewritten', async ($, on) => {
    const { bottom, runs } = world(on)
    await submit($, BIG, 'bridge')
    await submit($, BIG, 'sdk')
    expect(runs.length).toBe(2)
    expect(bottom.map(b => b.text)).toEqual([RW.text, RW.text])
  })

  test('a drop beneath is returned, no toast', async ($, on) => {
    const { toasts, bottom } = world(on, ok(), { drop: true })
    const r = await submit($, BIG)
    expect(r.drop).toBe('blocked')
    expect(bottom.length).toBe(1)
    expect(toasts).toEqual([])
  })

  test('mid-turn: turnId and wait pass through', async ($, on) => {
    const { bottom } = world(on)
    await submit($, BIG, 'composer', { turnId: 't1', wait: true })
    expect(bottom).toEqual([{ text: RW.text, context: [RW.context], turnId: 't1', wait: true }])
  })

  test('a rewrite longer in UTF-16 units than the paste still applies', async ($, on) => {
    const long = { ...RW, text: '漢'.repeat(BIG.length + 100) }
    const { bottom } = world(on, ok(long))
    await submit($, BIG)
    expect(bottom.map(b => b.text)).toEqual([long.text])
  })
})

describe('fallback to the typed text', () => {
  const typed = (bottom: Bottom[]) => expect(bottom).toEqual([{ text: BIG, context: undefined, turnId: undefined, wait: false }])

  test('a rejected run', async ($, on) => {
    const { runs, toasts, bottom } = world(on, 'reject')
    await submit($, BIG)
    expect(runs.length).toBe(1)
    typed(bottom)
    expect(toasts).toEqual([])
  })

  const unusable: [string, () => ReturnType<typeof out>][] = [
    ['exit 1 with a valid answer', () => out(JSON.stringify(RW), 1)],
    ['a truncated stdout', () => out(JSON.stringify(RW), 0, true)],
    ['an empty stdout', () => out('')],
    ['not JSON', () => out('nope')],
    ['an array', () => out('[]')],
  ]
  for (const [name, answer] of unusable) {
    test(`unusable answer: ${name}`, async ($, on) => {
      const { runs, toasts, bottom } = world(on, answer)
      await submit($, BIG)
      expect(runs.length).toBe(1)
      typed(bottom)
      expect(toasts).toEqual([])
    })
  }

  const incomplete: [string, unknown][] = [
    ['text only', { text: RW.text }],
    ['a non-string summary', { ...RW, summary: 7 }],
    ['an empty context', { ...RW, context: '' }],
    ['a context past 100,000 characters', { ...RW, context: 'c'.repeat(100_001) }],
  ]
  for (const [name, answer] of incomplete) {
    test(`incomplete answer: ${name}`, async ($, on) => {
      const { runs, toasts, bottom } = world(on, ok(answer))
      await submit($, BIG)
      expect(runs.length).toBe(1)
      typed(bottom)
      expect(toasts).toEqual([])
    })
  }

  test('FND_SLIM_TOAST=0 → the rewrite still applies, no toast', async ($, on) => {
    const { runs, toasts, bottom } = world(on, ok(), { env: { FND_SLIM_TOAST: '0' } })
    await submit($, BIG)
    expect(runs.length).toBe(1)
    expect(bottom.length).toBe(1)
    expect(bottom[0].text).not.toBe(BIG)
    expect(toasts).toEqual([])
  })

  test('FND_PROMPT_JSON=0 → no spawn', async ($, on) => {
    const { runs, bottom } = world(on, ok(), { env: { FND_PROMPT_JSON: '0' } })
    await submit($, BIG)
    expect(runs.length).toBe(0)
    typed(bottom)
  })

  test('a throwing session.root → the typed text once, progress still sees it', { plugins: [PEEK] }, async ($, on) => {
    const { runs, toasts, bottom } = world(on, ok(), { rootThrows: true })
    const text = `ELC-77 ${BIG}`
    await submit($, text)
    expect(runs.length).toBe(0)
    expect(toasts).toEqual([])
    expect(bottom.map(b => b.text)).toEqual([text])
    expect(await lastKey($)).toBe('ELC-77')
  })
})

describe('the gate', () => {
  test('short or opener-less prompts never spawn', async ($, on) => {
    const { runs, bottom } = world(on)
    const short = '{}' + 'a'.repeat(2998)
    const prose = 'a'.repeat(20_000)
    await submit($, short)
    await submit($, prose)
    expect(runs.length).toBe(0)
    expect(bottom.map(b => b.text)).toEqual([short, prose])
  })

  test('the ×3 gate boundary: 3,413 units never spawn, 3,414 do', async ($, on) => {
    const { runs } = world(on, () => out(''))
    await submit($, '{' + 'a'.repeat(3412))
    expect(runs.length).toBe(0)
    await submit($, '{' + 'a'.repeat(3413))
    expect(runs.length).toBe(1)
  })

  test('the ×3 gate: 3,507 units of Cyrillic (7,007 B) still spawns', async ($, on) => {
    const { runs } = world(on, () => out(''))
    await submit($, 'я'.repeat(3500) + '{"a":1}')
    expect(runs.length).toBe(1)
  })

  test('slash and ! commands are skipped; a path-led prompt is not', async ($, on) => {
    const { runs, bottom } = world(on)
    const slash = `/fnd:x ${BIG}`
    const bang = `! echo ${BIG}`
    await submit($, slash)
    await submit($, bang)
    expect(runs.length).toBe(0)
    expect(bottom.map(b => b.text)).toEqual([slash, bang])
    await submit($, `/Users/me/x.json fails: ${BIG}`)
    expect(runs.length).toBe(1)
    expect(bottom[2]?.text).toBe(RW.text)
  })

  test('peer, notification and plugin origins are not matched', async ($, on) => {
    const { runs, bottom } = world(on)
    for (const kind of ['peer', 'task-notification', 'plugin']) await submit($, BIG, kind)
    expect(runs.length).toBe(0)
    expect(bottom.map(b => b.text)).toEqual([BIG, BIG, BIG])
  })
})

describe('co-resident hooks', () => {
  test('progress failing after its next: one bottom call, one run', async ($, on) => {
    const { runs, bottom } = world(on, ok(), { noProgress: true })
    await submit($, BIG)
    expect(runs.length).toBe(1)
    expect(bottom.map(b => b.text)).toEqual([RW.text])
  })
})

// An aborted next.signal after the spawn (→ no second dispatch beneath, no toast) is checked live only: the kit has no
// interrupt, and an inline test plugin sits beneath the plugin under test, so nothing here can abort fnd's dispatch.
