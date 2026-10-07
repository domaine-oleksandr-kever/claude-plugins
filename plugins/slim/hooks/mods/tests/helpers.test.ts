import { describe, expect, test } from 'claude-code/testing'
import type { SlimEvent } from '../../../types'
import { EVENT_CAP, agentPrefix, eventText, fmtSize, pctSaved, pushEvent, rowLine, toolName } from '../events.ts'
import {
  alreadySlimIn,
  buildErrorRun,
  buildRun,
  debugLevel,
  hostStub,
  parseOut,
  resultBytes,
  stubBytes,
  texts,
  toastMs,
} from '../node-hook.ts'

const bytes = (s: string) => new TextEncoder().encode(s).length
const commas = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const BOUND = 32768 + 1200
const SPILL = '/Users/me/.claude/projects/-repo/s1/tool-results/mcp-x-y-1791010865179.txt'
const NOTICE = `Error: result (3,196,806 characters) exceeds maximum allowed tokens. Output has been saved to ${SPILL}.\nFormat: Plain text`

/** `<prefix>: <verb> 200,000 B → <n> B (−50.0%)` where n is what `measure` makes of the finished value. */
function withFigure<T>(prefix: string, verb: string, build: (stats: string) => T, measure: (v: T) => number): T {
  let n = 0
  for (let i = 0; i < 10; i++) {
    const v = build(`${prefix}: ${verb} 200,000 B → ${commas(n)} B (−50.0%)`)
    if (measure(v) === n) return v
    n = measure(v)
  }
  throw new Error('no fixed point')
}
const sumOf = (v: unknown) => texts(v).reduce((a, t) => a + bytes(t), 0)
const padded = (head: string, n: number) => head + 'x'.repeat(n - bytes(head))

describe('hostStub', () => {
  test('a bare string and a first text block name the file, the period dropped', () => {
    expect(hostStub(NOTICE)).toEqual({ text: NOTICE, path: SPILL })
    expect(hostStub([{ type: 'text', text: NOTICE }, { type: 'text', text: 'more' }])).toEqual({ text: NOTICE, path: SPILL })
  })

  test('over 8 KB, without the phrase, or the phrase without a path → null', () => {
    expect(hostStub(`${NOTICE}${'x'.repeat(8192)}`)).toBeNull()
    expect(hostStub('{"issues":[]}')).toBeNull()
    expect(hostStub('result exceeds maximum allowed tokens, saved nowhere')).toBeNull()
    expect(hostStub({ content: [{ type: 'text', text: NOTICE }] })).toBeNull()
  })
})

