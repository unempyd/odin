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

The renderer originally wrote authoritative rows itself for four call sites,
rather than only subscribing to the host's one store
(`docs/reference/agent-status-store.md`'s "the execution host owns agent
status, in one store" rule). All four are now resolved: one closed outright
(status-A), one closed for local/SSH and gated on the status-B capability for
remote-runtime (status-D-fix), and one gated on that same capability
(status-C):

- `src/renderer/src/components/native-chat/StructuredAgentSessionStatusBridge.tsx:185`
  — **closed by status-A**. Main now forwards structured rows over
  `agentStatus:set` like any hook row; the bridge's `projectStatus` is a
  no-op for every locally-owned worktree (it stays exactly as it was for a
  remote-owned worktree's session — IPC is local main↔renderer only, so a
  remote host's structured row has no other channel to this client).
- `src/renderer/src/lib/background-agent-status-consumer.ts` and
  `src/renderer/src/lib/automation-session-observer.ts` — **closed for
  local/SSH, gated for remote-runtime (status-D-fix)**. Main's OSC 9999
  ingest is unconditional (`orca-runtime-on-pty-data.ts:37`, no kill-switch
  check), so a local pty's write is always a duplicate and stays deleted —
  **including when `terminalMainSideEffectAuthority` is off**: Odin's
  contract is that the execution host owns status, not that a client setting
  reinstates a second writer, so a kill-switch-off local pane relies on
  main's unconditional OSC ingest exactly like a kill-switch-on one. A
  **remote-runtime** pty (bytes never transit local main at all) restores the
  write, but only for `isRemoteRuntimePtyId(ptyId) &&
  !(await hostOwnsRemoteAgentStatus(runtimeEnvironmentId))` — resolved once,
  asynchronously, by the caller (`launch-agent-background-session.ts`,
  `automation-session-observer.ts` itself) before the consumer starts
  receiving data, per remote-wire-compatibility.md rule 3 ("the client must
  probe, never assume"). A capable host's row makes the write a no-op; an old
  host's pane keeps exactly today's write.
- `src/renderer/src/components/terminal-pane/pty-connection/direct-ssh-retry-status.ts:146-211`
  — **gated (status-C)**. `handleRendererOwnedAgentStatus` still writes
  `setAgentStatus` from the client's own OSC parse, but only when
  `shouldOwnAgentStatusInRenderer` is true, which is now
  `runtimeEnvironmentId !== null && !cachedHostOwnsRemoteAgentStatus(id)`.
  Unlike the two sites above, this decision is made once, **synchronously**,
  at transport creation (never revisited for the pane's lifetime), while the
  capability probe is async — so it reads a small last-known-verdict cache
  (`cachedHostOwnsRemoteAgentStatus`, `agent-status-host-osc-ingest-capability.ts`)
  that defaults to `false` (client keeps writing — today's behavior) until a
  probe resolves, and fires a fresh probe (`primeHostOwnsRemoteAgentStatusCache`)
  so the *next* pane connecting to that environment (or a reconnect) reads a
  warm verdict. The registry fence (`renderer-owned-agent-status-registry.ts`)
  is claimed only when the pane actually owns writing, so a capable host's
  mirror is never fenced out by a pane that stopped claiming it.

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
it. Nothing calls the helper yet as of this increment — status-C and
status-D-fix (below) are the first consumers. The cross-version harness
needed no change: neither
`cross-version-terminal-wire.unit.test.ts` nor
`cross-version-agent-session-wire.unit.test.ts` hardcodes today's
`RUNTIME_CAPABILITIES` list — the latter already derives the old build's
advertised list from its own checkout, which is what the wire doc's "never
write down what the old side has" rule asks for.

Cost of closing them (status-C, status-D-fix): every remote-runtime pane's
status gains the latency of one host round trip before the client shows a
transition, since the client can no longer paint directly from its own byte
stream, once the host advertises the capability.

### status-C — direct-ssh-retry-status.ts stops writing for a capable host

Closes the last of the four call sites. `shouldOwnAgentStatusInRenderer`
(`direct-ssh-retry-status.ts:146`) is now
`runtimeEnvironmentId !== null && !cachedHostOwnsRemoteAgentStatus(id)`
instead of unconditionally `runtimeEnvironmentId !== null`. Because this
decision is made once, synchronously, at transport creation — and a
capability probe is async — `agent-status-host-osc-ingest-capability.ts`
gained a small last-known-verdict cache: `cachedHostOwnsRemoteAgentStatus`
reads it (default `false`, i.e. keep writing, until a probe resolves once for
that environment) and `primeHostOwnsRemoteAgentStatusCache` fires the real
probe so a later pane or reconnect reads a warm verdict. Defaulting to
"unknown → keep writing" rather than the other way is deliberate: the plan's
own caution is that assuming capability on a cold probe would starve a pane
on a healthy remote host that just hasn't answered yet. The registry fence
(`registerRendererOwnedAgentStatusPane`) is claimed only when
`shouldOwnAgentStatusInRenderer` is true, so a capable host's `session.tabs`
mirror is never fenced out by a pane that no longer claims the pane key.

Proof: `odin/proofs/status-C.before.txt` / `.after.txt`.

### status-D-fix — the same gate for the other two remote sites

Item 2 of the status-D increment deleted the `!mainOwnsAgentStatusWrites`
write in `background-agent-status-consumer.ts` and
`automation-session-observer.ts` unconditionally, which was right for local
panes (main's OSC ingest is unconditional) but wrong for a remote-runtime pty
reaching either path: bytes never transit local main for that pty at all, so
an old host publishes no row, and the deleted write was that pane's only
writer. Both sites now restore the write, gated the same way status-C is,
but resolved via a direct `await hostOwnsRemoteAgentStatus(environmentId)`
rather than the sync cache — both call sites' outer functions
(`launchAgentBackgroundSession`, `observeExistingAutomationSession`) are
already `async` and have not yet started consuming PTY data at the point the
gate is decided, so there is no synchronous-decision constraint here and no
need for a cold-probe default: `createBackgroundAgentStatusConsumer` takes
a precomputed `writesRemoteAgentStatusFallback: boolean` instead of resolving
it itself per chunk.

Related non-store reader, also out of scope here: the title-derived status
lane in `src/main/runtime/runtime-worktree-status-projection.ts:60`
(`getDetectedWorktreeStatus`, fed by `detectAgentStatusFromTitle`) and
`src/renderer/src/components/sidebar/worktree-title-derived-agent-rows.ts`
reconstruct status by pattern-matching terminal titles instead of reading the
store. `tui-idle` evidence is already de-authorized from that lane — see the
tier ranking in `src/main/runtime/tui-idle-evidence.ts` (tier 1/2 vs. the
tier-3 name-only-title hold-out at `:62-96`).

### Full writer enumeration (corrected 2026-09-15)

An earlier version of this section said the grep below "applies to every site in that list"
without actually naming every site, and mis-described one of the ranges it did name: it called
`title-spawn-bell.ts:105-189` one command-code title-bytes writer, but that range is two unrelated
functions and only one of them is command-code-specific. This section is the grep, run in full,
with every hit classified — closed, gated, kept-with-reason, or store-derived — so the claim is
true by construction instead of by assertion.

`grep -rn "setAgentStatus(" src/renderer --include='*.ts' --include='*.tsx' | grep -v test` returns
15 call sites in 10 files:

| Site | Classification | Why |
|---|---|---|
| `agent-status-event-applicator.ts:284` | store-derived | The one sink the closing plan feeds: applies a host-published `agentStatus:set` IPC event to the app store. Not a producer. |
| `agent-status-runtime.ts:108` | store-derived | `applyBatchedAgentStatusUpdate`'s internal call to the same store action while batching; not an independent producer. |
| `StructuredAgentSessionStatusBridge.tsx:140` | closed (status-A) | Forwards a host-published structured row. `projectStatus` is a no-op for a locally-owned worktree; unchanged for a remote-owned one, since local IPC is that row's only channel. |
| `direct-ssh-retry-status.ts:211,222` (`handleRendererOwnedAgentStatus`) | gated (status-C) | Writes only while `shouldOwnAgentStatusInRenderer` — `runtimeEnvironmentId !== null && !cachedHostOwnsRemoteAgentStatus(id)` — is true. A capable host's row makes this a no-op. |
| `automation-session-observer.ts:42` | gated (status-D-fix) | Closed outright for local/SSH panes (main's unconditional OSC ingest already covers them); restores the write only for a remote-runtime pty whose bytes never transit local main, per `await hostOwnsRemoteAgentStatus`. |
| `background-agent-status-consumer.ts:55` | gated (status-D-fix) | Same gate and reasoning as the row above. |
| `title-spawn-bell.ts:148`, `:189` (`seedCommandCodeOutputWorkingStatus` and the done-settle callback) | kept-with-reason | Command-code output-scrape family. The only writer for a kill-switch-off local pane and for a remote-runtime pane (`direct-ssh-retry-status.ts`'s `commandCodeOutputStatusDetector`) — `odin(status-D)`'s judgement call #1, below. |
| `parked-terminal-command-status.ts:126`, `:192` | kept-with-reason | The parked-pane equivalent of the pair above; same family, same reason. |
| `title-spawn-bell.ts:105`, `:113` (`applyInitialAgentStatus`, called from `pane-pty-visibility-bind.ts:137`) | kept-with-reason | **Not** the command-code/title-bytes family above, despite sharing a file. Seeds a `working` row from the pane's own launch config (`session.paneStartup.initialAgentStatus`, `origin: 'launch'`) for *any* agent, the instant a pane gains its first PTY — before any host event exists to publish one. Same class as the two sites below; `odin(status-D)`'s judgement call #2 named only the seed-file counterpart of this pair, not this one. |
| `command-code-prompt-status-seed.ts:37` | kept-with-reason | Launch-time seed for a Command Code prompt submitted after the TUI is ready — Command Code has no prompt-submit hook to seed from instead. |
| `launch-agent-background-session.ts:256` | kept-with-reason | Launch-time seed for a hidden-prompt Command Code launch (`origin: 'launch'`, via `observeLaunchIngress()`). Same class as the two rows above. |

**Honest statement this table makes true by construction: the store is not single-writer for local
launch seeds.** Three sites — `title-spawn-bell.ts:105/113`, `command-code-prompt-status-seed.ts:37`,
`launch-agent-background-session.ts:256` — write a `working` row from the renderer's own launch-time
knowledge before any host observation exists, for local panes exactly as much as remote ones. This
is not one of the four call sites the closing plan above covers (host-owned OSC/structured/hook
ingest all require something to have already happened for the host to observe), and no status-A
through status-D-fix increment touches it. Odin's contract is "the execution host owns status once
it observes anything"; a pane's very first frame, before any observation exists, is necessarily
renderer-local.

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

## Agent status: a second cross-machine clock comparison survives residual S

README's row S says a `stateStartedAt` comparison still guards provider-session retention and
that this is written down here; it previously was not. `remapHostAgentStatus`'s caller in
`web-session-tabs-sync/agent-status-patch.ts:105-109` computes
`hostIdentityPredatesCurrentTurn` as `existing.stateStartedAt > entry.stateStartedAt` — the same
shape of comparison residual S removed from the primary ownership decision
(`existing.updatedAt > entry.updatedAt`, `agent-status-patch.ts`'s old wall-clock arm). This one
was not in scope for that fix: it does not decide which row wins (that is `clientOwnsEntry`,
fenced and ownership-gated per the table above); it only decides whether to keep `providerSession`
and `lastAssistantMessage` from the pre-existing entry when the host's incoming row says `done`
but the existing entry does not. A host and client clock disagreeing here does not misattribute
status, only which turn's provider-session detail survives a remap — lower stakes than the
ownership question residual S closed, but still a wall-clock comparison across machines that are
not guaranteed to agree, and still open.
