import { describe, expect, mock, test } from 'claude-code/testing'
import { HOME, MARKER, block, compose, context, ours, put, ran, subagent, world } from './world.ts'

const rootOf = (text: string) => text.split(' ')[3]!
const heads = (text: string | undefined) => (text ?? '').split('\n\n').map(p => p.split('\n')[0])

describe('the cloud fallback: a prompt.context block', () => {
  test("nothing draws and no marker: the sections in order as one block after the engine's, the root filled in", async ($, on) => {
    world(on, { surfaces: [], env: { HOME } })
    const r = await context($)
    expect(r.blocks.map((b: any) => b.name)).toEqual(['claudeMd', 'feConventions'])
    const text = r.blocks[1].text as string
    const root = rootOf(text)
    expect(root).toStartWith('/')
    expect(heads(text)).toEqual([`fe plugin root: ${root} — fe writes \`<fe root>\` and \`<base root>\``, 'fe project profile: theme', '## fe convention — the progress series'])
    expect(r.blocks[1].text).not.toContain('<root>')
  })

  test("the SessionStart command hook's marker for this session id: no block", async ($, on) => {
    const { w } = world(on, { surfaces: [], env: { HOME } })
    w.files[MARKER] = { text: '{}', mtimeMs: 0 }
    expect((await context($)).blocks.map((b: any) => b.name)).toEqual(['claudeMd'])
    w.sid = 's2'
    expect(await block($)).toStartWith('fe plugin root: ')
  })

  test('DOMAINE_LOG_DIR moves the marker it looks for', async ($, on) => {
    const { w } = world(on, { surfaces: [], env: { HOME, DOMAINE_LOG_DIR: '/var/log/domaine' } })
    w.files[MARKER] = { text: '{}', mtimeMs: 0 }
    expect(await block($)).toBeDefined()
    w.files['/var/log/domaine/s1/conventions.fe.json'] = { text: '{}', mtimeMs: 0 }
    expect(await block($)).toBeUndefined()
  })

  test('a marker under the spare root (TMPDIR, else /tmp) counts: the hook wrote it there without a writable log dir', async ($, on) => {
    const { w } = world(on, { surfaces: [], env: { TMPDIR: '/var/tmp/' } })
    expect(await block($)).toBeDefined()
    w.files['/var/tmp/domaine-log/s1/conventions.fe.json'] = { text: '{}', mtimeMs: 0 }
    expect(await block($)).toBeUndefined()
  })

  test('a session a surface draws: no block, marker or not', async ($, on) => {
    world(on, { env: { HOME } })
    expect((await context($)).blocks.map((b: any) => b.name)).toEqual(['claudeMd'])
  })

  test('foundation with a toml and a .env: all six, store access with fe\'s root and base\'s placeholder kept', async ($, on) => {
    const { w } = world(on, { surfaces: [], profile: () => ran(0, 'foundation\n') })
    put(w, '.env')
    put(w, 'shopify.theme.toml')
    const text = (await block($))!
    const root = rootOf(text)
    expect(heads(text).slice(1)).toEqual([
      'fe project profile: foundation',
      '## fe convention — LiquidDoc and core',
      '## fe capability — live store access',
      'worktree copy list: shopify.theme.toml',
      `fe preview default: preview theme (${root}/references/session-theme.md)`,
      '## fe convention — the progress series',
    ])
    expect(text).toContain(`${root}/scripts/shopify-admin-gql.sh, <base root>/scripts/shopify-validate.cjs`)
    expect(text).not.toContain('never-read')
  })

  test('FE_PREVIEW_DEFAULT=0, in the env or the global env file: the local dev server line, as the start hook decides', async ($, on) => {
    const { w } = world(on, { surfaces: [], env: { HOME, FE_PREVIEW_DEFAULT: '0' } })
    put(w, 'shopify.theme.toml')
    expect(await block($)).toContain('fe preview default: local dev server (FE_PREVIEW_DEFAULT=0)')
  })

  test('FE_PREVIEW_DEFAULT=0 from ~/.config/domaine/env', async ($, on) => {
    const { w } = world(on, { surfaces: [], env: { HOME } })
    put(w, 'shopify.theme.toml')
    w.files[`${HOME}/.config/domaine/env`] = { text: 'X=1\nFE_PREVIEW_DEFAULT= 0\n', mtimeMs: 0 }
    const text = (await block($))!
    expect(text).toContain('fe preview default: local dev server (FE_PREVIEW_DEFAULT=0)')
    expect(text).not.toContain('fe preview default: preview theme')
  })

  test('profile none: a bare .env says nothing beyond root and profile', async ($, on) => {
    const { w } = world(on, { surfaces: [], profile: () => ran(0, 'none\n') })
    put(w, '.env')
    expect(heads(await block($)).slice(1)).toEqual(['fe project profile: none'])
  })

  test('an unreadable text file: no block, the prompt goes on', async ($, on) => {
    const { w } = world(on, { surfaces: [] })
    const root = rootOf((await block($))!)
    w.sid = 's2'
    w.files[`${root}/hooks/conventions-text.json`] = { text: 'not json', mtimeMs: 0 }
    expect((await context($)).blocks.map((b: any) => b.name)).toEqual(['claudeMd'])
  })
})

describe('the mods deliver nothing else', () => {
  test('prompt.compose: no fe section, whatever the profile', async ($, on) => {
    const { w } = world(on, { profile: () => ran(0, 'foundation\n') })
    put(w, 'shopify.theme.toml')
    expect(ours(await compose($))).toEqual([])
  })

  test('classic.SubagentStart: nothing added; the hooks beneath are kept', async ($, on) => {
    world(on, { subagentBelow: ['from below'] })
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
