import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionStatusState,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import { subagentSnapshotsFromTasks } from '../../../shared/structured-agent-session-subagents'
import { AgentHookServerIngestTerminal } from './server-ingest-terminal'

/**
 * Structured (native chat) sessions have no PTY and no hook script, so nothing else reaches this
 * store for them. The host projects each session's journal into a summary; this is where that
 * summary becomes the same row every other agent has, keyed by the pane key the renderer derives.
 */
export abstract class AgentHookServerIngestStructured extends AgentHookServerIngestTerminal {
  ingestStructuredStatus(summary: AgentSessionStatusSummary): void {
    const paneKey = structuredStatusPaneKey(summary.sessionId)
    // No persisted turn yet: the chat shows nothing, so neither does any status reader.
    if (!summary.status) {
      this.dropStructuredStatus(summary.sessionId)
      return
    }
    if (this.getAgentStatusDisposition(paneKey) !== 'accept') {
      return
    }
    const subagents = subagentSnapshotsFromTasks(summary.backgroundTasks)
    const payload: ParsedAgentStatusPayload = {
      state: structuredAgentSessionStatusState(summary.status),
      prompt: summary.latestPrompt,
      agentType: summary.agent,
      ...(summary.model ? { model: summary.model } : {}),
      ...(summary.toolName ? { toolName: summary.toolName } : {}),
      ...(summary.toolInput ? { toolInput: summary.toolInput } : {}),
      ...(summary.lastAssistantMessage
        ? { lastAssistantMessage: summary.lastAssistantMessage }
        : {}),
      ...(subagents ? { subagents } : {}),
      // A structured session has no PTY session-start/clear boundary; every `done` here is a
      // completed turn the sidebar and worktree ps must count, never the connect/resume no-op
      // the PTY vocabulary uses `sessionBoundary` to suppress.
      sessionBoundary: false
    }
    // The journal clock stamps the evidence so a restart's republish does not read as fresh work.
    this.applyNormalizedStatus(
      {
        paneKey,
        tabId: structuredAgentSessionTabId(summary.sessionId),
        worktreeId: summary.workspaceId,
        connectionId: null,
        structuredHost: summary.hostExecutionOwned ? 'owned' : 'held',
        ...(summary.providerSession ? { providerSession: summary.providerSession } : {}),
        payload
      },
      undefined,
      'structured',
      summary.updatedAt
    )
  }

  /** The host no longer holds the session; its last projection is history the journal keeps.
   *  `clearPaneState`, not `dropStatusEntry`: main is now this pane key's only writer, so the
   *  renderer must receive an `agentStatus:clear` or the row would strand forever — a structured
   *  session has no pane to resume into either, so the drop leaves no resume-identity remnant. */
  dropStructuredStatus(sessionId: string): void {
    this.clearPaneState(structuredStatusPaneKey(sessionId))
  }
}

// The DERIVED pane key the renderer publishes, never the orchestration bearer handle or the minted
// worker pane key: both of those are credentials.
function structuredStatusPaneKey(sessionId: string): string {
  return structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
}
