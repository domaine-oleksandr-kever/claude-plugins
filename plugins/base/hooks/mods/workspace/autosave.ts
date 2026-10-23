// Autosave: the levers on a stale task workspace (base.progress `stale`, never a `guessed` one) — one context line
// on a person's prompt here; the blocked stop and the notes.md marker before an auto-compact are the Stop and
// PreCompact command hooks (hooks/conventions.cjs), acting on the autosave-state.json progress.ts mirrors.
// BASE_AUTOSAVE=0 turns all three off.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, On } from 'claude-code'
import type { BaseCompactMarker } from '../../../types'
import { logDir } from '../events.ts'
import { PERSON, autosaveState, newMarker, newestWrite, queueMirror } from './progress.ts'

const progress = atom({ plugin: 'base', key: 'progress' } as const, null)
const autosave = atom({ plugin: 'base', key: 'autosave' } as const, null)
const marker = atom({ plugin: 'base', key: 'compactMarker' } as const, null)

type $ = EngineInterface

// progress.ts keeps the same two wrappers: the validator follows `$` only within one file.
const sessionLogDir = async ($: $): Promise<string | null> =>
  logDir(await $.env.get('HOME'), await $.env.get('DOMAINE_LOG_DIR'), String(await $.session.id()))

async function adoptMarker($: $): Promise<BaseCompactMarker | null> {
  const cur = await read($, marker)
  const dir = await sessionLogDir($).catch(() => null)
  const m = dir ? newMarker(await $.fs.read(`${dir}/compact-marker.json`).catch(() => null), cur) : null
  if (!m) return cur
  await update($, marker, () => m)
  await update($, autosave, t => (t ? { ...t, nudgedMs: -1 } : t))
  return m
}

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

type Workspace = { id: string; mtimeMs: number; stale: boolean }

/** The published workspace with its newest write listed now: a Bash append lands between ticks and un-stales it. */
async function workspace($: $): Promise<Workspace | null> {
  if ((await $.env.get('BASE_AUTOSAVE')) === '0') return null
  const p = await read($, progress)
  if (!p || p.workId === null || !p.hasWorkspace) return null
  let entries: FsEntry[] = []
  try {
    entries = await $.fs.list(`${await $.session.root()}/.claude/tasks/${p.workId}`)
  } catch {}
  const mtimeMs = Math.max(p.mtimeMs, newestWrite(entries, p.workId, await adoptMarker($)))
  return { id: p.workId, mtimeMs, stale: p.stale && mtimeMs <= p.mtimeMs }
}

/** Once per stale period: the period ends with the next workspace write (a new `mtimeMs`). */
async function nudge($: $, ws: Workspace | null): Promise<string | null> {
  if (!ws?.stale || (await read($, autosave))?.nudgedMs === ws.mtimeMs) return null
  await update($, autosave, t => (t ? { ...t, nudgedMs: ws.mtimeMs } : t))
  const age = ws.mtimeMs ? `${Math.floor(((await $.clock.now()) - ws.mtimeMs) / 60_000)} min` : 'unsaved'
  return `workspace stale ${age}: save findings to .claude/tasks/${ws.id}/notes.md before answering`
}

export function registerAutosave(on: On): void {
  on('prompt.submit', { text: /(?:)/ }, async ($, e, next) => {
    let line: string | null = null
    try {
      const ws = await workspace($)
      // A prompt typed over a running turn, or delivered into it, starts no turn of its own.
      if (e.turnId === undefined) {
        const startMs = await $.clock.now()
        await update($, autosave, t => ({ turn: (t?.turn ?? 0) + 1, startMs, nudgedMs: t?.nudgedMs ?? -1 }))
        await mirrorAutosave($)
      }
      if (PERSON.has(e.origin.kind)) line = await nudge($, ws)
    } catch {}
    return next(line ? { ...e, context: [...(e.context ?? []), line] } : e)
  })
}
