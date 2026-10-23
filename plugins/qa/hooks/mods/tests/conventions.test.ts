import { describe, expect, mock, test } from 'claude-code/testing'
import { subagent, world } from './world.ts'

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
