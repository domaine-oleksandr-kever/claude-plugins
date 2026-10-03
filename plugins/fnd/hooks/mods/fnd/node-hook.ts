// Pure adapter between the mod and the classic Node hooks it delegates to:
// builds the `$.process.run` call, reads its answer, recognises the host's overflow stub and
// mcp-slim's stats line. The `$.process.run` call itself stays in the file that hooks the event.
import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

export type HookRun = { argv: string[]; init: ProcessRunInit }

/** `node <root>/<rel> ...flags`, the hook's stdin event as JSON, `env` set over the host env. */
export function buildHookRun(
  root: string,
  rel: string,
  flags: readonly string[],
  stdinObj: unknown,
  env: Record<string, string>,
  timeoutMs: number,
): HookRun {
  const script = `${root.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`
  return {
    argv: ['node', script, ...flags],
    init: { stdin: JSON.stringify(stdinObj), env: { ...env }, timeoutMs },
  }
}

export type HookOut = Record<string, unknown> & {
  hookSpecificOutput?: Record<string, unknown> & {
    permissionDecision?: string
    permissionDecisionReason?: string
    updatedToolOutput?: unknown
    updatedMCPToolOutput?: unknown
  }
  systemMessage?: string
}

/** The hook's JSON answer; null on a non-zero exit, a truncated, empty or non-object stdout. */
export function parseHookOut(run: ProcessRunResult): HookOut | null {
  if (run.exitCode !== 0 || run.isStdoutTruncated) return null
  const text = run.stdout.trim()
  if (!text) return null
  try {
    const v: unknown = JSON.parse(text)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as HookOut) : null
  } catch {
    return null
  }
}

/** A shallow copy of `obj` without `keys`: a tool.call input less the engine's own fields. */
export function omit<T extends object>(obj: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (!keys.includes(k)) out[k] = v
  return out
}

// Mirrors hooks/mcp-slim.cjs overflowSpill(): a real notice is small and names its file right
// after the phrase; anything larger merely carries the phrase.
const OVERFLOW_MSG = 'exceeds maximum allowed tokens'
const OVERFLOW_PATH = /(\/[^\s"'\\]*tool-results\/[^\s"'\\]+)/
const OVERFLOW_WINDOW = 4096
const OVERFLOW_MAX_BYTES = 8192

export type HostStub = { text: string; path: string }

/** The host's overflow notice in a tool result (a bare string or its first text block), else null. */
export function stubText(result: unknown): HostStub | null {
  const text = firstText(result)
  if (text === null || utf8Bytes(text) > OVERFLOW_MAX_BYTES) return null
  const at = text.indexOf(OVERFLOW_MSG)
  if (at === -1) return null
  const m = OVERFLOW_PATH.exec(text.slice(at, at + OVERFLOW_WINDOW))
  const path = m?.[1]?.replace(/[.,;:)\]]+$/, '')
  return path ? { text, path } : null
}

// hooks/compression-notice.cjs FIGURE[0], the grammar of mcp-slim's statsLine().
const STATS_LINE = /^fnd-mcp-slim: (?:compressed|stub) (?:\d{1,3}(?:,\d{3})*|\d+) B → (?:\d{1,3}(?:,\d{3})*|\d+) B \([-+−]?\d{1,3}(?:\.\d+)?%\)$/m
const STUB_MARK = '<<fnd-mcp-slim stub>>'

/** mcp-slim's stats line when the text is its own output (a `<<full=` handle or its stub), else null. */
export function slimFigure(text: string): string | null {
  if (!text.includes('<<full=') && !text.startsWith(STUB_MARK)) return null
  const m = STATS_LINE.exec(text)
  return m ? m[0] : null
}

const TOAST_MS_DEFAULT = 5000
const TOAST_MS_MIN = 1000

/** How long a savings toast stays, from a raw FND_SLIM_TOAST_MS: a whole number of ms, floored at 1 s; invalid → 5 s. */
export function toastMs(raw: string | null | undefined): number {
  const n = Number(String(raw ?? '').trim())
  return Number.isFinite(n) && n > 0 ? Math.max(Math.round(n), TOAST_MS_MIN) : TOAST_MS_DEFAULT
}

// hooks/mcp-slim.cjs STUB_BYTES_DEFAULT and STUB_CAP.
const STUB_BYTES_DEFAULT = 32768
const STUB_CAP = 1200

/** mcp-slim's stubBytes() over a raw FND_MCP_SLIM_STUB_BYTES: invalid → the default, floored at STUB_CAP. */
export function stubBytes(raw: string | null | undefined): number {
  const n = Number(String(raw ?? '').trim())
  return Number.isFinite(n) && n > 0 ? Math.max(n, STUB_CAP) : STUB_BYTES_DEFAULT
}

/**
 * The stats line when a tool result is mcp-slim's own output, else null. Mirrors its alreadySlim():
 * both marks in one text block, and no bigger than it can emit (`stubLimit` + STUB_CAP) so a payload
 * quoting an old emission is not taken for one. `fallbackText` stands in when the result has no text.
 */
export function slimFigureIn(result: unknown, stubLimit: number, fallbackText?: string): string | null {
  const texts = textsOf(result)
  if (!texts.length && fallbackText) texts.push(fallbackText)
  const figure = texts.map(slimFigure).find(f => f !== null)
  if (!figure) return null
  let bytes = 0
  for (const t of texts) bytes += utf8Bytes(t)
  return bytes > stubLimit + STUB_CAP ? null : figure
}

// mcp-slim's blocksOf(): a block array, or an envelope's `content`; else the value as one block.
function textsOf(result: unknown): string[] {
  if (typeof result === 'string') return [result]
  const content = (result as { content?: unknown } | null)?.content
  const blocks = Array.isArray(result) ? result : Array.isArray(content) ? content : [result]
  const texts: string[] = []
  for (const b of blocks) {
    const t = typeof b === 'string' ? b : (b as { text?: unknown } | null)?.text
    if (typeof t === 'string') texts.push(t)
  }
  return texts
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

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}
