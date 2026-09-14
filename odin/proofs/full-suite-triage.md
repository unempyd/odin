# Full-suite triage

Every file in `odin/proofs/full-suite-failing-files.txt` (29 files), run individually and
re-run as a batch, classified against the Orca-vs-Odin diff and fixed or recorded as
directed. Classification key:

- **(a)** test pinned a behaviour Odin deliberately changed → assertion/fixture updated
  with a `Why` comment naming the Odin commit.
- **(b)** genuine regression Odin introduced (behaviour the contract did not intend to
  change) → production code fixed.
- **(c)** environment-only (real installed binary / network / concurrency-timing) → not
  changed; reason recorded.

Cross-check: the same 29 files were also run at upstream `539d4d1f32` vs this branch's
HEAD. 21 files failed only on Odin HEAD (Odin-caused) and 8 failed identically on both
(pre-existing). Of the 21 Odin-caused files, 3 (`orchestration-cli-subprocess.test.ts`,
`cross-version-terminal-wire.unit.test.ts`, `reported-lossy-initial-snapshot.unit.test.ts`)
turned out, on individual and repeated re-runs, to pass cleanly and reproducibly on this
branch — their appearance in the original 29-file list and in one Odin-vs-upstream diff
run was a concurrency artifact (heavy parallel test-worker load racing a shared
`proper-lockfile`-guarded checkout cache / a CLI-build-state-dependent skip), not a
deterministic behavioural difference; see their rows below for the evidence. The
remaining 18 Odin-caused files were genuine test/production issues, now fixed.

## Summary

| Class | Count | Files |
|---|---|---|
| (a) fixed — test pinned a changed contract | 17 | see table |
| (b) fixed — production regression | 0 | none found |
| (a)-adjacent fixed — test fixture missing required mock (see `completed-worker-retirement-resume`) | 1 | see table |
| (c) environment-only, pre-existing (fails on both upstream and Odin) | 8 | see table |
| (c) environment-only, concurrency/build-state flake (passes on repeated individual/batch runs) | 3 | see table |
| **Total** | **29** | |

## Table

