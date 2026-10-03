// Status band writers: usage, model, cache and tick atoms plus the tick timer.
// Nothing here draws; the band reads these atoms.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import type { FndUsage } from '../../../types'
import { CACHE_INIT, HOUR_MS, USAGE_INIT, alarmRate, oneHourCacheTokens, rateCard, toUsage, ttlMsOf } from './lib.ts'
import { lastRender } from './band.tsx'

const TICK_MS = 30_000
const ALARM_TOAST_MS = 8000
const STORE_TTL = 'cacheTtlMs'
const DEBUG_COMMAND = { name: 'fnd-band', description: 'Show the raw figures behind the fnd status band (debug)' }

const usage = atom({ plugin: 'fnd', key: 'usage' } as const, USAGE_INIT)
const model = atom({ plugin: 'fnd', key: 'model' } as const, null)
const cache = atom({ plugin: 'fnd', key: 'cache' } as const, CACHE_INIT)
const tick = atom({ plugin: 'fnd', key: 'tick' } as const, 0)
const progress = atom({ plugin: 'fnd', key: 'progress' } as const, null)
const rateAlarmed = atom({ plugin: 'fnd', key: 'rateAlarmed' } as const, false)

type $ = EngineInterface

async function refresh($: $): Promise<void> {
  const now = await $.clock.now()
  await update($, tick, () => now)
  const u = toUsage(...(await $.session.usage().then(r => [r.context, r.rateLimits, r.cost] as const)))
  await update($, usage, () => u)
  await adoptSubscriptionTtl($, u)
}

/**
 * An API key or a cloud provider bills per request and gets the 5 min cache; without them the session
 * runs on a claude.ai account, whose cache lives 1 h. Only the presence of the variables is read.
 */
async function defaultTtl($: $): Promise<number> {
  const billed = [
    await $.env.get('ANTHROPIC_API_KEY'),
    await $.env.get('CLAUDE_CODE_USE_BEDROCK'),
    await $.env.get('CLAUDE_CODE_USE_VERTEX'),
    await $.env.get('CLAUDE_CODE_USE_FOUNDRY'),
  ].some(v => v !== undefined)
  return billed ? CACHE_INIT.ttlMs : HOUR_MS
}

/**
 * Rate-limit windows arrive only on a claude.ai subscription, whose prompt cache lives 1 h (5 min
 * under an API key or in overage). Until the session reports a TTL itself, that is the best estimate.
 */
async function adoptSubscriptionTtl($: $, u: FndUsage): Promise<void> {
  if (u.rates.length === 0) return
  await update($, cache, c => (c.ttlSource === 'default' ? { ...c, ttlMs: HOUR_MS, ttlSource: 'subscription' } : c))
}

/** Remembers a TTL the session reported, for this session and the next ones. */
async function learnTtl($: $, ttlMs: number, ttlSource: 'model-switch' | 'agent'): Promise<void> {
  await update($, cache, c => ({ ...c, ttlMs, ttlSource }))
  await $.store.set(STORE_TTL, ttlMs)
}

export function registerUsage(on: On, options: PluginOptions): void {
  const forcedTtl = ttlMsOf(options.cacheTtl)

  // Matches every cwd: validate refuses a second unmatched session.start in one plugin.
  on('session.start', { cwd: /./ }, async ($, e, next) => {
    $.clock.every(TICK_MS, () => {
      void refresh($).catch(() => undefined)
    })
    // One throwing session.start hook skips every fnd session.start hook: each $ call fails alone.
    let learned: number | null = null
    if (forcedTtl === null) {
      try {
        const stored = await $.store.get(STORE_TTL)
        learned = typeof stored === 'number' && stored > 0 ? stored : null
      } catch {}
    }
    const ttlMs = forcedTtl ?? learned ?? (await defaultTtl($).catch(() => CACHE_INIT.ttlMs))
    const ttlSource = forcedTtl !== null ? 'option' : learned !== null ? 'store' : 'default'
    await $.command.register(DEBUG_COMMAND).catch(() => undefined)
    await update($, cache, c => ({ ...c, ttlMs, ttlSource }))
    try {
      const m = await $.session.model()
      await update($, model, () => m)
    } catch {}
    await refresh($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: DEBUG_COMMAND.name }, async ($) => {
    const raw = await $.session.usage().catch(err => ({ error: String(err) }))
    const root = await $.session.root().catch(err => `error: ${String(err)}`)
    const c = await read($, cache)
    const u = await read($, usage)
    const p = await read($, progress)
    const lines = [
      'fnd band debug',
      `usage(): ${JSON.stringify(raw)}`,
      `cache: ${JSON.stringify(c)}`,
      `usage atom: ${JSON.stringify(u)}`,
      `progress: ${JSON.stringify(p === null ? null : { workId: p.workId, branch: p.branch })}`,
      `root: ${root}`,
      `render: ${JSON.stringify(lastRender)}`,
      `now: ${await $.clock.now()}`,
    ]
    return { text: lines.join('\n') }
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    const u = toUsage(e.context, e.rateLimits, e.cost)
    await update($, usage, () => u)
    await adoptSubscriptionTtl($, u)
    const hot = alarmRate(u.rates)
    const isAlarmed = await read($, rateAlarmed)
    if (hot && !isAlarmed) {
      await update($, rateAlarmed, () => true)
      $.ui.toast(rateCard(hot, await $.clock.now()), { timeoutMs: ALARM_TOAST_MS })
    } else if (!hot && isAlarmed) {
      await update($, rateAlarmed, () => false)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.usage) {
      const now = await $.clock.now()
      await update($, cache, c => ({ ...c, anchorMs: now, isCold: false }))
      await update($, tick, () => now)
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (r.skip === undefined && r.messages && e.trigger !== 'precompute' && e.agentId === undefined) {
      await update($, cache, c => ({ ...c, isCold: true }))
      await update($, usage, u => ({ ...u, ctxPct: null, ctxTokens: null }))
    }
    return r
  })

  // Atom writes only: one 1.5 s bound covers every session.end hook and aborts a $ call in flight.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, cache, c => ({ ...c, anchorMs: null, isCold: false }))
      await update($, usage, u => ({ ...u, ctxPct: null, ctxTokens: null }))
      await update($, rateAlarmed, () => false)
    }
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    const m = await $.session.model()
    await update($, model, () => m)
    const ttlMs = ttlMsOf(e.cache_ttl)
    if (forcedTtl === null && ttlMs !== null) await learnTtl($, ttlMs, 'model-switch')
    // Caches are per model: a real switch forfeits the warm one. On resume the SessionStart seed decides.
    if (e.source !== 'resume' && (e.from_model !== e.to_model || !e.prompt_cache_warm)) {
      await update($, cache, c => ({ ...c, isCold: true }))
    }
    return next(e)
  })

  on('classic.SessionStart', { source: /^(resume|fork)$/ }, async ($, e, next) => {
    const secs = e.seconds_since_last_response
    if (typeof secs === 'number') {
      const now = await $.clock.now()
      const isCold = e.prompt_cache_likely_expired === true
      await update($, cache, c => ({ ...c, anchorMs: now - secs * 1000, isCold }))
      await update($, tick, () => now)
    }
    return next(e)
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const r = await next(e)
    if (forcedTtl === null && oneHourCacheTokens(r.result) > 0) await learnTtl($, HOUR_MS, 'agent')
    return r
  })
}
