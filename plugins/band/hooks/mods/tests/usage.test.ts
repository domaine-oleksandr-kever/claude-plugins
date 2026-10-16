import { describe, expect } from 'claude-code/testing'
import { HOUR_MS, seedsTtl } from '../lib.ts'
import { ENDPOINT_BODY, KEPT, MIN, SNAP, T0, logged, measure, modelSwitch, ok, peek, peekCache, peekEvents, sibBase, start, test, world } from './world.tsx'

const debug = async ($: any): Promise<string> => (await $.command.run({ command: 'band-debug', args: '' })).text

describe('event log writers → band.events', () => {
  const at = (kind: string, text: string) => ({ atMs: T0, kind, text })

  test('session.start → session start, stamped with the clock', async ($, on) => {
    world(on)
    await start($)
    expect(await peekEvents($)).toEqual([at('session', 'start · band 9.9.9')])
  })

  test('classic.SessionStart resume and fork log their source; startup logs nothing', async ($, on) => {
    world(on)
    on('classic.SessionStart', async () => ({}) as never)
    await start($)
    await $.classic.SessionStart({ source: 'startup', seconds_since_last_response: 600 } as any)
    await $.classic.SessionStart({ source: 'resume' } as any)
    await $.classic.SessionStart({ source: 'fork', seconds_since_last_response: 60 } as any)
    expect(await logged($)).toEqual(['session start · band 9.9.9', 'session resume', 'session fork'])
  })

  test('session.end clear → session clear; other reasons log nothing', async ($, on) => {
    world(on)
    await start($)
    await $.session.end({ reason: 'resume', sessionId: 's1', resume: {} } as any)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as any)
    expect(await logged($)).toEqual(['session start · band 9.9.9', 'session clear'])
  })

  test('classic.SessionStart clear re-seeds the model, TTL and usage the new session id starts without; no new lines', async ($, on) => {
    const { w } = world(on)
    on('classic.SessionStart', async () => ({}) as never)
    // band's state, held here in the host's place: it keeps state per session id, so a /clear empties it.
    const mem = new Map<string, { value: unknown; version: number }>()
    on('state.get', { plugin: 'band' } as any, async (_$: any, e: any) => ({ value: mem.get(e.key) ?? { value: undefined, version: 0 } }) as any)
    on('state.set', { plugin: 'band' } as any, async (_$: any, e: any) => {
      const version = (mem.get(e.key)?.version ?? 0) + 1
      mem.set(e.key, { value: e.value, version })
      return { value: { isSet: true, version } } as any
    })
    await start($)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as any)
    const lines = mem.get('events')
    mem.clear()
    expect((await peek($)).model).toBeNull()
    if (lines) mem.set('events', lines)
    w.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }]
    await $.classic.SessionStart({ source: 'clear' } as any)
    const p = await peek($)
    expect(p.model).toBe('claude-fable-5-1')
    expect(p.usage.rates.map((r: any) => r.pct)).toEqual([12])
    expect(p.cache.ttlMs).toBe(HOUR_MS)
    expect(p.tick).toBe(T0)
    expect(await logged($)).toEqual(['session start · band 9.9.9', 'session clear'])
  })

  test('session.compact → trigger and token sizes; unknown sizes → the trigger alone; precompute, skip, subagent → nothing', async ($, on) => {
    const { w, clock } = world(on)
    await start($)
    await $.session.compact({ trigger: 'precompute', messages: KEPT } as any)
    await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: KEPT } as any)
    w.compact = async () => ({ skip: 'blocked' })
    await $.session.compact({ trigger: 'manual', messages: KEPT } as any)
    w.compact = async () => ({ messages: KEPT, tokensBefore: 412_345, tokensAfter: 38_000 })
    await $.session.compact({ trigger: 'manual', messages: KEPT } as any)
    await clock.advance(MIN)
    w.compact = async () => ({ messages: KEPT })
    await $.session.compact({ trigger: 'auto', messages: KEPT } as any)
    expect(await logged($)).toEqual(['session start · band 9.9.9', 'compact manual 412k → 38k', 'compact auto'])
  })

  test('PostModelSwitch logs the new model once; the same model again logs nothing', async ($, on) => {
    const { w } = world(on)
    on('classic.PostModelSwitch', async () => ({}) as never)
    await start($)
    w.model = 'claude-opus-5-5'
    await $.classic.PostModelSwitch(modelSwitch({}))
    await $.classic.PostModelSwitch(modelSwitch({ from_model: 'claude-opus-5-5' }))
    expect(await logged($)).toEqual(['session start · band 9.9.9', 'model claude-opus-5-5'])
  })

  test('the rate alarm logs its toast text once per alarm', async ($, on) => {
    const { w } = world(on)
    await start($)
    await measure($, { window: 200_000, percent: 10 }, [{ kind: 'five_hour', percentUsed: 91 }])
    await measure($, { window: 200_000, percent: 10 }, [{ kind: 'five_hour', percentUsed: 92 }])
    expect(w.toasts).toEqual(['5h window: 91% used'])
    expect(await peekEvents($)).toEqual([at('session', 'start · band 9.9.9'), at('rate', '5h window: 91% used')])
  })

  test('BAND_EVENT_LOG=0 → nothing recorded, the toasts unchanged', async ($, on) => {
    const { w } = world(on, {}, { BAND_EVENT_LOG: '0' })
    await start($)
    w.compact = async () => ({ messages: KEPT, tokensBefore: 412_345, tokensAfter: 38_000 })
    await $.session.compact({ trigger: 'manual', messages: KEPT } as any)
    await measure($, { window: 200_000, percent: 10 }, [{ kind: 'five_hour', percentUsed: 91 }])
    expect(w.toasts).toEqual(['5h window: 91% used'])
    expect(await peekEvents($)).toEqual([])
  })
})

