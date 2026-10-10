import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { age, parseStatic, reconcile, render, summary } from '../doctor.ts'
import type { Row } from '../doctor.ts'
import { HOME, LOG, NOW, PEEK, ROOT, SLIM_VIEW, doctor, eventsOf, peek, ran, start, submit, world } from './world.ts'

const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)
const row = (status: Row['status'], name: string, detail = 'x'): Row => ({ status, name, detail })
const staticOut = (rows: Row[]) => JSON.stringify({ root: '/plugin', rows })
const GREEN = [
  row('PASS', 'node', 'node 22.0.0 (>= 18 required)'),
  row('PASS', 'manifest', 'be 0.1.0, depends on base'),
  row('PASS', 'base', 'base@domaine 0.3.0 installed and enabled'),
  row('PASS', 'shopify-dev-mcp', "base's manifest declares shopify-dev-mcp"),
]
const lines = (text: string) => text.split('\n')

describe('registration', () => {
  t('every session.start registers /be-doctor; a new session id at its first prompt registers it again', async ($, on) => {
    const { w, calls } = world(on)
    await start($)
    await start($)
    await submit($, 'hello')
    expect(calls.commands).toEqual(['be-doctor', 'be-doctor'])
    expect((await peek($)).armed).toBe('s1')
    w.sid = 's2'
    await submit($, 'after a clear')
    await submit($, 'again')
    expect(calls.commands).toEqual(['be-doctor', 'be-doctor', 'be-doctor'])
  })
})

describe('/be-doctor', () => {
  t('the static rows, then the live rows, then the summary', async ($, on) => {
    const { calls } = world(on, { env: { HOME }, doctor: () => ran(0, staticOut(GREEN)) })
    await start($)
    const { text } = await doctor($)
    expect(calls.doctors).toHaveLength(1)
    const argv = calls.doctors[0]!.argv
    expect(argv[0]).toBe('node')
    expect(argv[1]).toMatch(/\/scripts\/doctor\.cjs$/)
    expect(argv.slice(2, 4)).toEqual(['--json', '--root'])
    expect(argv.slice(5)).toEqual(['--project', ROOT, '--log-dir', `${LOG}/s1`])
    const out = lines(text)
    expect(out[0]).toMatch(/^be doctor — plugin root: /)
    expect(out.slice(1, 8)).toEqual([
      'PASS  node             node 22.0.0 (>= 18 required)',
      'PASS  manifest         be 0.1.0, depends on base',
      'PASS  base             base@domaine 0.3.0 installed and enabled',
      "PASS  shopify-dev-mcp  base's manifest declares shopify-dev-mcp",
      "PASS  base-live        base's skills are loaded",
      'PASS  slim-live        mcp__slim__view registered',
      'PASS  dev-mcp-live     mcp__plugin_base_shopify-dev-mcp__learn_shopify_api is in this session',
    ])
    expect(out[8]).toBe('doctor: 7 passed, 0 failed, 0 skipped')
  })

  t('one doctor line in be.events, and the events tail in the answer', async ($, on) => {
    const { clock } = world(on, { doctor: () => ran(0, staticOut(GREEN)) })
    await start($)
    await clock.advance(125_000)
    const { text } = await doctor($)
    expect(text).toContain('be events (last 1 of 1, newest last):')
    expect(text).toContain('    2m  start      be 0.1.0')
    expect(await eventsOf($, 'doctor')).toEqual([{ atMs: NOW + 125_000, kind: 'doctor', text: '7 passed, 0 failed, 0 skipped' }])
  })

  t('BE_EVENT_LOG=0 → the tail says so and no line is written', async ($, on) => {
    world(on, { env: { BE_EVENT_LOG: '0' }, doctor: () => ran(0, staticOut(GREEN)) })
    await start($)
    const { text } = await doctor($)
    expect(text).toContain('be events: off (BE_EVENT_LOG=0)')
    expect((await peek($)).events).toEqual([])
  })

  t('no line before the run → the tail says none yet', async ($, on) => {
    world(on, { doctor: () => ran(0, staticOut(GREEN)) })
    const { text } = await doctor($)
    expect(text).toContain('be events: none yet')
    expect((await eventsOf($)).map(ev => ev.kind)).toEqual(['doctor'])
  })

  t('base and slim missing → both live rows fail, no toast from the doctor', async ($, on) => {
    const { calls } = world(on, { commands: [['band-log', 'band']], tools: ['Bash'], doctor: () => ran(0, staticOut(GREEN)) })
    const { text } = await doctor($)
    expect(text).toContain('FAIL  base-live        be needs the base plugin — claude plugin install base@domaine')
    expect(text).toContain('FAIL  slim-live        slim is not loaded — claude plugin install slim@domaine')
    expect(calls.toasts).toEqual([])
  })

  t('Dev MCP declared but its tools absent this session → dev-mcp-live WARNs, the static row still passes', async ($, on) => {
    world(on, { tools: ['Bash', SLIM_VIEW], doctor: () => ran(0, staticOut(GREEN)) })
    const { text } = await doctor($)
    expect(text).toContain("PASS  shopify-dev-mcp  base's manifest declares shopify-dev-mcp")
    expect(text).toContain("WARN  dev-mcp-live     the Shopify Dev MCP's tools are not in this session (not connected? see /mcp) — the skills fall back to scripts/shopify-docs.cjs")
    expect(text).toContain('doctor: 6 passed, 0 failed, 0 skipped, 1 warned')
  })

  t('a base the install record lacks but the session loaded → WARN, not FAIL', async ($, on) => {
    world(on, { doctor: () => ran(1, staticOut([row('FAIL', 'base', 'not installed — x')])) })
    const { text } = await doctor($)
    expect(text).toContain('WARN  base          not in installed_plugins.json, yet loaded this session (a --plugin-dir load?)')
  })

  t('doctor.cjs cannot spawn → one SKIP row; the live rows still answer', async ($, on) => {
    world(on, { doctor: null })
    const { text } = await doctor($)
    expect(text).toMatch(/SKIP {2}static +scripts\/doctor\.cjs did not run \(.+\): the static checks need node/)
    expect(text).toContain('PASS  slim-live')
  })

  t('doctor.cjs without JSON rows → one FAIL row with its first stderr line', async ($, on) => {
    world(on, { doctor: () => ran(2, 'not json', 'doctor: unknown argument --json\nusage') })
    const { text } = await doctor($)
    expect(text).toContain('FAIL  static        scripts/doctor.cjs exited 2: doctor: unknown argument --json')
  })

  t('no HOME → no --log-dir', async ($, on) => {
    const { calls } = world(on, { doctor: () => ran(0, staticOut(GREEN)) })
    await doctor($)
    expect(calls.doctors[0]!.argv).not.toContain('--log-dir')
  })
})

