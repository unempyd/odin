import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMMAND_CODE_OUTPUT_DONE_SETTLE_MS,
  _resetCommandCodeDoneSettlesForTest,
  cancelCommandCodeDoneSettle,
  openCommandCodeDoneSettle
} from './command-code-output-done-settle-window'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const OTHER_PANE_KEY = 'tab-2:22222222-2222-4222-8222-222222222222'

describe('command code done settle window', () => {
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

/**
 * odin(done-settle-shared): main and the renderer each defined their own
 * `COMMAND_CODE_OUTPUT_DONE_SETTLE_MS = 1500` — two live implementations of
 * the same window with a magic constant that had to be hand-kept in sync.
 * Guard the tree level, not the call site, so a reintroduced duplicate (or a
 * future third copy) fails immediately instead of drifting.
 */
describe('COMMAND_CODE_OUTPUT_DONE_SETTLE_MS declaration boundary', () => {
  const REPOSITORY_ROOT = resolve(__dirname, '..', '..')
  const SCANNED_DIRECTORIES = ['src/main', 'src/renderer', 'src/shared', 'src/relay', 'src/cli']
  const SCANNED_EXTENSIONS = ['.ts', '.tsx']
  const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'out', 'build', '.git'])
  const DECLARATION = /\bCOMMAND_CODE_OUTPUT_DONE_SETTLE_MS\s*=\s*1500\b/

  function isTestFile(path: string): boolean {
    return /\.(?:test|spec)\.tsx?$/.test(path) || path.includes('/__tests__/')
  }

  function collectSourceFiles(root: string): string[] {
    let found: string[] = []
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      return found
    }
    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry)) {
        continue
      }
      const full = join(root, entry)
      if (statSync(full).isDirectory()) {
        found = found.concat(collectSourceFiles(full))
        continue
      }
      if (SCANNED_EXTENSIONS.some((extension) => full.endsWith(extension))) {
        found.push(full)
      }
    }
    return found
  }

  const files = SCANNED_DIRECTORIES.flatMap((directory) =>
    collectSourceFiles(join(REPOSITORY_ROOT, directory))
  )
    .map((file) => relative(REPOSITORY_ROOT, file).split('\\').join('/'))
    .filter((path) => !isTestFile(path))

  it('scans a plausible number of files', () => {
    // A broken root or directory list would make the guard silently vacuous.
    expect(files.length).toBeGreaterThan(1000)
  })

  it('is declared in exactly one file in the tree', () => {
    const declaredIn = files.filter((path) =>
      DECLARATION.test(readFileSync(join(REPOSITORY_ROOT, path), 'utf8'))
    )
    expect(declaredIn).toEqual(['src/shared/command-code-output-done-settle-window.ts'])
  })
})
