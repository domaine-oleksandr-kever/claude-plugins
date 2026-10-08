// base's install state: the start line, the slim and fnd checks at a session's first prompt, and the refusal
// of the readers while slim's view tool is missing.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { BaseEvent, BaseEventKind } from '../../types'
import { logLine, pushEvent } from './events.ts'
import type { Disk } from './events.ts'

export const SLIM_VIEW = 'mcp__slim__view'
const SLIM_INSTALL = 'claude plugin install slim@domaine'
export const SLIM_MISSING = `slim is not loaded — ${SLIM_INSTALL}`
export const WITH_FND = 'fnd and base must not run together — uninstall fnd (claude plugin uninstall fnd@domaine)'
/** The agents that read through slim's view tool; the writer and the reviewers do not need it. */
const READER = /^base:(jira|figma|doc)-reader$/

const events = atom({ plugin: 'base', key: 'events' } as const, [] as BaseEvent[])
const started = atom({ plugin: 'base', key: 'started' } as const, null)
const checked = atom({ plugin: 'base', key: 'checked' } as const, null)

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

async function logEvent($: $, kind: BaseEventKind, text: string): Promise<void> {
  try {
    if ((await $.env.get('BASE_EVENT_LOG')) === '0') return
    const ev: BaseEvent = { atMs: await $.clock.now(), kind, text }
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

/** slim registers its view tool at its own session.start, so the list answers from the first prompt on. */
async function slimLoaded($: $): Promise<boolean> {
  return (await $.tool.list()).some(t => t.name === SLIM_VIEW)
}

/** Enabled in the merged settings, or loaded now (a `--plugin-dir` load has no settings key). */
async function fndLoaded($: $): Promise<boolean> {
  try {
    const enabled = (await $.settings.read()).enabledPlugins
    if (enabled && typeof enabled === 'object' && Object.entries(enabled).some(([k, v]) => k.startsWith('fnd@') && v === true)) return true
  } catch {}
  try {
    return (await $.command.list()).some(c => c.plugin === 'fnd')
  } catch {
    return false
  }
}

/** The deny reason for a reader spawned while slim is missing, else null; a failed tool listing lets it run. */
async function refusal($: $, type: string): Promise<string | null> {
  if (!READER.test(type) || (await slimLoaded($).catch(() => true))) return null
  const name = type.slice(type.indexOf(':') + 1)
  await logEvent($, 'refuse', `${name}: slim is not loaded`)
  return `base: ${name} needs the slim plugin — ${SLIM_INSTALL}`
}

export function registerSession(on: On): void {
  // The engine allows one unmatched hook per event per plugin; this matcher takes every session.
  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    try {
      const sid = String(await $.session.id())
      if ((await read($, started)) !== sid) {
        await update($, started, () => sid)
        await logEvent($, 'start', `base ${await version($)}`)
      }
    } catch {}
    return next(e)
  })

  on('prompt.submit', { text: /^/ }, async ($, e, next) => {
    const r = await next(e)
    try {
      const sid = String(await $.session.id())
      if ((await read($, checked)) === sid) return r
      await update($, checked, () => sid)
      if (!(await slimLoaded($))) {
        await logEvent($, 'install', SLIM_MISSING)
        $.ui.toast(`base: ${SLIM_MISSING}`)
      }
      if (await fndLoaded($)) {
        await logEvent($, 'install', WITH_FND)
        $.ui.toast(`base: ${WITH_FND}`)
      }
    } catch {}
    return r
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.tool !== 'Agent') return next(e)
    const deny = await refusal($, e.subagent_type ?? '')
    return deny ? { deny } : next(e)
  })

  // The resolved type: a bare name the Agent tool resolved, or another plugin's $.agent.spawn.
  on('agent.spawn', { subagentType: READER }, async ($, e, next) => {
    const deny = await refusal($, e.subagentType)
    return deny ? { deny } : next(e)
  })
}
