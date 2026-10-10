// fe's session: the start line, the base check, the project profile (decided once per session id) and the
// conventions that follow it — system-prompt sections for the main session, added context for subagents.
// The profile lives here with both of its readers: the validator follows `$` only within one file.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PromptComposeSection } from 'claude-code'
import type { FeEvent, FeEventKind, FeProfile, FeProfileInfo } from '../../types'
import {
  FOUNDATION,
  NO_FE_AGENT,
  PROGRESS_SERIES,
  READ_ONLY_AGENT,
  STORE_ACCESS,
  WORKTREE,
  profileLine,
  rootLine,
  withRoot,
} from './conventions/text.ts'
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

// The decision in flight for one session id: compose, a subagent and the start never run the probe twice.
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

/**
 * The sections in session order, each `fe:<name>`: the profile is fixed per session id, so a render repeats
 * the last one byte for byte (the prompt cache).
 */
export async function sections($: $): Promise<PromptComposeSection[]> {
  const root = $.plugin.root
  const p = await profileOf($)
  const parts: [string, string][] = [
    ['root', rootLine(root)],
    ['profile', profileLine(p.word)],
  ]
  if (p.word === 'foundation') parts.push(['comment-discipline-foundation', FOUNDATION])
  if (p.store) parts.push(['store-access', withRoot(STORE_ACCESS, root)])
  if (p.toml) parts.push(['worktree', WORKTREE])
  if (p.toml || p.word !== 'none') parts.push(['progress-series', PROGRESS_SERIES])
  return parts.map(([name, text]) => ({ id: `fe:${name}`, text, scope: 'session' }))
}

/** null for base's readers and writer; the root, profile and Foundation rules for the rest; store access for a code writer. */
export async function subagentContext($: $, agentType: string): Promise<string | null> {
  if (NO_FE_AGENT.test(agentType)) return null
  const root = $.plugin.root
  const p = await profileOf($)
  const parts = [rootLine(root), profileLine(p.word)]
  if (p.word === 'foundation') parts.push(FOUNDATION)
  if (p.store && !READ_ONLY_AGENT.test(agentType)) parts.push(withRoot(STORE_ACCESS, root))
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
      // Unawaited: the probe never holds the start; the first compose waits on the same decision.
      void profileOf($).catch(() => undefined)
    } catch {}
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const ours = await sections($).catch(() => [])
    const taken = new Set(r.sections.map(s => s.id))
    return { sections: [...r.sections, ...ours.filter(s => !taken.has(s.id))] }
  })

  on('classic.SubagentStart', async ($, e, next) => {
    const r = await next(e)
    const ctx = await subagentContext($, e.agent_type ?? '').catch(() => null)
    return ctx ? { ...r, additionalContext: [...(r.additionalContext ?? []), ctx] } : r
  })
}
