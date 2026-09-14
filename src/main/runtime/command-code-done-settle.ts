/**
 * Command Code done-settle window (main-owned).
 *
 * Why: Command Code's TUI keeps rendering the composer while tools run, so a
 * submitted prompt returning to the idle composer only really completed the
 * turn if no active status repaint arrives within this window. Ported from
 * the renderer (`command-code-done-settle.ts`) now that main is the sole
 * writer of command-code status: main has no mount/park lifecycle to survive
 * across (unlike the renderer, whose pane can unmount mid-window), so this
 * drops the renderer version's cross-mount executor handoff and keeps only
 * the timer, keyed by pane.
 */

// Mirrors the renderer's settle window so completion timing is identical
// regardless of which side used to write it.
export const COMMAND_CODE_OUTPUT_DONE_SETTLE_MS = 1500

const timerByPaneKey = new Map<string, ReturnType<typeof setTimeout>>()

/** Opens (or replaces) the pane's pending completion window. */
export function openCommandCodeDoneSettle(paneKey: string, execute: () => void): void {
  cancelCommandCodeDoneSettle(paneKey)
  const timer = setTimeout(() => {
    timerByPaneKey.delete(paneKey)
    execute()
  }, COMMAND_CODE_OUTPUT_DONE_SETTLE_MS)
  timer.unref?.()
  timerByPaneKey.set(paneKey, timer)
}

/** Drops the window when a working repaint supersedes it. */
export function cancelCommandCodeDoneSettle(paneKey: string): void {
  const timer = timerByPaneKey.get(paneKey)
  if (timer !== undefined) {
    clearTimeout(timer)
    timerByPaneKey.delete(paneKey)
  }
}

/** Test-only: drops every pending window so suites cannot leak timers across cases. */
export function _resetCommandCodeDoneSettlesForTest(): void {
  for (const timer of timerByPaneKey.values()) {
    clearTimeout(timer)
  }
  timerByPaneKey.clear()
}
