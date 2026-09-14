import { describe, expect, it } from 'vitest'
import {
  clearInheritedAgentBypassDefaults,
  migrateAgentYoloDefaults
} from './terminal-settings-migrations'
import { YOLO_TUI_AGENT_ARGS, YOLO_TUI_AGENT_ENV } from '../../../shared/tui-agent-permissions'
import type { GlobalSettings } from '../../../shared/global-settings-types'

// H1: migrateAgentYoloDefaults only fills gaps -- it never touches a value already present, so a
// profile Orca's own earlier migration filled with a YOLO value (the user never chose it) kept
// the bypass forever. clearInheritedAgentBypassDefaults is the one-shot second pass that clears
// exactly that, gated on its own agentBypassDefaultsReviewed flag.
describe('clearInheritedAgentBypassDefaults (H1)', () => {
  it('clears an inherited YOLO arg and env value the user never chose', () => {
    const hydrated = migrateAgentYoloDefaults({
      agentDefaultArgs: { claude: YOLO_TUI_AGENT_ARGS.claude },
      agentDefaultEnv: { goose: { ...YOLO_TUI_AGENT_ENV.goose } }
    } as GlobalSettings)

    const result = clearInheritedAgentBypassDefaults(undefined, hydrated)

    expect(result.agentDefaultArgs?.claude).toBe('')
    expect(result.agentDefaultEnv?.goose).toEqual({})
    expect(result.agentBypassDefaultsReviewed).toBe(true)
  })

  it('preserves a value that differs from the YOLO table', () => {
    const hydrated = migrateAgentYoloDefaults({
      agentDefaultArgs: { claude: '--some-custom-flag' }
    } as GlobalSettings)

    const result = clearInheritedAgentBypassDefaults(undefined, hydrated)

    expect(result.agentDefaultArgs?.claude).toBe('--some-custom-flag')
  })

  it('does nothing on a second load once already reviewed', () => {
    const hydrated = migrateAgentYoloDefaults({
      agentDefaultArgs: { claude: YOLO_TUI_AGENT_ARGS.claude }
    } as GlobalSettings)

    // Why: a user who re-enabled the identical bypass value in Settings after the first pass
    // must not have it silently cleared again on every later load.
    const result = clearInheritedAgentBypassDefaults(
      { agentBypassDefaultsReviewed: true } as GlobalSettings,
      hydrated
    )

    expect(result.agentDefaultArgs?.claude).toBe(YOLO_TUI_AGENT_ARGS.claude)
    expect(result.agentBypassDefaultsReviewed).toBe(true)
  })
})
