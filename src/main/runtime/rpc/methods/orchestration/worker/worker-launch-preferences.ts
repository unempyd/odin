import type { AgentLaunchPreferences } from '../../../../../../shared/agent-session-host-authority'
import {
  findCatalogModel,
  findCatalogOption,
  getAgentSessionOptionCatalog
} from '../../../../../../shared/agent-session-option-catalog'
import { resolveAgentSessionOptionLaunch } from '../../../../../../shared/agent-session-option-launch'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  discoverCommitMessageModelsLocal,
  type DiscoverCommitMessageModelsResult
} from '../../../../../text-generation/commit-message-text-generation'

export type OrchestrationWorkerLaunchSelection = {
  agent: TuiAgent | null
  model: string | null
  effort: string | null
}

/** How `effective` was determined (issue #10846 — `effective` must never be a
 *  silent clone of `requested`):
 *  - 'probe': the installed CLI was asked (list_models) and accepts this exact
 *    selection.
 *  - 'catalog': no live probe runs for this agent; `effective` is the request
 *    as validated against the static catalog only — an honest label, not a
 *    claim of verification.
 *  - 'unverified': a probe exists but could not be run (not on PATH, timed
 *    out, too much output, ...); `unverifiedReason` carries the CLI/spawn
 *    failure text. The worker still starts on the catalog floor. */
export type OrchestrationWorkerLaunchSource = 'probe' | 'catalog' | 'unverified'

export type OrchestrationWorkerLaunchReceipt = {
  requested: OrchestrationWorkerLaunchSelection
  effective: OrchestrationWorkerLaunchSelection | null
  /** Absent on receipts from an older host, or from a caller that never
   *  verifies (the federated coordinator's own preliminary receipt) — never
   *  assume 'probe' when this is missing. */
  source?: OrchestrationWorkerLaunchSource
  /** Set only when `source` is 'unverified'. */
  unverifiedReason?: string
}

export function createWorkerLaunchReceipt(args: {
  agent: TuiAgent | null
  model?: string
  effort?: string
}): OrchestrationWorkerLaunchReceipt {
  const selection = {
    agent: args.agent,
    model: args.model ?? null,
    effort: args.effort ?? null
  }
  return { requested: selection, effective: { ...selection } }
}

export function createPendingWorkerLaunchReceipt(args: {
  agent: TuiAgent | null
  model?: string
  effort?: string
}): OrchestrationWorkerLaunchReceipt {
  return {
    requested: {
      agent: args.agent,
      model: args.model ?? null,
      effort: args.effort ?? null
    },
    effective: null
  }
}

/** The existing local model-discovery executor (commit-message-model-discovery.ts's
 *  discoverModelsLocal, already wired to spawnSourceControlAgent) — reused here rather
 *  than a new spawner. Test seam: production always passes the real function, whose
 *  identity is the coalescing key below. */
export type ClaudeLaunchModelDiscovery = typeof discoverCommitMessageModelsLocal

type ClaudeLaunchVerification =
  | { outcome: 'accepted' }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'unverified'; reason: string }

// Why: coalesce concurrent/repeated probes for the process lifetime, like
// native-chat-session-option-enrichment.ts's per-(agent,host) cache does. Keying
// on the executor's own identity means production (one stable function reference)
// naturally shares one probe, while each test's fresh stub gets its own entry —
// no explicit reset needed between tests.
const claudeModelProbeByExecutor = new WeakMap<
  ClaudeLaunchModelDiscovery,
  Promise<DiscoverCommitMessageModelsResult>
>()

function probeClaudeModelsOnce(
  discover: ClaudeLaunchModelDiscovery
): Promise<DiscoverCommitMessageModelsResult> {
  let pending = claudeModelProbeByExecutor.get(discover)
  if (!pending) {
    // Why: model discovery is a CLI-binary capability check, not a per-worktree
    // git operation — the default environment is enough to ask "what does the
    // installed CLI accept", so no cwd/wsl routing is threaded through here.
    pending = discover('claude', process.env)
    claudeModelProbeByExecutor.set(discover, pending)
  }
  return pending
}

async function verifyClaudeLaunchSelection(
  model: string,
  effort: string | undefined,
  discover: ClaudeLaunchModelDiscovery
): Promise<ClaudeLaunchVerification> {
  const result = await probeClaudeModelsOnce(discover)
  if (!result.success) {
    return { outcome: 'unverified', reason: result.error }
  }
  const listed = result.models.find((candidate) => candidate.id === model)
  if (!listed) {
    const available = result.models.map((candidate) => candidate.id).join(', ') || 'none'
    return {
      outcome: 'rejected',
      reason: `The installed Claude CLI does not list model "${model}". Available: ${available}.`
    }
  }
  if (effort) {
    const levels = listed.thinkingLevels ?? []
    if (!levels.some((level) => level.id === effort)) {
      const available = levels.map((level) => level.id).join(', ') || 'none'
      return {
        outcome: 'rejected',
        reason: `The installed Claude CLI's "${model}" does not accept effort "${effort}". Available: ${available}.`
      }
    }
  }
  return { outcome: 'accepted' }
}

