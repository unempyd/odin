/**
 * Panes whose agent status this renderer owns from the PTY byte stream.
 *
 * Remote-runtime panes have two writers for one store key: the client's own
 * OSC pipeline (pty-connection `shouldOwnAgentStatusInRenderer`) and the
 * mirrored host `session.tabs` snapshot. Without a fence they overwrite each
 * other on every publication and the tab flaps between "working + generated
 * title" and "done + Terminal". Registration marks the claim (re-evaluated
 * whenever a capability probe resolves — see `trackRemoteAgentStatusOwnership`
 * below — not just once at transport creation); the first byte-derived write
 * proves it, so a mirrored pane that never produced status keeps ceding to
 * the host.
 */
type RendererOwnedAgentStatusPane = {
  environmentId: string
  hasClientWrite: boolean
}

const panesByPaneKey = new Map<string, RendererOwnedAgentStatusPane>()

/** Claims the pane and returns its release; call the release on teardown. */
export function registerRendererOwnedAgentStatusPane(
  paneKey: string,
  environmentId: string
): () => void {
  const existing = panesByPaneKey.get(paneKey)
  // Why: a remount re-registers the same pane; keep the earned claim unless the
  // pane moved to another runtime environment (then its bytes are a new stream).
  const entry: RendererOwnedAgentStatusPane = {
    environmentId,
    hasClientWrite: existing?.environmentId === environmentId && existing.hasClientWrite
  }
  panesByPaneKey.set(paneKey, entry)
  // Why identity-checked: a replacement mount registers before the superseded
  // pane's dispose runs, and paneKey is `${tabId}:${leafId}` — shared across that
  // handoff. An unconditional delete would strip the live pane's claim for good,
  // since markRendererOwnedAgentStatusWrite never recreates a missing entry.
  return () => {
    if (panesByPaneKey.get(paneKey) === entry) {
      panesByPaneKey.delete(paneKey)
    }
  }
}

export function markRendererOwnedAgentStatusWrite(paneKey: string): void {
  const existing = panesByPaneKey.get(paneKey)
  if (!existing || existing.hasClientWrite) {
    return
  }
  existing.hasClientWrite = true
}

/** True once this renderer both claimed the pane and actually wrote its status. */
export function isClientAuthoritativeAgentStatusPane(paneKey: string): boolean {
  return panesByPaneKey.get(paneKey)?.hasClientWrite === true
}

export function _getRendererOwnedAgentStatusPaneCountForTest(): number {
  return panesByPaneKey.size
}

export function resetRendererOwnedAgentStatusPanesForTests(): void {
  panesByPaneKey.clear()
}

/**
 * Wires a remote-runtime pane's ownership claim to every later capability-probe resolution for
 * its environment, not just the value known at connection time (odin(status-cache-revisit)): a
 * cold-start pane that started "keep writing" flips to host-owned (and releases the claim) the
 * moment a probe proves the host owns it, and a pane that started host-owned flips back (and
 * re-claims) if a later probe answers false — a host downgraded mid-session.
 */
export function trackRemoteAgentStatusOwnership(args: {
  paneKey: string
  environmentId: string
  cachedHostOwns: boolean
  onOwnershipChange: (shouldOwnAgentStatusInRenderer: boolean) => void
  subscribeToHostOwnsChanges: (
    environmentId: string,
    listener: (hostOwns: boolean) => void
  ) => () => void
}): { shouldOwnAgentStatusInRenderer: boolean; dispose: () => void } {
  let shouldOwn = !args.cachedHostOwns
  let release = shouldOwn
    ? registerRendererOwnedAgentStatusPane(args.paneKey, args.environmentId)
    : null
  const unsubscribe = args.subscribeToHostOwnsChanges(args.environmentId, (hostOwns) => {
    const nextShouldOwn = !hostOwns
    if (nextShouldOwn === shouldOwn) {
      return
    }
    shouldOwn = nextShouldOwn
    if (shouldOwn) {
      release = registerRendererOwnedAgentStatusPane(args.paneKey, args.environmentId)
    } else {
      release?.()
      release = null
    }
    args.onOwnershipChange(shouldOwn)
  })
  return {
    shouldOwnAgentStatusInRenderer: shouldOwn,
    dispose: () => {
      release?.()
      unsubscribe()
    }
  }
}
