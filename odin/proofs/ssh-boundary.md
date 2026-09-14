# SSH boundary proof against a real host (claw-vps)

Real-machine run of `odin/proof/ssh-boundary.mjs` against `claw-vps` (Ubuntu 24.04, Node 18, ~1 GB
free RAM, root over key auth). Driver source: `odin/proof/ssh-boundary.mjs`. Recorded artifact:
`odin/proofs/ssh-boundary.2026-09-14T19-48-26-225Z.json` (NDJSON events + summary).

## Result in one line

Phase 1 (desktop-mode host boot, target/repo registration) is fully proven. Phase 2 (`ssh.connect`
against the real VPS) authenticates, deploys, and launches a real relay end-to-end — but the
connect handshake does not reach `status: "connected"` within the driver's patience window, every
time it was tried. Two real, previously-unknown Odin/Orca bugs were found and fixed along the way
(§Deviations 1–2). A third, still-open finding blocks phases 3–7 (§Deviation 3): worktree/terminal
creation on the SSH host and the loss-of-contact matrix were **not** exercised, because there was
never a connected relay to build them on. Every verdict that *could* be obtained without a
connected session is recorded below and in the JSON artifact.

## Phase 1 — desktop-mode host boot, target + repo registration

**What ran.** `odin/proof/real-session-host.mjs`'s `Host` launches Electron with `--serve`
(headless serve). The SSH proof needed a different launch because SSH mutation
(`ssh:addTarget`/`ssh.connect` IPC registration) only installs from a `BrowserWindow`
(`src/main/window/attach-main-window-services.ts:121`), and headless `--serve` returns before
`openMainWindow()` ever runs (`src/main/startup/main-process-runtime-launch.ts:340-343`). There is
also no CLI or RPC path that registers an SSH target — `sshTargets` is a top-level array normalized
at load (`src/main/persistence/loading-store/normalize-loaded-profile-state.ts:90`) with no
programmatic writer.

**What the driver does instead** (`DesktopHost` class in `ssh-boundary.mjs`): spawns
`electron out/main/index.js` with **no** `--serve` argv (desktop mode), keeps
`ORCA_BACKGROUND_LAUNCH=1` so the window is created but never shown
(`src/main/window/foreground-activation-policy.ts:17-34`), keeps the isolated
`ORCA_E2E_USER_DATA_DIR`/`HOME` contract from `real-session-host.mjs`, and polls
`orca status --json` for `result.runtime.state === "ready"` instead of the `orca_server_ready`
stdout line (serve-only). It seeds `sshTargets` (one manual target, `claw-vps`, resolved from
`~/.ssh/config` via `ssh -G`, `relayGracePeriodSeconds: 0`) and `repos` (one row pointing at a
freshly-seeded git repo at `/root/odin-proof/seed` on the VPS, `connectionId`/`executionHostId`
set to the target) directly into `orca-data.json` before boot — the only way to get an SSH target
onto disk without the desktop UI.

**Verdicts recorded** (`odin/proofs/ssh-boundary.2026-09-14T19-48-26-225Z.json`, `phase1`):
- Host reached `runtime.state: "ready"`.
- `orca host list --json` showed the seeded target: `{"kind":"ssh","name":"claw-vps","id":"ssh-1789415010957-7b3b00","selector":"--host ssh:ssh-1789415010957-7b3b00","connected":false}` — proving the CLI's `host list` (`src/cli/handlers/environment.ts:34-66`) correctly surfaces a disk-seeded target through the real RPC (`ssh.listTargets`), not just ones added through the UI.
- The seeded repo on the VPS: `git rev-parse HEAD` → `586851b18f3a06603c5132cadd823af0061a8274`.

Phase 1 is unconditionally proven: **ok: true**.

## Phase 2 — `ssh.connect`, real relay deploy against claw-vps

There is no CLI verb that calls `ssh.connect` (it is an RPC-only method,
`src/main/runtime/rpc/methods/ssh.ts:37-47`, meant for a paired renderer or mobile client). The
driver reimplements the wire protocol from `src/cli/runtime/transport.ts` against
`<userDataDir>/orca-runtime.json` (`src/shared/runtime-bootstrap.ts`) in ~70 lines
(`rpcCall` in `ssh-boundary.mjs`) rather than importing the bundled CLI internals, which are not
exposed as an importable module from `out/cli/index.js`.

