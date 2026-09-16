import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'

const mocks = vi.hoisted(() => ({
  markCodexProjectTrusted: vi.fn(),
  markCopilotFolderTrusted: vi.fn(),
  markCursorWorkspaceTrusted: vi.fn(),
  markRemoteAgentWorkspaceTrusted: vi.fn(),
  detectRemoteAgents: vi.fn(),
  detectInstalledAgentsWithShellPathHydration: vi.fn()
}))

vi.mock('../agent-trust-presets', () => ({
  markCodexProjectTrusted: mocks.markCodexProjectTrusted,
  markCopilotFolderTrusted: mocks.markCopilotFolderTrusted,
  markCursorWorkspaceTrusted: mocks.markCursorWorkspaceTrusted
}))

vi.mock('../remote-agent-trust-presets', () => ({
  markRemoteAgentWorkspaceTrusted: mocks.markRemoteAgentWorkspaceTrusted
}))

vi.mock('../preflight/agent-detection', () => ({
  detectRemoteAgents: mocks.detectRemoteAgents,
  detectInstalledAgentsWithShellPathHydration: mocks.detectInstalledAgentsWithShellPathHydration
}))

import {
  buildWorktreeStartupForAgent,
  buildWorktreeStartupForDraft,
  markLocalWorktreeTrusted,
  markRemoteWorktreeTrusted
} from './runtime-worktree-agent-startup'

function makeRepo(fields: Partial<Repo>): Repo {
  return {
    id: 'repo-1',
    name: 'repo',
    path: '/srv/repo',
    connectionId: null,
    executionHostId: null,
    ...fields
  } as Repo
}

const settings = {
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {},
  disabledTuiAgents: [],
  defaultTuiAgent: undefined,
  terminalWindowsShell: null
} as never

/** The launched CLI name is the whole decision: `orca` is the relay shim, `orca-ide` is local. */
function launchCliNameFor(repo: Repo): string {
  return buildWorktreeStartupForAgent({
    repo,
    settings,
    agent: 'claude-agent-teams',
    getLaunchPlatform: () => 'linux',
    toSessionOptions: () => undefined
  }).startup.command.split(' ')[0]!
}

describe('buildWorktreeStartupForAgent host resolution', () => {
  // Why two hosts: one SSH fixture passes even when the launch shape is resolved off another
  // host's row, which is the shape of the `ssh:m4air` -> openclaw leak.
  it('drops the Linux-only rename for both spellings of SSH ownership on two hosts', () => {
    expect(launchCliNameFor(makeRepo({ connectionId: 'm4air' }))).toBe('orca')
    expect(launchCliNameFor(makeRepo({ executionHostId: 'ssh:openclaw' }))).toBe('orca')
  })

  it('keeps the Linux rename for a local row carrying a stale connection', () => {
    expect(launchCliNameFor(makeRepo({ connectionId: 'm4air', executionHostId: 'local' }))).toBe(
      'orca-ide'
    )
  })

  it('drops the rename for a runtime host reaching a nested SSH target', () => {
    expect(
      launchCliNameFor(makeRepo({ connectionId: 'nested', executionHostId: 'runtime:vm-1' }))
    ).toBe('orca')
  })

  it('keeps the rename for a runtime host with no nested SSH target', () => {
    expect(launchCliNameFor(makeRepo({ executionHostId: 'runtime:vm-1' }))).toBe('orca-ide')
  })
})

describe('buildWorktreeStartupForDraft agent detection', () => {
  it('probes the SSH host named only by executionHostId instead of this client', async () => {
    mocks.detectRemoteAgents.mockResolvedValueOnce(['claude'])
    mocks.detectInstalledAgentsWithShellPathHydration.mockResolvedValue([])

    const result = await buildWorktreeStartupForDraft({
      repo: makeRepo({ executionHostId: 'ssh:openclaw' }),
      settings,
      draft: 'ship it',
      getLaunchPlatform: () => 'linux'
    })

    expect(mocks.detectRemoteAgents).toHaveBeenCalledWith({ connectionId: 'openclaw' })
    expect(mocks.detectInstalledAgentsWithShellPathHydration).not.toHaveBeenCalled()
    expect(result?.agent).toBe('claude')
  })

  it('probes this client for a local row carrying a stale connection', async () => {
    mocks.detectRemoteAgents.mockClear()
    mocks.detectInstalledAgentsWithShellPathHydration.mockResolvedValueOnce(['claude'])

    const result = await buildWorktreeStartupForDraft({
      repo: makeRepo({ connectionId: 'm4air', executionHostId: 'local' }),
      settings,
      draft: 'ship it',
      getLaunchPlatform: () => 'linux'
    })

    expect(mocks.detectRemoteAgents).not.toHaveBeenCalled()
    expect(result?.agent).toBe('claude')
  })
})

describe('markLocalWorktreeTrusted', () => {
  it('waits for the Codex trust write before resolving', async () => {
    let finish!: () => void
    mocks.markCodexProjectTrusted.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    let settled = false
    const marking = markLocalWorktreeTrusted('codex', '/workspace/app', {
      agentStatusHooksEnabled: true
    }).then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    finish()
    await marking
    expect(mocks.markCodexProjectTrusted).toHaveBeenCalledWith('/workspace/app')
  })

  it('contains a rejected Codex trust write', async () => {
    mocks.markCodexProjectTrusted.mockRejectedValueOnce(new Error('write failed'))

    await expect(
      markLocalWorktreeTrusted('codex', '/workspace/app', { agentStatusHooksEnabled: true })
    ).resolves.toBeUndefined()
  })
})

describe('trust preset writes require the agent-status-hooks consent', () => {
  beforeEach(() => {
    mocks.markCodexProjectTrusted.mockClear()
    mocks.markRemoteAgentWorkspaceTrusted.mockClear()
  })

  it('does not write the local Codex trust preset when consent is absent', async () => {
    await markLocalWorktreeTrusted('codex', '/workspace/app', null)
    expect(mocks.markCodexProjectTrusted).not.toHaveBeenCalled()
  })

  it('does not write the local Codex trust preset when consent is false', async () => {
    await markLocalWorktreeTrusted('codex', '/workspace/app', { agentStatusHooksEnabled: false })
    expect(mocks.markCodexProjectTrusted).not.toHaveBeenCalled()
  })

  it('does not write the remote trust preset when consent is absent', async () => {
    await markRemoteWorktreeTrusted('codex', 'ssh-1', '/workspace/app', undefined)
    expect(mocks.markRemoteAgentWorkspaceTrusted).not.toHaveBeenCalled()
  })

  it('writes the remote trust preset once consent is granted', async () => {
    mocks.markRemoteAgentWorkspaceTrusted.mockResolvedValueOnce(undefined)
    await markRemoteWorktreeTrusted('codex', 'ssh-1', '/workspace/app', {
      agentStatusHooksEnabled: true
    })
    expect(mocks.markRemoteAgentWorkspaceTrusted).toHaveBeenCalledWith({
      preset: 'codex',
      connectionId: 'ssh-1',
      workspacePath: '/workspace/app'
    })
  })
})
