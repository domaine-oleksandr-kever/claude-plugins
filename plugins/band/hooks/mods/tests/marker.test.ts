import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Opts = { env?: Record<string, string>; sid?: string; writeThrows?: boolean; writeHangs?: boolean; idThrows?: boolean }

/** `log` records session-id reads, marker writes, command registers and the bottom prompt.submit in call order; `w.sid` is the live session id. */
function world(on: On, o: Opts = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, o.env ?? {})
  const w = { sid: o.sid ?? 's1' }
  const log: string[] = []
  const writes: { path: string; text: unknown }[] = []
  const bottom: unknown[] = []
  let ids = 0
  on('session.id', async () => {
    log.push('id')
    if (o.idThrows && ids++ === 0) throw new Error('no session')
    return { value: w.sid }
  })
  on('command.register', async (_$, e) => {
    log.push(`register ${e.name}`)
    return { value: { command: e.name } }
  })
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('ui.toast', async () => ({ value: undefined }))
  let attempts = 0
  on('fs.write', async (_$, e: any) => {
    if (!String(e.path).includes('/fnd-mod-session-')) return { value: undefined }
    attempts++
    if (o.writeThrows) throw new Error('EACCES')
    if (o.writeHangs) return new Promise<never>(() => {})
    writes.push({ path: e.path, text: e.text })
    log.push(`write ${e.path}`)
    return { value: undefined }
  })
  on('prompt.submit', async (_$, e) => {
    bottom.push({ text: e.text, context: e.context, origin: e.origin })
    log.push('bottom')
    return { text: e.text, ...(e.context ? { context: e.context } : {}) }
  })
  return { w, log, writes, bottom, clock, attempts: () => attempts }
}

const submit = ($: any, text = 'hi', extra: Record<string, unknown> = {}) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...extra } as any)

const TMP = { TMPDIR: '/sandbox' }

describe('marker', () => {
  test('the first prompt writes one empty marker under TMPDIR, before the hooks beneath', async ($, on) => {
    const { writes, log } = world(on, { env: TMP })
    await submit($)
    expect(writes).toEqual([{ path: '/sandbox/fnd-mod-session-s1', text: '' }])
    expect(log.filter(l => l === 'bottom' || l.startsWith('write '))).toEqual(['write /sandbox/fnd-mod-session-s1', 'bottom'])
  })

  test('every prompt rewrites the marker: the classic side trusts only a fresh mtime', async ($, on) => {
    const { writes, bottom } = world(on, { env: TMP })
    await submit($)
    await submit($, 'again')
    expect(writes.map(x => x.path)).toEqual(['/sandbox/fnd-mod-session-s1', '/sandbox/fnd-mod-session-s1'])
    expect(bottom.length).toBe(2)
  })

  test("written before the hooks beneath; band's own prompt.submit then registers its commands for the new session", async ($, on) => {
    const { log } = world(on, { env: TMP })
    await submit($)
    expect(log).toEqual([
      'id',
      'write /sandbox/fnd-mod-session-s1',
      'bottom',
      'id',
      'register band-log',
      'register band-progress',
      'register band-debug',
    ])
  })

  test('disabled: no marker is written and the prompt passes unchanged', { options: { disabled: true } }, async ($, on) => {
    const { writes, bottom, attempts } = world(on, { env: TMP })
    const r = await submit($, 'q', { context: ['c'] })
    await submit($, 'again')
    expect(r.drop).toBe(undefined)
    expect(bottom).toEqual([
      { text: 'q', context: ['c'], origin: { kind: 'composer' } },
      { text: 'again', context: undefined, origin: { kind: 'composer' } },
    ])
    expect(writes).toEqual([])
    expect(attempts()).toBe(0)
  })

  test('after /clear the next prompt under the new session id writes its own marker', async ($, on) => {
    const { w, writes } = world(on, { env: TMP })
    await submit($)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as any)
    w.sid = 's2'
    await submit($)
    expect(writes.map(x => x.path)).toEqual(['/sandbox/fnd-mod-session-s1', '/sandbox/fnd-mod-session-s2'])
  })

  test('the session id keeps only [A-Za-z0-9_.-]', async ($, on) => {
    const { writes } = world(on, { env: TMP, sid: 'a/b c:D_9.-é$' })
    await submit($)
    expect(writes.map(x => x.path)).toEqual(['/sandbox/fnd-mod-session-abcD_9.-'])
  })

  test('the hook passes text, context and origin through unchanged', async ($, on) => {
    const { bottom } = world(on, { env: TMP })
    const r = await submit($, 'q', { context: ['prior'], origin: { kind: 'bridge' } })
    expect(bottom).toEqual([{ text: 'q', context: ['prior'], origin: { kind: 'bridge' } }])
    expect(r.drop).toBe(undefined)
  })
})

describe('tmpdir', () => {
  const cases: [string, Record<string, string>, string][] = [
    ['TMPDIR, trailing slashes dropped', { TMPDIR: '/var/t//', TMP: '/x', TEMP: '/y' }, '/var/t'],
    ['TMP when TMPDIR is unset', { TMP: '/tmp2/', TEMP: '/y' }, '/tmp2'],
    ['TEMP when TMPDIR and TMP are unset', { TEMP: '/tmp3' }, '/tmp3'],
    ['/tmp when none is set', {}, '/tmp'],
    ['an empty TMPDIR falls through', { TMPDIR: '', TMP: '/tmp4' }, '/tmp4'],
  ]
  for (const [name, env, dir] of cases) {
    test(name, async ($, on) => {
      const { writes } = world(on, { env })
      await submit($)
      expect(writes.map(x => x.path)).toEqual([`${dir}/fnd-mod-session-s1`])
    })
  }

  test('a bare / joins as path.join does', async ($, on) => {
    const { writes } = world(on, { env: { TMPDIR: '/' } })
    await submit($)
    expect(writes.map(x => x.path)).toEqual(['/fnd-mod-session-s1'])
  })
})

describe('failures never touch the prompt', () => {
  test('a throwing fs.write → the prompt reaches the bottom unchanged', async ($, on) => {
    const { bottom, writes } = world(on, { env: TMP, writeThrows: true })
    const r = await submit($, 'q', { context: ['c'] })
    expect(r.drop).toBe(undefined)
    expect(bottom).toEqual([{ text: 'q', context: ['c'], origin: { kind: 'composer' } }])
    expect(writes).toEqual([])
  })

  test('a failed write is not retried for the rest of that session', async ($, on) => {
    const { attempts, bottom } = world(on, { env: TMP, writeThrows: true })
    await submit($)
    await submit($, 'again')
    expect(attempts()).toBe(1)
    expect(bottom.length).toBe(2)
  })

  test('a stalled fs.write holds the prompt no longer than MARK_MS', async ($, on) => {
    const { bottom, clock, attempts } = world(on, { env: TMP, writeHangs: true })
    const r = submit($, 'q')
    await clock.advance(500)
    expect((await r).drop).toBe(undefined)
    expect(bottom).toEqual([{ text: 'q', context: undefined, origin: { kind: 'composer' } }])
    await submit($, 'again')
    expect(attempts()).toBe(1)
  })

  test('a throwing session.id → the prompt reaches the bottom unchanged, no write', async ($, on) => {
    const { bottom, writes } = world(on, { env: TMP, idThrows: true })
    const r = await submit($, 'q')
    expect(r.drop).toBe(undefined)
    expect(bottom).toEqual([{ text: 'q', context: undefined, origin: { kind: 'composer' } }])
    expect(writes).toEqual([])
  })
})
