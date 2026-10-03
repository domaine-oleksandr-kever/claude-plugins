// Pure parse of a task workspace's progress.md / notes.md into the band digest and pane rows.
import type { FndRow } from '../../../types'

const ROW = /^\s*- \[( |x|X)\] (.+)$/
const CURRENT_MAX = 28
const NOTES_TAIL = 3

export type ParsedProgress = { done: number; total: number; current: string | null; rows: FndRow[] }

/**
 * Checkbox rows. `current` is the first unchecked row below the last checked one (the frontier),
 * else the first unchecked row; it is cut to 28 code points plus `…`. Unchecked rows above the
 * frontier are `waiting`, the rest `todo`.
 */
export function parseProgress(md: string): ParsedProgress {
  const rows: FndRow[] = []
  for (const line of md.split(/\r?\n/)) {
    const m = ROW.exec(line)
    if (m) rows.push({ mark: m[1] === ' ' ? 'todo' : 'done', text: (m[2] ?? '').trim() })
  }
  const lastDone = rows.map(r => r.mark).lastIndexOf('done')
  let at = rows.findIndex((r, i) => i > lastDone && r.mark === 'todo')
  if (at === -1) at = rows.findIndex(r => r.mark === 'todo')
  rows.forEach((r, i) => {
    if (i < at && r.mark === 'todo') r.mark = 'waiting'
  })
  const row = rows[at]
  if (row) row.mark = 'current'
  return {
    done: rows.filter(r => r.mark === 'done').length,
    total: rows.length,
    current: row ? cut(row.text, CURRENT_MAX) : null,
    rows,
  }
}

/** The last three `- ` bullet lines of notes.md. */
export function notesTail(md: string): string[] {
  return md
    .split(/\r?\n/)
    .filter(l => l.startsWith('- '))
    .slice(-NOTES_TAIL)
    .map(l => l.trimEnd())
}

/** Band digest: `ELC-1591 3/5 ▶ Preview themes`, `ELC-1591 ✓ 5/5` when every row is checked, the id alone with no rows. */
export function digestText(workId: string, p: { done: number; total: number; current: string | null }): string {
  if (p.total === 0) return workId
  if (p.current === null) return `${workId} ✓ ${p.done}/${p.total}`
  return `${workId} ${p.done}/${p.total} ▶ ${p.current}`
}

function cut(text: string, max: number): string {
  const cps = [...text]
  return cps.length > max ? `${cps.slice(0, max).join('')}…` : text
}
