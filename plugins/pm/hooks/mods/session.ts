// pm's session: the start line, the base check, and the root line — a system-prompt section for the main
// session, added context for subagents.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PromptComposeSection } from 'claude-code'
import type { PmEvent, PmEventKind } from '../../types'
import { NO_PM_AGENT, rootLine } from './conventions/text.ts'
import { logLine, pushEvent } from './events.ts'
import type { Disk } from './events.ts'

export const BASE_MISSING = 'needs the base plugin — claude plugin install base@domaine'

const events = atom({ plugin: 'pm', key: 'events' } as const, [] as PmEvent[])
const started = atom({ plugin: 'pm', key: 'started' } as const, null)

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

async function logEvent($: $, kind: PmEventKind, text: string): Promise<void> {
  try {
    if ((await $.env.get('PM_EVENT_LOG')) === '0') return
    const ev: PmEvent = { atMs: await $.clock.now(), kind, text }
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

/** The one section, `pm:root`: fixed per plugin root, so a render repeats it byte for byte (the prompt cache). */
export function sections($: $): PromptComposeSection[] {
  return [{ id: 'pm:root', text: rootLine($.plugin.root), scope: 'session' }]
}

/** null for base's readers and writer and Claude Code's helpers; the root line for every other agent. */
export function subagentContext($: $, agentType: string): string | null {
  return NO_PM_AGENT.test(agentType) ? null : rootLine($.plugin.root)
}

export function registerSession(on: On): void {
  // The engine allows one unmatched hook per event per plugin; this matcher takes every session.
  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    try {
      const sid = String(await $.session.id())
      if ((await read($, started)) !== sid) {
        await update($, started, () => sid)
        await logEvent($, 'start', `pm ${await version($)}`)
        if (!(await baseLoaded($))) {
          await logEvent($, 'install', BASE_MISSING)
          $.ui.toast(`pm: ${BASE_MISSING}`)
        }
      }
    } catch {}
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    let ours: PromptComposeSection[] = []
    try {
      ours = sections($)
    } catch {}
    const taken = new Set(r.sections.map(s => s.id))
    return { sections: [...r.sections, ...ours.filter(s => !taken.has(s.id))] }
  })

  on('classic.SubagentStart', async ($, e, next) => {
    const r = await next(e)
    let ctx: string | null = null
    try {
      ctx = subagentContext($, e.agent_type ?? '')
    } catch {}
    return ctx ? { ...r, additionalContext: [...(r.additionalContext ?? []), ctx] } : r
  })
}
