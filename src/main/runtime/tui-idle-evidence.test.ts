import { describe, expect, it } from 'vitest'
import {
  isTuiIdleSatisfied,
  resolveTuiIdleVerdict,
  type TuiIdleSatisfactionInput
} from './tui-idle-evidence'

// Residual C: tui-idle settled on silence — a name-only title going quiet was published as the
// same `satisfied: true` as an agent's own explicit idle report. These pin the three-way verdict
// resolveTuiIdleVerdict now returns, and that isTuiIdleSatisfied stays a `!== 'not-idle'` guard.

const QUIESCENCE_MS = 3000

function baseInput(overrides: Partial<TuiIdleSatisfactionInput> = {}): TuiIdleSatisfactionInput {
  return {
    record: { lastAgentStatus: null, lastOutputAt: null, lastOscTitle: null },
    readPositiveBodyEvidence: () => false,
    agent: null,
    firstPartyStatus: null,
    quiescenceMs: QUIESCENCE_MS,
    ...overrides
  }
}

describe('resolveTuiIdleVerdict', () => {
  it('is observed-idle from an explicit idle title (tier 1)', () => {
    const input = baseInput({
      record: { lastAgentStatus: 'idle', lastOutputAt: null, lastOscTitle: 'Codex ready' },
      agent: 'codex'
    })
    expect(resolveTuiIdleVerdict(input)).toBe('observed-idle')
  })

  it('is observed-idle from positive body evidence (tier 1)', () => {
    const input = baseInput({ readPositiveBodyEvidence: () => true })
    expect(resolveTuiIdleVerdict(input)).toBe('observed-idle')
  })

  it('is not-idle when a fresh first-party status vetoes it', () => {
    const input = baseInput({
      record: {
        lastAgentStatus: 'idle',
        lastOutputAt: Date.now() - QUIESCENCE_MS * 4,
        lastOscTitle: 'Codex'
      },
      agent: 'codex',
      firstPartyStatus: { state: 'working', updatedAt: Date.now() }
    })
    expect(resolveTuiIdleVerdict(input)).toBe('not-idle')
  })

  it('is not-idle while a name-only title agent is still streaming', () => {
    const input = baseInput({
      record: { lastAgentStatus: 'idle', lastOutputAt: Date.now(), lastOscTitle: 'Codex' },
      agent: 'codex'
    })
    expect(resolveTuiIdleVerdict(input)).toBe('not-idle')
  })

  // The residual: a name-only title from an agent that DOES go on to announce rest explicitly
  // (Codex/Devin-style) going quiet is corroborated silence, not the agent's own report.
  it('is silence, not observed-idle, for a corroborating agent gone quiet on its name alone', () => {
    const input = baseInput({
      record: {
        lastAgentStatus: 'idle',
        lastOutputAt: Date.now() - QUIESCENCE_MS * 2,
        lastOscTitle: 'Codex'
      },
      agent: 'codex'
    })
    expect(resolveTuiIdleVerdict(input)).toBe('silence')
    expect(isTuiIdleSatisfied(input)).toBe(true)
  })

  // Carve-out: grok/copilot/aider/mimo/agy/opencode emit only their name at rest and never
  // announce readiness explicitly, so their sustained name-only title IS the only signal that
  // will ever arrive — promoted to observed-idle rather than degraded to silence.
  it('is observed-idle for an agent whose only rest signal is its name', () => {
    const input = baseInput({
      record: {
        lastAgentStatus: 'idle',
        lastOutputAt: Date.now() - QUIESCENCE_MS * 2,
        lastOscTitle: 'grok'
      },
      agent: 'grok'
    })
    expect(resolveTuiIdleVerdict(input)).toBe('observed-idle')
  })
})

describe('isTuiIdleSatisfied', () => {
  it('stays a guard: true for observed-idle and silence, false for not-idle', () => {
    expect(isTuiIdleSatisfied(baseInput({ readPositiveBodyEvidence: () => true }))).toBe(true)
    expect(
      isTuiIdleSatisfied(
        baseInput({
          record: {
            lastAgentStatus: 'idle',
            lastOutputAt: Date.now() - QUIESCENCE_MS * 2,
            lastOscTitle: 'Codex'
          },
          agent: 'codex'
        })
      )
    ).toBe(true)
    expect(isTuiIdleSatisfied(baseInput())).toBe(false)
  })
})
