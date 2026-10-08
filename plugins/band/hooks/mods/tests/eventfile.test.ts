import { describe, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { FILE_CAP_BYTES, FILE_CAP_LINES, capLines, fileLine, logDir, seedLines } from '../events.ts'
import { T0, logged, test } from './world.tsx'

/** Every test gets its own HOME, so no module-held file of an earlier test is mistaken for this one's. */
let homes = 0

/**
 * The engine beneath band's writers with an in-memory file system: `files` holds what band.jsonl reads back,
 * `writes` every whole-file write of it in order; `writeError` makes each write of it reject.
 */
function world(on: On, env: Record<string, string | undefined> = {}) {
  const home = `/home/u${++homes}`
  const w = {
    home,
    sid: `s-${homes}`,
    vars: { HOME: home, ...env } as Record<string, string | undefined>,
    files: {} as Record<string, string>,
    writes: [] as { path: string; text: string }[],
    writeError: null as string | null,
    toasts: [] as string[],
    model: 'claude-fable-5-1',
    clock: mock.clock(on, { now: T0 }),
  }
  mock.store(on)
  on('env.get', async (_$, e) => ({ value: w.vars[e.name] }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('fs.read', async (_$, e) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: JSON.stringify({ name: 'band', version: '9.9.9' }) }
    if (e.path in w.files) return { value: w.files[e.path]! }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.exists', async (_$, e) => ({ value: e.path in w.files }))
  on('fs.write', async (_$, e) => {
    if (!e.path.endsWith('/band.jsonl')) return { value: undefined }
    if (w.writeError !== null) throw new Error(w.writeError)
    w.writes.push({ path: e.path, text: e.text })
    w.files[e.path] = e.text
    return { value: undefined }
  })
  on('session.id', async () => ({ value: w.sid }))
  on('session.model', async () => ({ value: w.model }))
  on('session.usage', async () => ({ value: { startedAt: T0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.surfaces', async () => ({ value: ['terminal'] }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('classic.PostModelSwitch', async () => ({}) as never)
  on('ui.toast', async (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  return w
}

const start = ($: any) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const switchTo = ($: any, w: ReturnType<typeof world>, m: string) => {
  w.model = m
  return $.classic.PostModelSwitch({ from_model: 'x', to_model: m, source: 'command', prompt_cache_warm: true } as any)
}
const pathOf = (w: ReturnType<typeof world>, dir = `${w.home}/.claude/domaine/log`) => `${dir}/${w.sid}/band.jsonl`
const linesOf = (text: string | undefined) => (text ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))

describe('band.jsonl', () => {
  test("the start line is kind start, text `band <version>`; each line carries band's name, version, session, agent and the event's time", async ($, on) => {
    const w = world(on)
    await start($)
    await w.clock.advance(60_000)
    await switchTo($, w, 'claude-opus-5-5')
    const path = pathOf(w)
    expect(w.writes.map(x => x.path)).toEqual([path, path])
    expect(linesOf(w.files[path])).toEqual([
      { ts: new Date(T0).toISOString(), plugin: 'band', version: '9.9.9', session: w.sid, kind: 'start', agent: 'main', text: 'band 9.9.9' },
      { ts: new Date(T0 + 60_000).toISOString(), plugin: 'band', version: '9.9.9', session: w.sid, kind: 'model', agent: 'main', text: 'claude-opus-5-5' },
    ])
    expect(w.files[path]!.endsWith('}\n')).toBe(true)
    // The published list keeps its own wording of the start line.
    expect(await logged($)).toEqual(['session start · band 9.9.9', 'model claude-opus-5-5'])
  })

  test('every write is the whole file, oldest first; /clear adds `session clear`', async ($, on) => {
    const w = world(on)
    await start($)
    await switchTo($, w, 'claude-opus-5-5')
    await $.session.end({ reason: 'clear', sessionId: w.sid, resume: {} } as any)
    expect(w.writes.map(x => linesOf(x.text).map(l => `${l.kind} ${l.text}`))).toEqual([
      ['start band 9.9.9'],
      ['start band 9.9.9', 'model claude-opus-5-5'],
      ['start band 9.9.9', 'model claude-opus-5-5', 'session clear'],
    ])
  })

  test('a new session id starts its own file with a start line; the old one stays as written', async ($, on) => {
    const w = world(on)
    await start($)
    const first = pathOf(w)
    w.sid = `${w.sid}-next`
    await switchTo($, w, 'claude-opus-5-5')
    expect(linesOf(w.files[first]).map(l => l.kind)).toEqual(['start'])
    expect(linesOf(w.files[pathOf(w)]).map(l => [l.session, l.kind, l.text])).toEqual([
      [w.sid, 'start', 'band 9.9.9'],
      [w.sid, 'model', 'claude-opus-5-5'],
    ])
  })

  test('/clear: `session clear` closes the old file, the next session id opens with its own start line', async ($, on) => {
    const w = world(on)
    await start($)
    const old = pathOf(w)
    await $.session.end({ reason: 'clear', sessionId: w.sid, resume: {} } as any)
    w.sid = `${w.sid}-cleared`
    await switchTo($, w, 'claude-opus-5-5')
    expect(linesOf(w.files[old]).map(l => `${l.kind} ${l.text}`)).toEqual(['start band 9.9.9', 'session clear'])
    expect(linesOf(w.files[pathOf(w)]).map(l => `${l.kind} ${l.text}`)).toEqual(['start band 9.9.9', 'model claude-opus-5-5'])
  })

  test('a resume under a new session id opens its file with a start line, then `session resume`', async ($, on) => {
    const w = world(on)
    on('classic.SessionStart', async () => ({}) as never)
    await start($)
    w.sid = `${w.sid}-resumed`
    await $.classic.SessionStart({ source: 'resume' } as any)
    expect(linesOf(w.files[pathOf(w)]).map(l => `${l.kind} ${l.text}`)).toEqual(['start band 9.9.9', 'session resume'])
  })

  test("a fresh module seeds from the file: this session's lines stay, another session's and junk go", async ($, on) => {
    const w = world(on)
    const path = pathOf(w)
    const mine = fileLine(T0 - 1000, '9.9.8', w.sid, 'model', 'claude-haiku-4-5-20251001')
    w.files[path] = [mine, 'not json', fileLine(T0 - 500, '9.9.8', 'other', 'model', 'x'), ''].join('\n')
    await start($)
    expect(linesOf(w.files[path]).map(l => `${l.session === w.sid} ${l.kind} ${l.text}`)).toEqual([
      'true model claude-haiku-4-5-20251001',
      'true start band 9.9.9',
    ])
  })

  test('a fresh process resuming a session whose file has a start line adds no second one', async ($, on) => {
    const w = world(on)
    const path = pathOf(w)
    w.files[path] = `${fileLine(T0 - 1000, '9.9.8', w.sid, 'start', 'band 9.9.8')}\n`
    await start($)
    await switchTo($, w, 'claude-opus-5-5')
    expect(linesOf(w.files[path]).map(l => `${l.kind} ${l.text}`)).toEqual(['start band 9.9.8', 'model claude-opus-5-5'])
    // The list is this process's own and still opens with its start line.
    expect(await logged($)).toEqual(['session start · band 9.9.9', 'model claude-opus-5-5'])
  })

  test('a reload (session.start again) writes no second start line and keeps the record', async ($, on) => {
    const w = world(on)
    await start($)
    await start($)
    await switchTo($, w, 'claude-opus-5-5')
    expect(linesOf(w.files[pathOf(w)]).map(l => l.kind)).toEqual(['start', 'model'])
  })

  test('an absolute DOMAINE_LOG_DIR replaces ~/.claude/domaine/log; the session folder is still made under it', async ($, on) => {
    const w = world(on, { DOMAINE_LOG_DIR: '/var/logs/domaine/' })
    await start($)
    expect(w.writes.map(x => x.path)).toEqual([pathOf(w, '/var/logs/domaine')])
  })

  test('a relative DOMAINE_LOG_DIR is ignored: the log never lands in the project', async ($, on) => {
    const w = world(on, { DOMAINE_LOG_DIR: 'logs' })
    await start($)
    expect(w.writes.map(x => x.path)).toEqual([pathOf(w)])
  })

  test('no HOME and no DOMAINE_LOG_DIR → no file, no toast; the list still fills', async ($, on) => {
    const w = world(on, { HOME: undefined })
    await start($)
    await switchTo($, w, 'claude-opus-5-5')
    expect(w.writes).toEqual([])
    expect(w.toasts).toEqual([])
    expect(await logged($)).toEqual(['session start · band 9.9.9', 'model claude-opus-5-5'])
  })

  test('BAND_EVENT_LOG=0 → neither the file nor the list', async ($, on) => {
    const w = world(on, { BAND_EVENT_LOG: '0' })
    await start($)
    await switchTo($, w, 'claude-opus-5-5')
    expect(w.writes).toEqual([])
    expect(await logged($)).toEqual([])
  })

  test('a failing write toasts once per session and never reaches the hook; the list still fills', async ($, on) => {
    const w = world(on)
    w.writeError = 'EACCES: permission denied'
    await start($)
    await switchTo($, w, 'claude-opus-5-5')
    // A throwing test hook is skipped, so the engine's own refusal is the reason band sees.
    expect(w.toasts.filter(t => t.startsWith('band:'))).toEqual([expect.stringMatching(/^band: event log not written: \S/)])
    expect(await logged($)).toEqual(['session start · band 9.9.9', 'model claude-opus-5-5'])
    // Once writes work again, the lines that failed are in the file too.
    w.writeError = null
    await switchTo($, w, 'claude-fable-5-1')
    expect(linesOf(w.files[pathOf(w)]).map(l => l.kind)).toEqual(['start', 'model', 'model'])
  })
})

describe('file helpers', () => {
  test('logDir: an absolute override, else an absolute HOME, else null; the same rule as base and slim', () => {
    expect(logDir('/Users/a', undefined, 's1')).toBe('/Users/a/.claude/domaine/log/s1')
    expect(logDir('/Users/a/', '/tmp/x//', 's1')).toBe('/tmp/x/s1')
    expect(logDir('/Users/a', '/logs ', 's1')).toBe('/logs/s1')
    expect(logDir(' /Users/a ', undefined, 's1')).toBe('/Users/a/.claude/domaine/log/s1')
    expect(logDir('/Users/a', 'C:/logs', 's1')).toBe('/Users/a/.claude/domaine/log/s1')
    expect(logDir(undefined, 'C:\\logs', 's1')).toBeNull()
    expect(logDir(undefined, 'rel/dir', 's1')).toBeNull()
    expect(logDir('home/u', undefined, 's1')).toBeNull()
    expect(logDir('', '', 's1')).toBeNull()
    expect(logDir(undefined, undefined, 's1')).toBeNull()
    expect(logDir('/Users/a', undefined, '../etc')).toBeNull()
    expect(logDir('/Users/a', undefined, '..')).toBeNull()
    expect(logDir('/Users/a', undefined, '')).toBeNull()
  })

  test('seedLines keeps only parseable lines of the session', () => {
    const a = fileLine(1, '1', 's1', 'model', 'a')
    expect(seedLines(`${a}\n{"session":"s2"}\n{oops\n\n`, 's1')).toEqual([a])
    expect(seedLines('', 's1')).toEqual([])
  })

  test(`capLines: past ${FILE_CAP_LINES} lines or ${FILE_CAP_BYTES / 1024} KB the oldest go`, () => {
    const many = Array.from({ length: FILE_CAP_LINES + 5 }, (_, i) => `#${i}`)
    const kept = capLines(many)
    expect(kept).toHaveLength(FILE_CAP_LINES)
    expect(kept[0]).toBe('#5')
    expect(kept.at(-1)).toBe(`#${FILE_CAP_LINES + 4}`)
    // 100 lines of 4 KB (each `ж` is two UTF-8 bytes): 63 lines of 4097 bytes fit 256 KB, 64 do not.
    const big = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(2, '0')}${'ж'.repeat(2047)}`)
    const fit = capLines(big)
    expect(fit).toHaveLength(63)
    expect(fit.at(-1)).toBe(big.at(-1))
  })
})
