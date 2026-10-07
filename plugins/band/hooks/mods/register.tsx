// The band hooks module (Claude Code only): the status band, its figures, the Log and Progress panes and the session
// marker. band draws and writes only its own atoms; it reads fnd.* and slim.* and never writes them.
// Each feature file declares its own atoms and keeps its `$` code to itself: the validator follows `$` only within one file.
import type { Register } from 'claude-code'
import { registerBand } from './band.tsx'
import { registerChecklist } from './checklist.tsx'
import { registerInfo } from './info.ts'
import { registerLog } from './log.tsx'
import { registerMarker } from './marker.ts'
import { registerUsage } from './usage.ts'

export const register: Register = (on, options) => {
  // First, so the marker is written before every other prompt.submit hook runs.
  registerMarker(on, options)
  registerInfo(on, options)
  registerUsage(on, options)
  registerBand(on, options)
  registerChecklist(on)
  registerLog(on)
}
