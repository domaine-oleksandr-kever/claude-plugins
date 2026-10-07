// slim's $.state contract. Values are JSON, so an absent value is null, never undefined.

export type SlimEngine = 'json' | 'jsonl' | 'log' | 'html' | 'figma' | 'adf' | 'text' | 'stub'

/** The tool results slim reads: MCP calls and the built-in tools it has an intake for. */
export type SlimChannel = 'mcp' | 'bash' | 'read' | 'webfetch' | 'websearch' | 'grep' | 'glob' | 'agent'

/** atMs = $.clock.now() when written; text is one line. */
export type SlimEventBase = {
  v: 1
  atMs: number
  text: string
  src: 'slim'
  /** The full tool name. */
  tool: string
  /** Absent on the main loop; the subagent's type from $.agent.list(), else 'agent'. */
  agentType?: string
  ms: number
}

/** One compressed or stubbed tool result; bytesIn is what the host would have shown (bytes_seen ?? bytes_in). */
export type SlimCompressEvent = SlimEventBase & {
  kind: 'slim'
  channel: SlimChannel
  bytesIn: number
  bytesOut: number
  engine: SlimEngine
}

/** One lookup call: the only model spend slim adds. tokens.input counts cache reads and writes too. */
export type SlimLookupEvent = SlimEventBase & {
  kind: 'lookup'
  model: string
  tokens: { input: number; output: number } | null
  answered: boolean
}

export type SlimEvent = SlimCompressEvent | SlimLookupEvent

/** What the ToolResult and ToolGroup lines draw for one tool_use_id; bytesIn = bytes_seen ?? bytes_in. */
export type SlimRow = { engine: SlimEngine; bytesIn: number; bytesOut: number }

/** Snapshot slim writes at session.start; any plugin reads it to tell slim is loaded. */
export type SlimInfo = { v: 1; version: string; channels: SlimChannel[] }

declare module 'claude-code' {
  interface PluginState {
    slim: {
      /** Oldest first, at most 200; any plugin reads, slim writes; stays [] under SLIM_EVENT_LOG=0. */
      events: SlimEvent[]
      /** One member per compressed tool_use_id; written by the tool.call hook, read by the ToolResult and ToolGroup lines. */
      rows: StateFamily<SlimRow | null>
      /** null until slim's session.start ran; channels lists those whose SLIM_<CHANNEL> switch is not 0. */
      info: SlimInfo | null
    }
  }
}
