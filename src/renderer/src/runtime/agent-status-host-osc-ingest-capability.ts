import { AGENT_STATUS_HOST_OSC_INGEST_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'

/**
 * Whether the given runtime environment's host ingests its own OSC 9999 bytes into its agent-
 * status hook store and republishes the resulting row on `session.tabs` — see
 * `docs/reference/agent-status-store.md` and the "Agent status: renderer second writer" residual
 * in `odin/OPEN.md`. Not yet consumed by anything: a client that stopped parsing its own OSC bytes
 * on this answer alone, before the host-published row actually reaches it, would show blank status
 * for a healthy remote pane. Wiring this into `direct-ssh-retry-status.ts`'s
 * `shouldOwnAgentStatusInRenderer` decision is a later increment.
 */
export function hostOwnsRemoteAgentStatus(environmentId: string): Promise<boolean> {
  return runtimeEnvironmentSupportsCapability(
    environmentId,
    AGENT_STATUS_HOST_OSC_INGEST_RUNTIME_CAPABILITY
  )
}
