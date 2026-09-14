import type { AgentStatus } from '../../shared/agent-detection'
import { isFreshNonDoneAgentStatus } from '../../shared/agent-status-freshness'
import type { AgentStatusState } from '../../shared/agent-status-types'
import { getSyntheticAgentTerminalTitle } from '../../shared/synthetic-agent-title'
import { resolveExplicitTerminalTitleAgentType } from '../../shared/terminal-title-agent-type'
import type { TuiAgent } from '../../shared/tui-agent'
import { detectExplicitIdleStatusFromTitle } from './terminal-wait-detection'

/**
 * Ranking the evidence that a `tui-idle` wait may settle on.
 *
 * Why a ranking: a thinking TUI and a finished TUI are both silent, so the absence
 * of a working marker can never prove completion. `detectAgentStatusFromTitle`
 * DEFAULTS a name-only agent title to `idle` — the sidebar needs that to clear a
 * stale spinner (#1437) — so a busy Codex/Devin pane is routinely titled idle, and
 * accepting it satisfied a wait in ~0s mid-turn (#6011).
 *
 * Evaluated in this order:
 *   1. VETO — a fresh first-party agent status (OSC 9999) saying working/blocked/
 *      waiting. The agent's own live account of an open turn outranks anything
 *      inferred from the screen, including a title or ready-prompt body the agent
 *      painted before this turn started — that pixel may simply not have caught up
 *      yet (C5).
 *   2. POSITIVE — the agent states it is ready: an explicit idle marker in its own
 *      title, or a known ready-prompt body.
 *   3. ABSENCE — a name-only title, or a quiet non-shell foreground process. A last
 *      resort, and only once sustained.
 *
 * C4 — the name-only carve-out (grok/copilot/aider/mimo/agy/opencode — see
 * `nameOnlyIdleNeedsCorroboration`) is promoted to tier 2's `observed-idle` rather than held at
 * tier 3's `silence`, because those agents never emit a second, corroborating rest signal and
 * holding them to `silence` forever is indistinguishable from never settling. It still waits out
 * the full quiescence window first — "no stronger signal is coming" buys a better verdict, never a
 * faster one.
 *
 * C5 — tier 1's veto used to be consulted only after tier 2 (then numbered tier 1) already
 * settled, on the theory that a title/body the agent just painted is closer to the truth than a
 * status event that may simply not have arrived yet. That let a retained ready title or
 * ready-prompt body outrank a fresh first-party "still working" status — exactly backwards, since
 * a live status report is stronger evidence than a screen that has not repainted since the last
 * turn. The veto is now consulted first, unconditionally.
 *
 * Why derived here rather than stamped onto the record at write time: `syncWindowGraph`
 * rebuilds every leaf from an explicit field list, so a bespoke provenance field is
 * silently dropped on any renderer publish and the verdict silently flips. `lastOscTitle`
 * is copied, so reading the rank back off it cannot decay.
 */

export type TuiIdleEvidenceRecord = {
  lastAgentStatus: AgentStatus | null
  lastOutputAt: number | null
  lastOscTitle?: string | null
}

export type FirstPartyAgentStatus = { state: AgentStatusState; updatedAt: number } | null

/** Tier 2: an idle marker the agent put in a title itself. */
export function hasExplicitIdleTitle(
  record: TuiIdleEvidenceRecord,
  rendererTitle?: string | null
): boolean {
  // Why lastOscTitle too, not just the renderer's pane title: a daemon-hosted or
  // background pane has no renderer publishing a title, so reading only the synced
  // one dropped an explicit `Codex ready` to the tier-3 lane and delayed it by the
  // whole quiescence window.
  for (const title of [rendererTitle, record.lastOscTitle]) {
    if (title && detectExplicitIdleStatusFromTitle(title) === 'idle') {
      return true
    }
  }
  return false
}

/** Tier 1: the agent's own status stream says this turn is still open. */
export function hasFreshWorkingFirstPartyStatus(status: FirstPartyAgentStatus): boolean {
  return isFreshNonDoneAgentStatus(status ?? undefined)
}

/**
 * Whether a name-only title from `agent` may be held to the tier-3 quiescence demand.
 *
 * Only for agents that go on to announce rest with an explicit title of their own (the
 * hook-driven `Codex ready` / `Devin ready`). Grok, Copilot, Aider, Mimo, agy and
 * OpenCode emit their NAME and nothing more at rest, so holding them to it leaves no
 * settle signal at all: a real idle Grok pane repaints its banner about four times a
 * second forever, so the stream never quiesces and the wait runs to timeout.
 */
export function nameOnlyIdleNeedsCorroboration(
  agent: TuiAgent | null | undefined,
  title?: string | null
): boolean {
  // Why the title fallback: an adopted pane carries no launch metadata, but its
  // name-only title is exactly the thing that names the agent.
  const resolved = agent ?? (title ? resolveExplicitTerminalTitleAgentType(title) : null)
  return getSyntheticAgentTerminalTitle(resolved, 'done') !== null
}

