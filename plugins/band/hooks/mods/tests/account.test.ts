import { describe, expect } from 'claude-code/testing'
import { CLEAR_RESEED_MS } from '../lib.ts'
import { MIN, T0, ok, peek, start, test, world } from './world.tsx'

const HOME = '/Users/dev'
const BEARER = { handle: 'h1', kind: 'bearer' as const }
/** BAND_EVENT_LOG=0: with a HOME set, band would otherwise try to write band.jsonl into the kit's file system. */
const ENV = { HOME, BAND_EVENT_LOG: '0' }
const record = (oauthAccount: unknown) => JSON.stringify({ numStartups: 4, oauthAccount })
const TEAM = { organizationType: 'claude_team', emailAddress: 'dev@corp.co', organizationName: 'Domaine Worldwide (2)', organizationRole: 'user', seatTier: 'standard', displayName: 'Dev' }

const account = async ($: any) => (await peek($)).account
const debug = async ($: any): Promise<string> => (await $.command.run({ command: 'band-debug', args: '' })).text

describe('band.account from the login record', () => {
  for (const [plan, label] of [
    ['claude_team', 'work'],
    ['claude_enterprise', 'work'],
    ['claude_max', 'personal'],
    ['claude_pro', 'personal'],
    ['free', 'personal'],
  ] as const) {
    test(`${plan} → ${label}`, async ($, on) => {
      const { w } = world(on, {}, ENV)
      w.auth = BEARER
      w.files[`${HOME}/.claude.json`] = record({ ...TEAM, organizationType: plan })
      await start($)
      expect(await account($)).toEqual({
        label,
        plan,
        email: 'dev@corp.co',
        org: 'Domaine Worldwide (2)',
        role: 'user',
        configDir: '~/.claude',
        source: 'login record',
        hiddenModels: [],
        hiddenReason: null,
      })
      expect(w.profileFetches).toEqual([])
    })
  }

  test('CLAUDE_CONFIG_DIR names the login record: <dir>/.claude.json, not HOME\'s', async ($, on) => {
    const { w } = world(on, {}, { ...ENV, CLAUDE_CONFIG_DIR: `${HOME}/.claude-cloudcon` })
    w.auth = BEARER
    w.files[`${HOME}/.claude.json`] = record({ organizationType: 'claude_max' })
    w.files[`${HOME}/.claude-cloudcon/.claude.json`] = record(TEAM)
    await start($)
    expect(await account($)).toMatchObject({ label: 'work', plan: 'claude_team', configDir: '~/.claude-cloudcon', source: 'login record' })
  })

  test('an oauthAccount without a plan → no segment, and the profile endpoint is not asked', async ($, on) => {
    const { w } = world(on, {}, ENV)
    w.auth = BEARER
    w.files[`${HOME}/.claude.json`] = record({ emailAddress: 'dev@corp.co' })
    await start($)
    expect(await account($)).toBeNull()
    expect(w.profileFetches).toEqual([])
    expect(await debug($)).toContain('"error":"no plan"')
  })

  for (const [name, auth] of [
    ['no claude.ai login', null],
    ['an API-key session', { handle: 'h2', kind: 'api-key' as const }],
  ] as const) {
    test(`${name} → no segment, the login record never read, and no request`, async ($, on) => {
      const { w, clock } = world(on, {}, ENV)
      w.auth = auth
      let reads = 0
      Object.defineProperty(w.files, `${HOME}/.claude.json`, { enumerable: true, get: () => (reads++, record(TEAM)) })
      await start($)
      await clock.advance(6 * MIN)
      expect(await account($)).toBeNull()
      expect(reads).toBe(0)
      expect(w.profileFetches).toEqual([])
    })
  }
})

