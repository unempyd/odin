# Open residuals

## Agent status: renderer second writer

Closed in this increment: `buildMirroredAgentStatusPatch`
(`src/renderer/src/runtime/web-session-tabs-sync/agent-status-patch.ts:101-141`)
no longer lets a client row outrank a host row by wall clock alone. A host
row is replaced only by a proven, fresh, client-owned row the host does not
pierce (`isFencedClientAgentStatus` + `!hostAgentStatusPiercesClientAuthority`,
`agent-status-primitives.ts:59-81`); the `existing.updatedAt > entry.updatedAt`
arm is gone.

Left open: the renderer still writes authoritative rows itself for some
panes, rather than only subscribing to the host's one store
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
- `src/renderer/src/components/native-chat/StructuredAgentSessionStatusBridge.tsx:185`
  — the structured-session chat bridge still calls `store.setAgentStatus`
  itself; PR 2 in `docs/reference/agent-status-store.md` retires this once
  the main-process structured feed forwards its rows over `agentStatus:set`
  (it does not yet — see the two filters below).

Why these two are left open: both write from bytes/events that never transit the
local main process — a remote-runtime pane's PTY bytes flow client-to-host
directly, and a structured chat session's turns are host-published over
`agentStatus:set` but main deliberately withholds them so the pane key does
not get two writers at once (the guard is explicit at
`src/main/ipc/agent-hooks.ts:53-57`, filtering
`entry.structuredHost === undefined` out of `getSnapshot`, and again at
`src/main/startup/main-window-agent-status.ts:51-56`, returning early when
`structuredHost` is set on the live push). Deleting the renderer writers
before removing those two filters would just make those panes go blank.
Closing this residual for real requires: the remote host ingesting its own
OSC bytes into its hook store (so the client never has bytes main hasn't
seen), and a capability gate so an old host that cannot do that yet does not
silently starve a paired client — `docs/reference/remote-wire-compatibility.md`
rule 3.

Cost of closing it: every remote-runtime pane's status would gain the
latency of one host round trip before the client shows a transition, since
the client could no longer paint directly from its own byte stream.

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
