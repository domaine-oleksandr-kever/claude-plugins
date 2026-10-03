// The fnd hooks module (Claude Code only): core = band, usage, progress; fnd = guard, slim.
// Each feature file declares its own atoms and keeps its `$` code to itself: the validator follows `$` only within one file.
import type { Register } from 'claude-code'
import { registerBand } from './core/band.tsx'
import { registerProgress } from './core/progress.tsx'
import { registerUsage } from './core/usage.ts'
import { registerGuard } from './fnd/guard.ts'
import { registerSlim } from './fnd/slim.ts'

export const register: Register = (on, options) => {
  registerUsage(on, options)
  registerBand(on, options)
  registerProgress(on)
  registerGuard(on)
  registerSlim(on)
}
