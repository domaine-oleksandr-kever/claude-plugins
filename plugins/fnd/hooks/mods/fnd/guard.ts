// Scratch-path guard as a mod: tool.describe note + tool.call deny by delegation to scratch-path-guard.cjs.
import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'
import { buildHookRun, omit, parseHookOut } from './node-hook.ts'

/** Same source as the plugin.json PreToolUse matcher of scratch-path-guard.cjs (layout-assertions pins it). */
export const GUARDED_RE =
  /^mcp__.*__(take_screenshot|browser_take_screenshot|take_snapshot|get_network_request|browser_run_code_unsafe)$/

// chrome-devtools' write tools (playwright's are browser_*): their server also accepts its OS temp dir.
const TMPDIR_OK_RE = /__(take_screenshot|take_snapshot|get_network_request)$/

// Constant on purpose: the describe answer is cached per session and any change spends the prompt cache.
const NOTE_HEAD =
  '\n\nfnd scratch-path guard: paths must resolve inside this project: `.claude/tasks/<work-id>/tmp/` ' +
  '(`.claude/tmp/<work-id>/` in a git worktree) or `.claude/tmp/`; use an absolute path. '
const NOTE = NOTE_HEAD + 'Paths outside the project are refused.'
const NOTE_TMPDIR = NOTE_HEAD + "Paths outside the project, other than this server's own OS temp dir, are refused."

export const DENY_FALLBACK = 'fnd scratch-path-guard: path outside the project'

/** The launch root, latched once: the MCP servers' roots were fixed where they launched. */
const guardRoot = atom({ plugin: 'fnd', key: 'guardRoot' } as const, null)

export function guardNote(tool: string): string {
  return TMPDIR_OK_RE.test(tool) ? NOTE_TMPDIR : NOTE
}

export function registerGuard(on: On): void {
  // The engine allows one unmatched hook per event per plugin; this matcher takes every session.
  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    const launch = await $.session.root()
    await update($, guardRoot, v => v ?? launch)
    return next(e)
  })

  // Unlike tool.call, no spawned guard re-checks the switch here, and the answer lasts the session.
  on('tool.describe', { tool: GUARDED_RE }, async ($, e, next) => {
    const settingsEnv = (await $.settings.read()).env as Record<string, unknown> | undefined
    if ((await $.env.get('FND_SCRATCH_GUARD')) === '0' || settingsEnv?.FND_SCRATCH_GUARD === '0') return next(e)
    const d = await next(e)
    return { ...d, description: d.description + guardNote(e.tool) }
  })

  on('tool.call', { tool: GUARDED_RE }, async ($, e, next) => {
    if ((await $.env.get('FND_SCRATCH_GUARD')) === '0') return next(e)
    let root = await read($, guardRoot)
    if (root === null) {
      // session.start's latch is skipped when any fnd session.start hook throws: the first call latches.
      const live = await $.session.root()
      root = (await update($, guardRoot, v => v ?? live)) ?? live
    }
    const { argv, init } = buildHookRun(
      $.plugin.root,
      'hooks/scratch-path-guard.cjs',
      ['--from-mod'],
      {
        hook_event_name: 'PreToolUse',
        tool_name: e.tool,
        tool_input: omit(e, ['tool', 'tool_use_id', 'agentId']),
        cwd: await $.session.cwd(),
      },
      { FND_HOST: 'claude', CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: $.plugin.root },
      10_000,
    )
    const out = await $.process.run(argv, init).then(parseHookOut, () => null)
    const hso = out?.hookSpecificOutput
    if (hso?.permissionDecision !== 'deny') return next(e)
    const reason = hso.permissionDecisionReason
    return { deny: typeof reason === 'string' && reason.trim() ? reason : DENY_FALLBACK }
  })
}
