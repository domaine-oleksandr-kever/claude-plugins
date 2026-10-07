// The fnd mod's $.state contract: the one list of keys `claude plugin validate` holds every
// read and write to. Values are JSON, so an absent value is `null`, never `undefined`.

/** One rate-limit window as the band draws it; `pct` is the raw percentUsed (may pass 100). */
export type FndRate = { kind: string; label: string; pct: number; resetsAt: string | null }

/** Context, rate and cost figures; `ctxPct`/`ctxTokens` are null until the first reading and after a compaction; `costUsd` null where the host keeps no ledger. */
export type FndUsage = { ctxPct: number | null; ctxTokens: number | null; window: number; rates: FndRate[]; costUsd: number | null }

/** Prompt-cache estimate: `anchorMs` = clock time of the last main-thread response, null before one. */
export type FndCache = {
  anchorMs: number | null
  ttlMs: number
  ttlSource: 'option' | 'store' | 'model-switch' | 'agent' | 'subscription' | 'resume' | 'default'
  isCold: boolean
}

/** `waiting`: unchecked above the `current` row (waits on someone, not the queue). */
export type FndRow = { mark: 'done' | 'current' | 'waiting' | 'todo'; text: string }

/** The resolved task digest, or `{ workId: null }` when nothing answers. */
export type FndProgress =
  | {
      workId: string
      branch: string | null
      /** `.claude/tasks/<workId>/` exists; false = a ticket the conversation named that has no workspace yet */
      hasWorkspace: boolean
      done: number
      total: number
      current: string | null
      rows: FndRow[]
      notesTail: string[]
      mtimeMs: number
    }
  | { workId: null; branch: string | null }

export type FndEventKind = 'session' | 'model' | 'compact' | 'rate' | 'workspace' | 'slim' | 'prompt' | 'guard'
/** One event-log line; `atMs` = `$.clock.now()` when written, `text` one line, no kind prefix. */
export type FndEvent = { atMs: number; kind: FndEventKind; text: string }

/** A line from another plugin's event log (slim's `slim` / `lookup`); fnd reads only these fields. */
export type FndForeignEvent = { atMs: number; kind: string; text: string }
/** The slim plugin's session.start snapshot: present iff slim is loaded; `channels` = its channels not switched off. */
export type FndSlimInfo = { v: 1; version: string; channels: string[] }

declare module 'claude-code' {
  interface PluginState {
    fnd: {
      usage: FndUsage
      model: string | null
      cache: FndCache
      tick: number
      progress: FndProgress | null
      pin: string | null
      rateAlarmed: boolean
      /** progress pane placed and not closed; the band reads it instead of $.ui.panes() */
      paneShown: boolean
      /** the band holds the keyboard (ui.focus landed on it); hotkey letters are drawn only then */
      bandFocused: boolean
      /** the terminal's model picker is unfolded: the band row holds the models alone */
      modelPicker: boolean
      /** last ticket a person's prompt named (a `/browse/` URL or a known project corroborates the key) */
      lastKey: string | null
      /** last seen $.session.id(), to spot a /clear */
      sessionId: string | null
      /** launch root latched once for the guard */
      guardRoot: string | null
      /** event-log ring buffer, oldest first, at most 200; stays [] under FND_EVENT_LOG=0 */
      events: FndEvent[]
      /** the FND_COMPRESSION=proxy fallback notice this session: `<session id>` once logged, `<session id>:toast` once toasted too */
      proxyNotice: string | null
      /** session id the FND_COMPRESSION=proxy scratch-file sweep was started for (once per session) */
      proxySweep: string | null
    }
    /** Owned and written by the separate slim plugin; fnd only reads it, and both stay null/[] without slim. */
    slim: {
      events: FndForeignEvent[]
      info: FndSlimInfo | null
    }
  }
}
