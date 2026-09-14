import type { GlobalSettings, OrcaWorkspaceLayout } from '../../../shared/global-settings-types'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import {
  legacyTerminalScrollbackBytesToRows,
  normalizeDesktopTerminalScrollbackRows
} from '../../../shared/terminal-scrollback-policy'
import {
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord
} from '../../../shared/tui-agent-launch-defaults'
import {
  sameEnv,
  YOLO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ENV
} from '../../../shared/tui-agent-permissions'

export function buildWorkspaceDirHistoryForUpdate(
  current: GlobalSettings,
  updates: Partial<GlobalSettings>
): OrcaWorkspaceLayout[] | null {
  if (!('workspaceDir' in updates) && !('nestWorkspaces' in updates)) {
    return null
  }
  const nextPath = updates.workspaceDir ?? current.workspaceDir
  const nextNestWorkspaces = updates.nestWorkspaces ?? current.nestWorkspaces
  if (
    normalizeRuntimePathForComparison(nextPath) ===
      normalizeRuntimePathForComparison(current.workspaceDir) &&
    nextNestWorkspaces === current.nestWorkspaces
  ) {
    return null
  }

  const previousLayout = {
    path: current.workspaceDir,
    nestWorkspaces: current.nestWorkspaces
  }
  const existing = current.workspaceDirHistory ?? []
  const next = [...existing]
  const previousKey = getWorkspaceLayoutHistoryKey(previousLayout)
  if (!next.some((layout) => getWorkspaceLayoutHistoryKey(layout) === previousKey)) {
    next.push(previousLayout)
  }
  return next
}

export type LegacyTerminalScrollbackSettings = {
  terminalScrollbackRows?: unknown
  terminalScrollbackBytes?: unknown
}

export const LEGACY_TERMINAL_TUI_SCROLL_SENSITIVITY_DEFAULT = 3

export function readLegacyTerminalScrollbackSettings(
  settings: unknown
): LegacyTerminalScrollbackSettings {
  return settings && typeof settings === 'object'
    ? (settings as LegacyTerminalScrollbackSettings)
    : {}
}

type RetiredGlobalSettings = {
  terminalScrollbackBytes?: unknown
  enableGitHubAttribution?: unknown
  showAgentsSidebar?: unknown
}

export function stripRetiredGlobalSettings(
  settings: Partial<GlobalSettings> | undefined
): Partial<GlobalSettings> {
  const {
    terminalScrollbackBytes: _legacyScrollbackBytes,
    enableGitHubAttribution: _legacyGitHubAttribution,
    showAgentsSidebar: _legacyShowAgentsSidebar,
    ...rest
  } = (settings ?? {}) as Partial<GlobalSettings> & RetiredGlobalSettings
  void _legacyScrollbackBytes
  void _legacyGitHubAttribution
  void _legacyShowAgentsSidebar
  return rest
}

export function migrateTerminalScrollbackRows(settings: unknown): {
  rows: number
  needsSave: boolean
} {
  const legacySettings = readLegacyTerminalScrollbackSettings(settings)
  const hasRows = Object.hasOwn(legacySettings, 'terminalScrollbackRows')
  const hasLegacyBytes = Object.hasOwn(legacySettings, 'terminalScrollbackBytes')
  const rows = hasRows
    ? normalizeDesktopTerminalScrollbackRows(legacySettings.terminalScrollbackRows)
    : legacyTerminalScrollbackBytesToRows(legacySettings.terminalScrollbackBytes)

  return {
    rows,
    needsSave: !hasRows || hasLegacyBytes || legacySettings.terminalScrollbackRows !== rows
  }
}