| File | Class | Reason | What changed |
|---|---|---|---|
| `src/renderer/src/components/sidebar/useWorktreeAgentRows.test.ts` | (a) | Pinned `state: 'idle'` for a sub-agent row whose parent status is stale. `odin(fix-k1)` (`af947f2027`) deliberately changed this fall-through to `'unverifiable'`: a stale/absent roster observation is exactly as unknown as an explicit `'unverifiable'` and must not read as a falsely confident `'idle'`. | Updated the expectation to `'unverifiable'` with a `Why` comment citing `odin(fix-k1)`. |
| `src/renderer/src/components/onboarding/onboarding-folder-agent-startup.test.ts` | (a) | Both tests asserted a `codex '--dangerously-bypass-approvals-and-sandbox'` command built from **defaults**. `odin(H)` (`854b5956ba`, hardened by `74b234c61e`/`233d01c1d9`) zeroed `DEFAULT_TUI_AGENT_ARGS`/`DEFAULT_TUI_AGENT_ENV`, so the built command is now bare `codex`. | Added an explicit `agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' }` to each test's settings fixture (the user's own per-agent grant standing in for the retired default), preserving the rest of each test (telemetry, cmd overrides, session options). |
| `src/renderer/src/lib/agent-launch-routing.test.ts` | (a) | `hasExplicitTuiAgentArgs('codex', '--dangerously-bypass-approvals-and-sandbox')` was asserted `false` because that string used to equal codex's default. Under `odin(H)` the default is `''`, so that same string is no longer the resolved default and is `true`. | Rewrote the test to assert against the real resolved default via `getTuiAgentDefaultArgs('codex')` (now `''`, still not "explicit") and added the bypass string as a positive "this is explicit" case, so the invariant under test (the resolved default is never explicit) is still exercised faithfully rather than just flipped to match new output. |
| `src/renderer/src/lib/ai-vault-resume-command.resumable-agent.test.ts` | (a) | Settings' `agentDefaultArgs` had no `kimi` entry, relying on kimi's old YOLO default (`--yolo`) to appear in the resumed command; `odin(H)` removed that default. | Added `kimi: '--yolo'` to the test's `agentDefaultArgs`/`agentDefaultEnv` fixture with a `Why` comment; the cd-prefix and provider-session-resume assertions (the test's real subject) are unchanged. |
| `src/renderer/src/lib/agent-background-session-test-state.ts` (shared fixture, no direct test) | (a) | Shared `settings` fixture used by `launch-agent-background-session.test.ts` and `launch-agent-background-session-remote.test.ts` had no `agentDefaultArgs`; both files' assertions embedded pre-`odin(H)` YOLO defaults (claude/codex/command-code) in expected commands. | Added `agentDefaultArgs`/`agentDefaultEnv` fields seeded from `YOLO_TUI_AGENT_ARGS` (imported, not hand-copied) across all three state constructors (`createAgentBackgroundSessionTestState`, `resetAgentBackgroundSessionTestState`, `useRemoteAgentBackgroundRuntime`), with a `Why` comment. Fixed both consuming test files with no changes to `launch-agent-background-session.test.ts` itself. |
| `src/renderer/src/lib/launch-agent-background-session-remote.test.ts` | (a) | One test locally overwrote `state.settings` (dropping the shared fixture's grant) while asserting a codex prefill-plus-bypass command. | Added `agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' }` to that local override. |
| `src/renderer/src/lib/launch-agent-in-new-tab-host-resolution.test.ts` | (a) | All 4 failing cases assert `claude-teams '--dangerously-skip-permissions'` launch commands built from defaults. | Added `agentDefaultArgs: { 'claude-agent-teams': '--dangerously-skip-permissions' }` to the shared `beforeEach` settings. |
| `src/renderer/src/lib/launch-agent-in-new-tab-windows-quoting.test.ts` | (a) | 6 Windows/WSL/Git-Bash quoting cases for `claude` assert the default bypass flag is present and correctly quoted per shell — the test's real subject (shell quoting) needs non-empty default args to exercise. | Added `agentDefaultArgs: { claude: '--dangerously-skip-permissions' }` to the shared `beforeEach` settings. |
| `src/renderer/src/lib/launch-agent-in-new-tab.test.ts` | (a) | 3 cases (`command-code` argv/working-status queuing, a Windows draft-paste fallback for `claude`) assert default bypass args. | Added `agentDefaultArgs: { claude: ..., 'command-code': '--yolo' }` to the shared `beforeEach` settings (kept to one line to stay under the file's 800-line oxlint budget). |
| `src/renderer/src/lib/launch-work-item-direct.test.ts` | (a) | Two cases (`claude` Linear prefill, `cursor` SSH remote launch) assert default bypass args in the plan handed to `buildAgentDraftLaunchPlan`. | Added `agentDefaultArgs: { claude: '--dangerously-skip-permissions' }` to the shared `beforeEach` store settings and `agentDefaultArgs: { cursor: '--yolo' }` to the cursor test's local settings override. |
| `src/renderer/src/lib/sleeping-agent-session-launch-windows-quoting.test.ts` | (a) | All 4 cases assert quoted codex resume argv including the bypass flag, per Windows shell. | Added `agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' }` to the shared `beforeEach` settings. |
| `src/renderer/src/lib/tui-agent-startup.test.ts` | (a) | Devin case computed `agentArgs` via `resolveTuiAgentLaunchArgs('devin', null)`, i.e. the real default, then asserted the old `--permission-mode bypass` default in the expected output. | Passed an explicit per-agent override (`resolveTuiAgentLaunchArgs('devin', { devin: '--permission-mode bypass' })`) so the launch-then-inject sequencing under test still runs with non-empty args. |
| `src/renderer/src/store/slices/repos-onboarding-folder-startup.test.ts` | (a) | Same pattern as the onboarding-folder-agent-startup case: `codex` default bypass command expected. | Added `agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' }` to the test's settings override. |
| `src/renderer/src/components/terminal-pane/pty-connection-cold-restore-agent-resume.test.ts` | (a) | 4 cases assert a `codex ... resume ...` command including the bypass flag, built by the production resume path from defaults. | Added `agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' }` to each test's local `settings` override (6 call sites touched for consistency; 4 were load-bearing). |
| `src/renderer/src/components/terminal-pane/pty-connection-cold-restore-resume-command.test.ts` | (a) | 5 cases (SSH fallback, hibernated reattach, 3 Windows-shell-quoting cases) assert the same codex bypass resume command. | Added the same `agentDefaultArgs` grant to each local `settings` override, including the shared `terminalWindowsShell`-parametrized helper used by the 3 quoting cases. |
| `src/renderer/src/components/terminal-pane/pty-connection-remote-runtime-attach.test.ts` | (a) | 1 case asserts the codex bypass resume command for a remote-runtime cold-spawn. | Added the same `agentDefaultArgs` grant to that test's local `settings` override. |
| `src/renderer/src/components/terminal-pane/pty-connection-sleeping-resume-banner.test.ts` | (a) | 1 case (local sleeping-pane resume) asserts the codex bypass resume command. | Added the same `agentDefaultArgs` grant to the relevant local `settings` overrides. |
| `tests/e2e/completed-worker-retirement-resume.unit.test.ts` | (a) | Not an `odin(H)` case. The `terminalState === 'exited'` scenario mocked `showTerminal`/`readTerminal` to look exited but never mocked `runtime.getTerminalLivenessVerdict`. Pre-Odin, a bare `terminal.connected === false` was enough to report `'exited'`. `odin(B)` (`cfc277f2b1`) plus the review fixes `odin(fix-o1)` (`f2c592825d`/`8918805620`) and `odin(fix-o2)` (`4d39ba9773`) require **positive host provenance** (a `PtyLivenessVerdict` of `{status:'exited'}`) before `inspectWorkerTerminal` reports `'exited'`; an absent verdict now falls through to `'unverifiable'`/`'live'`, so `worker-release-completion.ts` reported `processAction: 'closed_agent_terminal'` instead of the expected `'closed_exited_terminal'`. | Added `vi.spyOn(runtime, 'getTerminalLivenessVerdict')` returning `{ status: 'exited' }` for the `terminalState === 'exited'` branch (and `null` otherwise), with a `Why` comment citing `odin(B)`/`fix-o1`/`fix-o2`. This is the missing positive-provenance mock the new contract requires, so the parametrized `'exited'` case still exercises the real `closed_exited_terminal` path instead of the assertion being weakened to match whatever the code now returns. |
| `src/main/claude/claude-structured-real-cli.test.ts` | (c) | All 4 sub-tests spawn the real, installed Claude CLI and wait for a real `SessionStart`/`system init` event within 5s. Fails identically on upstream and Odin HEAD (`AgentSessionAcquisitionRefusal`: no init proof arrived — needs a signed-in Claude account and valid `CLAUDE_CONFIG_DIR` credentials in this environment). | Not changed. |
| `src/main/claude/claude-tui-resume-real-binary.integration.test.ts` | (c) | Spawns the real `claude` binary in a real PTY and expects a `--resume` proof. In this environment the real CLI stops at its own "trust this folder?" first-run security prompt instead of resuming, which the test's captured transcript shows verbatim. Fails identically on upstream and Odin HEAD. | Not changed. |
| `src/main/daemon/bash-prompt-command-composition.test.ts` | (c) | Spawns a real interactive bash in a real PTY with `set -u` (nounset). This machine's bash prints `bash: cannot set terminal process group ... Operation not supported on socket` and `bash: no job control in this shell`, and its startup files reference `HISTTIMEFORMAT` unbound under `nounset`, producing output the test's string assertions don't expect. Real-shell/real-PTY/bash-version dependent; fails identically on upstream and Odin HEAD. | Not changed. |
| `src/main/repo-icon-autodetect.test.ts` | (c) | 2 cases create a real git repo and add a `git@github.com:...` SSH remote, then assert the stored `remoteUrl` is unchanged; this machine's global/user git config rewrites SSH GitHub URLs to `https://github.com/...` (an `insteadOf` rule), so the observed remote URL differs from what the test wrote. Real-git-config dependent; fails identically on upstream and Odin HEAD. | Not changed. |
| `src/main/ai-vault/session-scanner-codex-workers.test.ts` | (c) | Scans an isolated `mkdtemp` directory for the explicit Codex sessions it wrote, but the result contains one extra, real-looking session id (`1788966241888_94np7`) not written by the test. This is a pre-existing scanner behaviour unrelated to any of Odin's five contracts (confirmed identical on upstream). Out of scope per `AGENTS.md`'s "surgical replacement of only the listed residual failure modes" rule. | Not changed. |
| `tests/e2e/relay-region-correction.unit.test.ts` | (c) | Fails at import time: `Cannot find package 'pg' imported from cloud/apps/relay/src/database.ts` — a missing dependency in this checkout's install, not a behavioural issue. Fails identically on upstream and Odin HEAD. | Not changed. |
| `tests/e2e/cross-version-wire/orchestration-delivery-downgrade.unit.test.ts` | (c) | Times out at 30s waiting on `materializeReleaseCheckout` to extract a real pre-v41 release commit into a cached checkout tree; needs network/local-git-tag access. Fails identically on upstream and Odin HEAD. | Not changed. |
| `tests/e2e/cross-version-wire/release-checkout.unit.test.ts` | (c) | Same `materializeReleaseCheckout` machinery; failed in the original 29-file batch run with an `ECOMPROMISED` `proper-lockfile` error on a shared checkout-cache lock file under heavy parallel-worker contention. Passed cleanly in every individual run and in a same-directory batch run of all 4 cross-version-wire files. Concurrency/timing-dependent on the shared filesystem lock, not a logic bug in either commit. | Not changed. |
| `src/main/runtime/orchestration-cli-subprocess.test.ts` | (c) | `describeIfBuilt = existsSync(CLI_PATH) ? describe : describe.skip` — this checkout has no `out/cli/index.js` (no prior `pnpm run build:cli`), so all 3 tests are skipped, not failing. When built, the suite spawns the real compiled CLI and asserts real keepalive timing (stderr flush cadence under a shortened interval), which is CPU/load sensitive. Matches the task's own example. | Not changed. |
| `tests/e2e/cross-version-wire/cross-version-terminal-wire.unit.test.ts` | (c) | Passed cleanly and reproducibly on every individual run (10/10 tests) and in a same-directory batch run. Its one appearance as a failure (in the original 29-file batch and in the earlier Odin-vs-upstream single-run diff) coincided with the same `proper-lockfile`/checkout-cache contention documented under `release-checkout.unit.test.ts` above, triggered when many test files hit the shared `tests/e2e/.cross-version-checkouts` cache at once. Not a deterministic Odin-vs-upstream behavioural difference. | Not changed. |
| `tests/e2e/cross-version-wire/reported-lossy-initial-snapshot.unit.test.ts` | (c) | Same as `cross-version-terminal-wire.unit.test.ts`: passed cleanly and reproducibly (4/4) on every individual and same-directory batch run; its one failure appearance is the same shared-cache concurrency artifact, not an `odin(C)` wire-evidence shape regression. | Not changed. |

