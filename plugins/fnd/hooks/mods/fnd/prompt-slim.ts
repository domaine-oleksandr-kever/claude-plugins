// Pasted JSON as a mod: prompt-json-guard.cjs --from-mod spills each big blob and replaces it in place instead of blocking the prompt.
import type { On } from 'claude-code'
import { buildHookRun, parseHookOut } from './node-hook.ts'

const PROMPT_MIN = 10240 // prompt-json-guard.cjs's gate in UTF-8 bytes (layout-assertions pins it); one UTF-16 unit is at most 3 of them
const RUN_MS = 20_000
const TOAST_MS = 10_000 // as slim.ts: the two figures stack when both fire
const CONTEXT_MAX = 100_000 // past this the engine gives the model a head and a path, not the line

type Rewrite = { text: string; context: string; summary: string }

export function registerPromptSlim(on: On): void {
  on('prompt.submit', { origin: { kind: ['composer', 'bridge', 'sdk'] } }, async ($, e, next) => {
    if (!due(e.text)) return next(e)
    let rw: Rewrite | null = null
    try {
      if ((await $.env.get('FND_PROMPT_JSON')) !== '0') {
        const { argv, init } = buildHookRun(
          $.plugin.root,
          'hooks/prompt-json-guard.cjs',
          ['--from-mod'],
          { prompt: e.text, cwd: await $.session.root() },
          { FND_HOST: 'claude', CLAUDE_PLUGIN_ROOT: $.plugin.root },
          RUN_MS,
        )
        rw = rewriteOf(await $.process.run(argv, init).then(parseHookOut, () => null))
      }
    } catch {
      rw = null
    }
    // Aborted: the dispatch already went on without this hook, so a next(e) here could run the hooks beneath twice.
    if (next.signal.aborted) return { drop: 'interrupted' }
    if (!rw) return next(e)
    const r = await next({ ...e, text: rw.text, context: [...(e.context ?? []), rw.context] })
    // After next: a failing env read must not turn the accepted prompt into an error.
    if (r.drop === undefined && (await $.env.get('FND_SLIM_TOAST').catch(() => undefined)) !== '0') {
      $.ui.toast(rw.summary, { timeoutMs: TOAST_MS })
    }
    return r
  })
}

/** A prompt the classic guard could block: possibly ≥ PROMPT_MIN bytes, a container opener, not a slash or `!` command. */
function due(text: string): boolean {
  return text.length * 3 >= PROMPT_MIN && /[{[]/.test(text) && !/^\s*(?:\/[\w:.-]+(?:\s|$)|!)/.test(text)
}

/** The script's rewrite when it is complete, else null. */
function rewriteOf(out: Record<string, unknown> | null): Rewrite | null {
  if (!out) return null
  const { text, context, summary } = out
  if (typeof text !== 'string' || typeof context !== 'string' || typeof summary !== 'string') return null
  if (!text || !context || !summary || context.length > CONTEXT_MAX) return null
  return { text, context, summary }
}
