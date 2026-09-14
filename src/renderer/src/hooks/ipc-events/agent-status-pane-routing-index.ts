import { collectLeafIdsInOrder } from '@/components/terminal-pane/layout-serialization'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import type { AppState } from '../../store/types'

type AgentStatusPaneResolution = {
  exists: boolean
  title: string | undefined
  identityTitle: string | undefined
  repoConnectionId: string | null
  repoConnectionResolved: boolean
  owningWorktreeId: string | undefined
  titleUsesTabTitle: boolean
  tabTitle: string | undefined
}

type AgentStatusWorktreeConnectionResolution = {
  worktreeExists: boolean
  repoConnectionId: string | null
  repoConnectionResolved: boolean
}

type IndexedAgentStatusTab = {
  title: string | undefined
  owningWorktreeId: string
}

export type AgentStatusPaneRoutingIndex = {
  tabsById: Map<string, IndexedAgentStatusTab>
  /** Structured (native chat) tabs, keyed by tab id. They own no `tabsByWorktree` entry — that
   *  map is PTY terminals only — so a structured pane key needs its own existence check. */
  agentSessionTabsById: Map<string, { owningWorktreeId: string }>
  unifiedTabsByWorktree: AppState['unifiedTabsByWorktree']
  unifiedLabelsByWorktreeId: Map<string, Map<string, string | undefined>>
  layoutsByTabId: AppState['terminalLayoutsByTabId']
  leafIdsByRoot: WeakMap<TerminalPaneLayoutNode, Set<string>>
  worktreesById: ReturnType<typeof getWorktreeMapFromState>
  reposById: ReturnType<typeof getRepoMapFromState>
}

/** Deterministic build accounting for the memoization ratchet test and the routing benchmark. */
export const agentStatusPaneRoutingIndexCounters = {
  indexBuilds: 0,
  tabIndexBuilds: 0,
  tabVisits: 0,
  unifiedLabelIndexBuilds: 0,
  leafSetBuilds: 0
}

export function resetAgentStatusPaneRoutingIndexCounters(): void {
  agentStatusPaneRoutingIndexCounters.indexBuilds = 0
  agentStatusPaneRoutingIndexCounters.tabIndexBuilds = 0
  agentStatusPaneRoutingIndexCounters.tabVisits = 0
  agentStatusPaneRoutingIndexCounters.unifiedLabelIndexBuilds = 0
  agentStatusPaneRoutingIndexCounters.leafSetBuilds = 0
}

// Why: layout roots are immutable snapshots, so leaf membership keyed on the root node stays
// correct across commits and never has to be rewalked once seen.
const leafIdsByRoot = new WeakMap<TerminalPaneLayoutNode, Set<string>>()
const tabsByIdCache = new WeakMap<AppState['tabsByWorktree'], Map<string, IndexedAgentStatusTab>>()
const agentSessionTabsByIdCache = new WeakMap<object, Map<string, { owningWorktreeId: string }>>()
const unifiedLabelIndexCache = new WeakMap<object, Map<string, Map<string, string | undefined>>>()
const routingIndexCache = new WeakMap<AppState['tabsByWorktree'], AgentStatusPaneRoutingIndex>()
const NO_UNIFIED_TABS = {}

/** Structured tabs live only in `unifiedTabsByWorktree`; first wins, matching `getIndexedTabs`. */
function getIndexedAgentSessionTabs(
  unifiedTabsByWorktree: AppState['unifiedTabsByWorktree']
): Map<string, { owningWorktreeId: string }> {
  const cacheKey = unifiedTabsByWorktree ?? NO_UNIFIED_TABS
  const cached = agentSessionTabsByIdCache.get(cacheKey)
  if (cached) {
    return cached
  }
  const byId = new Map<string, { owningWorktreeId: string }>()
  for (const [worktreeId, tabs] of Object.entries(unifiedTabsByWorktree ?? {})) {
    for (const tab of tabs) {
      if (tab.contentType === 'agent-session' && !byId.has(tab.id)) {
        byId.set(tab.id, { owningWorktreeId: worktreeId })
      }
    }
  }
  agentSessionTabsByIdCache.set(cacheKey, byId)
  return byId
}

