// Status band: the AbovePrompt row drawn from the atoms, the Compact and Clear presses and the terminal's model
// picker, which unfolds into the row itself: the band region clips anything drawn outside its own rows, so no
// list can pop over the transcript. A desktop draws the buttons on a second row under the figures.
// Render only reads: band's atoms (usage.ts and checklist.tsx write them), base's or fnd's task snapshot for the
// digest and the Progress button, every publisher's event list for the Log button. The Progress and Log presses are
// answered by the `ui.press` hooks on elements `progress` (checklist.tsx) and `log` (log.tsx). While base reports
// the task workspace stale, a Compact press or a typed /compact runs base's save-task-context first.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, RenderNode } from 'claude-code'
import type { BandEvent, BandRate, ForeignEvent } from '../../types'
import {
  CACHE_INIT,
  CTX_PROPS,
  GLYPH,
  LEVEL_PROPS,
  MODEL_MARK,
  RULE,
  SEP,
  USAGE_INIT,
  bandSegs,
  cacheCard,
  cells,
  cacheView,
  compactToast,
  costCard,
  ctxCard,
  digestOf,
  glyphText,
  layout,
  modelOptions,
  pctLevel,
  pickProgress,
  rateCard,
  rateText,
  splitLabel,
  toChecklist,
} from './lib.ts'
import { merged, take } from './events.ts'

const usage = atom({ plugin: 'band', key: 'usage' } as const, USAGE_INIT)
const model = atom({ plugin: 'band', key: 'model' } as const, null)
const cache = atom({ plugin: 'band', key: 'cache' } as const, CACHE_INIT)
const tick = atom({ plugin: 'band', key: 'tick' } as const, 0)
const paneShown = atom({ plugin: 'band', key: 'paneShown' } as const, false)
const bandFocused = atom({ plugin: 'band', key: 'bandFocused' } as const, false)
const modelPicker = atom({ plugin: 'band', key: 'modelPicker' } as const, false)
const events = atom({ plugin: 'band', key: 'events' } as const, [] as BandEvent[])
const baseProgress = atom({ plugin: 'base', key: 'progress' } as const, null)
const fndProgress = atom({ plugin: 'fnd', key: 'progress' } as const, null)
const baseEvents = atom({ plugin: 'base', key: 'events' } as const, [] as ForeignEvent[])
const fndEvents = atom({ plugin: 'fnd', key: 'events' } as const, [] as ForeignEvent[])
const slimEvents = atom({ plugin: 'slim', key: 'events' } as const, [] as ForeignEvent[])
const feEvents = atom({ plugin: 'fe', key: 'events' } as const, [] as ForeignEvent[])
const qaEvents = atom({ plugin: 'qa', key: 'events' } as const, [] as ForeignEvent[])
const beEvents = atom({ plugin: 'be', key: 'events' } as const, [] as ForeignEvent[])
const pmEvents = atom({ plugin: 'pm', key: 'events' } as const, [] as ForeignEvent[])

type $ = EngineInterface

/** Main-loop turn in flight: turn events flip it, each band draw syncs it; usage.ts clears it, as the engine allows one unmatched turn.complete hook. */
export const turn = { running: false }

const SAVE = 'base:save-task-context'

/** base's task workspace is stale and BASE_AUTOSAVE is not 0: a compaction now would drop the unsaved findings. */
async function mustSave($: $): Promise<boolean> {
  if ((await $.env.get('BASE_AUTOSAVE')) === '0') return false
  const p = await read($, baseProgress)
  return p !== null && p.workId !== null && p.stale === true
}

function pressCompact($: $): void {
  if (turn.running) {
    $.ui.toast('turn is running — press Compact again when it ends')
    return
  }
  const refused = (err: unknown) => $.ui.toast(`compact refused: ${err instanceof Error ? err.message : String(err)}`)
  // A headless (SDK, desktop app) session refuses the op but still runs a typed /compact.
  const compact = () =>
    $.session.compact().then(
      r => $.ui.toast(compactToast(r)),
      () => $.command.run({ command: 'compact' }).then(r => $.ui.toast(r.text || 'compacted'), refused),
    )
  // After a save only the queued /compact is sure to run after the save's turn; the op could run before it starts.
  const saveThenCompact = () =>
    $.command.run({ command: SAVE }).then(
      () => $.command.run({ command: 'compact' }).then(r => $.ui.toast(`saved, then ${r.text || 'compacted'}`), refused),
      compact,
    )
  mustSave($).then(stale => (stale ? saveThenCompact() : compact()), compact)
}

