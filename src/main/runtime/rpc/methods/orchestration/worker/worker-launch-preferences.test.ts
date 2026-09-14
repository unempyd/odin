import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from '../../../../../../shared/agent-session-option-catalog'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import type { DiscoverCommitMessageModelsResult } from '../../../../../text-generation/commit-message-text-generation'
import {
  assertWorkerLaunchPreferencesCreateTerminal,
  assertWorkerLaunchPreferencesRuntimeSupported,
  createPendingWorkerLaunchReceipt,
  resolveFederatedWorkerLaunchReceipt,
  resolveWorkerLaunchPreferences,
  type ClaudeLaunchModelDiscovery
} from './worker-launch-preferences'
import { WorkerStartParams } from './worker-start-schema'

/** A fresh function reference each call, matching how production tags one
 *  process-lifetime probe by executor identity — each test gets its own,
 *  never sharing a cached result with another test's stub. */
function claudeProbeAccepting(
  models: { id: string; thinkingLevels?: string[] }[]
): ClaudeLaunchModelDiscovery {
  const capabilityModels = models.map((model) => ({
    id: model.id,
    label: model.id,
    ...(model.thinkingLevels
      ? { thinkingLevels: model.thinkingLevels.map((id) => ({ id, label: id })) }
      : {})
  }))
  return async (): Promise<DiscoverCommitMessageModelsResult> => ({
    success: true,
    capability: {
      id: 'claude',
      label: 'Claude',
      modelSource: 'dynamic',
      models: capabilityModels,
      defaultModelId: models[0]?.id ?? ''
    },
    models: capabilityModels,
    defaultModelId: models[0]?.id ?? '',
    catalogOrigin: 'probe'
  })
}

function claudeProbeUnavailable(error: string): ClaudeLaunchModelDiscovery {
  return async (): Promise<DiscoverCommitMessageModelsResult> => ({ success: false, error })
}

