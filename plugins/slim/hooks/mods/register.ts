// slim hooks module: tool results, @-mentioned files and pasted prompts through slim's core, the spill-read
// guard, the lookup and view tools, the lines slim draws and the event log on disk.
import type { Register } from 'claude-code'
import { registerDescribe } from './describe'
import { registerEventLog } from './eventlog'
import { registerGuard } from './guard'
import { registerInfo } from './info'
import { registerIntake } from './intake'
import { registerLookup } from './lookup'
import { registerPrompt } from './prompt'
import { registerRender } from './render'
import { registerView } from './view'

export const register: Register = (on, options) => {
  const attachments = options.attachments === true
  registerIntake(on, attachments)
  registerGuard(on)
  registerPrompt(on)
  registerLookup(on)
  registerView(on)
  registerDescribe(on)
  registerInfo(on, attachments)
  registerEventLog(on)
  registerRender(on)
}
