import { describe, expect, test } from 'claude-code/testing'
import { pushEvent, EVENT_CAP } from '../events.ts'
import { notesTail, parseProgress } from '../workspace/progress-parse.ts'
import { isWorkId, keyFromBranch, projectOf, slugFromBranch, ticketKeys } from '../workspace/workid.ts'

describe('work id', () => {
  test('keyFromBranch', () => {
    expect(keyFromBranch('feature/ABC-1591-x')).toBe('ABC-1591')
    expect(keyFromBranch('ABC-12')).toBe('ABC-12')
    expect(keyFromBranch('feature/header-refactor')).toBeNull()
    expect(keyFromBranch('')).toBeNull()
    expect(keyFromBranch(null)).toBeNull()
  })

  test('slugFromBranch', () => {
    expect(slugFromBranch('feature/header-refactor')).toBe('header-refactor')
    expect(slugFromBranch('base-mods')).toBe('base-mods')
    expect(slugFromBranch('HEAD')).toBeNull()
    expect(slugFromBranch('--x')).toBeNull()
    expect(slugFromBranch('feature/a--b')).toBeNull()
    expect(slugFromBranch('feature/Header')).toBeNull()
    expect(slugFromBranch('feature/x-')).toBeNull()
    expect(slugFromBranch('')).toBeNull()
    expect(slugFromBranch(null)).toBeNull()
  })

  test('ticketKeys: a known project or a /browse/ URL corroborates a key, the most recent first', () => {
    const known = new Set(['ABC'])
    expect(ticketKeys('see ABC-77, then UTF-8 and ABC-1591', known)).toEqual(['ABC-1591', 'ABC-77'])
    expect(ticketKeys('format as ISO-8601, save as UTF-8, hash SHA-256', known)).toEqual([])
    expect(ticketKeys('https://x.atlassian.net/browse/XYZ-9 look', known)).toEqual(['XYZ-9'])
    expect(ticketKeys('https://x.atlassian.net/BROWSE/XYZ-9', new Set())).toEqual(['XYZ-9'])
    expect(ticketKeys('see XYZ-9', new Set())).toEqual([])
    expect(ticketKeys('no key here', known)).toEqual([])
    expect(ticketKeys(null, known)).toEqual([])
  })

  test('projectOf', () => {
    expect(projectOf('ABC-1591')).toBe('ABC')
    expect(projectOf('base-mods')).toBeNull()
    expect(projectOf('ABC-1591-x')).toBeNull()
  })

  test('isWorkId accepts a key or a slug, never a path', () => {
    expect(isWorkId('ABC-1591')).toBe(true)
    expect(isWorkId('base-mods')).toBe(true)
    expect(isWorkId('ABC-1591-x')).toBe(false)
    expect(isWorkId('../x')).toBe(false)
    expect(isWorkId('a/b')).toBe(false)
    expect(isWorkId('-')).toBe(false)
    expect(isWorkId('')).toBe(false)
  })
})

describe('progress parse', () => {
  const md = [
    '# ABC-1591',
    '',
    '- [x] Read the ticket',
    '- [X] Plan approved',
    '  - [x] nested row counts too',
    '- [ ] Preview themes for every store and locale',
    '- [ ] QA',
    '- not a row',
  ].join('\n')

  test('done / total / current', () => {
    const p = parseProgress(md)
    expect(p.done).toBe(3)
    expect(p.total).toBe(5)
    expect(p.current).toBe('Preview themes for every sto…')
    expect(p.rows.map(r => r.mark)).toEqual(['done', 'done', 'done', 'current', 'todo'])
    expect(p.rows[3]?.text).toBe('Preview themes for every store and locale')
  })

  test('a short current row is not cut', () => {
    expect(parseProgress('- [ ] Preview themes').current).toBe('Preview themes')
  })

  test('all done → no current', () => {
    const p = parseProgress('- [x] a\r\n- [x] b\r\n')
    expect(p).toMatchObject({ done: 2, total: 2, current: null })
  })

  test('no rows', () => {
    expect(parseProgress('just prose')).toEqual({ done: 0, total: 0, current: null, rows: [] })
  })

  test('frontier: an unchecked row above the last checked one waits, current is below it', () => {
    const p = parseProgress(['- [x] a', '- [ ] Owner: reinstall cache', '- [x] b', '- [ ] Pilot E', '- [ ] Ship'].join('\n'))
    expect(p.rows.map(r => r.mark)).toEqual(['done', 'waiting', 'done', 'current', 'todo'])
    expect(p.done).toBe(2)
    expect(p.current).toBe('Pilot E')
  })

  test('frontier: no checked rows → the first unchecked row', () => {
    const p = parseProgress('- [ ] a\n- [ ] b')
    expect(p.rows.map(r => r.mark)).toEqual(['current', 'todo'])
    expect(p.current).toBe('a')
  })

  test('frontier: trailing checked rows → falls back to the first unchecked row', () => {
    const p = parseProgress('- [x] a\n- [ ] b\n- [ ] c\n- [x] d')
    expect(p.rows.map(r => r.mark)).toEqual(['done', 'current', 'todo', 'done'])
    expect(p.current).toBe('b')
  })

  test('notes tail = last three bullet lines', () => {
    const notes = ['## 1', '- one', '  - nested', '- two', 'prose', '- three', '- four  '].join('\n')
    expect(notesTail(notes)).toEqual(['- two', '- three', '- four'])
    expect(notesTail('')).toEqual([])
  })
})

describe('event list', () => {
  test('oldest first; past the cap the oldest line goes', () => {
    let list = [] as ReturnType<typeof pushEvent>
    for (let i = 0; i < EVENT_CAP + 2; i++) list = pushEvent(list, { atMs: i, kind: 'workspace', text: String(i) })
    expect(list).toHaveLength(EVENT_CAP)
    expect(list[0]?.text).toBe('2')
    expect(list[EVENT_CAP - 1]?.text).toBe(String(EVENT_CAP + 1))
  })
})
