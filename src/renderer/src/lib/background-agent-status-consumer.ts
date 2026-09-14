import { useAppStore } from '@/store'
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
  // Why no store write here: main's OSC ingest is unconditional (agent-status-store.ts),
  // so this consumer only forwards parsed payloads for automation completion tracking.
  const consume = (data: string): void => {
    const processed = processAgentStatus(data)
    for (const payload of processed.payloads) {
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