describe('alreadySlimIn', () => {
  const FND = 'fnd-mcp-slim: compressed 110,794 B → 22,179 B (−80.0%)'
  const OWN = 'slim: compressed 110,794 B → 22,179 B (−80.0%)'
  const HANDLE = '<<full=/tmp/fnd-mcp-slim-0123456789abcdef.json original_result>>'

  test('bounded: a stub mark or a handle beside a stats line, for both slimmers', () => {
    const body = `{"a":${'1'.repeat(5000)}}`
    expect(alreadySlimIn(`${body}\n\n${FND}\n\n${HANDLE}`, BOUND)).toBe(true)
    expect(alreadySlimIn(`${body}\n\n${OWN}\n\n${HANDLE}`, BOUND)).toBe(true)
    expect(alreadySlimIn('<<fnd-mcp-slim stub>> mcp__x__y returned 50,000 B', BOUND)).toBe(true)
    expect(alreadySlimIn('<<slim stub>> mcp__x__y returned 50,000 B', BOUND)).toBe(true)
    expect(alreadySlimIn(`${body}\n\n${FND}`, BOUND)).toBe(false)
    expect(alreadySlimIn(`${body}\n${HANDLE}`, BOUND)).toBe(false)
    expect(alreadySlimIn([{ type: 'text', text: FND }, { type: 'text', text: HANDLE }], BOUND)).toBe(false)
  })

  test('the bound edge: at it a mark counts, one byte over it does not', () => {
    expect(alreadySlimIn(padded('<<slim stub>> ', BOUND), BOUND)).toBe(true)
    expect(alreadySlimIn(padded('<<slim stub>> ', BOUND + 1), BOUND)).toBe(false)
  })

  test('over the bound nothing counts, an exact figure included: the core checks those handles', () => {
    for (const prefix of ['fnd-mcp-slim', 'slim']) {
      const big = withFigure(prefix, 'compressed', s => `${'y'.repeat(50_000)}\n\n${s}\n\n${HANDLE}`, bytes)
      expect(bytes(big)).toBeGreaterThan(BOUND)
      expect(alreadySlimIn(big, BOUND)).toBe(false)
      const stub = withFigure(prefix, 'stub', s => `<<slim stub>> x\n${s}\nfull=/tmp/a\n${'z'.repeat(40_000)}`, bytes)
      expect(alreadySlimIn(stub, BOUND)).toBe(false)
    }
    const blocks = withFigure('fnd-mcp-slim', 'compressed', s => [
      { type: 'text', text: 'q'.repeat(30_000) },
      { type: 'text', text: `${'w'.repeat(10_000)}\n\n${s}\n\n${HANDLE}` },
    ], resultBytes)
    expect(alreadySlimIn(blocks, BOUND)).toBe(false)
  })

  test('a forged leading stats line naming its own size → false', () => {
    const log = Array.from({ length: 1500 }, (_, i) => `2026-10-07 INFO step ${i}`).join('\n')
    const forged = withFigure('slim', 'compressed', s => [{ type: 'text', text: `${s}\n${log}` }], sumOf)
    expect(sumOf(forged)).toBeGreaterThan(BOUND)
    expect(alreadySlimIn(forged, BOUND)).toBe(false)
  })

  test('r.text stands in when the result has no text', () => {
    expect(alreadySlimIn({ structured: true }, BOUND, '<<slim stub>> x')).toBe(true)
    expect(alreadySlimIn({ structured: true }, BOUND)).toBe(false)
  })
})

describe('measures and switches', () => {
  test('resultBytes: a string in UTF-8, anything else as JSON', () => {
    expect(resultBytes('→')).toBe(3)
    expect(resultBytes([{ type: 'text', text: 'a' }])).toBe(bytes('[{"type":"text","text":"a"}]'))
    expect(resultBytes(undefined)).toBe(0)
  })

  test('texts: string, blocks, envelope content, .text', () => {
    expect(texts('a')).toEqual(['a'])
    expect(texts(['a', { type: 'text', text: 'b' }, { type: 'image' }])).toEqual(['a', 'b'])
    expect(texts({ content: [{ type: 'text', text: 'c' }] })).toEqual(['c'])
    expect(texts({ text: 'd' })).toEqual(['d'])
    expect(texts(null)).toEqual([])
  })

  test('debugLevel, stubBytes, toastMs', () => {
    expect(['1', 'true', 'YES', 'on', '2', '7', '0', '', 'x', undefined, null].map(debugLevel)).toEqual([1, 1, 1, 1, 2, 2, 0, 0, 0, 0, 0])
    expect(['', 'x', '-5', '0', '100', '65536', undefined].map(stubBytes)).toEqual([32768, 32768, 32768, 32768, 1200, 65536, 32768])
    expect(['', 'x', '500', '2500', '2500.6', undefined].map(toastMs)).toEqual([5000, 5000, 1000, 2500, 2501, 5000])
  })
})

