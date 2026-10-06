// MCP result slimming as a mod: host-stub replacement and the savings toast (FND_SLIM_TOAST=0 silences it,
// FND_SLIM_TOAST_MS sets how long it stays).
import { atom, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { FndEvent, FndEventKind } from '../../../types'
import { bare, pushEvent, toolName } from '../core/events.ts'
import { buildHookRun, omit, parseHookOut, slimFigureIn, stubBytes, stubText, toastMs } from './node-hook.ts'

const events = atom({ plugin: 'fnd', key: 'events' } as const, [] as FndEvent[])

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

export function registerSlim(on: On): void {
  on('tool.call', { tool: /^mcp__/ }, async ($, e, next) => {
    // Never race next: returning while it is pending aborts what runs beneath.
    const r = await next(e)
    if (r.deny !== undefined || (await $.env.get('FND_MCP_SLIM')) === '0') return r
    const isMain = e.agentId === undefined

    const stub = stubText(r.result)
    if (!stub) {
      // The classic hook already slimmed it beneath us: only the figure is left to show.
      const limit = stubBytes(await $.env.get('FND_MCP_SLIM_STUB_BYTES'))
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
