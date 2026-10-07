// slim hooks module: a pass-through placeholder until the result proxy lands.
import type { Register } from 'claude-code'

export const register: Register = (on) => {
  on('session.start', async (_$, e, next) => next(e))
}
