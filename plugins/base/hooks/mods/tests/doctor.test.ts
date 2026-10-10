import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { MCP_TIMEOUT_MS, age, parseStatic, reconcile, render, summary } from '../doctor.ts'
import type { Row } from '../doctor.ts'
import { SLIM_MISSING } from '../session.ts'
import { NOW, PEEK, ROOT, eventsOf, peek, ran, run, start, submit, world } from './world.ts'

const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)
const doctor = ($: any) => run($, '', 'base-doctor')
const NO_SLIM = ['Bash', 'Read']

const row = (status: Row['status'], name: string, detail = 'x'): Row => ({ status, name, detail })
const staticOut = (rows: Row[]) => JSON.stringify({ root: '/plugin', rows })
const GREEN = [
  row('PASS', 'node', 'node 22.0.0 (>= 18 required)'),
  row('PASS', 'manifest', 'base 0.1.0, depends on slim'),
  row('PASS', 'slim', 'slim@domaine 0.5.0 installed and enabled'),
]
const manifest = (servers: string[]) =>
  JSON.stringify({ name: 'base', version: '0.1.0', mcpServers: Object.fromEntries(servers.map(s => [s, {}])) })
const up = (server: string) => ({ isConnected: true as const, server: `plugin:base:${server}` })
const down = (reason: 'auth' | 'failed' | 'disabled', message: string) => ({ isConnected: false as const, reason, message })
const lines = (text: string) => text.split('\n')

describe('once per session', () => {
  t('every session.start registers /base-doctor; base-tmp is swept under the session root once per id', async ($, on) => {
    const { calls } = world(on)
    await start($)
    await start($)
    expect(calls.commands.filter(c => c === 'base-doctor')).toEqual(['base-doctor', 'base-doctor'])
    expect(calls.sweeps).toHaveLength(1)
    const argv = calls.sweeps[0] ?? []
    expect(argv[0]).toBe('node')
    expect(argv[1]).toMatch(/\/scripts\/scratch-hygiene\.cjs$/)
    expect(argv.slice(2)).toEqual(['--sweep', ROOT])
    expect((await peek($)).swept).toBe('s1')
  })

  t('a new session id (a /clear) registers and sweeps again at its first prompt', async ($, on) => {
    const { w, calls } = world(on)
    await start($)
    await submit($, 'hello')
    expect(calls.sweeps).toHaveLength(1)
    w.sid = 's2'
    await submit($, 'after a clear')
    await submit($, 'again')
    expect(calls.sweeps).toHaveLength(2)
    expect(calls.commands.filter(c => c === 'base-doctor')).toHaveLength(2)
  })

  t('the sweep does not hold the session start', async ($, on) => {
    let release = () => {}
    const { calls } = world(on, { sweepGate: new Promise<void>(r => (release = r)) })
    await start($)
    expect(calls.commands).toContain('base-doctor')
    expect(calls.sweeps).toHaveLength(0)
    release()
  })

  t('BASE_TMP_TTL reaches the sweep as --ttl-hours', async ($, on) => {
    const { calls } = world(on, { env: { BASE_TMP_TTL: '6' } })
    await start($)
    expect((calls.sweeps[0] ?? []).slice(2)).toEqual(['--sweep', ROOT, '--ttl-hours', '6'])
  })
})

