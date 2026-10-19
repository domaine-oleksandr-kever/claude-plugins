// qa's session: the start line and the base check. The conventions travel as command hooks
// (hooks/conventions.cjs); this mod is the cloud fallback only: in a session no surface draws and whose
// SessionStart hook left no marker, they ride the first user message as a block.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { QaEvent, QaEventKind } from '../../types'
import { logDir, spareRoot, logLine, pushEvent } from './events.ts'
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

/** Where the SessionStart command hook leaves its marker: `<log dir>/<session>/conventions.qa.json`, else under the spare root. */
export const markerPaths = (home: string | undefined, override: string | undefined, tmp: string | undefined, sid: string): string[] =>
  [logDir(home, override, sid), logDir(undefined, spareRoot(tmp), sid)].flatMap(d => (d ? [`${d}/conventions.qa.json`] : []))

/** The sections as one context block where nothing draws and no command hook delivered them; else null. */
export async function contextBlock($: $): Promise<string | null> {
  if ((await $.session.surfaces()).length > 0) return null
  for (const m of markerPaths(await $.env.get('HOME'), await $.env.get('DOMAINE_LOG_DIR'), await $.env.get('TMPDIR'), String(await $.session.id()))) {
    if (await $.fs.exists(m)) return null
  }
  const t = JSON.parse(await $.fs.read(`${$.plugin.root}/hooks/conventions-text.json`)) as Record<string, string>
  return [(t.root ?? '').split('<root>').join($.plugin.root), t.passwords ?? ''].join('\n\n')
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

  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    const text = await contextBlock($).catch(() => null)
    return text ? { ...r, blocks: [...r.blocks, { name: 'qaConventions', text }] } : r
  })
}
