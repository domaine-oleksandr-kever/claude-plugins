// Progress: the work-id resolver, the digest refresh and /base-progress (the pin). Writes the base.progress
// atom band draws its checklist from, with the staleness autosave.ts acts on; base draws nothing itself.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, On } from 'claude-code'
import type { BaseAutosave, BaseCompactMarker, BaseEvent, BaseProgress, BaseSavable } from '../../../types'
import { logDir, logLine, pushEvent, spareRoot } from '../events.ts'
import type { Disk } from '../events.ts'
import { notesTail, parseProgress } from './progress-parse.ts'
import { KEY, isWorkId, keyFromBranch, projectsOf, slugFromBranch, ticketKeys } from './workid.ts'

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
export const STALE_MS = 20 * 60_000
/** The levers' stale window once the context window is at or above TIGHT_CTX_PCT full: an auto-compact is near. */
export const TIGHT_STALE_MS = 5 * 60_000
const TIGHT_CTX_PCT = 85
const SAVABLE_CAP = 200
/** slim's MCP gate: a result past it is one slim compresses or stubs. */
const MCP_GATE = 4096
/** slim's handle or stub: the original was over the gate even when the result now is not. */
const SLIMMED = /<<full=|<<slim stub>>/
/** Prompt origins a person wrote; notifications, peers and schedules never set the conversation key. */
export const PERSON = new Set(['composer', 'bridge', 'sdk'])

const progress = atom({ plugin: 'base', key: 'progress' } as const, null)
const pin = atom({ plugin: 'base', key: 'pin' } as const, null)
const lastKey = atom({ plugin: 'base', key: 'lastKey' } as const, null)
const sessionId = atom({ plugin: 'base', key: 'sessionId' } as const, null)
const events = atom({ plugin: 'base', key: 'events' } as const, [] as BaseEvent[])
const savable = atom({ plugin: 'base', key: 'savable' } as const, [] as BaseSavable[])
const background = atom({ plugin: 'base', key: 'background' } as const, [] as string[])
const saved = atom({ plugin: 'base', key: 'saved' } as const, [] as string[])
const marker = atom({ plugin: 'base', key: 'compactMarker' } as const, null)
const autosave = atom({ plugin: 'base', key: 'autosave' } as const, null)

/** Unsaved work: no workspace write for the stale window, and something worth saving happened after the last one. */
export const isStale = (mtimeMs: number, lastSavableMs: number, now: number, staleMs = STALE_MS): boolean =>
  now - mtimeMs > staleMs && lastSavableMs > mtimeMs

/** The levers' window from `$.session.usage().context.percent`: 5 min at or above 85 % full, else 20. */
export const staleWindowOf = (percent: number | null | undefined): number =>
  (percent ?? 0) >= TIGHT_CTX_PCT ? TIGHT_STALE_MS : STALE_MS

/** The newest write among a workspace root's files; notes.md still at the compact marker's write keeps the time before it. */
export function newestWrite(entries: readonly FsEntry[], id: string, m: BaseCompactMarker | null): number {
  let ms = 0
  for (const f of entries) {
    if (f.kind !== 'file') continue
    ms = Math.max(ms, f.name === 'notes.md' && m?.workId === id && f.mtimeMs === m.notesMs ? m.priorMs : f.mtimeMs)
  }
  return ms
}

type Loaded = Extract<BaseProgress, { workId: string }>

/** Events stamped with another work id belong to that task; unstamped ones count for any. */
function withStaleness(p: Loaded, list: readonly BaseSavable[], now: number, staleMs: number): Loaded {
  let lastSavableMs = 0
  let agentsSince = 0
  let editsSince = 0
  for (const s of list) {
    if (s.workId != null && s.workId !== p.workId) continue
    lastSavableMs = Math.max(lastSavableMs, s.atMs)
    if (s.atMs <= p.mtimeMs) continue
    if (s.kind === 'agent') agentsSince++
    else if (s.kind === 'edit') editsSince++
  }
  const stale = p.hasWorkspace && !p.guessed && isStale(p.mtimeMs, lastSavableMs, now, staleMs)
  return { ...p, lastSavableMs, agentsSince, editsSince, stale }
}

type $ = EngineInterface

const windowOf = async ($: $): Promise<number> => staleWindowOf((await $.session.usage().catch(() => null))?.context.percent)

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