describe('/base-doctor', () => {
  t('the static rows, the live rows, one row per manifest server, the summary', async ($, on) => {
    const { calls } = world(on, {
      manifest: manifest(['atlassian', 'playwright']),
      mcp: { atlassian: up('atlassian'), playwright: up('playwright') },
      run: () => ran(0, staticOut(GREEN)),
    })
    await start($)
    const { text } = await doctor($)
    expect(calls.runs).toHaveLength(1)
    const argv = calls.runs[0]?.argv ?? []
    expect(argv[0]).toBe('node')
    expect(argv[1]).toMatch(/\/scripts\/doctor\.cjs$/)
    expect(argv.slice(2, 4)).toEqual(['--json', '--root'])
    expect(argv.slice(5)).toEqual(['--project', ROOT])
    expect(calls.connects.sort()).toEqual(['atlassian', 'playwright'])
    const out = lines(text)
    expect(out[0]).toMatch(/^base doctor — plugin root: /)
    expect(out.slice(1, 7)).toEqual([
      'PASS  node            node 22.0.0 (>= 18 required)',
      'PASS  manifest        base 0.1.0, depends on slim',
      'PASS  slim            slim@domaine 0.5.0 installed and enabled',
      'PASS  slim-live       mcp__slim__view registered',
      'PASS  mcp:atlassian   connected as plugin:base:atlassian',
      'PASS  mcp:playwright  connected as plugin:base:playwright',
    ])
    expect(out[7]).toBe('doctor: 6 passed, 0 failed, 0 skipped')
  })

  t('one doctor line in base.events, and the events tail in the answer', async ($, on) => {
    const { clock } = world(on, { manifest: manifest([]), run: () => ran(0, staticOut(GREEN)) })
    await start($)
    await clock.advance(125_000)
    const { text } = await doctor($)
    expect(text).toContain('base events (last 1 of 1, newest last):')
    expect(text).toContain('    2m  start      base 0.1.0')
    expect(text).toContain('SKIP  mcp')
    expect(await eventsOf($, 'doctor')).toEqual([{ atMs: NOW + 125_000, kind: 'doctor', text: '4 passed, 0 failed, 1 skipped' }])
  })

  t('BASE_EVENT_LOG=0 → the tail says so and no line is written', async ($, on) => {
    world(on, { env: { BASE_EVENT_LOG: '0' }, manifest: manifest([]), run: () => ran(0, staticOut(GREEN)) })
    await start($)
    const { text } = await doctor($)
    expect(text).toContain('base events: off (BASE_EVENT_LOG=0)')
    expect((await peek($)).events).toEqual([])
  })

  t('slim missing → the live row fails', async ($, on) => {
    const { calls } = world(on, {
      tools: NO_SLIM,
      manifest: manifest([]),
      run: () => ran(0, staticOut(GREEN)),
    })
    await start($)
    const { text } = await doctor($)
    expect(text).toContain(`FAIL  slim-live  ${SLIM_MISSING}; base refuses its readers until it is`)
    expect(calls.toasts).toEqual([])
  })

  t('a slim the install record lacks but the session loaded → WARN, not FAIL', async ($, on) => {
    world(on, {
      manifest: manifest([]),
      run: () => ran(1, staticOut([row('FAIL', 'slim', 'not installed — x')])),
    })
    await start($)
    const { text } = await doctor($)
    expect(text).toContain('WARN  slim       not in installed_plugins.json, yet loaded this session (a --plugin-dir load?)')
    expect(text).not.toContain('FAIL  slim ')
  })

  t('doctor.cjs cannot spawn → one SKIP row; the live rows still answer', async ($, on) => {
    world(on, { manifest: manifest([]), run: null })
    await start($)
    const { text } = await doctor($)
    expect(text).toMatch(/SKIP {2}static +scripts\/doctor\.cjs did not run \(.+\): the static checks need node and the Claude Code CLI/)
    expect(text).toContain('PASS  slim-live')
  })

  t('doctor.cjs without JSON rows → one FAIL row with its first stderr line', async ($, on) => {
    world(on, { manifest: manifest([]), run: () => ran(2, 'not json', 'doctor: unknown argument --json\nusage') })
    await start($)
    const { text } = await doctor($)
    expect(text).toContain('FAIL  static     scripts/doctor.cjs exited 2: doctor: unknown argument --json')
  })

  t('the MCP verdicts: connected, sign-in, the local Figma server, turned off, failed, a rejecting connect', async ($, on) => {
    world(on, {
      manifest: manifest(['atlassian', 'notion-mcp', 'figma-dev-mode', 'shopify-dev-mcp', 'playwright', 'chrome-devtools-mcp']),
      mcp: {
        atlassian: up('atlassian'),
        'notion-mcp': down('auth', 'needs authentication'),
        'figma-dev-mode': down('failed', 'connection refused'),
        'shopify-dev-mcp': down('disabled', 'disabled in /mcp'),
        playwright: down('failed', 'exited 1'),
      },
      run: () => ran(0, staticOut(GREEN)),
    })
    await start($)
    const { text } = await doctor($)
    expect(text).toMatch(/PASS {2}mcp:atlassian +connected as plugin:base:atlassian/)
    expect(text).toMatch(/FAIL {2}mcp:notion-mcp +needs sign-in — \/mcp, then authenticate notion-mcp: needs authentication/)
    expect(text).toMatch(/WARN {2}mcp:figma-dev-mode +connection refused — the Figma desktop app serves it \(Dev Mode\); base:figma-reader falls back to the REST API/)
    expect(text).toMatch(/WARN {2}mcp:shopify-dev-mcp +turned off: disabled in \/mcp/)
    expect(text).toMatch(/FAIL {2}mcp:playwright +failed: exited 1/)
    expect(text).toMatch(/FAIL {2}mcp:chrome-devtools-mcp +\S/)
    expect(text).toContain('doctor: 5 passed, 3 failed, 0 skipped, 2 warned')
  })

  t(`a server that never answers fails after ${MCP_TIMEOUT_MS / 1000} s`, async ($, on) => {
    const { clock } = world(on, { manifest: manifest(['atlassian']), mcp: { atlassian: 'hang' }, run: () => ran(0, staticOut(GREEN)) })
    await start($)
    const pending = doctor($)
    await clock.advance(MCP_TIMEOUT_MS)
    const { text } = await pending
    expect(text).toMatch(/FAIL {2}mcp:atlassian +no answer in 15 s/)
  })

  t('an unreadable manifest → one mcp row', async ($, on) => {
    world(on, { manifest: 'not json', run: () => ran(0, staticOut(GREEN)) })
    await start($)
    const { text } = await doctor($)
    expect(text).toContain("FAIL  mcp        base's manifest is unreadable: no server to check")
  })
})

