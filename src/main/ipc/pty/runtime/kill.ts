import type { IPtyProvider } from '../../../providers/types'
import { UNVERIFIED_PROCESS_EXIT_CODE } from '../../../../shared/terminal-exit-cause'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../../shared/pty-liveness-verdict'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import { ptyOwnership, ptyIncarnationById } from '../provider/ownership-state'
import { getProvider, getProviderForPty } from '../provider/registry'
import { isPtyAlreadyGoneError, delay, verifyPtyStopped } from '../provider/liveness'
import { recordUndeliveredSshPtyKill } from './undelivered-ssh-kill'
import type { PtyRuntimeControllerDeps } from './controller-deps'

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function emitSyntheticPtyExit(
  deps: PtyRuntimeControllerDeps,
  ptyId: string,
  code: number,
  incarnationId?: string | null
): void {
  deps.runtime?.onPtyExit(ptyId, code, incarnationId ?? undefined)
  deps.rememberSyntheticKillExit(ptyId)
  deps.sendPtyExitToRenderer({ id: ptyId, code, ...(incarnationId ? { incarnationId } : {}) })
}

export function killPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string
): boolean {
  const {
    runtime,
    store,
    getLocalPtyProviderStartupPromise,
    shutdownProviderAndDetectExit,
    finishPtyShutdown,
    retiredRejectedPtyIds,
    reversibleStopOwnersByPtyId
  } = deps
  runtime?.markPtyStopRequested?.(ptyId)
  let connectionId: string | null | undefined = ptyOwnership.get(ptyId)
  const parsedSshId = connectionId === undefined ? parseAppSshPtyId(ptyId) : null
  connectionId ??= parsedSshId?.connectionId
  const recordUndelivered = (incarnationId?: string): void => {
    recordUndeliveredSshPtyKill({
      store,
      ptyId,
      connectionId,
      reversible: reversibleStopOwnersByPtyId.has(ptyId),
      incarnationId
    })
  }
  const killWithCurrentProvider = (): boolean => {
    let provider: IPtyProvider
    try {
      provider = connectionId ? getProvider(connectionId) : getProviderForPty(ptyId)
    } catch {
      if (connectionId) {
        // Why: runtime/CLI close can target a detached SSH PTY after its
        // provider was unregistered. Tombstone the lease so reconnect does
        // not revive a terminal the user explicitly closed.
        const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
        // The relay was never asked, so the remote shell is still running. Keep the order.
        recordUndelivered(incarnationId)
        emitSyntheticPtyExit(deps, ptyId, UNVERIFIED_PROCESS_EXIT_CODE, incarnationId)
        runtime?.markPtyLivenessUnverifiable?.(ptyId, SSH_PROVIDER_UNREGISTERED_REASON)
        return false
      }
      return false
    }
    // Why: controller is synchronous, but keep ownership until async shutdown proves whether the provider emitted an exit.
    void shutdownProviderAndDetectExit(provider, ptyId, { immediate: false })
      .then((providerExitObserved) => {
        const retired = retiredRejectedPtyIds.has(ptyId)
        const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
        if (!providerExitObserved && !retired) {
          emitSyntheticPtyExit(deps, ptyId, UNVERIFIED_PROCESS_EXIT_CODE, incarnationId)
        }
      })
      .catch((err) => {
        const retired = retiredRejectedPtyIds.has(ptyId)
        if (isPtyAlreadyGoneError(err)) {
          const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
          if (!retired) {
            emitSyntheticPtyExit(deps, ptyId, UNVERIFIED_PROCESS_EXIT_CODE, incarnationId)
          }
          return
        }
        console.warn(`[pty] Failed to stop PTY ${ptyId}: ${errorMessage(err)}`)
        // Why: close runtime tails without clearing provider ownership, so
        // a retry can still target a PTY that survived the failed shutdown.
        if (!retired) {
          if (connectionId) {
            runtime?.markPtyLivenessUnverifiable?.(ptyId, errorMessage(err))
          }
          runtime?.onPtyExit(ptyId, -1, ptyIncarnationById.get(ptyId))
        }
        // Outside the `retired` guard: the remote process outlives this client's bookkeeping
        // either way, and the intent is what the next handshake replays.
        recordUndelivered()
      })
    return true
  }
  const startupPromise = getLocalPtyProviderStartupPromise(connectionId)
  if (startupPromise) {
    // Why: resolve the provider after daemon swap, or the fallback can falsely confirm teardown.
    void startupPromise.then(killWithCurrentProvider).catch((err) => {
      console.warn(`[pty] Failed to stop PTY ${ptyId}: ${errorMessage(err)}`)
      if (!retiredRejectedPtyIds.has(ptyId)) {
        if (connectionId) {
          runtime?.markPtyLivenessUnverifiable?.(ptyId, errorMessage(err))
        }
        runtime?.onPtyExit(ptyId, -1, ptyIncarnationById.get(ptyId))
      }
      recordUndelivered()
    })
    return true
  }
  return killWithCurrentProvider()
}

