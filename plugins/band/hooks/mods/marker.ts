// Session marker: tells fnd's classic UserPromptSubmit hook (plugins/fnd/hooks/mod-session.cjs) that a band is
// drawn, so its context monitor goes silent — the band shows ctx and model. The file name is that hook's, so it
// keeps fnd's prefix. Rewritten on every prompt, because the classic side trusts only a fresh mtime: a resumed
// session whose module no longer loads must not inherit a stale file. With `disabled` on nothing is written, so
// the monitor speaks again. Never deleted ($.fs cannot remove); old empty markers stay in tmpdir.
import type { EngineInterface, On, PluginOptions } from 'claude-code'

type $ = EngineInterface

const MARK_MS = 500 // a stalled fs.write must not hold the prompt

export function registerMarker(on: On, options: PluginOptions): void {
  let broken: string | null = null // a session whose tmpdir failed once is not retried on every prompt
  // Matches every prompt: a module holds one matcherless prompt.submit hook, and info.ts has it.
  on('prompt.submit', { text: /^/ }, async ($, e, next) => {
    if (options.disabled === true) return next(e)
    const sid = await sessionId($).catch(() => '')
    if (sid && sid !== broken) {
      const ok = await Promise.race([
        mark($, sid).then(() => true),
        $.clock.sleep(MARK_MS, { signal: next.signal }).then(() => false),
      ]).catch(() => false)
      if (!ok) broken = sid
    }
    return next(e)
  })
}

async function sessionId($: $): Promise<string> {
  return String(await $.session.id()).replace(/[^A-Za-z0-9_.-]/g, '')
}

/** Writes the empty `<tmpdir>/fnd-mod-session-<sid>`. */
async function mark($: $, sid: string): Promise<void> {
  await $.fs.write(`${await tmpdir($)}/fnd-mod-session-${sid}`, '')
}

/** Node's os.tmpdir() on POSIX (TMPDIR, TMP, TEMP, else /tmp) without trailing slashes: '/' gives '', so the joined path matches path.join. */
async function tmpdir($: $): Promise<string> {
  const dir = (await $.env.get('TMPDIR')) || (await $.env.get('TMP')) || (await $.env.get('TEMP')) || '/tmp'
  return dir.replace(/\/+$/, '')
}
