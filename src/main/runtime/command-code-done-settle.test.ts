import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMMAND_CODE_OUTPUT_DONE_SETTLE_MS,
  _resetCommandCodeDoneSettlesForTest,
  cancelCommandCodeDoneSettle,
  openCommandCodeDoneSettle
} from './command-code-done-settle'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const OTHER_PANE_KEY = 'tab-2:22222222-2222-4222-8222-222222222222'

describe('main command code done settle window', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetCommandCodeDoneSettlesForTest()
  })

  afterEach(() => {
    _resetCommandCodeDoneSettlesForTest()
    vi.useRealTimers()
  })

  it('fires the executor at the deadline', () => {
    const execute = vi.fn()
    openCommandCodeDoneSettle(PANE_KEY, execute)

    vi.advanceTimersByTime(COMMAND_CODE_OUTPUT_DONE_SETTLE_MS - 1)
    expect(execute).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(execute).toHaveBeenCalledOnce()
  })

  // Why: main has no renderer mount/park lifecycle — a park is invisible to
  // this timer, so nothing but an explicit cancel or a fresh working repaint
  // (which callers cancel through) can stop it from completing the turn.
  it('keeps completing a turn that the renderer parks mid-settle', () => {
    const execute = vi.fn()
    openCommandCodeDoneSettle(PANE_KEY, execute)

    vi.advanceTimersByTime(COMMAND_CODE_OUTPUT_DONE_SETTLE_MS - 100)
    // A renderer park/reveal cycle touches no main state at all — simulated
    // here by simply doing nothing before the window elapses.
    vi.advanceTimersByTime(100)

    expect(execute).toHaveBeenCalledOnce()
  })

  it('drops the window when cancelled before the deadline', () => {
    const execute = vi.fn()
    openCommandCodeDoneSettle(PANE_KEY, execute)
    cancelCommandCodeDoneSettle(PANE_KEY)
    vi.advanceTimersByTime(COMMAND_CODE_OUTPUT_DONE_SETTLE_MS * 2)

    expect(execute).not.toHaveBeenCalled()
  })

  it('re-opening replaces the pending window rather than stacking a second one', () => {
    const execute = vi.fn()
    openCommandCodeDoneSettle(PANE_KEY, execute)
    vi.advanceTimersByTime(COMMAND_CODE_OUTPUT_DONE_SETTLE_MS - 100)
    const secondExecute = vi.fn()
    openCommandCodeDoneSettle(PANE_KEY, secondExecute)
    vi.advanceTimersByTime(COMMAND_CODE_OUTPUT_DONE_SETTLE_MS)

    expect(execute).not.toHaveBeenCalled()
    expect(secondExecute).toHaveBeenCalledOnce()
  })

  it('scopes windows per pane key', () => {
    const execute = vi.fn()
    const otherExecute = vi.fn()
    openCommandCodeDoneSettle(PANE_KEY, execute)
    openCommandCodeDoneSettle(OTHER_PANE_KEY, otherExecute)
    cancelCommandCodeDoneSettle(PANE_KEY)
    vi.advanceTimersByTime(COMMAND_CODE_OUTPUT_DONE_SETTLE_MS)

    expect(execute).not.toHaveBeenCalled()
    expect(otherExecute).toHaveBeenCalledOnce()
  })

  it('cancelling an unopened pane key is a harmless no-op', () => {
    expect(() => cancelCommandCodeDoneSettle('never-opened')).not.toThrow()
  })
})
