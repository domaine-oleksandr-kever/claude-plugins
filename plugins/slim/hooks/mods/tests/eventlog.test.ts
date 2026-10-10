import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { FILE_BYTES, FILE_LINES, fileLine, keep, logDir, seedLines } from '../eventlog.ts'

const VIEW = 'mcp__slim__view'
const NOW = 1_760_000_000_000
const TS = new Date(NOW).toISOString()
const VERSION = '0.0.0-kit'
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const REPLY = { v: 1, decision: 'compressed', engine: 'json', figure: 'slim: compressed', text: '{}', bytesIn: 118_000, bytesOut: 29_000, stages: [] }

/** Reads slim's events from beside it. */
const PEEK = {
  name: 'peek',
  register(on: On) {
    on('command.run', { command: 'peek-slim' } as any, async ($: any) => ({
      text: JSON.stringify((await $.state.get({ plugin: 'slim', key: 'events' })).value ?? []),
    }))
  },
}
const events = async ($: any): Promise<any[]> => JSON.parse((await $.command.run({ command: 'peek-slim', args: '' })).text)

type Opts = { env?: Record<string, string>; files?: Record<string, string>; writeFails?: string; writeMs?: number }
/** The kit's `$` has no file system: files and writes live in the world. Each test names its own session, or a getter for one that changes. */
function world(on: On, session: string | (() => string), o: Opts = {}) {
  mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, o.env ?? { HOME: '/home/u' })
  const w = { files: { ...(o.files ?? {}) } as Record<string, string>, writes: [] as string[], toasts: [] as string[] }
  on('session.id', async () => ({ value: typeof session === 'string' ? session : session() }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('session.root', async () => ({ value: '/repo' }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('fs.read', async (_$, e) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: JSON.stringify({ name: 'slim', version: VERSION }) }
    if (e.path in w.files) return { value: w.files[e.path]! }
    return { deny: `ENOENT: ${e.path}` } as any
  })
  on('fs.write', async (_$, e) => {
    if (o.writeMs) await new Promise(r => setTimeout(r, o.writeMs))
    w.writes.push(e.path)
    if (o.writeFails) return { deny: o.writeFails } as any
    w.files[e.path] = e.text
    return { value: undefined }
  })
  on('ui.toast', async (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('agent.list', async () => ({ value: [{ id: 'agent-7', description: 'd', type: 'core:jira-reader', status: 'running' }] as any }))
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__slim__${e.name}` } }))
  on('tool.check', async () => ({ decision: 'allow' }) as any)
  on('tool.call', async (_$, e) =>
    ({ result: { type: 'text', file: { filePath: (e as any).file_path, content: 'x', numLines: 1, startLine: 1, totalLines: 1 } }, text: 'x' }) as any)
  on('process.run', async () => ({ value: ok(JSON.stringify(REPLY)) as any }))
  return w
}
const start = ($: any) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const view = ($: any, extra: Record<string, unknown> = {}) => $.tool.call({ tool: VIEW, path: '/repo/issues.json', ...extra })
const lines = (text: string | undefined) => (text ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
const fileOf = (session: string, dir = '/home/u/.claude/domaine/log') => `${dir}/${session}/slim.jsonl`

describe('L1 the start line', () => {
  test('session.start publishes `slim <version>` to slim.events and writes it as the first file line', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, 'E1')
    await start($)
    expect((await events($)).map(e => [e.kind, e.text, e.src])).toEqual([['start', `slim ${VERSION}`, 'slim']])
    expect(w.files[fileOf('E1')]).toBe(
      `${JSON.stringify({ ts: TS, plugin: 'slim', version: VERSION, session: 'E1', kind: 'start', agent: 'main', text: `slim ${VERSION}` })}\n`,
    )
  })

  test('a second session.start of the same session writes no second start line', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, 'E2')
    await start($)
    await start($)
    expect((await events($)).filter(e => e.kind === 'start')).toHaveLength(1)
    expect(lines(w.files[fileOf('E2')]).map(l => l.kind)).toEqual(['start'])
  })
})

describe('L2 the file follows slim.events', () => {
  test('each published line is appended with kind and text as published, agent = the labelled subagent type, else main', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, 'E3')
    await start($)
    await view($)
    await view($, { agentId: 'agent-7' })
    const ev = await events($)
    const got = lines(w.files[fileOf('E3')])
    expect(got.map(l => [l.plugin, l.version, l.session, l.ts, l.kind, l.agent])).toEqual([
      ['slim', VERSION, 'E3', TS, 'start', 'main'],
      ['slim', VERSION, 'E3', TS, 'view', 'main'],
      ['slim', VERSION, 'E3', TS, 'view', 'jira-reader'],
    ])
    expect(got.map(l => l.text)).toEqual(ev.map(e => e.text))
    expect(got[2].text).toMatch(/^jira-reader · view issues\.json:/)
  })

  test('an absolute DOMAINE_LOG_DIR holds the session dir; a relative one is ignored', async ($, on) => {
    const w = world(on, 'E4', { env: { HOME: '/home/u', DOMAINE_LOG_DIR: '/logs/' } })
    await start($)
    expect(w.writes).toEqual(['/logs/E4/slim.jsonl'])
  })

  test('a relative DOMAINE_LOG_DIR falls back to HOME', async ($, on) => {
    const w = world(on, 'E5', { env: { HOME: '/home/u', DOMAINE_LOG_DIR: 'logs' } })
    await start($)
    expect(w.writes).toEqual([fileOf('E5')])
  })

  test('no HOME and no override: no file, silently; the list still gets the line', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, 'E6', { env: {} })
    await start($)
    await view($)
    expect(w.writes).toEqual([])
    expect(w.toasts).toEqual([])
    expect((await events($)).map(e => e.kind)).toEqual(['start', 'view'])
  })

  test('SLIM_EVENT_LOG=0: neither the list nor the file', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, 'E7', { env: { HOME: '/home/u', SLIM_EVENT_LOG: '0' } })
    await start($)
    await view($)
    expect(await events($)).toEqual([])
    expect(w.writes).toEqual([])
  })
})

describe('L3 reload and failure', () => {
  test("a file already there for this session is seeded and kept (hot reload, /clear); another session's lines are dropped", async ($, on) => {
    const mine = JSON.stringify({ ts: TS, plugin: 'slim', version: VERSION, session: 'E8', kind: 'view', agent: 'main', text: 'earlier' })
    const other = JSON.stringify({ ts: TS, plugin: 'slim', version: VERSION, session: 'X', kind: 'view', agent: 'main', text: 'foreign' })
    const w = world(on, 'E8', { files: { [fileOf('E8')]: `${other}\n${mine}\nnot json\n` } })
    await view($)
    await start($)
    expect(lines(w.files[fileOf('E8')]).map(l => [l.kind, l.text.slice(0, 7)])).toEqual([['view', 'earlier'], ['view', 'view is'], ['start', 'slim 0.']])
  })

  test('a file at the cap is seeded and stays at the cap: the oldest line goes, the new one lands last', async ($, on) => {
    const old = Array.from({ length: FILE_LINES }, (_, i) => JSON.stringify({ session: 'E10', text: `old ${i}` }))
    const w = world(on, 'E10', { files: { [fileOf('E10')]: `${old.join('\n')}\n` } })
    await view($)
    const got = lines(w.files[fileOf('E10')])
    expect(got).toHaveLength(FILE_LINES)
    expect([got[0].text, got.at(-1).kind]).toEqual(['old 1', 'view'])
  })

  test('lines before any session.start open with the start line and carry the manifest version', async ($, on) => {
    const w = world(on, 'E11')
    await view($)
    await view($)
    expect(lines(w.files[fileOf('E11')]).map(l => [l.kind, l.version])).toEqual([['start', VERSION], ['view', VERSION], ['view', VERSION]])
    expect(lines(w.files[fileOf('E11')])[0].text).toBe(`slim ${VERSION}`)
  })

  test('/clear: the new session id, which no session.start announces, opens its file with the start line', { plugins: [PEEK] }, async ($, on) => {
    let sid = 'E12'
    const w = world(on, () => sid)
    await start($)
    await view($)
    sid = 'E12-cleared'
    await view($)
    expect(lines(w.files[fileOf('E12')]).map(l => l.kind)).toEqual(['start', 'view'])
    expect(lines(w.files[fileOf('E12-cleared')]).map(l => [l.session, l.kind, l.text.slice(0, 7)])).toEqual([
      ['E12-cleared', 'start', 'slim 0.'],
      ['E12-cleared', 'view', 'view is'],
    ])
    // The start line is the file's own: the list keeps one per session.start.
    expect((await events($)).map(e => e.kind)).toEqual(['start', 'view', 'view'])
  })

  test('a fresh process resuming a session whose file has a start line adds no second one; the list still gets it', { plugins: [PEEK] }, async ($, on) => {
    const old = JSON.stringify({ ts: TS, plugin: 'slim', version: '0.0.0-old', session: 'E13', kind: 'start', agent: 'main', text: 'slim 0.0.0-old' })
    const w = world(on, 'E13', { files: { [fileOf('E13')]: `${old}\n` } })
    await start($)
    await view($)
    expect(lines(w.files[fileOf('E13')]).map(l => [l.kind, l.text.slice(0, 14)])).toEqual([['start', 'slim 0.0.0-old'], ['view', 'view issues.js']])
    expect((await events($)).map(e => e.kind)).toEqual(['start', 'view'])
  })

  test('a start line while an earlier write is still queued: the reopened file keeps that write', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, 'E14', { writeMs: 20 })
    await Promise.all([view($), start($)])
    expect(lines(w.files[fileOf('E14')]).map(l => l.kind).sort()).toEqual(['start', 'view'])
  })

  test('a failing write never fails the call and toasts once per session', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on, 'E9', { writeFails: 'EACCES: permission denied' })
    await start($)
    const r = await view($)
    expect(String(r.result)).toContain('slim: compressed')
    expect(w.writes).toHaveLength(2)
    expect(w.toasts).toEqual(['slim: event log not written: EACCES: permission denied'])
    expect((await events($)).map(e => e.kind)).toEqual(['start', 'view'])
  })
})

describe('L4 pure helpers', () => {
  test('logDir: override, HOME, neither, and a session id that is no plain name', () => {
    expect(logDir('/home/u', undefined, 'abc-1')).toBe('/home/u/.claude/domaine/log/abc-1')
    expect(logDir('/home/u/', '/var/log/x/', 'abc')).toBe('/var/log/x/abc')
    expect(logDir(undefined, undefined, 'abc')).toBeNull()
    expect(logDir('/home/u', undefined, '../etc')).toBeNull()
    expect(logDir('/home/u', undefined, '..')).toBeNull()
    expect(logDir('/home/u', undefined, '')).toBeNull()
  })

  test('fileLine: an unlisted subagent is `agent`', () => {
    const ev = { v: 1, atMs: NOW, kind: 'slim', text: 'agent · Bash: …', src: 'slim', tool: 'Bash', agentType: 'agent', channel: 'bash', bytesIn: 1, bytesOut: 1, engine: 'text', ms: 0 } as const
    expect(JSON.parse(fileLine(ev, '1.2.3', 'S'))).toEqual({ ts: TS, plugin: 'slim', version: '1.2.3', session: 'S', kind: 'slim', agent: 'agent', text: 'agent · Bash: …' })
  })

  test('keep holds the newest FILE_LINES lines and their byte count', () => {
    const k = { lines: [] as string[], bytes: 0 }
    for (let i = 1; i <= FILE_LINES + 1; i++) keep(k, String(i))
    expect(k.lines).toHaveLength(FILE_LINES)
    expect([k.lines[0], k.lines.at(-1)]).toEqual(['2', String(FILE_LINES + 1)])
    expect(k.bytes).toBe(k.lines.reduce((n, l) => n + l.length + 1, 0))
  })

  test('keep holds the file within FILE_BYTES, and a lone oversized line stays', () => {
    const big = 'x'.repeat(1023)
    const k = { lines: [] as string[], bytes: 0 }
    for (let i = 0; i < 300; i++) keep(k, big)
    expect(k.lines).toHaveLength(FILE_BYTES / 1024)
    expect(k.bytes).toBe(FILE_BYTES)
    const lone = { lines: [] as string[], bytes: 0 }
    keep(lone, 'y'.repeat(FILE_BYTES * 2))
    expect(lone.lines).toHaveLength(1)
  })

  test('seedLines keeps only parseable lines of the session', () => {
    const a = JSON.stringify({ session: 'S', text: 'a' })
    expect(seedLines(`${a}\n{"session":"T"}\n\ngarbage\n`, 'S')).toEqual({ lines: [a], bytes: a.length + 1 })
  })

  test('seedLines on a file past the cap keeps the newest lines that fit, by count and by bytes', () => {
    const line = (i: number, pad = 0) => JSON.stringify({ session: 'S', text: `${i}${'x'.repeat(pad)}` })
    const many = Array.from({ length: FILE_LINES + 50 }, (_, i) => line(i))
    const k = seedLines([...many, JSON.stringify({ session: 'T' })].join('\n'), 'S')
    expect(k.lines).toEqual(many.slice(50))
    expect(k.bytes).toBe(k.lines.reduce((n, l) => n + l.length + 1, 0))
    const fat = Array.from({ length: 400 }, (_, i) => line(i, 1000))
    const f = seedLines(fat.join('\n'), 'S')
    expect(f.bytes).toBeLessThanOrEqual(FILE_BYTES)
    expect(f.bytes + fat[399 - f.lines.length]!.length + 1).toBeGreaterThan(FILE_BYTES)
    expect(f.lines.at(-1)).toBe(fat[399])
    expect(seedLines(line(0, FILE_BYTES * 2), 'S').lines).toHaveLength(1)
  })
})
