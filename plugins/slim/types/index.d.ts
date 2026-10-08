// slim's $.state contract. Values are JSON, so an absent value is null, never undefined.

export type SlimEngine = 'json' | 'jsonl' | 'log' | 'html' | 'figma' | 'figma-nodes' | 'adf' | 'text' | 'stub'

/** What slim reads: MCP calls, the built-in tools it has an intake for, @-mentioned files and pasted prompts. */
export type SlimChannel = 'mcp' | 'bash' | 'read' | 'webfetch' | 'websearch' | 'grep' | 'glob' | 'agent' | 'attachment' | 'prompt'

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

/**
 * One compressed or stubbed tool result, @-mentioned file or pasted prompt; bytesIn is what the host would
 * have shown (bytes_seen ?? bytes_in). tool is 'Attachment' for a file, 'prompt' for a prompt.
 */
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

/** One view call; engine is 'media' for an image or a video, null when refused before an engine ran. */
export type SlimViewEvent = SlimEventBase & {
  kind: 'view'
  channel: 'view'
  decision: 'compressed' | 'narrowed' | 'passthrough' | 'cached' | 'refused'
  engine: string | null
  bytesIn: number
  bytesOut: number
}

/** slim's first line in a session: text `slim <version>`. */
export type SlimStartEvent = { v: 1; atMs: number; kind: 'start'; text: string; src: 'slim' }

export type SlimEvent = SlimCompressEvent | SlimLookupEvent | SlimViewEvent | SlimStartEvent

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
      /** One member per @-mentioned file content slim compressed this session (keyed by its hash): the Log line is written once. */
      seen: StateFamily<true | null>
      /** The session id whose start line slim wrote, so a repeated session.start writes none. */
      started: string | null
    }
  }
}
