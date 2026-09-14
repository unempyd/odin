// Main is now the only writer of a structured row's pane key (the renderer's own feed bridge no
// longer writes it — see StructuredAgentSessionStatusBridge.tsx). So a structured row must reach
// the renderer over `agentStatus:set` exactly like any hook row; this used to be the seam where
// the window listener dropped it (see git history), which is what this test now inverts.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server'

const hooks = vi.hoisted(() => ({
  listener: null as ((payload: EnrichedAgentHookEventPayload) => void) | null
}))

vi.mock('electron', () => ({
  app: { getPath: () => '', on: vi.fn(), isReady: () => true }
}))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    setListener: (listener: ((payload: EnrichedAgentHookEventPayload) => void) | null) => {
      hooks.listener = listener
    },
    setPaneStatusClearListener: vi.fn()
  }
}))
vi.mock('../agent-hooks/migration-unsupported-pty-state', () => ({
  setMigrationUnsupportedPtyListener: vi.fn()
}))
vi.mock('../window/dashboard-popout-window', () => ({
  getDashboardPopoutWindow: () => null
}))
vi.mock('./synthetic-title-runtime', () => ({
  driveSyntheticTitleFromHook: vi.fn(),
  shouldSuppressCodexAutoApprovalSyntheticTitleFromHook: () => false,
  stopAllSyntheticTitleSpinners: vi.fn()
}))

import { installMainWindowAgentStatusListeners } from './main-window-agent-status'
import { mainProcessState } from './main-process-state'

const sent: { channel: string; event: { paneKey: string } }[] = []

function statusPayload(
  over: Partial<EnrichedAgentHookEventPayload>
): EnrichedAgentHookEventPayload {
  return {
    paneKey: 'pane-1',
    tabId: 'tab-1',
    worktreeId: 'repo::/wt',
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    payload: { state: 'working', prompt: 'ship it', agentType: 'codex' },
    ...over
  } as EnrichedAgentHookEventPayload
}

beforeEach(() => {
  sent.length = 0
  hooks.listener = null
  mainProcessState.runtime = null
  mainProcessState.mainWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, event: { paneKey: string }) => sent.push({ channel, event })
    }
  } as unknown as typeof mainProcessState.mainWindow
  installMainWindowAgentStatusListeners({
    window: mainProcessState.mainWindow!,
    maybeAutoRenameBranchOnFirstWork: vi.fn(),
    onRecordAgentState: vi.fn()
  })
})

describe('the main-window agent-status listener', () => {
  it('forwards both a hook row and a structured one', () => {
    expect(hooks.listener).not.toBeNull()

    hooks.listener!(statusPayload({ paneKey: 'hook-pane' }))
    hooks.listener!(
      statusPayload({
        paneKey: 'structured-agent-session-s1:leaf',
        structuredHost: 'owned'
      })
    )

    expect(sent.map((entry) => `${entry.channel}:${entry.event.paneKey}`)).toEqual([
      'agentStatus:set:hook-pane',
      'agentStatus:set:structured-agent-session-s1:leaf'
    ])
  })

  it('carries structuredHost on the forwarded event', () => {
    hooks.listener!(
      statusPayload({
        paneKey: 'structured-agent-session-s1:leaf',
        structuredHost: 'owned'
      })
    )

    expect(sent[0]?.event).toMatchObject({ structuredHost: 'owned' })
  })
})
