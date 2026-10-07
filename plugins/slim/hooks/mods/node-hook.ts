// Pure adapter between the hooks and scripts/slim.cjs: builds the `$.process.run` calls, reads the
// core's answers, and recognises the host's overflow notice and an already-slimmed result.
// The `$.process.run` call itself stays in the file that hooks the event.
import type { ProcessRunInit, ProcessRunResult } from 'claude-code'
import type { SlimEngine } from '../../types'

export const ENGINES: readonly SlimEngine[] = ['json', 'jsonl', 'log', 'html', 'figma', 'adf', 'text', 'stub']

export type Run = { argv: string[]; init: ProcessRunInit }

/** `node <root>/scripts/slim.cjs`, the envelope as JSON on stdin. */
export function buildRun(root: string, envelope: unknown, timeoutMs = 120_000): Run {
  return {
    argv: ['node', `${root.replace(/\/+$/, '')}/scripts/slim.cjs`],
    init: { stdin: JSON.stringify(envelope), env: {}, timeoutMs },
  }
}

/** `node <root>/scripts/slim.cjs --error`: the core appends one error line for a failure the mod saw. */
export function buildErrorRun(root: string, payload: unknown): Run {
  const run = buildRun(root, payload, 10_000)
  return { argv: [...run.argv, '--error'], init: run.init }
}

/** `node <root>/scripts/slim.cjs --distill`: lookup's document, read and compressed, no file written. */
export function buildDistillRun(root: string, payload: unknown): Run {
  const run = buildRun(root, payload, 30_000)
  return { argv: [...run.argv, '--distill'], init: run.init }
}

/** `node <root>/scripts/slim.cjs --record`: the core writes lookup's report line at every debug level. */
export function buildRecordRun(root: string, rec: unknown): Run {
  const run = buildRun(root, rec, 10_000)
  return { argv: [...run.argv, '--record'], init: run.init }
}

export type SlimRecord = Record<string, unknown> & {
  engine: SlimEngine | null
  bytes_in: number
  bytes_out: number
  /** What the host would have shown in place of the text slim read (a persisted output's preview). */
  bytes_seen?: number
  ms: number
}
export type SlimOut = {
  decision: string
  reason?: string | null
  result?: unknown
  figure?: string
  record: SlimRecord
}
export type Parsed = { ok: true; out: SlimOut } | { ok: false; reason: string; message: string }

/** The core's answer, or why it cannot be used: the reason becomes the error line's name. */
export function parseOut(run: ProcessRunResult): Parsed {
  if (run.exitCode !== 0) {
    return { ok: false, reason: `exit-${run.exitCode}`, message: (run.stderr.split('\n')[0] ?? '').slice(0, 200) }
  }
  if (run.isStdoutTruncated) return { ok: false, reason: 'stdout-truncated', message: 'stdout over 4 MiB' }
  const bad = (message: string): Parsed => ({ ok: false, reason: 'bad-output', message })
  const text = run.stdout.trim()
  if (!text) return bad('empty stdout')
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return bad('stdout is not JSON')
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return bad('stdout is not an object')
  const out = v as SlimOut
  if (typeof out.decision !== 'string') return bad('no decision')
  if (out.decision === 'compressed' || out.decision === 'stubbed') {
    const rec = out.record as Partial<SlimRecord> | undefined
    if (!('result' in out)) return bad('no result')
    if (!rec || typeof rec !== 'object') return bad('no record')
    if (typeof rec.bytes_in !== 'number' || typeof rec.bytes_out !== 'number' || typeof rec.ms !== 'number') return bad('record figures missing')
    if (!ENGINES.includes(rec.engine as SlimEngine)) return bad(`unknown engine ${String(rec.engine)}`.slice(0, 200))
  }
  return { ok: true, out }
}

/** The bytes a row and an event count as saved from: the host's own view when the core measured one. */
export function bytesSeen(rec: SlimRecord): number {
  return typeof rec.bytes_seen === 'number' && Number.isFinite(rec.bytes_seen) ? rec.bytes_seen : rec.bytes_in
}

export type Distilled = { decision: string; engine: string | null; reason?: string; text: string; bytesIn: number; bytesOut: number }

/** The --distill answer, or why lookup cannot use it. */
export function parseDistill(run: ProcessRunResult): { ok: true; out: Distilled } | { ok: false; reason: string } {
  if (run.exitCode !== 0) return { ok: false, reason: `exit-${run.exitCode}` }
  if (run.isStdoutTruncated) return { ok: false, reason: 'stdout-truncated' }
  let v: Partial<Distilled> | null
  try {
    v = JSON.parse(run.stdout.trim()) as Partial<Distilled> | null
  } catch {
    return { ok: false, reason: 'bad-output' }
  }
  if (!v || typeof v !== 'object' || typeof v.decision !== 'string') return { ok: false, reason: 'bad-output' }
  if (v.decision === 'refused') return { ok: false, reason: typeof v.reason === 'string' ? v.reason : 'refused' }
  if (typeof v.text !== 'string') return { ok: false, reason: 'bad-output' }
  return {
    ok: true,
    out: {
      decision: v.decision,
      engine: typeof v.engine === 'string' ? v.engine : null,
      text: v.text,
      bytesIn: typeof v.bytesIn === 'number' ? v.bytesIn : utf8Bytes(v.text),
      bytesOut: typeof v.bytesOut === 'number' ? v.bytesOut : utf8Bytes(v.text),
    },
  }
}

/** A shallow copy of `obj` without `keys`: a tool.call input less the engine's own fields. */
export function omit<T extends object>(obj: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (!keys.includes(k)) out[k] = v
  return out
}

const STUB_BYTES_DEFAULT = 32768
const STUB_CAP = 1200

