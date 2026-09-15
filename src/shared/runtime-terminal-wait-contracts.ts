import type { TerminalExitCause } from './terminal-exit-cause'
import type { RuntimeTerminalState } from './runtime-terminal-contracts'

export type RuntimeTerminalWaitCondition = 'exit' | 'tui-idle'

// Why both spellings: the codex-* members were published by every host before the agent-neutral
// rename, so they are permanent — a client still has to read them off an older host. This build
// keeps a codex-* reason only where the matched wording is plausibly Codex's own; every matcher
// that inspects no agent publishes the agent-* spelling.
export type RuntimeTerminalWaitBlockedReason =
  | 'codex-update-prompt'
  | 'codex-trust-workspace'
  | 'codex-cwd-prompt'
  | 'codex-model-migration-prompt'
  | 'codex-hooks-review-prompt'
  | 'codex-interactive-prompt'
  | 'agent-update-prompt'
  | 'agent-trust-workspace'
  | 'agent-cwd-prompt'
  | 'agent-hooks-review-prompt'
  | 'agent-interactive-prompt'
  | 'agent-approval-prompt'

export type RuntimeTerminalWait = {
  handle: string
  condition: RuntimeTerminalWaitCondition
  satisfied: boolean
  status: RuntimeTerminalState
  exitCode: number | null
  exitCause?: TerminalExitCause
  blockedReason?: RuntimeTerminalWaitBlockedReason
  /** `'observed-idle'` (only for `condition: 'tui-idle'`) is a positive read: the agent said so,
   *  or it is one of the agents with no other rest signal. `'silence'` is contact that merely
   *  went quiet with nothing proving the wait's condition — a `tui-idle` pane that stopped
   *  repainting without reporting idle, or an `exit` wait on a PTY that disconnected without a
   *  proven exit code (C1) — corroborated by quiescence at best, never confirmed. `satisfied` is
   *  false whenever evidence is `'silence'`. Absent from a host older than this field. */
  evidence?: 'observed-idle' | 'silence'
}
