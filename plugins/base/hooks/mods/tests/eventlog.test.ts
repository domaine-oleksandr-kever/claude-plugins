import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { FILE_BYTES, FILE_LINES, LOG_TTL_MS, capLines, logDir, nextLines, seedLines } from '../events.ts'
import { NOW, PEEK, ROOT, ran, run, start, submit, world } from './world.ts'

const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)
const HOME = '/home/dev'
const LOG = `${HOME}/.claude/domaine/log`
const FILE = `${LOG}/s1/base.jsonl`
const TS = new Date(NOW).toISOString()
const DAY = 24 * 3_600_000
const ATTRIBUTION = 'git commit -m "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'
const NO_SLIM = ['Bash', 'Read']
const BYPASS = 'git commit --no-verify -m x'

type Line = { ts: string; plugin: string; version: string; session: string; kind: string; agent: string; text: string }
const parse = (text: string | undefined): Line[] => (text ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Line)
const line = (session: string, kind: string, text: string, version = '0.1.0') =>
  JSON.stringify({ ts: TS, plugin: 'base', version, session, kind, agent: 'main', text })
const bash = ($: any, command: string) => $.tool.call({ tool: 'Bash', command })

describe('base.jsonl', () => {
  t('the start line is the first line: ts, plugin literal, manifest version, session, agent main', async ($, on) => {
    const { w, calls } = world(on, { env: { HOME }, manifest: '{ "name": "base", "version": "1.2.3" }' })
    await start($)
    expect(calls.writes.map(x => x.path)).toEqual([FILE])
    expect(w.files[FILE]?.text).toBe(`${line('s1', 'start', 'base 1.2.3', '1.2.3')}\n`)
  })

  t('every line base publishes follows, oldest first, the whole file rewritten each time', async ($, on) => {
    const { w, calls } = world(on, { env: { HOME }, tools: NO_SLIM, run: () => ran(2, '', 'no bypass') })
    await start($)
    await submit($, 'hello')
    await bash($, ATTRIBUTION)
    await bash($, BYPASS)
    await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'base:jira-reader' })
    const lines = parse(w.files[FILE]?.text)
    expect(lines.map(l => [l.kind, l.text])).toEqual([
      ['start', 'base 0.1.0'],
      ['install', 'slim is not loaded — claude plugin install slim@domaine'],
      ['guard', 'Bash: a commit message with AI attribution'],
      ['guard', 'Bash: a git hooks bypass'],
      ['refuse', 'jira-reader: slim is not loaded'],
    ])
    expect(lines.every(l => l.plugin === 'base' && l.session === 's1' && l.agent === 'main' && l.ts === TS)).toBe(true)
    expect(calls.writes).toHaveLength(5)
    expect(calls.writes[1]?.text.split('\n').filter(Boolean)).toHaveLength(2)
  })

  t('the doctor and title lines reach the file too', async ($, on) => {
    const { w } = world(on, { env: { HOME }, run: () => ran(0, JSON.stringify({ root: '/p', rows: [] })) })
    w.files[`${ROOT}/.claude/tasks/ABC-1591/ticket.md`] = { text: '# ABC-1591 — Fix the cart', mtimeMs: NOW }
    await $.classic.SessionStart({ source: 'startup', session_id: 's1' })
    await start($)
    await run($, '', 'base-doctor')
    expect(parse(w.files[FILE]?.text).map(l => l.kind)).toEqual(expect.arrayContaining(['start', 'title', 'workspace', 'doctor']))
    expect(parse(w.files[FILE]?.text)[0]?.kind).toBe('start')
  })

  t('a /clear (a new id, no session.start) opens its own file with a start line first', async ($, on) => {
    const { w } = world(on, { env: { HOME } })
    await start($)
    w.sid = 's2'
    await bash($, ATTRIBUTION)
    expect(parse(w.files[`${LOG}/s2/base.jsonl`]?.text).map(l => [l.session, l.kind])).toEqual([
      ['s2', 'start'],
      ['s2', 'guard'],
    ])
    expect(parse(w.files[FILE]?.text).map(l => l.kind)).toEqual(['start'])
  })

  t("a reload goes on from this session's lines on disk; another session's lines go", async ($, on) => {
    const { w } = world(on, { env: { HOME } })
    w.files[FILE] = { text: `${line('s0', 'guard', 'old')}\n${line('s1', 'start', 'base 0.1.0')}\n${line('s1', 'workspace', 'ABC-1')}\n`, mtimeMs: NOW }
    await bash($, ATTRIBUTION)
    expect(parse(w.files[FILE]?.text).map(l => [l.session, l.kind, l.text])).toEqual([
      ['s1', 'start', 'base 0.1.0'],
      ['s1', 'workspace', 'ABC-1'],
      ['s1', 'guard', 'Bash: a commit message with AI attribution'],
    ])
  })

  t('a file of another session starts over', async ($, on) => {
    const { w } = world(on, { env: { HOME } })
    w.files[FILE] = { text: `${line('s0', 'start', 'base 0.0.9')}\n`, mtimeMs: NOW }
    await bash($, ATTRIBUTION)
    expect(parse(w.files[FILE]?.text).map(l => [l.session, l.kind])).toEqual([
      ['s1', 'start'],
      ['s1', 'guard'],
    ])
  })

  t('BASE_EVENT_LOG=0 → neither the list nor the file', async ($, on) => {
    const { calls } = world(on, { env: { HOME, BASE_EVENT_LOG: '0' } })
    await start($)
    await bash($, ATTRIBUTION)
    expect(calls.writes).toEqual([])
  })

  t('no HOME and no DOMAINE_LOG_DIR → no file, no toast, the list still fills', async ($, on) => {
    const { calls } = world(on)
    await start($)
    await bash($, ATTRIBUTION)
    expect(calls.writes).toEqual([])
    expect(calls.toasts).toEqual([])
  })

  t('an absolute DOMAINE_LOG_DIR replaces the home directory; the session directory is still made under it', async ($, on) => {
    const { calls } = world(on, { env: { HOME, DOMAINE_LOG_DIR: '/var/log/domaine/' } })
    await start($)
    expect(calls.writes.map(x => x.path)).toEqual(['/var/log/domaine/s1/base.jsonl'])
  })

  t('a relative DOMAINE_LOG_DIR is ignored: the log never lands in the project', async ($, on) => {
    const { calls } = world(on, { env: { HOME, DOMAINE_LOG_DIR: 'logs' } })
    await start($)
    expect(calls.writes.map(x => x.path)).toEqual([FILE])
  })

  t('two events in flight together, no start first: both lines reach the file', async ($, on) => {
    const { w } = world(on, { env: { HOME }, run: () => ran(2, '', 'no bypass') })
    const [a, b] = await Promise.all([bash($, ATTRIBUTION), bash($, BYPASS)])
    expect(a.deny && b.deny).toBeTruthy()
    const lines = parse(w.files[FILE]?.text)
    expect(lines.map(l => l.kind)).toEqual(['start', 'guard', 'guard'])
    expect(lines.slice(1).map(l => l.text).sort()).toEqual(['Bash: a commit message with AI attribution', 'Bash: a git hooks bypass'])
  })

  t('a failing write never reaches the hook: one toast per session', async ($, on) => {
    const { w, calls } = world(on, { env: { HOME }, writeFails: 'EACCES: permission denied' })
    await start($)
    const r = await bash($, ATTRIBUTION)
    expect(r.deny).toBeTruthy()
    await bash($, ATTRIBUTION)
    expect(calls.toasts).toHaveLength(1)
    expect(calls.toasts[0]).toMatch(/^base: event log not written: \S/)
    w.sid = 's2'
    await bash($, ATTRIBUTION)
    expect(calls.toasts).toHaveLength(2)
  })
})

