// The fnd hooks module (Claude Code only): core = band, usage, progress, log; fnd = marker, guard, slim, prompt-slim.
// Each feature file declares its own atoms and keeps its `$` code to itself: the validator follows `$` only within one file.
import type { Register } from 'claude-code'
import { registerBand } from './core/band'
import { registerLog } from './core/log'
import { registerProgress } from './core/progress'
import { registerUsage } from './core/usage'
import { registerGuard } from './fnd/guard'
import { registerMarker } from './fnd/marker'
import { registerPromptSlim } from './fnd/prompt-slim'
import { registerSlim } from './fnd/slim'

export const register: Register = (on, options) => {
  registerMarker(on)
  registerUsage(on, options)
  registerBand(on, options)
  registerProgress(on)
  registerLog(on)
  registerGuard(on)
  registerSlim(on)
  registerPromptSlim(on)
}
