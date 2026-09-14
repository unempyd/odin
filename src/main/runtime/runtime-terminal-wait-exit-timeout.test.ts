import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalIdlePolls } from './runtime-terminal-idle-polls'
import { RuntimeTerminalWait } from './runtime-terminal-wait'
import { RuntimeTerminalWaiterRegistry } from './runtime-terminal-waiter-registry'
import { errorMessage, makeTuiIdleLeaf, makeTuiIdlePty } from './tui-idle-wait-test-harness'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

/**
 * `docs/reference/ssh-execution-boundary.md`'s contract: an exit wait never settles on
 * silence, and a wait that runs out of budget with no proven exit is exactly silence — an
 * `Error('timeout')` rejection is an opaque failure, not that verdict (odin/proofs/
 * ssh-boundary.md's `terminal.wait --for exit` note: the SSH proof's loss-of-contact
 * phases could not read a verdict from the rejection).
 */

const HANDLE = 'terminal-1'

function createWait(options: { pty?: RuntimePtyWorktreeRecord; leaf?: RuntimeLeafRecord }) {
  const waiters = new RuntimeTerminalWaiterRegistry()
  const shared = {
    getTabTitle: () => null,
    getAdoptedPtyIdleStatus: () => null,
    getPaneAgent: () => null,
    getFirstPartyAgentStatus: () => null,
    quiescenceMs: 3000
  }
  const polls = new RuntimeTerminalIdlePolls({
    ...shared,
    intervalMs: 2000,
    getForegroundProcess: () => Promise.resolve(null),
    getLiveLeaf: (leaf) => leaf,
    resolve: (waiter, result) => waiters.resolve(waiter, result)
  })
  const wait = new RuntimeTerminalWait(
    {
      ...shared,
      defaultTimeoutMs: 60_000,
      getLivePty: () => (options.pty ? { pty: options.pty } : null),
      getLiveLeaf: () => ({ leaf: options.leaf ?? makeTuiIdleLeaf() }),
      startVisibleReadProbe: vi.fn()
    },
    waiters,
    polls
  )
  return { wait, waiters }
}

function watch(promise: Promise<unknown>) {
  const settled = vi.fn()
  void promise.then(
    (value) => settled({ ok: value }),
    (error) => settled({ error: errorMessage(error) })
  )
  return settled
}

describe('RuntimeTerminalWait exit-condition timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves the silence verdict instead of rejecting when a PTY exit wait times out', async () => {
    const pty = makeTuiIdlePty({ connected: true })
    const { wait } = createWait({ pty })

    const settled = watch(wait.wait(HANDLE, { condition: 'exit', timeoutMs: 1000 }))
    await vi.advanceTimersByTimeAsync(1000)

    expect(settled).toHaveBeenCalledExactlyOnceWith({
      ok: {
        handle: HANDLE,
        condition: 'exit',
        satisfied: false,
        status: 'running',
        exitCode: null,
        evidence: 'silence'
      }
    })
  })

  it('resolves the silence verdict instead of rejecting when a leaf exit wait times out', async () => {
    const leaf = makeTuiIdleLeaf({ connected: true })
    const { wait } = createWait({ leaf })

    const settled = watch(wait.wait(HANDLE, { condition: 'exit', timeoutMs: 1000 }))
    await vi.advanceTimersByTimeAsync(1000)

    expect(settled).toHaveBeenCalledExactlyOnceWith({
      ok: {
        handle: HANDLE,
        condition: 'exit',
        satisfied: false,
        status: 'running',
        exitCode: null,
        evidence: 'silence'
      }
    })
  })

  it('still rejects a tui-idle wait on timeout (unchanged contract)', async () => {
    const pty = makeTuiIdlePty({ connected: true, lastOutputAt: Date.now() })
    const { wait } = createWait({ pty })

    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 1000 }))
    await vi.advanceTimersByTimeAsync(1000)

    expect(settled).toHaveBeenCalledExactlyOnceWith({ error: 'timeout' })
  })
})
