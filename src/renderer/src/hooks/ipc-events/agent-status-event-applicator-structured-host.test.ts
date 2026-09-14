// Increment A's actual seam: a structured row now reaches the renderer over `agentStatus:set`
// (main no longer filters it — see main-window-structured-status-filter.test.ts and
// agent-hooks.test.ts). This proves the applicator can actually apply one: a structured pane key
// has no `tabsByWorktree` entry, so without the routing-index fallback in
// agent-status-pane-routing-index.ts this event would be queued as unattributed forever instead
// of ever reaching the store.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import {
  createTestStore,
  makeUnifiedTab,
  makeWorktree,
  TEST_REPO
} from '../../store/slices/store-test-helpers'

const SESSION_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const TAB_ID = `structured-agent-session-${SESSION_ID}`
const PANE_KEY = structuredAgentSessionPaneKey(TAB_ID, SESSION_ID)
const WORKTREE_ID = 'wt-1'

vi.mock('../agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn(),
  syncAgentHookCompletionNotificationsForStoreUpdate: vi.fn()
}))

function structuredEvent(over: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    tabId: TAB_ID,
    worktreeId: WORKTREE_ID,
    connectionId: null,
    receivedAt: 1_700_000_000_000,
    stateStartedAt: 1_700_000_000_000,
    structuredHost: 'owned',
    state: 'working',
    prompt: 'ship it',
    agentType: 'codex',
    sessionBoundary: false,
    ...over
  } as AgentStatusIpcPayload
}

describe('agentStatus:set applying a structured (native chat) row', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(async () => {
    vi.resetModules()
    store = createTestStore()
    store.setState({
      workspaceSessionReady: true,
      repos: [TEST_REPO],
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id: WORKTREE_ID, repoId: TEST_REPO.id })]
      },
      tabsByWorktree: {},
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [
          makeUnifiedTab({
            id: TAB_ID,
            entityId: SESSION_ID,
            worktreeId: WORKTREE_ID,
            groupId: 'group-1',
            contentType: 'agent-session',
            label: 'Codex Chat',
            agentSessionAgent: 'codex'
          })
        ]
      },
      terminalLayoutsByTabId: {}
    })
    vi.doMock('../../store', () => ({ useAppStore: store }))
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('applies immediately instead of queueing as unattributed', async () => {
    const { createAgentStatusEventApplicator } = await import('./agent-status-event-applicator')
    const pendingAgentStatusEvents: never[] = []
    const enqueuePendingAgentStatus = vi.fn()
    const applyAgentStatus = createAgentStatusEventApplicator({
      pendingAgentStatusEvents,
      transientClearWatermarkByConnectionId: new Map(),
      enqueuePendingAgentStatus
    })

    const result = applyAgentStatus(structuredEvent())

    expect(result).toBe('applied')
    expect(enqueuePendingAgentStatus).not.toHaveBeenCalled()
    const entry = store.getState().agentStatusByPaneKey[PANE_KEY]
    expect(entry).toBeDefined()
    expect(entry?.state).toBe('working')
    expect(entry?.structuredHostOwned).toBe(true)
    expect(entry?.terminalResumeEligible).toBe(false)
  })

  it('maps a held (non-owning) host to no structuredHostOwned flag, still resume-ineligible', async () => {
    const { createAgentStatusEventApplicator } = await import('./agent-status-event-applicator')
    const applyAgentStatus = createAgentStatusEventApplicator({
      pendingAgentStatusEvents: [],
      transientClearWatermarkByConnectionId: new Map(),
      enqueuePendingAgentStatus: vi.fn()
    })

    applyAgentStatus(structuredEvent({ structuredHost: 'held' }))

    const entry = store.getState().agentStatusByPaneKey[PANE_KEY]
    expect(entry?.structuredHostOwned).toBeUndefined()
    expect(entry?.terminalResumeEligible).toBe(false)
  })
})
