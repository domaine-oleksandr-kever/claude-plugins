// qa hooks module (Claude Code only): the QA team's root line, store-access posture and doctor beside base.
// qa writes only qa.* atoms. Each feature file declares its own atoms and keeps its `$` code to itself: the
// validator follows `$` only within one file.
import type { Register } from 'claude-code'
import { registerDoctor } from './doctor.ts'
import { registerSession } from './session.ts'

export const register: Register = (on) => {
  registerSession(on)
  registerDoctor(on)
}
