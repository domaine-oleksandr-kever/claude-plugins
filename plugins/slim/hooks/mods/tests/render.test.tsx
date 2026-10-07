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
  on('ui.render', { component: 'ToolGroup' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>Ran 3 shell commands</Text>
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

    test(`${surface}: R5 a Bash row with a member draws the line too`, async ($, on) => {
      const ids = world(on)
      await $.tool.call({ tool: TOOL } as any)
      const texts = await shown(await mount($, surface, ids[0]!, { tool: 'Bash' }))
      expect(texts[0]).toBe('engine row')
      expect(texts[1]).toMatch(LINE)
    })
  }
})

const call = (id: string | undefined) => ({ ...(id ? { tool_use_id: id } : {}), tool: 'Bash', input: { command: 'x' }, isRunning: false, isErrored: false, isInterrupted: false })
const group = ($: any, surface: string, calls: unknown[], isExpanded = false) =>
  $.ui.mount({ plugin: 'slim', surface, component: 'ToolGroup', requestId: 'g1', props: { calls, isActive: false, isExpanded } })

describe('ToolGroup line', () => {
  for (const surface of SURFACES) {
    test(`${surface}: G1 two compressed calls of three → the engine's line, then the count and the saving`, async ($, on) => {
      const ids = world(on)
      await $.tool.call({ tool: TOOL } as any)
      await $.tool.call({ tool: TOOL } as any)
      const ui = await group($, surface, [call(ids[0]), call('toolu_plain'), call(ids[1])])
      expect(await shown(ui)).toEqual(['Ran 3 shell commands', ' · 2 compressed, −180 KB'])
      const suffix = (await ui.findAll({ type: 'Text' }))[1]
      expect(suffix?.props.dimColor).toBe(true)
    })

    test(`${surface}: G4 a window bigger than the host preview is not counted as compressed`, async ($, on) => {
      const ids = world(on, answer(4_096, 2_300))
      await $.tool.call({ tool: TOOL } as any)
      expect(await shown(await group($, surface, [call(ids[0])]))).toEqual(['Ran 3 shell commands'])
      expect((await shown(await mount($, surface, ids[0]!)))[1]).toBe('slim  json  2 KB → 4 KB  +78%')
    })

    test(`${surface}: G2 an expanded group → the engine's own`, async ($, on) => {
      const ids = world(on)
      await $.tool.call({ tool: TOOL } as any)
      expect(await shown(await group($, surface, [call(ids[0])], true))).toEqual(['Ran 3 shell commands'])
    })

    test(`${surface}: G3 calls without a tool_use_id or a row → the engine's own`, async ($, on) => {
      world(on)
      await $.tool.call({ tool: TOOL } as any)
      expect(await shown(await group($, surface, [call(undefined), call('toolu_other')]))).toEqual(['Ran 3 shell commands'])
    })
  }
})
