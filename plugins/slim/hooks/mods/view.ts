// mcp__slim__view: a big local file or a command's output shown compactly, by the same engines the
// channels use, without the whole source entering the context. A path is ruled on by a one-line Read
// through the host, a command runs through Bash, and `out` is written through the host's Write tool,
// so permission rules and every guard decide on each. An image or a video is resized by the core's
// media backend beside the input, where the Read and Write checks allow or the person says yes.
import { atom, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { SlimEvent } from '../../types'
import { agentPrefix, pushEvent, viewText } from './events.ts'
import { buildRecordRun, buildViewRun, parseView, utf8Bytes } from './node-hook.ts'
import type { Viewed } from './node-hook.ts'

const EVENTS = atom({ plugin: 'slim', key: 'events' } as const, [] as SlimEvent[])

export const VIEW_TOOL = 'mcp__slim__view'
export const VIEW_ENGINES = ['json', 'jsonl', 'log', 'html', 'figma', 'figma-nodes', 'adf', 'text', 'media'] as const
export const VIEW_DESC =
  'Show a big local file (path) or a shell command\'s output (command) compactly: slim picks the engine by content ' +
  '(JSON, JSON lines, logs, HTML, Figma REST nodes.json, Atlassian documents, plain-text windows) and returns a figure ' +
  'line and the compact text, whole up to 16 KB, else its head and a file to Read windowed. jq narrows JSON first ' +
  "(dot paths .a.b, .a[0], '[]' iteration, ',' multi-select, '| keys' / '| length'). out writes the compact text to a " +
  'file under <project>/.claude/tasks/<id>/, reused while it is newer than the input. An image becomes a copy at most ' +
  '1568 px on its long edge and a video a folder of frames, beside the input. Give exactly one of path or command; ' +
  'for a URL use WebFetch or mcp__slim__lookup.'
export const VIEW_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    command: { type: 'string' },
    jq: { type: 'string' },
    out: { type: 'string' },
    engine: { type: 'string', enum: [...VIEW_ENGINES] },
  },
}
export const BAD_ARGS = 'view: give exactly one of path or command'
export const NO_URL = 'view: there is no url mode — for a page use WebFetch(url, prompt), or mcp__slim__lookup({ url, question }) for one fact'
export const INLINE = 16384
const HEAD_LINES = 40

type $ = EngineInterface
type Outcome = Viewed & { rung: 'path' | 'command' }

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'])
const OUT_EXT = new Set(['png', 'jpg', 'jpeg', 'gif'])

function nameParts(path: string): { dir: string; stem: string; ext: string } {
  const slash = path.lastIndexOf('/')
  const dir = slash === -1 ? '.' : slash === 0 ? '/' : path.slice(0, slash)
  const base = path.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? { dir, stem: base.slice(0, dot), ext: base.slice(dot + 1).toLowerCase() } : { dir, stem: base, ext: '' }
}

/** True when the name says image or video; the core still decides by the bytes. */
export function mediaName(path: string): boolean {
  const { ext } = nameParts(path)
  return IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext)
}

/**
 * The first file the media backend would write for `path`, from the name alone (the core refuses
 * when its byte sniff disagrees): `<dir>/<stem>.1568.<ext>` for an image (png, jpg, jpeg, gif kept,
 * anything else png), `<dir>/<stem>.frames/001.jpg` for a video. `path` is absolute.
 */
export function mediaProbe(path: string): string {
  const { dir, stem, ext } = nameParts(path)
  const at = dir === '/' ? '' : dir
  if (VIDEO_EXT.has(ext)) return `${at}/${stem}.frames/001.jpg`
  return `${at}/${stem}.1568.${OUT_EXT.has(ext) ? ext : 'png'}`
}

/** At most `maxLines` lines and `maxBytes` bytes from the top of `text`; a longer line is cut. */
export function headOf(text: string, maxLines: number, maxBytes: number): string {
  const out: string[] = []
  let n = 0
  for (const line of text.split('\n')) {
    if (out.length === maxLines) break
    const room = maxBytes - n
    if (room <= 0) break
    const b = utf8Bytes(line) + 1
    if (b <= room) {
      out.push(line)
      n += b
      continue
    }
    let cut = ''
    let k = 0
    for (const c of Array.from(line)) {
      const cb = utf8Bytes(c)
      if (k + cb > room - 4) break
      cut += c
      k += cb
    }
    out.push(`${cut}…`)
    break
  }
  return out.join('\n')
}

/** The tool's text: the figure, the out line, then the compact text whole or its head and where to read on. */
export function replyText(v: Viewed): string {
  if (v.decision === 'refused') return v.text
  const lines = [v.figure]
  if (v.out) lines.push(`out: ${v.out} (${v.lines ?? 0} lines)`)
  if (v.original) lines.push(`original: ${v.original}`)
  if (v.engine === 'media') return [...lines, v.text].join('\n')
  lines.push('--- head ---')
  if (utf8Bytes(v.text) <= INLINE) return [...lines, v.text].join('\n')
  const total = v.text.split('\n').length
  lines.push(headOf(v.text, HEAD_LINES, INLINE - 1024))
  lines.push(`… ${total} lines in all — read ${v.pointer ?? v.out ?? 'the source'} windowed (offset/limit)`)
  return lines.join('\n')
}

