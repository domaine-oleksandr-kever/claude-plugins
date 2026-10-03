// The fnd hooks module (Claude Code only): core = band, usage, progress; fnd = marker, guard, slim, prompt-slim.
// Each feature file declares its own atoms and keeps its `$` code to itself: the validator follows `$` only within one file.
import type { Register } from 'claude-code'
import { registerBand } from './core/band.tsx'
import { registerProgress } from './core/progress.tsx'
import { registerUsage } from './core/usage.ts'
import { registerGuard } from './fnd/guard.ts'
import { registerMarker } from './fnd/marker.ts'
import { registerPromptSlim } from './fnd/prompt-slim.ts'
import { registerSlim } from './fnd/slim.ts'

export const register: Register = (on, options) => {
  registerMarker(on)
  registerUsage(on, options)
  registerBand(on, options)
  registerProgress(on)
  registerGuard(on)
  registerSlim(on)
  registerPromptSlim(on)
}