const CLEAR_QUESTION = 'Clear the conversation?'
const CLEAR_YES = 'Yes'

/** Always behind the engine's own Yes/No dialog: it takes the keyboard, so a stray click or hotkey never clears. */
function pressClear($: $): void {
  if (turn.running) {
    $.ui.toast('turn is running — press Clear again when it ends')
    return
  }
  const refused = (err: unknown) => $.ui.toast(`clear refused: ${err instanceof Error ? err.message : String(err)}`)
  // A dismissed dialog rejects: that is a No.
  $.ui.ask(CLEAR_QUESTION, [CLEAR_YES, 'No']).then(
    answer => {
      if (answer !== CLEAR_YES) return
      $.command.run({ command: 'clear' }).then(r => $.ui.toast(r.text || 'cleared'), refused)
    },
    () => undefined,
  )
}

/** A pick folds the picker and runs `/model <id>` as typed; the switch event then moves the segment. The current id only folds. */
function pickModel($: $, id: string, current: string): void {
  void setPicker($, false)
  if (id === current) return
  $.command.run({ command: 'model', args: id }).then(
    r => $.ui.toast(r.text || `model ${id}`),
    err => $.ui.toast(`model refused: ${err instanceof Error ? err.message : String(err)}`),
  )
}

/** The surface the band last drew on; a desktop has no hotkey letters, so focus moves must not redraw it. */
let drawnOn: string = 'terminal'

/** The last render's surface and measured props, for /band-debug. */
export const lastRender: { surface: string | null; bodyColumns: number | undefined; maxRows: number | undefined } = {
  surface: null,
  bodyColumns: undefined,
  maxRows: undefined,
}

/** Guarded write: a redraw between a click's focus-in and its press would swallow the press. */
async function setFocused($: $, to: boolean): Promise<void> {
  if (drawnOn !== 'desktop' && (await read($, bandFocused)) !== to) await update($, bandFocused, () => to)
}

/** Guarded write, as setFocused; the desktop never unfolds. */
async function setPicker($: $, to: boolean): Promise<void> {
  if (drawnOn !== 'desktop' && (await read($, modelPicker)) !== to) await update($, modelPicker, () => to)
}

