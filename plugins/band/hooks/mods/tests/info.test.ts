import { describe, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { peek, start, test } from './world.tsx'

const MANIFEST = /^\/.+\/plugins\/band\/\.claude-plugin\/plugin\.json$/
const VERSION = '0.0.0-kit'

/**
 * The engine beneath band's info hooks. The kit's `$` has no file system, so the manifest is the test's: a
 * version no release carries, which band can only report by reading the file it asks for.
 */
function world(on: On, o: { manifest?: string | null; registerThrows?: boolean } = {}) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, {})
  const w = { sid: 's1', reads: [] as { path: string; plugin: string }[], registers: [] as string[] }
  on('fs.read', async (_$, e, next: any) => {
    w.reads.push({ path: e.path, plugin: next.origin?.plugin })
    if (o.manifest === null) throw new Error('ENOENT')
    return { value: o.manifest ?? JSON.stringify({ name: 'band', version: VERSION }) }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: w.sid }))
  on('session.model', async () => ({ value: 'claude-fable-5-1' }))
  on('session.usage', async () => ({ value: { startedAt: 1, context: { window: 200_000 }, rateLimits: [] } }))
  on('command.register', async (_$, e) => {
    w.registers.push(e.name)
    if (o.registerThrows) throw new Error('refused')
    return { value: { command: e.name } }
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  return w
}

/** A plugin beneath band (tier append): what band.info held when band's session.start called next. */
const BENEATH = {
  name: 'beneath',
  tier: 'append' as const,
  register(on: On) {
    let seen: unknown = 'not run'
    on('session.start', async ($: any, e: any, next: any) => {
      seen = (await $.state.get({ plugin: 'band', key: 'info' })).value ?? null
      return next(e)
    })
    on('command.run', { command: 'seen' } as any, async () => ({ text: JSON.stringify(seen) }))
  },
}

const submit = ($: any, text = 'hi') => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as any)
const ALL = ['band-log', 'band-progress', 'band-debug']

describe('band.info', () => {
  test('{ v: 1, version from band\'s own manifest, disabled: false }', async ($, on) => {
    const w = world(on)
    expect((await peek($)).info).toBeNull()
    await start($)
    expect((await peek($)).info).toEqual({ v: 1, version: VERSION, disabled: false })
    expect(w.reads).toHaveLength(1)
    expect(w.reads[0]?.path).toMatch(MANIFEST)
    expect(w.reads[0]?.plugin).toBe('band')
  })

  test('the disabled option → disabled: true', { options: { disabled: true } }, async ($, on) => {
    world(on)
    await start($)
    expect((await peek($)).info).toEqual({ v: 1, version: VERSION, disabled: true })
  })

  for (const [name, manifest] of [
    ['an unreadable manifest', null],
    ['a manifest that is not JSON', '{not json'],
    ['a version that is no string', JSON.stringify({ version: 1 })],
    ['an empty version', JSON.stringify({ version: '' })],
  ] as const) {
    test(`${name} → version 'unknown', the snapshot still written`, async ($, on) => {
      world(on, { manifest })
      await start($)
      expect((await peek($)).info).toEqual({ v: 1, version: 'unknown', disabled: false })
    })
  }

  test('written before next: a plugin beneath session.start already reads it', { plugins: [BENEATH] }, async ($, on) => {
    world(on)
    await start($)
    expect(JSON.parse((await $.command.run({ command: 'seen', args: '' })).text)).toEqual({ v: 1, version: VERSION, disabled: false })
  })
})

describe('commands', () => {
  test('registered once at start; the first prompt does not register again; a new session id registers all three', async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.registers).toEqual(ALL)
    await submit($)
    await submit($, 'again')
    expect(w.registers).toEqual(ALL)
    w.sid = 's2'
    await submit($)
    expect(w.registers).toEqual([...ALL, ...ALL])
    await submit($)
    expect(w.registers).toHaveLength(6)
  })

  test('a refused register fails neither session.start nor prompt.submit', async ($, on) => {
    const w = world(on, { registerThrows: true })
    expect(await start($)).toEqual({ cwd: '/repo' })
    expect((await peek($)).info).toEqual({ v: 1, version: VERSION, disabled: false })
    w.sid = 's2'
    expect((await submit($, 'q')).text).toBe('q')
    expect(w.registers).toEqual([...ALL, ...ALL])
  })
})
