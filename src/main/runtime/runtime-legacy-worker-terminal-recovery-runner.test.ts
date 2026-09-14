import { describe, expect, it, vi } from 'vitest'
import { RuntimeLegacyWorkerTerminalRecoveryController } from './runtime-legacy-worker-terminal-recovery-controller'
import type { LegacyWorkerTerminalRecoveryCandidate } from './orchestration/orchestration-legacy-worker-terminal-recovery'
import type {
  LegacyWorkerRecoveryPorts,
  LegacyWorkerRecoveryResolution,
  LegacyWorkerRecoveryWorkspace
} from './runtime-legacy-worker-terminal-recovery-types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'

const CANDIDATE: LegacyWorkerTerminalRecoveryCandidate = {
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
}

const RESOLVED_WORKTREE = { id: 'wt-1' } as unknown as ResolvedWorktree
const WORKSPACE: LegacyWorkerRecoveryWorkspace = {
  scope: { id: 'wt-1', path: '/tmp/wt-1', connectionId: null, repo: null, folderWorkspace: null },
  resolved: RESOLVED_WORKTREE
}

// Residual L: the recovery engine both `orca serve`/orcad (headless) and the desktop renderer
// call is the same one, and it has no direct unit test of its own -- every existing spec drives
// it through the full OrcaRuntimeService with materializeRenderer: true. This exercises it with a
// fake PTY provider and no renderer, proving a Dispatch whose terminal is gone still gets failed
// without ever touching a renderer-only port (adopt/reveal/getRendererEpoch).
describe('runLegacyWorkerTerminalRecovery without a renderer (residual L)', () => {
  function createPorts(
    overrides: Partial<LegacyWorkerRecoveryPorts> = {}
  ): LegacyWorkerRecoveryPorts {
    return {
      preparePlan: () => ({ candidates: [CANDIDATE], ambiguousDispatchIds: [] }),
      resolveWorkspace: vi.fn(async () => WORKSPACE),
      refreshInventory: vi.fn(async () => ({
        livePtyIds: new Set<string>(),
        allLivePtyIds: new Set<string>(),
        terminalIdentityByPtyId: new Map(),
        queriedHostIds: new Set<ExecutionHostId>([LOCAL_EXECUTION_HOST_ID])
      })),
      runMutation: vi.fn(async (_worktreeId, operation) => operation()),
      getActivation: vi.fn(() => ({})),
      hasExactPersistedSurface: vi.fn(() => false),
      hasExactSurface: vi.fn(() => false),
      adopt: vi.fn(async () => undefined),
      getRendererEpoch: vi.fn(() => 0),
      reveal: vi.fn(async () => true),
      onPtyExit: vi.fn(),
      persist: vi.fn(
        async (resolutions: readonly LegacyWorkerRecoveryResolution[]) =>
          new Set(resolutions.map((r) => r.candidate.dispatchId))
      ),
      rollback: vi.fn(),
      reconcileMissing: vi.fn(() => true),
      notifyResolution: vi.fn(),
      canRecoverPersistentLocalPtys: () => true,
      reconcileRequestedReleases: vi.fn(async () => undefined),
      reconcile: vi.fn(),
      updateRetry: vi.fn(),
      ...overrides
    }
  }

  it('fails a Dispatch whose PTY is no longer in the live inventory, headless (no materializeRenderer)', async () => {
    const ports = createPorts()
    const controller = new RuntimeLegacyWorkerTerminalRecoveryController(ports)

    const result = await controller.reconcile({})

    expect(result.exitedDispatchIds).toEqual(['ctx-1'])
    expect(result.deferredDispatchIds).toEqual([])
    expect(ports.reconcileMissing).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchId: 'ctx-1' })
    )
    // Why these three: they only ever run to materialize a renderer tab, which headless
    // recovery must never need to fail or abandon a gone Dispatch.
    expect(ports.adopt).not.toHaveBeenCalled()
    expect(ports.reveal).not.toHaveBeenCalled()
    expect(ports.getRendererEpoch).not.toHaveBeenCalled()
  })

  it('adopts a live Dispatch headless too, without revealing it', async () => {
    const ports = createPorts({
      refreshInventory: vi.fn(async () => ({
        livePtyIds: new Set([CANDIDATE.ptyId]),
        allLivePtyIds: new Set([CANDIDATE.ptyId]),
        terminalIdentityByPtyId: new Map([
          [
            CANDIDATE.ptyId,
            { handle: CANDIDATE.terminalHandle, incarnationId: CANDIDATE.incarnationId }
          ]
        ]),
        queriedHostIds: new Set<ExecutionHostId>([LOCAL_EXECUTION_HOST_ID])
      }))
    })
    const controller = new RuntimeLegacyWorkerTerminalRecoveryController(ports)

    const result = await controller.reconcile({})

    expect(result.adoptedDispatchIds).toEqual(['ctx-1'])
    expect(ports.adopt).toHaveBeenCalled()
    expect(ports.reveal).not.toHaveBeenCalled()
  })
})