/** Compared with the last logged workspace, not the atom: /clear nulls the atom while the work stays. */
async function logWorkspace($: $, text: string): Promise<void> {
  try {
    if ((await $.env.get('BASE_EVENT_LOG')) === '0') return
    const ev: BaseEvent = { atMs: await $.clock.now(), kind: 'workspace', text }
    let pushed = false
    await update($, events, l => {
      let last = 'none'
      for (const e of l) if (e.kind === 'workspace') last = e.text
      pushed = last !== text
      return pushed ? pushEvent(l, ev) : l
    })
    if (pushed) await logLine(diskOf($), ev)
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

const inputsFile = async ($: $, sid: string): Promise<string | null> => {
  const dir = logDir(await $.env.get('HOME'), await $.env.get('DOMAINE_LOG_DIR'), sid)
  return dir && `${dir}/workspace.json`
}

/** The inputs on disk under the session id: a resume or an engine restart brings the same id back with empty atoms. */
async function saveInputs($: $, sid: string): Promise<void> {
  try {
    const file = await inputsFile($, sid)
    if (file) await $.fs.write(file, JSON.stringify(await readInputs($)))
  } catch {}
}

/** With both inputs null, takes them from the file `saveInputs` wrote under this very id. */
async function restoreInputs($: $, sid: string): Promise<void> {
  try {
    const cur = await readInputs($)
    if (cur.lastKey !== null || cur.pin !== null) return
    const file = await inputsFile($, sid)
    if (!file || !(await $.fs.exists(file))) return
    const disk = JSON.parse(await $.fs.read(file)) as Partial<Record<keyof Inputs, unknown>>
    const ok = (v: unknown): v is string => typeof v === 'string' && isWorkId(v)
    if (ok(disk.lastKey)) await update($, lastKey, () => disk.lastKey as string)
    if (ok(disk.pin)) await update($, pin, () => disk.pin as string)
  } catch {}
}

/** The names of the `.claude/tasks` dirs. */
async function taskDirs($: $, root: string): Promise<Set<string>> {
  try {
    return new Set((await $.fs.list(tasksDir(root))).filter(d => d.kind === 'dir').map(d => d.name))
  } catch {
    return new Set()
  }
}

type Resolved = { id: string; guessed: boolean } | null

/**
 * pin (an existing dir) → conversation key, workspace or not: the ticket the developer named is the task →
 * branch key → branch slug (existing dirs) → newest progress.md within 12 h → null. The last three are `guessed`.
 */
async function resolveWorkId($: $, root: string, branch: string | null, inputs: Inputs): Promise<Resolved> {
  if (await hasWorkspace($, root, inputs.pin)) return { id: inputs.pin as string, guessed: false }
  if (inputs.lastKey) return { id: inputs.lastKey, guessed: false }
  for (const id of [keyFromBranch(branch), slugFromBranch(branch)]) if (await hasWorkspace($, root, id)) return { id: id as string, guessed: true }
  const id = await newestWorkspace($, root)
  return id ? { id, guessed: true } : null
}

/** The most recent ticket the prompt names (`ticketKeys`), else null: the held key stays. */
async function conversationKey($: $, text: string): Promise<string | null> {
  if (!KEY.test(text)) return null
  return ticketKeys(text, projectsOf(await taskDirs($, await $.session.root())))[0] ?? null
}

async function readText($: $, path: string): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

/** compact-marker.json's marker when it is a new one (another `notesMs` than `cur`), else null. */
export function newMarker(text: string | null, cur: BaseCompactMarker | null): BaseCompactMarker | null {
  try {
    const m = JSON.parse(text ?? '') as Partial<BaseCompactMarker>
    if (typeof m.workId !== 'string' || typeof m.notesMs !== 'number' || typeof m.priorMs !== 'number' || m.notesMs === cur?.notesMs) return null
    return { workId: m.workId, notesMs: m.notesMs, priorMs: m.priorMs }
  } catch {
    return null
  }
}

/** autosave-state.json, what the Stop and PreCompact command hooks act on: the workspace (null without one) and the turn. */
export function autosaveState(sid: string, root: string, p: BaseProgress | null, t: BaseAutosave | null): string {
  const ws = p && p.workId !== null && p.hasWorkspace ? p : null
  const state = {
    sid,
    workId: ws?.workId ?? null,
    wsDir: ws ? workDir(root, ws.workId) : null,
    stale: ws?.stale ?? false,
    mtimeMs: ws?.mtimeMs ?? 0,
    lastSavableMs: ws?.lastSavableMs ?? 0,
    agentsSince: ws?.agentsSince ?? 0,
    editsSince: ws?.editsSince ?? 0,
    turn: t?.turn ?? 0,
    startMs: t?.startMs ?? 0,
  }
  return `${JSON.stringify(state)}\n`
}

const sessionLogDir = async ($: $): Promise<string | null> =>
  logDir(await $.env.get('HOME'), await $.env.get('DOMAINE_LOG_DIR'), String(await $.session.id()))

/** A new compact-marker.json becomes base.compactMarker and re-arms the prompt line: the compacted context lost it. */
async function adoptMarker($: $): Promise<BaseCompactMarker | null> {
  const cur = await read($, marker)
  const dir = await sessionLogDir($).catch(() => null)
  const m = dir ? newMarker(await $.fs.read(`${dir}/compact-marker.json`).catch(() => null), cur) : null
  if (!m) return cur
  await update($, marker, () => m)
  await update($, autosave, t => (t ? { ...t, nudgedMs: -1 } : t))
  return m
}

let mirrors: Promise<void> = Promise.resolve()

/** Runs one autosave-state.json mirror after the one before (progress.ts and autosave.ts share the queue). */
export function queueMirror(job: () => Promise<void>): Promise<void> {
  mirrors = mirrors.then(job, job)
  return mirrors
}

/** Writes autosave-state.json when its text changed, built from the atoms after the previous mirror's write. */
const mirrorAutosave = ($: $): Promise<void> => queueMirror(() => mirrorOnce($))

async function mirrorOnce($: $): Promise<void> {
  try {
    const dir = (await $.env.get('BASE_AUTOSAVE')) === '0' ? null : await sessionLogDir($)
    if (!dir) return
    const text = autosaveState(String(await $.session.id()), await $.session.root(), await read($, progress), await read($, autosave))
    const file = `${dir}/autosave-state.json`
    if ((await $.fs.read(file).catch(() => null)) !== text) await $.fs.write(file, text)
  } catch {}
}

/** The workspace's newest write (`newestWrite`): what the tick compares. */
async function workspaceMtime($: $, root: string, id: string): Promise<number> {
  let entries: FsEntry[] = []
  try {
    entries = await $.fs.list(workDir(root, id))
  } catch {}
  return newestWrite(entries, id, await adoptMarker($))
}

async function load($: $, root: string, workId: string, branch: string | null, guessed: boolean): Promise<BaseProgress> {
  const dir = workDir(root, workId)
  const workspace = await hasWorkspace($, root, workId)
  const mtimeMs = await workspaceMtime($, root, workId)
  const parsed = parseProgress(await readText($, `${dir}/progress.md`))
  const notes = notesTail(await readText($, `${dir}/notes.md`))
  const p = { workId, branch, hasWorkspace: workspace, ...parsed, notesTail: notes, mtimeMs, lastSavableMs: 0, agentsSince: 0, editsSince: 0, stale: false, guessed }
  return withStaleness(p, await read($, savable), await $.clock.now(), await windowOf($))
}

/** A savable event re-derives the staleness fields without re-reading the workspace. */
async function noteSavable($: $, kind: BaseSavable['kind']): Promise<void> {
  const now = await $.clock.now()
  const workId = (await read($, progress))?.workId ?? null
  const list = await update($, savable, l => [...l, { atMs: now, kind, workId }].slice(-SAVABLE_CAP))
  const staleMs = await windowOf($)
  await update($, progress, p => (p && p.workId !== null ? withStaleness(p, list, now, staleMs) : p))
  await mirrorAutosave($)
}

/** An agent that wrote the workspace itself (`saved`) brings back nothing unsaved: its return or stop is no event. */
async function noteAgent($: $, id: string | undefined): Promise<void> {
  let own = false
  if (id !== undefined)
    await update($, saved, l => {
      own = l.includes(id)
      return own ? l.filter(s => s !== id) : l
    })
  if (!own) await noteSavable($, 'agent')
}

const markSaved = ($: $, id: string) => update($, saved, l => (l.includes(id) ? l : [...l, id].slice(-SAVABLE_CAP)))

/** The published workspace and its newest write, or null with no work id. */
async function currentWrite($: $): Promise<{ id: string; ms: number } | null> {
  const cur = await read($, progress)
  return cur?.workId ? { id: cur.workId, ms: await workspaceMtime($, await $.session.root(), cur.workId) } : null
}

/** A tool call that reaches into the guessed workspace (`touches` its dir or id) makes it this session's work. */
async function adopt($: $, touches: (dir: string, id: string) => boolean): Promise<void> {
  const cur = await read($, progress)
  if (!cur || cur.workId === null || !cur.guessed) return
  const root = await $.session.root()
  const list = await read($, savable)
  const now = await $.clock.now()
  const staleMs = await windowOf($)
  await update($, progress, p => (p && p.workId !== null && p.guessed && touches(workDir(root, p.workId), p.workId) ? withStaleness({ ...p, guessed: false }, list, now, staleMs) : p))
  await mirrorAutosave($)
}

// The root the last refresh resolved under: a tick that finds another (a /cd, a worktree move) resolves again.
let lastRoot = ''

/** `resolve` re-runs git and the resolver; otherwise only the current workspace is re-read while it exists. */
async function refresh($: $, resolve: boolean): Promise<void> {
  const root = await $.session.root()
  lastRoot = root
  const cur = await read($, progress)
  const inputs = await readInputs($)
  const reload = !resolve && !!cur?.workId && (await hasWorkspace($, root, cur.workId))
  let next: BaseProgress
  if (reload && cur?.workId) {
    next = await load($, root, cur.workId, cur.branch, cur.guessed)
    // a write since the last read adopts a guessed workspace: it is this session's work now
    if (next.workId !== null && next.guessed && next.mtimeMs > cur.mtimeMs) next = { ...next, guessed: false }
  } else {
    const branch = await branchOf($, root)
    const r = await resolveWorkId($, root, branch, inputs)
    // a re-resolve keeps an adopted workspace adopted
    const guessed = !!r?.guessed && !(cur !== null && cur.workId === r.id && !cur.guessed)
    next = r ? await load($, root, r.id, branch, guessed) : { workId: null, branch }
  }
  // A pin or key change (or /clear) during the awaits started its own, newer resolve.
  const now = await readInputs($)
  if (now.pin !== inputs.pin || now.lastKey !== inputs.lastKey) return
  const after = await update($, progress, prev => (!reload || prev?.workId === next.workId ? next : prev))
  await logWorkspace($, after?.workId ?? 'none')
  await mirrorAutosave($)
}

// The session id whose title.json the tick has read: one read per id once the file is there.
let titleSid = ''

/** The title hooks/title.cjs set for this session id, as one `title` event (base.events and base.jsonl). */
async function adoptTitle($: $): Promise<void> {
  try {
    const sid = String(await $.session.id())
    if (sid === titleSid) return
    const dirs = [logDir(await $.env.get('HOME'), await $.env.get('DOMAINE_LOG_DIR'), sid), logDir(undefined, spareRoot(await $.env.get('TMPDIR')), sid)]
    let file: { by?: unknown; title?: unknown; ts?: unknown } | null = null
    for (const d of dirs) {
      if (!d) continue
      const text = await $.fs.read(`${d}/title.json`).catch(() => null)
      if (text === null) continue
      titleSid = sid
      try {
        file = JSON.parse(text) as typeof file
      } catch {}
      break
    }
    if (!file) return
    if (file.by !== 'base' || typeof file.title !== 'string' || (await $.env.get('BASE_EVENT_LOG')) === '0') return
    const ev: BaseEvent = { atMs: typeof file.ts === 'number' ? file.ts : await $.clock.now(), kind: 'title', text: file.title }
    let pushed = false
    await update($, events, l => {
      pushed = !l.some(x => x.kind === 'title' && x.atMs === ev.atMs)
      return pushed ? pushEvent(l, ev) : l
    })
    if (pushed) await logLine(diskOf($), ev)
  } catch {}
}

async function tick($: $, resolve: boolean): Promise<void> {
  await adoptTitle($)
  const cur = await read($, progress)
  if (resolve || cur === null || (await $.session.root()) !== lastRoot) return refresh($, true)
  if (cur.workId === null) return
  const mtimeMs = await workspaceMtime($, await $.session.root(), cur.workId)
  if (mtimeMs !== cur.mtimeMs) return refresh($, false)
  // Time or the context window alone turns a workspace stale: write only when the flag flips.
  const now = await $.clock.now()
  const list = await read($, savable)
  const staleMs = await windowOf($)
  if (withStaleness(cur, list, now, staleMs).stale !== cur.stale) {
    await update($, progress, p => (p && p.workId !== null ? withStaleness(p, list, now, staleMs) : p))
    await mirrorAutosave($)
  }
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
      await restoreInputs($, id)
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
      await restoreInputs($, id)
      // a pin outlives /clear in memory: the new id's file keeps it for that id's own resume
      if ((await read($, pin)) !== null) await saveInputs($, id)
      await $.command.register(COMMAND).catch(() => undefined)
      resolve = true
    }
    const key = PERSON.has(e.origin.kind) ? await conversationKey($, e.text) : null
    if (key && key !== (await read($, lastKey))) {
      await update($, lastKey, () => key)
      await saveInputs($, id)
      resolve = true
    }
    if (resolve) await refresh($, true)
    return r
  })

  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    await update($, progress, () => null)
    await update($, lastKey, () => null)
    await update($, savable, () => [])
    await saveInputs($, e.sessionId)
    return next(e)
  })

  on('tool.call', { tool: /^(Write|Edit)$/ }, async ($, e, next) => {
    const r = await next(e)
    if (e.tool !== 'Write' && e.tool !== 'Edit') return r
    if (!e.file_path.includes('/.claude/')) {
      if (r.deny === undefined && !r.isError && e.agentId === undefined) await noteSavable($, 'edit')
      return r
    }
    const root = await $.session.root()
    if (!e.file_path.startsWith(`${tasksDir(root)}/`)) return r
    const cur = await read($, progress)
    const inCurrent = !!cur?.workId && e.file_path.startsWith(`${workDir(root, cur.workId)}/`)
    await refresh($, !inCurrent)
    const path = e.file_path
    if (r.deny !== undefined || r.isError) return r
    await adopt($, dir => path.startsWith(`${dir}/`))
    const after = await read($, progress)
    const dir = after?.workId ? `${workDir(root, after.workId)}/` : null
    // a file in the root, as newestWrite counts it
    if (e.agentId !== undefined && dir && path.startsWith(dir) && !path.slice(dir.length).includes('/')) await markSaved($, e.agentId)
    return r
  })

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const r = await next(e)
    if (e.tool === 'Read' && e.file_path.includes('/.claude/tasks/') && r.deny === undefined && !r.isError) {
      const path = e.file_path
      await adopt($, dir => path.startsWith(`${dir}/`))
    }
    return r
  })

  // A background launch is no result yet: the agent's stop is the savable event.
  on('tool.call', { tool: /^(Agent|Task)$/ }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || r.isError || e.agentId !== undefined) return r
    const rec = r.result as { status?: unknown; agentId?: unknown } | null | undefined
    const status = typeof rec === 'object' ? rec?.status : undefined
    const id = typeof rec === 'object' && typeof rec?.agentId === 'string' ? rec.agentId : undefined
    if (status === 'async_launched' && id !== undefined) await update($, background, l => [...l, id].slice(-SAVABLE_CAP))
    else if (status === undefined || status === 'completed') await noteAgent($, id)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const id = e.agentId
    if (id === undefined) return r
    let mine = false
    await update($, background, l => {
      mine = l.includes(id)
      return mine ? l.filter(x => x !== id) : l
    })
    if (mine) await noteAgent($, id)
    return r
  })

  on('tool.call', { tool: /^mcp__/ }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || r.isError || e.agentId !== undefined) return r
    const text = typeof r.result === 'string' ? r.result : (JSON.stringify(r.result) ?? '')
    if (text.length > MCP_GATE || SLIMMED.test(text)) await noteSavable($, 'mcp')
    return r
  })

  // A Bash write to the workspace reaches the atom now, not at the next tick; a subagent's is its own save.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.tool !== 'Bash') return next(e)
    const command = e.command
    const tasks = command.includes('.claude/tasks/')
    const before = tasks ? await currentWrite($) : null
    const r = await next(e)
    if (CHECKOUT.test(command)) await refresh($, true)
    if (!tasks) return r
    await adopt($, (_, id) => command.includes(`.claude/tasks/${id}/`))
    const after = before && (await currentWrite($))
    if (before && after?.id === before.id && after.ms > before.ms) {
      await refresh($, false)
      if (e.agentId !== undefined) await markSaved($, e.agentId)
    }
    return r
  })

  on('command.run', { command: COMMAND.name }, async ($, e) => {
    const arg = e.args.trim()
    if (!arg) return { text: `Pinned: ${(await read($, pin)) ?? 'none'}. The checklist is band's: ${CHECKLIST}` }
    if (arg !== '-' && !isWorkId(arg)) return { text: `Not a work id: ${arg}` }
    await update($, pin, () => (arg === '-' ? null : arg))
    await saveInputs($, await $.session.id())
    await refresh($, true)
    if (arg === '-') return { text: `Unpinned. ${CHECKLIST} shows the checklist.` }
    const cur = await read($, progress)
    const text = `Pinned ${arg}. ${CHECKLIST} shows it.`
    return { text: cur?.workId === arg ? text : `${text} ${arg} has no task workspace.` }
  })
}
