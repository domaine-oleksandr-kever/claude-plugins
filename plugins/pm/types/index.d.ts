// pm's $.state contract. Values are JSON, so an absent value is null, never undefined. base's and slim's keys
// come from the dependency contracts the engine lays beside the module (base, and slim through base); they
// are never redeclared here.

/**
 * At most 9 characters each (band's kind cell). `start` pm's version at session start, `install` base is not
 * loaded, `doctor` the counts of a /pm-doctor run.
 */
export type PmEventKind = 'start' | 'install' | 'doctor'

/** atMs = $.clock.now() when written; text is one line. */
export type PmEvent = { atMs: number; kind: PmEventKind; text: string }

declare module 'claude-code' {
  interface PluginState {
    pm: {
      /** Oldest first, at most 200; any plugin reads, pm writes. Stays [] under PM_EVENT_LOG=0. */
      events: PmEvent[]
      /** The session id whose start line was written and whose base check ran: a module reload does neither again. */
      started: string | null
      /** The session id whose /pm-doctor command is registered. */
      armed: string | null
    }
  }
}