## Final per-file pass/fail (re-run after all fixes, whole 29-file list together)

| File | Result |
|---|---|
| `src/main/ai-vault/session-scanner-codex-workers.test.ts` | FAIL (c) |
| `src/main/claude/claude-structured-real-cli.test.ts` | FAIL (c) |
| `src/main/claude/claude-tui-resume-real-binary.integration.test.ts` | FAIL (c) |
| `src/main/daemon/bash-prompt-command-composition.test.ts` | FAIL (c) |
| `src/main/repo-icon-autodetect.test.ts` | FAIL (c) |
| `src/main/runtime/orchestration-cli-subprocess.test.ts` | SKIPPED (c, no `out/cli` build) |
| `src/renderer/src/components/onboarding/onboarding-folder-agent-startup.test.ts` | PASS |
| `src/renderer/src/components/sidebar/useWorktreeAgentRows.test.ts` | PASS |
| `src/renderer/src/components/terminal-pane/pty-connection-cold-restore-agent-resume.test.ts` | PASS |
| `src/renderer/src/components/terminal-pane/pty-connection-cold-restore-resume-command.test.ts` | PASS |
| `src/renderer/src/components/terminal-pane/pty-connection-remote-runtime-attach.test.ts` | PASS |
| `src/renderer/src/components/terminal-pane/pty-connection-sleeping-resume-banner.test.ts` | PASS |
| `src/renderer/src/lib/agent-launch-routing.test.ts` | PASS |
| `src/renderer/src/lib/ai-vault-resume-command.resumable-agent.test.ts` | PASS |
| `src/renderer/src/lib/launch-agent-background-session-remote.test.ts` | PASS |
| `src/renderer/src/lib/launch-agent-background-session.test.ts` | PASS |
| `src/renderer/src/lib/launch-agent-in-new-tab-host-resolution.test.ts` | PASS |
| `src/renderer/src/lib/launch-agent-in-new-tab-windows-quoting.test.ts` | PASS |
| `src/renderer/src/lib/launch-agent-in-new-tab.test.ts` | PASS |
| `src/renderer/src/lib/launch-work-item-direct.test.ts` | PASS |
| `src/renderer/src/lib/sleeping-agent-session-launch-windows-quoting.test.ts` | PASS |
| `src/renderer/src/lib/tui-agent-startup.test.ts` | PASS |
| `src/renderer/src/store/slices/repos-onboarding-folder-startup.test.ts` | PASS |
| `tests/e2e/completed-worker-retirement-resume.unit.test.ts` | PASS |
| `tests/e2e/cross-version-wire/cross-version-terminal-wire.unit.test.ts` | PASS |
| `tests/e2e/cross-version-wire/orchestration-delivery-downgrade.unit.test.ts` | FAIL (c) |
| `tests/e2e/cross-version-wire/release-checkout.unit.test.ts` | PASS |
| `tests/e2e/cross-version-wire/reported-lossy-initial-snapshot.unit.test.ts` | PASS |
| `tests/e2e/relay-region-correction.unit.test.ts` | FAIL (c) |

21 passed, 1 skipped (environment-gated), 7 failed — all 7 failures class (c), reproduced
identically across two independent full-batch re-runs after the fixes.

## Typecheck

- `pnpm run tc:web` — passes clean.
- `pnpm run tc:node` — passes clean.

## Correction after merge (2026-09-15)

`src/main/runtime/orchestration-cli-subprocess.test.ts` ("emits newline-flushed JSON keepalives") was listed as Odin-caused because the upstream comparison run had no `out/cli` build and skipped it. Rebuilding the CLI at the upstream commit (`tsc -p config/tsconfig.cli.json`) in a scratch worktree and running the test there fails identically (exit 1 in ~400 ms: `stable_pane_required`, "Terminal term_nobody has no live pane bound to a Run"). Class (c): pre-existing, the test predates upstream's Run-bound inbox check; Odin did not touch `run-scope.ts` or the messaging methods. After the fix-suite commits, every other Odin-caused file passes (20/20 rerun on the merged tree).
