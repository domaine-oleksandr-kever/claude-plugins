// fe's session: the start line, the base check and the project profile (decided once per session id). The
// conventions travel as command hooks (hooks/conventions.cjs); this mod is the cloud fallback only: in a session
// no surface draws and whose SessionStart hook left no marker, they ride the first user message as a block.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { FeEvent, FeEventKind, FeProfile, FeProfileInfo } from '../../types'
import { logDir, spareRoot, logLine, pushEvent } from './events.ts'
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

// The decision in flight for one session id: the start and the fallback never run the probe twice.
let pending: { session: string; info: Promise<FeProfileInfo> } | null = null

/** This session's profile: the atom when it holds this id, else decided now, stored and logged once. */
async function profileOf($: $): Promise<FeProfileInfo> {
  const session = String(await $.session.id())
  const held = await read($, profile)
  if (held?.session === session) return held
  if (pending?.session !== session) {
    const info = decide($, session).then(async p => {
      await update($, profile, () => p)
      await logEvent($, 'profile', profileText(p))
      return p
    })
    pending = { session, info: info.catch(() => ({ session, word: 'none', via: 'fallback', why: 'not stored', toml: false, store: false }) as FeProfileInfo) }
  }
  return pending.info
}

/** Where the SessionStart command hook leaves its marker: `<log dir>/<session>/conventions.fe.json`, else under the spare root. */
export const markerPaths = (home: string | undefined, override: string | undefined, tmp: string | undefined, sid: string): string[] =>
  [logDir(home, override, sid), logDir(undefined, spareRoot(tmp), sid)].flatMap(d => (d ? [`${d}/conventions.fe.json`] : []))

/**
 * True when FE_PREVIEW_DEFAULT is 0: a set env value wins, else the first `FE_PREVIEW_DEFAULT=` line of
 * `${XDG_CONFIG_HOME:-$HOME/.config}/domaine/env` — the rule of hooks/conventions.cjs previewDefault.
 */
async function previewOff($: $): Promise<boolean> {
  let v = await $.env.get('FE_PREVIEW_DEFAULT')
  if (v === undefined) {
    const abs = (x: string | undefined) => ((x ?? '').trim().startsWith('/') ? (x ?? '').trim().replace(/\/+$/, '') : '')
    const home = abs(await $.env.get('HOME'))
    const xdg = abs(await $.env.get('XDG_CONFIG_HOME')) || (home && `${home}/.config`)
    if (xdg) {
      const text = await $.fs.read(`${xdg}/domaine/env`).catch(() => null)
      const line = text?.split('\n').find(l => /^\s*FE_PREVIEW_DEFAULT\s*=/.test(l))
      if (line !== undefined) v = line.replace(/^[^=]*=/, '')
    }
  }
  return (v ?? '').trim() === '0'
}

/** The sections as one context block where nothing draws and no command hook delivered them; else null. */
export async function contextBlock($: $): Promise<string | null> {
  if ((await $.session.surfaces()).length > 0) return null
  for (const m of markerPaths(await $.env.get('HOME'), await $.env.get('DOMAINE_LOG_DIR'), await $.env.get('TMPDIR'), String(await $.session.id()))) {
    if (await $.fs.exists(m)) return null
  }
  const t = JSON.parse(await $.fs.read(`${$.plugin.root}/hooks/conventions-text.json`)) as Record<string, string>
  const root = $.plugin.root
  const p = await profileOf($)
  const parts = [(t.root ?? '').split('<root>').join(root), (t.profile ?? '').split('<profile>').join(p.word)]
  if (p.word === 'foundation') parts.push(t['comment-discipline-foundation'] ?? '')
  if (p.store) parts.push((t['store-access'] ?? '').split('<fe root>').join(root))
  if (p.toml) parts.push(t.worktree ?? '')
  if (p.toml) parts.push((t[(await previewOff($)) ? 'preview-default-off' : 'preview-default-on'] ?? '').split('<fe root>').join(root))
  if (p.toml || p.word !== 'none') parts.push(t['progress-series'] ?? '')
  return parts.join('\n\n')
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
      // Unawaited: the probe never holds the start; the fallback waits on the same decision.
      void profileOf($).catch(() => undefined)
    } catch {}
    return next(e)
  })

  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    const text = await contextBlock($).catch(() => null)
    return text ? { ...r, blocks: [...r.blocks, { name: 'feConventions', text }] } : r
  })
}
