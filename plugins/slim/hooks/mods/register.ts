// slim hooks module: tool results, @-mentioned files and pasted prompts through slim's core, the spill-read
// guard, the lookup and view tools, and the lines slim draws.
import type { Register } from 'claude-code'
import { registerDescribe } from './describe.ts'
import { registerGuard } from './guard.ts'
import { registerInfo } from './info.ts'
import { registerIntake } from './intake.ts'
import { registerLookup } from './lookup.ts'
import { registerPrompt } from './prompt.ts'
import { registerRender } from './render.tsx'
import { registerView } from './view.ts'

export const register: Register = (on) => {
  registerIntake(on)
  registerGuard(on)
  registerPrompt(on)
  registerLookup(on)
  registerView(on)
  registerDescribe(on)
  registerInfo(on)
  registerRender(on)
}
