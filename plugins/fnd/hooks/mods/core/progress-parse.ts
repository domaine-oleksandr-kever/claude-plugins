// Pure parse of a task workspace's progress.md / notes.md into the band digest and pane rows.
import type { FndRow } from '../../../types'

const ROW = /^\s*- \[( |x|X)\] (.+)$/
const CURRENT_MAX = 28
const NOTES_TAIL = 3

export type ParsedProgress = { done: number; total: number; current: string | null; rows: FndRow[] }

/** Checkbox rows; the first unchecked one is `current`, cut to 28 code points plus `…`. */
export function parseProgress(md: string): ParsedProgress {
  const rows: FndRow[] = []
  let done = 0
  let current: string | null = null
  for (const line of md.split(/\r?\n/)) {
    const m = ROW.exec(line)
    if (!m) continue
    const text = (m[2] ?? '').trim()
    if (m[1] !== ' ') {
      done++
      rows.push({ mark: 'done', text })
    } else if (current === null) {
      current = cut(text, CURRENT_MAX)
      rows.push({ mark: 'current', text })
    } else {
      rows.push({ mark: 'todo', text })
    }
  }
  return { done, total: rows.length, current, rows }
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