export async function resolveWorkerLaunchPreferences(args: {
  agent: TuiAgent
  model?: string
  effort?: string
  /** True when the worker will not execute on this host (e.g. `--on` targets a remote/SSH
   *  execution host) -- a probe spawned here cannot speak for what that host's CLI accepts (I1). */
  remotePlacement?: boolean
  /** The agent's configured launch command override, if any. The probe always spawns the plain
   *  CLI, so a custom command changes what actually runs without the probe ever seeing it (I1). */
  agentCommandOverride?: string
  /** Test seam only; production always uses the real local discovery executor. */
  discoverClaudeModels?: ClaudeLaunchModelDiscovery
}): Promise<{
  preferences: AgentLaunchPreferences | undefined
  receipt: OrchestrationWorkerLaunchReceipt
}> {
  if (args.effort && !args.model) {
    throw new OrchestrationError('invalid_argument', '--effort requires --model.')
  }
  if (!args.model) {
    return {
      preferences: undefined,
      // Why an explicit 'catalog' label: nothing was requested to override, so effective trivially
      // equals requested -- but the receipt still must not be a bare clone with no source (I1).
      receipt: { ...createWorkerLaunchReceipt({ agent: args.agent }), source: 'catalog' }
    }
  }

  const catalog = getAgentSessionOptionCatalog(args.agent)
  if (!catalog?.supportsWorkerLaunchPreferences || !catalog.modelApply.launchArgs) {
    throw new OrchestrationError(
      'invalid_argument',
      `Agent ${args.agent} does not support launch-time model selection.`
    )
  }

  if (args.effort) {
    const model = findCatalogModel(catalog, args.model)
    const option =
      findCatalogOption(model, 'effort') ??
      (!model
        ? catalog.unknownModelOptions?.find((candidate) => candidate.id === 'effort')
        : undefined)
    if (
      option?.kind.type !== 'select' ||
      !option.kind.choices.some((choice) => choice.value === args.effort)
    ) {
      throw new OrchestrationError(
        'invalid_argument',
        `Agent ${args.agent} model ${args.model} does not support effort ${args.effort}.`
      )
    }
  }

  const requested = {
    model: args.model,
    ...(args.effort ? { effort: args.effort } : {})
  }
  const resolved = resolveAgentSessionOptionLaunch(args.agent, requested, [], false)
  if (
    resolved.appliedValues.model !== args.model ||
    resolved.appliedValues.effort !== args.effort
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      `Agent ${args.agent} cannot apply the requested worker launch preferences.`
    )
  }

  const preferences: AgentLaunchPreferences = requested

  // Why: only Claude has a live model/effort probe wired here today (issue
  // #10846). Codex has its own commit-message model probe (`codex debug
  // models`), but that catalog's effort vocabulary is uniform per model and
  // does not match the orchestration catalog's per-model effort ceilings in
  // agent-session-option-catalog-claude-codex.ts (e.g. gpt-5.6-sol's
  // 'ultra'), so wiring it here would reject valid effort selections; codex
  // stays on the static catalog with an honest 'catalog' label.
  if (args.agent === 'claude') {
    // Why scoped before probing: the probe always spawns the plain `claude` binary on THIS host
    // (probeClaudeModelsOnce), so its answer only speaks for a launch that actually runs that
    // exact command, here. A remote/SSH placement or a configured command override means the
    // worker will not run what was just probed -- reporting 'probe' there would claim
    // verification of a CLI invocation nothing ever asked (I1).
    const unscopedReason = args.remotePlacement
      ? 'The worker runs on a remote execution host; the local Claude CLI probe cannot verify what it will accept.'
      : args.agentCommandOverride
        ? 'This agent has a custom launch command the local Claude CLI probe did not see.'
        : null
    if (unscopedReason) {
      const base = createWorkerLaunchReceipt({ agent: args.agent, ...preferences })
      return {
        preferences,
        receipt: {
          requested: base.requested,
          effective: null,
          source: 'unverified',
          unverifiedReason: unscopedReason
        }
      }
    }
    const verification = await verifyClaudeLaunchSelection(
      args.model,
      args.effort,
      args.discoverClaudeModels ?? discoverCommitMessageModelsLocal
    )
    if (verification.outcome === 'rejected') {
      throw new OrchestrationError('invalid_argument', verification.reason)
    }
    const base = createWorkerLaunchReceipt({ agent: args.agent, ...preferences })
    return {
      preferences,
      receipt:
        verification.outcome === 'accepted'
          ? { ...base, source: 'probe' }
          : {
              requested: base.requested,
              effective: null,
              source: 'unverified',
              unverifiedReason: verification.reason
            }
    }
  }

  return {
    preferences,
    receipt: {
      ...createWorkerLaunchReceipt({ agent: args.agent, ...preferences }),
      source: 'catalog'
    }
  }
}

export function assertWorkerLaunchPreferencesCreateTerminal(args: {
  terminal?: string
  model?: string
  effort?: string
}): void {
  if (args.terminal && (args.model || args.effort)) {
    throw new OrchestrationError(
      'invalid_argument',
      '--model and --effort cannot be applied when reusing an existing terminal.'
    )
  }
}

export function assertWorkerLaunchPreferencesRuntimeSupported(args: {
  model?: string
  effort?: string
  capabilities?: readonly string[]
  serverName: string
}): void {
  if (
    (args.model || args.effort) &&
    !args.capabilities?.includes(ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY)
  ) {
    throw new OrchestrationError(
      'capability_unsupported',
      `Connected server ${args.serverName} does not support worker model or effort overrides.`
    )
  }
}

export function resolveFederatedWorkerLaunchReceipt(
  remote: OrchestrationWorkerLaunchReceipt | undefined,
  requested: OrchestrationWorkerLaunchReceipt,
  remoteReady: boolean
): OrchestrationWorkerLaunchReceipt {
  if (remote) {
    return remote
  }
  // Why effective: null, not a clone (I1): the remote server never told us what it actually
  // applied (an older remote, or one that answered before its own receipt arrived). Cloning
  // `requested` into `effective` here would look identical to a verified receipt to anything
  // that reads `effective` without also checking `source` -- 'unverified' means there is no
  // effective selection to report, full stop.
  return remoteReady
    ? {
        requested: requested.requested,
        effective: null,
        source: 'unverified',
        unverifiedReason: 'The worker server did not report which launch options it applied.'
      }
    : requested
}
