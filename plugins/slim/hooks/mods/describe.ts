// Keeps lookup's schema in the prompt's tool list, so it is called without a ToolSearch first. view stays
// deferred: every pointer to it (a stub, the guard's deny, view's own out line) names it.
import type { On } from 'claude-code'

export function registerDescribe(on: On): void {
  on('tool.describe', { tool: 'mcp__slim__lookup' }, async ($, e, next) => {
    if ((await $.env.get('SLIM_LOOKUP')) === '0') return next(e)
    return { ...(await next(e)), isDeferred: false }
  })
}