describe('band.account hiddenModels from the login record', () => {
  /** The Team login's record as the host writes it while the org has no credits for the credit-gated Fable. */
  const gated = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      oauthAccount: { ...TEAM, hasExtraUsageEnabled: true },
      additionalModelOptionsCache: [{ value: 'claude-fable-5-1[1m]', label: 'Fable', description: 'Credit-gated' }],
      cachedExtraUsageDisabledReason: 'out_of_credits',
      modelAccessCache: [],
      cachedGrowthBookFeatures: { tengu_saffron_lattice: { enabled: true, planLimitsEndDate: '2026-07-20T07:00:00Z' } },
      ...extra,
    })

  test('a Team record out of credits → fable hidden, out_of_credits, in the atom and /band-debug', async ($, on) => {
    const { w } = world(on, {}, { ...ENV, CLAUDE_CONFIG_DIR: `${HOME}/.claude-cloudcon` })
    w.auth = BEARER
    w.files[`${HOME}/.claude-cloudcon/.claude.json`] = gated()
    await start($)
    expect(await account($)).toMatchObject({ label: 'work', hiddenModels: ['fable'], hiddenReason: 'out_of_credits' })
    expect(await debug($)).toContain('"hiddenModels":["fable"],"hiddenReason":"out_of_credits"')
  })

  test('extra usage usable → nothing hidden', async ($, on) => {
    const { w } = world(on, {}, ENV)
    w.auth = BEARER
    w.files[`${HOME}/.claude.json`] = gated({ cachedExtraUsageDisabledReason: null })
    await start($)
    expect(await account($)).toMatchObject({ label: 'work', hiddenModels: [], hiddenReason: null })
  })

  test('the personal record (no oauthAccount, no gating keys) → the profile endpoint names it, nothing hidden', async ($, on) => {
    const { w } = world(on, {}, ENV)
    w.auth = BEARER
    w.files[`${HOME}/.claude.json`] = JSON.stringify({ numStartups: 9 })
    w.profile = async () => ok({ account: { email: 'me@home.co' }, organization: { organization_type: 'claude_max' } })
    await start($)
    await peek($)
    expect(await account($)).toMatchObject({ label: 'personal', source: 'profile endpoint', hiddenModels: [], hiddenReason: null })
  })

  test('a gated record that names no plan → no label (no segment), and fable still hidden', async ($, on) => {
    const { w } = world(on, {}, ENV)
    w.auth = BEARER
    w.files[`${HOME}/.claude.json`] = gated({ oauthAccount: { emailAddress: 'dev@corp.co', hasExtraUsageEnabled: true } })
    await start($)
    expect(await account($)).toMatchObject({ label: null, source: null, email: null, hiddenModels: ['fable'], hiddenReason: 'out_of_credits' })
    expect(await debug($)).toContain('"error":"no plan"')
  })

  test('a gated record without oauthAccount and a failed profile request → no label, fable still hidden', async ($, on) => {
    const { w, clock } = world(on, {}, ENV)
    w.auth = BEARER
    w.files[`${HOME}/.claude.json`] = gated({ oauthAccount: undefined })
    w.profile = async () => ({ status: 500, ok: false, headers: {}, text: 'oops' })
    await start($)
    await peek($)
    expect(await account($)).toMatchObject({ label: null, source: null, hiddenModels: ['fable'], hiddenReason: 'out_of_credits' })
    await clock.advance(6 * MIN)
    expect(await account($)).toMatchObject({ label: null, hiddenModels: ['fable'] })
    expect(w.profileFetches).toHaveLength(1)
  })

  test('BAND_ACCOUNT=work still reads the record for the hidden families; BAND_ACCOUNT=0 reads nothing, so none', async ($, on) => {
    const { w } = world(on, {}, { ...ENV, BAND_ACCOUNT: 'work' })
    w.files[`${HOME}/.claude.json`] = gated()
    await start($)
    expect(await account($)).toMatchObject({ label: 'work', source: 'BAND_ACCOUNT', hiddenModels: ['fable'], hiddenReason: 'out_of_credits' })
    w.vars.BAND_ACCOUNT = '0'
    await start($)
    expect(await account($)).toBeNull()
  })
})

