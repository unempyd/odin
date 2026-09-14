# VERIFIED — residuals closed upstream, verified by Odin (no code change)

## Nesting depth cap (upstream #16668)

Upstream stablyai/orca PR #16668 landed the nesting-depth cap before this Odin increment started work.
The single choke point is `resolveChildDispatchDepth` in
`src/main/runtime/orchestration/db/dispatch-depth.ts:166-180` — every path that mints a live worker
computes `resolveCreatorDepth(creator) + 1` and throws `OrchestrationError('nested_worker_depth_exceeded', …)`
before a row over `maxDepth` can be created. Depth is derived from the deepest *live* role the creator
currently holds (`resolveCreatorDepth`, dispatch-depth.ts:77-99), taking the max across a local dispatch
row and any live remote attachment so an SSH-federated caller cannot under-report its depth. Self-created
rows (`isSelfCreatedDispatch`, dispatch-depth.ts:47-52) are excluded so bookkeeping against one's own
terminal is not mistaken for delegation. The cap constant and message live in
`src/shared/nested-worker-depth.ts`.

Odin's DIRECTION.md item 1 requires "Explicit nesting depth policy (no accidental fences)." This is
already met by the existing contract — Odin adds nothing here.

Verified by running the three test files that pin this contract:
- `src/main/runtime/orchestration/db/dispatch-depth.test.ts`
- `src/main/runtime/orchestration/nested-worker-depth-migration.test.ts`
- `src/main/runtime/rpc/methods/orchestration/worker/self-dispatch-nesting-depth.test.ts`

Command: `pnpm exec vitest run --config config/vitest.config.ts src/main/runtime/orchestration/db/dispatch-depth.test.ts src/main/runtime/orchestration/nested-worker-depth-migration.test.ts src/main/runtime/rpc/methods/orchestration/worker/self-dispatch-nesting-depth.test.ts`

Result: 3 test files passed, 30 tests passed. Full output saved at
[`odin/proofs/J-nesting-depth.verified.txt`](proofs/J-nesting-depth.verified.txt).
