import { expect, test } from 'claude-code/testing'

test('the module loads and session.start passes through it', async ($, on) => {
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  const r = await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(r).toEqual({ cwd: '/repo' })
})
