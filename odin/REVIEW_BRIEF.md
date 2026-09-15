# Independent review brief — Odin (fork of stablyai/orca)

Repository: /Users/briankeeny/Desktop/odin-fork, branch `odin`. Upstream is stablyai/orca at commit 539d4d1f32 (v1.4.197). Every Odin change is a commit on top of that; `git log --first-parent 539d4d1f32..odin` lists them, `git diff 539d4d1f32..odin --stat` shows the whole surface.

You are an independent reviewer with no stake in the outcome. Be adversarial and specific; cite file:line for every claim. Do not rubber-stamp.

Read first: `odin/DIRECTION.md`, `odin/AGENTS.md`, `README.md` (the Odin section at the top), `odin/VERIFIED.md`, `odin/OPEN.md`, `odin/proof/manifest.json`, and the commit messages of every `odin(...)` commit. Then read the diffs.

Review this Odin repository against DIRECTION.md and AGENTS.md. Verify, with evidence, each of the following and state PASS / FAIL / PARTIAL for each:

1. Only residual failure modes were changed. List every file in `git diff 539d4d1f32..odin --stat` and classify each change as (a) a cited residual, (b) a test or proof for one, (c) scaffolding under `odin/`, or (d) none of the above. Anything in (d) is a deviation.
2. No parallel re-implementation of working Orca surfaces. Did any commit add a second implementation of something Orca already had (a store, a journal, a settlement path, a spawner, a status copy)?
3. Every residual Orca bug cited in the proofs no longer reproduces. For each entry in `odin/proof/manifest.json`, confirm the named test fails at the upstream commit for the cited reason and passes on `odin` (you may run `odin/proof/run-proofs.sh --only <id>`; use `export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`). Also check that the "Orca replica" is the real upstream code, not a hand-written caricature.
4. Settlement is three-valued and the only path. Where can a wait or a dispatch still settle as satisfied/completed on silence, on an absent status, or on a wall clock? Check `tui-idle-evidence.ts`, `terminal-wait-results.ts`, `terminal-host-process-inspection.ts`, `worker-terminal-process-liveness.ts`, the relay twin, and the federation/automation consumers the C commit says it left alone.
5. Status is single-writer and host-owned. Assess `agent-status-patch.ts` after commit S and the items in `odin/OPEN.md`. Is the remaining renderer second-writer honestly described?
6. Agent Graph is first-class. Assess commit K (sub-agent identity) and the nesting-depth verification in `odin/VERIFIED.md`. Is anything still flattened or fabricated?
7. Process vocabulary is live/unverifiable/exited only. Grep for new synonyms or for paths that map loss of contact to exited.
8. Consent is fail-closed and defaults are safe. For D, E, F, G, H: is the default denied, is an unreadable setting a denial, does revocation re-close, and is there any remaining path that installs hooks, copies credentials, adds bypass flags, or widens the bind without a recorded grant? Check `orca serve` / `orcad` explicit opt-ins are documented, not silent.
9. Verified launch receipt (I): is `effective` ever a copy of `requested` when a probe spec exists? Is the `source` label honest for Codex and federated workers?
10. Durable recovery (L, M, N): does the headless sweep really run without a renderer (cite the call sites), are injected dispatches reconciled, is `dispatched_at` written on the right edge, and does the schema migration (v42) follow the repo's migration conventions?
11. Real-session proofs: read the newest `odin/proofs/real-sessions.*.json`. Do the recorded events support the README's claims (which agents settled, whether the default-blocks phase shows the safe default, crash recovery, concurrency)? Note any phase that did not run or did not pass.
12. Definition of done (odin/DIRECTION.md) — item by item, met or not.

Finish with: a verdict (FINISHED / FINISHED WITH MATERIAL DEVIATIONS / NOT FINISHED), a numbered list of material deviations, a list of unproven claims, and a list of remaining risks. Concrete, no praise.

## Round 3 scope (2026-09-15, tree after v0.1.0)

Everything above still applies. Since v0.1.0 the tree also carries the following; review each with the same standard and add its verdict to the numbered list:

