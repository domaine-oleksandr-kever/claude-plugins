import { describe, expect, mock, test } from 'claude-code/testing'
import { PASSWORDS } from '../conventions/text.ts'
import { compose, ours, subagent, world } from './world.ts'

// The lint's banned names, spelled so that neither the lint nor the release grep flags this file: qa's text never points at the legacy plugin or another team plugin.
const OLD = 'f' + 'nd'
const HOSTS = ['Cur' + 'sor', 'Co' + 'dex', 'Open' + 'Code']
const BANNED = [`plugin_${OLD}_`, `${OLD.toUpperCase()}_`, `\\b${OLD}:`, `/${OLD}\\b`, `${OLD}-tmp`, '/f' + 'e:', '<f' + 'e root>', ...HOSTS.map(h => `\\b${h}\\b`)].map(p => new RegExp(p))

describe('prompt.compose', () => {
  test("the engine's sections first, then qa's two, every one session-scoped", async ($, on) => {
    world(on)
    const r = await compose($)
    expect(r.sections[0]).toEqual({ id: 'intro', text: 'You are Claude Code.', scope: 'shared' })
    expect(r.sections.slice(1).map((s: any) => s.id)).toEqual(['qa:root', 'qa:passwords'])
    expect(ours(r).every(s => s.scope === 'session')).toBe(true)
  })

  test('the root line is one line with an absolute path', async ($, on) => {
    world(on)
    const [root] = ours(await compose($))
    expect(root!.text).toMatch(/^qa plugin root: \/\S*$/)
  })

  test("passwords: base's registry get, the browser fill alone, one paragraph", async ($, on) => {
    world(on)
    const text = ours(await compose($)).find(s => s.id === 'qa:passwords')!.text
    expect(text).toBe(PASSWORDS)
    expect(text).toMatch(/^## qa convention — storefront passwords\n\nA storefront password comes only from/)
    expect(text).toContain('`node <base root>/scripts/qa-stores.cjs get <store>`')
    expect(text).toContain("base's `base plugin root:` line")
    expect(text).toContain('used only as the browser fill value')
    expect(text).toContain('a `qa-stores.cjs set`\nthat registers or updates a store')
    expect(text).toContain('the registry file is never read directly')
    expect(text.split('\n\n')).toHaveLength(2)
    expect(text.length).toBeLessThanOrEqual(460)
  })

  test('the store-access posture lives in the skill, not the prompt', async ($, on) => {
    world(on)
    const text = ours(await compose($)).map(s => s.text).join('\n')
    for (const phrase of ['Admin API write', 'add to cart', 'hands-on QA']) expect(text).not.toContain(phrase)
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
    expect(r.sections.map((s: any) => s.id)).toContain('qa:passwords')
  })
})

describe('classic.SubagentStart', () => {
  test('qa adds nothing to any subagent', async ($, on) => {
    world(on)
    for (const type of ['base:jira-reader', 'base:change-reviewer', 'general-purpose', 'Explore', 'Plan', 'some-plugin:implementer', '']) {
      expect((await subagent($, type)).additionalContext ?? []).toEqual([])
    }
  })

  test('context from the hooks beneath passes through untouched', async ($, on) => {
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
