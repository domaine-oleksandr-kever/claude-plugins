import { describe, expect, mock, test } from 'claude-code/testing'
import { STORE_ACCESS } from '../conventions/text.ts'
import { compose, ours, subagent, world } from './world.ts'

// The lint's banned names, spelled so that neither the lint nor the release grep flags this file: qa's text never points at the legacy plugin or another team plugin.
const OLD = 'f' + 'nd'
const HOSTS = ['Cur' + 'sor', 'Co' + 'dex', 'Open' + 'Code']
const BANNED = [`plugin_${OLD}_`, `${OLD.toUpperCase()}_`, `\\b${OLD}:`, `/${OLD}\\b`, `${OLD}-tmp`, '/f' + 'e:', '<f' + 'e root>', ...HOSTS.map(h => `\\b${h}\\b`)].map(p => new RegExp(p))
const rootOf = (text: string) => text.replace(/^qa plugin root: /, '')

describe('prompt.compose', () => {
  test("the engine's sections first, then qa's two, every one session-scoped", async ($, on) => {
    world(on)
    const r = await compose($)
    expect(r.sections[0]).toEqual({ id: 'intro', text: 'You are Claude Code.', scope: 'shared' })
    expect(r.sections.slice(1).map((s: any) => s.id)).toEqual(['qa:root', 'qa:store-access'])
    expect(ours(r).every(s => s.scope === 'session')).toBe(true)
  })

  test('the root line is one line with an absolute path', async ($, on) => {
    world(on)
    const [root] = ours(await compose($))
    expect(root!.text).toMatch(/^qa plugin root: \/\S*$/)
  })

  test("store access: storefront only, the password through base's registry get and the browser fill alone", async ($, on) => {
    world(on)
    const text = ours(await compose($)).find(s => s.id === 'qa:store-access')!.text
    expect(text).toBe(STORE_ACCESS)
    expect(text).toContain('`node <base root>/scripts/qa-stores.cjs get <store>`')
    expect(text).toContain("base's `base plugin root:` line")
    expect(text).toContain('no Admin API write, no theme or theme-settings write')
    expect(text).toContain('used only as the browser fill')
    expect(text).toContain('never restated in chat')
    expect(text.split('\n').length).toBeLessThanOrEqual(14)
  })

  test("store access binds a preflight or a hands-on QA session only, and leaves a team plugin's own QA flow to its own section", async ($, on) => {
    world(on)
    const text = ours(await compose($)).find(s => s.id === 'qa:store-access')!.text
    expect(text).toMatch(/^## qa convention — store access while a QA preflight runs\n/)
    expect(text.replace(/\s+/g, ' ')).toContain('While `/qa:preflight` runs, or when the person says this is a hands-on QA session, the run works on the storefront only')
    expect(text).toContain("A team plugin's own QA flow follows its own store-access section.")
    expect(text).not.toMatch(/^A QA run works on the storefront only/m)
  })

  test('the password rules hold whatever the scope', async ($, on) => {
    world(on)
    const text = ours(await compose($)).find(s => s.id === 'qa:store-access')!.text
    const passwords = text.slice(text.indexOf('A storefront password'))
    expect(passwords).toMatch(/^A storefront password comes only from/)
    expect(passwords).toContain('never written to a file, a workspace note, a Jira comment or a screenshot')
    expect(passwords).toContain('never restated in chat')
    for (const scope of ['preflight', 'QA session']) expect(passwords).not.toContain(scope)
  })

  test('two renders are byte-identical', async ($, on) => {
    world(on)
    expect(JSON.stringify(await compose($))).toBe(JSON.stringify(await compose($)))
  })

  test('no legacy, host or other team-plugin name in any section', async ($, on) => {
    world(on)
    const r = ours(await compose($))
    expect(r).toHaveLength(2)
    for (const s of r) for (const re of BANNED) expect(re.test(s.text)).toBe(false)
  })

  test('a section the engine already answered under a qa id is not added twice', async ($, on) => {
    world(on, { composeBelow: [{ id: 'qa:root', text: 'kept', scope: 'session' }] })
    const r = await compose($)
    expect(r.sections.filter((s: any) => s.id === 'qa:root')).toEqual([{ id: 'qa:root', text: 'kept', scope: 'session' }])
    expect(r.sections.map((s: any) => s.id)).toContain('qa:store-access')
  })
})

describe('classic.SubagentStart', () => {
  const ctxOf = async ($: any, type: string) => ((await subagent($, type)).additionalContext ?? []) as string[]

  test("base's readers and writer and Claude Code's helpers get nothing from qa", async ($, on) => {
    world(on)
    for (const type of ['base:jira-reader', 'base:jira-writer', 'base:figma-reader', 'base:doc-reader', 'jira-reader', 'claude-code-guide', 'statusline-setup']) {
      expect(await ctxOf($, type)).toEqual([])
    }
  })

  test("base's reviewers: the root line only", async ($, on) => {
    world(on)
    for (const type of ['base:change-reviewer', 'base:bug-hunter']) {
      const ctx = await ctxOf($, type)
      expect(ctx).toHaveLength(1)
      expect(ctx[0]).toMatch(/^qa plugin root: \/\S*$/)
    }
  })

  test('every other agent: the root line and the store-access posture', async ($, on) => {
    world(on)
    const [root] = ours(await compose($))
    for (const type of ['general-purpose', 'Explore', 'Plan', 'some-plugin:implementer', '']) {
      const ctx = await ctxOf($, type)
      expect(ctx).toHaveLength(1)
      expect(ctx[0]).toBe(`${root!.text}\n\n${STORE_ACCESS}`)
      expect(rootOf(ctx[0]!.split('\n')[0]!)).toBe(rootOf(root!.text))
    }
  })

  test("context from the hooks beneath is kept, qa's comes after it", async ($, on) => {
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
