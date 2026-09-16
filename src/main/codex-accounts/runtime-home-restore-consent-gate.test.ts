import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createStore,
  getRuntimeCodexAuthPath,
  getSystemCodexAuthPath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

function getRuntimeLogoutMarkerPath(): string {
  return join(testState.userDataDir, 'codex-runtime-home', 'system-default-runtime-logout.json')
}

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

  // G3: the no-consent branch's own comment says it must never read or write the credential, but
  // it called persistRuntimeLogoutMarker() with its default argument (readSystemDefaultAuth()),
  // copying ~/.codex/auth.json verbatim into system-default-runtime-logout.json.
  it('never persists the real ~/.codex credential into the logout marker without consent', async () => {
    writeFileSync(getSystemCodexAuthPath(), '{"tokens":{"refresh_token":"top-secret"}}\n', 'utf-8')
    const store = createStore(createSettings({ codexCredentialMirrorConsent: false }))

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    ;(service as unknown as RestoreSystemDefaultSnapshotAccessible).restoreSystemDefaultSnapshot({
      detectExternalLogin: true
    })

    const markerPath = getRuntimeLogoutMarkerPath()
    expect(existsSync(markerPath)).toBe(true)
    const marker: { systemDefaultAuthJson: string | null } = JSON.parse(
      readFileSync(markerPath, 'utf-8')
    )
    expect(marker.systemDefaultAuthJson).toBeNull()
  })

  // Finding 10 (round4-opus, material deviation 10): syncForCurrentSelection's sibling branch
  // (reached once a prior consented sync already set lastWrittenAuthJson) called
  // persistRuntimeLogoutMarker() with no consent check at all, unlike the branch six lines above
  // it (passes null explicitly) and the one below it (gated on hasCredentialMirrorConsent()).
  it('never persists the real ~/.codex credential into the logout marker on a later sync after consent is revoked', async () => {
    writeFileSync(getSystemCodexAuthPath(), '{"tokens":{"refresh_token":"top-secret"}}\n', 'utf-8')
    const store = createStore(createSettings({ codexCredentialMirrorConsent: true }))

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    // Why: a prior consented sync (construction, above) seeded lastWrittenAuthJson.
    expect(existsSync(runtimeAuthPath)).toBe(true)

    store.updateSettings({ codexCredentialMirrorConsent: false })
    rmSync(runtimeAuthPath, { force: true })
    service.syncForCurrentSelection()

    const markerPath = getRuntimeLogoutMarkerPath()
    expect(existsSync(markerPath)).toBe(true)
    const marker: { systemDefaultAuthJson: string | null } = JSON.parse(
      readFileSync(markerPath, 'utf-8')
    )
    expect(marker.systemDefaultAuthJson).toBeNull()
  })
})
