# Open residuals

## Agent status: renderer second writer

Closed in this increment: `buildMirroredAgentStatusPatch`
(`src/renderer/src/runtime/web-session-tabs-sync/agent-status-patch.ts:101-141`)
no longer lets a client row outrank a host row by wall clock alone. A host
row is replaced only by a proven, fresh, client-owned row the host does not
pierce (`isFencedClientAgentStatus` + `!hostAgentStatusPiercesClientAuthority`,
`agent-status-primitives.ts:59-81`); the `existing.updatedAt > entry.updatedAt`
arm is gone.

**Premise correction (2026-09-15):** this section previously said closing the
residual "requires the remote host ingesting its own OSC bytes into its hook
store." That already shipped in PR 1b — `orca-runtime-on-pty-data.ts` parses
OSC 9999 out of every PTY chunk ungated, and both hosts
(`main-process-runtime-service.ts`, `orcad-entry.ts`) wire
`onTerminalAgentStatus: (event) => agentHookServer.ingestTerminalStatus(event)`.
What was actually missing was (a) a capability so a client can tell a host is
new enough to trust its published row, and (b) the client's willingness to
stop writing. status-A (below) closes the structured half of (b) outright —
no capability needed, since a structured row never crosses the runtime wire.
status-B adds the capability for (a) — advertised and probed, wired to
nothing yet. Consuming it to close the remote-OSC half of (b) is the next
increment.

Left open before status-A/status-B: the renderer wrote authoritative rows
itself for some panes, rather than only subscribing to the host's one store
(`docs/reference/agent-status-store.md`'s "the execution host owns agent
status, in one store" rule). Two of the original four call sites (status-D,
this increment):

- `src/renderer/src/lib/background-agent-status-consumer.ts` and
  `src/renderer/src/lib/automation-session-observer.ts` no longer write
  `setAgentStatus` at all — main's OSC 9999 ingest is unconditional
  (`src/main/runtime/orca-runtime-on-pty-data.ts:37`, no kill-switch check),
  so the `!mainOwnsAgentStatusWrites`-gated write in each was always a
  duplicate for local panes and is now deleted outright; each keeps only its
  `onAgentStatus` callback for automation completion tracking. **Residual
  risk accepted, not closed**: for a **remote-runtime** pty reaching either
  path (bytes never transit local main at all), or a **local pty with the
  kill switch explicitly off**, deleting the write leaves the pane's OSC
  status unwritten by anyone through these two entry points — a real
  regression versus before this increment for those two specific cases,
  scoped narrower than the general residual below. `direct-ssh-retry-status.ts`
  is unaffected (still fenced, see below).

Remaining two call sites:

- `src/renderer/src/components/terminal-pane/pty-connection/direct-ssh-retry-status.ts:146-211`
  — `handleRendererOwnedAgentStatus` writes `setAgentStatus` straight from the
  client's own OSC parse whenever `shouldOwnAgentStatusInRenderer` is true.
  **Closed by status-C** (see below) — gated on `hostOwnsRemoteAgentStatus`.
- `src/renderer/src/components/native-chat/StructuredAgentSessionStatusBridge.tsx:185`
  — the structured-session chat bridge called `store.setAgentStatus` itself.
  **Closed by status-A** for every locally-owned worktree: main now forwards
  structured rows over `agentStatus:set` like any hook row, and the bridge's
  `projectStatus` is a no-op there (it stays exactly as it was for a
  remote-owned worktree's session — see status-A's commit for why: IPC is
  local main↔renderer only, so a remote host's structured row has no other
  channel to this client).

### status-A — structured sessions are host-published

Removed the half-migration seam: the two filters
(`src/main/ipc/agent-hooks.ts`'s `getSnapshot` filter and
`src/main/startup/main-window-agent-status.ts`'s early return on
`structuredHost`) are gone, `server-ingest-structured.ts` now projects
`subagents` and `sessionBoundary: false` onto the row, `dropStructuredStatus`
uses `clearPaneState` (so a session the host stops holding reaches the
renderer as a real `agentStatus:clear` instead of stranding), and the
applicator maps `structuredHost: 'owned'` → `structuredHostOwned: true` and
stamps `terminalResumeEligible: false` whenever `structuredHost` is present.

Bug found and fixed along the way: a structured pane key
(`structured-agent-session-<uuid>:<leaf>`) has no `tabsByWorktree` entry —
that map is PTY terminals only — and it never carries a `terminalHandle` or
`orchestration` context, so it could never satisfy
`hasRuntimeBackedWorktreeAttribution`'s fallback either. Without a fix, every
host-published structured row would have queued as permanently unattributed
and never reached the store. `agent-status-pane-routing-index.ts` now also
indexes agent-session tabs from `unifiedTabsByWorktree` and treats a
structured pane key as existing when its tab is there.