export function retireRejectedPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string,
  stopConfirmed: boolean
): void {
  const { runtime, store, rememberRetiredRejectedPty, finishPtyShutdown } = deps
  rememberRetiredRejectedPty(ptyId)
  if (!stopConfirmed) {
    runtime?.markPtyLivenessUnverifiable?.(
      ptyId,
      'a follow-up stop was issued but its outcome could not be verified'
    )
    if (!ptyOwnership.has(ptyId)) {
      return
    }
    emitSyntheticPtyExit(deps, ptyId, UNVERIFIED_PROCESS_EXIT_CODE, ptyIncarnationById.get(ptyId))
    return
  }
  // Why: a completed stop already cleared provider state, tombstoned the lease and told the
  // renderer; repeating that double-fires the exit IPC. The runtime still needs code 0 so an
  // SSH pane retires for good instead of staying preserved by the stop's negative exit.
  if (!ptyOwnership.has(ptyId)) {
    runtime?.onPtyExit(ptyId, 0, ptyIncarnationById.get(ptyId))
    return
  }
  let connectionId: string | null | undefined = ptyOwnership.get(ptyId)
  const parsedSshId = connectionId === undefined ? parseAppSshPtyId(ptyId) : null
  connectionId ??= parsedSshId?.connectionId
  const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
  emitSyntheticPtyExit(deps, ptyId, 0, incarnationId)
}

export function markReversibleStopsFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyIds: readonly string[]
): () => void {
  const { reversibleStopOwnersByPtyId } = deps
  for (const ptyId of ptyIds) {
    reversibleStopOwnersByPtyId.set(ptyId, (reversibleStopOwnersByPtyId.get(ptyId) ?? 0) + 1)
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    for (const ptyId of ptyIds) {
      const owners = (reversibleStopOwnersByPtyId.get(ptyId) ?? 0) - 1
      if (owners > 0) {
        reversibleStopOwnersByPtyId.set(ptyId, owners)
      } else {
        reversibleStopOwnersByPtyId.delete(ptyId)
      }
    }
  }
}

/**
 * Deliberately records no undelivered-stop intent, unlike `killPtyFromRuntimeController`.
 *
 * Only a caller that gives the PTY up for good may leave a replayable kill order behind. This one
 * hands its failures back instead: worktree sleep marks these stops reversible and leaves the pane
 * live and usable when one does not land, so a durable order recorded here would come back on a
 * later handshake and destroy a terminal the user had gone back to using.
 */
export async function stopAndWaitPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string,
  opts?: { keepHistory?: boolean; deadlineMs?: number }
): Promise<boolean> {
  const {
    runtime,
    store,
    getLocalPtyProviderStartupPromise,
    shutdownProviderAndDetectExit,
    finishPtyShutdown
  } = deps
  runtime?.markPtyStopRequested?.(ptyId)
  let connectionId: string | null | undefined = ptyOwnership.get(ptyId)
  const parsedSshId = connectionId === undefined ? parseAppSshPtyId(ptyId) : null
  connectionId ??= parsedSshId?.connectionId
  // Why: destructive teardown threads one absolute deadline through every await below.
  const deadlineMs = opts?.deadlineMs
  const startupPromise = getLocalPtyProviderStartupPromise(connectionId)
  if (startupPromise) {
    // Why: resolve the provider after daemon startup, or the fallback can falsely confirm teardown.
    if (deadlineMs !== undefined) {
      const won = await Promise.race([
        startupPromise.then(
          () => true,
          () => false
        ),
        delay(Math.max(1, deadlineMs - Date.now())).then(() => false)
      ])
      if (!won) {
        return false
      }
    } else {
      await startupPromise
    }
  }
  let provider: IPtyProvider
  try {
    provider = connectionId ? getProvider(connectionId) : getProviderForPty(ptyId)
  } catch {
    if (connectionId) {
      // Why: absent SSH provider: tombstone the relay lease even with no live target to await.
      const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
      emitSyntheticPtyExit(deps, ptyId, UNVERIFIED_PROCESS_EXIT_CODE, incarnationId)
      runtime?.markPtyLivenessUnverifiable?.(ptyId, SSH_PROVIDER_UNREGISTERED_REASON)
    }
    return false
  }
  let providerExitObserved = false
  try {
    providerExitObserved = await shutdownProviderAndDetectExit(provider, ptyId, {
      immediate: true,
      keepHistory: opts?.keepHistory ?? false,
      deadlineMs
    })
  } catch (err) {
    if (!isPtyAlreadyGoneError(err)) {
      if (connectionId) {
        runtime?.markPtyLivenessUnverifiable?.(ptyId, errorMessage(err))
      }
      console.warn(`[pty] Failed to stop PTY ${ptyId}: ${errorMessage(err)}`)
      return false
    }
  }
  try {
    if (!(await verifyPtyStopped(provider, ptyId, opts))) {
      runtime?.markPtyLivenessLive?.(ptyId)
      return false
    }
  } catch (err) {
    if (connectionId) {
      runtime?.markPtyLivenessUnverifiable?.(ptyId, errorMessage(err))
    }
    console.warn(`[pty] Failed to verify PTY ${ptyId} stopped: ${errorMessage(err)}`)
    return false
  }
  const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
  if (!providerExitObserved) {
    // A fresh listing omission is not proof of death; let the unverifiable sentinel carry it.
    emitSyntheticPtyExit(deps, ptyId, UNVERIFIED_PROCESS_EXIT_CODE, incarnationId)
    runtime?.markPtyLivenessUnverifiable?.(
      ptyId,
      "the provider's post-stop listing omitted the id, not proof it exited"
    )
  }
  return true
}
