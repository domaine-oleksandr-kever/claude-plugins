// Status band writers: usage, model, cache and tick atoms plus the tick timer, the claude.ai usage endpoint
// poll, band's own event lines (session, model, compact, rate) with their file on disk, and /band-debug
// (account.ts writes the account atom).
// Nothing here draws; the band reads these atoms.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, Timer } from 'claude-code'
import type { BandEvent, BandEventKind, BandRate, BandUsage } from '../../types'
import { DEBUG_COMMAND, capLines, fileLine, fmtK, logDir, pushEvent, seedLines } from './events.ts'
import { CACHE_INIT, CLEAR_RESEED_MS, HOUR_MS, USAGE_INIT, alarmRate, compactedUsage, endpointRates, keepCtx, mergeRates, oneHourCacheTokens, rateCard, seedsTtl, toRates, toUsage, ttlMsOf } from './lib.ts'
import { lastRender, turn } from './band.tsx'
import { accountDebug } from './account.ts'

const TICK_MS = 30_000
const ALARM_TOAST_MS = 8000
/** A 1 h TTL learned in a billed session; a claude.ai account starts at 1 h anyway, so it stores none. */
const STORE_TTL = 'billedCacheTtlMs'
/** Below this much of session.end's shared bound, `session clear` stays off the disk rather than risk an abort. */
const END_FILE_MIN_MS = 500

const usage = atom({ plugin: 'band', key: 'usage' } as const, USAGE_INIT)
const model = atom({ plugin: 'band', key: 'model' } as const, null)
const cache = atom({ plugin: 'band', key: 'cache' } as const, CACHE_INIT)
const tick = atom({ plugin: 'band', key: 'tick' } as const, 0)
const rateAlarmed = atom({ plugin: 'band', key: 'rateAlarmed' } as const, false)
const events = atom({ plugin: 'band', key: 'events' } as const, [] as BandEvent[])
const info = atom({ plugin: 'band', key: 'info' } as const, null)
const account = atom({ plugin: 'band', key: 'account' } as const, null)
const baseProgress = atom({ plugin: 'base', key: 'progress' } as const, null)

type $ = EngineInterface

/** This session's lines of band.jsonl as last written; `path` tells a new session (or a reload) apart. */
let file: { path: string; lines: string[] } | null = null
let fileVersion: string | null = null
let toastedFor: string | null = null
/** Whole-file writes, one at a time: two hooks writing at once would each drop the other's line. */
let fileQueue: Promise<void> = Promise.resolve()

/**
 * Appends one line to `<dir>/<session-id>/band.jsonl`, rewriting the whole file (the engine writes no
 * append). The first write of a module or of a new session id seeds from the file, so a reload keeps the
 * record. A session's first line is a start line, as no session.start follows a /clear or a resume; a
 * start line comes once per session, so a fresh process resuming an id whose file has one adds none. `sid`
 * pins the session (session.end names the ending one). No HOME and no DOMAINE_LOG_DIR → no file. A
 * failure toasts once per session unless `quiet`, and goes no further.
 */
async function writeFileLine($: $, atMs: number, kind: string, text: string, sid?: string, quiet = false): Promise<void> {
  let id = sid ?? ''
  try {
    id = sid ?? String(await $.session.id())
    const dir = logDir(await $.env.get('HOME'), await $.env.get('DOMAINE_LOG_DIR'), id)
    if (dir === null) return
    const path = `${dir}/band.jsonl`
    fileVersion ??= (await read($, info).catch(() => null))?.version ?? null
    const version = fileVersion ?? 'unknown'
    let prior = file?.path === path ? file.lines : seedLines((await $.fs.exists(path)) ? String(await $.fs.read(path)) : '', id)
    if (kind === 'start' && prior.some(l => JSON.parse(l).kind === 'start')) {
      file = { path, lines: prior }
      return
    }
    if (kind !== 'start' && !prior.length) prior = [fileLine(atMs, version, id, 'start', `band ${version}`)]
    const lines = capLines([...prior, fileLine(atMs, version, id, kind, text)])
    file = { path, lines }
    await $.fs.write(path, `${lines.join('\n')}\n`)
  } catch (err) {
    if (quiet || toastedFor === id) return
    toastedFor = id
    try {
      $.ui.toast(`band: event log not written: ${err instanceof Error ? err.message : String(err)}`)
    } catch {}
  }
}

