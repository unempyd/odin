import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UNVERIFIED_PROCESS_EXIT_CODE,
  isProvenProcessExit
} from '../../../../shared/terminal-exit-cause'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import { setLocalPtyProvider } from '../provider/registry'
import { stopAndWaitPtyFromRuntimeController } from './kill'
import type { PtyRuntimeControllerDeps } from './controller-deps'

const PTY_ID = 'orca-pty-stop-verify'

/**
 * A stop RPC followed by a listing that omits the id is the exact absence
 * shape residual B closed elsewhere (`worker-terminal-process-liveness.ts`):
 * it proves nothing about whether the process died. `stopAndWaitPtyFromRuntimeController`
 * must still tear the pane down, but it must not mint a proven exit from that omission.
 */
describe('stopAndWaitPtyFromRuntimeController: post-stop listing omission', () => {
  afterEach(() => {
    setLocalPtyProvider(new LocalPtyProvider())
  })

  it('reports the unverifiable sentinel, not a proven exit, when the provider never observed the exit', async () => {
    setLocalPtyProvider({ listProcesses: vi.fn(async () => []) } as never)
    const sendPtyExitToRenderer = vi.fn()
    const onPtyExit = vi.fn()
    const markPtyLivenessUnverifiable = vi.fn()
    const deps = {
      runtime: {
        markPtyStopRequested: vi.fn(),
        onPtyExit,
        markPtyLivenessUnverifiable,
        markPtyLivenessLive: vi.fn()
      },
      store: undefined,
      getLocalPtyProviderStartupPromise: () => undefined,
      shutdownProviderAndDetectExit: async () => false,
      rememberSyntheticKillExit: vi.fn(),
      sendPtyExitToRenderer,
      finishPtyShutdown: () => undefined
    } as unknown as PtyRuntimeControllerDeps

    const stopped = await stopAndWaitPtyFromRuntimeController(deps, PTY_ID)

    expect(stopped).toBe(true)
    // Pane cleanup still happens.
    expect(sendPtyExitToRenderer).toHaveBeenCalledTimes(1)
    expect(onPtyExit).toHaveBeenCalledTimes(1)
    // But the evidence must not pass as a proven exit.
    const [, exitCodeSent] = onPtyExit.mock.calls[0]
    expect(isProvenProcessExit(exitCodeSent)).toBe(false)
    expect(exitCodeSent).toBe(UNVERIFIED_PROCESS_EXIT_CODE)
    expect(sendPtyExitToRenderer).toHaveBeenCalledWith(
      expect.objectContaining({ code: UNVERIFIED_PROCESS_EXIT_CODE })
    )
    expect(markPtyLivenessUnverifiable).toHaveBeenCalledWith(PTY_ID, expect.any(String))
  })
})
