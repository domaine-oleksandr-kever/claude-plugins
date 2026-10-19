// base's conventions travel as command hooks (hooks/conventions.cjs, hooks/hooks.json) on every login. This
// mod is the cloud fallback only: in a session no surface draws and whose SessionStart command hook left no
// marker, the sections ride the first user message as a prompt.context block, text from conventions-text.json.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import { dogfoodMode, enabledNames, loginAccount, loginFile, versionsLine, versionsOf } from './dogfood/text.ts'
import { logDir, spareRoot } from './events.ts'

type $ = EngineInterface

/** The session id whose first user message carries the conventions as a context block (doctor.ts reads it). */
const injected = atom({ plugin: 'base', key: 'injected' } as const, null as string | null)
const slimInfo = atom({ plugin: 'slim', key: 'info' } as const, null)

/** Where the SessionStart command hook leaves its marker: `<log dir>/<session>/conventions.base.json`, else under the spare root. */
export const markerPaths = (home: string | undefined, override: string | undefined, tmp: string | undefined, sid: string): string[] =>
  [logDir(home, override, sid), logDir(undefined, spareRoot(tmp), sid)].flatMap(d => (d ? [`${d}/conventions.base.json`] : []))

async function pluginVersions($: $): Promise<string> {
  const home = (await $.env.get('HOME'))?.trim() ?? ''
  const cfgEnv = (await $.env.get('CLAUDE_CONFIG_DIR'))?.trim() ?? ''
  const config = cfgEnv.startsWith('/') ? cfgEnv.replace(/\/+$/, '') : home.startsWith('/') ? `${home.replace(/\/+$/, '')}/.claude` : null
  const installed = config ? await $.fs.read(`${config}/plugins/installed_plugins.json`).catch(() => null) : null
  let own = 'unknown'
  try {
    const v = (JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }).version
    if (typeof v === 'string' && v) own = v
  } catch {}
  const slim = (await read($, slimInfo).catch(() => null))?.version ?? null
  const enabled = enabledNames(await $.settings.read().catch(() => null))
  return versionsLine(versionsOf(installed, $.plugin.root, own, slim, enabled))
}

const dogfoodOn = async ($: $) => {
  const sw = (await $.env.get('BASE_DOGFOOD')) ?? ''
  if (sw === '1' || sw === '0') return sw === '1'
  const file = loginFile(await $.env.get('HOME'), await $.env.get('CLAUDE_CONFIG_DIR'))
  const account = (await $.env.get('CLAUDE_CODE_ACCOUNT_UUID'))?.trim() || loginAccount(file && (await $.fs.read(file).catch(() => null)))
  return dogfoodMode(sw, account, await $.fs.read(`${$.plugin.root}/dogfood.json`).catch(() => null))
}

/** The sections as one context block where nothing draws and no command hook delivered them; else null. */
export async function contextBlock($: $): Promise<string | null> {
  if ((await $.session.surfaces()).length > 0) return null
  for (const m of markerPaths(await $.env.get('HOME'), await $.env.get('DOMAINE_LOG_DIR'), await $.env.get('TMPDIR'), String(await $.session.id()))) {
    if (await $.fs.exists(m)) return null
  }
  const t = JSON.parse(await $.fs.read(`${$.plugin.root}/hooks/conventions-text.json`)) as Record<string, string>
  const names = ['root', 'comment-discipline', 'task-workspace', 'untrusted-content', 'shopify']
  if ((await $.env.get('BASE_LEAN')) !== '0') names.push('lean-code')
  if ((await $.env.get('BASE_STE')) !== '0') names.push('writing-style')
  const parts = names.map(n => (t[n] ?? '').split('<base root>').join($.plugin.root))
  if (await dogfoodOn($)) parts.push((t.dogfood ?? '').split('{versions}').join(await pluginVersions($)).split('{rule}').join(t['rule-surfaceless'] ?? ''))
  return parts.join('\n\n')
}

export function registerConventions(on: On): void {
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    const text = await contextBlock($).catch(() => null)
    if (!text) return r
    const sid = String(await $.session.id())
    await update($, injected, () => sid).catch(() => {})
    return { ...r, blocks: [...r.blocks, { name: 'baseConventions', text }] }
  })
}
