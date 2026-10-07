import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ALL = ['mcp', 'bash', 'read', 'webfetch', 'websearch', 'grep', 'glob', 'agent']

/** A sibling plugin reading slim.info, as fnd's FND_COMPRESSION=proxy check does. */
const PEEK = {
  name: 'peek',
  register(on: On) {
    on('command.run', { command: 'peek-info' } as any, async ($: any) => ({
      text: JSON.stringify((await $.state.get({ plugin: 'slim', key: 'info' })).value ?? null),
    }))
  },
}
const info = async ($: any) => JSON.parse((await $.command.run({ command: 'peek-info', args: '' })).text)

/**
 * The kit's `$` has no file system, so the manifest is the test's: a version no release carries, which
 * slim can only report by reading the file it asks for.
 */
function world(on: On, env: Record<string, string> = {}, manifest: string | null = null) {
  mock.store(on)
  mock.env(on, env)
  const version = '0.0.0-kit'
  const reads: string[] = []
  on('fs.read', async (_$, e) => {
    reads.push(e.path)
    if (!e.path.endsWith('/.claude-plugin/plugin.json')) throw new Error('ENOENT')
    return { value: manifest ?? JSON.stringify({ name: 'slim', version }) }
  })
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__slim__${e.name}` } }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  return { version, reads }
}
const start = ($: any) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

describe('slim.info at session.start', () => {
  test('I1 the version from the manifest beside the module, every channel on', { plugins: [PEEK] }, async ($, on) => {
    const w = world(on)
    expect(await info($)).toBeNull()
    await start($)
    expect(w.reads).toHaveLength(1)
    expect(w.reads[0]).toMatch(/\/\.claude-plugin\/plugin\.json$/)
    expect(await info($)).toEqual({ v: 1, version: w.version, channels: ALL })
  })

  test('I2 a switch at 0 drops its channels', { plugins: [PEEK] }, async ($, on) => {
    world(on, { SLIM_BASH: '0', SLIM_WEB: '0' })
    await start($)
    expect((await info($)).channels).toEqual(['mcp', 'read', 'grep', 'glob', 'agent'])
  })

  test("I3 an unreadable manifest → version 'unknown', the snapshot still written", { plugins: [PEEK] }, async ($, on) => {
    world(on, {}, '{not json')
    await start($)
    expect(await info($)).toEqual({ v: 1, version: 'unknown', channels: ALL })
  })
})
