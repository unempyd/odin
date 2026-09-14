import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session-resume'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session-wire'
import { agentSubagentsEqual } from '../../../../shared/agent-status-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionStatusState
} from '../../../../shared/structured-agent-session-projection'
import { subagentSnapshotsFromTasks } from '../../../../shared/structured-agent-session-subagents'
import type { Tab } from '../../../../shared/tab-types'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import { getActiveRuntimeTarget, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'

type StructuredTab = Tab & { contentType: 'agent-session' }

function isStructuredTab(tab: Tab): tab is StructuredTab {
  return tab.contentType === 'agent-session' && isAgentSessionHandleProvider(tab.agentSessionAgent)
}

const structuredTabsByUnifiedTabsSnapshot = new WeakMap<
  Record<string, Tab[]>,
  readonly StructuredTab[]
>()

/** Project structured-session tabs once per immutable tab-map snapshot. */
export function getStructuredAgentSessionTabs(
  unifiedTabsByWorktree: Record<string, Tab[]>
): readonly StructuredTab[] {
  const cached = structuredTabsByUnifiedTabsSnapshot.get(unifiedTabsByWorktree)
  if (cached) {
    return cached
  }

  const tabs: StructuredTab[] = []
  for (const worktreeTabs of Object.values(unifiedTabsByWorktree)) {
    for (const tab of worktreeTabs) {
      if (isStructuredTab(tab)) {
        tabs.push(tab)
      }
    }
  }
  structuredTabsByUnifiedTabsSnapshot.set(unifiedTabsByWorktree, tabs)
  return tabs
}

/** The host's projected status for one session, live while the caller is mounted. */
function useStructuredAgentSessionStatusSummary(
  sessionId: string,
  target: RuntimeClientTarget
): { summary: AgentSessionStatusSummary | null; observation: 'live' | 'unverifiable' } {
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  useEffect(() => feed.activate(), [feed])
  const summary = useSyncExternalStore(
    feed.subscribe,
    () => feed.getSnapshot().get(sessionId) ?? null,
    () => null
  )
  const observation = useSyncExternalStore(
    feed.subscribe,
    () => feed.getSessionObservation(sessionId),
    () => 'unverifiable' as const
  )
  return { summary, observation }
}

/**
 * Local worktrees: main ingests this same summary into the hook store (see
 * `server-ingest-structured.ts`) and the applicator writes the row from `agentStatus:set`.
 * Writing it again here would give the pane key two writers — the exact defect
 * `docs/reference/agent-status-store.md` closes. So for a local worktree this projection
 * does nothing; the feed subscription below stays (it is what keeps a remote host's summary
 * flowing — see the `environmentId !== null` branch), but it feeds nothing into the store.
 *
 * Remote worktrees: the remote host ingests into *its own* hook store, which has no way to
 * reach this renderer — `agentStatus:set` is local Electron IPC only (main to its own
 * renderer), never a wire message (`docs/reference/remote-wire-compatibility.md`). This feed,
 * over `agentSession.subscribeStatus`, is the only channel a paired client has for a remote
 * structured session's status, so the write here stays exactly as it was.
 */
function projectStatus(
  tab: StructuredTab,
  summary: AgentSessionStatusSummary | null,
  observation: 'live' | 'unverifiable'
): void {
  const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
  const store = useAppStore.getState()
  // No persisted turn yet (or nothing known): the row shows no agent status at all.
  if (!summary?.status) {
    if (store.agentStatusByPaneKey?.[paneKey]) {
      store.removeAgentStatus(paneKey)
    }
    return
  }
  const subagents = subagentSnapshotsFromTasks(summary.backgroundTasks)
  const desired = {
    // Shared with `worktree ps`, so the CLI and this row cannot disagree about one session.
    state: structuredAgentSessionStatusState(summary.status),
    prompt: summary.latestPrompt,
    agentType: tab.agentSessionAgent,
    // The host projects these from the journal so the row reads like a hook-reported one:
    // the running tool while a turn is live, the agent's last words once it settles.
    ...(summary.model ? { model: summary.model } : {}),
    ...(summary.toolName ? { toolName: summary.toolName } : {}),
    ...(summary.toolInput ? { toolInput: summary.toolInput } : {}),
    ...(summary.lastAssistantMessage ? { lastAssistantMessage: summary.lastAssistantMessage } : {}),
    ...(subagents ? { subagents, subagentObservation: observation } : {}),
    sessionBoundary: false
  } as const
  const current = store.agentStatusByPaneKey?.[paneKey]
  if (
    current?.state === desired.state &&
    current.prompt === desired.prompt &&
    current.agentType === desired.agentType &&
    // A row keeps the last model it was told about, so only a reported one can differ.
    (summary.model === undefined || current.model === summary.model) &&
    current.toolName === summary.toolName &&
    current.toolInput === summary.toolInput &&
    current.lastAssistantMessage === summary.lastAssistantMessage &&
    agentSubagentsEqual(current.subagents, subagents) &&
    current.subagentObservation === desired.subagentObservation &&
    current.sessionBoundary === desired.sessionBoundary &&
    current.updatedAt === summary.updatedAt &&
    current.terminalTitle === tab.label &&
    current.tabId === tab.id &&
    current.worktreeId === tab.worktreeId &&
    current.terminalResumeEligible === false &&
    current.structuredHostOwned === summary.hostExecutionOwned &&
    agentProviderSessionsEqual(
      tab.agentSessionAgent,
      current.providerSession,
      summary.providerSession
    )
  ) {
    return
  }
  store.setAgentStatus(
    paneKey,
    desired,
    tab.label,
    {
      updatedAt: summary.updatedAt,
      // This ordered host feed can correct a legacy publication clock after upgrade.
      allowOlderTimestamp: true,
      stateStartedAt:
        desired.state !== 'done' && current?.state === desired.state
          ? current.stateStartedAt
          : summary.updatedAt,
      evidenceObservedAt: summary.updatedAt
    },
    { tabId: tab.id, worktreeId: tab.worktreeId },
    {
      ...(summary.providerSession ? { providerSession: summary.providerSession } : {}),
      terminalResumeEligible: false,
      ...(summary.hostExecutionOwned ? { structuredHostOwned: true as const } : {})
    }
  )
}

function StructuredAgentSessionStatusProjection({ tab }: { tab: StructuredTab }): null {
  const environmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, tab.worktreeId)
  )
  const target = useMemo(
    () => getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId }),
    [environmentId]
  )
  const { summary, observation } = useStructuredAgentSessionStatusSummary(tab.entityId, target)
  // Local: main is this pane key's only writer (see the doc comment on `projectStatus`), and it
  // clears the row itself when the session closes — no local cleanup needed. Remote: unchanged.
  const isRemote = environmentId !== null
  useEffect(() => {
    if (!isRemote) {
      return
    }
    projectStatus(tab, summary, observation)
  }, [isRemote, summary, observation, tab])
  useEffect(() => {
    if (!isRemote) {
      return undefined
    }
    return () =>
      useAppStore.getState().removeAgentStatus(structuredAgentSessionPaneKey(tab.id, tab.entityId))
  }, [isRemote, tab.entityId, tab.id])
  return null
}

export function StructuredAgentSessionStatusBridge(): React.JSX.Element {
  const tabs = useAppStore(
    useShallow((state) => getStructuredAgentSessionTabs(state.unifiedTabsByWorktree))
  )
  return (
    <>
      {tabs.map((tab) => (
        <StructuredAgentSessionStatusProjection key={`${tab.id}:${tab.entityId}`} tab={tab} />
      ))}
    </>
  )
}
