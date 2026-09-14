import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createStore,
  getRuntimeCodexAuthPath,
  getSystemCodexAuthPath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

type RestoreSystemDefaultSnapshotAccessible = {
  restoreSystemDefaultSnapshot(options: { detectExternalLogin: boolean }): void
}

// G1: restoreSystemDefaultSnapshot copied ~/.codex/auth.json (or its cached snapshot) into the
// runtime home unconditionally. It is reachable ungated from both switching away from a managed
// account (detectExternalLogin: true) and a system-default-changed marker (detectExternalLogin:
// false). The gate now lives inside the method itself so no future caller can bypass it.
describe('CodexRuntimeHomeService restoreSystemDefaultSnapshot consent gate (G1)', () => {
  beforeEach(() => {
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    teardownRuntimeHomeTest()
  })

  it('leaves runtime auth.json absent, never copied, when switching away without consent', async () => {
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    writeFileSync(runtimeAuthPath, '{"account":"managed"}\n', 'utf-8')
    const store = createStore(createSettings({ codexCredentialMirrorConsent: false }))

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    ;(service as unknown as RestoreSystemDefaultSnapshotAccessible).restoreSystemDefaultSnapshot({
      detectExternalLogin: true
    })

    expect(existsSync(runtimeAuthPath)).toBe(false)
  })

  it('does not copy the system-default auth into the runtime home on a system-default-changed marker without consent', async () => {
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const store = createStore(createSettings({ codexCredentialMirrorConsent: false }))

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    ;(service as unknown as RestoreSystemDefaultSnapshotAccessible).restoreSystemDefaultSnapshot({
      detectExternalLogin: false
    })

    expect(existsSync(runtimeAuthPath)).toBe(false)
  })
})
