import type { Register } from 'claude-code'

import { registerCleanView } from './clean-view'

// One entry point, so more mods can be registered beside Clean View later.
export const register: Register = on => {
  registerCleanView(on)
}
