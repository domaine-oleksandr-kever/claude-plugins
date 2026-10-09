import { describe, expect, mock, test } from 'claude-code/testing'
import { NO_PM_AGENT, rootLine } from '../conventions/text.ts'
import { compose, ours, subagent, world } from './world.ts'

// The refs lint's banned names, spelled so that neither the lint nor the release grep flags this file: pm's text never points at the legacy plugin.
const OLD = 'f' + 'nd'
const HOSTS = ['Cur' + 'sor', 'Co' + 'dex', 'Open' + 'Code']
const BANNED = [`plugin_${OLD}_`, `${OLD.toUpperCase()}_`, `\\b${OLD}:`, `/${OLD}\\b`, ...HOSTS.map(h => `\\b${h}\\b`)].map(p => new RegExp(p))

describe('prompt.compose', () => {
  test("the engine's sections first, then pm's one session-scoped root line", async ($, on) => {
    world(on)
    const r = await compose($)
    expect(r.sections[0]).toEqual({ id: 'intro', text: 'You are Claude Code.', scope: 'shared' })
    expect(r.sections.slice(1).map((s: any) => s.id)).toEqual(['pm:root'])
    const [root] = ours(r)
    expect(root!.scope).toBe('session')
    expect(root!.text).toMatch(/^pm plugin root: \/\S*$/)
  })

  test('two renders are byte-identical', async ($, on) => {
    world(on)
    const a = await compose($)
    expect(JSON.stringify(a)).toBe(JSON.stringify(await compose($)))
  })

  test('no legacy or host name in the section', async ($, on) => {
    world(on)
    for (const s of ours(await compose($))) for (const re of BANNED) expect(re.test(s.text)).toBe(false)
    for (const re of BANNED) expect(re.test(rootLine('/x'))).toBe(false)
  })

  test('a section the engine already answered under a pm id is not added twice', async ($, on) => {
    world(on, { composeBelow: [{ id: 'pm:root', text: 'kept', scope: 'session' }] })
    const r = await compose($)
    expect(r.sections.filter((s: any) => s.id === 'pm:root')).toEqual([{ id: 'pm:root', text: 'kept', scope: 'session' }])
  })
})

describe('classic.SubagentStart', () => {
  const ctxOf = async ($: any, type: string) => ((await subagent($, type)).additionalContext ?? []) as string[]

  test("base's readers and writer and Claude Code's helpers get nothing from pm", async ($, on) => {
    world(on)
    for (const type of ['base:jira-reader', 'base:jira-writer', 'base:figma-reader', 'base:doc-reader', 'jira-reader', 'claude-code-guide', 'statusline-setup']) {
      expect(await ctxOf($, type)).toEqual([])
    }
  })

  test('every other agent gets the root line and only that', async ($, on) => {
    world(on)
    const root = ours(await compose($))[0]!.text
    for (const type of ['general-purpose', 'base:bug-hunter', 'Explore', 'Plan', 'some-plugin:researcher', '']) {
      expect(await ctxOf($, type)).toEqual([root])
    }
  })

  test("context from the hooks beneath is kept, pm's comes after it", async ($, on) => {
    world(on, { subagentBelow: ['from below'] })
    const r = await subagent($, 'general-purpose')
    expect(r.additionalContext).toHaveLength(2)
    expect(r.additionalContext[0]).toBe('from below')
  })

  test('NO_PM_AGENT matches a whole agent name only', () => {
    for (const n of ['base:jira-reader', 'doc-reader', 'claude-code-guide']) expect(NO_PM_AGENT.test(n)).toBe(true)
    for (const n of ['jira-reader-2', 'my-doc-reader-x', 'x:claude-code-guide', 'general-purpose']) expect(NO_PM_AGENT.test(n)).toBe(false)
  })
})

test('the module loads under the bare engine too', async ($, on) => {
  mock.clock(on, { now: 1 })
  mock.store(on)
  mock.env(on, {})
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  expect(await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })).toEqual({ cwd: '/x' })
})
