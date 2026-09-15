import { AGENT_STATUS_HOST_OSC_INGEST_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'

/**
 * Whether the given runtime environment's host ingests its own OSC 9999 bytes into its agent-
 * status hook store and republishes the resulting row on `session.tabs` — see
 * `docs/reference/agent-status-store.md` and the "Agent status: renderer second writer" residual
 * in `odin/OPEN.md`. Consumed by the remote-pane writers (`direct-ssh-retry-status.ts` through the
 * cached verdict below, `background-agent-status-consumer.ts` and `automation-session-observer.ts`
 * directly): a client stops parsing its own OSC bytes only for a host that answers yes.
 */
export function hostOwnsRemoteAgentStatus(environmentId: string): Promise<boolean> {
  // Why swallow: a transient probe failure must fall back to "host does not own" — the
  // increment's own stated default — never fail a caller mid-launch (odin(status-probe-await)).
  return runtimeEnvironmentSupportsCapability(
    environmentId,
    AGENT_STATUS_HOST_OSC_INGEST_RUNTIME_CAPABILITY
  ).catch(() => false)
}

const lastKnownHostOwnsRemoteAgentStatus = new Map<string, boolean>()
const hostOwnsRemoteAgentStatusListeners = new Map<string, Set<(owns: boolean) => void>>()

/**
 * Synchronous last-known verdict for `hostOwnsRemoteAgentStatus`, for a caller that must decide
 * ownership before a transport exists (`direct-ssh-retry-status.ts`'s `shouldOwnAgentStatusInRenderer`,
 * decided at connection time from whatever is known so far). Defaults to `false` — the client
 * keeps writing, today's behavior — until the probe this module fires resolves at least once for
 * that environment: defaulting the other way would starve a pane on a cold probe. A live session
 * does not have to re-read this itself — see `subscribeToHostOwnsRemoteAgentStatusChanges` below.
 */
export function cachedHostOwnsRemoteAgentStatus(environmentId: string): boolean {
  return lastKnownHostOwnsRemoteAgentStatus.get(environmentId) ?? false
}

/**
 * Notifies every listener for `environmentId` when a probe resolves — so a pane connected before
 * the cold-start default was known (or before a host upgrade/downgrade mid-session) can flip its
 * own live ownership decision instead of freezing whatever `cachedHostOwnsRemoteAgentStatus`
 * returned at connection time. Returns the unsubscribe.
 */
export function subscribeToHostOwnsRemoteAgentStatusChanges(
  environmentId: string,
  listener: (owns: boolean) => void
): () => void {
  let listeners = hostOwnsRemoteAgentStatusListeners.get(environmentId)
  if (!listeners) {
    listeners = new Set()
    hostOwnsRemoteAgentStatusListeners.set(environmentId, listeners)
  }
  listeners.add(listener)
  return () => {
    hostOwnsRemoteAgentStatusListeners.get(environmentId)?.delete(listener)
  }
}

/** Fire-and-forget: the client must probe, never assume (remote-wire-compatibility.md) — this
 *  warms the cache and notifies every live subscriber for this environment (see
 *  `subscribeToHostOwnsRemoteAgentStatusChanges`), including the pane whose own connection fired
 *  this probe. Never throws. */
export function primeHostOwnsRemoteAgentStatusCache(environmentId: string): void {
  void hostOwnsRemoteAgentStatus(environmentId)
    .then((owns) => {
      lastKnownHostOwnsRemoteAgentStatus.set(environmentId, owns)
      for (const listener of hostOwnsRemoteAgentStatusListeners.get(environmentId) ?? []) {
        listener(owns)
      }
    })
    .catch(() => {})
}

/** Test-only: drops every cached verdict and subscriber so suites cannot leak state across cases. */
export function _resetHostOwnsRemoteAgentStatusCacheForTest(): void {
  lastKnownHostOwnsRemoteAgentStatus.clear()
  hostOwnsRemoteAgentStatusListeners.clear()
}
