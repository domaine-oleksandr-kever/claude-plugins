// fe's $.state contract. Values are JSON, so an absent value is null, never undefined. base's and slim's keys
// come from the dependency contracts the engine lays beside the module (base, and slim through base); they
// are never redeclared here.

/**
 * At most 9 characters each (band's kind cell). `start` fe's version at session start, `install` base is not
 * loaded, `profile` the project profile fe decided and how, `doctor` the counts of a /fe-doctor run.
 */
export type FeEventKind = 'start' | 'install' | 'profile' | 'doctor'

/** atMs = $.clock.now() when written; text is one line. */
export type FeEvent = { atMs: number; kind: FeEventKind; text: string }

/** The project profile fe's conventions follow; `none` outside a Shopify theme. */
export type FeProfile = 'foundation' | 'theme' | 'none'

/**
 * The profile of one session's project. `via`: `FE_PROFILE` forced it, `project-profile.sh` answered it
 * (detection or a domaine env file), `fallback` the script failed and fe took `none` (`why` says how).
 * `store`: the project root holds `shopify.theme.toml` or `.env`, so the store-access section applies.
 */
export type FeProfileInfo = {
  session: string
  word: FeProfile
  via: 'FE_PROFILE' | 'project-profile.sh' | 'fallback'
  why: string | null
  store: boolean
}

declare module 'claude-code' {
  interface PluginState {
    fe: {
      /** Oldest first, at most 200; any plugin reads, fe writes. Stays [] under FE_EVENT_LOG=0. */
      events: FeEvent[]
      /** Decided once per session id; null before the first decision. */
      profile: FeProfileInfo | null
      /** The session id whose start line was written and whose base check ran: a module reload does neither again. */
      started: string | null
      /** The session id whose /fe-doctor command is registered. */
      armed: string | null
    }
  }
}
