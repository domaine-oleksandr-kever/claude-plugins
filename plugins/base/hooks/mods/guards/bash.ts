// The two Bash guards in one tool.call hook: no AI attribution in a commit message (pure, in this
// module) and no git-hooks bypass (delegated to hooks/no-verify-bypass.sh, whose heuristics
// tests/no-verify-bypass-matrix.sh pins row by row). Each deny writes one `guard` event.
import { atom, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { BaseEvent } from '../../../types'
import { logLine, pushEvent } from '../events.ts'
import type { Disk } from '../events.ts'
import { buildHookRun } from '../node-hook.ts'
import { ATTRIBUTION_DENY, carriesAttribution } from './attribution.ts'

/** Every block of the script sits behind one of these words; a command naming none never spawns it. */
const GIT_WORD = /git|commit|push|merge|pull|\sam/
export const NO_VERIFY_FALLBACK =
  'Domaine convention (references/commit-message-format.md): git hooks are quality gates — never bypass them.'

const events = atom({ plugin: 'base', key: 'events' } as const, [] as BaseEvent[])

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

async function logGuard($: $, text: string): Promise<void> {
  try {
    if ((await $.env.get('BASE_EVENT_LOG')) === '0') return
    const ev: BaseEvent = { atMs: await $.clock.now(), kind: 'guard', text }
    await update($, events, l => pushEvent(l, ev))
    await logLine(diskOf($), ev)
  } catch {}
}

/** The script's deny reason (exit 2, its stderr), else null; a spawn that fails or times out lets the call run. */
async function noVerifyDeny($: $, command: string): Promise<string | null> {
  if (!GIT_WORD.test(command)) return null
  const { argv, init } = buildHookRun(
    'bash',
    $.plugin.root,
    'hooks/no-verify-bypass.sh',
    { tool_name: 'Bash', tool_input: { command } },
    {},
    10_000,
  )
  const run = await $.process.run(argv, init).catch(() => null)
  if (run?.exitCode !== 2) return null
  return run.stderr.trim() || NO_VERIFY_FALLBACK
}

export function registerBashGuards(on: On): void {
  // A matcher apart from the workspace's `{ tool: 'Bash' }` hook.
  on('tool.call', { tool: /^Bash$/ }, async ($, e, next) => {
    if (e.tool !== 'Bash' || (await $.env.get('BASE_GUARD')) === '0') return next(e)
    if (carriesAttribution(e.command)) {
      await logGuard($, 'Bash: a commit message with AI attribution')
      return { deny: ATTRIBUTION_DENY }
    }
    const deny = await noVerifyDeny($, e.command)
    if (deny === null) return next(e)
    await logGuard($, 'Bash: a git hooks bypass')
    return { deny }
  })
}
