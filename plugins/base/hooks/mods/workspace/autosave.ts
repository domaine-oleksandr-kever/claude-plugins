// Autosave: the levers on a stale task workspace (base.progress `stale`) — one context line on a prompt,
// one blocked stop at turn end, a notes.md marker before an auto-compact. BASE_AUTOSAVE=0 turns all three off.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import { isStale } from './progress.ts'

const BLOCK_EVERY = 3
/** Turns without a workspace write after which earlier savable work counts at a stop too. */
const QUIET_TURNS = 3

const progress = atom({ plugin: 'base', key: 'progress' } as const, null)
const autosave = atom({ plugin: 'base', key: 'autosave' } as const, null)

type $ = EngineInterface
type Workspace = { id: string; notes: string; mtimeMs: number; lastSavableMs: number; agentsSince: number; editsSince: number }

async function mtimeOf($: $, path: string): Promise<number> {
  try {
    return (await $.fs.stat(path)).mtimeMs
  } catch {
    return 0
  }
}

/** The current work id's workspace with its newest write stat'ed now: a Bash append lands between ticks. */
async function workspace($: $): Promise<Workspace | null> {
  if ((await $.env.get('BASE_AUTOSAVE')) === '0') return null
  const p = await read($, progress)
  if (!p || p.workId === null || !p.hasWorkspace) return null
  const dir = `${await $.session.root()}/.claude/tasks/${p.workId}`
  const notes = `${dir}/notes.md`
  const mtimeMs = Math.max(await mtimeOf($, `${dir}/progress.md`), await mtimeOf($, notes))
  return { id: p.workId, notes, mtimeMs, lastSavableMs: p.lastSavableMs ?? 0, agentsSince: p.agentsSince ?? 0, editsSince: p.editsSince ?? 0 }
}

const minutes = (ws: Workspace, now: number) => Math.floor((now - ws.mtimeMs) / 60_000)

async function nudge($: $, ws: Workspace | null): Promise<string | null> {
  const now = await $.clock.now()
  if (!ws || !isStale(ws.mtimeMs, ws.lastSavableMs, now)) return null
  const last = ws.mtimeMs ? `last write ${minutes(ws, now)} min ago` : 'nothing saved yet'
  return `workspace stale: ${last} — save decisions and interim findings to .claude/tasks/${ws.id}/notes.md before you answer`
}

/**
 * Blocks a stop whose turn wrote nothing to the workspace and left it stale, after savable work in this turn
 * or 3 turns without a write; once per 3 turns.
 */
async function stopReason($: $): Promise<string | null> {
  const turn = await read($, autosave)
  const ws = await workspace($)
  if (!turn || !ws) return null
  const now = await $.clock.now()
  if (ws.mtimeMs >= turn.startMs || !isStale(ws.mtimeMs, ws.lastSavableMs, now)) return null
  if (ws.lastSavableMs < turn.startMs && turn.turn - turn.writeTurn < QUIET_TURNS) return null
  if (turn.blockedTurn && turn.turn - turn.blockedTurn < BLOCK_EVERY) return null
  await update($, autosave, t => (t ? { ...t, blockedTurn: t.turn } : t))
  return `save interim findings to the workspace (.claude/tasks/${ws.id}/notes.md), then stop`
}

/** An auto-compact gives the model no pass to save in: leave a pointer for the next context instead. */
async function compactMarker($: $): Promise<void> {
  const ws = await workspace($)
  const now = await $.clock.now()
  if (!ws || !isStale(ws.mtimeMs, ws.lastSavableMs, now)) return
  const age = ws.mtimeMs ? ` ${minutes(ws, now)} min` : ', nothing saved yet'
  const line = `- ${new Date(now).toISOString().slice(0, 10)} compact: workspace stale${age}; since then ${ws.agentsSince} reader agents, ${ws.editsSince} edits\n`
  let text = ''
  try {
    text = await $.fs.read(ws.notes)
  } catch {
    if ((await mtimeOf($, ws.notes)) > 0) return
  }
  await $.fs.write(ws.notes, text && !text.endsWith('\n') ? `${text}\n${line}` : `${text}${line}`)
}

export function registerAutosave(on: On): void {
  on('prompt.submit', { text: /(?:)/ }, async ($, e, next) => {
    let line: string | null = null
    try {
      const ws = await workspace($)
      // A prompt typed over a running turn, or delivered into it, starts no turn of its own.
      if (e.turnId === undefined) {
        const startMs = await $.clock.now()
        const writeMs = ws?.mtimeMs ?? 0
        await update($, autosave, t => {
          const turn = (t?.turn ?? 0) + 1
          const writeTurn = t && t.writeMs === writeMs ? t.writeTurn : turn - 1
          return { turn, startMs, blockedTurn: t?.blockedTurn ?? 0, writeMs, writeTurn }
        })
      }
      line = await nudge($, ws)
    } catch {}
    return next(line ? { ...e, context: [...(e.context ?? []), line] } : e)
  })

  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    if (e.stop_hook_active || r.block) return r
    const reason = await stopReason($).catch(() => null)
    return reason ? { ...r, block: reason } : r
  })

  on('classic.PreCompact', async ($, e, next) => {
    const r = await next(e)
    if (e.trigger === 'auto' && !r.block) await compactMarker($).catch(() => undefined)
    return r
  })
}