export function migrateTerminalTuiScrollSensitivityDefault(settings: GlobalSettings | undefined): {
  settings: Pick<
    GlobalSettings,
    'terminalTuiScrollSensitivity' | 'terminalTuiScrollSensitivityDefaultedToOne'
  >
  needsSave: boolean
} {
  const alreadyDefaultedToOne = settings?.terminalTuiScrollSensitivityDefaultedToOne === true
  const current = settings?.terminalTuiScrollSensitivity
  const shouldMoveInheritedDefault =
    !alreadyDefaultedToOne &&
    (current === undefined || current === LEGACY_TERMINAL_TUI_SCROLL_SENSITIVITY_DEFAULT)
  const terminalTuiScrollSensitivity = shouldMoveInheritedDefault ? 1 : (current ?? 1)

  return {
    settings: {
      terminalTuiScrollSensitivity,
      terminalTuiScrollSensitivityDefaultedToOne: true
    },
    needsSave: !alreadyDefaultedToOne || current === undefined
  }
}

export function getWorkspaceLayoutHistoryKey(layout: OrcaWorkspaceLayout): string {
  return `${normalizeRuntimePathForComparison(layout.path)}:${layout.nestWorkspaces}`
}

export function migrateAgentYoloDefaults(
  settings: GlobalSettings | undefined
): Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv' | 'agentYoloDefaultsMigrated'> {
  const existingArgs = normalizeTuiAgentArgsRecord(settings?.agentDefaultArgs)
  const existingEnv = normalizeTuiAgentEnvRecord(settings?.agentDefaultEnv)

  // Why: hydrate every known agent to manual ('' / {}); migration never injects a permission bypass.
  for (const agent of Object.keys(YOLO_TUI_AGENT_ARGS)) {
    if (!(agent in existingArgs)) {
      existingArgs[agent as keyof typeof YOLO_TUI_AGENT_ARGS] = ''
    }
  }
  for (const agent of Object.keys(YOLO_TUI_AGENT_ENV)) {
    if (!(agent in existingEnv)) {
      existingEnv[agent as keyof typeof YOLO_TUI_AGENT_ENV] = {}
    }
  }

  return {
    agentDefaultArgs: existingArgs,
    agentDefaultEnv: existingEnv,
    agentYoloDefaultsMigrated: true
  }
}

// Why a separate one-shot flag from agentYoloDefaultsMigrated (H1): that migration only fills
// in *missing* entries with a manual default -- it never touches a value already present, so a
// profile Orca's own earlier migration filled with a YOLO value (the user never chose it) kept
// the bypass forever. Reusing agentYoloDefaultsMigrated would skip every profile that already
// has it set to true, which is most existing installs. A user who had explicitly chosen the
// identical bypass value re-enables it once in Settings after this runs.
export function clearInheritedAgentBypassDefaults(
  settings: GlobalSettings | undefined,
  hydrated: Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv'>
): Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv' | 'agentBypassDefaultsReviewed'> {
  if (settings?.agentBypassDefaultsReviewed === true) {
    return {
      agentDefaultArgs: hydrated.agentDefaultArgs,
      agentDefaultEnv: hydrated.agentDefaultEnv,
      agentBypassDefaultsReviewed: true
    }
  }

  const agentDefaultArgs = { ...hydrated.agentDefaultArgs }
  for (const key of Object.keys(YOLO_TUI_AGENT_ARGS)) {
    const agent = key as keyof typeof YOLO_TUI_AGENT_ARGS
    if (agentDefaultArgs[agent] === YOLO_TUI_AGENT_ARGS[agent]) {
      agentDefaultArgs[agent] = ''
    }
  }

  const agentDefaultEnv = { ...hydrated.agentDefaultEnv }
  for (const key of Object.keys(YOLO_TUI_AGENT_ENV)) {
    const agent = key as keyof typeof YOLO_TUI_AGENT_ENV
    if (sameEnv(agentDefaultEnv[agent], YOLO_TUI_AGENT_ENV[agent])) {
      agentDefaultEnv[agent] = {}
    }
  }

  return { agentDefaultArgs, agentDefaultEnv, agentBypassDefaultsReviewed: true }
}
