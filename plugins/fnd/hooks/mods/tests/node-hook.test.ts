import { describe, expect, test } from 'claude-code/testing'
import { buildHookRun, omit, parseHookOut, slimFigure, slimFigureIn, stubBytes, stubText } from '../fnd/node-hook.ts'

const run = (stdout: string, over: Partial<{ exitCode: number; isStdoutTruncated: boolean }> = {}) => ({
  exitCode: 0,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
  ...over,
})

const SPILL =
  '/Users/me/.claude/projects/-Users-me-repo/0b1c/tool-results/mcp-plugin_fnd_atlassian-searchJiraIssuesUsingJql-1791010865179.txt'
const NOTICE =
  `Error: result (3,196,806 characters across 77,369 lines) exceeds maximum allowed tokens. Output has been saved to ${SPILL}.\n` +
  'Format: Plain text\nUse offset and limit parameters to read specific portions of the file.'

describe('buildHookRun', () => {
  test('argv, stdin, env and timeout', () => {
    const stdinObj = { hook_event_name: 'PreToolUse', tool_name: 'mcp__x__take_screenshot', tool_input: { filePath: '/tmp/a.png' } }
    const env = { FOO: '1', CLAUDE_PLUGIN_ROOT: '/p/fnd' }
    const { argv, init } = buildHookRun('/p/fnd/', 'hooks/scratch-path-guard.cjs', ['--from-mod'], stdinObj, env, 10_000)
    expect(argv).toEqual(['node', '/p/fnd/hooks/scratch-path-guard.cjs', '--from-mod'])
    expect(argv[1]).toStartWith('/p/fnd/')
    expect(JSON.parse(init.stdin ?? '')).toEqual(stdinObj)
    expect(init.env).toEqual(env)
    expect(init.env).not.toBe(env)
    expect(init.timeoutMs).toBe(10_000)
  })

  test('several flags keep their order', () => {
    expect(buildHookRun('/r', 'hooks/mcp-slim.cjs', ['--from-mod', '--overflow=expand'], {}, {}, 1).argv).toEqual([
      'node', '/r/hooks/mcp-slim.cjs', '--from-mod', '--overflow=expand',
    ])
  })
})

describe('parseHookOut', () => {
  test('a JSON object', () => {
    const out = { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'outside' } }
    expect(parseHookOut(run(`${JSON.stringify(out)}\n`))).toEqual(out)
  })

  test('null on a non-zero exit, truncation, empty or garbage stdout', () => {
    expect(parseHookOut(run('{"a":1}', { exitCode: 2 }))).toBeNull()
    expect(parseHookOut(run('{"a":1}', { isStdoutTruncated: true }))).toBeNull()
    expect(parseHookOut(run(''))).toBeNull()
    expect(parseHookOut(run('  \n'))).toBeNull()
    expect(parseHookOut(run('not json'))).toBeNull()
    expect(parseHookOut(run('[1,2]'))).toBeNull()
    expect(parseHookOut(run('null'))).toBeNull()
  })
})

describe('omit', () => {
  test('drops the engine fields only', () => {
    const e = { tool: 'mcp__x__take_screenshot', tool_use_id: 't1', agentId: 'a', filePath: '/tmp/a.png' }
    expect(omit(e, ['tool', 'tool_use_id', 'agentId'])).toEqual({ filePath: '/tmp/a.png' })
  })
})

describe('stubText', () => {
  test('bare string notice; the trailing period is not part of the path', () => {
    expect(stubText(NOTICE)).toEqual({ text: NOTICE, path: SPILL })
  })

  test('first text block of a block array', () => {
    expect(stubText([{ type: 'text', text: NOTICE }])?.path).toBe(SPILL)
    expect(stubText([{ type: 'image', data: 'x' }, { type: 'text', text: NOTICE }])?.path).toBe(SPILL)
  })

  test('not a stub', () => {
    expect(stubText('{"issues":[]}')).toBeNull()
    expect(stubText([{ type: 'text', text: '{"issues":[]}' }])).toBeNull()
    expect(stubText({ issues: [] })).toBeNull()
    expect(stubText(undefined)).toBeNull()
    expect(stubText('Error: result exceeds maximum allowed tokens. No path here.')).toBeNull()
  })

  test('a long payload merely carrying the phrase is no stub', () => {
    const forged = `${'x'.repeat(9000)} ${NOTICE}`
    expect(stubText(forged)).toBeNull()
    expect(stubText([{ type: 'text', text: forged }])).toBeNull()
  })
})

