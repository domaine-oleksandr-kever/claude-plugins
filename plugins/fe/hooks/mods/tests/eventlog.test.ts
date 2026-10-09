import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { EVENT_CAP, FILE_BYTES, FILE_LINES, capLines, logDir, nextLines, pushEvent, seedLines } from '../events.ts'
import { HOME, LOG, NOW, PEEK, compose, doctor, peek, ran, start, world } from './world.ts'

const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)
const FILE = `${LOG}/s1/fe.jsonl`
const TS = new Date(NOW).toISOString()
const NO_BASE: [string, string][] = [['band-log', 'band']]

type Line = { ts: string; plugin: string; version: string; session: string; kind: string; agent: string; text: string }
const parse = (text: string | undefined): Line[] => (text ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Line)
const line = (session: string, kind: string, text: string, version = '0.1.0') =>
  JSON.stringify({ ts: TS, plugin: 'fe', version, session, kind, agent: 'main', text })
const staticOut = JSON.stringify({ root: '/p', rows: [{ status: 'PASS', name: 'node', detail: 'x' }] })

describe('fe.jsonl', () => {
  t('the start line first: ts, the plugin literal, the manifest version, session, agent main', async ($, on) => {
    const { w, calls, clock } = world(on, { env: { HOME }, manifest: '{ "name": "fe", "version": "1.2.3" }' })
    await start($)
    await clock.settle()
    expect(calls.writes[0]?.path).toBe(FILE)
    expect(parse(w.files[FILE]?.text)[0]).toEqual(JSON.parse(line('s1', 'start', 'fe 1.2.3', '1.2.3')))
  })

  t('every line fe publishes follows, oldest first, the whole file rewritten each time', async ($, on) => {
    const { w, calls, clock } = world(on, { env: { HOME }, commands: NO_BASE, doctor: () => ran(0, staticOut) })
    await start($)
    await clock.settle()
    await doctor($)
    const lines = parse(w.files[FILE]?.text)
    expect(lines.map(l => [l.kind, l.text])).toEqual([
      ['start', 'fe 0.1.0'],
      ['install', 'needs the base plugin — claude plugin install base@domaine'],
      ['profile', 'theme (project-profile.sh)'],
      ['doctor', '2 passed, 1 failed, 0 skipped'],
    ])
    expect(lines.every(l => l.plugin === 'fe' && l.session === 's1' && l.agent === 'main' && l.version === '0.1.0')).toBe(true)
    expect(calls.writes).toHaveLength(4)
    expect(calls.writes[1]?.text.split('\n').filter(Boolean)).toHaveLength(2)
  })

  t('a /clear (a new id, no session.start) opens its own file with a start line first', async ($, on) => {
    const { w } = world(on, { env: { HOME } })
    await compose($)
    w.sid = 's2'
    await compose($)
    expect(parse(w.files[`${LOG}/s2/fe.jsonl`]?.text).map(l => [l.session, l.kind])).toEqual([
      ['s2', 'start'],
      ['s2', 'profile'],
    ])
    expect(parse(w.files[FILE]?.text).map(l => l.kind)).toEqual(['start', 'profile'])
  })

  t("a reload goes on from this session's lines on disk; another session's lines go; no second start line", async ($, on) => {
    const { w } = world(on, { env: { HOME } })
    w.files[FILE] = { text: `${line('s0', 'doctor', 'old')}\n${line('s1', 'start', 'fe 0.1.0')}\n${line('s1', 'install', 'x')}\n`, mtimeMs: NOW }
    await compose($)
    expect(parse(w.files[FILE]?.text).map(l => [l.session, l.kind, l.text])).toEqual([
      ['s1', 'start', 'fe 0.1.0'],
      ['s1', 'install', 'x'],
      ['s1', 'profile', 'theme (project-profile.sh)'],
    ])
  })

  t('FE_EVENT_LOG=0 → neither the list nor the file', async ($, on) => {
    const { calls, clock } = world(on, { env: { HOME, FE_EVENT_LOG: '0' }, doctor: () => ran(0, staticOut) })
    await start($)
    await clock.settle()
    await doctor($)
    expect(calls.writes).toEqual([])
    expect((await peek($)).events).toEqual([])
  })

  t('no HOME and no DOMAINE_LOG_DIR → no file, no toast, the list still fills', async ($, on) => {
    const { calls } = world(on)
    await compose($)
    expect(calls.writes).toEqual([])
    expect(calls.toasts).toEqual([])
    expect((await peek($)).events.map((ev: any) => ev.kind)).toEqual(['profile'])
  })

  t('an absolute DOMAINE_LOG_DIR replaces the home directory; a relative one is ignored', async ($, on) => {
    const { calls } = world(on, { env: { HOME, DOMAINE_LOG_DIR: '/var/log/domaine/' } })
    await compose($)
    expect(calls.writes.map(x => x.path)).toEqual(['/var/log/domaine/s1/fe.jsonl'])
  })

  t('a failing write never reaches the hook: one toast per session', async ($, on) => {
    const { w, calls } = world(on, { env: { HOME }, writeFails: 'EACCES: permission denied', doctor: () => ran(0, staticOut) })
    await compose($)
    const r = await doctor($)
    expect(r.text).toContain('fe doctor')
    await doctor($)
    expect(calls.toasts).toHaveLength(1)
    expect(calls.toasts[0]).toMatch(/^fe: event log not written: \S/)
    w.sid = 's2'
    await doctor($)
    expect(calls.toasts).toHaveLength(2)
  })
})

