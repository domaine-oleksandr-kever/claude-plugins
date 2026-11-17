import { expect, mock, test } from 'claude-code/testing'
import type { TestOptions } from 'claude-code/testing'

const CASES: TestOptions['options'][] = [{}, { disabled: true, cacheTtl: '1h' }]
for (const options of CASES) {
  test(`the module loads and session.start runs through it (${JSON.stringify(options)})`, { options }, async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    mock.store(on)
    mock.env(on, {})
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    const r = await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(r).toEqual({ cwd: '/repo' })
  })
}
