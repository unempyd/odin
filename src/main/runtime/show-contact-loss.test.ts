// show-contact-loss: buildPtyTerminalSummary/buildTerminalSummary read pty.connected straight off
// the record, which a lost-but-reconnecting SSH relay never touches (only a PTY data/exit event or
// an inventory sweep does). `terminal show` kept answering `connected: true` for the whole
// reconnect window against a real host — docs/reference/ssh-execution-boundary.md,
// odin/proofs/ssh-boundary.2026-09-15T01-39-52-596Z.json phase4.
import { afterEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { setSshTargetRegistryHandlers } from '../ssh/ssh-target-registry'
import type { SshConnectionState, SshConnectionStatus } from '../../shared/ssh-types'

const CONNECTION_ID = 'claw-vps'
const PTY_ID = `ssh:${CONNECTION_ID}@@relay-pty-1`
const WORKTREE_ID = 'repo-show-contact-loss::/root/odin-proof/seed'
const TAB_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const HANDLE = 'term_show_contact_loss'

function createSshBackedRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(null)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.registerPty(PTY_ID, WORKTREE_ID, CONNECTION_ID, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId: 'show-contact-loss-incarnation'
  })
  runtime.registerPreAllocatedHandleForPty(PTY_ID, HANDLE)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Agent',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      { tabId: TAB_ID, worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 1, ptyId: PTY_ID }
    ]
  })
  return runtime
}

// Fakes the ssh-relay-session/ssh-connection-manager registry (`getRegisteredSshState`) that
// `src/main/ipc/ssh-relay-session-callbacks.ts`'s real `onRelayLost`/`onReady` handlers keep
// current — the same state the boundary doc's `[ssh] Relay channel ... lost; reconnect attempt`
// and `Keepalive timeout` log sites drive. Standing in for a real relay session in `reconnecting`.
function mockSshConnectionStatus(status: SshConnectionStatus): void {
  setSshTargetRegistryHandlers({
    connect: null,
    getState: (targetId: string): SshConnectionState | undefined =>
      targetId === CONNECTION_ID
        ? { targetId, status, error: null, reconnectAttempt: status === 'connected' ? 0 : 1 }
        : undefined
  })
}

describe('show-contact-loss: terminal show honesty during SSH transport loss', () => {
  afterEach(() => {
    setSshTargetRegistryHandlers({ connect: null, getState: null })
  })

  it('reports unverifiable, not connected, while the relay is lost and reconnecting', async () => {
    const runtime = createSshBackedRuntime()
    mockSshConnectionStatus('reconnecting')

    const summary = await runtime.showTerminal(HANDLE)

    expect(summary.connected).toBe(false)
    expect(summary.writable).toBe(false)
    expect(summary.exitCause).toBeUndefined()
    expect(summary.liveness).toEqual({ status: 'unverifiable', reason: 'reconnecting' })
  })

  it('never asserts exited while the transport is merely lost (a non-reconnecting status too)', async () => {
    const runtime = createSshBackedRuntime()
    mockSshConnectionStatus('error')

    const summary = await runtime.showTerminal(HANDLE)

    expect(summary.exitCause).toBeUndefined()
    expect(summary.connected).toBe(false)
    expect(summary.liveness).toEqual({ status: 'unverifiable', reason: 'transport_lost' })
  })

  it('returns to live once the target reconnects and re-adopts the PTY', async () => {
    const runtime = createSshBackedRuntime()
    mockSshConnectionStatus('connected')

    const summary = await runtime.showTerminal(HANDLE)

    expect(summary.connected).toBe(true)
    expect(summary.writable).toBe(true)
    expect(summary.liveness).toBeUndefined()
  })

  it('leaves a local terminal unaffected by the SSH registry entirely', async () => {
    const runtime = new OrcaRuntimeService(null)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const localPtyId = 'pty-show-contact-loss-local'
    const localHandle = 'term_show_contact_loss_local'
    runtime.registerPty(localPtyId, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'local-incarnation'
    })
    runtime.registerPreAllocatedHandleForPty(localPtyId, localHandle)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Local',
          activeLeafId: LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          leafId: LEAF_ID,
          paneRuntimeId: 1,
          ptyId: localPtyId
        }
      ]
    })

    const summary = await runtime.showTerminal(localHandle)

    expect(summary.connected).toBe(true)
    expect(summary.liveness).toBeUndefined()
  })

  it('never overrides a genuine owner-proven exit, even while the registry also reads reconnecting', async () => {
    const runtime = createSshBackedRuntime()
    runtime.onPtyExit(PTY_ID, 0, undefined, { cause: { kind: 'signaled', signal: 9 } })
    mockSshConnectionStatus('reconnecting')

    const summary = await runtime.showTerminal(HANDLE)

    expect(summary.connected).toBe(false)
    expect(summary.exitCause).toEqual({ kind: 'signaled', signal: 9 })
    expect(summary.liveness).toBeUndefined()
  })
})
