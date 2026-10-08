// The spill-read guard: a model's Read of a whole spill (an original or a rows part over the inline
// budget) is denied with a pointer to a windowed Read, view or lookup, since a whale read back raw
// undoes the compression. Windowed Reads, id maps, Grep, Bash and every plugin's own calls (view's and
// lookup's probes among them) pass. Every spill read is recorded as an access line at debug level 1+,
// so --report pairs the recovery with the whale it followed; a denied one is marked and never paired.
import type { EngineInterface, On } from 'claude-code'
import { spillAccess, spillKind } from './channels.ts'
import { buildAccessRun, debugLevel } from './node-hook.ts'

/** A spill at or under this many bytes is read whole without a word: the read channel's own gate. */
export const SPILL_INLINE = 32768

type $ = EngineInterface

export function denyText(path: string, size: number): string {
  return `slim: ${path} is a ${size} B spill — Read it with offset/limit, or call mcp__slim__view({ path, jq }) to narrow it, ` +
    'or mcp__slim__lookup({ path, question }) for one fact'
}

async function record($: $, payload: Record<string, unknown>): Promise<void> {
  try {
    if (debugLevel(await $.env.get('SLIM_DEBUG')) < 1) return
    const { argv, init } = buildAccessRun($.plugin.root, { v: 1, ...payload, cwd: await $.session.cwd() })
    await $.process.run(argv, init)
  } catch {}
}

async function oversize($: $, path: string): Promise<number | null> {
  try {
    const st = await $.fs.stat(path)
    return st.kind === 'file' && st.size > SPILL_INLINE ? st.size : null
  } catch {
    return null
  }
}

export function registerGuard(on: On): void {
  on('tool.call', { tool: /^(?:Read|Bash|Grep)$/ }, async ($, e, next) => {
    if (next.origin.plugin !== 'engine') return next(e)
    const args = e as unknown as Record<string, unknown>
    const hit = spillAccess(String(e.tool), args)
    if (hit === null) return next(e)
    if (hit.tool === 'Read' && args.offset === undefined && args.limit === undefined && args.pages === undefined) {
      const kind = spillKind(hit.paths[0]!)
      if ((kind === 'original' || kind === 'rows') && (await $.env.get('SLIM_SPILL_GUARD')) !== '0') {
        const size = await oversize($, hit.paths[0]!)
        if (size !== null) {
          await record($, { tool: hit.tool, via: hit.via, spills: [hit.paths[0]!], denied: true })
          return { deny: denyText(hit.paths[0]!, size) }
        }
      }
    }
    // Never race next: returning while it is pending aborts the tool beneath.
    const r = await next(e)
    if (r.deny !== undefined || r.isError === true) return r
    await record($, { tool: hit.tool, via: hit.via, spills: hit.paths })
    return r
  })
}