describe('slimFigure', () => {
  const STATS = 'fnd-mcp-slim: compressed 3,197,763 B → 41,000 B (−98.7%)'

  test('stats line with a <<full= handle', () => {
    const body = `{"issues":[]}\n\n${STATS}\n\n<<full=/tmp/fnd-mcp-slim-abc.json original_result>>`
    expect(slimFigure(body)).toBe(STATS)
  })

  test("mcp-slim's own stub", () => {
    const stub = `<<fnd-mcp-slim stub>> mcp__x__y returned 600000 B (format=json) — too large:\nfnd-mcp-slim: stub 600,000 B → 1,100 B (−99.8%)\nfull=/tmp/x.json`
    expect(slimFigure(stub)).toBe('fnd-mcp-slim: stub 600,000 B → 1,100 B (−99.8%)')
  })

  test('null without a handle, or without a whole stats line', () => {
    expect(slimFigure(`payload quoting ${STATS}`)).toBeNull()
    expect(slimFigure(`${STATS}\n`)).toBeNull()
    expect(slimFigure('<<full=/tmp/x original_result>>')).toBeNull()
    expect(slimFigure(`say ${STATS} now\n<<full=/tmp/x original_result>>`)).toBeNull()
  })
})

describe('slimFigureIn', () => {
  const STATS = 'fnd-mcp-slim: compressed 3,197,763 B → 41,000 B (−98.7%)'
  const SLIM = `{"issues":[]}\n\n${STATS}\n\n<<full=/tmp/fnd-mcp-slim-abc.json original_result>>`
  const LIMIT = 32768

  test('a bare string, a text block among others, or an envelope', () => {
    expect(slimFigureIn(SLIM, LIMIT)).toBe(STATS)
    expect(slimFigureIn([{ type: 'text', text: '{"a":1}' }, { type: 'image', data: 'x' }, { type: 'text', text: SLIM }], LIMIT)).toBe(STATS)
    expect(slimFigureIn({ content: [{ type: 'text', text: SLIM }] }, LIMIT)).toBe(STATS)
  })

  test('the fallback text stands in only when the result has none', () => {
    expect(slimFigureIn({ structuredContent: {} }, LIMIT, SLIM)).toBe(STATS)
    expect(slimFigureIn([{ type: 'text', text: '{"a":1}' }], LIMIT, SLIM)).toBeNull()
  })

  test('the marks split across blocks are no emission', () => {
    expect(slimFigureIn([{ type: 'text', text: STATS }, { type: 'text', text: '<<full=/tmp/x original_result>>' }], LIMIT)).toBeNull()
  })

  test('bigger than mcp-slim can emit → null, even quoting both marks', () => {
    const quoted = `${'x'.repeat(34_000)}\n${SLIM}`
    expect(slimFigureIn(quoted, LIMIT)).toBeNull()
    expect(slimFigureIn([{ type: 'text', text: 'y'.repeat(34_000) }, { type: 'text', text: SLIM }], LIMIT)).toBeNull()
    expect(slimFigureIn(quoted, 64_000)).toBe(STATS)
  })
})

describe('stubBytes', () => {
  test('mirrors mcp-slim: default, floor, invalid values', () => {
    expect(stubBytes(null)).toBe(32768)
    expect(stubBytes('')).toBe(32768)
    expect(stubBytes('32k')).toBe(32768)
    expect(stubBytes('0')).toBe(32768)
    expect(stubBytes(' 65536 ')).toBe(65536)
    expect(stubBytes('100')).toBe(1200)
  })
})
