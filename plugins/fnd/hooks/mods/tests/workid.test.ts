import { describe, expect, test } from 'claude-code/testing'
import { digestText, notesTail, parseProgress } from '../core/progress-parse.ts'
import { isWorkId, keyFromBranch, keyFromText, keysFromText, slugFromBranch } from '../core/workid.ts'

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

  test('keysFromText lists every key, the most recent first', () => {
    expect(keysFromText('see ELC-77, then UTF-8 and ELC-1591')).toEqual(['ELC-1591', 'UTF-8', 'ELC-77'])
    expect(keysFromText('no key here')).toEqual([])
    expect(keysFromText(null)).toEqual([])
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

  test('notes tail = last three bullet lines', () => {
    const notes = ['## 1', '- one', '  - nested', '- two', 'prose', '- three', '- four  '].join('\n')
    expect(notesTail(notes)).toEqual(['- two', '- three', '- four'])
    expect(notesTail('')).toEqual([])
  })
})