Calling that RPC directly against a real VPS surfaced two real deployment bugs on the very first
attempt, both now fixed in the driver (not in product source — see "What was not changed" below).

### Deviation 1 — dev-mode desktop launch can't find its own relay bundle

**Symptom.** `ssh.connect` authenticated (`[ssh] TCP_NODELAY enabled for claw-vps`), detected the
remote platform (`[ssh-relay] Platform: linux-x64`), then failed immediately with the client-facing
`{"code":"runtime_error","message":"SSH connection unavailable"}` — the generic message
`getPublicSshError` returns for any non-`auth-failed` status
(`src/main/runtime/public-ssh-state.ts`), which by design hides the real cause from the RPC caller.

**Root cause, captured via Chrome DevTools Protocol** (attached `--inspect` to a throwaway repro
host, `Debugger.setPauseOnExceptions({state:'all'})`, read the paused exception's stack — see
"How this was diagnosed" below): the real error was
`Error: Relay package for linux-x64 not found locally. This may be a packaging issue — try
reinstalling Orca.`, thrown from `getLocalRelayPath` returning `null`
(`src/main/ssh/ssh-relay-deploy.ts:1646-1651`). `getLocalRelayCandidates`
(`:1655-1673`) builds candidates from `app.getAppPath()` joined with `out/relay/<platform>`. A bare
`electron out/main/index.js` dev launch (this checkout's `out/` is a git-worktree symlink to the
main checkout) does not resolve `app.getAppPath()` the way `pnpm dev`'s electron-vite launcher
does, so none of the candidates exist even though `out/relay/linux-x64/` is right there on disk.
Because `real-session-host.mjs`'s existing driver only ever runs `--serve` (which never reaches
this code path per the design note above), this bug had never been hit by any prior proof.

**Fix applied in the driver** (not product code): set `ORCA_RELAY_PATH` — the one documented
override `getLocalRelayCandidates` checks first (`ssh-relay-deploy.ts:1657-1659`).