describe('band.account from the profile endpoint', () => {
  const PROFILE = { account: { uuid: 'u', email: 'me@home.co' }, organization: { uuid: 'o', organization_type: 'claude_max', name: "me's Organization" } }

  test('no login record → the profile endpoint once, with the session credential and the oauth beta header', async ($, on) => {
    const { w, clock } = world(on, {}, ENV)
    w.auth = BEARER
    w.profile = async () => ok(PROFILE)
    await start($)
    await peek($)
    expect(await account($)).toEqual({ label: 'personal', plan: 'claude_max', email: 'me@home.co', org: "me's Organization", role: null, configDir: '~/.claude', source: 'profile endpoint', hiddenModels: [], hiddenReason: null })
    expect(w.profileFetches).toEqual([
      { url: 'https://api.anthropic.com/api/oauth/profile', init: { headers: { 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' }, auth: 'h1' } },
    ])
    await clock.advance(11 * MIN)
    expect(w.profileFetches).toHaveLength(1)
  })

  for (const [name, file] of [
    ['malformed JSON', '{"oauthAccount": '],
    ['a record without oauthAccount', JSON.stringify({ numStartups: 1 })],
  ] as const) {
    test(`${name} → the profile endpoint; its failure → no segment, silently, and asked no more`, async ($, on) => {
      const { w, clock } = world(on, {}, ENV)
      w.auth = BEARER
      w.files[`${HOME}/.claude.json`] = file
      w.profile = async () => ({ deny: 'refused: nonessential traffic is off' })
      await start($)
      await peek($)
      expect(await account($)).toBeNull()
      expect(w.toasts).toEqual([])
      expect(w.profileFetches).toHaveLength(1)
      await clock.advance(6 * MIN)
      expect(w.profileFetches).toHaveLength(1)
      expect(await debug($)).toMatch(/; profile: .*refused: nonessential traffic is off/)
    })
  }

  for (const [name, answer] of [
    ['a 500', async () => ({ status: 500, ok: false, headers: {}, text: 'oops' })],
    ['a body that is not JSON', async () => ({ status: 200, ok: true, headers: {}, text: '<html>' })],
    ['a body with neither plan nor email', async () => ok({ account: {}, organization: [] })],
  ] as const) {
    test(`missing file and ${name} → no segment`, async ($, on) => {
      const { w } = world(on, {}, ENV)
      w.auth = BEARER
      w.profile = answer as any
      await start($)
      await peek($)
      expect(await account($)).toBeNull()
      expect(w.toasts).toEqual([])
    })
  }

  test('a profile request that never answers blocks neither session start nor the band, and times out', async ($, on) => {
    const { w, clock } = world(on, {}, ENV)
    w.auth = BEARER
    w.profile = () => new Promise(() => {})
    await start($)
    expect(await account($)).toBeNull()
    expect(await debug($)).toContain('profile: asking')
    await clock.advance(10_000)
    expect(await debug($)).toMatch(/^account: .*"mode":"on"/m)
    await clock.advance(5 * MIN)
    expect(await debug($)).toContain('profile: timeout')
    expect(w.profileFetches).toHaveLength(1)
  })
})

describe('BAND_ACCOUNT', () => {
  test('0 → no segment, nothing read or asked, and /band-debug says so', async ($, on) => {
    const { w, clock } = world(on, {}, { ...ENV, BAND_ACCOUNT: '0' })
    w.auth = BEARER
    w.files[`${HOME}/.claude.json`] = record(TEAM)
    await start($)
    await clock.advance(6 * MIN)
    expect(await account($)).toBeNull()
    expect(w.profileFetches).toEqual([])
    expect(await debug($)).toContain(`account: {"atom":null,"last":{"mode":"off","at":${T0},"source":"none","error":"BAND_ACCOUNT=0"}}`)
  })

  for (const label of ['work', 'personal'] as const) {
    test(`${label} forces the label without a login, and the card source says BAND_ACCOUNT`, async ($, on) => {
      const { w } = world(on, {}, { ...ENV, BAND_ACCOUNT: label })
      w.files[`${HOME}/.claude.json`] = record({ organizationType: label === 'work' ? 'claude_max' : 'claude_team' })
      await start($)
      expect(await account($)).toEqual({ label, plan: null, email: null, org: null, role: null, configDir: '~/.claude', source: 'BAND_ACCOUNT', hiddenModels: [], hiddenReason: null })
      expect(w.profileFetches).toEqual([])
    })
  }

  for (const value of [undefined, '1', 'yes']) {
    test(`${JSON.stringify(value)} reads the login (on by default)`, async ($, on) => {
      const { w } = world(on, {}, { ...ENV, ...(value === undefined ? {} : { BAND_ACCOUNT: value }) })
      w.auth = BEARER
      w.files[`${HOME}/.claude.json`] = record(TEAM)
      await start($)
      expect((await account($))?.label).toBe('work')
    })
  }
})

describe('refresh', () => {
  test('no login at start: read again every 5 min, so a later login shows up', async ($, on) => {
    const { w, clock } = world(on, {}, ENV)
    await start($)
    expect(await account($)).toBeNull()
    w.auth = BEARER
    w.files[`${HOME}/.claude.json`] = record(TEAM)
    await clock.advance(4 * MIN)
    expect(await account($)).toBeNull()
    await clock.advance(MIN)
    expect((await account($))?.label).toBe('work')
  })

  test('a /clear empties the state: the read armed at its session.end refills it; the 30 s check backs it up', async ($, on) => {
    const { w, clock } = world(on, {}, ENV)
    w.auth = BEARER
    w.files[`${HOME}/.claude.json`] = record(TEAM)
    const mem = new Map<string, { value: unknown; version: number }>()
    on('state.get', { plugin: 'band' } as any, async (_$: any, e: any) => ({ value: mem.get(e.key) ?? { value: undefined, version: 0 } }) as any)
    on('state.set', { plugin: 'band' } as any, async (_$: any, e: any) => {
      const version = (mem.get(e.key)?.version ?? 0) + 1
      mem.set(e.key, { value: e.value, version })
      return { value: { isSet: true, version } } as any
    })
    await start($)
    expect((await account($))?.label).toBe('work')
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as any)
    mem.clear()
    expect(await account($)).toBeNull()
    await clock.advance(CLEAR_RESEED_MS)
    expect((await account($))?.label).toBe('work')
    mem.clear()
    w.files[`${HOME}/.claude.json`] = record({ organizationType: 'claude_max' })
    expect(await account($)).toBeNull()
    await clock.advance(30_000)
    expect((await account($))?.label).toBe('personal')
  })

  test('a /login to another account mid-session shows within 5 min', async ($, on) => {
    const { w, clock } = world(on, {}, ENV)
    w.auth = BEARER
    w.files[`${HOME}/.claude.json`] = record({ organizationType: 'claude_max' })
    await start($)
    expect((await account($))?.label).toBe('personal')
    w.files[`${HOME}/.claude.json`] = record(TEAM)
    await clock.advance(4 * MIN)
    expect((await account($))?.label).toBe('personal')
    await clock.advance(MIN)
    expect((await account($))?.label).toBe('work')
  })

  test('a read that throws is retried every 5 min, not every 30 s', async ($, on) => {
    const { w, clock } = world(on, {}, ENV)
    w.files[`${HOME}/.claude.json`] = record(TEAM)
    Object.defineProperty(w, 'auth', {
      get() {
        throw new Error('authorize denied')
      },
    })
    await start($)
    expect(await debug($)).toMatch(new RegExp(`^account: .*"at":${T0},"source":"none","error":"`, 'm'))
    await clock.advance(4.5 * MIN)
    expect(await debug($)).toMatch(new RegExp(`^account: .*"at":${T0},`, 'm'))
    await clock.advance(MIN)
    expect(await debug($)).toMatch(new RegExp(`^account: .*"at":${T0 + 5 * MIN},`, 'm'))
  })

  test('a relative CLAUDE_CONFIG_DIR never reads HOME\'s record: ~/ means HOME, anything else asks the profile endpoint', async ($, on) => {
    const { w } = world(on, {}, { ...ENV, CLAUDE_CONFIG_DIR: 'cloudcon' })
    w.auth = BEARER
    w.files[`${HOME}/.claude.json`] = record({ organizationType: 'claude_max' })
    w.profile = async () => ok({ account: { email: 'dev@corp.co' }, organization: { organization_type: 'claude_team', name: 'Domaine' } })
    await start($)
    await peek($)
    expect(await account($)).toMatchObject({ label: 'work', configDir: 'cloudcon', source: 'profile endpoint' })
  })

  test('CLAUDE_CONFIG_DIR=~/.claude-cloudcon reads <HOME>/.claude-cloudcon/.claude.json', async ($, on) => {
    const { w } = world(on, {}, { ...ENV, CLAUDE_CONFIG_DIR: '~/.claude-cloudcon' })
    w.auth = BEARER
    w.files[`${HOME}/.claude.json`] = record({ organizationType: 'claude_max' })
    w.files[`${HOME}/.claude-cloudcon/.claude.json`] = record(TEAM)
    await start($)
    expect(await account($)).toMatchObject({ label: 'work', configDir: '~/.claude-cloudcon', source: 'login record' })
  })

  test('/band-debug shows the atom and the last read', async ($, on) => {
    const { w } = world(on, {}, ENV)
    w.auth = BEARER
    w.files[`${HOME}/.claude.json`] = record(TEAM)
    await start($)
    expect(await debug($)).toContain(
      `account: {"atom":{"plan":"claude_team","email":"dev@corp.co","org":"Domaine Worldwide (2)","role":"user","configDir":"~/.claude","hiddenModels":[],"hiddenReason":null,"label":"work","source":"login record"},"last":{"mode":"on","at":${T0},"source":"login record"}}`,
    )
  })
})
