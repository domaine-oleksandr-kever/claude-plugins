// band.info: the snapshot that tells any plugin that band is loaded, which version, and whether its `disabled`
// option is on; band's own file lines and /band-debug read the version. Also registers band's slash commands,
// again after a /clear.
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { CHECKLIST_COMMAND, DEBUG_COMMAND, LOG_COMMAND } from './events.ts'

type $ = EngineInterface

async function version($: $): Promise<string> {
  try {
    const v = (JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }).version
    return typeof v === 'string' && v ? v : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function registerCommands($: $): Promise<void> {
  await $.command.register(LOG_COMMAND).catch(() => undefined)
  await $.command.register(CHECKLIST_COMMAND).catch(() => undefined)
  await $.command.register(DEBUG_COMMAND).catch(() => undefined)
}

export function registerInfo(on: On, options: PluginOptions): void {
  /** The session the commands were registered for: a /clear starts a new one with no session.start. */
  let registeredFor: string | null = null

  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    // One throwing session.start hook skips every band session.start hook: each $ call fails alone.
    try {
      await $.state.set({ plugin: 'band', key: 'info' }, { v: 1, version: await version($), disabled: options.disabled === true })
    } catch {}
    try {
      registeredFor = String(await $.session.id())
    } catch {}
    await registerCommands($)
    return next(e)
  })

  // band's one matcherless prompt.submit: a module holds at most one.
  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    let sid: string | null = null
    try {
      sid = String(await $.session.id())
    } catch {}
    if (sid !== null && sid !== registeredFor) {
      await registerCommands($)
      registeredFor = sid
    }
    return r
  })
}