/** Tier 3: a title-derived idle, usable only once the stream has also gone quiet.
 *
 * C4: the name-only carve-out used to skip straight past this quiescence check — "no stronger
 * signal will ever arrive" bought the carve-out a better final verdict (see
 * `nameOnlyIdleNeedsCorroboration` below), never an *immediate* one. A busy name-only agent still
 * repaints its banner while working, so settling on the title alone reopened #6011 for exactly
 * the agents the carve-out exists for. */
export function hasSustainedTitleIdle(
  record: TuiIdleEvidenceRecord,
  quiescenceMs: number
): boolean {
  if (record.lastAgentStatus !== 'idle') {
    return false
  }
  // Why not "no timestamp means nothing to debounce": an adopted or daemon-backed pane has
  // no local output clock, so for an agent that WILL announce rest explicitly there is no
  // corroboration available at all. Settling here let a busy Codex/Devin satisfy the wait
  // from a name-only title (#6011); hold out for tier 1/2 or the caller's timeout instead.
  // Applies identically to the name-only carve-out (C4): no clock means no proof of rest yet.
  if (record.lastOutputAt === null) {
    return false
  }
  return Date.now() - record.lastOutputAt >= quiescenceMs
}

/**
 * Tier 3, cold start: Orca launched a known agent on this PTY, so a quiet non-shell
 * foreground process is an agent still booting, not one sitting at its prompt. Resolving
 * on it is what let `dispatch --inject` write into a TUI that had not yet attached its
 * reader and silently lose the prompt (#9976).
 */
export function quietForegroundProcessProvesTuiIdle(agent: TuiAgent | null | undefined): boolean {
  return !agent
}

export type TuiIdleSatisfactionInput = {
  record: TuiIdleEvidenceRecord
  /** Renderer-synced pane/tab title, when one exists. */
  rendererTitle?: string | null
  /** Tier 1 body evidence: a known ready prompt, or an adopted pane's explicit title.
   *  A thunk because producing it means building the pane's wait text and lowercasing it
   *  (~11us and a multi-KB string on a full tail); the title check below usually answers
   *  first, and then none of that has to happen at all. */
  readPositiveBodyEvidence: () => boolean
  agent: TuiAgent | null | undefined
  firstPartyStatus: FirstPartyAgentStatus
  quiescenceMs: number
}

/**
 * Residual C: `hasSustainedTitleIdle`'s tier-3 verdict was published as the same settlement as
 * tier 2 — a name-only title going quiet and an agent explicitly announcing readiness both read
 * as `satisfied: true`. A pane that just stopped repainting is not proven idle; it went silent.
 *
 * `'observed-idle'`: the agent said so itself (tier 2), or it is one of the agents whose ONLY
 * rest signal is its name going quiet (`nameOnlyIdleNeedsCorroboration` false) — there the
 * documented carve-out promotes sustained silence to a positive verdict because no stronger
 * signal will ever arrive.
 * `'silence'`: an agent that DOES eventually announce rest explicitly (Codex/Devin-style) has
 * only gone quiet so far — corroborated by quiescence, but not the agent's own report.
 * `'not-idle'`: proven still working, or nothing to settle on yet.
 */
export type TuiIdleVerdict = 'observed-idle' | 'silence' | 'not-idle'

/** The one place the three tiers are combined; every satisfaction site routes here. */
export function resolveTuiIdleVerdict(input: TuiIdleSatisfactionInput): TuiIdleVerdict {
  // C5: the veto is consulted first and unconditionally — a fresh first-party working/blocked/
  // waiting status outranks a retained idle title or ready-prompt body regardless of what the
  // screen still shows.
  if (hasFreshWorkingFirstPartyStatus(input.firstPartyStatus)) {
    return 'not-idle'
  }
  // Why the title before the body: both are tier 2, so either settles, but the title is a
  // memoized lookup and the body is a fresh multi-KB scan. Same verdict, cheaper order.
  if (hasExplicitIdleTitle(input.record, input.rendererTitle) || input.readPositiveBodyEvidence()) {
    return 'observed-idle'
  }
  if (!hasSustainedTitleIdle(input.record, input.quiescenceMs)) {
    return 'not-idle'
  }
  return nameOnlyIdleNeedsCorroboration(input.agent, input.record.lastOscTitle)
    ? 'silence'
    : 'observed-idle'
}

/** A settlement site has already gated on `verdict !== 'not-idle'` by the time it builds a
 *  result; narrows for the builders, which only accept the two settleable tiers. */
export function tuiIdleVerdictToEvidence(
  verdict: TuiIdleVerdict
): 'observed-idle' | 'silence' | undefined {
  return verdict === 'not-idle' ? undefined : verdict
}
