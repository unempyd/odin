import { describe, expect, it } from 'vitest'
import { reconcileLegacyWorkerCandidate } from './runtime-legacy-worker-terminal-recovery-candidate'
import type {
  LegacyWorkerRecoveryCandidate,
  LegacyWorkerRecoveryResolution
} from './runtime-legacy-worker-terminal-recovery-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'

const CANDIDATE = {
  dispatchId: 'ctx-1',
  dispatchStatus: 'dispatched',
  contractVersion: 1,
  taskId: 'task-1',
  worktreeId: 'wt-1',
  terminalHandle: 'term_worker',
  paneKey: 'tab_worker:leaf_worker',
  tabId: 'tab_worker',
  leafId: 'leaf_worker',
  processIncarnation: 'pty-worker:1',
  ptyId: 'pty-worker',
  incarnationId: '1'
} as unknown as LegacyWorkerRecoveryCandidate

/**
 * A ptyId absent from the controller's inventory is silence, not a death
 * certificate -- the same absence shape residual B closed for worker
 * liveness. The dispatch still has to resolve so orchestration can move
 * on, but the word recorded (and the one `runLegacyWorkerTerminalRecovery`
 * sends the renderer) must not claim a proven exit.
 */
describe('reconcileLegacyWorkerCandidate: absence from the live inventory', () => {
  it('resolves unverifiable, not exited, when the ptyId is missing from inventory.livePtyIds', async () => {
    const pendingResolutions: LegacyWorkerRecoveryResolution[] = []

    await reconcileLegacyWorkerCandidate({
      controller: {} as never,
      ports: {} as never,
      options: {},
      candidate: CANDIDATE,
      workspace: {} as never,
      resolvedWorktrees: [],
      inventory: {
        livePtyIds: new Set<string>(),
        allLivePtyIds: new Set<string>(),
        terminalIdentityByPtyId: new Map(),
        queriedHostIds: new Set<ExecutionHostId>([LOCAL_EXECUTION_HOST_ID])
      },
      deferredDispatchIds: new Set(),
      pendingResolutions
    })

    expect(pendingResolutions).toEqual([{ candidate: CANDIDATE, resolution: 'unverifiable' }])
  })
})
