// qa's $.state contract. Values are JSON, so an absent value is null, never undefined. base's and slim's keys
// come from the dependency contracts the engine lays beside the module (base, and slim through base); they
// are never redeclared here.

/**
 * At most 9 characters each (band's kind cell). `start` qa's version at session start, `install` base is not
 * loaded, `doctor` the counts of a /qa-doctor run.
 */
export type QaEventKind = 'start' | 'install' | 'doctor'

/** atMs = $.clock.now() when written; text is one line. */
export type QaEvent = { atMs: number; kind: QaEventKind; text: string }

declare module 'claude-code' {
  interface PluginState {
    qa: {
      /** Oldest first, at most 200; any plugin reads, qa writes. Stays [] under QA_EVENT_LOG=0. */
      events: QaEvent[]
      /** The session id whose start line was written and whose base check ran: a module reload does neither again. */
      started: string | null
      /** The session id whose /qa-doctor command is registered. */
      armed: string | null
    }
  }
}
