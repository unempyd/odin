// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithApplyTrackedPtyTitle } from './orca-runtime-apply-tracked-pty-title'
import type {
  RuntimePtyTitleTrackerEntry,
  RuntimePtyWorktreeRecord
} from './runtime-terminal-state-records'
import { createCommandCodeOutputStatusDetector } from '../../shared/command-code-output-status'
import { extractLastOsc7Uri, extractOscScanTail } from '../daemon/osc7-uri-extraction'
import { parseFileUriPathParts } from '../daemon/osc7-file-uri'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import type { ProcessedAgentStatusChunk } from '../../shared/agent-status-osc'
import { mapExplicitAgentStateToRuntimeTerminalStatus } from './runtime-worktree-status-projection'
import {
  cancelCommandCodeDoneSettle,
  openCommandCodeDoneSettle
} from '../../shared/command-code-output-done-settle-window'

type TerminalAgentStatusTarget = {
  source: 'mounted-leaf' | 'pty-record'
  paneKey: string
  tabId?: string
  worktreeId?: string
  connectionId?: string | null
  terminalHandle?: string
}

export class OrcaRuntimeWithCreateTerminalSideEffectCommandCodeDetector extends OrcaRuntimeWithApplyTrackedPtyTitle {
  protected createTerminalSideEffectCommandCodeDetector(
    ptyId: string
  ): NonNullable<RuntimePtyTitleTrackerEntry['commandCodeDetector']> {
    return createCommandCodeOutputStatusDetector({
      startupCommand: this.terminalSpawnCommandsByPtyId.get(ptyId) ?? null,
      onWorking: (prompt) => {
        // Why kept alongside the ingest below: a remote-paired host still
        // forwards this fact over the environment stream, and a kill-switch-off
        // renderer's mounted/parked-pane fact registration still expects it —
        // neither of those consumers is affected by this increment.
        this.recordTerminalSideEffectFact(ptyId, { kind: 'command-code-working', prompt })
        this.ingestCommandCodeWorkingStatus(ptyId, prompt)
      },
      onDone: (prompt) => {
        this.recordTerminalSideEffectFact(ptyId, { kind: 'command-code-done', prompt })
        this.scheduleCommandCodeDoneStatusIngest(ptyId, prompt)
      }
    })
  }

  /** Same local-only kill switch the renderer's byte-parser fallback checks
   *  (`isMainTerminalSideEffectAuthorityForPty`'s local clause) — a
   *  kill-switch-off pane already writes this status itself from its own
   *  scrape, so main ingesting too would double-write it. */
  protected isCommandCodeStatusMainAuthorityEnabled(): boolean {
    return this.store?.getSettings().terminalMainSideEffectAuthority !== false
  }

  /** Same target resolution `emitTerminalAgentStatusEvents` uses for OSC
   *  payloads: mounted leaves first, else the spawn-time PTY record binding. */
  protected resolveTerminalAgentStatusTargets(
    ptyId: string
  ): Map<string, TerminalAgentStatusTarget> {
    const targets = new Map<string, TerminalAgentStatusTarget>()
    const pty = this.ptysById.get(ptyId)
    const connectionId = pty?.connectionId ?? null
    for (const leaf of this.getLeavesForPty(ptyId)) {
      const paneKey = this.makeRuntimePaneKey(leaf)
      targets.set(paneKey, {
        source: 'mounted-leaf',
        paneKey,
        tabId: leaf.tabId,
        worktreeId: leaf.worktreeId,
        connectionId
      })
    }
    if (targets.size === 0 && pty?.paneKey) {
      targets.set(pty.paneKey, {
        source: 'pty-record',
        paneKey: pty.paneKey,
        tabId: pty.tabId ?? undefined,
        worktreeId: pty.worktreeId,
        connectionId
      })
    }
    if (this.onTerminalAgentStatus) {
      for (const target of targets.values()) {
        const terminalHandle = this.getAgentStatusTerminalHandleForPaneKey(target.paneKey)
        if (terminalHandle) {
          target.terminalHandle = terminalHandle
        }
      }
    }
    return targets
  }

  /** Command Code has no working hook, so this is the whole of that turn's
   *  boundary evidence; ingest through the same sink the OSC path uses
   *  (`agentHookServer.ingestTerminalStatus`) so main is the only writer. */
  protected ingestCommandCodeWorkingStatus(ptyId: string, prompt: string): void {
    if (!this.onTerminalAgentStatus || !this.isCommandCodeStatusMainAuthorityEnabled()) {
      return
    }
    for (const target of this.resolveTerminalAgentStatusTargets(ptyId).values()) {
      // Why: a fresh working repaint supersedes any done-settle left over from the prior turn.
      cancelCommandCodeDoneSettle(target.paneKey)
      try {
        this.onTerminalAgentStatus({
          ptyId,
          ...target,
          payload: { state: 'working', prompt, agentType: 'command-code' }
        })
      } catch (err) {
        console.error('[runtime] command-code agent status listener threw', {
          ptyId,
          paneKey: target.paneKey,
          state: 'working',
          err
        })
      }
    }
  }

