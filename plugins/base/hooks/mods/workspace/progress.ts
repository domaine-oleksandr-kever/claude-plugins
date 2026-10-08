// Progress: the work-id resolver, the digest refresh and /base-progress (the pin). Writes the base.progress
// atom band draws its checklist from; base draws nothing itself.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { BaseEvent, BaseProgress } from '../../../types'
import { pushEvent } from '../events.ts'
import { notesTail, parseProgress } from './progress-parse.ts'
import { KEY, isWorkId, keyFromBranch, projectOf, slugFromBranch, ticketKeys } from './workid.ts'

export const COMMAND = {
  name: 'base-progress',
  description: 'Pin the task base publishes for the checklist (<work-id>, or - to unpin)',
  argumentHint: '[work-id|-]',
  immediate: true,
} as const
const CHECKLIST = '/band-progress'
const TICK_MS = 30_000
const RESOLVE_EVERY = 4
const FRESH_MS = 12 * 60 * 60_000
const CHECKOUT = /\bgit\s+(checkout|switch|worktree)\b/
/** Prompt origins a person wrote; notifications, peers and schedules never set the conversation key. */
const PERSON = new Set(['composer', 'bridge', 'sdk'])

const progress = atom({ plugin: 'base', key: 'progress' } as const, null)
const pin = atom({ plugin: 'base', key: 'pin' } as const, null)
const lastKey = atom({ plugin: 'base', key: 'lastKey' } as const, null)
const sessionId = atom({ plugin: 'base', key: 'sessionId' } as const, null)
const events = atom({ plugin: 'base', key: 'events' } as const, [] as BaseEvent[])

type $ = EngineInterface

/** Compared with the last logged workspace, not the atom: /clear nulls the atom while the work stays. */
async function logWorkspace($: $, text: string): Promise<void> {
  try {
    if ((await $.env.get('BASE_EVENT_LOG')) === '0') return
    const atMs = await $.clock.now()
    await update($, events, l => {
      let last = 'none'
      for (const ev of l) if (ev.kind === 'workspace') last = ev.text
      return last === text ? l : pushEvent(l, { atMs, kind: 'workspace', text })
    })
  } catch {}
}

const tasksDir = (root: string) => `${root}/.claude/tasks`
const workDir = (root: string, id: string) => `${tasksDir(root)}/${id}`

async function branchOf($: $, root: string): Promise<string | null> {
  try {
    const r = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.trim() || null : null
  } catch {
    return null
  }
}

/** The workspace directory itself: a ticket dir without progress.md still names the work. */
async function hasWorkspace($: $, root: string, id: string | null): Promise<boolean> {
  if (!id) return false
  try {
    return (await $.fs.stat(workDir(root, id))).kind === 'dir'
  } catch {
    return false
  }
}

async function newestWorkspace($: $, root: string): Promise<string | null> {
  let dirs
  try {
    dirs = (await $.fs.list(tasksDir(root))).filter(d => d.kind === 'dir' && isWorkId(d.name))
  } catch {
    return null
  }
  const now = await $.clock.now()
  let best: string | null = null
  let bestMs = 0
  for (const d of dirs) {
    try {
      const s = await $.fs.stat(`${workDir(root, d.name)}/progress.md`)
      if (s.kind === 'file' && now - s.mtimeMs <= FRESH_MS && s.mtimeMs > bestMs) {
        best = d.name
        bestMs = s.mtimeMs
      }
    } catch {}
  }
  return best
}

type Inputs = { pin: string | null; lastKey: string | null }

const readInputs = async ($: $): Promise<Inputs> => ({ pin: await read($, pin), lastKey: await read($, lastKey) })

/** The projects of the `.claude/tasks/<KEY>` dirs: what corroborates a bare key in a prompt. */
async function knownProjects($: $, root: string): Promise<Set<string>> {
  const out = new Set<string>()
  try {
    for (const d of await $.fs.list(tasksDir(root))) {
      const project = d.kind === 'dir' ? projectOf(d.name) : null
      if (project) out.add(project)
    }
  } catch {}
  return out
}

/**
 * pin (an existing dir) → conversation key, workspace or not: the ticket the developer named is the task →
 * branch key → branch slug (existing dirs) → newest progress.md within 12 h → null.
 */
async function resolveWorkId($: $, root: string, branch: string | null, inputs: Inputs): Promise<string | null> {
  if (await hasWorkspace($, root, inputs.pin)) return inputs.pin
  if (inputs.lastKey) return inputs.lastKey
  for (const id of [keyFromBranch(branch), slugFromBranch(branch)]) if (await hasWorkspace($, root, id)) return id
  return newestWorkspace($, root)
}

/** The most recent ticket the prompt names (`ticketKeys`), else null: the held key stays. */
async function conversationKey($: $, text: string): Promise<string | null> {
  if (!KEY.test(text)) return null
  const keys = ticketKeys(text, await knownProjects($, await $.session.root()))
  return keys[0] ?? null
}

async function readText($: $, path: string): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

