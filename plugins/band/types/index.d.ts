// The band plugin's $.state contract: the keys band owns and writes, and the other plugins' keys it reads,
// typed locally (no `dependencies`). Values are JSON; a value never written reads as the atom's initial.

/** One rate-limit window as the band draws it; `pct` is the raw percentUsed (may pass 100). */
export type BandRate = { kind: string; label: string; pct: number; resetsAt: string | null }

/** Context, rate and cost figures; `ctxPct`/`ctxTokens` are null until the first reading and after a compaction; `costUsd` is null where the host keeps no ledger or BAND_COST is off. */
export type BandUsage = { ctxPct: number | null; ctxTokens: number | null; window: number; rates: BandRate[]; costUsd: number | null }

/** Prompt-cache estimate: `anchorMs` = clock time of the last main-thread response, null before one. */
export type BandCache = {
  anchorMs: number | null
  ttlMs: number
  ttlSource: 'option' | 'store' | 'model-switch' | 'agent' | 'subscription' | 'default'
  isCold: boolean
}

export type BandEventKind = 'session' | 'model' | 'compact' | 'rate'
/** One of band's own event-log lines; `atMs` = `$.clock.now()` when written, `text` is one line. */
export type BandEvent = { atMs: number; kind: BandEventKind; text: string }

/** Written at every session.start of band, so non-null iff band is loaded; `disabled` = userConfig `disabled`. */
export type BandInfo = { v: 1; version: string; disabled: boolean }

/** A line from another plugin's event log; band reads only these fields and drops an entry missing one. */
export type ForeignEvent = { atMs: number; kind: string; text: string }

/** A team plugin on base whose event list band reads. */
export type TeamSource = 'fe' | 'qa' | 'be' | 'pm'
/** The list a log line came from: the PLUGIN column of the Log pane and `/band-log`. */
export type LogSource = 'band' | 'base' | 'slim' | TeamSource
/** One line of the merged log, tagged with its source list. */
export type LogLine = ForeignEvent & { plugin: LogSource }

export type ChecklistMark = 'done' | 'current' | 'waiting' | 'todo'
export type ChecklistRow = { mark: ChecklistMark; text: string }
/** The generic shape the Progress pane draws; band maps the published task snapshot into it. */
export type Checklist = { v: 1; title: string; subtitle?: string; rows: ChecklistRow[]; footer?: string[] }

/**
 * base's resolved task (its BaseProgress) as band reads it; every field is checked before use.
 * `stale`: a workspace with savable work and no write within base's window.
 */
export type ProgressSnapshot =
  | { workId: string; branch: string | null; hasWorkspace: boolean; done: number; total: number; current: string | null; rows: ChecklistRow[]; notesTail: string[]; mtimeMs: number; stale?: boolean }
  | { workId: null; branch: string | null }

declare module 'claude-code' {
  interface PluginState {
    band: {
      info: BandInfo | null
      usage: BandUsage
      model: string | null
      cache: BandCache
      /** clock time of the last refresh; 0 until the first session.start of this process */
      tick: number
      rateAlarmed: boolean
      /** the band-progress pane is placed and not closed; the band hides its digest then */
      paneShown: boolean
      /** the band holds the keyboard; hotkey letters are drawn only then */
      bandFocused: boolean
      /** the terminal's model picker is unfolded: the band row holds the models alone */
      modelPicker: boolean
      /** band's own event lines, oldest first, at most 200; stays [] under BAND_EVENT_LOG=0 */
      events: BandEvent[]
    }
    /** Owned and written by the base plugin; band only reads it (null / [] without base). */
    base: {
      events: ForeignEvent[]
      progress: ProgressSnapshot | null
    }
    /** Owned and written by the slim plugin; band only reads it. */
    slim: {
      events: ForeignEvent[]
    }
    /** Owned and written by the team plugins (fe, qa, be, pm); band only reads their event lists ([] without the plugin). */
    fe: {
      events: ForeignEvent[]
    }
    qa: {
      events: ForeignEvent[]
    }
    be: {
      events: ForeignEvent[]
    }
    pm: {
      events: ForeignEvent[]
    }
  }
}