describe('doctor helpers', () => {
  test('parseStatic keeps well-formed rows only', () => {
    expect(parseStatic(staticOut([row('PASS', 'node'), { status: 'MAYBE', name: 'x', detail: 'y' } as any]))).toEqual([row('PASS', 'node')])
    expect(parseStatic('PASS  node')).toBeNull()
    expect(parseStatic('{"root":"/x"}')).toBeNull()
  })

  test('reconcile touches only a not-installed base FAIL beside a live base', () => {
    const rows = [row('FAIL', 'base', 'not installed — x'), row('SKIP', 'shopify-dev-mcp', 'y')]
    expect(reconcile(rows)).toEqual(rows)
    expect(reconcile([...rows, row('PASS', 'base-live')])[0]?.status).toBe('WARN')
    expect(reconcile([...rows, row('PASS', 'base-live')])[1]).toEqual(rows[1])
    expect(reconcile([row('FAIL', 'base', 'base@d 0.2.0 is installed but disabled'), row('PASS', 'base-live')])[0]?.status).toBe('FAIL')
  })

  test('age, summary, render', () => {
    expect([age(-5), age(59_000), age(60_000), age(3_600_000), age(47 * 3_600_000), age(48 * 3_600_000)]).toEqual(['0s', '59s', '1m', '1h', '47h', '2d'])
    expect(summary([row('PASS', 'a'), row('WARN', 'b')])).toBe('1 passed, 0 failed, 0 skipped, 1 warned')
    expect(render('/p', [row('PASS', 'a', 'one'), row('FAIL', 'long', 'two')], ['tail'])).toBe(
      ['be doctor — plugin root: /p', 'PASS  a     one', 'FAIL  long  two', 'doctor: 1 passed, 1 failed, 0 skipped', '', 'tail'].join('\n'),
    )
  })
})
