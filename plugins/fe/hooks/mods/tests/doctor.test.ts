import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { age, parseStatic, reconcile, render, summary } from '../doctor.ts'
import type { Row } from '../doctor.ts'
import { HOME, LOG, NOW, PEEK, ROOT, compose, doctor, eventsOf, peek, ran, start, submit, world } from './world.ts'

const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)
const row = (status: Row['status'], name: string, detail = 'x'): Row => ({ status, name, detail })
const staticOut = (rows: Row[]) => JSON.stringify({ root: '/plugin', rows })
const GREEN = [
  row('PASS', 'node', 'node 22.0.0 (>= 18 required)'),
  row('PASS', 'manifest', 'fe 0.1.0, depends on base'),
  row('PASS', 'base', 'base@domaine 0.2.0 installed and enabled'),
  row('PASS', 'profile', 'theme (project-profile.sh)'),
]
const lines = (text: string) => text.split('\n')

describe('registration', () => {
  t('every session.start registers /fe-doctor; a new session id at its first prompt registers it again', async ($, on) => {
    const { w, calls } = world(on)
    await start($)
    await start($)
    await submit($, 'hello')
    expect(calls.commands).toEqual(['fe-doctor', 'fe-doctor'])
    expect((await peek($)).armed).toBe('s1')
    w.sid = 's2'
    await submit($, 'after a clear')
    await submit($, 'again')
    expect(calls.commands).toEqual(['fe-doctor', 'fe-doctor', 'fe-doctor'])
  })
})

describe('/fe-doctor', () => {
  t("the static rows, then the live rows, the session's profile in place of the probe's, the summary", async ($, on) => {
    const { calls } = world(on, { env: { HOME }, profile: () => ran(0, 'foundation\n'), doctor: () => ran(0, staticOut(GREEN)) })
    await start($)
    await compose($)
    const { text } = await doctor($)
    expect(calls.doctors).toHaveLength(1)
    const argv = calls.doctors[0]!.argv
    expect(argv[0]).toBe('node')
    expect(argv[1]).toMatch(/\/scripts\/doctor\.cjs$/)
    expect(argv.slice(2, 4)).toEqual(['--json', '--root'])
    expect(argv.slice(5)).toEqual(['--project', ROOT, '--log-dir', `${LOG}/s1`])
    const out = lines(text)
    expect(out[0]).toMatch(/^fe doctor — plugin root: /)
    expect(out.slice(1, 7)).toEqual([
      'PASS  node       node 22.0.0 (>= 18 required)',
      'PASS  manifest   fe 0.1.0, depends on base',
      'PASS  base       base@domaine 0.2.0 installed and enabled',
      "PASS  profile    foundation (project-profile.sh) — this session's",
      "PASS  base-live  base's skills are loaded",
      'PASS  slim-live  mcp__slim__view registered',
    ])
    expect(out[7]).toBe('doctor: 6 passed, 0 failed, 0 skipped')
  })

  t('one doctor line in fe.events, and the events tail in the answer', async ($, on) => {
    const { clock } = world(on, { doctor: () => ran(0, staticOut(GREEN)) })
    await start($)
    await clock.settle()
    await clock.advance(125_000)
    const { text } = await doctor($)
    expect(text).toContain('fe events (last 2 of 2, newest last):')
    expect(text).toContain('    2m  start      fe 0.1.0')
    expect(text).toContain('    2m  profile    theme (project-profile.sh)')
    expect(await eventsOf($, 'doctor')).toEqual([{ atMs: NOW + 125_000, kind: 'doctor', text: '6 passed, 0 failed, 0 skipped' }])
  })

  t('FE_EVENT_LOG=0 → the tail says so and no line is written', async ($, on) => {
    world(on, { env: { FE_EVENT_LOG: '0' }, doctor: () => ran(0, staticOut(GREEN)) })
    await start($)
    const { text } = await doctor($)
    expect(text).toContain('fe events: off (FE_EVENT_LOG=0)')
    expect((await peek($)).events).toEqual([])
  })

  t('base and slim missing → both live rows fail; a profile fallback warns', async ($, on) => {
    const { calls } = world(on, { commands: [['band-log', 'band']], tools: ['Bash'], profile: () => ran(2, '', 'boom'), doctor: () => ran(0, staticOut(GREEN)) })
    await compose($)
    const { text } = await doctor($)
    expect(text).toContain('FAIL  base-live  fe needs the base plugin — claude plugin install base@domaine')
    expect(text).toContain('FAIL  slim-live  slim is not loaded — claude plugin install slim@domaine')
    expect(text).toContain("WARN  profile    none (fallback: project-profile.sh exited 2: boom) — this session's")
    expect(calls.toasts).toEqual([])
  })

  t("before the session decided its profile, doctor.cjs's own probe row stays", async ($, on) => {
    world(on, { doctor: () => ran(0, staticOut(GREEN)) })
    const { text } = await doctor($)
    expect(text).toContain('PASS  profile    theme (project-profile.sh)\n')
  })

  t('a base the install record lacks but the session loaded → WARN, not FAIL', async ($, on) => {
    world(on, { doctor: () => ran(1, staticOut([row('FAIL', 'base', 'not installed — x')])) })
    const { text } = await doctor($)
    expect(text).toContain('WARN  base       not in installed_plugins.json, yet loaded this session (a --plugin-dir load?)')
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
    expect(text).toContain('FAIL  static     scripts/doctor.cjs exited 2: doctor: unknown argument --json')
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

  test('reconcile touches only a not-installed base FAIL beside a live base, and the profile row', () => {
    const rows = [row('FAIL', 'base', 'not installed — x'), row('WARN', 'profile', 'none (fallback: y)')]
    expect(reconcile(rows, null)).toEqual(rows)
    expect(reconcile([...rows, row('PASS', 'base-live')], null)[0]?.status).toBe('WARN')
    expect(reconcile([row('FAIL', 'base', 'base@d 0.2.0 is installed but disabled'), row('PASS', 'base-live')], null)[0]?.status).toBe('FAIL')
    expect(reconcile(rows, { word: 'theme', text: 'theme (FE_PROFILE)', fallback: false })[1]).toEqual(
      row('PASS', 'profile', "theme (FE_PROFILE) — this session's"),
    )
  })

  test('age, summary, render', () => {
    expect([age(-5), age(59_000), age(60_000), age(3_600_000), age(48 * 3_600_000)]).toEqual(['0s', '59s', '1m', '1h', '2d'])
    expect(summary([row('PASS', 'a'), row('WARN', 'b')])).toBe('1 passed, 0 failed, 0 skipped, 1 warned')
    expect(render('/p', [row('PASS', 'a', 'one'), row('FAIL', 'long', 'two')], ['tail'])).toBe(
      ['fe doctor — plugin root: /p', 'PASS  a     one', 'FAIL  long  two', 'doctor: 1 passed, 1 failed, 0 skipped', '', 'tail'].join('\n'),
    )
  })
})
