// MCP result slimming as a mod: host-stub replacement and the savings toast (FND_SLIM_TOAST=0 silences it,
// FND_SLIM_TOAST_MS sets how long it stays). FND_COMPRESSION=proxy hands the job to the slim plugin while
// its slim.info snapshot lists the MCP channel; without it this module compresses every result itself.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { FndEvent, FndEventKind, FndSlimInfo } from '../../../types'
import { bare, pushEvent, toolName } from '../core/events.ts'
import { buildHookRun, omit, parseHookOut, slimFigureIn, stubBytes, stubText, toastMs } from './node-hook.ts'

const events = atom({ plugin: 'fnd', key: 'events' } as const, [] as FndEvent[])
const proxyNotice = atom({ plugin: 'fnd', key: 'proxyNotice' } as const, null as string | null)
const proxySweep = atom({ plugin: 'fnd', key: 'proxySweep' } as const, null as string | null)
const slimInfo = atom({ plugin: 'slim', key: 'info' } as const, null as FndSlimInfo | null)

// mcp-slim's GATE_BYTES: below it the classic hook passes a result through untouched.
const PROXY_GATE_BYTES = 4096
// The labels slim's emissions carry, and fnd's own (which mcp-slim would pass through anyway).
const STATS_LINE = /^(slim|fnd-mcp-slim): (?:compressed|stub) [\d,]+ B → [\d,]+ B \([-+−]?\d+(?:\.\d+)?%\)$/gm
const SLIM_HEADS = ['<<slim stub>>']
const OWN_HEADS = ['<<fnd-mcp-slim stub>>', '<<fnd-jsx-slim>>']

type $ = EngineInterface

async function logEvent($: $, kind: FndEventKind, text: string): Promise<void> {
  try {
    if ((await $.env.get('FND_EVENT_LOG')) === '0') return
    const atMs = await $.clock.now()
    await update($, events, l => pushEvent(l, { atMs, kind, text }))
  } catch {}
}

/** `<type> · ` for a subagent's line (`fnd:` dropped, `agent` when unlisted); '' on the main loop. */
async function loopLabel($: $, agentId: string | undefined): Promise<string> {
  if (agentId === undefined) return ''
  try {
    const type = (await $.agent.list()).find(a => a.id === agentId)?.type
    if (type) return `${type.replace(/^fnd:/, '')} · `
  } catch {}
  return 'agent · '
}

function serialized(result: unknown): string {
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result) ?? ''
  } catch {
    return ''
  }
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}

/** The texts the model reads in an MCP result: the string, or each text block's text. */
function textsOf(result: unknown): string[] {
  if (typeof result === 'string') return [result]
  const blocks = Array.isArray(result) ? result : (result as { content?: unknown } | null)?.content
  if (Array.isArray(blocks)) {
    return blocks.flatMap(b => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? [(b as { text: string }).text] : []))
  }
  const t = (result as { text?: unknown } | null)?.text
  return typeof t === 'string' ? [t] : []
}

/**
 * Already compressed output, judged within the bound the emitter can reach (a quote in a big payload
 * is not one): slim's labels only, or fnd's too when `withFnd`.
 */
function slimTagged(texts: string[], limit: number, withFnd: boolean): boolean {
  if (texts.reduce((n, t) => n + utf8Bytes(t), 0) > limit + 1200) return false
  const heads = withFnd ? [...SLIM_HEADS, ...OWN_HEADS] : SLIM_HEADS
  return texts.some(t => heads.some(h => t.includes(h)) ||
    (t.includes('<<full=') && [...t.matchAll(STATS_LINE)].some(m => withFnd || m[1] === 'slim')))
}

/** Once per session: mcp-slim's exit sweep (scratch spills, playwright output) still runs while slim compresses. */
async function sweepOnce($: $, tool: string): Promise<void> {
  const sid = await $.session.id()
  if ((await read($, proxySweep)) === sid) return
  let prev = null as string | null
  await update($, proxySweep, p => {
    prev = p
    return sid
  })
  if (prev === sid) return
  const { argv, init } = buildHookRun(
    $.plugin.root,
    'hooks/mcp-slim.cjs',
    [],
    { cwd: await $.session.cwd(), tool_name: tool },
    { FND_HOST: 'claude', FND_COMPRESSION: 'proxy', CLAUDE_PLUGIN_ROOT: $.plugin.root },
    30_000,
  )
  // Hygiene only: nothing waits on it, and a failure costs nothing but the sweep.
  $.process.run(argv, init).catch(() => null)
}

