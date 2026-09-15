import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _getRendererOwnedAgentStatusPaneCountForTest,
  isClientAuthoritativeAgentStatusPane,
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests,
  trackRemoteAgentStatusOwnership
} from './renderer-owned-agent-status-registry'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const OTHER_PANE = 'tab-2:22222222-2222-4222-8222-222222222222'
const ENV = 'web-env-1'

describe('renderer-owned agent status registry', () => {
  beforeEach(() => {
    resetRendererOwnedAgentStatusPanesForTests()
  })

  it('is not authoritative until the renderer actually writes status', () => {
    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(false)
    registerRendererOwnedAgentStatusPane(PANE, ENV)
    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(false)
    markRendererOwnedAgentStatusWrite(PANE)
    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(true)
  })

  it('ignores writes for panes that never registered', () => {
    markRendererOwnedAgentStatusWrite(OTHER_PANE)
    expect(isClientAuthoritativeAgentStatusPane(OTHER_PANE)).toBe(false)
    expect(_getRendererOwnedAgentStatusPaneCountForTest()).toBe(0)
  })

  it('cedes authority on teardown and leaks no entry', () => {
    const release = registerRendererOwnedAgentStatusPane(PANE, ENV)
    markRendererOwnedAgentStatusWrite(PANE)
    release()
    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(false)
    expect(_getRendererOwnedAgentStatusPaneCountForTest()).toBe(0)
    // A post-teardown write must not resurrect the claim.
    markRendererOwnedAgentStatusWrite(PANE)
    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(false)
  })

  it('keeps the earned claim across a remount in the same environment', () => {
    registerRendererOwnedAgentStatusPane(PANE, ENV)
    markRendererOwnedAgentStatusWrite(PANE)
    registerRendererOwnedAgentStatusPane(PANE, ENV)
    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(true)
    expect(_getRendererOwnedAgentStatusPaneCountForTest()).toBe(1)
  })

  it('drops the claim when the pane re-registers under another environment', () => {
    registerRendererOwnedAgentStatusPane(PANE, ENV)
    markRendererOwnedAgentStatusWrite(PANE)
    registerRendererOwnedAgentStatusPane(PANE, 'web-env-2')
    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(false)
  })

  it('scopes authority per pane', () => {
    const releasePane = registerRendererOwnedAgentStatusPane(PANE, ENV)
    const releaseOther = registerRendererOwnedAgentStatusPane(OTHER_PANE, ENV)
    markRendererOwnedAgentStatusWrite(PANE)
    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(true)
    expect(isClientAuthoritativeAgentStatusPane(OTHER_PANE)).toBe(false)
    releasePane()
    releaseOther()
    expect(_getRendererOwnedAgentStatusPaneCountForTest()).toBe(0)
  })

  // A replacement mount registers before the superseded pane's dispose runs
  // (use-terminal-pane-lifecycle cleanup), and both share `${tabId}:${leafId}`.
  it('keeps the successor claim when a superseded pane releases late', () => {
    const staleRelease = registerRendererOwnedAgentStatusPane(PANE, ENV)
    markRendererOwnedAgentStatusWrite(PANE)
    registerRendererOwnedAgentStatusPane(PANE, ENV)

    staleRelease()

    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(true)
    expect(_getRendererOwnedAgentStatusPaneCountForTest()).toBe(1)
  })
})

// odin(status-cache-revisit): shouldOwnAgentStatusInRenderer was decided once,
// synchronously, at connection time and never revisited — a cold-start pane kept
// writing (and fencing the host mirror out) for its whole lifetime, and a host
// downgraded mid-session left a stale claim with no writer left at all.
describe('trackRemoteAgentStatusOwnership', () => {
  beforeEach(() => {
    resetRendererOwnedAgentStatusPanesForTests()
  })

  function fakeHostOwnsChangesBus(): {
    subscribe: (environmentId: string, listener: (owns: boolean) => void) => () => void
    emit: (environmentId: string, owns: boolean) => void
  } {
    const listenersByEnv = new Map<string, Set<(owns: boolean) => void>>()
    return {
      subscribe: (environmentId, listener) => {
        let set = listenersByEnv.get(environmentId)
        if (!set) {
          set = new Set()
          listenersByEnv.set(environmentId, set)
        }
        set.add(listener)
        return () => {
          listenersByEnv.get(environmentId)?.delete(listener)
        }
      },
      emit: (environmentId, owns) => {
        for (const listener of listenersByEnv.get(environmentId) ?? []) {
          listener(owns)
        }
      }
    }
  }

  it('cold start: keeps writing until a probe proves the host owns it, then cedes the claim', () => {
    const bus = fakeHostOwnsChangesBus()
    const onOwnershipChange = vi.fn()
    const ownership = trackRemoteAgentStatusOwnership({
      paneKey: PANE,
      environmentId: ENV,
      cachedHostOwns: false, // cold default: unknown -> keep writing
      onOwnershipChange,
      subscribeToHostOwnsChanges: bus.subscribe
    })
    expect(ownership.shouldOwnAgentStatusInRenderer).toBe(true)
    markRendererOwnedAgentStatusWrite(PANE)
    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(true)

    bus.emit(ENV, true)

    expect(onOwnershipChange).toHaveBeenCalledWith(false)
    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(false)
    expect(_getRendererOwnedAgentStatusPaneCountForTest()).toBe(0)
  })

  it('flips back to renderer-owned when a later probe reports a host downgrade', () => {
    const bus = fakeHostOwnsChangesBus()
    const onOwnershipChange = vi.fn()
    const ownership = trackRemoteAgentStatusOwnership({
      paneKey: PANE,
      environmentId: ENV,
      cachedHostOwns: true, // host already proved ownership at connection time
      onOwnershipChange,
      subscribeToHostOwnsChanges: bus.subscribe
    })
    expect(ownership.shouldOwnAgentStatusInRenderer).toBe(false)
    expect(_getRendererOwnedAgentStatusPaneCountForTest()).toBe(0)

    bus.emit(ENV, false)

    expect(onOwnershipChange).toHaveBeenCalledWith(true)
    markRendererOwnedAgentStatusWrite(PANE)
    expect(isClientAuthoritativeAgentStatusPane(PANE)).toBe(true)
  })

  it('ignores a probe resolution that repeats the current verdict', () => {
    const bus = fakeHostOwnsChangesBus()
    const onOwnershipChange = vi.fn()
    trackRemoteAgentStatusOwnership({
      paneKey: PANE,
      environmentId: ENV,
      cachedHostOwns: false,
      onOwnershipChange,
      subscribeToHostOwnsChanges: bus.subscribe
    })

    bus.emit(ENV, false)

    expect(onOwnershipChange).not.toHaveBeenCalled()
  })

  it('stops reacting to probe resolutions and leaks no claim once disposed', () => {
    const bus = fakeHostOwnsChangesBus()
    const onOwnershipChange = vi.fn()
    const ownership = trackRemoteAgentStatusOwnership({
      paneKey: PANE,
      environmentId: ENV,
      cachedHostOwns: false,
      onOwnershipChange,
      subscribeToHostOwnsChanges: bus.subscribe
    })
    markRendererOwnedAgentStatusWrite(PANE)

    ownership.dispose()

    expect(_getRendererOwnedAgentStatusPaneCountForTest()).toBe(0)
    bus.emit(ENV, true)
    expect(onOwnershipChange).not.toHaveBeenCalled()
  })
})
