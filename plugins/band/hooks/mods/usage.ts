// Status band writers: usage, model, cache and tick atoms plus the tick timer, band's own event lines
// (session, model, compact, rate) and /band-debug. Nothing here draws; the band reads these atoms.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import type { BandEvent, BandEventKind, BandUsage } from '../../types'
import { DEBUG_COMMAND, fmtK, pushEvent } from './events.ts'
import { CACHE_INIT, HOUR_MS, USAGE_INIT, alarmRate, compactedUsage, keepCtx, oneHourCacheTokens, rateCard, seedsTtl, toUsage, ttlMsOf } from './lib.ts'
import { lastRender, turn } from './band.tsx'

const TICK_MS = 30_000
const ALARM_TOAST_MS = 8000
const STORE_TTL = 'cacheTtlMs'

const usage = atom({ plugin: 'band', key: 'usage' } as const, USAGE_INIT)
const model = atom({ plugin: 'band', key: 'model' } as const, null)
const cache = atom({ plugin: 'band', key: 'cache' } as const, CACHE_INIT)
const tick = atom({ plugin: 'band', key: 'tick' } as const, 0)
const rateAlarmed = atom({ plugin: 'band', key: 'rateAlarmed' } as const, false)
const events = atom({ plugin: 'band', key: 'events' } as const, [] as BandEvent[])
const info = atom({ plugin: 'band', key: 'info' } as const, null)
const progress = atom({ plugin: 'fnd', key: 'progress' } as const, null)

type $ = EngineInterface

/** Appends one event-log line. BAND_EVENT_LOG=0 skips the write. It never throws, because a throwing
 *  session.start hook would skip every band session.start hook. */
async function logEvent($: $, kind: BandEventKind, text: string): Promise<void> {
  try {
    if ((await $.env.get('BAND_EVENT_LOG')) === '0') return
    const atMs = await $.clock.now()
    await update($, events, l => pushEvent(l, { atMs, kind, text }))
  } catch {}
}

/** BAND_COST=1 (true/yes/on) shows the session's cost; off, the figure is dropped before it reaches the atom. */
let costShown = false
const ON = new Set(['1', 'true', 'yes', 'on'])

function withCost(u: BandUsage): BandUsage {
  return costShown ? u : { ...u, costUsd: null }
}

/** Writes the model atom and logs the change once; the same id again is a no-op. */
async function adoptModel($: $, m: string): Promise<void> {
  if ((await read($, model)) === m) return
  await update($, model, () => m)
  await logEvent($, 'model', m)
}

const SAME_COMPACTION_MS = 30_000
let lastCompactMs = 0

/**
 * Cold cache, the context from the engine's count (absent = no reading), one log line. The
 * session.compact chain and the classic PostCompact both report one compaction, in either order: a
 * report within 30 s of the last is the same compaction, and then only a token count refines the context.
 */
async function applyCompaction($: $, trigger: string, tokensAfter?: number, tokensBefore?: number): Promise<void> {
  const now = await $.clock.now()
  const same = now - lastCompactMs < SAME_COMPACTION_MS
  lastCompactMs = now
  await update($, cache, c => ({ ...c, isCold: true }))
  if (same && tokensAfter === undefined) return
  await update($, usage, u => compactedUsage(u, tokensAfter))
  if (same) return
  const sizes = typeof tokensBefore === 'number' && typeof tokensAfter === 'number' ? ` ${fmtK(tokensBefore)} → ${fmtK(tokensAfter)}` : ''
  await logEvent($, 'compact', `${trigger}${sizes}`)
}

async function refresh($: $): Promise<void> {
  const now = await $.clock.now()
  await update($, tick, () => now)
  const u = withCost(toUsage(...(await $.session.usage().then(r => [r.context, r.rateLimits, r.cost] as const))))
  await update($, usage, prev => keepCtx(prev, u))
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
 * under an API key or in overage). Live evidence beats the default and a remembered value alike.
 */
async function adoptSubscriptionTtl($: $, u: BandUsage): Promise<void> {
  if (u.rates.length === 0) return
  await update($, cache, c =>
    c.ttlSource === 'default' || c.ttlSource === 'store' ? { ...c, ttlMs: HOUR_MS, ttlSource: 'subscription' } : c,
  )
}

/**
 * Adopts a TTL the session reported. Only 1 h is remembered for the next sessions: a 5 min report is
 * the host's fallback when it has seen no 1 h cache write yet (every session start on 2.1.289), and
 * remembered it would outlive the session that made it.
 */
async function learnTtl($: $, ttlMs: number, ttlSource: 'model-switch' | 'agent'): Promise<void> {
  await update($, cache, c => ({ ...c, ttlMs, ttlSource }))
  if (ttlMs === HOUR_MS) await $.store.set(STORE_TTL, ttlMs)
}

/** fnd writes the snapshot: only a string or null id and branch are shown. */
function progressLine(p: unknown): { workId: string | null; branch: string | null } | null {
  if (p === null || typeof p !== 'object') return null
  const s = p as { workId?: unknown; branch?: unknown }
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  return { workId: str(s.workId), branch: str(s.branch) }
}

