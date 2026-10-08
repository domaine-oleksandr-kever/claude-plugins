// Pure helpers for base's event list. No `$` here: each writer file keeps its own wrapper, as the validator
// follows `$` only within one file.
import type { BaseEvent } from '../../types'

export const EVENT_CAP = 200

/** Appends `ev`, oldest first, at most EVENT_CAP: past the cap the oldest line goes. */
export function pushEvent(list: readonly BaseEvent[], ev: BaseEvent): BaseEvent[] {
  return list.length < EVENT_CAP ? [...list, ev] : [...list.slice(1), ev]
}

/** `base scratch-path guard: <reason>` → `<reason>`: the kind column already names the source. */
export function bare(text: string): string {
  return text.replace(/^base[ -][a-z -]+?: /, '')
}

/** `mcp__plugin_base_chrome-devtools-mcp__take_screenshot` → `take_screenshot`. */
export function toolName(tool: string): string {
  return tool.split('__').pop() ?? tool
}