/** Queues one file line behind the writes in flight, so no whole-file write drops another's line. */
function persist($: $, atMs: number, kind: string, text: string, sid?: string, quiet = false): Promise<void> {
  const job = fileQueue.then(() => writeFileLine($, atMs, kind, text, sid, quiet))
  fileQueue = job.catch(() => undefined)
  return job
}

/**
 * Appends one event-log line to band.events and band.jsonl; `onDisk` replaces kind and text in the file only.
 * BAND_EVENT_LOG=0 skips both. It never throws, because a throwing session.start hook would skip every
 * band session.start hook.
 */
async function logEvent($: $, kind: BandEventKind, text: string, onDisk?: { kind: string; text: string }): Promise<void> {
  try {
    if ((await $.env.get('BAND_EVENT_LOG')) === '0') return
    const atMs = await $.clock.now()
    await update($, events, l => pushEvent(l, { atMs, kind, text }))
    await persist($, atMs, onDisk?.kind ?? kind, onDisk?.text ?? text)
  } catch {}
}

/** BAND_COST=1 (true/yes/on) shows the session's cost; off, the figure is dropped before it reaches the atom. */
let costShown = false
const ON = new Set(['1', 'true', 'yes', 'on'])
const isOn = (v: string | undefined) => ON.has(v?.trim().toLowerCase() ?? '')
/** The session bills an API key or a cloud provider; read at session start. */
let billed = false

function withCost(u: BandUsage): BandUsage {
  return costShown ? u : { ...u, costUsd: null }
}

/** The model a switch moved away from: $.session.model() still answers it for a while after the event. */
let leftModel: string | null = null

