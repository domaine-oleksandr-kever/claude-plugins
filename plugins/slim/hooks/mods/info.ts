// slim.info: the snapshot that tells another plugin (fnd's FND_COMPRESSION=proxy) that slim is loaded,
// which version, and which channels it compresses this session.
import type { EngineInterface, On } from 'claude-code'
import type { SlimChannel } from '../../types'

type $ = EngineInterface

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

export function registerInfo(on: On): void {
  on('session.start', async ($, e, next) => {
    // One throwing session.start hook skips every slim session.start hook (lookup's registration too).
    try {
      await $.state.set({ plugin: 'slim', key: 'info' }, { v: 1, version: await version($), channels: await channelsOn($) })
    } catch {}
    return next(e)
  })
}