  /** Command Code keeps rendering the composer while tools run, so only
   *  complete the row if no active repaint arrives during the settle window —
   *  ported from the renderer's command-code-done-settle.ts, keyed by pane. */
  protected scheduleCommandCodeDoneStatusIngest(ptyId: string, prompt: string): void {
    if (!this.onTerminalAgentStatus || !this.isCommandCodeStatusMainAuthorityEnabled()) {
      return
    }
    for (const target of this.resolveTerminalAgentStatusTargets(ptyId).values()) {
      openCommandCodeDoneSettle(target.paneKey, () => {
        if (!this.onTerminalAgentStatus) {
          return
        }
        // Why re-resolved: the settle fires off a timer, not a chunk, so the
        // target captured at schedule time may be stale by the deadline.
        const freshTarget =
          this.resolveTerminalAgentStatusTargets(ptyId).get(target.paneKey) ?? target
        try {
          this.onTerminalAgentStatus({
            ptyId,
            ...freshTarget,
            payload: { state: 'done', prompt, agentType: 'command-code' }
          })
        } catch (err) {
          console.error('[runtime] command-code agent status listener threw', {
            ptyId,
            paneKey: target.paneKey,
            state: 'done',
            err
          })
        }
      })
    }
  }

  protected extractLastOsc7CwdForPty(
    ptyId: string,
    data: string
  ): { path: string; hostname: string } | null {
    const previousTail = this.osc7ScanTailByPtyId.get(ptyId)
    if (!previousTail && !data.includes('\x1b]7;')) {
      return null
    }
    const input = `${previousTail ?? ''}${data}`
    const scanTail = extractOscScanTail(input, 4096)
    if (scanTail.length > 0) {
      this.osc7ScanTailByPtyId.set(ptyId, scanTail)
    } else {
      this.osc7ScanTailByPtyId.delete(ptyId)
    }
    const uri = extractLastOsc7Uri(input)
    const pty = this.ptysById.get(ptyId)
    const pathFlavor = this.pathFlavorForPty(pty)
    return uri
      ? parseFileUriPathParts(uri, {
          pathFlavor,
          remotePosixAuthority: !!pty?.connectionId && pathFlavor !== 'win32',
          wslDistro: pty?.connectionId
            ? undefined
            : (this.wslDistroByPtyId.get(ptyId) ?? pty?.wslDistro ?? undefined)
        })
      : null
  }

  protected recordOsc7MetadataForPty(
    ptyId: string,
    data: string
  ): { cwd: string | null; cwdChanged: boolean } {
    const osc7 = this.extractLastOsc7CwdForPty(ptyId, data)
    const cwd = osc7?.path ?? null
    const cwdChanged =
      cwd !== null && cwd.trim().length > 0 && this.terminalCwdByPtyId.get(ptyId) !== cwd
    if (cwdChanged) {
      this.terminalCwdByPtyId.set(ptyId, cwd)
    }
    if (osc7) {
      if (osc7.hostname) {
        this.terminalFileUriHostnameByPtyId.set(ptyId, osc7.hostname)
      } else {
        this.terminalFileUriHostnameByPtyId.delete(ptyId)
      }
    }
    return { cwd, cwdChanged }
  }

  protected pathFlavorForPty(pty?: RuntimePtyWorktreeRecord | null): 'posix' | 'win32' {
    if (!pty?.connectionId) {
      return process.platform === 'win32' ? 'win32' : 'posix'
    }
    const worktreePath = splitWorktreeIdForFilesystem(pty.worktreeId)?.worktreePath
    return worktreePath && isWindowsAbsolutePathLike(worktreePath) ? 'win32' : 'posix'
  }

  protected emitTerminalAgentStatusEvents(ptyId: string, chunk: ProcessedAgentStatusChunk): void {
    if (chunk.payloads.length === 0) {
      return
    }
    // Why once per chunk and not per payload: the same lookup the renderer-facing IPC boundary
    // runs, and it is the pane's only durable join back to its terminal once the pane key moves.
    const targets = this.resolveTerminalAgentStatusTargets(ptyId)
    for (const payload of chunk.payloads) {
      // Why not gated on a listener: the prompt lifecycle is main's own state, read by
      // terminal waits that run with no status consumer attached.
      this.recordAgentPromptLifecycleState(
        ptyId,
        mapExplicitAgentStateToRuntimeTerminalStatus(payload.state)
      )
      for (const target of targets.values()) {
        if (!this.onTerminalAgentStatus) {
          continue
        }
        try {
          this.onTerminalAgentStatus({
            ptyId,
            ...target,
            payload
          })
        } catch (err) {
          console.error('[runtime] terminal agent status listener threw', {
            ptyId,
            paneKey: target.paneKey,
            state: payload.state,
            agentType: payload.agentType,
            err
          })
        }
      }
    }
  }
}
