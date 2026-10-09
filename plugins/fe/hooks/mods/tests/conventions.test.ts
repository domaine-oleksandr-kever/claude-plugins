import { describe, expect, mock, test } from 'claude-code/testing'
import { FOUNDATION, PROGRESS_SERIES, STORE_ACCESS, WORKTREE } from '../conventions/text.ts'
import { ROOT, compose, ours, put, ran, subagent, world } from './world.ts'

// team-refs-lint's banned names, spelled so that neither the lint nor the release grep flags this file: fe's text never points at the legacy plugin.
const OLD = 'f' + 'nd'
const SLIMS = ['json', 'log'].map(k => `${k}-` + 'slim')
const HOSTS = ['Cur' + 'sor', 'Co' + 'dex', 'Open' + 'Code']
const BANNED = [`plugin_${OLD}_`, `${OLD.toUpperCase()}_`, `\\b${OLD}:`, `/${OLD}\\b`, `${OLD}-tmp`, ...HOSTS.map(h => `\\b${h}\\b`), ...SLIMS].map(p => new RegExp(p))
const ids = async ($: any) => ours(await compose($)).map(s => s.id)
const rootOf = (text: string) => text.replace(/^fe plugin root: /, '')

describe('prompt.compose', () => {
  test("the engine's sections first, then fe's, every one session-scoped", async ($, on) => {
    world(on)
    const r = await compose($)
    expect(r.sections[0]).toEqual({ id: 'intro', text: 'You are Claude Code.', scope: 'shared' })
    expect(r.sections.slice(1).map((s: any) => s.id)).toEqual(['fe:root', 'fe:profile', 'fe:worktree', 'fe:progress-series'])
    expect(ours(r).every(s => s.scope === 'session')).toBe(true)
  })

  test('the root and profile lines, one line each', async ($, on) => {
    world(on)
    const [root, profile] = ours(await compose($))
    expect(root!.text).toMatch(/^fe plugin root: \/\S*$/)
    expect(profile!.text).toBe('fe project profile: theme')
  })

  test('foundation → the LiquidDoc-and-core section right after the profile', async ($, on) => {
    world(on, { profile: () => ran(0, 'foundation\n') })
    const r = ours(await compose($))
    expect(r.map(s => s.id)).toEqual(['fe:root', 'fe:profile', 'fe:comment-discipline-foundation', 'fe:worktree', 'fe:progress-series'])
    expect(r[1]!.text).toBe('fe project profile: foundation')
    expect(r[2]!.text).toBe(FOUNDATION)
  })

  for (const file of ['shopify.theme.toml', '.env']) {
    test(`${file} at the project root → store access with fe's own paths, never a value`, async ($, on) => {
      const { w } = world(on)
      put(w, file)
      const r = ours(await compose($))
      expect(r.map(s => s.id)).toContain('fe:store-access')
      const root = rootOf(r[0]!.text)
      const text = r.find(s => s.id === 'fe:store-access')!.text
      expect(text).not.toContain('<fe root>')
      for (const p of ['scripts/shopify-admin-gql.sh', 'scripts/theme-json.sh', 'references/metafield-metaobject-setup.md', 'references/theme-customizer-state.md']) {
        expect(text).toContain(`${root}/${p}`)
      }
      expect(text).not.toContain('never-read')
    })
  }

  test('no store config → no store-access section', async ($, on) => {
    world(on, { profile: () => ran(0, 'foundation\n') })
    expect(await ids($)).not.toContain('fe:store-access')
  })

  test("the worktree section carries exactly one copy-list line base's /base:worktree parses", async ($, on) => {
    world(on)
    const text = ours(await compose($)).find(s => s.id === 'fe:worktree')!.text
    expect(text).toBe(WORKTREE)
    expect(text.split('\n').filter(l => l.startsWith('worktree copy list:'))).toEqual(['worktree copy list: shopify.theme.toml'])
    expect(text).toContain('/fe:preview-theme')
  })

  test("the progress series: fe's steps in order, base's own two by base's names", async ($, on) => {
    world(on)
    const text = ours(await compose($)).find(s => s.id === 'fe:progress-series')!.text
    expect(text).toBe(PROGRESS_SERIES)
    const rows = [...text.matchAll(/^\d\. `([a-z-]+)` — `(\/[a-z]+:[a-z-]+)`/gm)].map(m => [m[1], m[2]])
    expect(rows).toEqual([
      ['write-technical-approach', '/fe:write-technical-approach'],
      ['develop-feature-or-fix', '/fe:develop-feature-or-fix'],
      ['qa-feature-or-fix', '/fe:qa-feature-or-fix'],
      ['pre-commit-review', '/base:pre-commit-review'],
      ['commit', '/base:commit'],
      ['write-steps-to-test', '/fe:write-steps-to-test'],
      ['create-pull-request', '/fe:create-pull-request'],
    ])
  })

  test('two renders are byte-identical and the probe runs once', async ($, on) => {
    const { calls } = world(on)
    const a = await compose($)
    expect(JSON.stringify(a)).toBe(JSON.stringify(await compose($)))
    expect(calls.profiles).toHaveLength(1)
    expect(calls.profiles[0]!.argv.slice(0, 1)).toEqual(['bash'])
    expect(calls.profiles[0]!.argv[1]).toMatch(/\/scripts\/project-profile\.sh$/)
    expect(calls.profiles[0]!.argv[2]).toBe(ROOT)
  })

  test('no legacy, host or old-compressor name in any section', async ($, on) => {
    const { w } = world(on, { profile: () => ran(0, 'foundation\n') })
    put(w, '.env')
    const r = ours(await compose($))
    expect(r).toHaveLength(6)
    for (const s of r) for (const re of BANNED) expect(re.test(s.text)).toBe(false)
    for (const s of [FOUNDATION, STORE_ACCESS, WORKTREE, PROGRESS_SERIES]) for (const re of BANNED) expect(re.test(s)).toBe(false)
  })

  test('a section the engine already answered under a fe id is not added twice', async ($, on) => {
    world(on, { composeBelow: [{ id: 'fe:root', text: 'kept', scope: 'session' }] })
    const r = await compose($)
    expect(r.sections.filter((s: any) => s.id === 'fe:root')).toEqual([{ id: 'fe:root', text: 'kept', scope: 'session' }])
  })
})

