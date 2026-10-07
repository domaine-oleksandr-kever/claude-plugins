// Every tool result slim reads goes through scripts/slim.cjs here: the result replaced with the core's
// answer, one slim.events entry, the row the ToolResult and ToolGroup lines draw, and a savings toast
// for MCP calls on the main loop. Also the @-mention probe, which only reports.
import { atom, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { SlimChannel, SlimEvent } from '../../types'
import { GATES, attachmentShape, candidate, channelOf, floor, guardOf, viewOf } from './channels.ts'
import type { Pre } from './channels.ts'
import { agentPrefix, eventText, pushEvent } from './events.ts'
import {
  alreadySlimIn,
  alreadySlimTexts,
  bareCurl,
  buildErrorRun,
  buildRun,
  bytesSeen,
  debugLevel,
  hostStub,
  omit,
  parseOut,
  plainBytes,
  resultBytes,
  stubBytes,
  toastMs,
  utf8Bytes,
} from './node-hook.ts'

const EVENTS = atom({ plugin: 'slim', key: 'events' } as const, [] as SlimEvent[])

export const DENY_TEXT =
  'slim: a bare curl of a page is turned off here (SLIM_CURL=deny) — for one fact call mcp__slim__lookup({ url, question }); ' +
  'for the page content use WebFetch(url, prompt).'

type $ = EngineInterface

/** The channel's SLIM_<CHANNEL> switch, each read by its literal name. */
async function switchOf($: $, ch: SlimChannel): Promise<string | undefined> {
  switch (ch) {
    case 'mcp': return $.env.get('SLIM_MCP')
    case 'bash': return $.env.get('SLIM_BASH')
    case 'read': return $.env.get('SLIM_READ')
    case 'webfetch':
    case 'websearch': return $.env.get('SLIM_WEB')
    case 'grep':
    case 'glob': return $.env.get('SLIM_GREP')
    case 'agent': return $.env.get('SLIM_AGENT')
  }
}

async function level($: $): Promise<0 | 1 | 2> {
  return debugLevel((await $.env.get('SLIM_DEBUG')) || (await $.env.get('FND_MCP_SLIM_DEBUG')))
}

/** Within this many bytes a stub mark or a stats line beside a handle is trusted without the core. */
async function slimBound($: $): Promise<number> {
  return Math.max(stubBytes(await $.env.get('SLIM_STUB_BYTES')), stubBytes(await $.env.get('FND_MCP_SLIM_STUB_BYTES'))) + 1200
}

/** Asks the core to append the error line: `$.fs` has no append, and the spill root is the core's to resolve. */
async function reportError($: $, channel: string, tool: string, toolUseId: string | undefined, name: string, message: string): Promise<void> {
  try {
    const payload = {
      v: 1,
      channel,
      tool,
      ...(toolUseId !== undefined ? { tool_use_id: toolUseId } : {}),
      cwd: await $.session.cwd(),
      error: { name, message: message.slice(0, 200) },
    }
    const { argv, init } = buildErrorRun($.plugin.root, payload)
    await $.process.run(argv, init)
  } catch {}
}

/** The subagent's type as $.agent.list() names it; undefined when unlisted or the list throws. */
async function agentType($: $, agentId: string): Promise<string | undefined> {
  try {
    return (await $.agent.list()).find(a => a.id === agentId)?.type || undefined
  } catch {
    return undefined
  }
}

export function registerIntake(on: On): void {
  on('tool.call', async ($, e, next) => {
    // Only the model's calls: a plugin's own $.tool.call (lookup's among them) gets the record it asked for.
    if (next.origin.plugin !== 'engine') return next(e)
    const args = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    if (tool === 'Bash' && /\bcurl\b/.test(String(args.command ?? ''))) {
      if ((await $.env.get('SLIM_CURL')) === 'deny' && bareCurl(String(args.command))) return { deny: DENY_TEXT }
    }

    // Never race next: returning while it is pending aborts what runs beneath.
    const r = await next(e)
    if (r.deny !== undefined) return r
    const ch = channelOf(tool)
    if (ch === null || ch === 'lookup') return r

    // Passthroughs the mod can tell alone; the core is spawned for them only to write the report line.
    let pre: Pre | null = null
    let bytesIn: number
    if (ch === 'mcp') {
      if ((await switchOf($, ch)) === '0') return r
      // Already-slim first: a slimmed result can quote the overflow phrase above its own host-file handle.
      const slimmed = alreadySlimIn(r.result, await slimBound($), r.text)
      bytesIn = resultBytes(r.result)
      if (slimmed || hostStub(r.result) === null) {
        pre = r.isError === true ? 'error-shape' : slimmed ? 'already-slim' : bytesIn <= GATES.mcp ? 'size-gate' : null
      }
    } else {
      // Sizes first and pure: a result below the floor costs no env read and writes no line.
      const view = viewOf(ch, r, args)
      if (view === null || !floor(ch, view)) return r
      if ((await switchOf($, ch)) === '0') return r
      bytesIn = view.bytes
      pre = guardOf(ch, view)
      if (pre === null && alreadySlimTexts(view.texts, await slimBound($))) pre = 'already-slim'
      if (pre === null && !candidate(ch, view, plainBytes(await $.env.get('SLIM_PLAIN_BYTES')))) return r
    }
    if (pre !== null && (await level($)) < (pre === 'error-shape' ? 1 : 2)) return r

    const envelope = {
      v: 1,
      channel: ch,
      tool,
      tool_use_id: e.tool_use_id,
      tool_input: omit(e, ['tool', 'tool_use_id', 'agentId']),
      tool_response: pre ? null : r.result,
      is_error: r.isError === true,
      cwd: await $.session.cwd(),
      session_id: await $.session.id(),
      ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
      ...(pre ? { pre, bytes_in: bytesIn } : {}),
    }
    const { argv, init } = buildRun($.plugin.root, envelope)
    let run
    try {
      run = await $.process.run(argv, init)
    } catch (err) {
      await reportError($, ch, tool, e.tool_use_id, 'spawn-rejected', String((err as Error)?.message ?? err))
      return r
    }
    const parsed = parseOut(run)
    if (!parsed.ok) {
      await reportError($, ch, tool, e.tool_use_id, parsed.reason, parsed.message)
      return r
    }
    const out = parsed.out
    if (pre || (out.decision !== 'compressed' && out.decision !== 'stubbed')) return r

    const rec = out.record
    const engine = rec.engine!
    const seen = bytesSeen(rec)
    try {
      await $.state.set({ plugin: 'slim', key: 'rows', id: e.tool_use_id }, { engine, bytesIn: seen, bytesOut: rec.bytes_out })
    } catch {}

    const isSub = e.agentId !== undefined
    const listed = isSub ? await agentType($, e.agentId!) : undefined
    const type = isSub ? (listed ?? 'agent') : undefined
    const decision = out.decision as 'compressed' | 'stubbed'
    const text = eventText(agentPrefix(listed, isSub), tool, decision, engine, seen, rec.bytes_out)
    // A toast per Bash or Read would be noise: the other channels show the row and the group line.
    if (ch === 'mcp' && !isSub && (await $.env.get('SLIM_TOAST')) !== '0') {
      $.ui.toast(text, { timeoutMs: toastMs(await $.env.get('SLIM_TOAST_MS')) })
    }
    if ((await $.env.get('SLIM_EVENT_LOG')) !== '0') {
      try {
        const atMs = await $.clock.now()
        const ev: SlimEvent = {
          v: 1, atMs, kind: 'slim', text, src: 'slim', tool, channel: ch,
          ...(type ? { agentType: type } : {}),
          bytesIn: seen, bytesOut: rec.bytes_out, engine, ms: rec.ms,
        }
        await update($, EVENTS, l => pushEvent(l, ev))
      } catch {}
    }
    // A fresh object: returning `r` itself would make core reuse its own messages verbatim.
    return r.context?.length ? { result: out.result, context: r.context } : { result: out.result }
  })

  // No rewrite: an @-mentioned file reaches the model as the Read mapper framed it. Large ones are
  // reported at SLIM_DEBUG=2 with their shape, the data for deciding whether to compress them later.
  on('prompt.attachment', { type: 'file' }, async ($, e, next) => {
    const d = await next(e)
    const bytes = utf8Bytes(e.text)
    if (bytes <= GATES.read) return d
    try {
      if ((await level($)) < 2) return d
      const probe = {
        v: 1,
        channel: 'attachment',
        tool: 'Attachment',
        tool_input: { type: e.type, origin: e.origin.kind, shape: attachmentShape(e.text) },
        tool_response: null,
        is_error: false,
        cwd: await $.session.cwd(),
        session_id: await $.session.id(),
        pre: 'not-covered',
        bytes_in: bytes,
      }
      const { argv, init } = buildRun($.plugin.root, probe, 10_000)
      await $.process.run(argv, init)
    } catch {}
    return d
  })
}
