// MCP tool results through slim's core (scripts/slim.cjs): the result replaced with its answer, a
// savings toast on the main loop, one slim.events entry and the row the ToolResult line draws.
import { atom, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { SlimEvent } from '../../types'
import { agentPrefix, eventText, pushEvent } from './events.ts'
import {
  GATE_BYTES,
  alreadySlimIn,
  buildErrorRun,
  buildRun,
  debugLevel,
  hostStub,
  omit,
  parseOut,
  resultBytes,
  stubBytes,
  toastMs,
} from './node-hook.ts'

const EVENTS = atom({ plugin: 'slim', key: 'events' } as const, [] as SlimEvent[])

type $ = EngineInterface
type Pre = 'error-shape' | 'already-slim' | 'size-gate'

/** Asks the core to append the error line: `$.fs` has no append, and the spill root is the core's to resolve. */
async function reportError($: $, tool: string, toolUseId: string | undefined, name: string, message: string): Promise<void> {
  try {
    const payload = {
      v: 1,
      channel: 'mcp',
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

export function registerMcp(on: On): void {
  on('tool.call', { tool: /^mcp__/ }, async ($, e, next) => {
    // Never race next: returning while it is pending aborts what runs beneath.
    const r = await next(e)
    if (r.deny !== undefined) return r
    if ((await $.env.get('SLIM_MCP')) === '0') return r

    // Passthroughs the mod can tell alone; the core is spawned for them only to write the report line.
    // Already-slim first: a slimmed result can quote the overflow phrase above its own host-file handle.
    const bound = Math.max(stubBytes(await $.env.get('SLIM_STUB_BYTES')), stubBytes(await $.env.get('FND_MCP_SLIM_STUB_BYTES'))) + 1200
    const slimmed = alreadySlimIn(r.result, bound, r.text)
    let pre: Pre | null = null
    if (slimmed || hostStub(r.result) === null) {
      pre = r.isError === true
        ? 'error-shape'
        : slimmed
          ? 'already-slim'
          : resultBytes(r.result) <= GATE_BYTES
            ? 'size-gate'
            : null
      if (pre !== null) {
        const lvl = debugLevel((await $.env.get('SLIM_DEBUG')) || (await $.env.get('FND_MCP_SLIM_DEBUG')))
        if (lvl < (pre === 'error-shape' ? 1 : 2)) return r
      }
    }

    const envelope = {
      v: 1,
      channel: 'mcp',
      tool: e.tool,
      tool_use_id: e.tool_use_id,
      tool_input: omit(e, ['tool', 'tool_use_id', 'agentId']),
      tool_response: pre ? null : r.result,
      is_error: r.isError === true,
      cwd: await $.session.cwd(),
      session_id: await $.session.id(),
      ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
      ...(pre ? { pre, bytes_in: resultBytes(r.result) } : {}),
    }
    const { argv, init } = buildRun($.plugin.root, envelope)
    let run
    try {
      run = await $.process.run(argv, init)
    } catch (err) {
      await reportError($, e.tool, e.tool_use_id, 'spawn-rejected', String((err as Error)?.message ?? err))
      return r
    }
    const parsed = parseOut(run)
    if (!parsed.ok) {
      await reportError($, e.tool, e.tool_use_id, parsed.reason, parsed.message)
      return r
    }
    const out = parsed.out
    if (pre || (out.decision !== 'compressed' && out.decision !== 'stubbed')) return r

    const rec = out.record
    const engine = rec.engine!
    try {
      await $.state.set({ plugin: 'slim', key: 'rows', id: e.tool_use_id }, { engine, bytesIn: rec.bytes_in, bytesOut: rec.bytes_out })
    } catch {}

    const isSub = e.agentId !== undefined
    const listed = isSub ? await agentType($, e.agentId!) : undefined
    const type = isSub ? (listed ?? 'agent') : undefined
    const decision = out.decision as 'compressed' | 'stubbed'
    const text = eventText(agentPrefix(listed, isSub), e.tool, decision, engine, rec.bytes_in, rec.bytes_out)
    if (!isSub && (await $.env.get('SLIM_TOAST')) !== '0') {
      $.ui.toast(text, { timeoutMs: toastMs(await $.env.get('SLIM_TOAST_MS')) })
    }
    if ((await $.env.get('SLIM_EVENT_LOG')) !== '0') {
      try {
        const atMs = await $.clock.now()
        const ev: SlimEvent = {
          v: 1, atMs, kind: 'slim', text, src: 'slim', tool: e.tool,
          ...(type ? { agentType: type } : {}),
          bytesIn: rec.bytes_in, bytesOut: rec.bytes_out, engine, ms: rec.ms,
        }
        await update($, EVENTS, l => pushEvent(l, ev))
      } catch {}
    }
    // A fresh object: returning `r` itself would make core reuse its own messages verbatim.
    return r.context?.length ? { result: out.result, context: r.context } : { result: out.result }
  })
}
