import { describe, expect, test } from 'claude-code/testing'
import { digestText, notesTail, parseProgress } from '../core/progress-parse.ts'
import { isWorkId, keyFromBranch, keyFromText, projectOf, slugFromBranch, ticketKeys } from '../core/workid.ts'

describe('work id', () => {
  test('keyFromBranch', () => {
    expect(keyFromBranch('feature/ELC-1591-x')).toBe('ELC-1591')
    expect(keyFromBranch('ELC-12')).toBe('ELC-12')
    expect(keyFromBranch('feature/header-refactor')).toBeNull()
    expect(keyFromBranch('')).toBeNull()
    expect(keyFromBranch(null)).toBeNull()
  })

  test('slugFromBranch', () => {
    expect(slugFromBranch('feature/header-refactor')).toBe('header-refactor')
    expect(slugFromBranch('fnd-mods')).toBe('fnd-mods')
    expect(slugFromBranch('HEAD')).toBeNull()
    expect(slugFromBranch('--x')).toBeNull()
    expect(slugFromBranch('feature/a--b')).toBeNull()
    expect(slugFromBranch('feature/Header')).toBeNull()
    expect(slugFromBranch('feature/x-')).toBeNull()
    expect(slugFromBranch('')).toBeNull()
    expect(slugFromBranch(null)).toBeNull()
  })

  test('keyFromText returns the last key', () => {
    expect(keyFromText('see ELC-77, then ABC-1 and ELC-1591')).toBe('ELC-1591')
    expect(keyFromText('see ELC-77')).toBe('ELC-77')
    expect(keyFromText('no key here, elc-1 is lower case')).toBeNull()
    expect(keyFromText('')).toBeNull()
  })

  test('ticketKeys: a known project or a /browse/ URL corroborates a key, the most recent first', () => {
    const known = new Set(['ELC'])
    expect(ticketKeys('see ELC-77, then UTF-8 and ELC-1591', known)).toEqual(['ELC-1591', 'ELC-77'])
    expect(ticketKeys('format as ISO-8601, save as UTF-8, hash SHA-256', known)).toEqual([])
    expect(ticketKeys('https://x.atlassian.net/browse/ABC-9 look', known)).toEqual(['ABC-9'])
    expect(ticketKeys('https://x.atlassian.net/BROWSE/ABC-9', new Set())).toEqual(['ABC-9'])
    expect(ticketKeys('see ABC-9', new Set())).toEqual([])
    expect(ticketKeys('no key here', known)).toEqual([])
    expect(ticketKeys(null, known)).toEqual([])
  })

  test('projectOf', () => {
    expect(projectOf('ELC-1591')).toBe('ELC')
    expect(projectOf('fnd-mods')).toBeNull()
    expect(projectOf('ELC-1591-x')).toBeNull()
  })

  test('isWorkId accepts a key or a slug, never a path', () => {
    expect(isWorkId('ELC-1591')).toBe(true)
    expect(isWorkId('fnd-mods')).toBe(true)
    expect(isWorkId('ELC-1591-x')).toBe(false)
    expect(isWorkId('../x')).toBe(false)
    expect(isWorkId('a/b')).toBe(false)
    expect(isWorkId('-')).toBe(false)
    expect(isWorkId('')).toBe(false)
  })
})

describe('progress parse', () => {
  const md = [
    '# ELC-1591',
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
    expect(digestText('ELC-1591', p)).toBe('ELC-1591 3/5 ▶ Preview themes for every sto…')
  })

  test('a short current row is not cut', () => {
    expect(parseProgress('- [ ] Preview themes').current).toBe('Preview themes')
  })

  test('all done', () => {
    const p = parseProgress('- [x] a\r\n- [x] b\r\n')
    expect(p.current).toBeNull()
    expect(digestText('fnd-mods', p)).toBe('fnd-mods ✓ 2/2')
  })

  test('no rows', () => {
    const p = parseProgress('just prose')
    expect(p.total).toBe(0)
    expect(digestText('fnd-mods', p)).toBe('fnd-mods')
  })

  test('frontier: an unchecked row above the last checked one waits, current is below it', () => {
    const p = parseProgress(['- [x] a', '- [ ] Owner: reinstall cache', '- [x] b', '- [ ] Pilot E', '- [ ] Ship'].join('\n'))
    expect(p.rows.map(r => r.mark)).toEqual(['done', 'waiting', 'done', 'current', 'todo'])
    expect(p.done).toBe(2)
    expect(digestText('fnd-mods', p)).toBe('fnd-mods 2/5 ▶ Pilot E')
  })

  test('frontier: no checked rows → the first unchecked row', () => {
    const p = parseProgress('- [ ] a\n- [ ] b')
    expect(p.rows.map(r => r.mark)).toEqual(['current', 'todo'])
    expect(p.current).toBe('a')
  })

  test('frontier: trailing checked rows → falls back to the first unchecked row', () => {
    const p = parseProgress('- [x] a\n- [ ] b\n- [ ] c\n- [x] d')
    expect(p.rows.map(r => r.mark)).toEqual(['done', 'current', 'todo', 'done'])
    expect(digestText('fnd-mods', p)).toBe('fnd-mods 2/4 ▶ b')
  })

  test('notes tail = last three bullet lines', () => {
    const notes = ['## 1', '- one', '  - nested', '- two', 'prose', '- three', '- four  '].join('\n')
    expect(notesTail(notes)).toEqual(['- two', '- three', '- four'])
    expect(notesTail('')).toEqual([])
  })
})