describe('orchestration worker launch preferences', () => {
  it('verifies the requested Claude model and effort against the installed CLI', async () => {
    // Why: issue #10846 — `effective` must come from the installed CLI, never a
    // clone of `requested`. The probe stub stands in for discoverModelsLocal
    // (the existing local discovery executor), so no real CLI is spawned.
    await expect(
      resolveWorkerLaunchPreferences({
        agent: 'claude',
        model: 'aws-bedrock-opus-5',
        effort: 'high',
        discoverClaudeModels: claudeProbeAccepting([
          { id: 'aws-bedrock-opus-5', thinkingLevels: ['low', 'medium', 'high'] }
        ])
      })
    ).resolves.toEqual({
      preferences: { model: 'aws-bedrock-opus-5', effort: 'high' },
      receipt: {
        requested: { agent: 'claude', model: 'aws-bedrock-opus-5', effort: 'high' },
        effective: { agent: 'claude', model: 'aws-bedrock-opus-5', effort: 'high' },
        source: 'probe'
      }
    })
  })

  it('rejects a model/effort the installed Claude CLI does not accept, with the CLI-sourced reason', async () => {
    // Why: 'max' passes the static catalog's extended effort choices (so this
    // exercises the PROBE's rejection, not the earlier catalog check) but the
    // stubbed installed CLI only reports low/medium/high for this model.
    await expect(
      resolveWorkerLaunchPreferences({
        agent: 'claude',
        model: 'aws-bedrock-opus-5',
        effort: 'max',
        discoverClaudeModels: claudeProbeAccepting([
          { id: 'aws-bedrock-opus-5', thinkingLevels: ['low', 'medium', 'high'] }
        ])
      })
    ).rejects.toThrow('does not accept effort "max"')

    await expect(
      resolveWorkerLaunchPreferences({
        agent: 'claude',
        model: 'not-a-real-model',
        discoverClaudeModels: claudeProbeAccepting([{ id: 'aws-bedrock-opus-5' }])
      })
    ).rejects.toThrow('does not list model "not-a-real-model"')
  })

  it('falls back to unverified (not a clone) when the installed CLI cannot be asked', async () => {
    await expect(
      resolveWorkerLaunchPreferences({
        agent: 'claude',
        model: 'aws-bedrock-opus-5',
        discoverClaudeModels: claudeProbeUnavailable('claude not found on PATH.')
      })
    ).resolves.toEqual({
      preferences: { model: 'aws-bedrock-opus-5' },
      receipt: {
        requested: { agent: 'claude', model: 'aws-bedrock-opus-5', effort: null },
        effective: null,
        source: 'unverified',
        unverifiedReason: 'claude not found on PATH.'
      }
    })
  })

  it('does not invent an effort when only a model is requested', async () => {
    await expect(
      resolveWorkerLaunchPreferences({ agent: 'codex', model: 'gpt-5.6-sol' })
    ).resolves.toMatchObject({ preferences: { model: 'gpt-5.6-sol' } })
  })

  it.each([
    {
      model: 'gpt-5.6-sol',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      rejected: ['future-effort']
    },
    {
      model: 'gpt-5.6-terra',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      rejected: ['future-effort']
    },
    {
      model: 'gpt-5.6-luna',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      rejected: ['ultra', 'future-effort']
    },
    {
      model: 'gpt-5.5',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      rejected: ['max', 'ultra', 'future-effort']
    },
    {
      model: 'gpt-5.2-codex',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      rejected: ['max', 'ultra', 'future-effort']
    },
    {
      model: 'gpt-5.4',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      rejected: ['max', 'ultra', 'future-effort']
    },
    {
      model: 'gpt-5.4-mini',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      rejected: ['max', 'ultra', 'future-effort']
    },
    {
      model: 'gpt-5.3-codex-spark',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      rejected: ['max', 'ultra', 'future-effort']
    },
    {
      model: 'future-codex-model',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      rejected: ['max', 'ultra', 'future-effort']
    }
  ])('enforces the Codex effort ceiling for $model', async ({ model, accepted, rejected }) => {
    const catalog = getAgentSessionOptionCatalog('codex')!
    const effort =
      catalog.models
        .find((candidate) => candidate.id === model)
        ?.options.find((option) => option.id === 'effort') ??
      catalog.unknownModelOptions?.find((option) => option.id === 'effort')

    expect(effort?.kind.type).toBe('select')
    expect(
      effort?.kind.type === 'select' ? effort.kind.choices.map(({ value }) => value) : []
    ).toEqual(accepted)

    for (const effortValue of accepted) {
      // Why: Codex has no live probe wired here (see worker-launch-preferences.ts) —
      // its own commit-message probe's effort vocabulary doesn't match this
      // per-model ceiling table — so it stays on the static catalog, labeled
      // 'catalog' rather than silently pretending to be verified.
      await expect(
        resolveWorkerLaunchPreferences({ agent: 'codex', model, effort: effortValue })
      ).resolves.toMatchObject({
        preferences: { model, effort: effortValue },
        receipt: { source: 'catalog' }
      })
    }
    for (const effortValue of rejected) {
      await expect(
        resolveWorkerLaunchPreferences({ agent: 'codex', model, effort: effortValue })
      ).rejects.toThrow(`does not support effort ${effortValue}`)
    }
  })

  it('rejects effort without a model', async () => {
    await expect(
      resolveWorkerLaunchPreferences({ agent: 'codex', effort: 'high' })
    ).rejects.toThrow('--effort requires --model')
  })

  it('rejects model selection for agents without a launch catalog', async () => {
    await expect(
      resolveWorkerLaunchPreferences({ agent: 'grok', model: 'grok-code-fast-1' })
    ).rejects.toThrow('does not support launch-time model selection')
  })

  it('does not expose deprecated Gemini model selection to worker-start', async () => {
    await expect(
      resolveWorkerLaunchPreferences({ agent: 'gemini', model: 'gemini-3-pro-preview' })
    ).rejects.toThrow('does not support launch-time model selection')
  })

  it('rejects preferences when reusing an existing terminal', () => {
    expect(() =>
      assertWorkerLaunchPreferencesCreateTerminal({
        terminal: 'term_existing',
        model: 'gpt-5.6-sol'
      })
    ).toThrow('cannot be applied when reusing an existing terminal')
  })

  it('requires remote capability support only for explicit preferences', () => {
    expect(() =>
      assertWorkerLaunchPreferencesRuntimeSupported({
        model: 'gpt-5.6-sol',
        capabilities: [],
        serverName: 'windows'
      })
    ).toThrow('does not support worker model or effort overrides')
    expect(() =>
      assertWorkerLaunchPreferencesRuntimeSupported({
        capabilities: [],
        serverName: 'windows'
      })
    ).not.toThrow()
    expect(() =>
      assertWorkerLaunchPreferencesRuntimeSupported({
        model: 'gpt-5.6-sol',
        capabilities: [ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY],
        serverName: 'windows'
      })
    ).not.toThrow()
  })

  it('refuses --retry-of beside --spec, which could only create a fresh Task', () => {
    const parsed = WorkerStartParams.safeParse({
      spec: 'redo it',
      retryOf: 'ctx_prior',
      agent: 'claude',
      from: 'term_coord'
    })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.map((issue) => issue.message)).toContain(
      '--retry-of needs --task <task_id> naming the failed Task; --spec creates a new one'
    )
    expect(
      WorkerStartParams.safeParse({
        task: 'task_1',
        retryOf: 'ctx_prior',
        agent: 'claude',
        from: 'term_coord'
      }).success
    ).toBe(true)
  })

  it('uses the requested launch receipt when an older worker omits it', () => {
    const requested = createPendingWorkerLaunchReceipt({
      agent: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high'
    })

    // Why: this clone is the federated coordinator's last resort before the
    // remote server answers — it never verifies, so it must say so rather than
    // imply the remote confirmed these options (issue #10846).
    expect(resolveFederatedWorkerLaunchReceipt(undefined, requested, true)).toEqual({
      requested: requested.requested,
      effective: requested.requested,
      source: 'unverified',
      unverifiedReason: 'The worker server did not report which launch options it applied.'
    })
    expect(resolveFederatedWorkerLaunchReceipt(undefined, requested, false)).toBe(requested)
  })

  it.each([' custom-model', 'custom-model '])(
    'rejects model ids with surrounding whitespace: %j',
    (model) => {
      expect(WorkerStartParams.safeParse({ task: 'task_1', agent: 'codex', model }).success).toBe(
        false
      )
    }
  )

  it('bounds opaque launch preferences', () => {
    expect(
      WorkerStartParams.safeParse({
        task: 'task_1',
        agent: 'codex',
        model: 'm'.repeat(513)
      }).success
    ).toBe(false)
    expect(
      WorkerStartParams.safeParse({
        task: 'task_1',
        agent: 'codex',
        model: 'custom-model',
        effort: 'e'.repeat(513)
      }).success
    ).toBe(false)
  })

  it('requires exactly one task identity', () => {
    expect(WorkerStartParams.safeParse({ agent: 'codex' }).success).toBe(false)
    expect(
      WorkerStartParams.safeParse({ task: 'task_1', spec: 'new work', agent: 'codex' }).success
    ).toBe(false)
    expect(
      WorkerStartParams.safeParse({ spec: 'new work', agent: 'codex', from: 'term_coord' }).success
    ).toBe(true)
  })
})
