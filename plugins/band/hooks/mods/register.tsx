// The band hooks module (Claude Code only): the status band, its figures and the Log and Progress panes. band draws
// and writes only its own atoms; it reads base.*, slim.* and the team plugins' events and never writes them.
// Each feature file declares its own atoms and keeps its `$` code to itself: the validator follows `$` only within one file.
import type { Register } from 'claude-code'
import { registerAccount } from './account'
import { registerBand } from './band'
import { registerChecklist } from './checklist'
import { registerInfo } from './info'
import { registerLog } from './log'
import { registerUsage } from './usage'

export const register: Register = (on, options) => {
  registerInfo(on, options)
  registerUsage(on, options)
  registerAccount(on)
  registerBand(on, options)
  registerChecklist(on)
  registerLog(on)
}
