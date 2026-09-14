import { subscribeToPtyData } from '@/components/terminal-pane/pty-data-sidecar-subscriptions'
import { subscribeToPtyExit } from '@/components/terminal-pane/pty-dispatcher'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getRemoteRuntimeTerminalMultiplexer } from '@/runtime/remote-runtime-terminal-multiplexer'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from '@/runtime/runtime-terminal-stream'
import { hostOwnsRemoteAgentStatus } from '@/runtime/agent-status-host-osc-ingest-capability'
import { useAppStore } from '@/store'
import { createAgentStatusOscProcessor } from '../../../shared/agent-status-osc'
import { runtimeWaitExitCode } from '@/lib/agent-background-session-exit'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import { resolveLiveAgentStatusConnectionRouting } from '@/lib/agent-status-connection-ownership'
import { rendererAgentStatusObservations } from '@/lib/renderer-agent-status-observations'

export async function observeExistingAutomationSession(args: {
  ptyId: string
  paneKey: string
  runId: string
  onData: (chunk: string) => void
  onAgentStatus: (payload: ParsedAgentStatusPayload) => void
  onExit: (code: number) => void
}): Promise<() => void> {
  const { ptyId, paneKey, runId, onData, onExit } = args
  const processAgentStatus = createAgentStatusOscProcessor()
  // Why default false, resolved below only for a remote-runtime pty: local/SSH
  // status facts already pass through main's unconditional OSC ingest, so
  // writing here too would duplicate that path.
  let writesRemoteAgentStatusFallback = false
  const handleData = (data: string): void => {
    onData(data)
    const processed = processAgentStatus(data)
    for (const payload of processed.payloads) {
      if (writesRemoteAgentStatusFallback) {
        const state = useAppStore.getState()
        const routing = resolveLiveAgentStatusConnectionRouting({ state, paneKey, ptyId })
        // Why: a delayed reuse observer must not write into a pane that has
        // since rebound to another host's colliding tab/pane identifiers.
        if (routing) {
          state.setAgentStatus(
            paneKey,
            {
              ...payload,
              observation: rendererAgentStatusObservations.observe(paneKey, {
                origin: 'osc',
                observedAt: Date.now(),
                kind: 'snapshot'
              })
            },
            undefined,
            undefined,
            routing
          )
        }
      }
      args.onAgentStatus(payload)
    }
  }

  if (isRemoteRuntimePtyId(ptyId)) {
    let disposed = false
    const ownerEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
    const runtimeTarget = ownerEnvironmentId
      ? ({ kind: 'environment', environmentId: ownerEnvironmentId } as const)
      : getActiveRuntimeTarget(useAppStore.getState().settings)
    const terminal = getRemoteRuntimeTerminalHandle(ptyId)
    if (runtimeTarget.kind !== 'environment' || !terminal) {
      return () => {}
    }
    // Why probe, not assume: bytes never transit local main for this pty, so an
    // old host (no OSC-ingest capability) publishes no row at all — this
    // observer's own parse is that pane's only writer until the host upgrades.
    writesRemoteAgentStatusFallback = !(await hostOwnsRemoteAgentStatus(
      runtimeTarget.environmentId
    ))
    const stream = await getRemoteRuntimeTerminalMultiplexer(
      runtimeTarget.environmentId
    ).subscribeTerminal({
      terminal,
      client: { id: `desktop:automation-reuse:${runId}`, type: 'desktop' },
      callbacks: {
        onData: handleData,
        onSnapshot: () => {}
      }
    })
    void callRuntimeRpc<{ wait: { exitCode?: number | null } }>(
      runtimeTarget,
      'terminal.wait',
      { terminal, for: 'exit' },
      { timeoutMs: 24 * 60 * 60 * 1000 }
    )
      .then((result) => {
        if (!disposed) {
          onExit(runtimeWaitExitCode(result.wait))
        }
      })
      .catch(() => {})
    return () => {
      disposed = true
      stream.close()
    }
  }

  const unsubscribeData = subscribeToPtyData(ptyId, handleData)
  const unsubscribeExit = subscribeToPtyExit(ptyId, onExit)
  return () => {
    unsubscribeData()
    unsubscribeExit()
  }
}