/** The subagent's type as $.agent.list() names it; undefined when unlisted or the list throws. */
async function agentType($: $, agentId: string): Promise<string | undefined> {
  try {
    return (await $.agent.list()).find(a => a.id === agentId)?.type || undefined
  } catch {
    return undefined
  }
}

const refused = (rung: 'path' | 'command', reason: string, text: string): Outcome =>
  ({ rung, decision: 'refused', reason, engine: null, figure: text.split('\n')[0] ?? text, text, bytesIn: 0, bytesOut: 0, stages: [] })

const errText = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 120)

/** The core's reply, or a refusal naming why it could not be had. */
async function core($: $, rung: 'path' | 'command', payload: Record<string, unknown>): Promise<Outcome> {
  try {
    const full = { v: 1, ...payload, root: await $.session.root(), cwd: await $.session.cwd(), session_id: await $.session.id() }
    const { argv, init } = buildViewRun($.plugin.root, full)
    const p = parseView(await $.process.run(argv, init))
    return p.ok ? { ...p.out, rung } : refused(rung, p.reason, `view failed: core ${p.reason}`)
  } catch {
    return refused(rung, 'spawn-failed', 'view failed: the core could not be started')
  }
}

const check = async ($: $, tool: 'Read' | 'Write', file_path: string) => {
  try {
    return await $.tool.check({ tool, input: { file_path } })
  } catch (err) {
    return { decision: 'deny' as const, reason: `view: the ${tool} check failed (${errText(err)})` }
  }
}

/**
 * A one-line Read of `path` through the host, so the permission rules (and their dialog) and every
 * PreToolUse guard rule on it: the path the Read opened, or why it did not. A Read check that denies
 * is answered without the call. An image's Read comes back as an image, with no path: `path` stands.
 */
async function readProbe($: $, path: string): Promise<{ opened: string } | { denied: string }> {
  const c = await check($, 'Read', path)
  if (c.decision === 'deny') return { denied: c.reason || `view: reading ${path} is denied` }
  try {
    const probe = await $.tool.call({ tool: 'Read', file_path: path, limit: 1 } as never)
    if (probe.deny !== undefined) return { denied: probe.deny }
    if (probe.isError === true) return { denied: String(probe.text || `view: reading ${path} failed`) }
    const r = probe.result as { type?: unknown; file?: { filePath?: unknown } } | undefined
    if (typeof r?.file?.filePath === 'string' && r.file.filePath) return { opened: r.file.filePath }
    return r?.type === 'image' ? { opened: path } : { denied: `view: Read returned no file for ${path}` }
  } catch (err) {
    return { denied: `view: Read failed (${errText(err)})` }
  }
}

/** Yes from the person in the host's own question dialog; a dismissal or a run with no one to ask is no. */
async function confirmed($: $, question: string): Promise<boolean> {
  try {
    return (await $.ui.ask(question, ['Yes', 'No'])) === 'Yes'
  } catch {
    return false
  }
}

/**
 * An image or a video: the Read tool cannot open a video, and the backend writes beside the input
 * outside the Write tool, so the permission checks rule on both and an `ask` from either becomes one
 * Yes/No question; an image still takes the one-line Read, so its guards rule too.
 */
async function viewMedia($: $, path: string, a: Record<string, string>): Promise<Outcome> {
  const abs = path.startsWith('/') ? path : `${(await $.session.cwd()).replace(/\/+$/, '')}/${path}`
  const { ext } = nameParts(path)
  let askRead = false
  if (IMAGE_EXT.has(ext)) {
    const p = await readProbe($, path)
    if ('denied' in p) return refused('path', 'read-denied', p.denied)
  } else {
    const r = await check($, 'Read', path)
    if (r.decision === 'deny') return refused('path', 'read-denied', r.reason || `view: reading ${path} is denied`)
    askRead = r.decision === 'ask'
  }
  const probe = mediaProbe(abs)
  const w = await check($, 'Write', probe)
  if (w.decision === 'deny') return refused('path', 'write-denied', `view: writing ${probe} is denied${w.reason ? ` (${w.reason})` : ''}`)
  if (askRead || w.decision === 'ask') {
    const what = VIDEO_EXT.has(ext) ? `frames into ${probe.slice(0, probe.lastIndexOf('/'))}/` : `a resized copy ${probe}`
    if (!(await confirmed($, `Let slim read ${abs} and write ${what}?`))) {
      return refused('path', 'not-confirmed', `view: not confirmed — reading ${abs} and writing ${what} needs a yes`)
    }
  }
  return core($, 'path', { path, ...a, media: true, allowed_out: probe })
}