`terminalTitle` decision (the one deliberate content regression): the host
cannot mint a tab's label, so a host-published structured row carries no
`terminalTitle` and `resolveAgentStatusTerminalTitle` falls back to a
synthesized title. This only reaches display for a row with no live tab
(`worktree-agent-row-fallback-tab.ts`, mobile/`worktree ps` projections) — a
sidebar row for an open chat tab renders the tab's own label directly, not
`entry.terminalTitle`. Accepted rather than plumbed through, because doing so
would require publishing renderer-only tab-label knowledge to a headless host.

### status-B — the capability, advertised and probed, wired to nothing

`AGENT_STATUS_HOST_OSC_INGEST_RUNTIME_CAPABILITY = 'agent-status.host-osc-ingest.v1'`
is in `src/shared/protocol-version.ts` and `RUNTIME_CAPABILITIES`, and
`hostOwnsRemoteAgentStatus(environmentId)`
(`src/renderer/src/runtime/agent-status-host-osc-ingest-capability.ts`) probes
it. Nothing calls the helper yet — remote-runtime panes still write their own
OSC-derived rows unconditionally (see the still-open bullet above). The
cross-version harness needed no change: neither
`cross-version-terminal-wire.unit.test.ts` nor
`cross-version-agent-session-wire.unit.test.ts` hardcodes today's
`RUNTIME_CAPABILITIES` list — the latter already derives the old build's
advertised list from its own checkout, which is what the wire doc's "never
write down what the old side has" rule asks for.

Cost of closing the still-open bullets: every remote-runtime pane's status
would gain the latency of one host round trip before the client shows a
transition, since the client could no longer paint directly from its own
byte stream.

Related non-store reader, also out of scope here: the title-derived status
lane in `src/main/runtime/runtime-worktree-status-projection.ts:60`
(`getDetectedWorktreeStatus`, fed by `detectAgentStatusFromTitle`) and
`src/renderer/src/components/sidebar/worktree-title-derived-agent-rows.ts`
reconstruct status by pattern-matching terminal titles instead of reading the
store. `tui-idle` evidence is already de-authorized from that lane — see the
tier ranking in `src/main/runtime/tui-idle-evidence.ts` (tier 1/2 vs. the
tier-3 name-only-title hold-out at `:62-96`).

Additional renderer writer the Claude review located (2026-09-15), unchanged by Odin and not in the four above:
`src/renderer/src/components/terminal-pane/pty-connection/title-spawn-bell.ts:105-189` computes `working`/`done`
status from renderer-observed PTY title bytes for the `command-code` pseudo-agent and writes it with `setAgentStatus`.
A full enumeration is `grep -rn "setAgentStatus(" src/renderer --include='*.ts' --include='*.tsx' | grep -v test`;
only `hooks/ipc-events/agent-status-event-applicator.ts` is store-derived. The closing plan above applies to every
site in that list.

Partially closed (status-D, this increment): the command-code writer above is now conditional, not deleted. Main's
`orca-runtime-create-terminal-side-effect-command-code-detector.ts` ports the renderer's done-settle window
(`src/main/runtime/command-code-done-settle.ts`) and ingests `working`/settled `done` through
`agentHookServer.ingestTerminalStatus` — the same sink the OSC path uses — whenever the pane is local and the
`terminalMainSideEffectAuthority` kill switch is on. `title-spawn-bell.ts`'s and
`parked-terminal-command-status.ts`'s command-code seed/settle functions are **not** deleted: they remain the only
writer for a kill-switch-off local pane and for a remote-runtime pane (`direct-ssh-retry-status.ts`'s
`commandCodeOutputStatusDetector`, created only when `!session.mainSideEffectAuthority`), both out of scope here.
The renderer's `terminal-keydown-fit.ts` and `parked-terminal-byte-watcher.ts` fact-consumer registrations now omit
`onCommandCodeWorking`/`onCommandCodeDone` exactly when `mainSideEffectAuthority` is true, so main's direct ingest
and the renderer's byte-parser fallback never both write the same pane. `agent-status-event-applicator.ts` gained a
`dropsCommandCodeAgentStatus` ownership filter (`agent-status-command-code-ownership-filter.ts`) so a command-code
row main observed cannot overwrite a pane a different foreground/retained/launch agent owns — main has no visibility
into that renderer-only state, so filtering stays client-side per §3.2(b) of the renderer-writer plan.
