import { describe, expect, it } from 'vitest'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult,
  buildTerminalWaitBlockedResult,
  buildTerminalWaitResult
} from './terminal-wait-results'
import { UNVERIFIED_PROCESS_EXIT_CODE } from '../../shared/terminal-exit-cause'

describe('terminal wait results', () => {
  it('preserves exit provenance for every wait result shape', () => {
    const terminal = {
      connected: false,
      lastExitCode: 0,
      lastExitCause: { kind: 'operator_close' as const }
    }
    const results = [
      buildTerminalWaitResult('terminal', 'exit', terminal),
      buildTerminalWaitBlockedResult('terminal', 'exit', terminal, 'agent-approval-prompt'),
      buildPtyTerminalWaitResult('pty', 'exit', terminal),
      buildPtyTerminalWaitBlockedResult('pty', 'exit', terminal, 'agent-approval-prompt')
    ]

    expect(results.map((result) => result.exitCause)).toEqual([
      { kind: 'operator_close' },
      { kind: 'operator_close' },
      { kind: 'operator_close' },
      { kind: 'operator_close' }
    ])
  })

  // C1: runtime-terminal-wait.ts:84 built a satisfied exit result off nothing but
  // `!connected`, so a PTY that merely lost contact settled the same as a proven exit.
  it('never settles an exit wait on disconnection without a proven exit code', () => {
    const disconnectedUnproven = { connected: false, lastExitCode: null }

    const result = buildPtyTerminalWaitResult('pty', 'exit', disconnectedUnproven)

    expect(result.status).toBe('unknown')
    expect(result.satisfied).toBe(false)
    expect(result.evidence).toBe('silence')
  })

  it('never maps the unverified exit sentinel to exited', () => {
    const disconnectedSentinel = { connected: false, lastExitCode: UNVERIFIED_PROCESS_EXIT_CODE }

    const result = buildPtyTerminalWaitResult('pty', 'exit', disconnectedSentinel)

    expect(result.status).not.toBe('exited')
    expect(result.satisfied).toBe(false)
  })

  it('settles an exit wait once the host vouches for a real exit code', () => {
    const disconnectedProven = { connected: false, lastExitCode: 0 }

    const result = buildPtyTerminalWaitResult('pty', 'exit', disconnectedProven)

    expect(result.status).toBe('exited')
    expect(result.satisfied).toBe(true)
    expect(result.evidence).toBeUndefined()
  })

  // C2: terminal-wait-results.ts:110 computed `satisfied: evidence !== 'silence'`, so a tui-idle
  // result built without any evidence at all (a caller bug, not a real verdict) settled anyway.
  // Only 'observed-idle' may satisfy a tui-idle wait.
  it('never settles a tui-idle wait with no evidence at all', () => {
    const running = { connected: true, lastExitCode: null }

    const result = buildPtyTerminalWaitResult('pty', 'tui-idle', running)

    expect(result.satisfied).toBe(false)
    expect(result.evidence).toBeUndefined()
  })

  it('never settles a tui-idle wait on silence evidence', () => {
    const running = { connected: true, lastExitCode: null }

    const result = buildPtyTerminalWaitResult('pty', 'tui-idle', running, 'silence')

    expect(result.satisfied).toBe(false)
  })

  it('settles a tui-idle wait once the agent is observed idle', () => {
    const running = { connected: true, lastExitCode: null }

    const result = buildPtyTerminalWaitResult('pty', 'tui-idle', running, 'observed-idle')

    expect(result.satisfied).toBe(true)
  })
})
