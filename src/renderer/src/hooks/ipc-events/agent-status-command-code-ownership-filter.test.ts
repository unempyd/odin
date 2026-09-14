import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'

vi.mock('../agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn(),
  syncAgentHookCompletionNotificationsForStoreUpdate: vi.fn()
}))

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const WORKTREE_ID = 'repo-1::/wt-1'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

type MockStore = Record<string, unknown>

function buildStore(overrides: MockStore = {}): MockStore {
  return {
    workspaceSessionReady: true,
    tabsByWorktree: {
      [WORKTREE_ID]: [
        { id: TAB_ID, ptyId: `pty-${TAB_ID}`, worktreeId: WORKTREE_ID, title: 'shell' }
      ]
    },
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null
      }
    },
    worktreesByRepo: { repo1: [{ id: WORKTREE_ID, repoId: 'repo1', path: '/tmp/wt-1' }] },
    repos: [{ id: 'repo1', connectionId: null }],
    agentStatusByPaneKey: {},
    paneForegroundAgentByPaneKey: {},
    retainedAgentsByPaneKey: {},
    agentLaunchConfigByPaneKey: {},
    recentlyClosedAgentStatusTabIds: {},
    recentlyRetiredAgentStatusPaneKeys: {},
    setAgentStatus: vi.fn(),
    ...overrides
  }
}

function buildPayload(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    state: 'working',
    prompt: 'Fix the spinner',
    agentType: 'command-code',
    receivedAt: 1_700_000_000_000,
    stateStartedAt: 1_700_000_000_000,
    ...overrides
  } as AgentStatusIpcPayload
}

describe('command-code ownership drop filter (agentStatus:set)', () => {
  let store: MockStore

  beforeEach(() => {
    vi.resetModules()
    store = buildStore()
    vi.doMock('../../store', () => ({
      useAppStore: { getState: () => store }
    }))
  })

  afterEach(() => {
    vi.doUnmock('../../store')
  })

  async function applyStatus(payload: AgentStatusIpcPayload): Promise<string> {
    const { createAgentStatusEventApplicator } = await import('./agent-status-event-applicator')
    const applyAgentStatus = createAgentStatusEventApplicator({
      pendingAgentStatusEvents: [],
      transientClearWatermarkByConnectionId: new Map(),
      enqueuePendingAgentStatus: vi.fn()
    })
    return applyAgentStatus(payload)
  }

  it('applies a command-code row when nothing else owns the pane', async () => {
    const result = await applyStatus(buildPayload())

    expect(result).toBe('applied')
    expect(store.setAgentStatus).toHaveBeenCalled()
    expect((store.setAgentStatus as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(PANE_KEY)
    expect((store.setAgentStatus as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
      agentType: 'command-code'
    })
  })

  it('drops a command-code row when the foreground agent is a different agent', async () => {
    store.paneForegroundAgentByPaneKey = {
      [PANE_KEY]: { agent: 'claude', shellForeground: false }
    }

    const result = await applyStatus(buildPayload())

    expect(result).toBe('dropped')
    expect(store.setAgentStatus).not.toHaveBeenCalled()
  })

  it('drops a command-code row when a retained agent owns the pane', async () => {
    store.retainedAgentsByPaneKey = { [PANE_KEY]: { agentType: 'claude' } }

    const result = await applyStatus(buildPayload())

    expect(result).toBe('dropped')
    expect(store.setAgentStatus).not.toHaveBeenCalled()
  })

  it('drops a command-code row when the tab was launched as a different agent', async () => {
    store.tabsByWorktree = {
      [WORKTREE_ID]: [
        { id: TAB_ID, ptyId: `pty-${TAB_ID}`, worktreeId: WORKTREE_ID, launchAgent: 'claude' }
      ]
    }

    const result = await applyStatus(buildPayload())

    expect(result).toBe('dropped')
    expect(store.setAgentStatus).not.toHaveBeenCalled()
  })

  it('does not filter non-command-code rows', async () => {
    store.paneForegroundAgentByPaneKey = {
      [PANE_KEY]: { agent: 'claude', shellForeground: false }
    }

    const result = await applyStatus(buildPayload({ agentType: 'claude' }))

    expect(result).toBe('applied')
    expect(store.setAgentStatus).toHaveBeenCalled()
  })
})
