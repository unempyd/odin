import { canCommandCodeOutputOwnPane } from '@/components/terminal-pane/command-code-output-ownership'
import { resolvePaneAgentOwner } from '../../../../shared/pane-agent-owner'
import type { AppState } from '../../store/types'

/**
 * Renderer-side ownership drop filter for an inbound `agentStatus:set` command-code row.
 *
 * Why here, not in main: ownership (foreground process, retained agent) is renderer-only
 * state main never sees. Main now writes every command-code detection it observes
 * (status-D), so this is the filter that keeps a pane's command-code row from overwriting
 * a different foreground/retained agent — the same policy title-spawn-bell.ts and
 * parked-terminal-command-status.ts already apply before their own (byte-parser-fallback)
 * writes.
 */
export type CommandCodeOwnershipFilterStore = Pick<
  AppState,
  | 'paneForegroundAgentByPaneKey'
  | 'tabsByWorktree'
  | 'agentLaunchConfigByPaneKey'
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
>

/** Bundles the routing context an applicator call site already has in scope. */
export type CommandCodeOwnershipFilterContext = {
  store: CommandCodeOwnershipFilterStore
  paneKey: string
  ownerTabId: string | undefined
  owningWorktreeId: string | undefined
}

export function dropsCommandCodeAgentStatus(
  payload: { agentType?: string },
  ctx: CommandCodeOwnershipFilterContext
): boolean {
  if (payload.agentType !== 'command-code') {
    return false
  }
  const { store, paneKey, ownerTabId, owningWorktreeId } = ctx
  const foreground = store.paneForegroundAgentByPaneKey[paneKey]
  const tab = owningWorktreeId
    ? (store.tabsByWorktree[owningWorktreeId] ?? []).find((entry) => entry.id === ownerTabId)
    : undefined
  const paneOwnerAgent = resolvePaneAgentOwner({
    launchAgent: tab?.launchAgent,
    startupLaunchAgent: store.agentLaunchConfigByPaneKey[paneKey]?.identity.agentType,
    hookAgent: store.agentStatusByPaneKey[paneKey]?.agentType
  })
  return !canCommandCodeOutputOwnPane({
    foregroundAgent: foreground?.agent,
    shellForeground: foreground?.shellForeground,
    paneOwnerAgent,
    retainedPaneOwnerAgent: store.retainedAgentsByPaneKey[paneKey]?.agentType
  })
}
