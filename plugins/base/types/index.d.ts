// base's $.state contract. Values are JSON, so an absent value is null, never undefined. slim's keys come
// from the dependency contract the engine lays beside the module; they are never redeclared here.

export type BaseMark = 'done' | 'current' | 'waiting' | 'todo'

/** One progress.md step; `text` is the step label with its mark stripped. */
export type BaseRow = { mark: BaseMark; text: string }

/**
 * The task workspace of the pinned or detected work id; `{ workId: null, branch }` when none applies.
 * band draws it: `current` is the step in progress, `notesTail` the last notes.md bullets but `compact:` and
 * `build-dirtied:` ones.
 * `mtimeMs` is the newest write of a file in the workspace root (0 = none; a compact marker is no write);
 * `lastSavableMs` the newest savable event of this work id this session (0 = none); `agentsSince` / `editsSince`
 * count the agent / edit ones after `mtimeMs`; `stale` = a workspace, `mtimeMs` older than the stale window
 * (20 min, 5 at 85 % context) and than `lastSavableMs`.
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
      lastSavableMs: number
      agentsSince: number
      editsSince: number
      stale: boolean
    }
  | { workId: null; branch: string | null }

/**
 * At most 9 characters each (band's kind cell); band and slim own session, model, compact, rate, slim and lookup.
 * `start` base's version at session start, `install` slim missing, `refuse` a reader refused,
 * `workspace` the work id base publishes, `title` the session title base set, `guard` a guard's deny,
 * `doctor` the counts of a /base-doctor run.
 */
export type BaseEventKind = 'start' | 'install' | 'workspace' | 'refuse' | 'title' | 'guard' | 'doctor'

/**
 * Worth saving to the workspace, in the main loop: an Agent / Task call returned, a Write / Edit outside `.claude/`,
 * an MCP result over slim's 4 KB gate. `workId` = the work id published when it happened (null = none).
 */
export type BaseSavable = { atMs: number; kind: 'agent' | 'edit' | 'mcp'; workId: string | null }

/** The last `compact:` line autosave appended: notes.md's mtime after it and the workspace mtime before it. */
export type BaseCompactMarker = { workId: string; notesMs: number; priorMs: number }

/**
 * The autosave turn: a counter bumped per prompt that starts a turn, when it began, the turn the stop was last
 * blocked in (0 = never), the workspace mtime seen at its start, the last turn that ended with a new one, and
 * the workspace mtime the prompt line last fired for (-1 = none).
 */
export type BaseAutosave = { turn: number; startMs: number; blockedTurn: number; writeMs: number; writeTurn: number; nudgedMs: number }

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
      /** The session id whose slim check ran (at its first prompt). */
      checked: string | null
      /** The session id whose title is settled: `<id>` titled by base, `<id>:user` set by the person. */
      titled: string | null
      /** The project root the session launched in, latched once: the scratch-path guard measures against it. */
      guardRoot: string | null
      /** The session id whose base-tmp sweep ran and whose /base-doctor command is registered. */
      swept: string | null
      /** This session's savable events, oldest first, at most 200. */
      savable: BaseSavable[]
      autosave: BaseAutosave | null
      compactMarker: BaseCompactMarker | null
    }
  }
}
