// Status band: the AbovePrompt row drawn from the atoms, and the Compact press.
// Render only reads atoms; usage.ts and progress.tsx write them. The Progress button's press is
// answered by progress.tsx's `ui.press` hook on element `progress`.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, RenderNode } from 'claude-code'
import type { FndRate } from '../../../types'
import {
  CACHE_INIT,
  GLYPH,
  LEVEL_PROPS,
  RULE,
  SEP,
  USAGE_INIT,
  bandSegs,
  cacheCard,
  cells,
  cacheView,
  compactToast,
  ctxCard,
  glyphText,
  layout,
  pctLevel,
  rateCard,
  rateText,
  splitLabel,
} from './lib.ts'
import { digestText } from './progress-parse.ts'

const usage = atom({ plugin: 'fnd', key: 'usage' } as const, USAGE_INIT)
const model = atom({ plugin: 'fnd', key: 'model' } as const, null)
const cache = atom({ plugin: 'fnd', key: 'cache' } as const, CACHE_INIT)
const tick = atom({ plugin: 'fnd', key: 'tick' } as const, 0)
const progress = atom({ plugin: 'fnd', key: 'progress' } as const, null)
const paneShown = atom({ plugin: 'fnd', key: 'paneShown' } as const, false)
const bandFocused = atom({ plugin: 'fnd', key: 'bandFocused' } as const, false)

type $ = EngineInterface

function pressCompact($: $): void {
  $.session.compact().then(
    r => $.ui.toast(compactToast(r)),
    err => $.ui.toast(`compact refused: ${err instanceof Error ? err.message : String(err)}`),
  )
}

export function registerBand(on: On, options: PluginOptions): void {
  // Hotkey letters are drawn only while the band holds the keyboard. A focus-in sets the flag; a
  // press, a turn or /clear clears it, as there is no focus-out event. The hotkeys stay armed.
  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    await update($, bandFocused, () => true)
    return next(e)
  })
  on('ui.press', { plugin: 'fnd' }, async ($, e, next) => {
    await update($, bandFocused, () => false)
    return next(e)
  })
  on('turn.start', async ($, e, next) => {
    await update($, bandFocused, () => false)
    return next(e)
  })
  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    await update($, bandFocused, () => false)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (options.statusBand === false || e.props.hasSurvey) return next(e)
    const u = await read($, usage)
    const m = await read($, model)
    const c = await read($, cache)
    const now = await read($, tick)
    const p = await read($, progress)
    const isPaneShown = await read($, paneShown)
    const focused = await read($, bandFocused)
    if (u.ctxPct === null && u.rates.length === 0 && m === null && c.anchorMs === null) return next(e)

    const isWorking = e.props.isWorking
    const digest = p !== null && p.workId !== null && !isPaneShown ? digestText(p.workId, p) : null
    const segs = layout(bandSegs({ usage: u, model: m, cache: c, nowMs: now, isWorking, digest }), e.props.bodyColumns)
    const isDesktop = e.surface === 'desktop'
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
    // The card gets its own width: an absolute Box would otherwise shrink to its segment.
    const hoverable = (key: string, body: RenderNode, card: string): RenderNode => (
      <Box key={key}>
        {body}
        <Box
          position="absolute"
          top={0}
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
    const rate = (r: FndRate, i: number): RenderNode[] => [
      ...(i > 0 ? [<Text dimColor> · </Text>] : []),
      hoverable(`seg-rate-${r.kind}`, labeled(rateText(r), dimLabel, { bold: true, ...LEVEL_PROPS[pctLevel(r.pct)] }), rateCard(r, now)),
    ]

    const groups: RenderNode[][] = []
    if (segs.cache !== null) {
      const level = LEVEL_PROPS[cacheView(c, now, isWorking).level]
      groups.push([hoverable('seg-cache', labeled(label(segs.cache), dimLabel, { bold: true, ...level }), cacheCard(c, now))])
    }
    if (segs.model !== null) {
      groups.push([<Text wrap="truncate-end">{segs.model}</Text>])
    }
    const ctxLevel = u.ctxPct === null ? {} : LEVEL_PROPS[pctLevel(u.ctxPct)]
    groups.push([hoverable('seg-ctx', labeled(label(segs.ctx), dimLabel, { bold: true, ...ctxLevel }), ctxCard(u))])
    if (segs.rates.length) {
      groups.push([...(isDesktop ? [<Text>{`${GLYPH.rates} `}</Text>] : []), ...segs.rates.flatMap(rate)])
    }
    if (segs.digest !== null) groups.push([<Box key="seg-digest">{labeled(segs.digest, { bold: true }, {})}</Box>])
    const buttons: RenderNode[] = []
    const letters = focused ? { plain: true as const } : null
    if (segs.compact !== null) {
      const look = letters ?? (segs.compact.plain ? { dimColor: true } : { variant: 'primary' as const })
      buttons.push(<Button key="compact" label="Compact" hotkey="c" {...look} onPress={() => pressCompact($)} />)
    }
    if (segs.progress !== null) {
      if (buttons.length) buttons.push(<Text>{'  '}</Text>)
      buttons.push(<Button key="progress" label="Progress" hotkey="p" {...(letters ?? { dimColor: true })} onPress={() => {}} />)
    }
    if (buttons.length) groups.push(buttons)

    const row = groups.flatMap((g, i) => (i === 0 ? g : [<Text dimColor>{SEP}</Text>, ...g]))
    // A dim rule separates the band from the transcript above it.
    const ruleCols = e.props.bodyColumns && e.props.bodyColumns > 0 ? Math.min(e.props.bodyColumns, 400) : 80
    return (
      <Box flexDirection="column">
        <Text dimColor>{RULE.repeat(ruleCols)}</Text>
        <Box flexDirection="row" overflow="hidden">
          {row}
        </Box>
      </Box>
    )
  })
}
