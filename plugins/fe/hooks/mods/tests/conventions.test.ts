import { describe, expect, mock, test } from 'claude-code/testing'
import { HOME, compose, context, ours, put, ran, subagent, world } from './world.ts'

describe('the conventions travel as command hooks only: the mods deliver nothing', () => {
  test('prompt.context: no fe block, the engine\'s blocks kept', async ($, on) => {
    const { w } = world(on, { env: { HOME }, profile: () => ran(0, 'foundation\n') })
    put(w, 'shopify.theme.toml')
    expect((await context($)).blocks.map((b: any) => b.name)).toEqual(['claudeMd'])
  })

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
