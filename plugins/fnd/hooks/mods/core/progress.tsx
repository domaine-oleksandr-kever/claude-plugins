// Progress: work-id resolver, digest refresh, /fnd-progress and its pane.
// Writes the `progress` and `paneShown` atoms the band draws from.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { FndEvent, FndProgress } from '../../../types'
import { LOG_COMMAND, pushEvent } from './events.ts'
import { notesTail, parseProgress } from './progress-parse.ts'
import { KEY, isWorkId, keyFromBranch, projectOf, slugFromBranch, ticketKeys } from './workid.ts'

const PANE = 'fnd-progress'
const COMMAND = {
  name: 'fnd-progress',
  description: 'Open the fnd task progress pane',
  argumentHint: '[work-id]',
  immediate: true,
} as const
const TICK_MS = 30_000
const RESOLVE_EVERY = 4
const FRESH_MS = 12 * 60 * 60_000
const CHECKOUT = /\bgit\s+(checkout|switch|worktree)\b/
const NO_WORKSPACE = 'no task workspace — /fnd:save-task-context'
const NO_PROGRESS = 'no progress.md yet — /fnd:save-task-context'
const GLYPH = { done: '✓', current: '▶', waiting: '◌', todo: '☐' } as const
/** Prompt origins a person wrote; notifications, peers and schedules never set the conversation key. */
const PERSON = new Set(['composer', 'bridge', 'sdk'])

const progress = atom({ plugin: 'fnd', key: 'progress' } as const, null)
const pin = atom({ plugin: 'fnd', key: 'pin' } as const, null)
const lastKey = atom({ plugin: 'fnd', key: 'lastKey' } as const, null)
const sessionId = atom({ plugin: 'fnd', key: 'sessionId' } as const, null)
const paneShown = atom({ plugin: 'fnd', key: 'paneShown' } as const, false)
const events = atom({ plugin: 'fnd', key: 'events' } as const, [] as FndEvent[])

type $ = EngineInterface

/** Compared with the last logged workspace, not the atom: /clear nulls the atom while the work stays. */
async function logWorkspace($: $, text: string): Promise<void> {
  try {
    if ((await $.env.get('FND_EVENT_LOG')) === '0') return
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

/** The workspace directory itself: a ticket dir without progress.md still names the work (digest = the bare id). */
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

async function load($: $, root: string, workId: string, branch: string | null): Promise<FndProgress> {
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
  let next: FndProgress
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

async function openPane($: $): Promise<string> {
  const r = await $.ui.open({ id: PANE, title: 'Progress', focus: true, closeOnEscape: true })
  if (!r.isPlaced) {
    $.ui.toast(`progress pane not placed: ${r.reason}`)
    return `Progress pane not placed: ${r.reason}`
  }
  await update($, paneShown, () => true)
  return 'Progress pane opened.'
}

async function togglePane($: $): Promise<string> {
  const panes = await $.ui.panes()
  if (panes.some(p => p.id === PANE && p.isShown)) {
    await $.ui.close({ id: PANE })
    return 'Progress pane closed.'
  }
  return openPane($)
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
      const panes = await $.ui.panes()
      const shown = panes.some(p => p.id === PANE && p.isPlaced)
      await update($, paneShown, () => shown)
    } catch {}
    try {
      const id = await $.session.id()
      await update($, sessionId, () => id)
    } catch {}
    await $.command.register(COMMAND).catch(() => undefined)
    await $.command.register(LOG_COMMAND).catch(() => undefined)
    await refresh($, true).catch(() => undefined)
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    let resolve = false
    const id = await $.session.id()
    if (id !== (await read($, sessionId))) {
      await update($, sessionId, () => id)
      await $.command.register(COMMAND)
      await $.command.register(LOG_COMMAND)
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

  on('command.run', { command: 'fnd-progress' }, async ($, e) => {
    const arg = e.args.trim()
    if (!arg) return { text: await togglePane($) }
    if (arg !== '-' && !isWorkId(arg)) return { text: `Not a work id: ${arg}` }
    await update($, pin, () => (arg === '-' ? null : arg))
    await refresh($, true)
    const text = await openPane($)
    const cur = await read($, progress)
    if (arg !== '-' && cur?.workId !== arg) return { text: `${text} ${arg} has no task workspace.` }
    return { text }
  })

  // Answers without next, so the band Button's own closure never runs and the pane toggles once.
  on('ui.press', { plugin: 'fnd', element: 'progress' }, async ($, e) => {
    await togglePane($)
    return { element: e.element }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const r = await next(e)
    if (e.origin.kind === 'plugin' || e.origin.kind === 'person') await update($, paneShown, () => false)
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const p = await read($, progress)
    if (!p || p.workId === null) {
      return (
        <Box flexDirection="column" width={e.props.bodyColumns}>
          <Text wrap="truncate-end">{NO_WORKSPACE}</Text>
        </Box>
      )
    }
    const header = [p.workId, p.branch, p.total ? `${p.done}/${p.total}` : null].filter(Boolean).join(' · ')
    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Text bold wrap="truncate-end">
          {header}
        </Text>
        {!p.hasWorkspace ? (
          <Text dimColor wrap="truncate-end">
            {NO_WORKSPACE}
          </Text>
        ) : p.total === 0 ? (
          <Text dimColor wrap="truncate-end">
            {NO_PROGRESS}
          </Text>
        ) : null}
        {p.rows.map((row, i) => (
          <Box key={`row-${i}`}>
            <Text wrap="truncate-end" dimColor={row.mark === 'done' || row.mark === 'waiting'} bold={row.mark === 'current'}>
              {`${GLYPH[row.mark]} ${row.text}`}
            </Text>
          </Box>
        ))}
        {p.notesTail.map(line => (
          <Text dimColor wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Box>
    )
  })
}
