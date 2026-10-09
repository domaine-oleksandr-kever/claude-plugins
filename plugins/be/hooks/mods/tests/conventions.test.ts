import { describe, expect, mock, test } from 'claude-code/testing'
import { compose, ours, subagent, world } from './world.ts'

// The lint's banned names, spelled so that neither the lint nor the release grep flags this file: be's text never points at the legacy plugin.
const OLD = 'f' + 'nd'
const HOSTS = ['Cur' + 'sor', 'Co' + 'dex', 'Open' + 'Code']
const BANNED = [`plugin_${OLD}_`, `${OLD.toUpperCase()}_`, `\\b${OLD}:`, `/${OLD}\\b`, ...HOSTS.map(h => `\\b${h}\\b`)].map(p => new RegExp(p))

describe('prompt.compose', () => {
  test("the engine's sections first, then be's one root line, session-scoped", async ($, on) => {
    world(on)
    const r = await compose($)
    expect(r.sections[0]).toEqual({ id: 'intro', text: 'You are Claude Code.', scope: 'shared' })
    expect(r.sections.slice(1).map((s: any) => s.id)).toEqual(['be:root'])
    const [root] = ours(r)
    expect(root!.scope).toBe('session')
    expect(root!.text).toMatch(/^be plugin root: \/\S*$/)
  })

  test('two renders are byte-identical', async ($, on) => {
    world(on)
    expect(JSON.stringify(await compose($))).toBe(JSON.stringify(await compose($)))
  })

  test('no legacy or host name in the section', async ($, on) => {
    world(on)
    for (const s of ours(await compose($))) for (const re of BANNED) expect(re.test(s.text)).toBe(false)
  })
})

describe('classic.SubagentStart', () => {
  const ctxOf = async ($: any, type: string) => ((await subagent($, type)).additionalContext ?? []) as string[]

  test("base's readers and writer and Claude Code's helpers get nothing from be", async ($, on) => {
    world(on)
    for (const type of ['base:jira-reader', 'base:jira-writer', 'base:figma-reader', 'base:doc-reader', 'jira-reader', 'claude-code-guide', 'statusline-setup']) {
      expect(await ctxOf($, type)).toEqual([])
    }
  })

  test('every other agent gets the root line and nothing more', async ($, on) => {
    world(on)
    for (const type of ['general-purpose', 'base:bug-hunter', 'base:change-reviewer', 'Explore', 'Plan', 'some-plugin:implementer', '']) {
      const ctx = await ctxOf($, type)
      expect(ctx).toHaveLength(1)
      expect(ctx[0]).toMatch(/^be plugin root: \/\S*$/)
    }
  })

  test("context from the hooks beneath is kept, be's comes after it", async ($, on) => {
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