describe('pure helpers', () => {
  test('logDir', () => {
    expect(logDir(HOME, undefined, 's1')).toBe(`${LOG}/s1`)
    expect(logDir(`${HOME}/`, '', 's1')).toBe(`${LOG}/s1`)
    expect(logDir(HOME, '/x/y//', 's1')).toBe('/x/y/s1')
    expect(logDir(HOME, 'x/y', 's1')).toBe(`${LOG}/s1`)
    expect(logDir(undefined, undefined, 's1')).toBe(null)
    expect(logDir('relative', undefined, 's1')).toBe(null)
    expect(logDir(HOME, undefined, '..')).toBe(null)
    expect(logDir(HOME, undefined, 'a/b')).toBe(null)
  })

  test('the list cap: 200, the oldest goes first', () => {
    expect(EVENT_CAP).toBe(200)
    let list: any[] = []
    for (let i = 0; i < EVENT_CAP + 3; i++) list = pushEvent(list, { atMs: i, kind: 'doctor', text: `d${i}` })
    expect(list).toHaveLength(EVENT_CAP)
    expect(list[0].text).toBe('d3')
    expect(list[list.length - 1].text).toBe(`d${EVENT_CAP + 2}`)
  })

  test('the file cap: 2000 lines, then 256 KB, the newest line always kept', () => {
    const many = Array.from({ length: FILE_LINES }, (_, i) => `l${i}`)
    const capped = capLines(many, 'new')
    expect(capped).toHaveLength(FILE_LINES)
    expect(capped[0]).toBe('l1')
    expect(capped[capped.length - 1]).toBe('new')
    const kb = 'é'.repeat(512)
    const big = capLines(Array.from({ length: 300 }, () => kb), kb)
    expect(big.length).toBe(Math.floor(FILE_BYTES / 1025))
    expect(capLines([], 'x'.repeat(FILE_BYTES * 2))).toHaveLength(1)
  })

  test('seedLines keeps the session, skips what does not parse, caps once', () => {
    expect(seedLines(`${line('s1', 'start', 'a')}\nnot json\n${line('s2', 'doctor', 'b')}\n${line('s1', 'doctor', 'c')}\n`, 's1')).toEqual([
      line('s1', 'start', 'a'),
      line('s1', 'doctor', 'c'),
    ])
    const lines = Array.from({ length: FILE_LINES + 5 }, (_, i) => line('s1', 'doctor', `d${i}`))
    const seeded = seedLines(`${lines.join('\n')}\n`, 's1')
    expect(seeded).toHaveLength(FILE_LINES)
    expect(seeded[0]).toBe(lines[5])
  })

  test('nextLines: a start line first, one per session', () => {
    const ev = { atMs: NOW, kind: 'profile' as const, text: 'p' }
    expect(nextLines([], ev, '0.1.0', 's1')).toEqual([line('s1', 'start', 'fe 0.1.0'), line('s1', 'profile', 'p')])
    expect(nextLines([line('s1', 'start', 'fe 0.1.0')], { atMs: NOW, kind: 'start', text: 'fe 0.1.0' }, '0.1.0', 's1')).toBe(null)
  })
})