function createUnifiedTerminalLabelIndex(
  entries: AppState['unifiedTabsByWorktree'][string] | undefined
): Map<string, string | undefined> {
  agentStatusPaneRoutingIndexCounters.unifiedLabelIndexBuilds += 1
  const labelsByTabId = new Map<string, string | undefined>()
  for (const entry of entries ?? []) {
    if (entry.contentType !== 'terminal' || labelsByTabId.has(entry.entityId)) {
      continue
    }
    const rawLabel = entry.label?.trim()
    labelsByTabId.set(entry.entityId, rawLabel && rawLabel.length > 0 ? rawLabel : undefined)
  }
  return labelsByTabId
}

function getIndexedTabs(
  tabsByWorktree: AppState['tabsByWorktree']
): Map<string, IndexedAgentStatusTab> {
  const cached = tabsByIdCache.get(tabsByWorktree)
  if (cached) {
    return cached
  }
  agentStatusPaneRoutingIndexCounters.tabIndexBuilds += 1
  const tabsById = new Map<string, IndexedAgentStatusTab>()
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    for (const tab of tabs) {
      agentStatusPaneRoutingIndexCounters.tabVisits += 1
      // Read the id once: retained selectors assert one read per row, and it is a getter on some snapshots.
      const tabId = tab.id
      // First wins: the standalone resolver stops at the first worktree owning this tab id.
      if (!tabsById.has(tabId)) {
        tabsById.set(tabId, { title: tab.title, owningWorktreeId: worktreeId })
      }
    }
  }
  tabsByIdCache.set(tabsByWorktree, tabsById)
  return tabsById
}

function getUnifiedLabelIndex(
  unifiedTabsByWorktree: AppState['unifiedTabsByWorktree']
): Map<string, Map<string, string | undefined>> {
  const cacheKey = unifiedTabsByWorktree ?? NO_UNIFIED_TABS
  const cached = unifiedLabelIndexCache.get(cacheKey)
  if (cached) {
    return cached
  }
  const labelsByWorktreeId = new Map<string, Map<string, string | undefined>>()
  unifiedLabelIndexCache.set(cacheKey, labelsByWorktreeId)
  return labelsByWorktreeId
}

function resolveUnifiedLabel(
  index: AgentStatusPaneRoutingIndex,
  worktreeId: string,
  tabId: string
): string | undefined {
  let labelsByTabId = index.unifiedLabelsByWorktreeId.get(worktreeId)
  if (!labelsByTabId) {
    labelsByTabId = createUnifiedTerminalLabelIndex(index.unifiedTabsByWorktree?.[worktreeId])
    index.unifiedLabelsByWorktreeId.set(worktreeId, labelsByTabId)
  }
  return labelsByTabId.get(tabId)
}

/**
 * Ownership index for agent-status routing, memoized on the identity of the slices it reads.
 * A status commit replaces none of them, so a dense burst reuses one index instead of rebuilding
 * a per-worktree tab and label map for every event.
 */
export function createAgentStatusPaneRoutingIndex(store: AppState): AgentStatusPaneRoutingIndex {
  const worktreesById = getWorktreeMapFromState(store)
  const reposById = getRepoMapFromState(store)
  const cached = routingIndexCache.get(store.tabsByWorktree)
  if (
    cached &&
    cached.unifiedTabsByWorktree === store.unifiedTabsByWorktree &&
    cached.layoutsByTabId === store.terminalLayoutsByTabId &&
    cached.worktreesById === worktreesById &&
    cached.reposById === reposById
  ) {
    return cached
  }
  agentStatusPaneRoutingIndexCounters.indexBuilds += 1
  const index: AgentStatusPaneRoutingIndex = {
    tabsById: getIndexedTabs(store.tabsByWorktree),
    agentSessionTabsById: getIndexedAgentSessionTabs(store.unifiedTabsByWorktree),
    unifiedTabsByWorktree: store.unifiedTabsByWorktree,
    unifiedLabelsByWorktreeId: getUnifiedLabelIndex(store.unifiedTabsByWorktree),
    layoutsByTabId: store.terminalLayoutsByTabId,
    leafIdsByRoot,
    worktreesById,
    reposById
  }
  routingIndexCache.set(store.tabsByWorktree, index)
  return index
}