export function registerUsage(on: On, options: PluginOptions): void {
  const forcedTtl = ttlMsOf(options.cacheTtl)

  // A /config change reloads the module and session.start runs again in the same session: the tick, set by
  // the first one, tells a reload apart, so it logs no second start line and keeps a learned TTL.
  on('session.start', async ($, e, next) => {
    $.clock.every(TICK_MS, () => {
      void refresh($).catch(() => undefined)
    })
    // One throwing session.start hook skips every band session.start hook: each $ call fails alone.
    const reloaded = (await read($, tick).catch(() => 0)) > 0
    if (seedsTtl(reloaded, forcedTtl, (await read($, cache).catch(() => CACHE_INIT)).ttlSource)) {
      let learned: number | null = null
      if (forcedTtl === null) {
        try {
          const stored = await $.store.get(STORE_TTL)
          learned = typeof stored === 'number' && stored > 0 ? stored : null
        } catch {}
      }
      const ttlMs = forcedTtl ?? learned ?? (await defaultTtl($).catch(() => CACHE_INIT.ttlMs))
      const ttlSource = forcedTtl !== null ? 'option' : learned !== null ? 'store' : 'default'
      await update($, cache, c => ({ ...c, ttlMs, ttlSource })).catch(() => undefined)
    }
    costShown = ON.has((await $.env.get('BAND_COST').catch(() => undefined))?.trim().toLowerCase() ?? '')
    try {
      const m = await $.session.model()
      await update($, model, () => m)
    } catch {}
    await refresh($).catch(() => undefined)
    // The start line names the drawer: fnd's own line reads `start`, so /band-log tells the two apart.
    if (!reloaded) await logEvent($, 'session', `start · band ${(await read($, info).catch(() => null))?.version ?? '?'}`)
    return next(e)
  })

  on('command.run', { command: DEBUG_COMMAND.name }, async ($) => {
    const raw = await $.session.usage().catch(err => ({ error: String(err) }))
    const root = await $.session.root().catch(err => `error: ${String(err)}`)
    const c = await read($, cache)
    const u = await read($, usage)
    const lines = [
      'band debug',
      `info: ${JSON.stringify(await read($, info))}`,
      `usage(): ${JSON.stringify(raw)}`,
      `cache: ${JSON.stringify(c)}`,
      `usage atom: ${JSON.stringify(u)}`,
      `progress: ${JSON.stringify(progressLine(await read($, progress)))}`,
      `root: ${root}`,
      `render: ${JSON.stringify(lastRender)}`,
      `tick: ${await read($, tick)}`,
      `now: ${await $.clock.now()}`,
    ]
    return { text: lines.join('\n') }
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    const u = withCost(toUsage(e.context, e.rateLimits, e.cost))
    await update($, usage, prev => keepCtx(prev, u))
    await adoptSubscriptionTtl($, u)
    // No session.start follows a /clear and the seed may read null: the first measure fills the gap. A
    // switch whose PostModelSwitch never reached the mod is caught here too.
    try {
      const m = await $.session.model()
      if (m) await adoptModel($, m)
    } catch {}
    const hot = alarmRate(u.rates)
    const isAlarmed = await read($, rateAlarmed)
    if (hot && !isAlarmed) {
      await update($, rateAlarmed, () => true)
      const card = rateCard(hot, await $.clock.now())
      $.ui.toast(card, { timeoutMs: ALARM_TOAST_MS })
      await logEvent($, 'rate', card)
    } else if (!hot && isAlarmed) {
      await update($, rateAlarmed, () => false)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) turn.running = false
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
      await applyCompaction($, e.trigger, r.tokensAfter, r.tokensBefore)
    }
    return r
  })

  // The engine's own report of a main-thread compaction. It reaches the mod when the session.compact
  // chain does not (a Compact press on 2.1.289 left the band warm at the old ctx).
  on('classic.PostCompact', async ($, e, next) => {
    if (e.agent_id === undefined) await applyCompaction($, e.trigger)
    return next(e)
  })

  // Atom writes only: one 1.5 s bound covers every session.end hook and aborts a $ call in flight.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, cache, c => ({ ...c, anchorMs: null, isCold: false }))
      await update($, usage, u => ({ ...u, ctxPct: null, ctxTokens: null }))
      await update($, rateAlarmed, () => false)
    }
    // No session.start follows a /clear: this line marks where the conversation restarted.
    if (e.reason === 'clear') await logEvent($, 'session', 'clear')
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    // The event's own field: $.session.model() may still answer the model before the switch here.
    await adoptModel($, e.to_model)
    // On a subscription (rate windows seen) the cache lives 1 h; a 5 min report there is the host's
    // fallback, not a measurement. Overage does drop it to 5 min, and the band hides the segment then.
    const ttlMs = ttlMsOf(e.cache_ttl)
    const subscribed = (await read($, usage)).rates.length > 0
    if (forcedTtl === null && ttlMs !== null && !(subscribed && ttlMs !== HOUR_MS)) await learnTtl($, ttlMs, 'model-switch')
    // Caches are per model: a real switch forfeits the warm one. On resume the SessionStart seed decides.
    if (e.source !== 'resume' && (e.from_model !== e.to_model || !e.prompt_cache_warm)) {
      await update($, cache, c => ({ ...c, isCold: true }))
    }
    return next(e)
  })

  on('classic.SessionStart', { source: /^(resume|fork)$/ }, async ($, e, next) => {
    await logEvent($, 'session', e.source)
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
