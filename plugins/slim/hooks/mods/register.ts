// slim hooks module: tool results, @-mentioned files and pasted prompts through slim's core, the spill-read
// guard, the lookup and view tools, the lines slim draws and the event log on disk.
import type { Register } from 'claude-code'
import { registerDescribe } from './describe.ts'
import { registerEventLog } from './eventlog.ts'
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
  registerEventLog(on)
  registerRender(on)
}
