import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { SPILL_INLINE, denyText } from '../guard.ts'
import { attachmentEligible, attachmentPath, bashVia, guardOf, spillAccess, spillKind } from '../channels.ts'

const ORIG = '/tmp/fnd-mcp-slim-0123456789abcdef.json'
const ROWS = '/tmp/fnd-crush-0123456789abcdef.json'
const IDS = '/tmp/fnd-jsx-ids-0123456789abcdef.json'
const PROMPT = '/repo/.claude/slim/prompt/slim-prompt-0123456789abcdef.json'
const HOST = '/u/.claude/projects/p/S/tool-results/b1.txt'
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const READ = (file_path: string) => ({ result: { type: 'text', file: { filePath: file_path, content: 'x', numLines: 1, startLine: 1, totalLines: 1 } }, text: 'x' })

/** Another plugin reading a spill through its own $.tool.call. */
const OTHER = {
  name: 'other',
  register(on: On) {
    on('command.run', { command: 'other-read' } as any, async ($: any, e: any) => {
      const r = await $.tool.call({ tool: 'Read', file_path: e.args })
      return { text: r.deny ?? 'read' }
    })
  },
}

type Opts = { env?: Record<string, string>; sizes?: Record<string, number>; below?: (e: any) => unknown }
function world(on: On, o: Opts = {}) {
  mock.clock(on, { now: 1_000 })
  mock.store(on)
  mock.env(on, o.env ?? { SLIM_DEBUG: '1' })
  const w = { access: [] as any[], other: [] as any[], stats: [] as string[], calls: [] as any[] }
  on('session.id', async () => ({ value: 'S' }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('agent.list', async () => ({ value: [] as any }))
  on('fs.stat', async (_$, e) => {
    w.stats.push(e.path)
    const size = (o.sizes ?? {})[e.path]
    if (size === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file', size, mtimeMs: 0, isLink: false } }
  })
  on('process.run', async (_$, e) => {
    const stdin = JSON.parse(e.init?.stdin ?? 'null')
    ;(e.argv[2] === '--access' ? w.access : w.other).push(stdin)
    return { value: ok('{"decision":"passthrough","reason":"read-guard","record":{"engine":null,"bytes_in":1,"bytes_out":1,"ms":1}}') }
  })
  on('tool.call', async (_$, e) => {
    w.calls.push(e)
    if (o.below) return o.below(e) as any
    if (e.tool === 'Read') return READ((e as any).file_path) as any
    if (e.tool === 'Grep') return { result: { mode: 'content', numFiles: 1, filenames: [], content: 'hit', numLines: 1 }, text: 'hit' } as any
    return { result: { stdout: 'out', stderr: '', interrupted: false }, text: 'out' } as any
  })
  return w
}

describe('G1 an unwindowed Read of a big spill', () => {
  for (const [name, path] of [['an original', ORIG], ['a rows part', ROWS], ['a prompt spill', PROMPT]] as const) {
    test(`${name} over the inline budget: denied with the pointer, the tool never runs, one denied access line`, async ($, on) => {
      const w = world(on, { sizes: { [path]: 120_000 } })
      const r = await $.tool.call({ tool: 'Read', file_path: path } as any)
      expect(r.deny).toBe(denyText(path, 120_000, true))
      expect(w.calls).toEqual([])
      expect(w.access).toEqual([{ v: 1, tool: 'Read', via: 'Read', spills: [path], denied: true, cwd: '/repo' }])
    })
  }

  test('the pointer names a windowed Read, view and lookup on one line', () => {
    const t = denyText(ORIG, 120_000, true)
    expect(t.includes('\n')).toBe(false)
    expect(t).toContain('offset/limit')
    expect(t).toContain('mcp__slim__view({ path, jq })')
    expect(t).toContain('mcp__slim__lookup({ path, question })')
  })

  test('SLIM_LOOKUP=0: the pointer names no lookup tool', async ($, on) => {
    world(on, { env: { SLIM_LOOKUP: '0' }, sizes: { [ORIG]: 120_000 } })
    const r = await $.tool.call({ tool: 'Read', file_path: ORIG } as any)
    expect(r.deny).toBe(denyText(ORIG, 120_000, false))
    expect(r.deny).not.toContain('lookup')
  })
})

describe('G2 what passes', () => {
  test('a windowed Read of a big spill: passes, one access line', async ($, on) => {
    const w = world(on, { sizes: { [ORIG]: 120_000 } })
    const r = await $.tool.call({ tool: 'Read', file_path: ORIG, offset: 1, limit: 200 } as any)
    expect(r.deny).toBeUndefined()
    expect(w.stats).toEqual([])
    expect(w.access).toEqual([{ v: 1, tool: 'Read', via: 'Read', spills: [ORIG], cwd: '/repo' }])
  })

  test(`a spill at the budget (${SPILL_INLINE} B) and an id map of any size: pass`, async ($, on) => {
    const w = world(on, { sizes: { [ORIG]: SPILL_INLINE, [IDS]: 900_000 } })
    expect((await $.tool.call({ tool: 'Read', file_path: ORIG } as any)).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'Read', file_path: IDS } as any)).deny).toBeUndefined()
    expect(w.stats).toEqual([ORIG])
    expect(w.access.map(a => a.spills[0])).toEqual([ORIG, IDS])
  })

  test('a host tool-results file is recorded, never denied', async ($, on) => {
    const w = world(on, { sizes: { [HOST]: 900_000 } })
    expect((await $.tool.call({ tool: 'Read', file_path: HOST } as any)).deny).toBeUndefined()
    expect(w.stats).toEqual([])
    expect(w.access[0].spills).toEqual([HOST])
  })

  test('a Read of any other file: no stat, no access spawn', async ($, on) => {
    const w = world(on, { sizes: { '/repo/a.json': 900_000 } })
    await $.tool.call({ tool: 'Read', file_path: '/repo/a.json' } as any)
    await $.tool.call({ tool: 'Read', file_path: '/tmp/fnd-mcp-slim-notahash.json' } as any)
    expect(w.stats).toEqual([])
    expect(w.access).toEqual([])
  })

  test('Grep and Bash on a spill: pass, one access line each with its reader', async ($, on) => {
    const w = world(on, { sizes: { [ORIG]: 120_000 } })
    await $.tool.call({ tool: 'Grep', pattern: 'ACME-7', path: ORIG } as any)
    await $.tool.call({ tool: 'Bash', command: `jq '.issues[0]' ${ORIG}` } as any)
    await $.tool.call({ tool: 'Bash', command: `rm -f ${ORIG} ${PROMPT}` } as any)
    expect(w.stats).toEqual([])
    expect(w.access.map(a => [a.tool, a.via, a.spills])).toEqual([
      ['Grep', 'Grep', [ORIG]], ['Bash', 'jq', [ORIG]], ['Bash', 'named', [ORIG, PROMPT]],
    ])
  })

  test('SLIM_SPILL_GUARD=0: the big Read passes and is still recorded', async ($, on) => {
    const w = world(on, { env: { SLIM_SPILL_GUARD: '0', SLIM_DEBUG: '1' }, sizes: { [ORIG]: 120_000 } })
    expect((await $.tool.call({ tool: 'Read', file_path: ORIG } as any)).deny).toBeUndefined()
    expect(w.stats).toEqual([])
    expect(w.access).toHaveLength(1)
  })

  test('SLIM_DEBUG unset: the guard still denies, nothing is recorded', async ($, on) => {
    const w = world(on, { env: {}, sizes: { [ORIG]: 120_000 } })
    expect((await $.tool.call({ tool: 'Read', file_path: ORIG } as any)).deny).toBe(denyText(ORIG, 120_000, true))
    await $.tool.call({ tool: 'Read', file_path: ORIG, limit: 50 } as any)
    expect(w.access).toEqual([])
  })

  test('a Read that errors beneath is not an access', async ($, on) => {
    const w = world(on, { below: () => ({ result: 'File does not exist.', isError: true, text: 'File does not exist.' }) })
    await $.tool.call({ tool: 'Read', file_path: ORIG, limit: 5 } as any)
    expect(w.access).toEqual([])
  })

  test('another plugin\'s Read of a big spill: passes, no stat, no record', { plugins: [OTHER] }, async ($, on) => {
    const w = world(on, { sizes: { [ORIG]: 120_000 } })
    expect((await $.command.run({ command: 'other-read', args: ORIG } as any)).text).toBe('read')
    expect(w.calls.map(c => c.file_path)).toEqual([ORIG])
    expect(w.stats).toEqual([])
    expect(w.access).toEqual([])
  })

  test('view\'s own one-line Read probe of a spill passes the guard', async ($, on) => {
    const w = world(on, { sizes: { [ORIG]: 120_000 } })
    on('tool.check', async () => ({ decision: 'allow' }))
    on('session.root', async () => ({ value: '/repo' }))
    await $.tool.call({ tool: 'mcp__slim__view', path: ORIG } as any)
    expect(w.calls.filter(c => c.tool === 'Read').map(c => [c.file_path, c.limit])).toEqual([[ORIG, 1]])
    expect(w.stats).toEqual([])
    expect(w.access).toEqual([])
  })
})

