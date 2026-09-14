import { describe, expect, it, vi } from 'vitest'

const runtimeEnvironmentSupportsCapability = vi.fn()

vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: (...args: unknown[]) =>
    runtimeEnvironmentSupportsCapability(...args)
}))

const { hostOwnsRemoteAgentStatus } = await import('./agent-status-host-osc-ingest-capability')

describe('hostOwnsRemoteAgentStatus', () => {
  it('probes the environment for the host-osc-ingest capability', async () => {
    runtimeEnvironmentSupportsCapability.mockResolvedValue(true)

    expect(await hostOwnsRemoteAgentStatus('env-1')).toBe(true)
    expect(runtimeEnvironmentSupportsCapability).toHaveBeenCalledWith(
      'env-1',
      'agent-status.host-osc-ingest.v1'
    )
  })

  it('is false for a host that predates the capability', async () => {
    runtimeEnvironmentSupportsCapability.mockResolvedValue(false)
    expect(await hostOwnsRemoteAgentStatus('env-legacy')).toBe(false)
  })
})