export function resolveWorktreeConnectionFromRoutingIndex(
  index: AgentStatusPaneRoutingIndex,
  worktreeId: string
): AgentStatusWorktreeConnectionResolution {
  const worktree = index.worktreesById.get(worktreeId)
  if (!worktree) {
    return { worktreeExists: false, repoConnectionId: null, repoConnectionResolved: false }
  }
  const repo = index.reposById.get(worktree.repoId)
  return {
    worktreeExists: true,
    repoConnectionId: repo?.connectionId ?? null,
    repoConnectionResolved: repo !== undefined
  }
}

export function resolvePaneKeyFromRoutingIndex(
  index: AgentStatusPaneRoutingIndex,
  paneKey: string
): AgentStatusPaneResolution {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return {
      exists: false,
      title: undefined,
      identityTitle: undefined,
      repoConnectionId: null,
      repoConnectionResolved: false,
      owningWorktreeId: undefined,
      titleUsesTabTitle: false,
      tabTitle: undefined
    }
  }
  const { tabId, leafId } = parsed
  const tab = index.tabsById.get(tabId)
  if (!tab) {
    // A structured (native chat) pane key has no `tabsByWorktree` entry — that map is PTY
    // terminals only — but it does have a real tab in `unifiedTabsByWorktree`. Host-published
    // structured rows carry no tab label (see StructuredAgentSessionStatusBridge.tsx), so title
    // resolution stays undefined here; the tab's own label is what the sidebar renders directly.
    const agentSessionTab = index.agentSessionTabsById.get(tabId)
    if (agentSessionTab) {
      const agentSessionConnection = resolveWorktreeConnectionFromRoutingIndex(
        index,
        agentSessionTab.owningWorktreeId
      )
      return {
        exists: true,
        title: undefined,
        identityTitle: undefined,
        repoConnectionId: agentSessionConnection.repoConnectionId,
        repoConnectionResolved: agentSessionConnection.repoConnectionResolved,
        owningWorktreeId: agentSessionTab.owningWorktreeId,
        titleUsesTabTitle: false,
        tabTitle: undefined
      }
    }
    return {
      exists: false,
      title: undefined,
      identityTitle: undefined,
      repoConnectionId: null,
      repoConnectionResolved: false,
      owningWorktreeId: undefined,
      titleUsesTabTitle: false,
      tabTitle: undefined
    }
  }
  const connection = resolveWorktreeConnectionFromRoutingIndex(index, tab.owningWorktreeId)
  const layout = index.layoutsByTabId?.[tabId]
  if (layout?.root) {
    let leafIds = index.leafIdsByRoot.get(layout.root)
    if (!leafIds) {
      agentStatusPaneRoutingIndexCounters.leafSetBuilds += 1
      leafIds = new Set(collectLeafIdsInOrder(layout.root))
      index.leafIdsByRoot.set(layout.root, leafIds)
    }
    if (!leafIds.has(leafId)) {
      return {
        exists: false,
        title: undefined,
        identityTitle: undefined,
        repoConnectionId: connection.repoConnectionId,
        repoConnectionResolved: connection.repoConnectionResolved,
        owningWorktreeId: tab.owningWorktreeId,
        titleUsesTabTitle: false,
        tabTitle: undefined
      }
    }
  }
  const rawPaneTitle = layout?.titlesByLeafId?.[leafId]
  const paneTitle = rawPaneTitle && rawPaneTitle.length > 0 ? rawPaneTitle : undefined
  return {
    exists: true,
    title: paneTitle ?? tab.title,
    identityTitle:
      paneTitle ?? resolveUnifiedLabel(index, tab.owningWorktreeId, tabId) ?? tab.title,
    repoConnectionId: connection.repoConnectionId,
    repoConnectionResolved: connection.repoConnectionResolved,
    owningWorktreeId: tab.owningWorktreeId,
    titleUsesTabTitle: paneTitle === undefined,
    tabTitle: tab.title
  }
}