describe('doctor helpers', () => {
  test('parseStatic keeps well-formed rows only', () => {
    expect(parseStatic(staticOut([row('PASS', 'node'), { status: 'MAYBE', name: 'x', detail: 'y' } as any]))).toEqual([row('PASS', 'node')])
    expect(parseStatic('PASS  node')).toBeNull()
    expect(parseStatic('{"root":"/x"}')).toBeNull()
  })

  test('reconcile touches only a not-installed slim FAIL beside a live slim', () => {
    const rows = [row('FAIL', 'slim', 'not installed — x'), row('FAIL', 'node', 'y')]
    expect(reconcile(rows)).toEqual(rows)
    expect(reconcile([...rows, row('PASS', 'slim-live')])[0]?.status).toBe('WARN')
    expect(reconcile([row('FAIL', 'slim', 'slim@d 0.5.0 is installed but disabled'), row('PASS', 'slim-live')])[0]?.status).toBe('FAIL')
  })

  test('age, summary, render', () => {
    expect([age(-5), age(59_000), age(60_000), age(3_599_000), age(3_600_000), age(47 * 3_600_000), age(48 * 3_600_000)]).toEqual([
      '0s', '59s', '1m', '59m', '1h', '47h', '2d',
    ])
    expect(summary([row('PASS', 'a'), row('WARN', 'b')])).toBe('1 passed, 0 failed, 0 skipped, 1 warned')
    expect(render('/p', [row('PASS', 'a', 'one'), row('FAIL', 'long', 'two')], ['tail'])).toBe(
      ['base doctor — plugin root: /p', 'PASS  a     one', 'FAIL  long  two', 'doctor: 1 passed, 1 failed, 0 skipped', '', 'tail'].join('\n'),
    )
  })
})
