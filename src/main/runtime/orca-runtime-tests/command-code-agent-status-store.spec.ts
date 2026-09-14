// status-D: command-code working/done status is produced by main and ingested
// straight into the hook server, mirroring the OSC path — the renderer no
// longer seeds or settles it for a main-authority pane.
import { describe, expect, it, vi } from 'vitest'
import { makeAgentStatusStoreWiring } from '../agent-status-store-wiring.test-fixture'
import { store, TEST_WORKTREE_ID } from '../orca-runtime-test-fixtures.spec'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

function createWiredRuntime(): {
  runtime: InstanceType<typeof OrcaRuntimeService>
  statusStore: ReturnType<typeof makeAgentStatusStoreWiring>['statusStore']
} {
  const statusWiring = makeAgentStatusStoreWiring()
  const runtime = new OrcaRuntimeService(store, undefined, {
    onTerminalAgentStatus: statusWiring.deps.onTerminalAgentStatus,
    // Why required: the command-code detector is only instantiated per PTY
    // while `terminalSideEffectConsumerAvailable` is true, which needs a
    // local side-effect consumer (or a remote client listener) in addition to
    // an attached window — a real desktop window always has one.
    onTerminalSideEffects: () => {}
  })
  return { runtime, statusStore: statusWiring.statusStore }
}

function syncPty(runtime: InstanceType<typeof OrcaRuntimeService>): void {
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: TEST_WORKTREE_ID,
        title: 'Command Code',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: TEST_WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: 'pty-1'
      }
    ]
  })
}

describe('command-code status is produced by main', () => {
  it('ingests working immediately, then done only after the 1500ms settle — two distinct rows', () => {
    vi.useFakeTimers()
    try {
      const { runtime, statusStore } = createWiredRuntime()
      syncPty(runtime)

      runtime.onPtyData('pty-1', '# Command Code v0.27.3\r\n', 100)
      runtime.onPtyData('pty-1', '❯ say hi\r\n✻ Thinking...', 101)

      const workingRow = statusStore.getStatusSnapshotForPane(PANE_KEY)[0]
      expect(workingRow).toMatchObject({
        state: 'working',
        prompt: 'say hi',
        agentType: 'command-code'
      })
      const workingStateStartedAt = workingRow?.stateStartedAt

      runtime.onPtyData(
        'pty-1',
        '\r\n✻ Thought for 1 second\r\n:: Hi!\r\n❯ Ask your question...',
        102
      )

      // Why 1499ms: the done fact is a hint — the row must still read working
      // right up to the settle deadline.
      vi.advanceTimersByTime(1499)
      expect(statusStore.getStatusSnapshotForPane(PANE_KEY)[0]).toMatchObject({ state: 'working' })

      vi.advanceTimersByTime(1)
      const doneRow = statusStore.getStatusSnapshotForPane(PANE_KEY)[0]
      expect(doneRow).toMatchObject({ state: 'done', prompt: 'say hi', agentType: 'command-code' })
      // Why distinct: a real state transition stamps a fresh stateStartedAt —
      // this is the "two rows" the working/done pair must produce, not one
      // row silently mutated in place.
      expect(doneRow?.stateStartedAt).not.toBe(workingStateStartedAt)
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: park unmounts the renderer's TerminalPane, but main's detector and its
  // settle timer live entirely in main — a renderer park/reveal cycle touches
  // no main state, so nothing here can strand the row at 'working'. Simulated
  // by simply doing nothing renderer-side between scheduling and the deadline.
  it('completes the turn on schedule even though the pane could be parked in the renderer meanwhile', () => {
    vi.useFakeTimers()
    try {
      const { runtime, statusStore } = createWiredRuntime()
      syncPty(runtime)

      runtime.onPtyData('pty-1', '# Command Code v0.27.3\r\n', 100)
      runtime.onPtyData('pty-1', '❯ Fix the spinner\r\n✻ Thinking...', 101)
      runtime.onPtyData('pty-1', '\r\n❯ Ask your question...', 102)

      vi.advanceTimersByTime(1500)

      expect(statusStore.getStatusSnapshotForPane(PANE_KEY)[0]).toMatchObject({
        state: 'done',
        prompt: 'Fix the spinner',
        agentType: 'command-code'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the pending done when a fresh working repaint arrives first', () => {
    vi.useFakeTimers()
    try {
      const { runtime, statusStore } = createWiredRuntime()
      syncPty(runtime)

      runtime.onPtyData('pty-1', '# Command Code v0.27.3\r\n', 100)
      runtime.onPtyData('pty-1', '❯ Run a slow command\r\n✻ Thinking...', 101)
      runtime.onPtyData('pty-1', '\r\n❯ Ask your question...\r\n', 102)
      vi.advanceTimersByTime(1000)
      runtime.onPtyData('pty-1', '❯ Run a slow command\r\n✻ Thinking...', 103)
      vi.advanceTimersByTime(2000)

      expect(statusStore.getStatusSnapshotForPane(PANE_KEY)[0]).toMatchObject({
        state: 'working',
        prompt: 'Run a slow command',
        agentType: 'command-code'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not ingest command-code status when the local kill switch is off', () => {
    vi.useFakeTimers()
    try {
      const statusWiring = makeAgentStatusStoreWiring()
      const runtime = new OrcaRuntimeService(
        {
          ...store,
          getSettings: () => ({ ...store.getSettings(), terminalMainSideEffectAuthority: false })
        },
        undefined,
        {
          onTerminalAgentStatus: statusWiring.deps.onTerminalAgentStatus,
          onTerminalSideEffects: () => {}
        }
      )
      syncPty(runtime)

      runtime.onPtyData('pty-1', '# Command Code v0.27.3\r\n', 100)
      runtime.onPtyData('pty-1', '❯ Fix the spinner\r\n✻ Thinking...', 101)
      vi.advanceTimersByTime(2000)

      expect(statusWiring.statusStore.getStatusSnapshotForPane(PANE_KEY)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
