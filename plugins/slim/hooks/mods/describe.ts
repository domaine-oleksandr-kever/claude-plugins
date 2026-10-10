// Keeps lookup's schema in the prompt's tool list (registration also passes isDeferred: false; engines before 2.1.293 ignore
// that field, so this hook is the one that holds everywhere). view stays deferred: every pointer to it names it.
import type { On } from 'claude-code'

export function registerDescribe(on: On): void {
  on('tool.describe', { tool: 'mcp__slim__lookup' }, async ($, e, next) => {
    if ((await $.env.get('SLIM_LOOKUP')) === '0') return next(e)
    return { ...(await next(e)), isDeferred: false }
  })
}