/** The $.session.model() answer, or null when it is the model a switch just left: that is the lagging answer. */
async function sessionModel($: $): Promise<string | null> {
  let m: string | null = null
  try {
    m = await $.session.model()
  } catch {
    return null
  }
  if (!m || m === leftModel) return null
  leftModel = null
  return m
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

/** The host's last measured windows and the endpoint's last good ones: the usage atom's `rates` is their merge. */
let measured: BandRate[] = []
let endpoint: BandRate[] = []

/**
 * Writes the usage atom: `next` is a new measured reading, whose rates become the measured windows; absent,
 * only the endpoint's windows changed. An endpoint window past its `resetsAt` is dropped. Every write of the
 * atom's rates goes through here.
 */
async function writeUsage($: $, next?: BandUsage): Promise<void> {
  if (next) measured = next.rates
  const now = await $.clock.now()
  endpoint = endpoint.filter(r => r.resetsAt === null || !(Date.parse(r.resetsAt) <= now))
  const rates = mergeRates(measured, endpoint)
  await update($, usage, prev => (next ? keepCtx(prev, { ...next, rates }) : { ...prev, rates }))
  await adoptSubscriptionTtl($, rates)
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
/** The host's /usage caches its answer this long; band asks no more often, after a failure too. */
const ENDPOINT_MIN_MS = 5 * 60_000
/** A request unanswered this long fails as `timeout`, so a stalled one never blocks the next poll. */
const ENDPOINT_TIMEOUT_MS = 10_000
/** BAND_USAGE_ENDPOINT=0 turns the poll off; read at session start. */
let endpointOn = true
/** The last endpoint attempt, for /band-debug: `at` in clock ms, `error` one line; the body is never kept. */
let attempt: { at: number; ok: boolean; status?: number; error?: string } | null = null
let inFlight: Promise<void> | null = null

/**
 * Polls the usage endpoint at most once per ENDPOINT_MIN_MS, one request at a time; never throws. Callers do
 * not await it: the poll writes the atom itself.
 */
function maybeFetchLimits($: $): Promise<void> {
  if (!endpointOn) return Promise.resolve()
  inFlight ??= fetchLimits($).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function fetchLimits($: $): Promise<void> {
  let at: number
  try {
    at = await $.clock.now()
  } catch {
    return
  }
  if (attempt !== null && at - attempt.at < ENDPOINT_MIN_MS) return
  try {
    attempt = { at, ok: false }
    const auth = await $.session.authorize()
    // The endpoint takes the claude.ai login's token only; a session may log in later, so it asks again.
    // No such login means no subscription, not a failed request: the windows it gave go.
    if (auth?.kind !== 'bearer') {
      attempt = { at, ok: false, error: auth ? 'api-key session' : 'no claude.ai login' }
      if (!endpoint.length) return
      endpoint = []
      await writeUsage($).catch(() => undefined)
      return
    }
    let timer: Timer | undefined
    const res = await Promise.race([
      $.http.fetch(USAGE_URL, {
        headers: { 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
        auth: auth.handle,
      }),
      new Promise<never>((_, reject) => {
        timer = $.clock.after(ENDPOINT_TIMEOUT_MS, () => reject(new Error('timeout')))
      }),
    ]).finally(() => timer?.cancel())
    if (!res.ok) {
      attempt = { at, ok: false, status: res.status }
      return
    }
    const body: unknown = JSON.parse(res.text)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('body is not a JSON object')
    endpoint = toRates(endpointRates(body))
    attempt = { at, ok: true, status: res.status }
  } catch (err) {
    attempt = { at, ok: false, error: (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200) }
    return
  }
  await writeUsage($).catch(() => undefined)
}

/** The /band-debug endpoint line's value: the last attempt and the windows it holds. */
function endpointDebug() {
  return {
    ...(attempt ?? { at: null, ok: false }),
    ...(endpointOn ? {} : { error: 'BAND_USAGE_ENDPOINT=0' }),
    windows: endpoint.map(r => ({ kind: r.kind, pct: r.pct })),
  }
}

async function refresh($: $): Promise<void> {
  const now = await $.clock.now()
  await update($, tick, () => now)
  await writeUsage($, withCost(toUsage(...(await $.session.usage().then(r => [r.context, r.rateLimits, r.cost] as const)))))
  void maybeFetchLimits($)
}

/**
 * A non-empty API key or a cloud provider switch that is on (1, true, yes, on) bills per request and gets the
 * 5 min cache; without them the session runs on a claude.ai account, whose cache lives 1 h.
 */
async function isBilled($: $): Promise<boolean> {
  return (
    !!(await $.env.get('ANTHROPIC_API_KEY')) ||
    isOn(await $.env.get('CLAUDE_CODE_USE_BEDROCK')) ||
    isOn(await $.env.get('CLAUDE_CODE_USE_VERTEX')) ||
    isOn(await $.env.get('CLAUDE_CODE_USE_FOUNDRY'))
  )
}

/**
 * Rate-limit windows arrive only on a claude.ai subscription, whose prompt cache lives 1 h (5 min
 * under an API key or in overage). Live evidence beats the default and a remembered value alike.
 */
async function adoptSubscriptionTtl($: $, rates: readonly BandRate[]): Promise<void> {
  if (rates.length === 0) return
  await update($, cache, c =>
    c.ttlSource === 'default' || c.ttlSource === 'store' ? { ...c, ttlMs: HOUR_MS, ttlSource: 'subscription' } : c,
  )
}

/**
 * Adopts a TTL the session reported. Only a billed session's 1 h is remembered, for the next billed session:
 * a 5 min report is the host's fallback when it has seen no 1 h cache write yet (every session start on
 * 2.1.289), and remembered it would outlive the session that made it.
 */
async function learnTtl($: $, ttlMs: number, ttlSource: 'model-switch' | 'agent'): Promise<void> {
  await update($, cache, c => ({ ...c, ttlMs, ttlSource }))
  if (ttlMs === HOUR_MS && billed) await $.store.set(STORE_TTL, ttlMs)
}

/** Another plugin writes the snapshot: only a string or null id and branch are shown. */
function progressLine(p: unknown): { workId: string | null; branch: string | null } | null {
  if (p === null || typeof p !== 'object') return null
  const s = p as { workId?: unknown; branch?: unknown }
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  return { workId: str(s.workId), branch: str(s.branch) }
}

/**
 * Fills the atoms a fresh session starts without: the TTL (`seedsTtl` decides), the model and the first usage
 * reading. One throwing session.start hook skips every band session.start hook: each $ call fails alone.
 */
async function seed($: $, reloaded: boolean, forcedTtl: number | null): Promise<void> {
  if (seedsTtl(reloaded, forcedTtl, (await read($, cache).catch(() => CACHE_INIT)).ttlSource)) {
    let learned: number | null = null
    if (forcedTtl === null && billed) {
      try {
        const stored = await $.store.get(STORE_TTL)
        learned = typeof stored === 'number' && stored > 0 ? stored : null
      } catch {}
    }
    const ttlMs = forcedTtl ?? learned ?? (billed ? CACHE_INIT.ttlMs : HOUR_MS)
    const ttlSource = forcedTtl !== null ? 'option' : learned !== null ? 'store' : 'default'
    await update($, cache, c => ({ ...c, ttlMs, ttlSource })).catch(() => undefined)
  }
  const m = await sessionModel($)
  if (m !== null) await update($, model, () => m).catch(() => undefined)
  await refresh($).catch(() => undefined)
}

export function registerUsage(on: On, options: PluginOptions): void {
  const forcedTtl = ttlMsOf(options.cacheTtl)

  // A /config change reloads the module and session.start runs again in the same session: the tick, set by
  // the first one, tells a reload apart, so it logs no second start line and keeps a learned TTL.
  on('session.start', async ($, e, next) => {
    $.clock.every(TICK_MS, () => {
      void refresh($).catch(() => undefined)
    })
    const reloaded = (await read($, tick).catch(() => 0)) > 0
    billed = await isBilled($).catch(() => true)
    costShown = isOn(await $.env.get('BAND_COST').catch(() => undefined))
    endpointOn = (await $.env.get('BAND_USAGE_ENDPOINT').catch(() => undefined)) !== '0'
    await seed($, reloaded, forcedTtl)
    if (!reloaded) {
      const v = (await read($, info).catch(() => null))?.version ?? '?'
      await logEvent($, 'session', `start · band ${v}`, { kind: 'start', text: `band ${v}` })
    }
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
      `endpoint: ${JSON.stringify(endpointDebug())}`,
      `account: ${JSON.stringify({ atom: await read($, account), last: accountDebug() })}`,
      `progress: ${JSON.stringify(progressLine(await read($, baseProgress)))}`,
      `root: ${root}`,
      `render: ${JSON.stringify(lastRender)}`,
      `tick: ${await read($, tick)}`,
      `now: ${await $.clock.now()}`,
    ]
    return { text: lines.join('\n') }
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    await writeUsage($, withCost(toUsage(e.context, e.rateLimits, e.cost)))
    // The seed may read null: the first measure fills the gap. A switch whose PostModelSwitch never
    // reached the mod is caught here too.
    const m = await sessionModel($)
    if (m !== null) await adoptModel($, m)
    void maybeFetchLimits($)
    const hot = alarmRate((await read($, usage)).rates)
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

  // One short wall-clock bound covers the whole session.end chain, $ waits included: the atoms and the
  // pane line go first, the disk write only after the chain beneath has run and while time is left.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, cache, c => ({ ...c, anchorMs: null, isCold: false }))
      await update($, usage, u => ({ ...u, ctxPct: null, ctxTokens: null }))
      await update($, rateAlarmed, () => false)
    }
    // No session.start follows a /clear: this line marks where the conversation restarted.
    let clearedAt: number | null = null
    if (e.reason === 'clear') {
      try {
        if ((await $.env.get('BAND_EVENT_LOG')) !== '0') {
          const atMs = await $.clock.now()
          await update($, events, l => pushEvent(l, { atMs, kind: 'session', text: 'clear' }))
          clearedAt = atMs
        }
      } catch {}
    }
    const r = await next(e)
    // /clear starts a new session id with empty state and no session.start; the timer runs in the plugin's
    // environment and seeds the new session.
    if (e.reason === 'clear') {
      try {
        $.clock.after(CLEAR_RESEED_MS, () => {
          void seed($, false, forcedTtl).catch(() => undefined)
        })
      } catch {}
    }
    if (clearedAt !== null && next.budget.remainingMs >= END_FILE_MIN_MS) {
      await persist($, clearedAt, 'session', 'clear', e.sessionId, true).catch(() => undefined)
    }
    return r
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    // The event's own field: $.session.model() may still answer the model before the switch here, and
    // the measure the host sends right after the switch would write that stale answer over this one.
    if (e.from_model !== e.to_model) leftModel = e.from_model
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
