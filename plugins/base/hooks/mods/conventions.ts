// base's conventions: system-prompt sections for the main session, added context for every subagent.
// The engine has no event for a subagent's system prompt, so its share rides classic SubagentStart.
import type { EngineInterface, On, PromptComposeSection } from 'claude-code'
import {
  COMMENT_DISCIPLINE,
  LEAN_CODE,
  NO_CODE_AGENT,
  TASK_WORKSPACE,
  UNTRUSTED_CONTENT,
  WRITING_STYLE,
  rootLine,
  withRoot,
} from './conventions/text.ts'

type $ = EngineInterface

/**
 * The sections in session order, each `base:<name>`: the switches are read on every render, and the
 * text depends on nothing else, so a render repeats the last one byte for byte (the prompt cache).
 */
export async function sections($: $): Promise<PromptComposeSection[]> {
  const root = $.plugin.root
  const lean = (await $.env.get('BASE_LEAN')) !== '0'
  const ste = (await $.env.get('BASE_STE')) !== '0'
  const parts: [string, string][] = [
    ['root', rootLine(root)],
    ['comment-discipline', COMMENT_DISCIPLINE],
    ['task-workspace', withRoot(TASK_WORKSPACE, root)],
    ['untrusted-content', UNTRUSTED_CONTENT],
  ]
  if (lean) parts.push(['lean-code', LEAN_CODE])
  if (ste) parts.push(['writing-style', WRITING_STYLE])
  return parts.map(([name, text]) => ({ id: `base:${name}`, text, scope: 'session' }))
}

/**
 * The root line and the untrusted-content rail for every agent; the code conventions for one that writes code.
 * Empty for a fork: it inherits the parent's system prompt, which already carries base's sections.
 */
export async function subagentContext($: $, agentType: string): Promise<string> {
  if (agentType === 'fork') return ''
  const parts = [rootLine($.plugin.root), UNTRUSTED_CONTENT]
  if (!NO_CODE_AGENT.test(agentType)) {
    parts.push(COMMENT_DISCIPLINE)
    if ((await $.env.get('BASE_LEAN')) !== '0') parts.push(LEAN_CODE)
  }
  return parts.join('\n\n')
}

export function registerConventions(on: On): void {
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const ours = await sections($).catch(() => [])
    const taken = new Set(r.sections.map(s => s.id))
    return { sections: [...r.sections, ...ours.filter(s => !taken.has(s.id))] }
  })

  on('classic.SubagentStart', async ($, e, next) => {
    const r = await next(e)
    const ctx = await subagentContext($, e.agent_type ?? '').catch(() => null)
    return ctx ? { ...r, additionalContext: [...(r.additionalContext ?? []), ctx] } : r
  })
}
