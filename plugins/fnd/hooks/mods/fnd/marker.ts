// Session marker: tells the classic UserPromptSubmit hook (mod-session.cjs) that this module is live, so its
// context monitor goes silent — the band shows ctx and model. Rewritten on every prompt, because the classic
// side trusts only a fresh mtime: a resumed session whose module no longer loads must not inherit a stale file.
// Never deleted ($.fs cannot remove); old empty markers stay in tmpdir.
import type { EngineInterface, On } from 'claude-code'

type $ = EngineInterface

const MARK_MS = 500 // a stalled fs.write must not hold the prompt

export function registerMarker(on: On): void {
  let broken: string | null = null // a session whose tmpdir failed once is not retried on every prompt
  // Matches every prompt: a module holds one matcherless prompt.submit hook, and progress has it.
  on('prompt.submit', { text: /^/ }, async ($, e, next) => {
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