async function viewPath($: $, path: string, a: Record<string, string>): Promise<Outcome> {
  if (a.engine === 'media' || mediaName(path)) return viewMedia($, path, a)
  const p = await readProbe($, path)
  if ('denied' in p) return refused('path', 'read-denied', p.denied)
  return core($, 'path', { path: p.opened, ...a })
}

async function viewCommand($: $, command: string, a: Record<string, string>): Promise<Outcome> {
  let b
  try {
    b = await $.tool.call({ tool: 'Bash', command } as never)
  } catch (err) {
    return refused('command', 'bash-failed', `view: Bash failed (${errText(err)})`)
  }
  if (b.deny !== undefined) return refused('command', 'command-denied', b.deny)
  const rec = (b.result ?? {}) as { stdout?: unknown; persistedOutputPath?: unknown }
  const source = b.isError === true
    ? { text: String(b.text ?? '') }
    : typeof rec.persistedOutputPath === 'string'
      ? { host_path: rec.persistedOutputPath }
      : { text: typeof rec.stdout === 'string' ? rec.stdout : String(b.text ?? '') }
  return core($, 'command', { ...source, command, ...a })
}

/** Puts the core's `write` through the host's Write tool; an existing file is Read first, as Write requires. */
async function writeOut($: $, o: Outcome): Promise<Outcome> {
  const w = o.write
  if (!w) return o
  const fail = (reason: string, text: string): Outcome => ({ ...refused(o.rung, reason, text), engine: o.engine, bytesIn: o.bytesIn })
  try {
    if (w.exists) {
      const r = await $.tool.call({ tool: 'Read', file_path: w.path, limit: 1 } as never)
      if (r.deny !== undefined) return fail('write-denied', r.deny)
    }
    const res = await $.tool.call({ tool: 'Write', file_path: w.path, content: `${w.marker}\n${o.text}` } as never)
    if (res.deny !== undefined) return fail('write-denied', res.deny)
    if (res.isError === true) return fail('write-failed', String(res.text || `view: writing ${w.path} failed`))
  } catch (err) {
    return fail('write-failed', `view: Write failed (${errText(err)})`)
  }
  return o
}

export function registerView(on: On): void {
  on('tool.call', { tool: VIEW_TOOL }, async ($, e) => {
    const args = e as unknown as Record<string, unknown>
    const str = (k: string) => (typeof args[k] === 'string' && (args[k] as string).trim() !== '' ? (args[k] as string).trim() : undefined)
    if (args.url !== undefined) return { result: NO_URL }
    const path = str('path')
    const command = str('command')
    if ((path === undefined) === (command === undefined)) return { result: BAD_ARGS }
    const engine = str('engine')
    if (engine !== undefined && !(VIEW_ENGINES as readonly string[]).includes(engine)) {
      return { result: `view: unknown engine '${engine.slice(0, 32)}' — one of ${VIEW_ENGINES.join(', ')}` }
    }
    const a: Record<string, string> = {}
    for (const k of ['jq', 'out'] as const) { const v = str(k); if (v !== undefined) a[k] = v }
    if (engine !== undefined) a.engine = engine
    const t0 = await $.clock.now()

    let o = path !== undefined ? await viewPath($, path, a) : await viewCommand($, command!, a)
    o = await writeOut($, o)
    const text = replyText(o)
    const ms = Math.max(0, (await $.clock.now()) - t0)

    if ((await $.env.get('SLIM_EVENT_LOG')) !== '0') {
      try {
        const isSub = e.agentId !== undefined
        const listed = isSub ? await agentType($, e.agentId!) : undefined
        const shown = path !== undefined ? path.slice(path.lastIndexOf('/') + 1) : command!
        const ev: SlimEvent = {
          v: 1, atMs: await $.clock.now(), kind: 'view', channel: 'view', src: 'slim', tool: VIEW_TOOL,
          text: viewText(agentPrefix(listed, isSub), shown, o.decision, o.engine, o.bytesIn, o.bytesOut, o.reason),
          ...(isSub ? { agentType: listed ?? 'agent' } : {}),
          ms, decision: o.decision, engine: o.engine, bytesIn: o.bytesIn, bytesOut: o.bytesOut,
        }
        await update($, EVENTS, l => pushEvent(l, ev))
      } catch {}
    }
    try {
      const rec = {
        channel: 'view', tool_use_id: e.tool_use_id, decision: o.decision, reason: o.reason ?? null, rung: o.rung,
        engine: o.engine, bytes_in: o.bytesIn, bytes_out: o.bytesOut, stages: o.stages,
        spill: o.out ?? o.pointer ?? o.original ?? null, ...(o.narrowed ? { narrowed: true } : {}),
        ...(o.frames ? { frames: o.frames } : {}), ms, cwd: await $.session.cwd(),
      }
      const { argv, init } = buildRecordRun($.plugin.root, rec)
      await $.process.run(argv, init)
    } catch {}
    return { result: text }
  })
}
