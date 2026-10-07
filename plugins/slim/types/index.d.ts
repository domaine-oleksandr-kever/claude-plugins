// slim's $.state contract. Values are JSON, so an absent value is null, never undefined.

export type SlimEngine = 'json' | 'log' | 'jsx' | 'stub'

/** One compressed or stubbed tool result; atMs = $.clock.now() when written; text is one line. */
export type SlimEvent = {
  v: 1
  atMs: number
  kind: 'slim'
  text: string
  src: 'slim'
  /** The full tool name. */
  tool: string
  /** Absent on the main loop; the subagent's type from $.agent.list(), else 'agent'. */
  agentType?: string
  bytesIn: number
  bytesOut: number
  engine: SlimEngine
  ms: number
}

/** What the ToolResult line draws for one tool_use_id. */
export type SlimRow = { engine: SlimEngine; bytesIn: number; bytesOut: number }

declare module 'claude-code' {
  interface PluginState {
    slim: {
      /** Oldest first, at most 200; any plugin reads, slim writes; stays [] under SLIM_EVENT_LOG=0. */
      events: SlimEvent[]
      /** One member per compressed tool_use_id; written by the tool.call hook, read by the ToolResult line. */
      rows: StateFamily<SlimRow | null>
    }
  }
}
