// base's conventions: system-prompt sections for the main session, added context for every subagent.
// The engine has no event for a subagent's system prompt, so its share rides classic SubagentStart. A session
// no surface draws (a cloud session, `claude -p`) gets its prompt composed without the plugins and no classic
// SessionStart: there the sections go in as a prompt.context block of the first user message, and
// prompt.compose adds nothing.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PromptComposeSection } from 'claude-code'
import type { BaseDelivery } from '../../types'
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

/** How many system prompts the engine composed through base's hook this session: 0 = the conventions never reached the model (doctor.ts reads it). */
const composed = atom({ plugin: 'base', key: 'composed' } as const, 0)
/** The session id whose first user message carries the conventions as a context block (doctor.ts reads it): prompt.compose then adds nothing. */
const injected = atom({ plugin: 'base', key: 'injected' } as const, null as string | null)
/** What the prompt events did this session, for the doctor: which of them a host fires decides how the conventions travel. */
const delivery = atom({ plugin: 'base', key: 'delivery' } as const, { sid: null, startSurfaces: null, prompts: 0, context: false } as BaseDelivery)

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

/** The sections as one context block for a session no surface draws; null where one does (the system prompt carries them). */
export async function contextBlock($: $): Promise<string | null> {
  if ((await $.session.surfaces()).length > 0) return null
  return (await sections($)).map(s => s.text).join('\n\n')
}

export function registerConventions(on: On): void {
  // Matched apart from title.ts's hook: one unmatched hook per event per plugin.
  on('classic.SessionStart', { source: /^/ }, async ($, e, next) => {
    const r = await next(e)
    const sid = String(await $.session.id())
    const seen = await $.session.surfaces().catch(() => null)
    await update($, delivery, d => ({ ...(d.sid === sid ? d : { sid, prompts: 0, context: false }), sid, startSurfaces: seen ? [...seen] : null })).catch(() => {})
    return r
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    await update($, composed, n => n + 1).catch(() => {})
    if ((await read($, injected).catch(() => null)) === String(await $.session.id())) return r
    const ours = await sections($).catch(() => [])
    const taken = new Set(r.sections.map(s => s.id))
    return { sections: [...r.sections, ...ours.filter(s => !taken.has(s.id))] }
  })

  // Matched apart from title.ts's hook. Counts the prompts a host hands the classic hook.
  on('classic.UserPromptSubmit', { prompt: /^/ }, async ($, e, next) => {
    const r = await next(e)
    const sid = String(await $.session.id())
    await update($, delivery, d => ({ ...(d.sid === sid ? d : { sid, startSurfaces: null, context: false }), sid, prompts: (d.sid === sid ? d.prompts : 0) + 1 })).catch(() => {})
    return r
  })

  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    const sid = String(await $.session.id())
    await update($, delivery, d => ({ ...(d.sid === sid ? d : { sid, startSurfaces: null, prompts: 0 }), sid, context: true })).catch(() => {})
    const text = await contextBlock($).catch(() => null)
    if (text === null) return r
    await update($, injected, () => sid).catch(() => {})
    return { ...r, blocks: [...r.blocks, { name: 'baseConventions', text }] }
  })

  on('classic.SubagentStart', async ($, e, next) => {
    const r = await next(e)
    const ctx = await subagentContext($, e.agent_type ?? '').catch(() => null)
    return ctx ? { ...r, additionalContext: [...(r.additionalContext ?? []), ctx] } : r
  })
}
