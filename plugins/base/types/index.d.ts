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
 * count the agent / edit ones after `mtimeMs`; `stale` = a workspace not `guessed`, `mtimeMs` older than the stale
 * window (20 min, 5 at 85 % context) and than `lastSavableMs`.
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
      /**
       * Resolved from the branch or the newest progress.md, not from a pin or a named key, and not yet touched by this
       * session (a Read, Write or Edit under it, a Bash command naming its dir, a write into it): never `stale`.
       */
      guessed: boolean
    }
  | { workId: null; branch: string | null }

/**
 * At most 9 characters each (band's kind cell); band and slim own session, model, compact, rate, slim and lookup.
 * `start` base's version at session start, `install` slim missing, `refuse` a reader refused,
 * `workspace` the work id base publishes, `title` the session title base set, `guard` a guard's deny,
 * `doctor` the counts of a /base-doctor run, `defect` a plugin defect reported or a plugin script failed (dogfood mode).
 */
export type BaseEventKind = 'start' | 'install' | 'workspace' | 'refuse' | 'title' | 'guard' | 'doctor' | 'defect'

/**
 * Worth saving to the workspace, in the main loop: an Agent / Task call returned its result, a background agent it
 * launched stopped (either one only when that agent wrote no workspace file itself), a Write / Edit outside
 * `.claude/`, an MCP result over slim's 4 KB gate. `workId` = the work id published when it happened (null = none).
 */
export type BaseSavable = { atMs: number; kind: 'agent' | 'edit' | 'mcp'; workId: string | null }

/** The last `compact:` line autosave appended: notes.md's mtime after it and the workspace mtime before it. */
export type BaseCompactMarker = { workId: string; notesMs: number; priorMs: number }

/**
 * The autosave turn: a counter bumped per prompt that starts a turn, when it began, the turn the stop was last
 * blocked in (0 = never), and the workspace mtime the prompt line last fired for (-1 = none).
 */
export type BaseAutosave = { turn: number; startMs: number; blockedTurn: number; nudgedMs: number }

/**
 * Dogfood mode, per session id: the last plugin-script failure in the main loop (`failMs` 0 = none) and its
 * basename, and the last plugin_defect report this session (0 = none). Mirrored to dogfood-state.json for the Stop hook.
 */
export type BaseDogfood = { sid: string; failMs: number; script: string; reportMs: number }

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
      /** The session id whose first user message carries the conventions as the prompt.context fallback (no surface draws, no command-hook marker). */
      injected: string | null
      /** The session id whose classic.UserPromptSubmit reached base's mods (the doctor's `classic` row). */
      classic: string | null
      /** The session id whose title is settled: `<id>` titled by base, `<id>:user` set by the person. */
      titled: string | null
      /** The project root the session launched in, latched once: the scratch-path guard measures against it. */
      guardRoot: string | null
      /** base's own MCP tools (`mcp__plugin_base_…`) the MCP guard refused once in session `sid` because another server serves the same tools, at most 200; another sid counts as none. */
      mcpSoft: { sid: string; tools: string[] }
      /** The session id whose base-tmp sweep ran and whose /base-doctor command is registered. */
      swept: string | null
      /** This session's savable events, oldest first, at most 200. */
      savable: BaseSavable[]
      /** The ids of background agents the main loop launched that have not stopped yet, oldest first, at most 200. */
      background: string[]
      /** The ids of subagents that wrote a file in the published workspace's root and have not returned or stopped yet, at most 200. */
      saved: string[]
      autosave: BaseAutosave | null
      compactMarker: BaseCompactMarker | null
      /** Dogfood mode's session (BASE_DOGFOOD=1): whose /base-defects is registered, its script failure and its last report. */
      dogfood: BaseDogfood | null
    }
  }
}