/** A raw *_STUB_BYTES value: a positive number floored at 1200; anything else → 32768. */
export function stubBytes(raw: string | null | undefined): number {
  const n = Number(String(raw ?? '').trim())
  return Number.isFinite(n) && n > 0 ? Math.max(n, STUB_CAP) : STUB_BYTES_DEFAULT
}

/** A raw SLIM_DEBUG: `1|true|yes|on` → 1, an integer ≥2 → 2, else 0. */
export function debugLevel(raw: string | null | undefined): 0 | 1 | 2 {
  const v = String(raw ?? '').trim().toLowerCase()
  if (/^(1|true|yes|on)$/.test(v)) return 1
  return /^\d+$/.test(v) && Number(v) >= 2 ? 2 : 0
}

export const PLAIN_MIN = 8192
const PLAIN_DEFAULT = 65536

/** A raw SLIM_PLAIN_BYTES: a whole number floored at 8192; anything else → 65536. */
export function plainBytes(raw: string | null | undefined): number {
  const v = String(raw ?? '').trim()
  return /^\d+$/.test(v) ? Math.max(Number(v), PLAIN_MIN) : PLAIN_DEFAULT
}

/** `curl [-sSLkfI…] <url>` and nothing else: no pipe, no redirect, no header, no output file. */
const BARE_CURL = /^\s*curl(?:\s+-(?:[sSLkfI]+|-silent|-location|-fail|-compressed))*\s+(['"]?)(https?:\/\/[^\s'"]+)\1\s*$/

export function bareCurl(command: string): boolean {
  return BARE_CURL.test(command)
}

/** The first http(s) URL a command names, or null. */
export function curlUrl(command: string): string | null {
  return /https?:\/\/[^\s'"<>|;]+/.exec(command)?.[0] ?? null
}

/** A raw SLIM_TOAST_MS: whole ms, floored at 1000; invalid → 5000. */
export function toastMs(raw: string | null | undefined): number {
  const n = Number(String(raw ?? '').trim())
  return Number.isFinite(n) && n > 0 ? Math.max(Math.round(n), 1000) : 5000
}

// The same constants as scripts/slim.cjs: a real notice is small and names its file right after the phrase.
const OVERFLOW_MSG = 'exceeds maximum allowed tokens'
const OVERFLOW_PATH = /(\/[^\s"'\\]*tool-results\/[^\s"'\\]+)/
const OVERFLOW_WINDOW = 4096
const OVERFLOW_MAX_BYTES = 8192
const FND_STATS = /^fnd-mcp-slim: (?:compressed|stub) [\d,]+ B → [\d,]+ B \([+−]\d+\.\d%\)$/m
const OWN_STATS = /^slim: (?:compressed|stub) [\d,]+ B → [\d,]+ B \([+−]\d+\.\d%\)$/m
const MARKS = ['<<fnd-mcp-slim stub>>', '<<slim stub>>', '<<fnd-jsx-slim>>']

export type HostStub = { text: string; path: string }

/** The host's overflow notice (a bare string or the first text block), else null. */
export function hostStub(result: unknown): HostStub | null {
  const text = firstText(result)
  if (text === null || utf8Bytes(text) > OVERFLOW_MAX_BYTES) return null
  const at = text.indexOf(OVERFLOW_MSG)
  if (at === -1) return null
  const m = OVERFLOW_PATH.exec(text.slice(at, at + OVERFLOW_WINDOW))
  const path = m?.[1]?.replace(/[.,;:)\]]+$/, '')
  return path ? { text, path } : null
}

/** The texts a result carries: a string, a block array, an envelope's `content`, or a `.text`. */
export function texts(result: unknown): string[] {
  if (typeof result === 'string') return [result]
  const content = (result as { content?: unknown } | null)?.content
  const blocks = Array.isArray(result) ? result : Array.isArray(content) ? content : [result]
  const out: string[] = []
  for (const b of blocks) {
    const t = typeof b === 'string' ? b : (b as { text?: unknown } | null)?.text
    if (typeof t === 'string') out.push(t)
  }
  return out
}

/** UTF-8 bytes of the result as the core measures it: a string as is, else its JSON. */
export function resultBytes(result: unknown): number {
  if (typeof result === 'string') return utf8Bytes(result)
  try {
    return utf8Bytes(JSON.stringify(result) ?? '')
  } catch {
    return 0
  }
}

/**
 * True when the result is already a slimmer's output by fnd's rule: no larger than a stub can be and
 * carrying a stub or jsx mark, or a `<<full=` handle beside a stats line. A bigger one goes to the core,
 * which alone can check that its handle names a spill this user owns.
 */
export function alreadySlimIn(result: unknown, bound: number, fallbackText?: string): boolean {
  const ts = texts(result)
  if (!ts.length && fallbackText) ts.push(fallbackText)
  return alreadySlimTexts(ts, bound)
}

/** alreadySlimIn over texts a channel extracted (Bash stdout, a Read's content, …). */
export function alreadySlimTexts(ts: readonly string[], bound: number): boolean {
  if (!ts.length) return false
  let sum = 0
  for (const t of ts) sum += utf8Bytes(t)
  if (sum > bound) return false
  const isStats = (t: string) => FND_STATS.test(t) || OWN_STATS.test(t)
  return ts.some(t => MARKS.some(m => t.startsWith(m)) || (t.includes('<<full=') && isStats(t)))
}

function firstText(result: unknown): string | null {
  if (typeof result === 'string') return result
  if (!Array.isArray(result)) return null
  for (const block of result) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const t = (block as { text?: unknown }).text
      return typeof t === 'string' ? t : null
    }
  }
  return null
}

export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}
