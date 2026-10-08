import { describe, expect } from 'claude-code/testing'
import { HOUR_MS, seedsTtl } from '../lib.ts'
import { KEPT, MIN, SNAP, T0, baseState, logged, measure, modelSwitch, peekCache, peekEvents, sibFnd, start, test, world } from './world.tsx'

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

describe('TTL learning in band\'s store under cacheTtlMs', () => {
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
    expect(w.storeSets).toEqual([{ key: 'cacheTtlMs', value: 3_600_000 }])
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

  test('an Agent result with 1 h cache writes learns 1 h', async ($, on) => {
    const { w } = world(on)
    on('tool.call', { tool: 'Agent' }, async () => ({
      result: { usage: { cache_creation: { ephemeral_1h_input_tokens: 1200, ephemeral_5m_input_tokens: 0 } } },
    }) as never)
    await start($)
    await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as any)
    expect(await peekCache($)).toMatchObject({ ttlMs: 3_600_000, ttlSource: 'agent' })
    expect(w.storeSets).toEqual([{ key: 'cacheTtlMs', value: 3_600_000 }])
  })

  test('a fresh session.start reads the stored TTL', async ($, on) => {
    world(on, { cacheTtlMs: 3_600_000 })
    await start($)
    expect((await peekCache($)).ttlMs).toBe(3_600_000)
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
    world(on, { cacheTtlMs: 300_000 })
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
    for (const source of ['store', 'model-switch', 'agent', 'subscription', 'resume', 'default'] as const) {
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
  test("prints 'band debug', band.info, the usage figures and fnd's task as {workId, branch}", async ($, on) => {
    world(on, {}, { SIB_FND_PROGRESS: JSON.stringify(SNAP) })
    await start($)
    const text = await debug($)
    expect(text.split('\n')[0]).toBe('band debug')
    expect(text).toMatch(/^info: \{"v":1,"version":"[^"]+","disabled":false\}$/m)
    expect(text).toMatch(/^cache: \{/m)
    expect(text).toMatch(/^usage atom: \{"ctxPct":null/m)
    expect(text).toContain('progress: {"workId":"ELC-1591","branch":"feature/ELC-1591-x"}')
    expect(text).toMatch(/^publisher: fnd$/m)
  })

  test("base's task beats fnd's and names base as the publisher", async ($, on) => {
    world(on, {}, { SIB_FND_PROGRESS: JSON.stringify(SNAP) })
    const base = baseState(on, { progress: { workId: 'ABC-7', branch: 'feature/ABC-7-x' } })
    await start($)
    const text = await debug($)
    expect(text).toContain('progress: {"workId":"ABC-7","branch":"feature/ABC-7-x"}')
    expect(text).toMatch(/^publisher: base$/m)
    base.progress = null
    expect(await debug($)).toMatch(/^publisher: fnd$/m)
  })

  test('without base and fnd the task line is null; a malformed snapshot shows nulls, never throws', async ($, on) => {
    const { w } = world(on)
    await start($)
    expect(await debug($)).toContain('progress: null')
    expect(await debug($)).toMatch(/^publisher: none$/m)
    w.vars.SIB_FND_PROGRESS = JSON.stringify({ workId: 5, branch: ['x'] })
    await sibFnd($)
    expect(await debug($)).toContain('progress: {"workId":null,"branch":null}')
  })

  test('disabled shows in the info line', { options: { disabled: true } }, async ($, on) => {
    world(on)
    await start($)
    expect(await debug($)).toMatch(/^info: \{"v":1,"version":"[^"]+","disabled":true\}$/m)
  })
})