13. Renderer second writer (`odin/OPEN.md`, commits `odin(status-A)` … `odin(status-D-fix)`): structured session rows are host-published, the two main-process seam filters are gone, command-code status is produced by main, and every remaining remote-pane writer is gated on the `agent-status.host-osc-ingest.v1` capability with a last-known-verdict cache. Is the store now single-writer for every pane class on a capable host? Is the cold-cache first write and the kill-switch-off local case described honestly? Did any increment blank status for an old host?
14. SSH boundary proof (`odin/proof/ssh-boundary.mjs`, `odin/proofs/ssh-boundary.md`, the newest `ssh-boundary.*.json`): do the recorded events support the README's SSH rows (connect, transport drop, relay SIGKILL, reconnect re-adoption, owner-proven exit)? Is the `safeStorage` windowless-launch fix (`electron-secret-store.ts`, `secrets-guard` ratchet) a correct product change or a test accommodation, and does it change what a real user's background launch persists?
15. Exit waits on timeout (`odin(wait-silence)`): does an exit wait ever reject or settle on silence now, and is the remaining end-to-end gap stated?
16. Linux proofs (`odin/proofs/linux-proofs.txt`, container run) and the Codex/Grok launch probes (`odin(I2)`): are the claims bounded by what actually ran?
17. Upstream pull requests (README "Upstream pull requests"): does each PR carry the same contract as its Odin commit, and are the stated differences (C subset, M includes O1) the only ones?
18. Dependency and CI changes (`.github/dependabot.yml`, workflow permissions, docs site Vercel removal, cloud/mobile overrides): are they within DIRECTION.md's scope or a deviation that should be named?

The verdict for round 3 decides v1.0.0: FINISHED means no material deviations remain.

## Round 4 scope (2026-09-15, tree after the round-3 fix round)

Everything above still applies. Round 3 returned FINISHED WITH MATERIAL DEVIATIONS twice (reports are summarised in the README's "Independent review" section); every item became a commit. Verify the closures with the same standard and add their verdicts:

19. Round-3 deviations: the "Outside the contract" README section and `odin/outside-contract.json` + `odin/outside-contract-scope.test.ts` drift ratchet; OPEN.md's renderer-writer enumeration (every `setAgentStatus(` hit classified, `title-spawn-bell.ts` launch seeds named); status-probe-await, status-cache-revisit (re-evaluation on every probe resolution, both directions), done-settle-shared (single module + ratchet), secrets-guard-scope (darwin-only, one-time warning, `getSecretStoreOrUnavailable`, README deviation 11, docs/reference note), wait-absence-verdict, reader-rule-disclosed (README deviation 12); cost-accounting and liveness-vocabulary disclosures (README deviations 9–10); the `terminal_gone` paragraph in `docs/reference/ssh-execution-boundary.md`; `run-proofs.sh --only` parsing and logs out of tree; corrected notes in `status-C/D.after.txt`; PR 20684's classifier now matching #20682.
20. New residuals found since round 3, each with a manifest entry and failing-first proof: `show-contact-loss` (remote `terminal show` reported connected/writable during a real transport drop), `I3` (Cursor launch receipt probed), `I4` (probe label on a static-catalog fallback; memoised probe failures), `O3b` (`classifyTerminalProcessInspectionFailure` overloaded `terminal_gone`), `O4` (the execution host's federation observer `inspectRemoteAttachment` minted `missing` from a thrown `showTerminal` failure — raised by Pullfrog on #20682; one shared `isOwnerProvenTerminalAbsence` gate for both observers, recovery release keeps the answer `release_pending`); closed-by-construction Odin-introduced fixes `N2` (schema-skew probe), `G3` (no-consent branch and scoped revocation), `O3a` (structured worker's unverifiable never treated as absent on release). Are they real, minimal, and honestly recorded? Does anything they touched regress a residual?
21. Evidence on the tree under review: `odin/proofs/linux-proofs.8b0df499bb.txt` produced by the checked-in `odin/proof/run-proofs-linux.sh`; the SSH runs `ssh-boundary.2026-09-15T01-39-52-596Z.json` (failing, exposed `show-contact-loss`) and `ssh-boundary.2026-09-15T02-28-13-014Z.json` (passing the strengthened phases 4/6/7: loss observed, `terminal wait --for exit` resolving silence during the drop, owner-proven exit with the out-of-band check recorded). Do the artifacts support the README rows exactly, and is what remains unproven stated?
22. Upstream PRs after the Pullfrog findings: #20682, #20683, #20684, #20689, #20693, #20697 were amended to the fixed contracts (#20682 additionally carries O4; #20684's `worker-observation.ts` keeps the inline gate #20682 extracted); verify each PR's diff matches the corresponding Odin commit(s) and that no PR carries a superseded contract.

The verdict for round 4 decides v1.0.0: FINISHED means no material deviations remain.
