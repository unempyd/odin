<p align="center"><img src="odin/odin-logo.svg" alt="Odin" width="120"></p>

# Odin

**Surgical derivative of [Orca](https://github.com/stablyai/orca). Same product surface. Residual orchestration and safety contracts closed.**

Odin is Orca (upstream `stablyai/orca` at `539d4d1f32`, v1.4.197, MIT © Lovecast Inc.) with a small set of patches at the exact sites where Orca still synthesised a verdict from an absence of evidence, or acted on the operator's machine without a recorded grant. Nothing else changed: terminals, worktrees, SSH, mobile, the 36 supported agent CLIs and the UI are Orca's. Every patch is proven the same way: its test fails at the upstream commit and passes here.

```
odin/proof/run-proofs.sh        # reruns every proof test at the upstream commit (must fail) and on Odin (must pass)
odin/proof/real-sessions.mjs    # drives real claude / codex / grok workers through Orca's own orchestration on a headless host
git log --first-parent odin     # one commit per residual, message = residual (file:line) → contract → proof files
```

## Orca residual failure → Odin stricter contract

| # | Orca residual failure (upstream citation) | Odin contract | Proof |
|---|---|---|---|
| A | Retired-incarnation tombstone minted a clean exit: `code: session.exitCode ?? 0` (`src/main/daemon/terminal-host.ts:132`) although `src/shared/terminal-exit-cause.ts:36-45` forbids exactly that; the consumer (`terminal-host-process-inspection.ts:43-63`) published `verdict:'exited'` regardless of the code, and the renderer fired a completion notification on it. Relay twin: `src/relay/pty-handler.ts:2412` hard-coded `code: 0` even for `record-torn-down`. | The exiting session is captured, not re-looked-up; an absent status is `UNVERIFIED_PROCESS_EXIT_CODE`; the inspector publishes `exited` only when `isProvenProcessExit(code)`, else `unverifiable`. The relay applies the same gate (closed by construction: its test pins the extracted mapping, because the record-torn-down race has no deterministic relay harness). | `terminal-host-process-inspection.test.ts` |
| B | Worker liveness read an empty or non-enumerating host answer as death (`src/main/runtime/orchestration/worker-terminal-process-liveness.ts:8-31`); the local provider lists only in-process PTYs and a restarted relay omits every prior id, so `worker-release` settled retained resources whose process was alive ([#3191](https://github.com/stablyai/orca/issues/3191)). | Only a host that enumerated this PTY under a different incarnation may report its death. Empty or unmatched listings are `unverifiable`. | `worker-terminal-process-liveness.test.ts` |
| C | `tui-idle` waits settled on silence: tier-3 "sustained title idle" returned the same `true` as positive evidence (`src/main/runtime/tui-idle-evidence.ts:127-138`; the module's own header calls it "ABSENCE, a last resort"; [#6011](https://github.com/stablyai/orca/issues/6011), roadmap [#15190](https://github.com/stablyai/orca/issues/15190)). A silent worker was declared ready and an automation run declared completed. | Three-valued verdict `observed-idle / silence / not-idle`; the wire result carries `evidence` and `satisfied` is never true on silence; worker start and the automation observer treat silence as not-ready / not-completed; the CLI prints the evidence. Exit waits never settle on a disconnected PTY without a proven exit code. Two deliberate exceptions remain and are named in the module header: an explicit idle marker or ready prompt the agent itself paints is positive evidence, and agents whose only rest signal is their name (grok, copilot, aider, mimo, agy, opencode) settle after the quiescence window rather than never. | `terminal-wait-name-only-idle.test.ts` |
| S | Renderer adjudicated agent status by comparing two machines' wall clocks with no ownership requirement (`src/renderer/src/runtime/web-session-tabs-sync/agent-status-patch.ts:118`); a host `blocked` row lost to a stale client row with a later clock. The main-process copies were already closed upstream (`docs/reference/agent-status-store.md`, PR 1a/1b). | A host row is replaced only by a proven, fresh, client-owned row that the host does not pierce; cross-machine `updatedAt` no longer decides. The renderer is still a second writer for remote-runtime and structured panes, and a `stateStartedAt` comparison still guards provider-session retention; both are written down in `odin/OPEN.md`. | `web-session-tabs-sync-host-authority.test.ts` |
| D | The runtime WebSocket listener widened to `0.0.0.0` on every start once any device had ever paired (`src/main/runtime/runtime-rpc/runtime-rpc-lifecycle.ts:146-158`); nothing ever narrowed it back ([#9963](https://github.com/stablyai/orca/issues/9963)). | Loopback unless a persisted `networkExposureConsent` record is true, read at every bind; pairing refuses to widen without it; flipping it off rebinds the live listener to loopback. `orca serve` and `orcad --bind` remain explicit opt-ins. | `runtime-rpc-websocket-bind-host.test.ts` |
| E | Hooks were written into 14 other tools' user-global configs on boot; `agentStatusHooksEnabled` defaulted to `true` and the check was `!== false`, so an unset or unreadable setting installed (`src/shared/default-global-settings.ts:211`, `managed-agent-hook-controls.ts:40-52`; [#9963](https://github.com/stablyai/orca/issues/9963)). | Default `false`; the gate is `=== true`; an absent, null or unreadable setting installs nothing. | `managed-agent-hook-controls.test.ts` |
| F | New installs were opted in to telemetry without ever seeing the banner (`loaded-cohort-migrations.ts:52-57` wrote `optedIn: true`; the first-launch surface only renders for pre-existing installs). | Fresh installs are opted out. | `persistence-cohort-and-identity-migration.test.ts` |
| G | `~/.codex/auth.json` was copied into an Orca-owned runtime home from the service constructor, on every launch and account switch, with no setting or prompt (`runtime-home-service-auth-sync.ts:9-84`, `runtime-home-service-sync.ts:95`). | `codexCredentialMirrorConsent` (default false) gates the copy primitive itself, so the constructor, account-switch and system-default-changed paths cannot copy without it; unreadable settings deny; any apply with consent false clears the runtime copy and snapshot. Logout bookkeeping stays ungated. | `runtime-home-system-default-mirror-readback.test.ts` |
| H | Permission bypass was the shipped default for 26 agents: `DEFAULT_TUI_AGENT_ARGS = YOLO_TUI_AGENT_ARGS` (`src/shared/tui-agent-launch-defaults.ts:10`), spread into default settings and force-migrated into profiles that never chose it (`terminal-settings-migrations.ts:149-179`; [#9963](https://github.com/stablyai/orca/issues/9963)). | Shipped defaults carry no bypass flag; the migration hydrates keys with empty values; bypass exists only as the payload of the user's own per-agent setting or permission-mode switch. | `constants.test.ts`, `terminal-settings-migrations.test.ts` |
| I | The worker launch receipt's `effective` was a structural copy of `requested` (`worker-launch-preferences.ts:23-33`); model and effort were validated against a table compiled into the binary, never against the installed CLI ([#10846](https://github.com/stablyai/orca/issues/10846), open). | For Claude, `effective` comes from the installed CLI's own `list_models` answer (`source: 'probe'`); a refusal carries the CLI's reason; a probe that cannot run yields `effective: null, source: 'unverified'` with the reason. Codex has no live probe and is labelled `source: 'catalog'`; a federated worker whose host never answered gets `effective: null`, never a copy; a remote or command-overridden placement skips the local probe and is `unverified`. Membership in the CLI's model list proves advertised support, not what the launched session applied. | `worker-launch-preferences.test.ts` |
| K | In-process sub-agents were flattened into fake dispatches: the sidebar fabricated `orchestration: { taskId: 'subagent:<id>', dispatchId: 'subagent:<id>' }` for rows that have no Task or Dispatch anywhere (`worktree-subagent-child-rows.ts:55-60`; [#8251](https://github.com/stablyai/orca/issues/8251)). | Sub-agent rows carry their own `subagent: { id, parentPaneKey }` identity and never masquerade as a dispatch. | `worktree-subagent-child-rows.test.ts` |
| M | Dispatches created by `orchestration dispatch --inject` had no worker row and were invisible to crash recovery (`worker-terminal-recovery.ts:13-27` inner-joins `worker_dispatches`), so after a restart they stayed live with a valid capability forever. | Every active dispatch is reconciled on every host start (wired into the one recovery method `orca serve`, `orcad` and the desktop share): left alone when its terminal is live or the host cannot be asked, failed with `termination_reason: 'unknown'` and its capability revoked only when the owner says the terminal is gone. | `orchestration-unsupervised-dispatch-recovery.test.ts` |
| N | `dispatch_contexts.dispatched_at` was stamped at row creation (a dead duplicate of `created_at`), the observed exit code was dropped before `failDispatch` (`orca-runtime-subscribe-to-terminal-resize.ts:87-90`), and nothing exposed per-attempt wallclock. | `dispatched_at` is written on the pending→dispatched edge, `exit_code` is a column (schema v42), and `worker-show --json` reports `dispatchedAt`, `completedAt`, `wallclockMs`, `exitCode`, `terminationReason`. | `worker-dispatch-accounting.test.ts` |

Verified, not re-implemented (see `odin/VERIFIED.md`): nesting-depth enforcement ([#16668](https://github.com/stablyai/orca/pull/16668)), durable mutation receipts, capability fencing and journal recovery ([#16904](https://github.com/stablyai/orca/pull/16904), fixes [#15180](https://github.com/stablyai/orca/issues/15180)), and the headless recovery sweep that already runs on `orca serve` and `orcad`. Odin pins these with tests so they cannot regress silently.

Left open, with the exact plan and cost written down in `odin/OPEN.md`: the renderer is still a second writer of agent status for remote-runtime panes whose bytes never transit the host.

## Real sessions on this build

`odin/proof/real-sessions.mjs` drives real agent CLIs through Orca's own `orchestration worker-start` on a headless serve host with an isolated profile. Recorded runs (macOS, this checkout; files under `odin/proofs/`):

| Phase | Claude | Codex | Grok | Artifact |
|---|---|---|---|---|
| Safe default: a fresh profile launches every worker with no bypass flag in its argv (`ps` captured live, full command lines) | no bypass; completes because this operator's own Claude config auto-approves | no bypass; stays `dispatched`, never settles | no bypass; the worker fails to start | `real-sessions.2026-09-14T14-29-05-741Z.json` |
| Settle: with the operator's per-agent grant recorded in the profile, the worker reports `worker_done` and the dispatch row settles `completed` with `dispatchedAt`, `completedAt`, `wallclockMs` | 8.7 s | 4.6 s | not run: the operator's Grok account is at its free usage limit | `real-sessions.2026-09-14T15-08-32-250Z.json` |
| Concurrent: two workers started in parallel both settle | 8.6 s | 5.3 s | — | same file |
| Crash: the host is SIGKILLed after `worker-start` has returned (the send is delivered, the receipt completed, the task unsettled) and restarted on the same profile; replaying the same `--retry-request` returns the identical dispatch (one row, no second worker); the worker is still `dispatched`, never falsely exited or completed. The other honest answer, `operation_unknown` for a receipt still pending at the crash, is pinned by upstream's own unit tests (`odin/VERIFIED.md`), not by this driver | pass | pass | pass | `real-sessions.2026-09-14T14-49-45-377Z.json` |

Two things these runs show that a unit test cannot. First, the H1 contract acting on a real profile: a run whose grants were written without `agentBypassDefaultsReviewed` had them cleared on load because they equal Orca's former automatic values verbatim, and the Codex worker parked on its approval prompt instead of settling (`real-sessions.2026-09-14T15-05-30-764Z.json`, kept as evidence). Second, the operator's own agent configuration is outside Odin's contract: the Claude worker completes even in the safe-default phase because this operator's Claude config auto-approves; the argv still carries no flag from Odin.

Not covered: Windows and Linux hosts (macOS only), a third agent settling (Grok quota), and Orca's mobile app paired against an Odin host.

## Independent review

Two independent reviewers were given the same brief (`odin/REVIEW_BRIEF.md`): review this repository against `odin/DIRECTION.md` and `odin/AGENTS.md`, do not rubber-stamp. Codex (`codex exec`, read-only) returned NOT FINISHED with concrete file:line findings; a Claude review ran the consent (D–H) and durability (L, M, N) sections before its session was rate-limited. Every material finding became a `odin(fix-…)` commit with its own failing-first proof:

- injected-dispatch recovery had no production caller (wired into the shared recovery method, runtime-level proof);
- the wallclock reader mis-parsed SQLite timestamps outside UTC (34,201,000 ms for a one-second interval in Adelaide; both ends normalised);
- two credential-copy paths bypassed the consent gate (gate moved into the copy primitive);
- two hook checks were still fail-open (`=== true` everywhere);
- exit waits settled on a disconnected PTY and mapped the unverified exit code to `exited`; tui-idle results accepted missing evidence; the boolean adapter said satisfied on silence (all removed);
- worker observation minted `exited` from absence and read every inspection failure as "missing" (now only the owner's not-found answer counts);
- widen/narrow of the network listener could race (serialised, consent re-read after a widen);
- profiles that inherited Orca's automatic bypass values kept them (one-shot review migration clears values equal to the YOLO table; a user who chose the same value re-enables it once);
- launch receipts still copied `requested` into `effective` in two paths (now `null` when unknown);
- sub-agent rows defaulted to done when nothing was observed (now unverifiable);
- the proof runner accepted any nonzero exit as a reproduction (now requires the named assertion at the upstream commit).

Findings the reviews raised that are deliberately not changed, with the reason: the liveness projection keeps `unattached`, `missing` and `identity_changed` as wire values beside `live / unverifiable / exited` because existing tests pin them as distinct client-facing states; `orca serve` and `orcad --bind` bind wide by explicit operator command; positive on-screen evidence (an explicit idle marker or ready prompt the agent paints) remains tier-1 evidence.

## Deviations at v0.1.0

Stated plainly, because two independent reviews returned NOT FINISHED against `odin/DIRECTION.md`'s definition of done and these are the items that remain open by decision rather than by oversight:

1. **Status is not yet single-writer end to end.** The main-process store is; the renderer still writes rows for remote-runtime and structured panes whose bytes never transit the host, and it still merges client identity fields into host rows. Closing it needs host-side OSC ingest plus a wire capability gate (`odin/OPEN.md`). Odin removed the cross-machine wall-clock adjudication and nothing more.
2. **Settlement keeps two positive-evidence exceptions.** An explicit idle marker or ready prompt the agent itself paints counts as observation (a fresh first-party working status now vetoes it), and agents whose only rest signal is their name (grok, copilot, aider, mimo, agy, opencode) settle after the quiescence window. Removing the second would make `tui-idle` unusable for those agents ([#6011](https://github.com/stablyai/orca/issues/6011)); it is a named trade-off, not the pure "silence is unverifiable" rule.
3. **The wait result is `satisfied` plus `evidence`, not the literal `accepted | refused | unverifiable` type.** The three outcomes are representable and every silence path maps to not-satisfied, but the wire shape is Orca's, kept for compatibility.
4. **Worker observation keeps `unattached`, `missing` and `identity_changed`** beside `live / unverifiable / exited` because clients depend on them as distinct states.
5. **The launch receipt verifies advertised support, not applied options.** `source: 'probe'` means the installed Claude CLI listed the model and effort; nothing reads back what the launched session applied. Codex and Grok have no live probe.
6. **Sub-agent rows carry their own identity but are still renderer-derived** and their synthesized entry state falls back to `done` where the status type has no `unverifiable` member.
7. **Proof coverage is macOS-local.** Windows and Linux process ownership, SSH-hosted worktrees, mixed-version clients, mobile pairing against an Odin host, and a third agent settling (this operator's Grok quota) are not established by the recorded runs.
8. **Retained telemetry opt-ins from Orca's automatic enrollment are preserved** for pre-existing profiles; only fresh installs are opted out.

Everything above is either in `odin/OPEN.md` with a plan, or accepted for v0.1.0 as Orca's existing behaviour.

## How to read the proofs

Each residual is one commit on the `odin` branch. The commit body names the upstream site, the contract, the judgement calls, and two files under `odin/proofs/`: `<id>.before.txt` is the new test failing on the unpatched code, `<id>.after.txt` is the same test and its neighbours passing after the patch. `odin/proof/run-proofs.sh` repeats that check mechanically against the pinned upstream commit. `odin/proofs/real-sessions.*.json` are the recorded runs of real agents through the orchestration surface.

## Credits and licence

Orca is by [Stably AI](https://github.com/stablyai) and Lovecast Inc., MIT. Odin keeps Orca's licence, copyright notice and history; the Odin commits are additive on top of upstream `539d4d1f32`. Odin's own briefs are under `odin/` (`DIRECTION.md`, `AGENTS.md`).

---

# Orca (upstream README, unchanged below)

<h1 align="center">
  <a href="https://onOrca.dev"><img src="resources/build/icon.png" alt="Orca" width="64" valign="middle" /></a> Orca
</h1>

<p align="center">
  <a href="https://github.com/stablyai/orca"><img src="https://img.shields.io/github/stars/stablyai/orca?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub stars" /></a>
  <a href="https://github.com/stablyai/orca/releases"><img src="docs/assets/readme-downloads.svg" alt="Total downloads across all releases" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="License: MIT" />
  <a href="https://discord.gg/fzjDKHxv8Q"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="Join the Orca Discord" /></a>
  <a href="https://x.com/orca_build"><img src="https://img.shields.io/badge/X-000000?logo=x&logoColor=white" alt="Follow Orca on X" /></a>
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square" alt="Supported platforms: macOS, Windows, and Linux" />
</p>

<p align="center">
  <sub><a href="docs/readme/README.zh-CN.md">中文</a> · <a href="docs/readme/README.ja.md">日本語</a> · <a href="docs/readme/README.ko.md">한국어</a> · <a href="docs/readme/README.es.md">Español</a> · <a href="docs/readme/README.fr.md">Français</a> · <a href="docs/readme/README.pt.md">Português</a></sub>
</p>

<p align="center">
  <strong>The AI Orchestrator for 100x builders.</strong><br/>
  Run Codex, ClaudeCode, OpenCode or Pi side-by-side — each in its own worktree, tracked in one place.
</p>

<h3 align="center"><a href="https://onorca.dev/download"><ins>Download Orca</ins></a></h3>

<p align="center">
  <img src="docs/assets/readme-hero.jpg" alt="Orca desktop app running agents in parallel worktrees, with the Orca mobile companion app in the corner" width="960" />
</p>

## Features

<table>
<tr>
<td width="50%" valign="middle">

### Mobile Companion

Monitor and steer your agents from your phone — get notified when an agent finishes and send follow-ups from anywhere.

[iOS App Store](https://apps.apple.com/us/app/orca-ide/id6766130217) · [TestFlight](https://testflight.apple.com/join/YjeGMQBA) · [Android APK 0.0.48](https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.48/app-release.apk) · [Docs →](https://www.onorca.dev/docs/mobile)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/mobile"><picture><source srcset="docs/assets/feature-wall/mobile-companion-app-showcase.gif" type="image/gif"><img src="docs/assets/feature-wall/mobile-companion-app-showcase.jpg" alt="Orca desktop with the mobile companion app" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Parallel Worktrees

Fan one prompt across five agents, each in its own isolated git worktree — compare the results and merge the winner.

[Docs →](https://www.onorca.dev/docs/model/worktrees)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/model/worktrees"><picture><source srcset="docs/site/public/docs/tab-split.gif" type="image/gif"><img src="docs/site/public/docs/posters/tab-split.jpg" alt="Parallel worktree orchestration" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Terminal Splits

Ghostty-class terminals with WebGL rendering, infinite splits, and scrollback that survives restarts.

[Docs →](https://www.onorca.dev/docs/terminal)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/terminal"><picture><source srcset="resources/onboarding/feature-wall/tile-02.gif" type="image/gif"><img src="resources/onboarding/feature-wall/tile-02.poster.jpg" alt="Terminal splits" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Design Mode

Click any UI element in a real Chromium window to send its HTML, CSS, and a cropped screenshot straight into your agent's prompt.

[Docs →](https://www.onorca.dev/docs/browser/design-mode)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/browser/design-mode"><picture><source srcset="docs/site/public/docs/orca-design-mode.gif" type="image/gif"><img src="resources/onboarding/feature-wall/tile-05.poster.jpg" alt="Embedded browser and Design Mode" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### GitHub &amp; Linear, Native

Browse PRs, issues, and project boards in-app — open a worktree from any task and review without a context switch.

[Docs →](https://www.onorca.dev/docs/review/linear)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/linear"><picture><source srcset="resources/onboarding/feature-wall/tile-03.gif" type="image/gif"><img src="resources/onboarding/feature-wall/tile-03.poster.jpg" alt="GitHub and Linear task workflows in Orca" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### SSH Worktrees

Run agents on a beefy remote box with full file editing, git, and terminals — auto-reconnect and port forwarding included.

[Docs →](https://www.onorca.dev/docs/ssh)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/ssh"><picture><source srcset="resources/onboarding/feature-wall/tile-06.gif" type="image/gif"><img src="resources/onboarding/feature-wall/tile-06.poster.jpg" alt="Remote worktrees over SSH" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Annotate AI Diffs

Drop comments on any diff line and ship them back to the agent — review, edit, and commit without leaving Orca.

[Docs →](https://www.onorca.dev/docs/review/annotate-ai-diff)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/annotate-ai-diff"><picture><source srcset="docs/site/public/docs/annotate-ai-diff.gif" type="image/gif"><img src="resources/onboarding/feature-wall/tile-08.poster.jpg" alt="Annotate AI-generated diffs" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Drag Files to Agents

VS Code's editor with autosave everywhere — drag files or images straight into an agent prompt.

[Docs →](https://www.onorca.dev/docs/editing/file-explorer)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/editing/file-explorer"><picture><source srcset="resources/onboarding/feature-wall/tile-07.gif" type="image/gif"><img src="resources/onboarding/feature-wall/tile-07.poster.jpg" alt="Drag files and images into an agent prompt" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Orca CLI

Agents drive Orca too — script every workflow with `orca worktree create`, `snapshot`, `click`, and `fill`.

[Docs →](https://www.onorca.dev/docs/cli/overview)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/cli/overview"><picture><source srcset="resources/onboarding/feature-wall/tile-09.gif" type="image/gif"><img src="resources/onboarding/feature-wall/tile-09.poster.jpg" alt="Script Orca from the CLI" width="100%" /></picture></a>
</td>
</tr>
</table>

**Also in the box:**

- **[Quick open](https://www.onorca.dev/docs/model/quick-open)** — Search across worktrees, files, agents, commands, and repo context without leaving your flow.
- **[Account switcher &amp; usage tracking](https://www.onorca.dev/docs/agents/usage-tracking)** — See Claude and Codex usage and rate-limit resets, and hot-swap accounts without re-logging in.
- **[Rich repo previews](https://www.onorca.dev/docs/editing/markdown)** — Preview Markdown, images, PDFs, and repo docs in the workspace.
- **[Computer Use](https://www.onorca.dev/docs/cli/computer-use)** — Let agents operate desktop apps and visible UI when a workflow needs real interaction.
- **[Notifications and unread state](https://www.onorca.dev/docs/notifications)** — Know when an agent finishes or needs attention, then mark threads unread to come back later.
- **And many, many more** — we ship daily, so this list is perpetually behind. The [changelog](https://github.com/stablyai/orca/releases) is the real feature list.

---

## Supported Agents

Works with **any CLI agent** — if it runs in a terminal, it runs in Orca.

<p>
  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd><img src="docs/assets/claude-logo.svg" alt="Claude Code logo" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://github.com/openai/codex"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" alt="Codex logo" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://x.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=x.ai&sz=64" alt="Grok logo" width="16" valign="middle" /> Grok</kbd></a> &nbsp;
  <a href="https://cursor.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" alt="Cursor logo" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=github.com&sz=64" alt="GitHub Copilot logo" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" alt="OpenCode logo" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://mimo.xiaomi.com/coder"><kbd><img src="https://www.google.com/s2/favicons?domain=mimo.xiaomi.com&sz=64" alt="MiMo Code logo" width="16" valign="middle" /> MiMo Code</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual#install"><kbd><img src="https://www.google.com/s2/favicons?domain=ampcode.com&sz=64" alt="Amp logo" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://openclaude.gitlawb.com/"><kbd><img src="resources/openclaude-logo.png" alt="OpenClaude logo" width="16" valign="middle" /> OpenClaude</kbd></a> &nbsp;
  <a href="https://antigravity.google/docs/cli-overview"><kbd><img src="https://www.google.com/s2/favicons?domain=antigravity.google&sz=64" alt="Antigravity logo" width="16" valign="middle" /> Antigravity</kbd></a> &nbsp;
  <a href="https://pi.dev"><kbd><img src="https://pi.dev/favicon.svg" alt="Pi logo" width="16" valign="middle" /> Pi</kbd></a> &nbsp;
  <a href="https://omp.sh"><kbd><img src="https://omp.sh/favicon.svg" alt="oh-my-pi logo" width="16" valign="middle" /> oh-my-pi</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/"><kbd><img src="https://www.google.com/s2/favicons?domain=nousresearch.com&sz=64" alt="Hermes Agent logo" width="16" valign="middle" /> Hermes Agent</kbd></a> &nbsp;
  <a href="https://devin.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=devin.ai&sz=64" alt="Devin logo" width="16" valign="middle" /> Devin</kbd></a> &nbsp;
  <a href="https://block.github.io/goose/docs/quickstart/"><kbd><img src="https://www.google.com/s2/favicons?domain=goose-docs.ai&sz=64" alt="Goose logo" width="16" valign="middle" /> Goose</kbd></a> &nbsp;
  <a href="https://docs.augmentcode.com/cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=augmentcode.com&sz=64" alt="Auggie logo" width="16" valign="middle" /> Auggie</kbd></a> &nbsp;
  <a href="https://github.com/autohandai/code-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=autohand.ai&sz=64" alt="Autohand Code logo" width="16" valign="middle" /> Autohand Code</kbd></a> &nbsp;
  <a href="https://github.com/charmbracelet/crush"><kbd><img src="https://www.google.com/s2/favicons?domain=charm.sh&sz=64" alt="Charm logo" width="16" valign="middle" /> Charm</kbd></a> &nbsp;
  <a href="https://docs.cline.bot/cline-cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=cline.bot&sz=64" alt="Cline logo" width="16" valign="middle" /> Cline</kbd></a> &nbsp;
  <a href="https://www.codebuff.com/docs/help/quick-start"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuff.com&sz=64" alt="Codebuff logo" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;
  <a href="https://commandcode.ai/docs/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=commandcode.ai&sz=64" alt="Command Code logo" width="16" valign="middle" /> Command Code</kbd></a> &nbsp;
  <a href="https://docs.continue.dev/guides/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=continue.dev&sz=64" alt="Continue logo" width="16" valign="middle" /> Continue</kbd></a> &nbsp;
  <a href="https://docs.factory.ai/cli/getting-started/quickstart"><kbd><img src="docs/assets/droid-logo.svg" alt="Droid logo" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
  <a href="https://kilo.ai/docs/cli"><kbd><img src="https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/assets/icons/kilo-light.svg" alt="Kilocode logo" width="16" valign="middle" /> Kilocode</kbd></a> &nbsp;
  <a href="https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html"><kbd><img src="https://www.google.com/s2/favicons?domain=moonshot.cn&sz=64" alt="Kimi logo" width="16" valign="middle" /> Kimi</kbd></a> &nbsp;
  <a href="https://kiro.dev/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=kiro.dev&sz=64" alt="Kiro logo" width="16" valign="middle" /> Kiro</kbd></a> &nbsp;
  <a href="https://github.com/mistralai/mistral-vibe"><kbd><img src="https://www.google.com/s2/favicons?domain=mistral.ai&sz=64" alt="Mistral Vibe logo" width="16" valign="middle" /> Mistral Vibe</kbd></a> &nbsp;
  <a href="https://github.com/QwenLM/qwen-code"><kbd><img src="https://www.google.com/s2/favicons?domain=qwenlm.github.io&sz=64" alt="Qwen Code logo" width="16" valign="middle" /> Qwen Code</kbd></a> &nbsp;
  <a href="https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/"><kbd><img src="https://www.google.com/s2/favicons?domain=atlassian.com&sz=64" alt="Rovo Dev logo" width="16" valign="middle" /> Rovo Dev</kbd></a> &nbsp;
  <kbd>+ any CLI agent</kbd>
</p>

---

## Install

### Desktop — macOS, Windows, Linux

- **[Download from onOrca.dev](https://onorca.dev/download)**
- Or grab a build directly: [macOS Apple Silicon](https://github.com/stablyai/orca/releases/latest/download/orca-macos-arm64.dmg) · [macOS Intel](https://github.com/stablyai/orca/releases/latest/download/orca-macos-x64.dmg) · [Windows (.exe)](https://github.com/stablyai/orca/releases/latest/download/orca-windows-setup.exe) · [Linux AppImage](https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage) · [All builds](https://github.com/stablyai/orca/releases/latest)
- Running `orca serve` on a headless Linux server? See the [headless Linux server guide](docs/reference/headless-linux-server.md).

_Or via a package manager:_

```bash
# macOS (Homebrew)
brew install --cask stablyai/orca/orca

# Arch Linux (AUR) — or stably-orca-git to build from source
yay -S stably-orca-bin
```

### Mobile Companion — iOS, Android

Pair with your desktop app to monitor and steer your agents from your phone.

- **iOS:** [Download on the App Store](https://apps.apple.com/us/app/orca-ide/id6766130217) or [join TestFlight](https://testflight.apple.com/join/YjeGMQBA)
- **Android:** [Download APK 0.0.48](https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.48/app-release.apk) · [Install guide](https://www.onorca.dev/docs/android-apk)

---

## Community &amp; Support

- **Discord:** Join the community on **[Discord](https://discord.gg/fzjDKHxv8Q)**.
- **Twitter / X:** Follow **[@orca_build](https://x.com/orca_build)** for updates and announcements.
- **WeChat:** Scan to join the Orca community WeChat group 8. Group 8 may be full; if so, scan the Group 9 QR code instead.

  <img src="docs/assets/wechat-qr-group8.jpg" alt="WeChat group 8 QR code for the Orca community" width="160" />&nbsp;&nbsp;<img src="docs/assets/wechat-qr-group9.jpg" alt="WeChat group 9 QR code for the Orca community" width="160" />

- **Feedback &amp; Ideas:** We ship fast. Missing something? [Request a new feature](https://github.com/stablyai/orca/issues).
- **Privacy:** See the [privacy &amp; telemetry docs](https://www.onorca.dev/docs/telemetry) for what anonymous usage data Orca collects and how to opt out.
- **Show Support:** [Star](https://github.com/stablyai/orca) this repo to follow along with our daily ships.

---

## Developing

Want to contribute or run locally? See our [CONTRIBUTING.md](.github/CONTRIBUTING.md) guide.

The relay that pairs the mobile app with a desktop host is also in this repository under
[`cloud/`](cloud/README.md), with a separate pnpm workspace and setup guide.

<a href="https://github.com/stablyai/orca/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=stablyai/orca" alt="Orca contributors" />
</a>

<p align="center">
  <img src="docs/assets/star-history.png" alt="GitHub star history chart for stablyai/orca" width="880" />
</p>

## Signed Builds

Windows code signing sponored/provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## License

Orca is free and open source under the [MIT License](LICENSE).