describe('the sweep of old session directories', () => {
  const old = NOW - 8 * DAY
  const fresh = NOW - 6 * DAY
  const put = (w: any, path: string, mtimeMs: number) => (w.files[path] = { text: '{}\n', mtimeMs })
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const [OLD, FRESH, NESTED, OLD2, MIXED] = [1, 2, 3, 4, 5].map(id) as [string, string, string, string, string]

  t('a session directory whose newest file is past 7 days goes, once per session id; this session, a fresh one and a nested one stay', async ($, on) => {
    const { w, calls, clock } = world(on, { env: { HOME } })
    put(w, `${LOG}/${OLD}/base.jsonl`, old)
    put(w, `${LOG}/${OLD}/band.jsonl`, old - DAY)
    put(w, `${LOG}/${FRESH}/base.jsonl`, old)
    put(w, `${LOG}/${FRESH}/slim.jsonl`, fresh)
    put(w, `${LOG}/s1/base.jsonl`, old)
    put(w, `${LOG}/${NESTED}/deeper/x.jsonl`, old)
    await start($)
    await clock.settle()
    expect(calls.removed).toEqual([`${LOG}/${OLD}`])
    expect(Object.keys(w.files).filter(p => p.startsWith(`${LOG}/`)).sort()).toEqual(
      [`${LOG}/${FRESH}/base.jsonl`, `${LOG}/${FRESH}/slim.jsonl`, `${LOG}/${NESTED}/deeper/x.jsonl`, `${LOG}/s1/base.jsonl`].sort(),
    )
    put(w, `${LOG}/${OLD2}/base.jsonl`, old)
    await start($)
    await clock.settle()
    expect(calls.removed).toEqual([`${LOG}/${OLD}`])
  })

  t('only session-id names holding nothing but *.jsonl files: a dotfile directory or one with other files stays', async ($, on) => {
    const { w, calls, clock } = world(on, { env: { HOME } })
    put(w, `${LOG}/.ssh/id_ed25519`, old)
    put(w, `${LOG}/.ssh/base.jsonl`, old)
    put(w, `${LOG}/notes/base.jsonl`, old)
    put(w, `${LOG}/${MIXED}/base.jsonl`, old)
    put(w, `${LOG}/${MIXED}/notes.txt`, old)
    await start($)
    await clock.settle()
    expect(calls.removed).toEqual([])
  })

  t('a directory that resolves anywhere but its own place under the root stays', async ($, on) => {
    const { w, calls, clock } = world(on, { env: { HOME }, realPaths: { [`${LOG}/${OLD}`]: `/elsewhere/${OLD}` } })
    put(w, `${LOG}/${OLD}/base.jsonl`, old)
    await start($)
    await clock.settle()
    expect(calls.removed).toEqual([])
  })

  t('a root that resolves anywhere but its own spelling (a link, maybe to ~) is never swept', async ($, on) => {
    const { w, calls, clock } = world(on, {
      env: { HOME },
      realPaths: { [LOG]: HOME, [`${LOG}/${OLD}`]: `${HOME}/${OLD}` },
    })
    put(w, `${LOG}/${OLD}/base.jsonl`, old)
    await start($)
    await clock.settle()
    expect(calls.removed).toEqual([])
  })

  t('never under a DOMAINE_LOG_DIR, never without HOME', async ($, on) => {
    const { w, calls, clock } = world(on, { env: { DOMAINE_LOG_DIR: '/var/log/domaine' } })
    put(w, `/var/log/domaine/${OLD}/base.jsonl`, old)
    put(w, `${LOG}/${OLD}/base.jsonl`, old)
    await start($)
    await clock.settle()
    expect(calls.removed).toEqual([])
    expect(calls.fs.filter(f => f.startsWith('list '))).not.toContain('list /var/log/domaine')
  })
})

