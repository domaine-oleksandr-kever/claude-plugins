// be hooks module (Claude Code only): the backend team's plugin root line and doctor beside base. be writes
// only be.* atoms. Each feature file declares its own atoms and keeps its `$` code to itself: the validator
// follows `$` only within one file.
import type { Register } from 'claude-code'
import { registerDoctor } from './doctor.ts'
import { registerSession } from './session.ts'

export const register: Register = (on) => {
  registerSession(on)
  registerDoctor(on)
}
