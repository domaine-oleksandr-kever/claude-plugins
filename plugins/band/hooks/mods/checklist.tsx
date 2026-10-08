// Progress pane: /band-progress and the band's Progress button toggle it; it draws the task base or fnd resolved
// as the generic checklist (title, subtitle, rows, footer) and never writes their state. Picking the task stays
// the publisher's (`/base-progress <KEY>` or `/fnd-progress <KEY>` pins one); band redraws from the subscription.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { Checklist, ChecklistMark } from '../../types'
import { CHECKLIST_COMMAND, CHECKLIST_PANE } from './events.ts'
import { pickProgress, toChecklist } from './lib.ts'

const paneShown = atom({ plugin: 'band', key: 'paneShown' } as const, false)
const baseProgress = atom({ plugin: 'base', key: 'progress' } as const, null)
const fndProgress = atom({ plugin: 'fnd', key: 'progress' } as const, null)

const GLYPH: Record<ChecklistMark, string> = { done: '✓', current: '▶', waiting: '◌', todo: '☐' }
export const NO_CHECKLIST_TEXT =
  'No task checklist: none of the loaded plugins publishes one (with base: /base-progress <KEY> pins one; with fnd: /fnd-progress <KEY>).'

type $ = EngineInterface

/** base.progress ?? fnd.progress as the checklist, its hints naming the publisher's skill. */
async function checklist($: $): Promise<Checklist | null> {
  const p = pickProgress(await read($, baseProgress), await read($, fndProgress))
  return p === null ? null : toChecklist(p.snapshot, p.publisher)
}

/** The pane's lines as plain text, for the surfaces that draw no pane. */
export function checklistText(c: Checklist): string {
  const head = [c.title, c.subtitle].filter(Boolean).join(' · ')
  return [head, ...c.rows.map(r => `${GLYPH[r.mark]} ${r.text}`), ...(c.footer ?? [])].join('\n')
}

/** Only the terminal and the Desktop app draw a mod's panes; elsewhere the checklist goes out as text. */
async function drawsPanes($: $): Promise<boolean> {
  return (await $.session.surfaces()).some(s => s === 'terminal' || s === 'desktop')
}

async function toggle($: $): Promise<string> {
  if (!(await drawsPanes($))) {
    const c = await checklist($)
    return c === null ? NO_CHECKLIST_TEXT : checklistText(c)
  }
  if ((await $.ui.panes()).some(p => p.id === CHECKLIST_PANE && p.isShown)) {
    // The ui.close hook below clears paneShown: this close comes back through it with origin plugin.
    await $.ui.close({ id: CHECKLIST_PANE })
    return 'Progress pane closed.'
  }
  if ((await checklist($)) === null) return NO_CHECKLIST_TEXT
  const r = await $.ui.open({ id: CHECKLIST_PANE, title: 'Progress', focus: true, closeOnEscape: true })
  if (!r.isPlaced) {
    $.ui.toast(`progress pane not placed: ${r.reason}`)
    return `Progress pane not placed: ${r.reason}`
  }
  await update($, paneShown, () => true)
  return 'Progress pane opened.'
}

export function registerChecklist(on: On): void {
  on('session.start', { cwd: /./ }, async ($, e, next) => {
    const r = await next(e)
    try {
      const shown = (await $.ui.panes()).some(p => p.id === CHECKLIST_PANE && p.isPlaced)
      await update($, paneShown, () => shown)
    } catch {}
    return r
  })

  on('command.run', { command: CHECKLIST_COMMAND.name }, async $ => ({ text: await toggle($) }))

  // Answers without next, so the band Button's own closure never runs and the pane toggles once.
  on('ui.press', { plugin: 'band', element: 'progress' }, async ($, e) => {
    await toggle($)
    return { element: e.element }
  })

  on('ui.close', { id: CHECKLIST_PANE }, async ($, e, next) => {
    const r = await next(e)
    if (e.origin.kind === 'plugin' || e.origin.kind === 'person') await update($, paneShown, () => false)
    return r
  })

  on('ui.render', { component: 'Pane', requestId: CHECKLIST_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const c = await checklist($)
    if (c === null) {
      return (
        <Box flexDirection="column" width={e.props.bodyColumns}>
          <Text dimColor wrap="truncate-end">
            no task checklist
          </Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Text bold wrap="truncate-end">
          {[c.title, c.subtitle].filter(Boolean).join(' · ')}
        </Text>
        {c.rows.map((row, i) => (
          <Box key={`row-${i}`}>
            <Text wrap="truncate-end" dimColor={row.mark === 'done' || row.mark === 'waiting'} bold={row.mark === 'current'}>
              {`${GLYPH[row.mark]} ${row.text}`}
            </Text>
          </Box>
        ))}
        {(c.footer ?? []).map(line => (
          <Text dimColor wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Box>
    )
  })
}
