// fe hooks module (Claude Code only): the frontend team's conventions, project profile, store access and doctor
// beside base. fe writes only fe.* atoms. Each feature file declares its own atoms and keeps its `$` code to
// itself: the validator follows `$` only within one file.
import type { Register } from 'claude-code'
import { registerDoctor } from './doctor.ts'
import { registerSession } from './session.ts'

export const register: Register = (on) => {
  registerSession(on)
  registerDoctor(on)
}
