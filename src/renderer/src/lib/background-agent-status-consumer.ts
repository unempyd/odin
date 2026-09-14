import { useAppStore } from '@/store'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { createAgentStatusOscProcessor } from '../../../shared/agent-status-osc'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import {
  resolveLiveAgentStatusConnectionRouting,
  type AgentStatusConnectionRouting
} from './agent-status-connection-ownership'
import { rendererAgentStatusObservations } from './renderer-agent-status-observations'
import type { AgentStatusObservation } from '../../../shared/agent-status-observation'

export function createBackgroundAgentStatusConsumer(args: {
  paneKey: string
  launchToken: string
  expectedConnectionId: string | null | undefined
  runtimeEnvironmentId: string | null
  /** Resolved by the caller (via `hostOwnsRemoteAgentStatus`) before this consumer
   *  starts receiving data: true only for a remote-runtime pty whose host does not
   *  (yet) advertise OSC-ingest — bytes never transit local main for that pty, so
   *  this consumer's own parse is its only writer until the host upgrades. */
  writesRemoteAgentStatusFallback: boolean
  getPtyId: () => string
  onAgentStatus?: (payload: ParsedAgentStatusPayload) => void
}): {
  consume: (data: string) => void
  resolveRouting: () => AgentStatusConnectionRouting | undefined
  /** Stamp a launch-origin observation for this pane (STA-4293). Lives here because this
   *  consumer already owns the pane's status ingress; callers seeding a launch row need the
   *  same authority the byte path writes under. */
  observeLaunchIngress: () => AgentStatusObservation
} {
  const processAgentStatus = createAgentStatusOscProcessor()
  const resolveRouting = (): AgentStatusConnectionRouting | undefined => {
    const ptyId = args.getPtyId()
    const state = useAppStore.getState()
    return resolveLiveAgentStatusConnectionRouting({
      state,
      paneKey: args.paneKey,
      ptyId,
      expectedConnectionId: args.expectedConnectionId,
      runtimeEnvironmentId: args.runtimeEnvironmentId
    })
  }
  // Why local/SSH writes no store: main's OSC ingest is unconditional
  // (agent-status-store.ts). Only a remote-runtime pty on a host that hasn't
  // advertised OSC-ingest still needs this consumer's own write.
  const consume = (data: string): void => {
    const processed = processAgentStatus(data)
    for (const payload of processed.payloads) {
      if (args.writesRemoteAgentStatusFallback && isRemoteRuntimePtyId(args.getPtyId())) {
        const routing = resolveRouting()
        // Why: hidden callbacks can outlive tab reuse; only the exact current
        // pane-to-PTY binding may update its status ownership.
        if (routing) {
          useAppStore.getState().setAgentStatus(
            args.paneKey,
            {
              ...payload,
              observation: rendererAgentStatusObservations.observe(args.paneKey, {
                origin: 'osc',
                observedAt: Date.now(),
                kind: 'snapshot'
              })
            },
            undefined,
            undefined,
            routing,
            { launchToken: args.launchToken }
          )
        }
      }
      args.onAgentStatus?.(payload)
    }
  }
  const observeLaunchIngress = (): AgentStatusObservation =>
    rendererAgentStatusObservations.observe(args.paneKey, {
      origin: 'launch',
      observedAt: Date.now(),
      kind: 'transition'
    })
  return { consume, resolveRouting, observeLaunchIngress }
}
