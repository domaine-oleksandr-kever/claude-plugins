// Pure: which channel a tool's result belongs to, what slim reads of it, and whether it is worth a
// core run. The tool name picks the channel; the decision to compress is the core's, by content.
import type { SlimChannel } from '../../types'
import { PLAIN_MIN, utf8Bytes } from './node-hook.ts'

/** Bytes over which a channel's result is a candidate; 0 = SLIM_PLAIN_BYTES. scripts/delivery/channels.cjs holds the same table. */
export const GATES = { mcp: 4096, bash: 4096, read: 32768, webfetch: 16384, websearch: 0, grep: 16384, agent: 0, attachment: 32768 } as const
/** A Bash command that reads a log is a candidate from here on, plain or not. */
export const LOG_GATE = 16384
/** A fetching command word at the start of a pipeline segment; `cat src/http/page.html` is not one. */
export const FETCH_CMD = /(?:^|[;&|(`]|\$\()\s*(?:curl|wget|https?|xh|lynx)(?=\s|$)/
export const LOG_CMD = /\.log\b|\.jsonl\b|\b(?:journalctl|logs?)\b/
/** Theme and package JSON a person edits: never compressed, whatever its size. */
export const SOURCE_JSON = /(?:^|\/)(?:config|templates|locales|sections|blocks|snippets|layout)\/[^/]+\.json$/i
const SOURCE_JSON_NAME = /^(?:package(?:-lock)?|tsconfig[\w.-]*|composer|jsconfig|\.?[\w-]*rc)\.json$|\.schema\.json$/i
const STRUCTURED = /^﻿?\s*(?:\{\s*["}[]|\[|<(?:!doctype|html|head|body)\b)/i
const MARKUP = /^﻿?\s*<(?:!doctype|html|head|body)\b/i
const LOG_EXT = new Set(['.log', '.jsonl', '.ndjson'])

/** The tool-result channels but MCP, which keeps its own pre-spawn rules. */
export type Intake = Exclude<SlimChannel, 'mcp' | 'attachment' | 'prompt'>
export type Pre = 'error-shape' | 'already-slim' | 'size-gate' | 'not-text' | 'windowed-read' | 'spill-read' | 'read-guard'

/** What the mod reads of one result: sizes and the facts the gates need, never the content's meaning. */
export type View = {
  /** UTF-8 bytes of the text slim would read (stdout, a file's content, a listing joined by newlines). */
  bytes: number
  texts: string[]
  persisted?: true
  notText?: true
  isError?: true
  command?: string
  path?: string
  windowed?: true
  truncated?: true
}

/** 'lookup' and 'view' are slim's own tools: their answers are already compact and never go through intake. */
export function channelOf(tool: string): Intake | 'mcp' | 'lookup' | 'view' | null {
  if (tool === 'mcp__slim__lookup') return 'lookup'
  if (tool === 'mcp__slim__view') return 'view'
  if (tool.startsWith('mcp__')) return 'mcp'
  switch (tool) {
    case 'Bash': return 'bash'
    case 'Read': return 'read'
    case 'WebFetch': return 'webfetch'
    case 'WebSearch': return 'websearch'
    case 'Grep': return 'grep'
    case 'Agent':
    case 'Task': return 'agent'
    default: return null
  }
}

export function isSourceJson(path: string): boolean {
  return SOURCE_JSON.test(path) || SOURCE_JSON_NAME.test(baseName(path))
}

/** JSON or a page at the start of the text: worth the core below the plain-text threshold. */
export function structured(t: string): boolean {
  return STRUCTURED.test(t.slice(0, 4096))
}

function markup(t: string): boolean {
  return MARKUP.test(t.slice(0, 4096))
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function ext(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function viewOfTexts(texts: string[], extra: Omit<View, 'bytes' | 'texts'> = {}): View {
  let bytes = 0
  for (const t of texts) bytes += utf8Bytes(t)
  return { bytes, texts, ...extra }
}

/**
 * The view of one result, or null when the record is not the shape the channel knows (a newer build,
 * another plugin's answer): such a result is left alone.
 */
export function viewOf(ch: Intake, r: { result?: unknown; text?: string; isError?: true }, e: Rec): View | null {
  if (r.isError === true) {
    const t = str(r.text) ?? str(r.result) ?? ''
    return viewOfTexts([t], { isError: true })
  }
  const rec = r.result
  if (!isRec(rec)) return null
  switch (ch) {
    case 'bash': {
      const stdout = str(rec.stdout)
      if (stdout === undefined) return null
      const notText = rec.isImage === true || (Array.isArray(rec.structuredContent) && rec.structuredContent.length > 0) || str(rec.backgroundTaskId) !== undefined
      return viewOfTexts([stdout], {
        command: str(e.command) ?? '',
        ...(str(rec.persistedOutputPath) ? { persisted: true as const } : {}),
        ...(notText ? { notText: true as const } : {}),
      })
    }
    case 'read': {
      const file = isRec(rec.file) ? rec.file : {}
      const path = str(e.file_path) ?? str(file.filePath) ?? ''
      if (rec.type !== 'text') return { bytes: 0, texts: [], path, notText: true }
      const content = str(file.content)
      if (content === undefined) return null
      return viewOfTexts([content], {
        path,
        ...(e.offset !== undefined || e.limit !== undefined || e.pages !== undefined ? { windowed: true as const } : {}),
        ...(file.truncatedByTokenCap === true ? { truncated: true as const } : {}),
      })
    }
    case 'webfetch': {
      const result = str(rec.result)
      return result === undefined ? null : viewOfTexts([result])
    }
    case 'websearch': {
      if (!Array.isArray(rec.results)) return null
      return viewOfTexts(rec.results.filter((x): x is string => typeof x === 'string'))
    }
    case 'grep': {
      const content = str(rec.content)
      return content === undefined ? null : viewOfTexts([content])
    }
    case 'agent': {
      if (rec.status !== 'completed') return { bytes: 0, texts: [], notText: true }
      if (!Array.isArray(rec.content)) return null
      const texts: string[] = []
      for (const b of rec.content) if (isRec(b) && b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
      return viewOfTexts(texts)
    }
  }
}

/** Below this no line is written and no switch is read: the result is no slim invocation (an Edit is not either). */
export function floor(ch: Intake, v: View): boolean {
  if (v.isError) return v.bytes > (GATES[ch] || PLAIN_MIN)
  switch (ch) {
    case 'bash': return v.persisted === true || v.bytes > GATES.bash
    case 'read': return v.truncated === true || v.bytes > GATES.read
    case 'websearch':
    case 'agent': return v.bytes > PLAIN_MIN
    default: return v.bytes > GATES[ch]
  }
}

/** A Read slim may replace: a whole data file the host did not show whole, never a file a person edits. */
function readEligible(v: View): boolean {
  const path = v.path ?? ''
  const x = ext(path)
  if (LOG_EXT.has(x)) return v.truncated === true || v.bytes > GATES.read
  return x === '.json' && v.truncated === true && !isSourceJson(path)
}

/** The passthrough the mod can tell alone; the core is spawned for it only to write the line. */
export function guardOf(ch: Intake, v: View): Pre | null {
  if (v.isError) return 'error-shape'
  if (v.notText) return 'not-text'
  if (ch !== 'read') return null
  if (v.windowed) return 'windowed-read'
  // How the model follows a handle: a Read of a spill always passes through.
  const kind = spillKind(v.path ?? '')
  if (kind !== null && kind !== 'host') return 'spill-read'
  return readEligible(v) ? null : 'read-guard'
}

function sizeOk(ch: Intake, v: View, plain: number): boolean {
  const head = v.texts[0] ?? ''
  switch (ch) {
    case 'bash': {
      const cmd = v.command ?? ''
      if (v.persisted) return true
      if (v.bytes > GATES.bash && structured(head) && (!markup(head) || FETCH_CMD.test(cmd))) return true
      if (v.bytes > LOG_GATE && LOG_CMD.test(cmd)) return true
      return v.bytes > plain
    }
    case 'read': return true
    case 'webfetch': return (v.bytes > GATES.webfetch && structured(head)) || v.bytes > plain
    case 'grep': return v.bytes > GATES.grep
    case 'websearch':
    case 'agent': return v.bytes > plain
  }
}

/** True when the result goes to the core for a decision; `plain` is SLIM_PLAIN_BYTES as plainBytes() reads it. */
export function candidate(ch: Intake, v: View, plain: number): boolean {
  return floor(ch, v) && guardOf(ch, v) === null && sizeOk(ch, v, plain)
}

const DATA_EXT = new Set(['.json', '.jsonl', '.ndjson', '.log', '.txt'])

/** The file the host's framing of an @-mentioned file names (`Called the Read tool with the following input: {…}`), or null. */
export function attachmentPath(text: string): string | null {
  const m = /^Called the Read tool with the following input: (\{.*\})$/m.exec(text.slice(0, 8192))
  if (!m) return null
  try {
    const v = JSON.parse(m[1]!) as { file_path?: unknown }
    return typeof v.file_path === 'string' ? v.file_path : null
  } catch {
    return null
  }
}

/**
 * Whether an @-mentioned file may be a data file worth the core: numbered lines, and, when the framing
 * names the file, a data extension and no source JSON. Without a name the core decides by content.
 */
export function attachmentEligible(text: string, path: string | null): boolean {
  if (attachmentShape(text) !== 'numbered') return false
  return path === null || (DATA_EXT.has(ext(path)) && !isSourceJson(path))
}

/** How an @-mentioned file reached the model: as the Read mapper's numbered lines, or raw. */
export function attachmentShape(text: string): 'numbered' | 'raw' {
  let n = 0
  for (const line of text.slice(0, 4096).split('\n')) if (/^\s*\d+(?:\t|→)/.test(line) && ++n >= 3) return 'numbered'
  return 'raw'
}

/** A spill slim writes, by name: in the spill root (the `fnd-` prefixes are a wire format other plugins match), `slim-prompt-*` in the prompt channel's dir. */
const SPILL_NAME = /^fnd-(mcp-slim|crush|jsx-ids)-[0-9a-f]{16}(?:-[0-9a-f]{8})?\.(?:json|txt)$/
const PROMPT_SPILL = /\/\.claude\/slim\/prompt\/slim-prompt-(?:(rows|ids)-)?[0-9a-f]{16}(?:-[0-9a-f]{8})?\.(?:json|txt)$/
const HOST_FILE = /\/tool-results\/[^/]+$/

export type SpillKind = 'original' | 'rows' | 'ids' | 'host'

/** What a path is to slim: a whole original, a rows part, an id map, a host tool-results file, or null. */
export function spillKind(path: string): SpillKind | null {
  const s = SPILL_NAME.exec(baseName(path))
  if (s) return s[1] === 'mcp-slim' ? 'original' : s[1] === 'crush' ? 'rows' : 'ids'
  const p = PROMPT_SPILL.exec(path)
  if (p) return p[1] === 'rows' ? 'rows' : p[1] === 'ids' ? 'ids' : 'original'
  return HOST_FILE.test(path) ? 'host' : null
}

/** The words of a shell command that look like paths, as delivery/channels.cjs splits them. */
export function commandWords(cmd: string): string[] {
  return cmd.split(/[\s'"|;&<>()=]+/).filter(Boolean)
}

/** Which reader a Bash command is, by the command words it carries: a word that only names a file is `named`. */
export function bashVia(cmd: string): string {
  const w = new Set(commandWords(cmd).map(baseName))
  const any = (...names: string[]) => names.some(n => w.has(n))
  if (any('jq')) return 'jq'
  if (any('grep', 'rg', 'egrep')) return 'grep'
  if (any('sed', 'awk', 'head', 'tail', 'cat', 'wc', 'less')) return 'shell'
  if (any('node')) return 'node'
  if (any('rm', 'mv', 'cp', 'ln', 'touch', 'ls', 'echo', 'stat')) return 'named'
  return 'other'
}

export const ACCESS_MAX = 8

export type SpillAccess = { tool: 'Read' | 'Bash' | 'Grep'; via: string; paths: string[] }

/** The spill files a Read, Bash or Grep call names (absolute paths, at most ACCESS_MAX), or null when none. */
export function spillAccess(tool: string, e: Record<string, unknown>): SpillAccess | null {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  let paths: string[]
  let via: string
  if (tool === 'Read') { paths = [str(e.file_path)]; via = 'Read' }
  else if (tool === 'Grep') { paths = [str(e.path)]; via = 'Grep' }
  else if (tool === 'Bash') { const c = str(e.command); paths = commandWords(c); via = bashVia(c) }
  else return null
  const hit = [...new Set(paths.filter(p => p.startsWith('/') && spillKind(p) !== null))].slice(0, ACCESS_MAX)
  return hit.length ? { tool, via, paths: hit } : null
}
