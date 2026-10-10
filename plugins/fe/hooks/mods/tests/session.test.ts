import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { BASE_MISSING, PROFILE_TIMEOUT_MS, profileText } from '../session.ts'
import { NOW, PEEK, ROOT, compose, eventsOf, ours, peek, put, ran, start, world } from './world.ts'

const t = (name: string, body: ($: any, on: On) => Promise<void>) => test(name, { plugins: [PEEK] }, body)
const profileOf = async ($: any) => ours(await compose($)).find(s => s.id === 'fe:profile')!.text

describe('start line and the base check', () => {
  t('one start line per session with the manifest version; a reloaded start writes none', async ($, on) => {
    const { w } = world(on, { manifest: '{ "name": "fe", "version": "1.2.3" }' })
    await start($)
    await start($)
    expect(await eventsOf($, 'start')).toEqual([{ atMs: NOW, kind: 'start', text: 'fe 1.2.3' }])
    expect((await peek($)).started).toBe('s1')
    w.sid = 's2'
    await start($)
    expect((await eventsOf($, 'start')).map(ev => ev.text)).toEqual(['fe 1.2.3', 'fe 1.2.3'])
  })

  t('an unreadable manifest → fe unknown', async ($, on) => {
    world(on, { manifest: 'not json' })
    await start($)
    expect((await eventsOf($, 'start')).map(ev => ev.text)).toEqual(['fe unknown'])
  })

  t('base loaded → nothing said', async ($, on) => {
    const { calls } = world(on)
    await start($)
    expect(calls.toasts).toEqual([])
    expect(await eventsOf($, 'install')).toEqual([])
  })

  t('base absent → one toast and one install line with the pointer, once per session', async ($, on) => {
    const { w, calls } = world(on, { commands: [['slim-log', 'slim'], ['band-log', 'band']] })
    await start($)
    await start($)
    expect(calls.toasts).toEqual(['fe: needs the base plugin — claude plugin install base@domaine'])
    expect(await eventsOf($, 'install')).toEqual([{ atMs: NOW, kind: 'install', text: BASE_MISSING }])
    w.sid = 's2'
    await start($)
    expect(calls.toasts).toHaveLength(2)
  })

  t('a command list that fails says nothing', async ($, on) => {
    const { calls } = world(on, { commands: null })
    await start($)
    expect(calls.toasts).toEqual([])
  })

  t('FE_EVENT_LOG=0 keeps the list empty; the toast still shows', async ($, on) => {
    const { calls } = world(on, { env: { FE_EVENT_LOG: '0' }, commands: [] })
    await start($)
    await compose($)
    expect((await peek($)).events).toEqual([])
    expect(calls.toasts).toEqual([`fe: ${BASE_MISSING}`])
  })
})

describe('the project profile', () => {
  t('decided at session start by project-profile.sh on the session root, logged once after the start line', async ($, on) => {
    const { calls, clock } = world(on, { profile: () => ran(0, 'foundation\n') })
    await start($)
    await clock.settle()
    expect(calls.profiles).toHaveLength(1)
    expect(calls.profiles[0]!.argv.slice(2)).toEqual([ROOT])
    expect(calls.profiles[0]!.init?.timeoutMs).toBe(PROFILE_TIMEOUT_MS)
    expect((await peek($)).profile).toEqual({ session: 's1', word: 'foundation', via: 'project-profile.sh', why: null, toml: false, store: false })
    expect((await eventsOf($)).map(ev => [ev.kind, ev.text])).toEqual([
      ['start', 'fe 0.1.0'],
      ['profile', 'foundation (project-profile.sh)'],
    ])
    expect(await profileOf($)).toBe('fe project profile: foundation')
    expect(calls.profiles).toHaveLength(1)
  })

  t('FE_PROFILE forces the word without running the probe', async ($, on) => {
    const { calls } = world(on, { env: { FE_PROFILE: 'none' } })
    expect(await profileOf($)).toBe('fe project profile: none')
    expect(calls.profiles).toEqual([])
    expect((await eventsOf($, 'profile')).map(ev => ev.text)).toEqual(['none (FE_PROFILE)'])
  })

  t('an FE_PROFILE that is not one of the three words goes to the probe', async ($, on) => {
    const { calls } = world(on, { env: { FE_PROFILE: 'Foundation' } })
    expect(await profileOf($)).toBe('fe project profile: theme')
    expect(calls.profiles).toHaveLength(1)
  })

  for (const [label, answer, why] of [
    ['a non-zero exit', () => ran(2, '', 'error=no_such_dir dir=/repo\nmore'), 'project-profile.sh exited 2: error=no_such_dir dir=/repo'],
    ['a word outside the three', () => ran(0, 'shopify\n'), 'project-profile.sh exited 0: shopify'],
    ['a probe that cannot start or times out', () => null, 'project-profile.sh did not run: '],
  ] as const) {
    t(`${label} → none, one profile line saying why, the session goes on`, async ($, on) => {
      world(on, { profile: answer })
      expect(await profileOf($)).toBe('fe project profile: none')
      const p = (await peek($)).profile
      expect(p).toMatchObject({ word: 'none', via: 'fallback' })
      expect(p.why).toStartWith(why)
      const lines = await eventsOf($, 'profile')
      expect(lines).toHaveLength(1)
      expect(lines[0]!.text).toStartWith(`none (fallback: ${why}`)
    })
  }

  t('the store gate is decided with the profile', async ($, on) => {
    const { w } = world(on)
    put(w, 'shopify.theme.toml')
    await compose($)
    expect((await peek($)).profile).toMatchObject({ toml: true, store: true })
  })

  t('a /clear (a new session id, no session.start) decides again at its first render', async ($, on) => {
    const { w, calls } = world(on)
    await compose($)
    w.sid = 's2'
    w.profile = () => ran(0, 'none\n')
    expect(await profileOf($)).toBe('fe project profile: none')
    expect(calls.profiles).toHaveLength(2)
    expect((await peek($)).profile.session).toBe('s2')
  })

  test('profileText', () => {
    expect(profileText({ session: 's', word: 'theme', via: 'project-profile.sh', why: null, toml: false, store: false })).toBe('theme (project-profile.sh)')
    expect(profileText({ session: 's', word: 'none', via: 'fallback', why: 'x', toml: false, store: false })).toBe('none (fallback: x)')
  })
})