/**
 * Once per session each: the Log line on the first call, the toast on the first main-loop call (a
 * subagent's call must not spend it). proxyNotice holds `<sid>` once logged, `<sid>:toast` once shown;
 * the claim is made inside update(), so two parallel calls cannot both win it.
 */
async function noticeOnce($: $, isMain: boolean, info: FndSlimInfo | null): Promise<void> {
  const sid = await $.session.id()
  const shown = `${sid}:toast`
  let prev = null as string | null
  await update($, proxyNotice, p => {
    prev = p
    return isMain || p === shown ? shown : sid
  })
  const logged = prev === sid || prev === shown
  if (logged && (!isMain || prev === shown)) return
  const text = info
    ? "FND_COMPRESSION=proxy, but slim's MCP channel is off (SLIM_MCP=0) — fnd compresses"
    : 'FND_COMPRESSION=proxy, but slim is not loaded (or older than 0.3.0) — fnd compresses'
  if (isMain && prev !== shown) $.ui.toast(text)
  if (!logged) await logEvent($, 'slim', text)
}

export function registerSlim(on: On): void {
  on('tool.call', { tool: /^mcp__/ }, async ($, e, next) => {
    // Never race next: returning while it is pending aborts what runs beneath.
    const r = await next(e)
    if (r.deny !== undefined || (await $.env.get('FND_MCP_SLIM')) === '0') return r
    const isMain = e.agentId === undefined

    let proxyInfo: FndSlimInfo | null = null
    const proxy = (await $.env.get('FND_COMPRESSION')) === 'proxy'
    if (proxy) {
      proxyInfo = await read($, slimInfo)
      if (Array.isArray(proxyInfo?.channels) && proxyInfo.channels.includes('mcp')) {
        await sweepOnce($, e.tool)
        return r
      }
    }

    const limit = stubBytes(await $.env.get('FND_MCP_SLIM_STUB_BYTES'))
    // slim beneath already compressed it: a slim output that quotes the overflow phrase is no host stub.
    if (slimTagged(textsOf(r.result), limit, false)) return r
    const stub = stubText(r.result)
    // Under proxy the classic hook never ran beneath, so the whole result is this module's to compress.
    const whole = proxy && !stub
    if (whole) {
      if (utf8Bytes(serialized(r.result)) <= PROXY_GATE_BYTES) return r
      if (slimTagged(textsOf(r.result), limit, true)) return r
    }
    if (!stub && !whole) {
      // The classic hook already slimmed it beneath us: only the figure is left to show.
      const figure = slimFigureIn(r.result, limit, r.text)
      if (isMain && figure && (await $.env.get('FND_SLIM_TOAST')) !== '0') {
        $.ui.toast(figure, { timeoutMs: toastMs(await $.env.get('FND_SLIM_TOAST_MS')) })
      }
      if (figure) await logEvent($, 'slim', `${await loopLabel($, e.agentId)}${toolName(e.tool)}: ${bare(figure)}`)
      return r
    }

    const { argv, init } = buildHookRun(
      $.plugin.root,
      'hooks/mcp-slim.cjs',
      ['--from-mod', '--overflow=expand'],
      {
        hook_event_name: 'PostToolUse',
        tool_name: e.tool,
        tool_input: omit(e, ['tool', 'tool_use_id', 'agentId']),
        tool_response: r.result,
        cwd: await $.session.cwd(),
        session_id: await $.session.id(),
      },
      { FND_HOST: 'claude', CLAUDE_PLUGIN_ROOT: $.plugin.root },
      120_000,
    )
    const out = await $.process.run(argv, init).then(parseHookOut, () => null)
    if (proxy) await noticeOnce($, isMain, proxyInfo)
    const hso = out?.hookSpecificOutput
    const result = hso?.updatedMCPToolOutput ?? hso?.updatedToolOutput
    if (result === undefined) return r
    const figure = typeof out?.systemMessage === 'string' ? out.systemMessage : ''
    if (isMain && figure && (await $.env.get('FND_SLIM_TOAST')) !== '0') {
      $.ui.toast(figure, { timeoutMs: toastMs(await $.env.get('FND_SLIM_TOAST_MS')) })
    }
    if (figure) await logEvent($, 'slim', `${await loopLabel($, e.agentId)}${toolName(e.tool)}: ${bare(figure)}`)
    // A fresh object: returning `r` itself would make core reuse its own messages verbatim.
    return r.context?.length ? { result, context: r.context } : { result }
  })
}
