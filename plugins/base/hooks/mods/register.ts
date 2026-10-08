// base hooks module (Claude Code only): the workspace progress band draws, the install checks, the session
// title, the guards, the conventions, the doctor and the event log on disk. base writes only base.* atoms.
// Each feature file declares its own atoms and keeps its `$` code to itself: the validator follows `$` only within one file.
import type { Register } from 'claude-code'
import { registerConventions } from './conventions.ts'
import { registerDoctor } from './doctor.ts'
import { registerBashGuards } from './guards/bash.ts'
import { registerScratchGuard } from './guards/scratch.ts'
import { registerSession } from './session.ts'
import { registerTitle } from './title.ts'
import { registerProgress } from './workspace/progress.ts'

export const register: Register = (on) => {
  registerSession(on)
  registerProgress(on)
  registerTitle(on)
  registerBashGuards(on)
  registerScratchGuard(on)
  registerConventions(on)
  registerDoctor(on)
}
