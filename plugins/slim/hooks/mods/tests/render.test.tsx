import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__plugin_fnd_atlassian__searchJiraIssuesUsingJql'
const BIG = 'x'.repeat(120_000)
const SURFACES = ['terminal', 'desktop'] as const
const LINE = /^slim {2}json {2}120 KB → 30 KB {2}−75%$/

const out = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const answer = (bytesOut: number, bytesIn = 120_030) =>
  out(JSON.stringify({
    decision: 'compressed', reason: null, result: 'slimmed', figure: 'slim: compressed',
    record: { src: 'slim', channel: 'mcp', engine: 'json', bytes_in: bytesIn, bytes_out: bytesOut, ms: 3 },
  }))

/** The engine beneath slim: an MCP tool, the core child, and the tool row's own drawing. */
function world(on: On, core = answer(30_000)) {
  mock.clock(on, { now: 1 })
  mock.store(on)
  mock.env(on, { SLIM_TOAST: '0' })
  const ids: string[] = []
  on('session.id', async () => ({ value: 'S' }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('process.run', async () => ({ value: core }))
  on('tool.call', async (_$, e) => {
    ids.push(e.tool_use_id)
    return { result: BIG, text: BIG } as any
  })
  on('ui.render', { component: 'ToolResult' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  return ids
}

const mount = ($: any, surface: string, id: string, props: Record<string, unknown> = {}) =>
  $.ui.mount({ plugin: 'slim', surface, component: 'ToolResult', requestId: id, props: { tool_use_id: id, tool: TOOL, output: 'slimmed', isErrored: false, ...props } })
const shown = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)

describe('ToolResult line', () => {
  for (const surface of SURFACES) {
    test(`${surface}: R1 a compressed id → the engine's row, then one success-dim line`, async ($, on) => {
      const ids = world(on)
      await $.tool.call({ tool: TOOL } as any)
      const ui = await mount($, surface, ids[0]!)
      const texts = await ui.findAll({ type: 'Text' })
      expect(texts.map((t: any) => t.text)[0]).toBe('engine row')
      expect(texts.length).toBe(2)
      expect(texts[1]!.text).toMatch(LINE)
      expect(texts[1]!.props).toMatchObject({ color: 'success', dimColor: true })
    })

    test(`${surface}: R2 under 50% saved → dim, no color`, async ($, on) => {
      const ids = world(on, answer(60_000, 100_000))
      await $.tool.call({ tool: TOOL } as any)
      const ui = await mount($, surface, ids[0]!)
      const line = (await ui.findAll({ type: 'Text' }))[1]
      expect(line?.text).toBe('slim  json  100 KB → 60 KB  −40%')
      expect(line?.props.dimColor).toBe(true)
      expect(line?.props.color).toBeUndefined()
    })

    test(`${surface}: R3 another id → only the engine's row`, async ($, on) => {
      world(on)
      await $.tool.call({ tool: TOOL } as any)
      expect(await shown(await mount($, surface, 'toolu_other'))).toEqual(['engine row'])
    })

    test(`${surface}: R4 an errored result → only the engine's row`, async ($, on) => {
      const ids = world(on)
      await $.tool.call({ tool: TOOL } as any)
      expect(await shown(await mount($, surface, ids[0]!, { isErrored: true }))).toEqual(['engine row'])
    })

    test(`${surface}: R5 a non-MCP tool → only the engine's row`, async ($, on) => {
      const ids = world(on)
      await $.tool.call({ tool: TOOL } as any)
      expect(await shown(await mount($, surface, ids[0]!, { tool: 'Read' }))).toEqual(['engine row'])
    })
  }
})