describe('/base-doctor', () => {
  t("passes the session's log directory to doctor.cjs", async ($, on) => {
    const { calls } = world(on, { env: { HOME }, manifest: '{ "name": "base", "version": "0.1.0" }', run: () => ran(0, JSON.stringify({ root: '/p', rows: [] })) })
    await start($)
    await run($, '', 'base-doctor')
    const argv = calls.runs.find(r => String(r.argv[1]).endsWith('/scripts/doctor.cjs'))?.argv ?? []
    expect(argv.slice(5)).toEqual(['--project', ROOT, '--log-dir', `${LOG}/s1`])
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

  test('the cap: 2000 lines, then 256 KB, the newest line always kept', () => {
    const many = Array.from({ length: FILE_LINES }, (_, i) => `l${i}`)
    const capped = capLines(many, 'new')
    expect(capped).toHaveLength(FILE_LINES)
    expect(capped[0]).toBe('l1')
    expect(capped[capped.length - 1]).toBe('new')
    const kb = 'é'.repeat(512)
    const big = capLines(Array.from({ length: 300 }, () => kb), kb)
    expect(big.length * 1025).toBeLessThanOrEqual(FILE_BYTES)
    expect(big.length).toBe(Math.floor(FILE_BYTES / 1025))
    expect(capLines([], 'x'.repeat(FILE_BYTES * 2))).toHaveLength(1)
  })

  test('seedLines keeps the session and skips what does not parse', () => {
    expect(seedLines(`${line('s1', 'start', 'a')}\nnot json\n${line('s2', 'guard', 'b')}\n${line('s1', 'guard', 'c')}\n`, 's1')).toEqual([
      line('s1', 'start', 'a'),
      line('s1', 'guard', 'c'),
    ])
  })

  test('seedLines caps a file past the limit once, keeping the newest lines', () => {
    const lines = Array.from({ length: FILE_LINES + 5 }, (_, i) => line('s1', 'guard', `g${i}`))
    const seeded = seedLines(`${lines.join('\n')}\n`, 's1')
    expect(seeded).toHaveLength(FILE_LINES)
    expect(seeded[0]).toBe(lines[5])
    expect(seeded[seeded.length - 1]).toBe(lines[lines.length - 1])
  })

  test('nextLines: a start line first, one per session', () => {
    const ev = { atMs: NOW, kind: 'guard' as const, text: 'g' }
    expect(nextLines([], ev, '0.1.0', 's1')).toEqual([line('s1', 'start', 'base 0.1.0'), line('s1', 'guard', 'g')])
    expect(nextLines([line('s1', 'start', 'base 0.1.0')], { atMs: NOW, kind: 'start', text: 'base 0.1.0' }, '0.1.0', 's1')).toBe(null)
    expect(LOG_TTL_MS).toBe(7 * DAY)
  })
})
