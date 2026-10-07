// One dim line under a tool result slim compressed (engine, sizes, saving), and the count a folded
// tool group's line gets. Draws state, never writes it.
import { atom, memberOf, read } from 'claude-code'
import type { On } from 'claude-code'
import type { SlimRow } from '../../types'
import { groupSuffix, pctSaved, rowLine } from './events.ts'

const rows = atom({ plugin: 'slim', key: 'rows' } as const, null as SlimRow | null)

export function registerRender(on: On): void {
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const drawn = await next(e)
    if (e.props.isErrored) return drawn
    // Keyed by requestId, the tool_use_id; the read subscribes, so a row drawn before the write redraws.
    const row = await read($, memberOf(rows, e))
    if (!row) return drawn
    const { Box, Text } = $.ui.resolve(e)
    const line = rowLine(row)
    return (
      <Box flexDirection="column">
        {drawn}
        {pctSaved(row.bytesIn, row.bytesOut) >= 50 ? (
          <Text color="success" dimColor>
            {line}
          </Text>
        ) : (
          <Text dimColor>{line}</Text>
        )}
      </Box>
    )
  })

  // Reads, searches and listings fold into one line; MCP calls never do, so this is the Bash/Read view.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const drawn = await next(e)
    if (e.props.isExpanded) return drawn
    let n = 0
    let saved = 0
    for (const c of e.props.calls) {
      if (!c.tool_use_id) continue
      // Each read subscribes this group to that member, so a row written after the draw redraws it.
      const row = (await $.state.get({ plugin: 'slim', key: 'rows', id: c.tool_use_id })).value
      // A window bigger than the host's preview saved nothing: its own row says so, the count does not.
      if (!row || row.bytesOut >= row.bytesIn) continue
      n++
      saved += row.bytesIn - row.bytesOut
    }
    if (n === 0) return drawn
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row">
        {drawn}
        <Text dimColor>{groupSuffix(n, saved)}</Text>
      </Box>
    )
  })
}