describe('TTL learning in band\'s store under billedCacheTtlMs', () => {
  test('PostModelSwitch under auto learns 5m for the session and stores nothing', async ($, on) => {
    const { w } = world(on)
    on('classic.PostModelSwitch', async () => ({}) as never)
    await start($)
    await $.classic.PostModelSwitch(modelSwitch({ to_model: 'claude-fable-5-1', cache_ttl: '5m' }))
    expect(await peekCache($)).toMatchObject({ ttlMs: 300_000, ttlSource: 'model-switch', isCold: false })
    expect(w.storeSets).toEqual([])
  })

  test('PostModelSwitch reporting 1h learns it and stores it', async ($, on) => {
    const { w } = world(on, {}, { ANTHROPIC_API_KEY: 'k' })
    on('classic.PostModelSwitch', async () => ({}) as never)
    await start($)
    expect(await peekCache($)).toMatchObject({ ttlMs: 300_000, ttlSource: 'default' })
    await $.classic.PostModelSwitch(modelSwitch({ to_model: 'claude-fable-5-1', cache_ttl: '1h' }))
    expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'model-switch' })
    expect(w.storeSets).toEqual([{ key: 'billedCacheTtlMs', value: 3_600_000 }])
  })

  test('on a subscription a reported 5m is ignored: the host reports it before any 1 h write', async ($, on) => {
    const { w } = world(on)
    w.rateLimits = [{ kind: 'five_hour', percentUsed: 2 }]
    on('classic.PostModelSwitch', async () => ({}) as never)
    await start($)
    expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'subscription' })
    await $.classic.PostModelSwitch(modelSwitch({ to_model: 'claude-fable-5-1', cache_ttl: '5m' }))
    expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'subscription' })
    expect(w.storeSets).toEqual([])
  })

  test('PostModelSwitch with a forced TTL keeps it and stores nothing', { options: { cacheTtl: '1h' } }, async ($, on) => {
    const { w } = world(on)
    on('classic.PostModelSwitch', async () => ({}) as never)
    await start($)
    await $.classic.PostModelSwitch(modelSwitch({ cache_ttl: '5m' }))
    expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'option' })
    expect(w.storeSets).toEqual([])
  })

  test('classic.SessionStart startup changes nothing', async ($, on) => {
    world(on)
    on('classic.SessionStart', async () => ({}) as never)
    await start($)
    await $.classic.SessionStart({ source: 'startup', seconds_since_last_response: 600 } as any)
    expect((await peekCache($)).anchorMs).toBeNull()
  })

  for (const [name, env, stored] of [
    ['billed', { ANTHROPIC_API_KEY: 'k' }, [{ key: 'billedCacheTtlMs', value: 3_600_000 }]],
    ['on a claude.ai account', {}, []],
  ] as const) {
    test(`an Agent result with 1 h cache writes learns 1 h; ${name} it is ${stored.length ? 'stored' : 'not stored'}`, async ($, on) => {
      const { w } = world(on, {}, env)
      on('tool.call', { tool: 'Agent' }, async () => ({
        result: { usage: { cache_creation: { ephemeral_1h_input_tokens: 1200, ephemeral_5m_input_tokens: 0 } } },
      }) as never)
      await start($)
      await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as any)
      expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'agent' })
      expect(w.storeSets).toEqual(stored)
    })
  }

  test('a fresh billed session.start reads the stored TTL', async ($, on) => {
    world(on, { billedCacheTtlMs: 3_600_000 }, { ANTHROPIC_API_KEY: 'k' })
    await start($)
    expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'store' })
  })

  test('a billed session ignores a 1 h remembered from a claude.ai session under the old key', async ($, on) => {
    world(on, { cacheTtlMs: 3_600_000 }, { ANTHROPIC_API_KEY: 'k' })
    await start($)
    expect(await peekCache($)).toMatchObject({ ttlMs: 300_000, ttlSource: 'default' })
  })

  test('a claude.ai session does not read the store: 1 h is its default', async ($, on) => {
    world(on, { billedCacheTtlMs: 300_000 })
    await start($)
    expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'default' })
  })

  test('without a stored TTL, auto starts at 1 h on a claude.ai account and 5 min under an API key', async ($, on) => {
    world(on)
    await start($)
    expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'default' })
  })

  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    test(`${name} set → auto starts at 5 min`, async ($, on) => {
      world(on, {}, { [name]: '1' })
      await start($)
      expect(await peekCache($)).toMatchObject({ ttlMs: 300_000, ttlSource: 'default' })
    })
  }

  for (const name of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    for (const value of ['0', '', 'false']) {
      test(`${name}=${JSON.stringify(value)} is off → auto starts at 1 h`, async ($, on) => {
        world(on, {}, { [name]: value })
        await start($)
        expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'default' })
      })
    }
  }

  test('an empty ANTHROPIC_API_KEY bills nothing → auto starts at 1 h', async ($, on) => {
    world(on, {}, { ANTHROPIC_API_KEY: '' })
    await start($)
    expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'default' })
  })

  test('rate windows mean a subscription → 1 h, from the start reading or a measurement', async ($, on) => {
    const { w } = world(on)
    w.rateLimits = [{ kind: 'five_hour', percentUsed: 2 }]
    await start($)
    expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'subscription' })
  })

  test('a measurement with rate windows adopts 1 h once; a stored, forced or reported TTL wins', async ($, on) => {
    world(on, {}, { ANTHROPIC_API_KEY: 'k' })
    await start($)
    expect(await peekCache($)).toMatchObject({ ttlMs: 300_000, ttlSource: 'default' })
    await measure($, { window: 200_000, percent: 10 }, [{ kind: 'seven_day', percentUsed: 17 }])
    expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'subscription' })
    await measure($, { window: 200_000, percent: 10 }, [])
    expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'subscription' })
  })

  test('a stored 5m TTL yields to the subscription rule; a reported or forced one does not', async ($, on) => {
    world(on, { billedCacheTtlMs: 300_000 }, { ANTHROPIC_API_KEY: 'k' })
    await start($)
    expect(await peekCache($)).toMatchObject({ ttlMs: 300_000, ttlSource: 'store' })
    await measure($, { window: 200_000, percent: 10 }, [{ kind: 'five_hour', percentUsed: 2 }])
    expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'subscription' })
  })

  test('a forced 5m TTL survives rate windows', { options: { cacheTtl: '5m' } }, async ($, on) => {
    world(on)
    await start($)
    await measure($, { window: 200_000, percent: 10 }, [{ kind: 'five_hour', percentUsed: 2 }])
    expect(await peekCache($)).toMatchObject({ ttlMs: 300_000, ttlSource: 'option' })
  })
})

