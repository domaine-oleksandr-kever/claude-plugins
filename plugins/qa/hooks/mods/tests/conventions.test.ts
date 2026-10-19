import { describe, expect, mock, test } from 'claude-code/testing'
import { HOME, MARKER, block, context, subagent, world } from './world.ts'

const names = (r: any) => r.blocks.map((b: any) => b.name)

describe('the cloud fallback: a prompt.context block', () => {
  test("nothing draws and no marker: the sections as one block after the engine's, the root filled in", async ($, on) => {
    world(on, { surfaces: [], env: { HOME } })
    const r = await context($)
    expect(names(r)).toEqual(['claudeMd', 'qaConventions'])
    const text = r.blocks[1].text as string
    const [root, passwords] = text.split('\n\n## ')
    expect(root).toMatch(/^qa plugin root: \/\S*$/)
    expect(`## ${passwords}`).toBe('## qa convention — storefront passwords\n\n<base root> stays literal')
  })

  test("the SessionStart command hook's marker for this session id: no block", async ($, on) => {
    const { w } = world(on, { surfaces: [], env: { HOME } })
    w.files[MARKER] = { text: '{}', mtimeMs: 0 }
    expect(names(await context($))).toEqual(['claudeMd'])
    w.sid = 's2'
    expect(await block($)).toStartWith('qa plugin root: /')
  })

  test('DOMAINE_LOG_DIR moves the marker it looks for', async ($, on) => {
    const { w } = world(on, { surfaces: [], env: { HOME, DOMAINE_LOG_DIR: '/var/log/domaine' } })
    w.files[MARKER] = { text: '{}', mtimeMs: 0 }
    expect(await block($)).toBeDefined()
    w.files['/var/log/domaine/s1/conventions.qa.json'] = { text: '{}', mtimeMs: 0 }
    expect(await block($)).toBeUndefined()
  })

  test('a marker under the spare root (TMPDIR, else /tmp) counts: the hook wrote it there without a writable log dir', async ($, on) => {
    const { w } = world(on, { surfaces: [], env: { TMPDIR: '/var/tmp/' } })
    expect(await block($)).toBeDefined()
    w.files['/var/tmp/domaine-log/s1/conventions.qa.json'] = { text: '{}', mtimeMs: 0 }
    expect(await block($)).toBeUndefined()
  })

  test('a session a surface draws: no block, marker or not', async ($, on) => {
    world(on, { env: { HOME } })
    expect(names(await context($))).toEqual(['claudeMd'])
  })

  test('an unreadable text file: no block, the prompt goes on', async ($, on) => {
    const { w } = world(on, { surfaces: [] })
    const root = (await block($))!.split('\n')[0]!.slice('qa plugin root: '.length)
    w.files[`${root}/hooks/conventions-text.json`] = { text: 'not json', mtimeMs: 0 }
    expect(names(await context($))).toEqual(['claudeMd'])
  })
})

describe('classic.SubagentStart', () => {
  test('qa adds nothing in the module (the command hook has no SubagentStart entry); context from beneath passes through', async ($, on) => {
    const { w } = world(on)
    expect((await subagent($, 'general-purpose')).additionalContext ?? []).toEqual([])
    w.subagentBelow = ['from below']
    expect((await subagent($, 'general-purpose')).additionalContext).toEqual(['from below'])
  })
})

test('the module loads under the bare engine too', async ($, on) => {
  mock.clock(on, { now: 1 })
  mock.store(on)
  mock.env(on, {})
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  expect(await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })).toEqual({ cwd: '/x' })
})
