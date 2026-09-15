/**
 * Cross-mount owner of Command Code's done-settle window.
 *
 * Why: park unmounts the pane and reveal disposes the parked watcher, both
 * possibly mid-settle, and neither successor can re-observe the idle composer
 * that opened the window. Owning the deadline here means park cannot strand the
 * row at 'working' and reveal need not complete the turn early; only the row
 * write (routing + title slot) stays with whoever currently owns the pane.
 *
 * The window itself (the constant and the timer bookkeeping) is main's too —
 * see `src/shared/command-code-output-done-settle-window.ts` — this module
 * layers only the renderer-specific concern on top: a pane's writer can
 * change mid-window (park/reveal), which main never needs to handle.
 */
import {
  COMMAND_CODE_OUTPUT_DONE_SETTLE_MS,
  _resetCommandCodeDoneSettlesForTest as _resetSharedCommandCodeDoneSettlesForTest,
  cancelCommandCodeDoneSettle,
  openCommandCodeDoneSettle as openSharedCommandCodeDoneSettle
} from '../../../../shared/command-code-output-done-settle-window'

export { COMMAND_CODE_OUTPUT_DONE_SETTLE_MS, cancelCommandCodeDoneSettle }

type CommandCodeDoneSettleExecutor = (normalizedPrompt: string) => void

const executorByPaneKey = new Map<string, CommandCodeDoneSettleExecutor>()

/** Registers the current writer for this pane; returns its release.
 *  Last registrant wins by design: park and reveal each hand the pane to a new
 *  owner while the predecessor is still registered, so refusing the overwrite
 *  would leave the row with an owner that can no longer write it. */
export function setCommandCodeDoneSettleExecutor(
  paneKey: string,
  execute: CommandCodeDoneSettleExecutor
): () => void {
  executorByPaneKey.set(paneKey, execute)
  return () => {
    // Why identity-checked: on reveal the remounted pane registers before the parked watcher releases.
    if (executorByPaneKey.get(paneKey) === execute) {
      executorByPaneKey.delete(paneKey)
    }
  }
}

export function openCommandCodeDoneSettle(paneKey: string, normalizedPrompt: string): void {
  openSharedCommandCodeDoneSettle(paneKey, () => {
    // Why optional: a pane torn down with no successor has no row worth completing.
    executorByPaneKey.get(paneKey)?.(normalizedPrompt)
  })
}

/** Test-only: drops every pending window so suites cannot leak timers across cases. */
export function _resetCommandCodeDoneSettlesForTest(): void {
  _resetSharedCommandCodeDoneSettlesForTest()
  executorByPaneKey.clear()
}
