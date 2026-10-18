// band.account writer: which claude.ai login the session runs on, read from the login record the host writes
// (`.claude.json` under CLAUDE_CONFIG_DIR, else HOME), else once per process from the OAuth profile endpoint, and
// the model families that record says the login cannot use. BAND_ACCOUNT=0 reads nothing; `work` / `personal`
// forces the label and still reads the record for those families. Nothing here draws; the band reads the atom.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Timer } from 'claude-code'
import type { BandAccount } from '../../types'
import { accountLabel, accountMode, creditGate, loginAccount, loginPaths, profileAccount } from './lib.ts'
import type { AccountFacts, AccountMode } from './lib.ts'

const account = atom({ plugin: 'band', key: 'account' } as const, null)

type $ = EngineInterface

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
/** How often the atom is checked: a /clear empties it, and where classic.SessionStart skips the plugin nothing else refills it. */
const CHECK_MS = 30_000
/** The login is read again this often: a /login may come later or switch the account mid-session. */
const RETRY_MS = 5 * 60_000
const PROFILE_TIMEOUT_MS = 10_000

let mode: AccountMode = 'on'
/** The profile endpoint's facts: undefined until asked, null while asking or when it gave nothing usable. */
let profile: AccountFacts | null | undefined
/** The profile request's state for /band-debug: `not asked`, `asking`, `ok` or why it gave nothing. */
let profileNote = 'not asked'
/** The value last written: when set, an empty atom means a /clear emptied it. */
let known: BandAccount | null = null
/** The last read, for /band-debug: `at` in clock ms, `error` one line. */
let attempt: { at: number; source: string; error?: string } | null = null
let inFlight: Promise<void> | null = null

/** The /band-debug account line's last-read part. */
export function accountDebug() {
  return { mode, ...(attempt ?? { at: null }) }
}

const oneLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200)

/** Asks the profile endpoint once per session, then reads again; never throws, and no read waits on it. */
async function askProfile($: $, handle: string): Promise<void> {
  profile = null
  profileNote = 'asking'
  let timer: Timer | undefined
  try {
    const res = await Promise.race([
      $.http.fetch(PROFILE_URL, {
        headers: { 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
        auth: handle,
      }),
      new Promise<never>((_, reject) => {
        timer = $.clock.after(PROFILE_TIMEOUT_MS, () => reject(new Error('timeout')))
      }),
    ]).finally(() => timer?.cancel())
    if (!res.ok) throw new Error(`status ${res.status}`)
    profile = profileAccount(JSON.parse(res.text))
    profileNote = profile === null ? 'no plan or email in the body' : 'ok'
  } catch (err) {
    profileNote = oneLine(err)
  }
  await inFlight
  if (profile !== null) await maybeRead($)
}

/** The login record, `none` (the atom without a login) carrying its credit gate, and why it names no login. */
async function readRecord($: $) {
  const where = loginPaths(await $.env.get('HOME'), await $.env.get('CLAUDE_CONFIG_DIR'))
  let record: unknown
  let why = 'no login record path'
  if (where.file !== null) {
    try {
      record = JSON.parse(await $.fs.read(where.file))
      why = 'no oauthAccount'
    } catch (err) {
      why = oneLine(err)
    }
  }
  const none = { plan: null, email: null, org: null, role: null, configDir: where.configDir, ...creditGate(record) }
  return { record, none, why }
}

/** The login as the record (else the profile endpoint) reports it; sets `attempt`. */
async function resolve($: $, at: number): Promise<BandAccount | null> {
  if (mode === 'off') {
    attempt = { at, source: 'none', error: 'BAND_ACCOUNT=0' }
    return null
  }
  if (mode !== 'on') {
    const { none } = await readRecord($)
    attempt = { at, source: 'BAND_ACCOUNT' }
    return { ...none, label: mode, source: 'BAND_ACCOUNT' }
  }
  const auth = await $.session.authorize()
  if (auth?.kind !== 'bearer') {
    attempt = { at, source: 'none', error: auth ? 'api-key session' : 'no claude.ai login' }
    return null
  }
  const { record, none, why } = await readRecord($)
  let facts: AccountFacts | null = loginAccount(record)
  let source: BandAccount['source'] = 'login record'
  if (facts === null) {
    if (profile === undefined) void askProfile($, auth.handle)
    facts = profile ?? null
    source = 'profile endpoint'
  }
  const label = facts === null ? null : accountLabel(facts.plan)
  if (facts === null || label === null) {
    attempt = { at, source: 'none', error: facts === null ? `${why}; profile: ${profileNote}` : 'no plan' }
    // No segment, but the record's gate still holds for the picker.
    return none.hiddenModels.length ? { ...none, label: null, source: null } : null
  }
  attempt = { at, source }
  return { ...none, ...facts, label, source }
}

/** Reads the login and writes the atom; never throws. */
async function readAccount($: $): Promise<void> {
  let next: BandAccount | null = null
  let at = 0
  try {
    at = await $.clock.now()
    next = await resolve($, at)
  } catch (err) {
    attempt = { at, source: 'none', error: oneLine(err) }
  }
  known = next
  await update($, account, () => next).catch(() => undefined)
}

function maybeRead($: $): Promise<void> {
  inFlight ??= readAccount($).finally(() => {
    inFlight = null
  })
  return inFlight
}

/** A new read once RETRY_MS has passed since the last, or at once when a /clear emptied a known account. */
async function recheck($: $): Promise<void> {
  if (mode === 'off' || inFlight !== null) return
  const emptied = known !== null && (await read($, account)) === null
  if (emptied || (await $.clock.now()) - (attempt?.at ?? 0) >= RETRY_MS) await maybeRead($)
}

export function registerAccount(on: On): void {
  // One throwing session.start hook skips every band session.start hook: the read never throws.
  on('session.start', { cwd: /$/ }, async ($, e, next) => {
    profile = undefined
    profileNote = 'not asked'
    try {
      mode = accountMode(await $.env.get('BAND_ACCOUNT'))
    } catch {}
    try {
      $.clock.every(CHECK_MS, () => {
        void recheck($).catch(() => undefined)
      })
    } catch {}
    await maybeRead($)
    return next(e)
  })

  // /clear goes on under a new session id whose state starts empty, and no session.start follows.
  on('classic.SessionStart', { source: /^clear$/ }, async ($, e, next) => {
    await maybeRead($)
    return next(e)
  })
}
