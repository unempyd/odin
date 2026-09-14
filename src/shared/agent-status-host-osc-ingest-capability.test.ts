import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_HOST_OSC_INGEST_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from './protocol-version'

describe('agent-status.host-osc-ingest capability', () => {
  it('is a stable, versioned capability string', () => {
    expect(AGENT_STATUS_HOST_OSC_INGEST_RUNTIME_CAPABILITY).toBe('agent-status.host-osc-ingest.v1')
  })

  it('is advertised in the runtime capability list', () => {
    expect(RUNTIME_CAPABILITIES).toContain(AGENT_STATUS_HOST_OSC_INGEST_RUNTIME_CAPABILITY)
  })
})
