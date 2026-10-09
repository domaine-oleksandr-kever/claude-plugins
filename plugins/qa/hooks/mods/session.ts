// qa's session: the start line, the base check and the conventions — system-prompt sections for the main
// session, added context for subagents.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PromptComposeSection } from 'claude-code'
import type { QaEvent, QaEventKind } from '../../types'
import { BASE_AGENT, NO_QA_AGENT, STORE_ACCESS, rootLine } from './conventions/text.ts'
import { logLine, pushEvent } from './events.ts'
import type { Disk } from './events.ts'

export const BASE_MISSING = 'needs the base plugin — claude plugin install base@domaine'

const events = atom({ plugin: 'qa', key: 'events' } as const, [] as QaEvent[])
const started = atom({ plugin: 'qa', key: 'started' } as const, null)

type $ = EngineInterface

/** events.ts's file writer reaches `$` through this: the validator follows `$` only within one file. */
function diskOf($: $): Disk {
  return {
    session: () => $.session.id(),
    home: () => $.env.get('HOME'),
    override: () => $.env.get('DOMAINE_LOG_DIR'),
    manifest: () => $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    toast: text => $.ui.toast(text),
  }
}

async function logEvent($: $, kind: QaEventKind, text: string): Promise<void> {
  try {
    if ((await $.env.get('QA_EVENT_LOG')) === '0') return
    const ev: QaEvent = { atMs: await $.clock.now(), kind, text }
    await update($, events, l => pushEvent(l, ev))
    await logLine(diskOf($), ev)
  } catch {}
}

async function version($: $): Promise<string> {
  try {
    const v = (JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }).version
    return typeof v === 'string' && v ? v : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** base's skills carry `plugin: 'base'` in the command list from its manifest on; a list that fails says nothing. */
async function baseLoaded($: $): Promise<boolean> {
  try {
    return (await $.command.list()).some(c => c.plugin === 'base')
  } catch {
    return true
  }
}

/** The sections, each `qa:<name>`: fixed text, so every render repeats the last one byte for byte (the prompt cache). */
export function sections(root: string): PromptComposeSection[] {
  const parts: [string, string][] = [
    ['root', rootLine(root)],
    ['store-access', STORE_ACCESS],
  ]
  return parts.map(([name, text]) => ({ id: `qa:${name}`, text, scope: 'session' }))
}

/** null for base's readers and writer and Claude Code's helpers; the root for base's reviewers; root and store access for the rest. */
export function subagentContext(root: string, agentType: string): string | null {
  if (NO_QA_AGENT.test(agentType)) return null
  return BASE_AGENT.test(agentType) ? rootLine(root) : `${rootLine(root)}\n\n${STORE_ACCESS}`
}

export function registerSession(on: On): void {
  // The engine allows one unmatched hook per event per plugin; this matcher takes every session.
  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    try {
      const sid = String(await $.session.id())
      if ((await read($, started)) !== sid) {
        await update($, started, () => sid)
        await logEvent($, 'start', `qa ${await version($)}`)
        if (!(await baseLoaded($))) {
          await logEvent($, 'install', BASE_MISSING)
          $.ui.toast(`qa: ${BASE_MISSING}`)
        }
      }
    } catch {}
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const taken = new Set(r.sections.map(s => s.id))
    return { sections: [...r.sections, ...sections($.plugin.root).filter(s => !taken.has(s.id))] }
  })

  on('classic.SubagentStart', async ($, e, next) => {
    const r = await next(e)
    const ctx = subagentContext($.plugin.root, e.agent_type ?? '')
    return ctx ? { ...r, additionalContext: [...(r.additionalContext ?? []), ctx] } : r
  })
}
