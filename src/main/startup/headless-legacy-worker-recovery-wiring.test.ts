import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Residual L: dispatch recovery must run on every host start (serve/orcad included), after the
// PTY provider is ready, without a renderer. The desktop app correctly gates recovery on its
// renderer's own startup barrier (app:recoverLegacyWorkerTerminalsForRendererStartup awaits
// firstWindowStartupServicesReady) because a desktop launch always has one; a headless host never
// gets that IPC call at all, so it must trigger the same sweep itself. This pins that both
// headless entry points already do -- a regression here would silently strand crash-recovered
// dispatches on every `orca serve` / orcad restart.
describe('headless legacy worker recovery wiring (residual L)', () => {
  it('orcad (plain Node, no renderer) reconciles legacy worker terminals unconditionally after the PTY runtime is registered', () => {
    const source = readFileSync(resolve(__dirname, '../orcad/orcad-entry.ts'), 'utf8')
    // Why: orcad has no window/renderer concept at all; if it ever grew an Electron import, the
    // "no renderer" premise this test relies on would need re-checking.
    expect(source).not.toMatch(/from ['"]electron['"]/)
    const ptyRegisteredAt = source.indexOf('await registerHeadlessPtyRuntime(')
    const reconcileAt = source.indexOf('await runtime.reconcileLegacyWorkerTerminals()')
    expect(ptyRegisteredAt).toBeGreaterThan(-1)
    expect(reconcileAt).toBeGreaterThan(ptyRegisteredAt)
  })

  it('`orca serve` reconciles legacy worker terminals unconditionally, not gated on the renderer startup barrier', () => {
    const source = readFileSync(resolve(__dirname, 'main-process-runtime-launch.ts'), 'utf8')
    const start = source.indexOf('async function launchServeMode(')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('\nasync function launchDesktopMode(', start)
    expect(end).toBeGreaterThan(start)
    const launchServeMode = source.slice(start, end)

    const ptyProviderReadyAt = launchServeMode.indexOf('await state.localPtyProviderStartupReady')
    const ptyRuntimeRegisteredAt = launchServeMode.indexOf('await registerHeadlessPtyRuntime(')
    const reconcileAt = launchServeMode.indexOf('await runtime.reconcileLegacyWorkerTerminals()')
    expect(ptyProviderReadyAt).toBeGreaterThan(-1)
    expect(ptyRuntimeRegisteredAt).toBeGreaterThan(ptyProviderReadyAt)
    expect(reconcileAt).toBeGreaterThan(ptyRuntimeRegisteredAt)
    // Why: this is the renderer-only barrier the IPC path
    // (app:recoverLegacyWorkerTerminalsForRendererStartup) awaits. Headless serve has no
    // renderer to satisfy it, so the sweep must not depend on it.
    expect(launchServeMode).not.toMatch(/firstWindowStartupServicesReady/)
  })

  it('the desktop launch path relies on the renderer to trigger recovery via IPC, not on this call', () => {
    const source = readFileSync(resolve(__dirname, 'main-process-runtime-launch.ts'), 'utf8')
    const start = source.indexOf('async function launchDesktopMode(')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('\nexport async function initializeMainProcessRuntimeLaunch(', start)
    expect(end).toBeGreaterThan(start)
    const launchDesktopMode = source.slice(start, end)

    // Why documenting the absence: a desktop launch always opens a window, and that renderer
    // calls app:recoverLegacyWorkerTerminalsForRendererStartup once its own startup services are
    // ready (main-process-ipc-bootstrap.ts). If this ever starts appearing here too, the two
    // triggers would race to recover the same Dispatches -- reconcile() is safe to call twice,
    // but the redundancy would mean this comment (and the reasoning above) needs updating.
    expect(launchDesktopMode).not.toMatch(/reconcileLegacyWorkerTerminals/)
  })
})
