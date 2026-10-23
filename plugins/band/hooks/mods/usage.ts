// Status band writers: usage, model, cache and tick atoms plus the tick timer, the claude.ai usage endpoint
// poll, band's own event lines (session, model, compact, rate) with their file on disk, and /band-debug
// (account.ts writes the account atom).
// Nothing here draws; the band reads these atoms.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, Timer } from 'claude-code'
import type { BandEvent, BandEventKind, BandRate, BandUsage } from '../../types'
import { DEBUG_COMMAND, capLines, fileLine, fmtK, logDir, pushEvent, seedLines } from './events.ts'
import { CACHE_INIT, CLEAR_RESEED_MS, HOUR_MS, USAGE_INIT, alarmRate, compactedUsage, endpointRates, fillHalved, keepCtx, mergeRates, modelFamily, oneHourCacheTokens, rateCard, seedsTtl, toRates, toUsage, ttlMsOf } from './lib.ts'
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

/** The model a `/model` run moved away from: $.session.model() still answers it for a while after the run. */
let leftModel: string | null = null
/** A main-thread response has arrived: until then $.session.model() answers the process default, not the configured model. */
let bound = false

/** The $.session.model() answer, or null before a response binds the session or when it is the model a switch just left. */
async function sessionModel($: $): Promise<string | null> {
  if (!bound) return null
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

/** The settings' `model` (an alias such as `opus`, or an id) when it names one; `default`, absent or unreadable → null. */
async function settingsModel($: $): Promise<string | null> {
  const s = await $.settings.read().catch(() => null)
  const m = s?.model
  return typeof m === 'string' && m.trim() !== '' && m !== 'default' ? m : null
}

/** Writes the model atom and logs the change once; the same id again is a no-op. */
async function adoptModel($: $, m: string): Promise<void> {
  if ((await read($, model)) === m) return
  await update($, model, () => m)
  await logEvent($, 'model', m)
}

/** The settings model last seen, so only a change to it moves the atom. */
let lastSettingsModel: string | null = null

/** Adopts `m` when the atom holds nothing or another family (a `[1m]` dropped), so an id of the same family stays. */
async function adoptFamily($: $, m: string): Promise<void> {
  const current = await read($, model)
  if (current === null || modelFamily(current.replace(/\[1m\]$/, '')) !== modelFamily(m)) await adoptModel($, m)
}

/** Follows a pick in the `/model` dialog through the settings it saves: a changed settings model goes to `adoptFamily`. */
async function syncSettingsModel($: $): Promise<void> {
  const s = await settingsModel($)
  if (s === null || s === lastSettingsModel) return
  lastSettingsModel = s
  await adoptFamily($, s)
}

/** The family a `/model` answer names: ``Set model to `Opus 5.5` (1M context) and saved …`` → `opus` (the name bare or quoted); null for any other text. */
function answeredFamily(text: string | undefined): string | null {
  const hit = /^Set model to\s+[`'"]?([A-Za-z]+)/i.exec(text ?? '')
  return hit ? hit[1].toLowerCase() : null
}

/**
 * Applies a `/model` run: the family its answer names, else `picked` (the band picker's alias), else the settings it
 * saved. Caches are per model, so another family than the model before the run forfeits the warm one: `prev`
 * ($.session.model() before the run) once a response bound the session, else the model atom. A bound session keeps
 * answering `prev` for a while, which the next measure must not write back.
 */
export async function modelRan($: $, prev: string | null, text: string | undefined, picked?: string): Promise<void> {
  const answered = answeredFamily(text)
  // The settings may still answer the old model right after: the reading taken now counts as seen.
  if (answered !== null) lastSettingsModel = await settingsModel($)
  const family = answered ?? picked ?? null
  if (family === null) return syncSettingsModel($)
  const before = bound ? prev : await read($, model)
  if (before && modelFamily(before) !== modelFamily(family)) {
    if (bound) leftModel = before
    await update($, cache, c => ({ ...c, isCold: true }))
  }
  await adoptFamily($, family)
}

const SAME_COMPACTION_MS = 30_000
let lastCompactMs = 0
/** Set by every compaction, cleared by the next reading with a fill: until then no reading is read as another one. */
let awaitingFill = false

/**
 * Cold cache, the context from the engine's count (absent = no reading), one log line. The
 * session.compact chain and the readings both report one compaction, in either order: a report within
 * 30 s of the last is the same compaction, and then only a token count refines the context.
 */
async function applyCompaction($: $, trigger: string, tokensAfter?: number, tokensBefore?: number): Promise<void> {
  awaitingFill = true
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
  if (next) {
    measured = next.rates
    await inferCompaction($, next)
  }
  const now = await $.clock.now()
  endpoint = endpoint.filter(r => r.resetsAt === null || !(Date.parse(r.resetsAt) <= now))
  const rates = mergeRates(measured, endpoint)
  await update($, usage, prev => (next ? keepCtx(prev, { ...next, rates }) : { ...prev, rates }))
  await adoptSubscriptionTtl($, rates)
}

/**
 * A compaction read off a measured reading, for logins whose hooks never see the compact events (a Claude Team
 * login). The fill gone (the engine drops it until the next response) is applied as one; a fill below half of
 * the last one, that moment missed, is only logged, as the response that measured it wrote the cache again.
 */
async function inferCompaction($: $, next: BandUsage): Promise<void> {
  const prev = await read($, usage)
  if (next.ctxPct === null) {
    if (prev.ctxPct !== null && !awaitingFill) await applyCompaction($, 'inferred')
    return
  }
  const wasAwaiting = awaitingFill
  awaitingFill = false
  if (wasAwaiting || !fillHalved(prev, next)) return
  const now = await $.clock.now()
  if (now - lastCompactMs < SAME_COMPACTION_MS) return
  lastCompactMs = now
  const sizes = prev.ctxTokens !== null && next.ctxTokens !== null ? ` ${fmtK(prev.ctxTokens)} → ${fmtK(next.ctxTokens)}` : ''
  await logEvent($, 'compact', `inferred${sizes}`)
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
  await applyResume($, now)
  await writeUsage($, withCost(toUsage(...(await $.session.usage().then(r => [r.context, r.rateLimits, r.cost] as const)))))
  void maybeFetchLimits($)
  // A pick in the dialog a bare `/model` opens is saved after the command returns.
  await syncSettingsModel($).catch(() => undefined)
}

/** A band-resume.json older than this when first seen belongs to an earlier start of the session id. */
const RESUME_FRESH_MS = 60_000
/** The band-resume.json last seen, as `<session id>@<atMs>`: each file applies once. */
let resumeSeen: string | null = null

/**
 * Applies `<log dir>/<session id>/band-resume.json`, which hooks/resume.cjs writes on a resume or fork: one
 * `session <source>` line, and the cache anchored at the last response (`atMs` less the seconds since it), cold
 * when the host says the cache likely expired. An anchor older than one already recorded is ignored. Never throws.
 */
async function applyResume($: $, now: number): Promise<void> {
  try {
    const sid = String(await $.session.id())
    const dir = logDir(await $.env.get('HOME'), await $.env.get('DOMAINE_LOG_DIR'), sid)
    if (dir === null) return
    const r = JSON.parse(String(await $.fs.read(`${dir}/band-resume.json`))) as Record<string, unknown>
    if (typeof r.atMs !== 'number' || (r.source !== 'resume' && r.source !== 'fork')) return
    const key = `${sid}@${r.atMs}`
    if (key === resumeSeen) return
    resumeSeen = key
    if (now - r.atMs > RESUME_FRESH_MS) return
    await logEvent($, 'session', r.source)
    const secs = r.secondsSinceLastResponse
    if (typeof secs !== 'number') return
    const anchorMs = r.atMs - secs * 1000
    if (((await read($, cache)).anchorMs ?? -Infinity) >= anchorMs) return
    const isCold = r.promptCacheLikelyExpired === true
    await update($, cache, c => ({ ...c, anchorMs, isCold }))
  } catch {}
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

/** Adopts the 1 h TTL a subagent's cache writes showed; a billed session remembers it for the next billed one. */
async function learnHourTtl($: $): Promise<void> {
  await update($, cache, c => ({ ...c, ttlMs: HOUR_MS, ttlSource: 'agent' }))
  if (billed) await $.store.set(STORE_TTL, HOUR_MS)
}

/** Another plugin writes the snapshot: only a string or null id and branch are shown. */
function progressLine(p: unknown): { workId: string | null; branch: string | null } | null {
  if (p === null || typeof p !== 'object') return null
  const s = p as { workId?: unknown; branch?: unknown }
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  return { workId: str(s.workId), branch: str(s.branch) }
}

/**
 * Fills the atoms a fresh session starts without: the TTL (`seedsTtl` decides), the model (the session's once a
 * response bound it, else the settings' while the atom is empty) and the first usage reading. One throwing
 * session.start hook skips every band session.start hook: each $ call fails alone.
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
  let m = await sessionModel($)
  if (m === null) {
    m = lastSettingsModel = await settingsModel($)
    if ((await read($, model).catch(() => null)) !== null) m = null
  }
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
    bound = false
    lastSettingsModel = null
    if (!reloaded) {
      const v = (await read($, info).catch(() => null))?.version ?? '?'
      await logEvent($, 'session', `start · band ${v}`, { kind: 'start', text: `band ${v}` })
    }
    await seed($, reloaded, forcedTtl)
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
    // Once a response has bound the session, a switch no `/model` run reported is caught here.
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
      bound = true
      // A response names its model without the `[1m]` a pinned session id carries: that id stays.
      const answered = e.usage.model
      if (typeof answered === 'string' && answered && (await read($, model))?.replace(/\[1m\]$/, '') !== answered) await adoptModel($, answered)
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

  // A typed `/model <alias>` lands here on every login; the band picker's own run applies it in band.tsx.
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const prev = await $.session.model().catch(() => null)
    const r = await next(e)
    await modelRan($, prev, r.text).catch(() => undefined)
    return r
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const r = await next(e)
    if (forcedTtl === null && oneHourCacheTokens(r.result) > 0) await learnHourTtl($)
    return r
  })
}