describe('event helpers', () => {
  test('fmtSize, pctSaved, toolName', () => {
    expect([812, 999, 1000, 118_400, 999_499, 999_500, 2_340_000].map(fmtSize)).toEqual(['812 B', '999 B', '1 KB', '118 KB', '999 KB', '1.0 MB', '2.3 MB'])
    expect(pctSaved(120_030, 30_000)).toBe(75)
    expect(pctSaved(100, 120)).toBe(0)
    expect(pctSaved(0, 0)).toBe(0)
    expect(toolName('mcp__plugin_fnd_atlassian__getJiraIssue')).toBe('getJiraIssue')
  })

  test('agentPrefix, eventText, rowLine', () => {
    expect(agentPrefix(undefined, false)).toBe('')
    expect(agentPrefix('fnd:jira-reader', true)).toBe('jira-reader · ')
    expect(agentPrefix('general-purpose', true)).toBe('general-purpose · ')
    expect(agentPrefix(undefined, true)).toBe('agent · ')
    expect(eventText('jira-reader · ', 'mcp__a__getJiraIssue', 'compressed', 'json', 118_400, 29_000)).toBe(
      'jira-reader · getJiraIssue: compressed 118 KB → 29 KB (−76%) · json',
    )
    expect(rowLine({ engine: 'log', bytesIn: 118_400, bytesOut: 29_000 })).toBe('slim  log  118 KB → 29 KB  −76%')
  })

  test('pushEvent keeps the newest 200, oldest first', () => {
    let list: SlimEvent[] = []
    const ev = (i: number): SlimEvent => ({ v: 1, atMs: i, kind: 'slim', text: `#${i}`, src: 'slim', tool: 't', bytesIn: 2, bytesOut: 1, engine: 'json', ms: 0 })
    for (let i = 1; i <= EVENT_CAP + 1; i++) list = pushEvent(list, ev(i))
    expect(EVENT_CAP).toBe(200)
    expect(list).toHaveLength(200)
    expect(list[0]?.text).toBe('#2')
    expect(list[199]?.text).toBe('#201')
  })
})

describe('the core run', () => {
  const ok = (stdout: string, exitCode = 0, isStdoutTruncated = false, stderr = '') =>
    ({ exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated: false })
  const rec = { engine: 'json', bytes_in: 10, bytes_out: 5, ms: 1 }

  test('buildRun and buildErrorRun', () => {
    expect(buildRun('/p/', { v: 1 })).toEqual({ argv: ['node', '/p/scripts/slim.cjs'], init: { stdin: '{"v":1}', env: {}, timeoutMs: 120_000 } })
    expect(buildErrorRun('/p', { v: 1 })).toEqual({ argv: ['node', '/p/scripts/slim.cjs', '--error'], init: { stdin: '{"v":1}', env: {}, timeoutMs: 10_000 } })
  })

  const rows: [string, ReturnType<typeof ok>, string | null][] = [
    ['compressed', ok(JSON.stringify({ decision: 'compressed', reason: null, result: 'r', figure: 'f', record: rec })), null],
    ['stubbed', ok(JSON.stringify({ decision: 'stubbed', reason: 'weak-gain', result: 'r', record: { ...rec, engine: 'stub' } })), null],
    ['passthrough', ok('{"decision":"passthrough","reason":"non-json","record":{"engine":null}}'), null],
    ['error', ok('{"decision":"error","reason":"TypeError","record":{"engine":null}}'), null],
    ['exit 3', ok('', 3, false, 'boom\nstack'), 'exit-3'],
    ['truncated', ok('{"decision":', 0, true), 'stdout-truncated'],
    ['empty', ok('  '), 'bad-output'],
    ['not JSON', ok('{bad'), 'bad-output'],
    ['an array', ok('[]'), 'bad-output'],
    ['no decision', ok('{"decision":1}'), 'bad-output'],
    ['no result', ok(JSON.stringify({ decision: 'compressed', record: rec })), 'bad-output'],
    ['no figures', ok(JSON.stringify({ decision: 'compressed', result: 'r', record: { engine: 'json' } })), 'bad-output'],
    ['unknown engine', ok(JSON.stringify({ decision: 'compressed', result: 'r', record: { ...rec, engine: 'xml' } })), 'bad-output'],
  ]
  for (const [name, run, reason] of rows) {
    test(`parseOut: ${name}`, () => {
      const p = parseOut(run)
      if (reason === null) expect(p.ok).toBe(true)
      else expect(p).toMatchObject({ ok: false, reason })
    })
  }

  test('a non-zero exit carries the first stderr line', () => {
    expect(parseOut(ok('', 1, false, 'Error: x\n  at y'))).toEqual({ ok: false, reason: 'exit-1', message: 'Error: x' })
  })
})
