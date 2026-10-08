// Points the model at lookup where it would otherwise pull a whole page or output into context, and
// keeps lookup's and view's schemas in the prompt's list so they are called without a ToolSearch first.
import type { On } from 'claude-code'

// Constant on purpose: the describe answer is cached per session and any change spends the prompt cache.
export const NOTE =
  "\n\nFor one fact about a page or a command's output, call mcp__slim__lookup({ url | command | path, question }) — " +
  'it returns a short answer instead of the whole output.'

export function registerDescribe(on: On): void {
  on('tool.describe', { tool: /^(?:Bash|WebFetch)$/ }, async ($, e, next) => {
    if ((await $.env.get('SLIM_LOOKUP')) === '0') return next(e)
    const d = await next(e)
    return { ...d, description: d.description + NOTE }
  })

  on('tool.describe', { tool: 'mcp__slim__lookup' }, async ($, e, next) => {
    if ((await $.env.get('SLIM_LOOKUP')) === '0') return next(e)
    return { ...(await next(e)), isDeferred: false }
  })

  on('tool.describe', { tool: 'mcp__slim__view' }, async (_$, e, next) => ({ ...(await next(e)), isDeferred: false }))
}
