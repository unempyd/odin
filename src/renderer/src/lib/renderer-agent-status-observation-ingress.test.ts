import { describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { AgentStatusObservation } from '../../../shared/agent-status-observation'
import { buildWorktreeAgentRows } from '@/components/sidebar/worktree-agent-rows'
import { TITLE_DERIVED_AGENT_ROW_AUTHORITY_ID } from '@/components/sidebar/worktree-title-derived-agent-rows'

const { setAgentStatusMock } = vi.hoisted(() => ({ setAgentStatusMock: vi.fn() }))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ setAgentStatus: setAgentStatusMock }) }
}))
vi.mock('./agent-status-connection-ownership', () => ({
  resolveLiveAgentStatusConnectionRouting: () => ({ connectionId: null })
}))

const LEAF_ID = '77777777-7777-4777-8777-777777777777'

function makeTab(id: string): TerminalTab {
  return {
    id,
    worktreeId: 'wt-1',
    ptyId: null,
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeSingleLayout(): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF_ID },
    activeLeafId: LEAF_ID,
    expandedLeafId: null
  }
}

function titleRowObservation(now: number): AgentStatusObservation {
  const rows = buildWorktreeAgentRows({
    tabs: [makeTab('tab-1')],
    entries: [],
    retained: [],
    runtimePaneTitlesByTabId: { 'tab-1': { 1: '⠋ Codex' } },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    terminalLayoutsByTabId: { 'tab-1': makeSingleLayout() },
    now
  })
  const observation = rows[0]?.entry.observation
  if (!observation) {
    throw new Error('expected a title-derived row carrying an observation')
  }
  return observation
}

describe('renderer-side observation origins', () => {
  it('tags a title-derived row as title-origin, not as a hook row', () => {
    // Why: this is the tag that makes the row's own contradiction findable — the entry it
    // fabricates reports `working` for a pane whose row state is idle.
    expect(titleRowObservation(2_000)).toEqual({
      origin: 'title',
      authorityId: TITLE_DERIVED_AGENT_ROW_AUTHORITY_ID,
      incarnation: 0,
      revision: 2_000,
      observedAt: 2_000,
      kind: 'snapshot'
    })
  })

  it('keeps the title-row stamp deterministic in `now` so re-deriving it does not churn', () => {
    // Why: these rows are recomputed every render; a counter here would mint a new revision
    // per frame and invalidate memoization that compares rows.
    expect(titleRowObservation(2_000)).toEqual(titleRowObservation(2_000))
    expect(titleRowObservation(3_000).revision).toBeGreaterThan(titleRowObservation(2_000).revision)
  })

  // status-C: createBackgroundAgentStatusConsumer writes again, but only for a
  // remote-runtime pty whose host the caller has already probed and found not
  // to advertise OSC-ingest (`writesRemoteAgentStatusFallback`, resolved via
  // hostOwnsRemoteAgentStatus before this consumer is constructed).
  it('tags a remote-runtime OSC write as osc-origin under the renderer authority', async () => {
    setAgentStatusMock.mockReset()
    const { createBackgroundAgentStatusConsumer } =
      await import('./background-agent-status-consumer')
    const paneKey = 'tab-osc:99999999-9999-4999-8999-999999999999'
    const consumer = createBackgroundAgentStatusConsumer({
      paneKey,
      launchToken: 'launch-1',
      expectedConnectionId: null,
      runtimeEnvironmentId: 'env-1',
      // Why true: this pane is remote-runtime and the caller's probe found the
      // host does not advertise OSC-ingest — the pre-status-C legacy write.
      writesRemoteAgentStatusFallback: true,
      getPtyId: () => 'remote:env-1@@terminal-9'
    })

    consumer.consume(`\x1b]9999;{"state":"working","prompt":"remote turn"}\x07`)
    consumer.consume(`\x1b]9999;{"state":"done","prompt":"remote turn"}\x07`)

    expect(setAgentStatusMock).toHaveBeenCalledTimes(2)
    const observations = setAgentStatusMock.mock.calls.map(
      (call) => (call[1] as { observation?: AgentStatusObservation }).observation
    )
    for (const observation of observations) {
      expect(observation).toMatchObject({
        origin: 'osc',
        kind: 'snapshot',
        authorityId: expect.stringMatching(/^renderer:/)
      })
    }
    expect(observations[1]!.revision).toBeGreaterThan(observations[0]!.revision)
  })

  it('never writes when the caller resolved the host as capable (writesRemoteAgentStatusFallback: false)', async () => {
    setAgentStatusMock.mockReset()
    const { createBackgroundAgentStatusConsumer } =
      await import('./background-agent-status-consumer')
    const consumer = createBackgroundAgentStatusConsumer({
      paneKey: 'tab-osc:99999999-9999-4999-8999-999999999999',
      launchToken: 'launch-1',
      expectedConnectionId: null,
      runtimeEnvironmentId: 'env-1',
      writesRemoteAgentStatusFallback: false,
      getPtyId: () => 'remote:env-1@@terminal-9'
    })

    consumer.consume(`\x1b]9999;{"state":"working","prompt":"remote turn"}\x07`)

    expect(setAgentStatusMock).not.toHaveBeenCalled()
  })

  it('never writes for a local pty even if writesRemoteAgentStatusFallback were left on', async () => {
    setAgentStatusMock.mockReset()
    const { createBackgroundAgentStatusConsumer } =
      await import('./background-agent-status-consumer')
    const consumer = createBackgroundAgentStatusConsumer({
      paneKey: 'tab-local:99999999-9999-4999-8999-999999999999',
      launchToken: 'launch-1',
      expectedConnectionId: null,
      runtimeEnvironmentId: null,
      writesRemoteAgentStatusFallback: true,
      getPtyId: () => 'pty-local-1'
    })

    consumer.consume(`\x1b]9999;{"state":"working","prompt":"local turn"}\x07`)

    expect(setAgentStatusMock).not.toHaveBeenCalled()
  })
})
