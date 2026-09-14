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
  return runtimeEnvironmentSupportsCapability(
    environmentId,
    AGENT_STATUS_HOST_OSC_INGEST_RUNTIME_CAPABILITY
  )
}

const lastKnownHostOwnsRemoteAgentStatus = new Map<string, boolean>()

/**
 * Synchronous last-known verdict for `hostOwnsRemoteAgentStatus`, for a caller that must decide
 * ownership before a transport exists (`direct-ssh-retry-status.ts`'s `shouldOwnAgentStatusInRenderer`,
 * decided once at connection time and never revisited). Defaults to `false` — the client keeps
 * writing, today's behavior — until the probe this module fires resolves at least once for that
 * environment: defaulting the other way would starve a pane on a cold probe.
 */
export function cachedHostOwnsRemoteAgentStatus(environmentId: string): boolean {
  return lastKnownHostOwnsRemoteAgentStatus.get(environmentId) ?? false
}

/** Fire-and-forget: the client must probe, never assume (remote-wire-compatibility.md) — this
 *  warms the cache so the *next* pane connecting to this environment (or a reconnect of this one)
 *  reads a real verdict instead of the cold default. Never throws. */
export function primeHostOwnsRemoteAgentStatusCache(environmentId: string): void {
  void hostOwnsRemoteAgentStatus(environmentId)
    .then((owns) => {
      lastKnownHostOwnsRemoteAgentStatus.set(environmentId, owns)
    })
    .catch(() => {})
}

/** Test-only: drops every cached verdict so suites cannot leak state across cases. */
export function _resetHostOwnsRemoteAgentStatusCacheForTest(): void {
  lastKnownHostOwnsRemoteAgentStatus.clear()
}
