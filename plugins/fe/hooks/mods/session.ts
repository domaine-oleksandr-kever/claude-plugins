// fe's session: the start line, the base check and the project profile (decided once per session id) for the
// module's readers. The conventions reach the model through command hooks only (hooks/conventions.cjs).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { FeEvent, FeEventKind, FeProfile, FeProfileInfo } from '../../types'
import { logLine, pushEvent } from './events.ts'
import type { Disk } from './events.ts'

export const BASE_MISSING = 'needs the base plugin — claude plugin install base@domaine'
export const PROFILE_TIMEOUT_MS = 5_000

const events = atom({ plugin: 'fe', key: 'events' } as const, [] as FeEvent[])
const started = atom({ plugin: 'fe', key: 'started' } as const, null)
const profile = atom({ plugin: 'fe', key: 'profile' } as const, null)

type $ = EngineInterface

/** events.ts's file writer reaches `$` through this: the validator follows `$` only within one file. */
function diskOf($: $): Disk {
  return {
    session: () => $.session.id(),
    home: () => $.env.get('HOME'),
    override: () => $.env.get('DOMAINE_LOG_DIR'),
    manifest: () => $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    toast: text => $.ui.toast(text),
  }
}

async function logEvent($: $, kind: FeEventKind, text: string): Promise<void> {
  try {
    if ((await $.env.get('FE_EVENT_LOG')) === '0') return
    const ev: FeEvent = { atMs: await $.clock.now(), kind, text }
    await update($, events, l => pushEvent(l, ev))
    await logLine(diskOf($), ev)
  } catch {}
}

async function version($: $): Promise<string> {
  try {
    const v = (JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }).version
    return typeof v === 'string' && v ? v : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** base's skills carry `plugin: 'base'` in the command list from its manifest on; a list that fails says nothing. */
async function baseLoaded($: $): Promise<boolean> {
  try {
    return (await $.command.list()).some(c => c.plugin === 'base')
  } catch {
    return true
  }
}

export const isProfile = (w: string | undefined): w is FeProfile => w === 'foundation' || w === 'theme' || w === 'none'

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 120)

/** `theme (project-profile.sh)`, `foundation (FE_PROFILE)`, `none (fallback: <why>)`: the profile line's text. */
export function profileText(p: FeProfileInfo): string {
  return p.via === 'fallback' ? `none (fallback: ${p.why ?? 'unknown'})` : `${p.word} (${p.via})`
}

async function decide($: $, session: string): Promise<FeProfileInfo> {
  let root = ''
  let toml = false
  let env = false
  try {
    root = await $.session.root()
    toml = await $.fs.exists(`${root}/shopify.theme.toml`)
    env = await $.fs.exists(`${root}/.env`)
  } catch {}
  const info = (word: FeProfile, via: FeProfileInfo['via'], why: string | null): FeProfileInfo =>
    ({ session, word, via, why, toml, store: toml || (env && word !== 'none') })
  const forced = (await $.env.get('FE_PROFILE').catch(() => undefined))?.trim()
  if (isProfile(forced)) return info(forced, 'FE_PROFILE', null)
  let why: string
  try {
    const argv = ['bash', `${$.plugin.root}/scripts/project-profile.sh`]
    if (root) argv.push(root)
    const r = await $.process.run(argv, { timeoutMs: PROFILE_TIMEOUT_MS })
    const word = r.stdout.trim()
    if (r.exitCode === 0 && isProfile(word)) return info(word, 'project-profile.sh', null)
    why = `project-profile.sh exited ${r.exitCode}: ${oneLine(r.stderr.split('\n')[0] || word) || 'no answer'}`
  } catch (err) {
    why = `project-profile.sh did not run: ${oneLine(err instanceof Error ? err.message : String(err))}`
  }
  return info('none', 'fallback', why)
}

/** Decides this session's profile unless the atom already holds this id; stores and logs it once. */
async function storeProfile($: $): Promise<void> {
  const session = String(await $.session.id())
  if ((await read($, profile))?.session === session) return
  const p = await decide($, session)
  await update($, profile, () => p)
  await logEvent($, 'profile', profileText(p))
}

export function registerSession(on: On): void {
  // The engine allows one unmatched hook per event per plugin; this matcher takes every session.
  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    try {
      const sid = String(await $.session.id())
      if ((await read($, started)) !== sid) {
        await update($, started, () => sid)
        await logEvent($, 'start', `fe ${await version($)}`)
        if (!(await baseLoaded($))) {
          await logEvent($, 'install', BASE_MISSING)
          $.ui.toast(`fe: ${BASE_MISSING}`)
        }
      }
      // Unawaited: the probe never holds the start.
      void storeProfile($).catch(() => undefined)
    } catch {}
    return next(e)
  })
}
