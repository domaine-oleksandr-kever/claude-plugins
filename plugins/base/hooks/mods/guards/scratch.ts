// The scratch-path guard: a tool.describe note and a tool.call deny delegated to hooks/scratch-path-guard.cjs,
// which keeps the os.tmpdir() and realpath logic a mod cannot do. Each deny writes one `guard` event.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { BaseEvent } from '../../../types'
import { bare, pushEvent, toolName } from '../events.ts'
import { buildHookRun, omit, parseHookOut } from '../node-hook.ts'

/** Server-agnostic: a per-user `claude mcp add` of the same servers is guarded too. */
export const GUARDED_RE =
  /^mcp__.*__(take_screenshot|browser_take_screenshot|take_snapshot|get_network_request|browser_run_code_unsafe)$/

// chrome-devtools' write tools (playwright's are browser_*): their server also accepts its OS temp dir.
const TMPDIR_OK_RE = /__(take_screenshot|take_snapshot|get_network_request)$/

// Constant on purpose: the describe answer is cached per session and any change spends the prompt cache.
const NOTE_HEAD =
  '\n\nbase scratch-path guard: paths must resolve inside this project: `.claude/tasks/<work-id>/tmp/` ' +
  '(`.claude/tmp/<work-id>/` in a git worktree) or `.claude/tmp/`; use an absolute path. '
const NOTE = NOTE_HEAD + 'Paths outside the project are refused.'
const NOTE_TMPDIR = NOTE_HEAD + "Paths outside the project, other than this server's own OS temp dir, are refused."

export const DENY_FALLBACK = 'base scratch-path guard: path outside the project'

/** The launch root, latched once: the MCP servers' roots were fixed where they launched. */
const guardRoot = atom({ plugin: 'base', key: 'guardRoot' } as const, null)
const events = atom({ plugin: 'base', key: 'events' } as const, [] as BaseEvent[])

type $ = EngineInterface

async function logGuard($: $, text: string): Promise<void> {
  try {
    if ((await $.env.get('BASE_EVENT_LOG')) === '0') return
    const atMs = await $.clock.now()
    await update($, events, l => pushEvent(l, { atMs, kind: 'guard', text }))
  } catch {}
}

export function guardNote(tool: string): string {
  return TMPDIR_OK_RE.test(tool) ? NOTE_TMPDIR : NOTE
}

/** BASE_GUARD or BASE_SCRATCH_GUARD is 0 in the process env. */
async function off($: $): Promise<boolean> {
  return (await $.env.get('BASE_GUARD')) === '0' || (await $.env.get('BASE_SCRATCH_GUARD')) === '0'
}

export function registerScratchGuard(on: On): void {
  // A matcher apart from base's other session.start hooks: one unmatched hook per event per plugin.
  on('session.start', { cwd: /./ }, async ($, e, next) => {
    try {
      const launch = await $.session.root()
      await update($, guardRoot, v => v ?? launch)
    } catch {}
    return next(e)
  })

  // The describe answer lasts the session, and no spawned script re-checks the switch here: the settings env counts too.
  on('tool.describe', { tool: GUARDED_RE }, async ($, e, next) => {
    const settingsEnv = (await $.settings.read()).env as Record<string, unknown> | undefined
    if ((await off($)) || settingsEnv?.BASE_GUARD === '0' || settingsEnv?.BASE_SCRATCH_GUARD === '0') return next(e)
    const d = await next(e)
    return { ...d, description: d.description + guardNote(e.tool) }
  })

  on('tool.call', { tool: GUARDED_RE }, async ($, e, next) => {
    if (await off($)) return next(e)
    let root = await read($, guardRoot)
    if (root === null) {
      // A throwing session.start hook of base skips this latch: the first call latches.
      const live = await $.session.root()
      root = (await update($, guardRoot, v => v ?? live)) ?? live
    }
    const { argv, init } = buildHookRun(
      'node',
      $.plugin.root,
      'hooks/scratch-path-guard.cjs',
      {
        hook_event_name: 'PreToolUse',
        tool_name: e.tool,
        tool_input: omit(e, ['tool', 'tool_use_id', 'agentId']),
        cwd: await $.session.cwd(),
      },
      { CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: $.plugin.root },
      10_000,
    )
    const out = await $.process.run(argv, init).then(parseHookOut, () => null)
    const hso = out?.hookSpecificOutput
    if (hso?.permissionDecision !== 'deny') return next(e)
    const raw = hso.permissionDecisionReason
    const reason = typeof raw === 'string' && raw.trim() ? raw : DENY_FALLBACK
    await logGuard($, `${toolName(e.tool)}: ${bare(reason.split('\n')[0] ?? '')}`)
    return { deny: reason }
  })
}