describe('classic.SubagentStart', () => {
  const ctxOf = async ($: any, type: string) => ((await subagent($, type)).additionalContext ?? []) as string[]

  test("base's readers and writer and Claude Code's helpers get nothing from fe", async ($, on) => {
    const { w } = world(on, { profile: () => ran(0, 'foundation\n') })
    put(w, '.env')
    for (const type of ['base:jira-reader', 'base:jira-writer', 'base:figma-reader', 'base:doc-reader', 'jira-reader', 'claude-code-guide', 'statusline-setup']) {
      expect(await ctxOf($, type)).toEqual([])
    }
  })

  test('a code-writing agent: root, profile, the Foundation rules and store access', async ($, on) => {
    const { w } = world(on, { profile: () => ran(0, 'foundation\n') })
    put(w, 'shopify.theme.toml')
    for (const type of ['general-purpose', 'some-plugin:implementer', '']) {
      const ctx = await ctxOf($, type)
      expect(ctx).toHaveLength(1)
      expect(ctx[0]).toStartWith('fe plugin root: /')
      expect(ctx[0]).toContain('fe project profile: foundation')
      expect(ctx[0]).toContain(FOUNDATION)
      expect(ctx[0]).toContain('## fe capability — live store access')
      expect(ctx[0]).not.toContain('<fe root>')
      expect(ctx[0]).not.toContain(PROGRESS_SERIES)
    }
  })

  test('a read-only agent: root, profile and the Foundation rules, no store access', async ($, on) => {
    const { w } = world(on, { profile: () => ran(0, 'foundation\n') })
    put(w, '.env')
    for (const type of ['fe:theme-explorer', 'base:change-reviewer', 'base:bug-hunter', 'Explore', 'Plan']) {
      const ctx = (await ctxOf($, type))[0] ?? ''
      expect(ctx).toContain('fe project profile: foundation')
      expect(ctx).toContain(FOUNDATION)
      expect(ctx).not.toContain('live store access')
    }
  })

  test('a theme profile without store config: root and profile only', async ($, on) => {
    world(on)
    const ctx = (await ctxOf($, 'general-purpose'))[0] ?? ''
    expect(ctx.split('\n\n')).toHaveLength(2)
    expect(ctx).toContain('fe project profile: theme')
  })

  test("context from the hooks beneath is kept, fe's comes after it", async ($, on) => {
    world(on, { subagentBelow: ['from below'] })
    const r = await subagent($, 'general-purpose')
    expect(r.additionalContext).toHaveLength(2)
    expect(r.additionalContext[0]).toBe('from below')
  })
})

test('the module loads under the bare engine too', async ($, on) => {
  mock.clock(on, { now: 1 })
  mock.store(on)
  mock.env(on, {})
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  expect(await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })).toEqual({ cwd: '/x' })
})
