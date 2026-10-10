// Session title `<KEY> — <summary>`: from a corroborated branch key at session start, else from the first person prompt
// that names a corroborated ticket. One shot per session; a title the person set (at start or by /rename) is kept.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { BaseEvent } from '../../types'
import { logLine, pushEvent } from './events.ts'
import type { Disk } from './events.ts'
import { KEY, keyFromBranch, projectOf, projectsOf, ticketKeys } from './workspace/workid.ts'

/** Bytes, not characters: a Cyrillic summary costs two per character in the hook envelope. */
const TITLE_MAX_BYTES = 100
/** UserPromptSubmit sources a person wrote; an absent source is a person's prompt on a host that predates it. */
const PERSON = new Set(['user', 'sdk'])

const titled = atom({ plugin: 'base', key: 'titled' } as const, null)
const events = atom({ plugin: 'base', key: 'events' } as const, [] as BaseEvent[])

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

/**
 * The summary from the ticket reader's `# <KEY> — <summary>` heading (its separator has been `—`, `:` and
 * `-`), then `<KEY> — <summary>` or the key alone, cut on a character boundary at 100 UTF-8 bytes.
 */
export function titleText(key: string, ticketMd: string): string {
  let summary: string | null = null
  for (const line of ticketMd.split('\n')) {
    if (line.startsWith(`# ${key}`) && !/[0-9]/.test(line.charAt(key.length + 2))) {
      summary = line.slice(key.length + 2).replace(/^[\s–—:|-]+/, '').trim() || null
      break
    }
  }
  const full = summary ? `${key} — ${summary}` : key
  let bytes = 0
  let out = ''
  for (const ch of full) {
    const cp = ch.codePointAt(0) ?? 0
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    if (bytes > TITLE_MAX_BYTES) return out.trim()
    out += ch
  }
  return out
}

async function logTitle($: $, text: string): Promise<void> {
  try {
    if ((await $.env.get('BASE_EVENT_LOG')) === '0') return
    const ev: BaseEvent = { atMs: await $.clock.now(), kind: 'title', text }
    await update($, events, l => pushEvent(l, ev))
    await logLine(diskOf($), ev)
  } catch {}
}

async function branchOf($: $, root: string): Promise<string | null> {
  try {
    const r = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.trim() || null : null
  } catch {
    return null
  }
}

async function taskDirs($: $, root: string): Promise<Set<string>> {
  try {
    return new Set((await $.fs.list(`${root}/.claude/tasks`)).filter(d => d.kind === 'dir').map(d => d.name))
  } catch {
    return new Set()
  }
}

/** Off by the switch, or this session's one shot already spent (`<id>` titled by base, `<id>:user` by the person). */
async function spent($: $, sid: string): Promise<boolean> {
  if (!sid || (await $.env.get('BASE_SESSION_TITLE')) === '0') return true
  const t = await read($, titled)
  return t === sid || t === `${sid}:user`
}

async function settle($: $, sid: string, root: string, key: string): Promise<string> {
  let md = ''
  try {
    md = await $.fs.read(`${root}/.claude/tasks/${key}/ticket.md`)
  } catch {}
  const title = titleText(key, md)
  await update($, titled, () => sid)
  await logTitle($, title)
  return title
}

async function startTitle($: $, sid: string, sessionTitle: string | undefined): Promise<string | null> {
  if (await spent($, sid)) return null
  if (sessionTitle?.trim()) {
    await update($, titled, () => `${sid}:user`)
    return null
  }
  const root = await $.session.root()
  const key = keyFromBranch(await branchOf($, root))
  if (!key) return null
  // key shape alone is no evidence: `fix/UTF-8-encoding` names no ticket
  const dirs = await taskDirs($, root)
  return dirs.has(key) || projectsOf(dirs).has(projectOf(key) ?? '') ? settle($, sid, root, key) : null
}

/**
 * The most recent ticket the prompt names, as the workspace resolver picks. `sessionTitle` carries only a set
 * title (never the host's generated one), and base has set none yet, so a non-empty one is the person's.
 */
async function promptTitle($: $, sid: string, prompt: string, source: string | undefined, sessionTitle: string | undefined): Promise<string | null> {
  if (await spent($, sid)) return null
  if (sessionTitle?.trim()) {
    await update($, titled, () => `${sid}:user`)
    return null
  }
  if ((source !== undefined && !PERSON.has(source)) || !KEY.test(prompt)) return null
  const root = await $.session.root()
  const key = ticketKeys(prompt, projectsOf(await taskDirs($, root)))[0]
  return key ? settle($, sid, root, key) : null
}

export function registerTitle(on: On): void {
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    const title = await startTitle($, e.session_id, e.session_title).catch(() => null)
    return title ? { ...r, sessionTitle: title } : r
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const r = await next(e)
    const title = await promptTitle($, e.session_id, e.prompt, e.source, e.session_title).catch(() => null)
    return title ? { ...r, sessionTitle: title } : r
  })
}