describe('a reload (a /config change runs session.start again)', () => {
  test('no second session start line; a TTL learned from the subscription stays', async ($, on) => {
    const { w } = world(on)
    w.rateLimits = [{ kind: 'five_hour', percentUsed: 2 }]
    await start($)
    expect(await peekCache($)).toMatchObject({ ttlMs: HOUR_MS, ttlSource: 'subscription' })
    await start($)
    expect(await logged($)).toEqual(['session start · band 9.9.9'])
    expect(await peekCache($)).toMatchObject({ ttlMs: HOUR_MS, ttlSource: 'subscription' })
  })

  test('a model-switch TTL survives a reload under auto, where a fresh start would re-read the store', async ($, on) => {
    world(on, {}, { ANTHROPIC_API_KEY: 'k' })
    on('classic.PostModelSwitch', async () => ({}) as never)
    await start($)
    await $.classic.PostModelSwitch(modelSwitch({ to_model: 'claude-fable-5-1', cache_ttl: '5m' }))
    expect(await peekCache($)).toMatchObject({ ttlMs: 300_000, ttlSource: 'model-switch' })
    await start($)
    expect(await peekCache($)).toMatchObject({ ttlMs: 300_000, ttlSource: 'model-switch' })
  })

  test('a forced TTL is applied again on a reload', { options: { cacheTtl: '1h' } }, async ($, on) => {
    world(on, {}, { ANTHROPIC_API_KEY: 'k' })
    await start($)
    await start($)
    expect(await peekCache($)).toMatchObject({ ttlMs: HOUR_MS, ttlSource: 'option' })
    expect(await logged($)).toEqual(['session start · band 9.9.9'])
  })

  test('seedsTtl: a first start and a forced TTL seed; leaving a forced TTL seeds; a learned one stays', () => {
    expect(seedsTtl(false, null, 'default')).toBe(true)
    expect(seedsTtl(true, HOUR_MS, 'subscription')).toBe(true)
    expect(seedsTtl(true, null, 'option')).toBe(true)
    for (const source of ['store', 'model-switch', 'agent', 'subscription', 'default'] as const) {
      expect(seedsTtl(true, null, source)).toBe(false)
    }
  })

  test('after a second start the figures keep refreshing and still one start line', async ($, on) => {
    const { w, clock } = world(on)
    await start($)
    await start($)
    w.context = { window: 200_000, percent: 33 }
    await clock.advance(30_000)
    expect(await peekEvents($)).toHaveLength(1)
    expect((await debug($))).toContain('"ctxPct":33')
  })
})

