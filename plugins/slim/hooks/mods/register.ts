// slim hooks module: tool results through slim's core, the lookup tool, and the lines slim draws.
import type { Register } from 'claude-code'
import { registerDescribe } from './describe.ts'
import { registerInfo } from './info.ts'
import { registerIntake } from './intake.ts'
import { registerLookup } from './lookup.ts'
import { registerRender } from './render.tsx'

export const register: Register = (on) => {
  registerIntake(on)
  registerLookup(on)
  registerDescribe(on)
  registerInfo(on)
  registerRender(on)
}
