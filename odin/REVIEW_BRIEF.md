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
