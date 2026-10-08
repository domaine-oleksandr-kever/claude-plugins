// slim.info: the snapshot that tells another plugin that slim is loaded, which version, and which
// channels it compresses this session; then slim's start line, the first it publishes in a session.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { SlimChannel, SlimEvent } from '../../types'
import { pushEvent } from './events.ts'

type $ = EngineInterface

const EVENTS = atom({ plugin: 'slim', key: 'events' } as const, [] as SlimEvent[])
const STARTED = atom({ plugin: 'slim', key: 'started' } as const, null as string | null)

/** The channels whose switch is not 0, each switch read by its literal name. */
async function channelsOn($: $): Promise<SlimChannel[]> {
  const off = async (name: Promise<string | undefined>) => (await name) === '0'
  const out: SlimChannel[] = []
  if (!(await off($.env.get('SLIM_MCP')))) out.push('mcp')
  if (!(await off($.env.get('SLIM_BASH')))) out.push('bash')
  if (!(await off($.env.get('SLIM_READ')))) out.push('read')
  const web = !(await off($.env.get('SLIM_WEB')))
  if (web) out.push('webfetch', 'websearch')
  const grep = !(await off($.env.get('SLIM_GREP')))
  if (grep) out.push('grep', 'glob')
  if (!(await off($.env.get('SLIM_AGENT')))) out.push('agent')
  if (!(await off($.env.get('SLIM_ATTACH')))) out.push('attachment')
  if (!(await off($.env.get('SLIM_PROMPT')))) out.push('prompt')
  return out
}

async function version($: $): Promise<string> {
  try {
    const v = (JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }).version
    return typeof v === 'string' && v ? v : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** `slim <version>`, once per session id: a repeated session.start writes none. */
async function startLine($: $, v: string): Promise<void> {
  if ((await $.env.get('SLIM_EVENT_LOG')) === '0') return
  const session = await $.session.id()
  if ((await read($, STARTED)) === session) return
  await update($, STARTED, () => session)
  const ev: SlimEvent = { v: 1, atMs: await $.clock.now(), kind: 'start', text: `slim ${v}`, src: 'slim' }
  await update($, EVENTS, l => pushEvent(l, ev))
}

export function registerInfo(on: On): void {
  on('session.start', async ($, e, next) => {
    // One throwing session.start hook skips every slim session.start hook (lookup's registration too).
    try {
      const v = await version($)
      await $.state.set({ plugin: 'slim', key: 'info' }, { v: 1, version: v, channels: await channelsOn($) })
      await startLine($, v)
    } catch {}
    return next(e)
  })
}