**A second-order bug this exposed once the first was patched**: pointing `ORCA_RELAY_PATH` at the
worktree path (`/Users/…/odin-wt-ssh/out/relay`) got past `getLocalRelayPath`, but the upload
step's own path-containment guard then rejected it: `Error: Path escaped upload root:
/Users/…/odin-wt-ssh/out/relay/linux-x64` (`assertLocalUploadPathInsideRoot`,
`src/main/ssh/sftp-upload.ts:308-320`), because the worktree's `out/` is a symlink and the guard's
containment check does not agree with itself across a symlinked root. The fix is to hand it the
resolved, non-symlinked path: `ORCA_RELAY_PATH: realpathSync(join(projectDir, 'out', 'relay'))`.
This does not weaken the guard — it points at the identical on-disk files by their real path
instead of asking the guard to reason about a symlink.

**With both fixes applied, the deploy completes for real, end to end, against claw-vps**, observed
twice (once against a from-scratch install, once reusing an already-installed relay):

```
[ssh] TCP_NODELAY enabled for claw-vps
[ssh-relay] Detecting remote platform...
[ssh-relay] Platform: linux-x64
[ssh-relay] Found node via path probe: /usr/bin/node
[ssh-relay] Remote dir: /root/.orca-remote/relay-0.1.0+9a9827b3fde2
[ssh-relay] Already installed at 0.1.0+9a9827b3fde2: false
[ssh-relay] Uploading relay...
[ssh-relay] Upload complete
[ssh-relay] Installing native dependencies...
[ssh-relay][NPTY-CLOEXEC] .../relay-0.1.0+9a9827b3fde2 (linux-x64): patched
[ssh-relay] Published native deps as shared cache entry linux-x64-d4d173138ccc2786
[ssh-relay] Native deps installed
[ssh-relay] Launching relay...
[ssh-relay] Socket probe result: "DEAD"
[ssh-relay] Relay started successfully
```

Verified independently on the VPS itself: `npm install node-pty@1.1.0 @parcel/watcher@2.5.6`
actually ran (`node-gyp rebuild` observed live in `ps`), the relay's own log confirms a real
`node relay.js --detached` process bound a real unix socket and accepted a real client:

```
2026-09-14T19:35:52.359Z [relay] Socket server listening: .../relay-578516318067a093.sock
[relay] Handshake OK from version=0.1.0+9a9827b3fde2
2026-09-14T19:35:54.228Z [relay] Socket client accepted (clients=1, accepted=1)
2026-09-14T19:35:54.228Z [relay] Grace canceled: socket client accepted
```

This is real: real SSH auth, a real SFTP upload, a real `npm install` + native compile under
constrained memory on a real VPS, a real relay process, a real accepted client connection.

### Deviation 3 — the connect handshake does not reach `connected` (unresolved)

**Symptom, reproduced identically on every attempt** (fresh install and reused install, three
different target ids, across ~40 minutes of testing): after the relay logs "Grace canceled: socket
client accepted", nothing further happens on either side for minutes. The client-side `ssh.connect`
RPC call (driver-imposed timeout, tried at 45s/180s/240s/280s across attempts) never resolves or
rejects with a diagnosable error — it simply never returns until the driver's own timeout fires.
The relay's log goes silent between "Grace canceled" and — in two observations — an eventual
`Shutdown: ptys=0, clients=0, ownsSocket=true` / `Process exiting with code 0` roughly 4 minutes
later, even though `relayGracePeriodSeconds: 0` is supposed to mean "keep alive until reset." In one
of those observations the relay process was still present in `ps` **ten minutes** after its own log
said it had exited — logged its own exit and then did not actually exit.

**What this rules out** (each checked directly against the real run, not inferred):
- **Not a crash.** The Electron main process stays alive throughout (`child alive?` confirmed
  `true` via an attached CDP session across every attempt) — there is no repeat of Deviation 1's
  silent `process.exit(0)` once `ORCA_RELAY_PATH` is set correctly.
- **Not the VPS's memory pressure alone.** `free -h` and `uptime` on the VPS showed no swapping
  spike or elevated load average correlated with the hang; no OOM kill in `dmesg`/`journalctl -k`.
- **Not a stale/leftover relay.** Reproduced against a completely fresh `rm -rf ~/.orca-remote`
  install, not only against reused installs.
- **Not the SSH connection dropping.** `pgrep`/`ps` on the VPS show the same relay pid alive and
  the same accepted-client count (`clients=1`) for the entire hang window before the eventual
  (self-contradicted) shutdown log line — the transport-level connection does not visibly close.
- **Not this driver's own process-group/detached-spawn plumbing** — reproduced identically with
  `detached: true` and `detached: false` on the Electron child.
- **Not `installDevParentWatchdog`** (the mechanism that killed the process before Deviation 1 was
  fixed) — ruled out by a 500ms `ps -o ppid=` poll of the Electron child for the entire window: the
  parent pid never changed and was never missing.

**What was not established**: the exact stuck `await` inside `SshRelaySession.establish()`
(`src/main/ssh/ssh-relay-session.ts:520-635` — `openPtyConsumerSession` →
`mux.request(SSH_PTY_OPEN_CLIENT_METHOD, …, {timeoutMs: SSH_PTY_OPEN_CLIENT_TIMEOUT_MS})`, a
10-second timeout, then `session.resolveHome`, then `registerProviders`, then
`reattachKnownPtys`). Reading the code, each of these has its own bounded
`SshChannelMultiplexer.request()` timeout (`REQUEST_TIMEOUT_MS = 30_000`,
`src/main/ssh/ssh-channel-multiplexer.ts:59`) that should turn a stuck request into a rejected
promise well under a minute — not the multi-minute silence actually observed. Locating the specific
await that outlives its own timeout needs either a Node inspector breakpoint inside
`ssh-relay-session.ts` at build time (not available against the minified bundle without a source
map) or an instrumented build; both were out of reach in the time available. `~350ms` RTT to the
VPS (`ping` measured `351.943/371.541/432.797ms` min/avg/max) is real but far too small on its own
to explain a multi-minute stall.

**This blocks phases 3–7** (worktree + terminal creation on the SSH host, the four-way
loss-of-contact matrix, reconnect, owner-proven exit, and the relay-SIGKILL variant): all of them
require a `status: "connected"` target with a live PTY, which this run never reached. The driver
detects this after phase 2 and stops explicitly (`odin/proof/ssh-boundary.mjs`, the
`phase3to7`/`skipped` record) rather than attempting worktree/terminal creation against a target
that was never connected and reporting misleading verdicts for it.

## How this was diagnosed (for whoever picks this up next)

- `NODE_OPTIONS=--require <script>` **does not work** for Electron's main process launched this
  way — Electron does not honor it outside `ELECTRON_RUN_AS_NODE`, so a `require('electron')`
  inside such a script never resolves to the real `app` object. This cost real time to discover;
  do not repeat it.
- What **does** work: spawn Electron with `--inspect=0` prepended to argv, read the
  `Debugger listening on ws://…` line from stderr, connect with the `ws` npm package, `Runtime.enable`
  + `Debugger.enable`, `Runtime.evaluate` a patch script (works reliably once the app is past
  `app-ready`; wrap in a short retry loop if evaluated very early), and
  `Debugger.setPauseOnExceptions({state:'all'})` immediately before the operation under test (arming
  it before that is far too noisy — hundreds of expected, caught `ENOENT` probes fire during normal
  startup for absent agent-CLI shims). Each `Debugger.paused` event's `params.data.description`
  carries the real thrown error's message and stack, including through minified bundles, because
  V8's own stack traces still resolve to file:line inside the running process regardless of
  minification.
