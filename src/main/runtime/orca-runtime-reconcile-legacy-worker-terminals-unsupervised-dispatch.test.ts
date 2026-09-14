import { afterEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'

// Residual M: reconcileUnsupervisedDispatchesOnRestart (orchestration-unsupervised-dispatch-
// recovery.ts) correctly settles an injected/context-only Dispatch whose terminal is gone, but
// had no production caller -- orca serve, orcad, and the desktop renderer-startup path all only
// ever ran the supervised sweep (legacyWorkerRecovery.reconcile), which never sees a Dispatch
// with no worker_dispatches row. This is the runtime-level proof that
// reconcileLegacyWorkerTerminals() -- the one method every one of those callers shares -- now
// also fails such a Dispatch. Before the fix this dispatch is left dispatched forever.
describe('reconcileLegacyWorkerTerminals wires unsupervised dispatch recovery (residual M)', () => {
  let runtime: OrcaRuntimeService | undefined
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createInjectedDispatch(d: OrchestrationDb) {
    const task = d.createTask({ runId: 'run_legacy_local', spec: 'injected work' })
    return d.createDispatchContext({
      taskId: task.id,
      // Why a handle nothing ever created: a bare runtime has no PTY provider, so showTerminal
      // resolves this to "not found" -- an owner-proven absence, not loss of contact.
      assigneeHandle: 'term_never_created',
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
  }

  it('fails an injected dispatch whose terminal is gone after the supervised sweep runs', async () => {
    runtime = new OrcaRuntimeService()
    db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const dispatch = createInjectedDispatch(db)

    await runtime.reconcileLegacyWorkerTerminals()

    const after = db.getDispatchContextById(dispatch.id)
    expect(after?.status).toBe('failed')
  })
})