describe('/band-debug', () => {
  test("prints 'band debug', band.info, the usage figures and base's task as {workId, branch}", async ($, on) => {
    world(on, {}, { SIB_BASE_PROGRESS: JSON.stringify(SNAP) })
    await start($)
    const text = await debug($)
    expect(text.split('\n')[0]).toBe('band debug')
    expect(text).toMatch(/^info: \{"v":1,"version":"[^"]+","disabled":false\}$/m)
    expect(text).toMatch(/^cache: \{/m)
    expect(text).toMatch(/^usage atom: \{"ctxPct":null/m)
    expect(text).toContain('progress: {"workId":"ELC-1591","branch":"feature/ELC-1591-x"}')
  })

  test('without base the task line is null; a malformed snapshot shows nulls, never throws', async ($, on) => {
    const { w } = world(on)
    await start($)
    expect(await debug($)).toContain('progress: null')
    w.vars.SIB_BASE_PROGRESS = JSON.stringify({ workId: 5, branch: ['x'] })
    await sibBase($)
    expect(await debug($)).toContain('progress: {"workId":null,"branch":null}')
  })

  test('disabled shows in the info line', { options: { disabled: true } }, async ($, on) => {
    world(on)
    await start($)
    expect(await debug($)).toMatch(/^info: \{"v":1,"version":"[^"]+","disabled":true\}$/m)
  })
})

describe('the claude.ai usage endpoint', () => {
  const BEARER = { handle: 'h1', kind: 'bearer' as const }
  const CTX = { window: 200_000, percent: 10 }
  const rates = async ($: any) => (await peek($)).usage.rates.map((r: any) => `${r.label} ${r.pct}`)

  test('a measurement keeps its windows and values; the endpoint adds the ones it lacks, 7d·fable among them', async ($, on) => {
    const { w } = world(on)
    w.auth = BEARER
    await start($)
    await measure($, CTX, [{ kind: 'five_hour', percentUsed: 70 }, { kind: 'seven_day', percentUsed: 30 }])
    expect(await rates($)).toEqual(['5h 70', '7d 30', '7d·sonnet 5', '7d·fable 12'])
    expect(w.fetches).toEqual([
      { url: 'https://api.anthropic.com/api/oauth/usage', init: { headers: { 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' }, auth: 'h1' } },
    ])
  })

  test('the desktop measures no window: the endpoint supplies every one, and they mean a subscription', async ($, on) => {
    const { w } = world(on, {}, { ANTHROPIC_API_KEY: '' })
    w.auth = BEARER
    w.surfaces = ['desktop']
    await start($, 'desktop')
    await measure($, CTX, [])
    expect(await rates($)).toEqual(['5h 61', '7d 34', '7d·sonnet 5', '7d·fable 12'])
    expect((await peek($)).usage.rates[0].resetsAt).toBe('2026-10-16T14:05:00Z')
    expect(await peekCache($)).toMatchObject({ ttlMs: HOUR_MS })
  })

  test('no claude.ai login: no request, the measured windows alone, no toast', async ($, on) => {
    const { w } = world(on)
    await start($)
    await measure($, CTX, [{ kind: 'five_hour', percentUsed: 70 }])
    expect(w.fetches).toEqual([])
    expect(await rates($)).toEqual(['5h 70'])
    expect(w.toasts).toEqual([])
    expect(await debug($)).toContain(`endpoint: {"at":${T0},"ok":false,"error":"no claude.ai login","windows":[]}`)
  })

  test('an API-key credential is not sent to the endpoint', async ($, on) => {
    const { w } = world(on)
    w.auth = { handle: 'h2', kind: 'api-key' }
    await start($)
    await measure($, CTX, [])
    expect(w.fetches).toEqual([])
  })

  for (const [name, answer, line] of [
    ['a rejected request', async () => ({ deny: 'refused: nonessential traffic is off\nmore' }), 'refused: nonessential traffic is off'],
    ['a 500', async () => ({ status: 500, ok: false, headers: {}, text: 'oops' }), '"status":500'],
    ['a body that is not JSON', async () => ({ status: 200, ok: true, headers: {}, text: '<html>' }), '"error":"'],
    ['a JSON body that is not an object', async () => ok([1]), '"error":"body is not a JSON object"'],
  ] as const) {
    test(`${name} keeps the last good windows, toasts nothing and shows in /band-debug`, async ($, on) => {
      const { w, clock } = world(on)
      w.auth = BEARER
      await start($)
      w.http = answer as any
      await clock.advance(5 * MIN)
      expect(w.fetches).toHaveLength(2)
      await measure($, CTX, [])
      expect(await rates($)).toEqual(['5h 61', '7d 34', '7d·sonnet 5', '7d·fable 12'])
      expect(w.toasts).toEqual([])
      const text = await debug($)
      expect(text).toMatch(/^endpoint: \{"at":\d+,"ok":false,/m)
      expect(text).toContain(line)
    })
  }

  test('asked at most once per 5 min, success or not; again once 5 min have passed', async ($, on) => {
    const { w, clock } = world(on)
    w.auth = BEARER
    await start($)
    await measure($, CTX, [])
    await measure($, CTX, [])
    expect(w.fetches).toHaveLength(1)
    await clock.advance(4 * MIN)
    await measure($, CTX, [])
    expect(w.fetches).toHaveLength(1)
    w.http = async () => ok({ ...ENDPOINT_BODY, five_hour: { utilization: 64, resets_at: null } })
    await clock.advance(MIN)
    expect(w.fetches).toHaveLength(2)
    expect(await rates($)).toEqual(['5h 64', '7d 34', '7d·sonnet 5', '7d·fable 12'])
  })

  test('without a login at first, it asks again after 5 min and fills in then', async ($, on) => {
    const { w, clock } = world(on)
    await start($)
    w.auth = BEARER
    await measure($, CTX, [])
    expect(w.fetches).toHaveLength(0)
    await clock.advance(5 * MIN)
    expect(w.fetches).toHaveLength(1)
    expect(await rates($)).toEqual(['5h 61', '7d 34', '7d·sonnet 5', '7d·fable 12'])
  })

  test('BAND_USAGE_ENDPOINT=0 → no request, and /band-debug says so', async ($, on) => {
    const { w, clock } = world(on, {}, { BAND_USAGE_ENDPOINT: '0' })
    w.auth = BEARER
    await start($)
    await measure($, CTX, [])
    await clock.advance(6 * MIN)
    expect(w.fetches).toEqual([])
    expect(await rates($)).toEqual([])
    expect(await debug($)).toContain('endpoint: {"at":null,"ok":false,"error":"BAND_USAGE_ENDPOINT=0","windows":[]}')
  })

  test('a request that never answers delays no measure and the alarm, and times out so the next poll runs', async ($, on) => {
    const { w, clock } = world(on)
    w.auth = BEARER
    w.http = () => new Promise(() => {})
    await start($)
    await measure($, CTX, [{ kind: 'five_hour', percentUsed: 50 }])
    w.rateLimits = [{ kind: 'five_hour', percentUsed: 95 }]
    await measure($, CTX, w.rateLimits)
    expect(await rates($)).toEqual(['5h 95'])
    expect(w.toasts).toHaveLength(1)
    await clock.advance(10_000)
    expect(await debug($)).toContain('"error":"timeout"')
    w.http = async () => ok()
    await clock.advance(5 * MIN)
    expect(w.fetches).toHaveLength(2)
    expect(await rates($)).toEqual(['5h 95', '7d 34', '7d·sonnet 5', '7d·fable 12'])
  })

  test('an endpoint window past its reset time goes while the requests fail', async ($, on) => {
    const { w, clock } = world(on)
    w.auth = BEARER
    w.http = async () => ok({ ...ENDPOINT_BODY, five_hour: { utilization: 95, resets_at: new Date(T0 + 7 * MIN).toISOString() } })
    await start($)
    await measure($, CTX, [])
    expect(await rates($)).toEqual(['5h 95', '7d 34', '7d·sonnet 5', '7d·fable 12'])
    w.http = async () => ({ deny: 'refused' })
    await clock.advance(10 * MIN)
    await measure($, CTX, [])
    expect(await rates($)).toEqual(['7d 34', '7d·sonnet 5', '7d·fable 12'])
  })

  test('a claude.ai login that goes away takes its endpoint windows with it', async ($, on) => {
    const { w, clock } = world(on)
    w.auth = BEARER
    await start($)
    await measure($, CTX, [])
    expect(await rates($)).toHaveLength(4)
    w.auth = null
    await clock.advance(5 * MIN)
    expect(await rates($)).toEqual([])
    expect(await debug($)).toMatch(/"error":"no claude\.ai login","windows":\[\]/)
  })

  test('after a /clear the seed brings the cached endpoint windows into the new session without a request', async ($, on) => {
    const { w } = world(on)
    w.auth = BEARER
    on('classic.SessionStart', async () => ({}) as never)
    const mem = new Map<string, { value: unknown; version: number }>()
    on('state.get', { plugin: 'band' } as any, async (_$: any, e: any) => ({ value: mem.get(e.key) ?? { value: undefined, version: 0 } }) as any)
    on('state.set', { plugin: 'band' } as any, async (_$: any, e: any) => {
      const version = (mem.get(e.key)?.version ?? 0) + 1
      mem.set(e.key, { value: e.value, version })
      return { value: { isSet: true, version } } as any
    })
    await start($)
    await measure($, CTX, [])
    expect(await rates($)).toEqual(['5h 61', '7d 34', '7d·sonnet 5', '7d·fable 12'])
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as any)
    mem.clear()
    await $.classic.SessionStart({ source: 'clear' } as any)
    expect(await rates($)).toEqual(['5h 61', '7d 34', '7d·sonnet 5', '7d·fable 12'])
    expect(w.fetches).toHaveLength(1)
  })

  test('/band-debug shows the last answer as its windows, never the body', async ($, on) => {
    const { w } = world(on)
    w.auth = BEARER
    await start($)
    const text = await debug($)
    expect(text).toContain(
      `endpoint: {"at":${T0},"ok":true,"status":200,"windows":[{"kind":"five_hour","pct":61},{"kind":"seven_day","pct":34},{"kind":"seven_day_sonnet","pct":5},{"kind":"seven_day_fable","pct":12}]}`,
    )
    expect(text).not.toContain('extra_usage')
  })
})
