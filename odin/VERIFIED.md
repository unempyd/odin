# VERIFIED — machinery already closed upstream

Contracts in this file are Orca's own fixes. We did not rebuild them; we ran the
tests that pin them and cite where they live so future changes in this worktree
don't regress them by accident.

## Durable dispatch idempotency and journal recovery (upstream #16904, fixes #15180)

Upstream stablyai/orca PR #16904 ("make multi-agent workflows durable", commit
`06a607a1d7`) closed a crash-recovery gap where a message could be re-sent after
a host restart, or a restarted host could not tell whether a prior send reached
its provider. Four pieces of durable state carry this, verified below.

1. **Mutation receipts** — one wire send per idempotency key
   (`caller_fingerprint` + `request_id`), independent of the RPC transport.
   `src/main/runtime/orchestration/db/mutation-receipts/mutation-receipt-store.ts:9-191`
   (`getOrCreateLocalMutationCallerFingerprint`, `beginMutationReceipt`,
   `completeMutationReceipt`, `checkpointPendingMutationReceipt`).

2. **`operation_unknown` on a pending receipt after restart** — a mutation whose
   receipt is still `pending` when the process comes back never re-executes; the
   caller is told "It will not be sent again."
   `src/main/runtime/rpc/orchestration-mutation-executor.ts:184-212`.

3. **Dispatch capability tokens with `consumer_generation` fencing** — a capability
   minted for one worker incarnation is rejected once that incarnation is
   superseded, so a stale holder cannot act on a dispatch after recovery.
   `src/main/runtime/orchestration/db/dispatch-context/dispatch-capability.ts:8-46`.

4. **Agent-session journal pending→unknown on restart** — an unresolved submission
   left `pending` (or a prior `unknown` not yet `recovered`) is settled `unknown`
   on the fence the restart supplies, never resurrected as re-deliverable.
   `src/main/native-chat/agent-session-journal/journal-pending-submission-recovery.ts:6-30`,
   invariant stated in
   `src/main/native-chat/agent-session-journal/journal-dispatch-doubt-reasons.ts:1-13`:
   "Orca NEVER re-delivers a message under its own id on the strength of an
   `unknown`."

### Tests run (passing)

```
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/runtime/orchestration/mutation-receipt-capacity.test.ts \
  src/main/runtime/rpc/orchestration-mutation-executor.test.ts \
  src/main/native-chat/agent-session-journal/journal-restart-reconciliation.test.ts \
  src/main/native-chat/agent-session-journal/journal-crash-boundary.test.ts \
  src/main/runtime/orchestration/db/lifecycle-transition-boundary.test.ts \
  src/main/runtime/orchestration/lifecycle-caller-edges.test.ts \
  src/main/runtime/orchestration/db/dispatch-context/dispatch-capability.test.ts
```

Result: 7 test files, 48 tests, all passing. Full output:
[`odin/proofs/upstream-durability.verified.txt`](./proofs/upstream-durability.verified.txt).

- `mutation-receipt-capacity.test.ts` — exercises `beginMutationReceipt`'s
  capacity guard (the mutation-receipt store has no dedicated unit-test file of
  its own; its idempotency behavior is also exercised end-to-end by
  `orchestration-mutation-executor.test.ts`).
- `orchestration-mutation-executor.test.ts` — pins `operation_unknown` on replay
  of a pending receipt.
- `journal-restart-reconciliation.test.ts`, `journal-crash-boundary.test.ts` —
  pin `markJournalPendingSubmissionsUnknown` / `markPendingSubmissionsUnknown`
  turning a pending or doubted submission into `unknown` on restart, never
  re-delivering it.
- `lifecycle-transition-boundary.test.ts` — ratchet: no file outside
  `transitionLifecycleWithDb` may write `worker_dispatches`/`dispatch_contexts`/
  `tasks` `state`/`status` directly. Relevant to residuals L/M/N below: any new
  recovery or accounting write must go through the same lifecycle transition
  path.
- `lifecycle-caller-edges.test.ts` — pins which lifecycle edges (e.g.
  `dispatched` → `failed`) are legal for which caller.
- `dispatch-context/dispatch-capability.test.ts` — pins capability
  verification/fencing behavior named in point 3 above.

No code changed for this section; verification only.