describe('G3 pure helpers', () => {
  test('spillKind', () => {
    expect([ORIG, ROWS, IDS, PROMPT, HOST, '/repo/.claude/slim/prompt/slim-prompt-rows-0123456789abcdef.json', '/repo/a.json', '/tmp/fnd-mcp-slim-debug.log'].map(spillKind))
      .toEqual(['original', 'rows', 'ids', 'original', 'host', 'rows', null, null])
  })

  test('bashVia by command words, readers before names', () => {
    expect([`grep x ${ORIG} | jq .`, `rg x ${ORIG}`, `head -c 400 ${ORIG}`, `node -e 1 ${ORIG}`, `ls -la ${ORIG}`, `python3 x.py ${ORIG}`, `/usr/bin/jq . ${ORIG}`].map(bashVia))
      .toEqual(['jq', 'grep', 'shell', 'node', 'named', 'other', 'jq'])
  })

  test('spillAccess: absolute spill paths only, deduplicated, at most 8', () => {
    expect(spillAccess('Read', { file_path: '/repo/a.json' })).toBeNull()
    expect(spillAccess('Edit', { file_path: ORIG })).toBeNull()
    expect(spillAccess('Bash', { command: `cat fnd-mcp-slim-0123456789abcdef.json ${ORIG} ${ORIG}` })).toEqual({ tool: 'Bash', via: 'shell', paths: [ORIG] })
    const many = Array.from({ length: 12 }, (_, i) => `/tmp/fnd-crush-${String(i).padStart(16, '0')}.json`).join(' ')
    expect(spillAccess('Bash', { command: `wc -c ${many}` })!.paths).toHaveLength(8)
  })

  test('a Read of a prompt spill is a spill-read for the intake too (never recompressed)', () => {
    expect(guardOf('read', { bytes: 90_000, texts: ['x'], path: PROMPT, truncated: true })).toBe('spill-read')
    expect(guardOf('read', { bytes: 90_000, texts: ['x'], path: '/repo/data/slim-prompt-0123456789abcdef.json', truncated: true })).toBeNull()
  })

  test('attachmentPath and attachmentEligible read the framing alone', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(6)}→{"id":${i}}`).join('\n')
    const framed = (file: string) => `Called the Read tool with the following input: {"file_path":"${file}"}\nResult of calling the Read tool: ${lines(5)}`
    expect([attachmentPath(framed('/r/a.jsonl')), attachmentPath(lines(5)), attachmentPath('Called the Read tool with the following input: {broken')]).toEqual(['/r/a.jsonl', null, null])
    expect([
      attachmentEligible(framed('/r/a.jsonl'), '/r/a.jsonl'), attachmentEligible(framed('/r/app.log'), '/r/app.log'),
      attachmentEligible(framed('/r/src/a.ts'), '/r/src/a.ts'), attachmentEligible(framed('/r/package.json'), '/r/package.json'),
      attachmentEligible(framed('/r/locales/en.default.json'), '/r/locales/en.default.json'), attachmentEligible(lines(5), null), attachmentEligible('{"id":1}\n{"id":2}', null),
    ]).toEqual([true, true, false, false, false, true, false])
  })
})
