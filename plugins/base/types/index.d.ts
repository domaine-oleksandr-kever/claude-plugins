// base's $.state contract. Values are JSON, so an absent value is null, never undefined. slim's keys come
// from the dependency contract the engine lays beside the module; they are never redeclared here.

export type BaseMark = 'done' | 'current' | 'waiting' | 'todo'

/** One progress.md step; `text` is the step label with its mark stripped. */
export type BaseRow = { mark: BaseMark; text: string }

/**
 * The task workspace of the pinned or detected work id; `{ workId: null, branch }` when none applies.
 * band draws it: `current` is the step in progress, `notesTail` the last notes.md bullets.
 */
export type BaseProgress =
  | {
      workId: string
      branch: string | null
      hasWorkspace: boolean
      done: number
      total: number
      current: string | null
      rows: BaseRow[]
      notesTail: string[]
      mtimeMs: number
    }
  | { workId: null; branch: string | null }

/**
 * At most 9 characters each (band's kind cell); band and slim own session, model, compact, rate, slim and lookup.
 * `start` base's version at session start, `install` slim missing or fnd present, `refuse` a reader refused,
 * `workspace` the work id base publishes, `title` the session title base set, `guard` a guard's deny,
 * `doctor` the counts of a /base-doctor run.
 */
export type BaseEventKind = 'start' | 'install' | 'workspace' | 'refuse' | 'title' | 'guard' | 'doctor'

/** atMs = $.clock.now() when written; text is one line. */
export type BaseEvent = { atMs: number; kind: BaseEventKind; text: string }

declare module 'claude-code' {
  interface PluginState {
    base: {
      progress: BaseProgress | null
      /** The work id `/base-progress <KEY>` pinned; null follows the branch and the conversation. */
      pin: string | null
      /** The last work id detected in the session. */
      lastKey: string | null
      sessionId: string | null
      /** Oldest first, at most 200; any plugin reads, base writes. Stays [] under BASE_EVENT_LOG=0. */
      events: BaseEvent[]
      /** The session id whose start line was written: a module reload writes none. */
      started: string | null
      /** The session id whose slim and fnd checks ran (at its first prompt). */
      checked: string | null
      /** The session id whose title is settled: `<id>` titled by base, `<id>:user` set by the person. */
      titled: string | null
      /** The project root the session launched in, latched once: the scratch-path guard measures against it. */
      guardRoot: string | null
      /** The session id whose base-tmp sweep ran and whose /base-doctor command is registered. */
      swept: string | null
    }
  }
}
