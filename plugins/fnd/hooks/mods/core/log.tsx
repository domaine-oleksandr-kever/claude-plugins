// Event log pane: /fnd-log and the band's Log button toggle it; it draws the events atom, never writes it.
import { atom, read } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { FndEvent } from '../../../types'
import { LOG_PANE, PREFIX_COLS, hhmm, kindCell, newestFitting } from './events.ts'

const events = atom({ plugin: 'fnd', key: 'events' } as const, [] as FndEvent[])

type $ = EngineInterface

async function togglePane($: $): Promise<string> {
  if ((await $.ui.panes()).some(p => p.id === LOG_PANE && p.isShown)) {
    await $.ui.close({ id: LOG_PANE })
    return 'Log pane closed.'
  }
  const r = await $.ui.open({ id: LOG_PANE, title: 'Log', focus: true, closeOnEscape: true })
  if (!r.isPlaced) {
    $.ui.toast(`log pane not placed: ${r.reason}`)
    return `Log pane not placed: ${r.reason}`
  }
  return 'Log pane opened.'
}

export function registerLog(on: On): void {
  on('command.run', { command: 'fnd-log' }, async $ => ({ text: await togglePane($) }))

  // Answers without next, so the band Button's own closure never runs and the pane toggles once.
  on('ui.press', { plugin: 'fnd', element: 'log' }, async ($, e) => {
    await togglePane($)
    return { element: e.element }
  })

  on('ui.render', { component: 'Pane', requestId: 'fnd-log' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, events)
    if (list.length === 0) {
      return (
        <Box flexDirection="column" width={e.props.bodyColumns}>
          <Text dimColor wrap="truncate-end">
            no events yet
          </Text>
        </Box>
      )
    }
    // The engine's window starts at the top and never follows the end: keep the newest rows in view,
    // counting the rows a wrapped text takes.
    const rows = e.props.scroll?.bodyRows ?? 0
    const textCols = Math.max(1, e.props.bodyColumns - PREFIX_COLS)
    const shown = newestFitting(list, rows, textCols)
    const cut = shown.length < list.length
    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        {cut ? <Text dimColor wrap="truncate-end">{`… ${list.length - shown.length} earlier`}</Text> : null}
        {shown.map((ev, i) => (
          <Box key={`ev-${i}`} flexDirection="row">
            <Box width={PREFIX_COLS} flexShrink={0}>
              <Text dimColor>{`${hhmm(ev.atMs)}  `}</Text>
              <Text dimColor>{`${kindCell(ev.kind)}  `}</Text>
            </Box>
            <Box width={textCols}>
              <Text wrap="wrap">{ev.text}</Text>
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
