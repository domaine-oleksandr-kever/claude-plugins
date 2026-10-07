// One dim line under an MCP result slim compressed: engine, sizes, saving. Draws state, never writes it.
import { atom, memberOf, read } from 'claude-code'
import type { On } from 'claude-code'
import type { SlimRow } from '../../types'
import { pctSaved, rowLine } from './events.ts'

const rows = atom({ plugin: 'slim', key: 'rows' } as const, null as SlimRow | null)

export function registerRender(on: On): void {
  on('ui.render', { component: 'ToolResult', props: { tool: /^mcp__/ } }, async ($, e, next) => {
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
}