- `ORCA_STARTUP_DIAGNOSTICS=1` (`src/main/startup/startup-diagnostics.ts`) is genuinely useful for
  timing desktop-mode boot phases; it played no role in either root cause here.

## What was not changed

Everything above is a **driver-side fix** (environment variables the driver sets before spawning
Electron): `ORCA_RELAY_PATH` and its realpath resolution. No product source under `src/` was
modified to produce these results. Whether `getLocalRelayCandidates` should also try
`realpathSync(app.getAppPath())`-relative candidates by default (so a bare dev launch works without
the override) is a legitimate follow-up but is a product change, out of scope for a proof driver.

## Residuals this run exercises (per the design plan, §3)

- **A-relay** (`odin/proof/manifest.json`, `closedByConstruction`): the relay tombstone gate
  (`src/relay/pty-handler.ts:2398-2413`, `isProvenProcessExit`) was the highest-value target for a
  real run because it has no deterministic harness in the relay test surface. **Not reached** —
  needs a live PTY and a SIGKILLed-then-relaunched relay, neither of which happened here.
- **B** (`worker-terminal-process-liveness`), **O1/O2** (`worker-observation.ts` SSH branch), **M**
  (`orca-runtime-notify-ssh-state-changed.ts` reconcile-on-reconnect), **C** (`tui-idle` over SSH):
  all require phases 3–7. **Not reached.**

## Unproven claims (explicit)

- The four boundary verdicts from `docs/reference/ssh-execution-boundary.md` (`terminal show` never
  `exited` on transport loss, `worktree ps`'s "not covered" scope note, `worker-show`'s
  `unverifiable`/`missing_liveness_verdict`, `terminal wait --for exit`'s immediate
  `satisfied:false, evidence:'silence'`) are **not proven by this run**. They were proven by unit
  tests before this effort (`odin/proofs/*.after.txt`) and remain proven only there.
- Variant B (relay `SIGKILL`) and variant C (transport drop via VPS-side `iptables`) were not
  exercised against a live session.
- Reconnect re-adoption and owner-proven exit (`pkill -f "^sleep 600"` → proven exit code) were not
  exercised.
- Whether Deviation 3 is a real product defect (something in `establish()` that can hang past its
  own timeouts) or an artifact specific to driving `ssh.connect` from a raw RPC socket instead of
  through the renderer's own connect UI flow is **not established**.

## State left on the VPS

`~/.orca-remote/relay-0.1.0+9a9827b3fde2/` (Orca's normal footprint; left in place per instruction —
it now holds a real, previously-compiled relay install, which is expected residue from a real
connect attempt). `/root/odin-proof` removed. No iptables rule left (`iptables -S INPUT` shows only
the VPS's pre-existing, unrelated port-block rule for 8000/8443/8444/5432/5433/6543). No leftover
relay process (the one from the final run was killed after the proof; a real production Orca
client that later ran `ssh.connect` against this target would either reconnect to a fresh install
or find the existing `relay-0.1.0+9a9827b3fde2` directory reusable).