async function mtimeOf($: $, path: string): Promise<number> {
  try {
    return (await $.fs.stat(path)).mtimeMs
  } catch {
    return 0
  }
}

/** Newest mtime of the workspace's progress.md and notes.md: what the tick compares. */
async function workspaceMtime($: $, root: string, id: string): Promise<number> {
  const dir = workDir(root, id)
  return Math.max(await mtimeOf($, `${dir}/progress.md`), await mtimeOf($, `${dir}/notes.md`))
}

async function load($: $, root: string, workId: string, branch: string | null): Promise<BaseProgress> {
  const dir = workDir(root, workId)
  const workspace = await hasWorkspace($, root, workId)
  const mtimeMs = await workspaceMtime($, root, workId)
  const parsed = parseProgress(await readText($, `${dir}/progress.md`))
  const notes = notesTail(await readText($, `${dir}/notes.md`))
  return { workId, branch, hasWorkspace: workspace, ...parsed, notesTail: notes, mtimeMs }
}

/** `resolve` re-runs git and the resolver; otherwise only the current workspace is re-read while it exists. */
async function refresh($: $, resolve: boolean): Promise<void> {
  const root = await $.session.root()
  const cur = await read($, progress)
  const inputs = await readInputs($)
  const reload = !resolve && !!cur?.workId && (await hasWorkspace($, root, cur.workId))
  let next: BaseProgress
  if (reload && cur?.workId) {
    next = await load($, root, cur.workId, cur.branch)
  } else {
    const branch = await branchOf($, root)
    const id = await resolveWorkId($, root, branch, inputs)
    next = id ? await load($, root, id, branch) : { workId: null, branch }
  }
  // A pin or key change (or /clear) during the awaits started its own, newer resolve.
  const now = await readInputs($)
  if (now.pin !== inputs.pin || now.lastKey !== inputs.lastKey) return
  const after = await update($, progress, prev => (!reload || prev?.workId === next.workId ? next : prev))
  await logWorkspace($, after?.workId ?? 'none')
}

async function tick($: $, resolve: boolean): Promise<void> {
  const cur = await read($, progress)
  if (resolve || cur === null) return refresh($, true)
  if (cur.workId === null) return
  const mtimeMs = await workspaceMtime($, await $.session.root(), cur.workId)
  if (mtimeMs !== cur.mtimeMs) await refresh($, false)
}

export function registerProgress(on: On): void {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    let ticks = 0
    $.clock.every(TICK_MS, () => {
      ticks++
      void tick($, ticks % RESOLVE_EVERY === 0).catch(() => undefined)
    })
    try {
      const id = await $.session.id()
      await update($, sessionId, () => id)
    } catch {}
    await $.command.register(COMMAND).catch(() => undefined)
    await refresh($, true).catch(() => undefined)
    return r
  })

  // A /clear starts a new session id with no session.start: the command and the resolve follow it here.
  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    let resolve = false
    const id = await $.session.id()
    if (id !== (await read($, sessionId))) {
      await update($, sessionId, () => id)
      await $.command.register(COMMAND).catch(() => undefined)
      resolve = true
    }
    const key = PERSON.has(e.origin.kind) ? await conversationKey($, e.text) : null
    if (key && key !== (await read($, lastKey))) {
      await update($, lastKey, () => key)
      resolve = true
    }
    if (resolve) await refresh($, true)
    return r
  })

  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    await update($, progress, () => null)
    await update($, lastKey, () => null)
    return next(e)
  })

  on('tool.call', { tool: /^(Write|Edit)$/ }, async ($, e, next) => {
    const r = await next(e)
    if (e.tool !== 'Write' && e.tool !== 'Edit') return r
    const root = await $.session.root()
    if (!e.file_path.startsWith(`${tasksDir(root)}/`)) return r
    const cur = await read($, progress)
    const inCurrent = !!cur?.workId && e.file_path.startsWith(`${workDir(root, cur.workId)}/`)
    await refresh($, !inCurrent)
    return r
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    if (e.tool === 'Bash' && CHECKOUT.test(e.command)) await refresh($, true)
    return r
  })

  on('classic.CwdChanged', async ($, e, next) => {
    const r = await next(e)
    await refresh($, true)
    return r
  })

  on('command.run', { command: COMMAND.name }, async ($, e) => {
    const arg = e.args.trim()
    if (!arg) return { text: `Pinned: ${(await read($, pin)) ?? 'none'}. The checklist is band's: ${CHECKLIST}` }
    if (arg !== '-' && !isWorkId(arg)) return { text: `Not a work id: ${arg}` }
    await update($, pin, () => (arg === '-' ? null : arg))
    await refresh($, true)
    if (arg === '-') return { text: `Unpinned. ${CHECKLIST} shows the checklist.` }
    const cur = await read($, progress)
    const text = `Pinned ${arg}. ${CHECKLIST} shows it.`
    return { text: cur?.workId === arg ? text : `${text} ${arg} has no task workspace.` }
  })
}
