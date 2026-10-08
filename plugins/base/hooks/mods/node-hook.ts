// Pure adapter between a guard mod and the script it delegates to: builds the `$.process.run` call and
// reads the script's JSON answer. The `$.process.run` call itself stays in the file that hooks the event.
import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

export type HookRun = { argv: string[]; init: ProcessRunInit }

/** `<interpreter> <root>/<rel> ...flags`, the event as JSON on stdin, `env` set over the host env. */
export function buildHookRun(
  interpreter: 'node' | 'bash',
  root: string,
  rel: string,
  stdinObj: unknown,
  env: Record<string, string>,
  timeoutMs: number,
): HookRun {
  const script = `${root.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`
  return {
    argv: [interpreter, script],
    init: { stdin: JSON.stringify(stdinObj), env: { ...env }, timeoutMs },
  }
}

export type HookOut = Record<string, unknown> & {
  hookSpecificOutput?: Record<string, unknown> & {
    permissionDecision?: string
    permissionDecisionReason?: string
  }
}

/** The script's JSON answer; null on a non-zero exit, a truncated, empty or non-object stdout. */
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