export function registerBand(on: On, options: PluginOptions): void {
  // Hotkey letters are drawn only while the band holds the keyboard. A focus-in sets the flag; a
  // press, a turn or /clear clears it, as there is no focus-out event. The hotkeys stay armed.
  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (options.disabled === true) return next(e)
    await setFocused($, true)
    return next(e)
  })
  // Unfolding the model picker keeps the keyboard on the band: its models take hotkey letters of their own.
  on('ui.press', { plugin: 'band' }, async ($, e, next) => {
    if (e.element !== 'model') await setFocused($, false)
    return next(e)
  })
  on('turn.start', async ($, e, next) => {
    turn.running = true
    await setFocused($, false)
    await setPicker($, false)
    return next(e)
  })
  // A typed /compact would compact before a save it awaited could run, and the host refuses $.command.run from this
  // hook: a stale workspace answers it, and a timer queues the save, then /compact again. band's own runs pass.
  on('command.run', { command: 'compact' }, async ($, e, next) => {
    if ((e.origin.kind === 'plugin' && e.origin.name === 'band') || !(await mustSave($).catch(() => false))) return next(e)
    const again = () => $.command.run({ command: 'compact', args: e.args })
    $.clock.after(1, () => {
      $.command.run({ command: SAVE })
        .then(again, again)
        .catch(err => $.ui.toast(`compact refused: ${err instanceof Error ? err.message : String(err)}`))
    })
    return { text: 'workspace stale: saving it first, then compacting' }
  })
  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    turn.running = false
    await setFocused($, false)
    await setPicker($, false)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The engine's own truth: every draw re-aligns a flag a missed turn.complete or a hot reload left wrong.
    turn.running = e.props.isWorking
    if (options.disabled === true || e.props.hasSurvey) return next(e)
    const u = await read($, usage)
    const m = await read($, model)
    const c = await read($, cache)
    const now = await read($, tick)
    const isPaneShown = await read($, paneShown)
    const focused = await read($, bandFocused)
    const unfolded = await read($, modelPicker)
    if (u.ctxPct === null && u.rates.length === 0 && m === null && c.anchorMs === null) return next(e)

    const isWorking = e.props.isWorking
    const snapshot = pickProgress(await read($, baseProgress), await read($, fndProgress))?.snapshot ?? null
    const digest = !isPaneShown ? digestOf(snapshot) : null
    const hasChecklist = toChecklist(snapshot) !== null
    // Short-circuit: while band's own list holds a line the foreign lists are not read, so their writes do not redraw the band.
    const hasEvents =
      take(await read($, events)).length > 0 ||
      merged([], await read($, baseEvents), await read($, fndEvents), await read($, slimEvents), {
        fe: await read($, feEvents),
        qa: await read($, qaEvents),
        be: await read($, beEvents),
        pm: await read($, pmEvents),
      }).length > 0
    const isDesktop = e.surface === 'desktop'
    drawnOn = e.surface
    lastRender.surface = e.surface
    lastRender.bodyColumns = e.props.bodyColumns
    lastRender.maxRows = e.props.maxRows
    // A desktop draws proportional text: its bodyColumns do not measure the row, so nothing is dropped there.
    const segs = layout(bandSegs({ usage: u, model: m, cache: c, nowMs: now, isWorking, digest, hasChecklist, hasEvents }), isDesktop ? undefined : e.props.bodyColumns)
    const { Box, Text, Button } = $.ui.resolve(e)

    const label = (text: string) => (isDesktop ? glyphText(text) : text)
    // Dim label, bold value (`cache` dim, `42m` bold); a desktop glyph label stays at full strength.
    const dimLabel = isDesktop ? {} : { dimColor: true }
    const labeled = (text: string, labelProps: Record<string, unknown>, valueProps: Record<string, unknown>): RenderNode => {
      const [l, v] = splitLabel(text)
      return (
        <Box flexDirection="row">
          <Text {...labelProps} wrap="truncate-end">
            {v ? `${l} ` : l}
          </Text>
          {v ? (
            <Text {...valueProps} wrap="truncate-end">
              {v}
            </Text>
          ) : null}
        </Box>
      )
    }
    const cardMax = e.props.bodyColumns && e.props.bodyColumns > 0 ? e.props.bodyColumns : Infinity
    // A keyed Box is a hover scope; its hidden child is the card. A surface without a pointer never reveals it.
    // The card gets its own width: an absolute Box would otherwise shrink to its segment. The terminal clips
    // it to the segment's columns, so there it pops up a row above, over the rule; the desktop lays it over.
    const hoverable = (key: string, body: RenderNode, card: string): RenderNode => (
      <Box key={key}>
        {body}
        <Box
          position="absolute"
          top={isDesktop ? 0 : -1}
          left={0}
          width={Math.min(cells(card), cardMax)}
          display="none"
          hover={{ display: 'flex' }}
        >
          <Text inverse wrap="truncate-end">
            {card}
          </Text>
        </Box>
      </Box>
    )
    const rate = (r: BandRate, i: number): RenderNode[] => [
      ...(i > 0 ? [<Text dimColor> · </Text>] : []),
      hoverable(`seg-rate-${r.kind}`, labeled(rateText(r), dimLabel, { bold: true, ...LEVEL_PROPS[pctLevel(r.pct)] }), rateCard(r, now)),
    ]

    // A desktop draws a hotkey as a badge on its native button, and its buttons are clicked: no hotkeys there.
    const letters = focused && !isDesktop ? { plain: true as const } : null
    const hot = (k: string) => (isDesktop ? {} : { hotkey: k })

    // Unfolded, the row holds the models alone: four names plus letters outgrow a row that also holds the figures.
    // The current one is at full strength and only folds; no Esc, as the engine raises no focus-out.
    if (unfolded && !isDesktop && m !== null) {
      const options = modelOptions(m)
      const row: RenderNode[] = [<Text dimColor>model </Text>]
      options.forEach((o, i) => {
        if (i > 0) row.push(<Text>{'  '}</Text>)
        row.push(
          <Button
            key={`model:${o.value}`}
            label={o.label}
            plain
            {...(letters && o.hotkey ? { hotkey: o.hotkey } : {})}
            {...(o.value === m ? {} : { dimColor: true })}
            onPress={() => pickModel($, o.value, m)}
          />,
        )
      })
      const ruleCols = e.props.bodyColumns && e.props.bodyColumns > 0 ? Math.min(e.props.bodyColumns, 400) : 80
      return (
        <Box flexDirection="column">
          <Text dimColor>{RULE.repeat(ruleCols)}</Text>
          <Box flexDirection="row">{row}</Box>
        </Box>
      )
    }

    const groups: RenderNode[][] = []
    if (segs.cache !== null) {
      const level = LEVEL_PROPS[cacheView(c, now, isWorking).level]
      groups.push([hoverable('seg-cache', labeled(label(segs.cache), dimLabel, { bold: true, ...level }), cacheCard(c, now))])
    }
    // The terminal has no model menu of its own in reach, so its segment is the picker's button; the desktop app has one.
    if (segs.model !== null && m !== null) {
      groups.push([
        isDesktop ? (
          <Text wrap="truncate-end">{`${GLYPH.model} ${segs.model}`}</Text>
        ) : (
          <Button key="model" label={`${segs.model}${MODEL_MARK}`} plain {...(letters ? { hotkey: 'm' } : {})} onPress={() => setPicker($, true)} />
        ),
      ])
    }
    const ctxLevel = u.ctxPct === null ? {} : CTX_PROPS[pctLevel(u.ctxPct)]
    groups.push([hoverable('seg-ctx', labeled(label(segs.ctx), dimLabel, { bold: true, ...ctxLevel }), ctxCard(u))])
    if (segs.rates.length) {
      groups.push([...(isDesktop ? [<Text>{`${GLYPH.rates} `}</Text>] : []), ...segs.rates.flatMap(rate)])
    }
    if (segs.cost !== null && u.costUsd !== null) {
      groups.push([hoverable('seg-cost', labeled(label(segs.cost), dimLabel, { bold: true }), costCard(u.costUsd))])
    }
    if (segs.digest !== null) {
      groups.push([
        <Box key="seg-digest" flexDirection="row">
          {isDesktop ? <Text>{`${GLYPH.digest} `}</Text> : null}
          {labeled(segs.digest, { bold: true }, {})}
        </Box>,
      ])
    }
    const buttons: RenderNode[] = []
    const look = letters ?? (segs.compact.plain ? {} : { variant: 'primary' as const })
    buttons.push(<Button key="compact" label="Compact" {...hot('c')} {...look} onPress={() => pressCompact($)} />)
    if (segs.clear !== null) {
      buttons.push(<Text>{'  '}</Text>)
      buttons.push(<Button key="clear" label="Clear" {...hot('x')} {...(letters ?? { dimColor: true })} onPress={() => pressClear($)} />)
    }
    if (segs.progress !== null) {
      buttons.push(<Text>{'  '}</Text>)
      buttons.push(<Button key="progress" label="Progress" {...hot('p')} {...(letters ?? { dimColor: true })} onPress={() => {}} />)
    }
    if (segs.log !== null) {
      buttons.push(<Text>{'  '}</Text>)
      buttons.push(<Button key="log" label="Log" {...hot('l')} {...(letters ?? { dimColor: true })} onPress={() => {}} />)
    }
    // A desktop draws native buttons: in the figures' row they squash it and sit far right, so they get a row of
    // their own below, left-aligned. The terminal keeps one row: its height is the scarce side there.
    if (!isDesktop) groups.push(buttons)

    const row = groups.flatMap((g, i) => (i === 0 ? g : [<Text dimColor>{SEP}</Text>, ...g]))
    // No overflow="hidden" here: it would clip the terminal's cards on the rule row above.
    const rowBox = (
      <Box flexDirection="row">
        {row}
      </Box>
    )
    // A dim rule separates the band from the transcript above it; the desktop frames its panel itself.
    if (isDesktop) {
      // A row of air between the figures and the buttons, and around the whole, so the panel is not one dense block.
      return (
        <Box flexDirection="column" gap={1} padding={1}>
          {rowBox}
          <Box flexDirection="row">{buttons}</Box>
        </Box>
      )
    }
    const ruleCols = e.props.bodyColumns && e.props.bodyColumns > 0 ? Math.min(e.props.bodyColumns, 400) : 80
    return (
      <Box flexDirection="column">
        <Text dimColor>{RULE.repeat(ruleCols)}</Text>
        {rowBox}
      </Box>
    )
  })
}
