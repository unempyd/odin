import { afterEach, describe, expect, it, vi } from 'vitest'

const runtimeEnvironmentSupportsCapability = vi.fn()

vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: (...args: unknown[]) =>
    runtimeEnvironmentSupportsCapability(...args)
}))

const {
  hostOwnsRemoteAgentStatus,
  cachedHostOwnsRemoteAgentStatus,
  primeHostOwnsRemoteAgentStatusCache,
  _resetHostOwnsRemoteAgentStatusCacheForTest
} = await import('./agent-status-host-osc-ingest-capability')

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

describe('cachedHostOwnsRemoteAgentStatus', () => {
  afterEach(() => {
    _resetHostOwnsRemoteAgentStatusCacheForTest()
  })

  it('defaults to false for an environment never probed — a cold probe must not starve the pane', () => {
    expect(cachedHostOwnsRemoteAgentStatus('env-never-probed')).toBe(false)
  })

  it('warms to the probed verdict after priming resolves', async () => {
    runtimeEnvironmentSupportsCapability.mockResolvedValue(true)

    primeHostOwnsRemoteAgentStatusCache('env-capable')
    await vi.waitFor(() => expect(cachedHostOwnsRemoteAgentStatus('env-capable')).toBe(true))
  })

  it('stays false when the probe rejects', async () => {
    runtimeEnvironmentSupportsCapability.mockRejectedValue(new Error('offline'))

    primeHostOwnsRemoteAgentStatusCache('env-offline')
    await vi.waitFor(() => expect(runtimeEnvironmentSupportsCapability).toHaveBeenCalled())
    expect(cachedHostOwnsRemoteAgentStatus('env-offline')).toBe(false)
  })
})
