// be's $.state contract. Values are JSON, so an absent value is null, never undefined. base's and slim's keys
// come from the dependency contracts the engine lays beside the module (base, and slim through base); they
// are never redeclared here.

/**
 * At most 9 characters each (band's kind cell). `start` be's version at session start, `install` base is not
 * loaded, `doctor` the counts of a /be-doctor run.
 */
export type BeEventKind = 'start' | 'install' | 'doctor'

/** atMs = $.clock.now() when written; text is one line. */
export type BeEvent = { atMs: number; kind: BeEventKind; text: string }

declare module 'claude-code' {
  interface PluginState {
    be: {
      /** Oldest first, at most 200; any plugin reads, be writes. Stays [] under BE_EVENT_LOG=0. */
      events: BeEvent[]
      /** The session id whose start line was written and whose base check ran: a module reload does neither again. */
      started: string | null
      /** The session id whose /be-doctor command is registered. */
      armed: string | null
    }
  }
}
