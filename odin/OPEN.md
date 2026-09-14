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
status, in one store" rule). Four call sites:

- `src/renderer/src/components/terminal-pane/pty-connection/direct-ssh-retry-status.ts:146-211`
  — `handleRendererOwnedAgentStatus` writes `setAgentStatus` straight from the
  client's own OSC parse whenever `shouldOwnAgentStatusInRenderer` is true.
- `src/renderer/src/lib/background-agent-status-consumer.ts:38-63` — the same
  OSC-derived write for a backgrounded/hidden pane, gated on
  `!args.mainOwnsAgentStatusWrites`.
- `src/renderer/src/lib/automation-session-observer.ts:32-66` — the same
  write again for an automation-session PTY reuse observer, gated on
  `!mainOwnsAgentStatusWrites`.
- `src/renderer/src/components/native-chat/StructuredAgentSessionStatusBridge.tsx:185`
  — the structured-session chat bridge still calls `store.setAgentStatus`
  itself; PR 2 in `docs/reference/agent-status-store.md` retires this once
  the main-process structured feed forwards its rows over `agentStatus:set`
  (it does not yet — see the two filters below).

Why it is left open: all four write from bytes/events that never transit the
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
