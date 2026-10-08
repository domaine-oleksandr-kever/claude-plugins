// The prompt channel: a prompt the person typed or sent through the bridge, with a big paste in it,
// is rewritten in place before it enters the session — each data-shaped span (JSON, JSON lines, a log,
// an HTML page) becomes its compact text, or its head, plus a handle to the whole span on disk. The
// prose and the question stay as typed. Never blocks: anything that fails leaves the prompt as it was.
// A rewrite the session never took (interrupted, or dropped beneath) has its spills removed.
import { atom, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { SlimEvent } from '../../types'
import { eventText, pushEvent } from './events.ts'
import { buildPromptDropRun, buildPromptRun, parsePrompt, toastMs } from './node-hook.ts'
import type { Prompted } from './node-hook.ts'

const EVENTS = atom({ plugin: 'slim', key: 'events' } as const, [] as SlimEvent[])

/** The core's gate in UTF-8 bytes; one UTF-16 unit is at most 3 of them. */
export const PROMPT_MIN = 10240

/** A prompt the core could rewrite: possibly PROMPT_MIN bytes or more, and not a slash or `!` command. */
export function due(text: string): boolean {
  return text.length * 3 >= PROMPT_MIN && !/^\s*(?:\/[\w:.-]+(?:\s|$)|!)/.test(text)
}

async function dropSpills($: EngineInterface, root: string, rw: Prompted): Promise<void> {
  if (!rw.created.length) return
  try {
    const { argv, init } = buildPromptDropRun($.plugin.root, { v: 1, root, files: rw.created })
    await $.process.run(argv, init)
  } catch {}
}

export function registerPrompt(on: On): void {
  on('prompt.submit', { origin: { kind: ['composer', 'bridge'] } }, async ($, e, next) => {
    if (!due(e.text)) return next(e)
    const t0 = await $.clock.now().catch(() => 0)
    let rw: Prompted | null = null
    let root = ''
    try {
      if ((await $.env.get('SLIM_PROMPT')) !== '0') {
        root = await $.session.root()
        const payload = { v: 1, text: e.text, root, cwd: await $.session.cwd(), session_id: await $.session.id() }
        const { argv, init } = buildPromptRun($.plugin.root, payload)
        rw = parsePrompt(await $.process.run(argv, init))
      }
    } catch {
      rw = null
    }
    // Aborted: the dispatch went on without this hook, so a next(e) here would run the hooks beneath twice.
    if (next.signal.aborted) {
      if (rw) await dropSpills($, root, rw)
      return { drop: 'interrupted' }
    }
    if (!rw) return next(e)
    const r = await next({ ...e, text: rw.text })
    if (r.drop !== undefined) {
      await dropSpills($, root, rw)
      return r
    }
    // After next: a failing env read must not turn the accepted prompt into an error.
    try {
      const text = eventText('', 'prompt', rw.form === 'head' ? 'stubbed' : 'compressed', rw.engine, rw.bytesIn, rw.bytesOut) +
        (rw.spans > 1 ? ` · ${rw.spans} spans` : '')
      if ((await $.env.get('SLIM_TOAST')) !== '0') $.ui.toast(text, { timeoutMs: toastMs(await $.env.get('SLIM_TOAST_MS')) })
      if ((await $.env.get('SLIM_EVENT_LOG')) !== '0') {
        const atMs = await $.clock.now()
        const ev: SlimEvent = {
          v: 1, atMs, kind: 'slim', text, src: 'slim', tool: 'prompt', channel: 'prompt',
          bytesIn: rw.bytesIn, bytesOut: rw.bytesOut, engine: rw.engine, ms: Math.max(0, atMs - t0),
        }
        await update($, EVENTS, l => pushEvent(l, ev))
      }
    } catch {}
    return r
  })
}
