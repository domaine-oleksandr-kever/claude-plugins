// MCP result slimming as a mod: host-stub replacement and the savings toast (FND_SLIM_TOAST=0 silences it).
import type { On } from 'claude-code'
import { buildHookRun, omit, parseHookOut, slimFigureIn, stubBytes, stubText } from './node-hook.ts'

const TOAST_MS = 10_000 // the savings figure; a click takes it off, the pointer over it holds it

export function registerSlim(on: On): void {
  on('tool.call', { tool: /^mcp__/ }, async ($, e, next) => {
    // Never race next: returning while it is pending aborts what runs beneath.
    const r = await next(e)
    if (r.deny !== undefined || (await $.env.get('FND_MCP_SLIM')) === '0') return r
    const isMain = e.agentId === undefined

    const stub = stubText(r.result)
    if (!stub) {
      // The classic hook already slimmed it beneath us: only the figure is left to show.
      if (!isMain) return r
      const limit = stubBytes(await $.env.get('FND_MCP_SLIM_STUB_BYTES'))
      const figure = slimFigureIn(r.result, limit, r.text)
      if (figure && (await $.env.get('FND_SLIM_TOAST')) !== '0') $.ui.toast(figure, { timeoutMs: TOAST_MS })
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
    if (isMain && typeof out?.systemMessage === 'string' && out.systemMessage && (await $.env.get('FND_SLIM_TOAST')) !== '0') {
      $.ui.toast(out.systemMessage, { timeoutMs: TOAST_MS })
    }
    // A fresh object: returning `r` itself would make core reuse its own messages verbatim.
    return r.context?.length ? { result, context: r.context } : { result }
  })
}
