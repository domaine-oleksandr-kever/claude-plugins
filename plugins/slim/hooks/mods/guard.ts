// The spill-read guard: a model's Read of a whole spill (an original or a rows part over the inline
// budget) is denied with a pointer to a windowed Read, view or lookup, since a whale read back raw
// undoes the compression. Windowed Reads, id maps, Grep, Bash and every plugin's own calls (view's and
// lookup's probes among them) pass. Every spill read is recorded as an access line at debug level 1+,
// so --report pairs the recovery with the whale it followed; a denied one is marked and never paired.
// A model's first Read of a big image (a raw screenshot) is denied with a pointer to view, which resizes
// it; the next Read of that path passes, so a model whose view cannot resize the file still sees it.
import type { EngineInterface, On } from 'claude-code'
import { spillAccess, spillKind } from './channels.ts'
import { buildAccessRun, debugLevel, textKey } from './node-hook.ts'

/** A spill at or under this many bytes is read whole without a word: the read channel's own gate. */
export const SPILL_INLINE = 32768

/** view's byte cap for an image it leaves as is (scripts/engines/media.cjs MAX_BYTES): view's "Read <path>" must pass. */
export const IMAGE_READ_MAX = 153600

/** The image names view resizes (view.ts IMAGE_EXT). */
const IMAGE = /\.(?:png|jpe?g|gif|webp)$/i
/** Images slim's own replies name to Read: view's `.1568.jpg` copy (over the cap at its last step) and video frames, an MCP image's saved original. */
const OWN_IMAGE = /(?:\.1568\.jpe?g|\.frames\/\d+\.jpg|\/slim-mcp-[0-9a-f]{16}(?:-[0-9a-f]{8})?\.(?:png|jpg|gif|webp))$/i

type $ = EngineInterface

/** A raw SLIM_IMAGE_READ_MAX: `0` = off, a whole number floored at IMAGE_READ_MAX; anything else → IMAGE_READ_MAX. */
export function imageReadMax(raw: string | null | undefined): number {
  const v = String(raw ?? '').trim()
  if (!/^\d+$/.test(v)) return IMAGE_READ_MAX
  return Number(v) === 0 ? 0 : Math.max(Number(v), IMAGE_READ_MAX)
}

export function imageDenyText(path: string, size: number): string {
  return `slim: ${path} is a ${Math.round(size / 1024)} KB image — call mcp__slim__view({ path }) (resized) or pass a smaller screenshot (type jpeg, quality 60, clip to the element); if view cannot resize it, Read it again`
}

/** true the first time this session's model Reads the big image at `path`; marks it, so the next Read passes. */
async function firstImageDeny($: $, path: string): Promise<boolean> {
  try {
    const key = { plugin: 'slim', key: 'imageDenied', id: textKey(`${await $.session.id()}\n${path}`) } as const
    if ((await $.state.get(key)).value === true) return false
    await $.state.set(key, true)
    return true
  } catch {
    return false
  }
}

/** `lookup` = the lookup tool is registered (SLIM_LOOKUP is not 0). */
export function denyText(path: string, size: number, lookup: boolean): string {
  return `slim: ${path} is a ${size} B spill — Read it with offset/limit, or call mcp__slim__view({ path, jq }) to narrow it` +
    (lookup ? ', or mcp__slim__lookup({ path, question }) for one fact' : '')
}

async function record($: $, payload: Record<string, unknown>): Promise<void> {
  try {
    if (debugLevel(await $.env.get('SLIM_DEBUG')) < 1) return
    const { argv, init } = buildAccessRun($.plugin.root, { v: 1, ...payload, cwd: await $.session.cwd() })
    await $.process.run(argv, init)
  } catch {}
}

async function oversize($: $, path: string, max: number): Promise<number | null> {
  try {
    const st = await $.fs.stat(path)
    return st.kind === 'file' && st.size > max ? st.size : null
  } catch {
    return null
  }
}

export function registerGuard(on: On): void {
  on('tool.call', { tool: /^(?:Read|Bash|Grep)$/ }, async ($, e, next) => {
    if (next.origin.plugin !== 'engine') return next(e)
    const args = e as unknown as Record<string, unknown>
    if (e.tool === 'Read' && typeof args.file_path === 'string' && IMAGE.test(args.file_path) && !OWN_IMAGE.test(args.file_path)) {
      const max = imageReadMax(await $.env.get('SLIM_IMAGE_READ_MAX'))
      const size = max > 0 ? await oversize($, args.file_path, max) : null
      if (size !== null && (await firstImageDeny($, args.file_path))) return { deny: imageDenyText(args.file_path, size) }
    }
    const hit = spillAccess(String(e.tool), args)
    if (hit === null) return next(e)
    if (hit.tool === 'Read' && args.offset === undefined && args.limit === undefined && args.pages === undefined) {
      const kind = spillKind(hit.paths[0]!)
      if ((kind === 'original' || kind === 'rows') && (await $.env.get('SLIM_SPILL_GUARD')) !== '0') {
        const size = await oversize($, hit.paths[0]!, SPILL_INLINE)
        if (size !== null) {
          await record($, { tool: hit.tool, via: hit.via, spills: [hit.paths[0]!], denied: true })
          return { deny: denyText(hit.paths[0]!, size, (await $.env.get('SLIM_LOOKUP')) !== '0') }
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
