import type {
  RuntimeTerminalState,
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason,
  RuntimeTerminalWaitCondition
} from '../../shared/runtime-types'
import { isProvenProcessExit, type TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { TuiIdleVerdict } from './tui-idle-evidence'

/** A caller only ever has a settled verdict by the time it builds a result — 'not-idle' means no
 *  result is built at all. */
export type TuiIdleWaitEvidence = Exclude<TuiIdleVerdict, 'not-idle'>

type ReadonlyTerminalStateRecord = {
  connected: boolean
  lastExitCode: number | null
  lastExitCause?: TerminalExitCause | null
}

export function getTerminalState(leaf: ReadonlyTerminalStateRecord): RuntimeTerminalState {
  if (leaf.connected) {
    return 'running'
  }
  // C1: -1 (UNVERIFIED_PROCESS_EXIT_CODE) is a "we lost contact" sentinel, not a code the host
  // vouched for — only a proven code may report 'exited'; anything else is unproven contact loss.
  if (leaf.lastExitCode !== null && isProvenProcessExit(leaf.lastExitCode)) {
    return 'exited'
  }
  return 'unknown'
}

export function buildTerminalWaitResult(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  leaf: ReadonlyTerminalStateRecord,
  evidence?: TuiIdleWaitEvidence
): RuntimeTerminalWait {
  return buildTerminalWait(
    handle,
    condition,
    getTerminalState(leaf),
    leaf.lastExitCode,
    undefined,
    leaf.lastExitCause,
    evidence
  )
}

export function buildTerminalWaitBlockedResult(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  leaf: ReadonlyTerminalStateRecord,
  blockedReason: RuntimeTerminalWaitBlockedReason
): RuntimeTerminalWait {
  return buildTerminalWait(
    handle,
    condition,
    getTerminalState(leaf),
    leaf.lastExitCode,
    blockedReason,
    leaf.lastExitCause
  )
}

export function buildPtyTerminalWaitResult(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  pty: ReadonlyTerminalStateRecord,
  evidence?: TuiIdleWaitEvidence
): RuntimeTerminalWait {
  return buildTerminalWait(
    handle,
    condition,
    getPtyTerminalState(pty),
    pty.lastExitCode,
    undefined,
    pty.lastExitCause,
    evidence
  )
}

export function buildPtyTerminalWaitBlockedResult(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  pty: ReadonlyTerminalStateRecord,
  blockedReason: RuntimeTerminalWaitBlockedReason
): RuntimeTerminalWait {
  return buildTerminalWait(
    handle,
    condition,
    getPtyTerminalState(pty),
    pty.lastExitCode,
    blockedReason,
    pty.lastExitCause
  )
}

export function buildTerminalWait(
  handle: string,
  condition: RuntimeTerminalWaitCondition,
  status: RuntimeTerminalState,
  exitCode: number | null,
  blockedReason?: RuntimeTerminalWaitBlockedReason,
  exitCause?: TerminalExitCause | null,
  evidence?: TuiIdleWaitEvidence
): RuntimeTerminalWait {
  // C1: an 'exit' wait has no title/OSC evidence tier of its own — its only proof is a proven
  // exit code, so a disconnected-but-unproven PTY (status stays 'unknown', see getPtyTerminalState)
  // gets the same 'silence' evidence a tui-idle wait gets for the identical reason: contact was
  // lost, nothing here is proof. Never overrides evidence already computed for tui-idle.
  const resolvedEvidence =
    condition === 'exit' ? (status === 'exited' ? undefined : 'silence') : evidence
  // C2: `evidence !== 'silence'` let an absent (caller-forgot-to-pass) evidence value settle a
  // tui-idle wait the same as a positive report. A tui-idle wait has its own evidence tier and
  // must require the positive one by name; an 'exit' wait has no such tier, so it keeps the
  // "not silence" shape — its only positive fact is a proven exit code (resolvedEvidence undefined).
  const satisfiedByEvidence =
    condition === 'tui-idle' ? resolvedEvidence === 'observed-idle' : resolvedEvidence !== 'silence'
  return {
    handle,
    condition,
    // Silence is not proof: a pane that merely stopped repainting must never settle a waiter,
    // even though nothing blocks it — residual C.
    satisfied: blockedReason === undefined && satisfiedByEvidence,
    status,
    exitCode,
    ...(exitCause ? { exitCause } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    ...(resolvedEvidence ? { evidence: resolvedEvidence } : {})
  }
}

export function getPtyTerminalState(pty: ReadonlyTerminalStateRecord): RuntimeTerminalState {
  if (pty.connected) {
    return 'running'
  }
  return pty.lastExitCode !== null && isProvenProcessExit(pty.lastExitCode) ? 'exited' : 'unknown'
}
