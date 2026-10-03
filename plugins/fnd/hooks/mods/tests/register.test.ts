import { expect, mock, test } from 'claude-code/testing'

test('the module loads and session.start runs through it', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, {})
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  const r = await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(r).toEqual({ cwd: '/repo' })
})
