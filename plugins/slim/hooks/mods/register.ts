// slim hooks module: MCP tool results through slim's core, and the line it draws under them.
import type { Register } from 'claude-code'
import { registerMcp } from './mcp.ts'
import { registerRender } from './render.tsx'

export const register: Register = (on) => {
  registerMcp(on)
  registerRender(on)
}
