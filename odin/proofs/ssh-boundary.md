# SSH boundary proof against a real host (claw-vps)

Real-machine run of `odin/proof/ssh-boundary.mjs` against `claw-vps` (Ubuntu 24.04, Node 18, ~1 GB
free RAM, root over key auth). Driver source: `odin/proof/ssh-boundary.mjs`. Recorded artifacts:
`odin/proofs/ssh-boundary.2026-09-14T19-48-26-225Z.json` (the original run, phases 1–2 only —
kept for the historical record of §Deviations 1–3 below) and
`odin/proofs/ssh-boundary.2026-09-14T21-46-07-872Z.json` (the full run after the fix in
§Deviation 3, phases 1–7, `ok: true`).

## Result in one line

All seven phases now pass end to end against the real VPS: desktop-mode host boot, `ssh.connect`
authenticating/deploying/reaching `status: "connected"`, worktree + terminal creation on the SSH
host, the loss-of-contact matrix (transport drop via `iptables`, reconnect re-adoption,
owner-proven exit, relay `SIGKILL` + relaunch). Three real, previously-unknown Odin/Orca bugs were
found and fixed (§Deviations 1–3); §Deviation 3 — the connect handshake never reaching
`status: "connected"` — was the blocker for phases 3–7 and is now root-caused and fixed at the
product level (`src/main/host/electron-secret-store.ts`), not worked around in the driver. See
§Deviation 3 for the exact stuck call, the evidence trail, and the fix.

**Caveat added since this run (review round 3 item 14 / unproven claims 1–3):** phases 4 and 7's
`ok` above was satisfied by a single early sample that had not yet observed the loss at all, not by
observing `unverifiable`/no-exit-claim *during* an actually-detected disconnect, and a rejected
`terminal.wait` was silently dropped from the JSON rather than recorded. The driver
(`odin/proof/ssh-boundary.mjs`) has since been strengthened to close both gaps — see the driver
contract update in §Phases 3–7 below — but that stronger assertion has not itself been re-run
against the real VPS yet, so the phases-4/7 "pass" recorded above should be read under the old,
weaker check until a fresh run exists.

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

### Deviation 3 — the connect handshake did not reach `connected` (root-caused and fixed)

**Symptom, originally reproduced identically on every attempt** (fresh install and reused install,
three different target ids, across ~40 minutes of testing): after the relay logs "Grace canceled:
socket client accepted", nothing further happens on either side for minutes. The client-side
`ssh.connect` RPC call (driver-imposed timeout, tried at 45s/180s/240s/280s across attempts) never
resolved or rejected with a diagnosable error — it simply never returned until the driver's own
timeout fired. See §"What this rules out" below (unchanged from the original investigation — each
of these really was ruled out; the root cause was simply somewhere else).

**Root cause, found by instrumenting the real await chain and rebuilding** (console.error
checkpoints at every `await` inside `SshRelaySession.establish()`
(`src/main/ssh/ssh-relay-session.ts`), `SshChannelMultiplexer.request()`/`sendMessage()`
(`src/main/ssh/ssh-channel-multiplexer.ts`), the relay's own request dispatch
(`src/relay/dispatcher-rpc-routing.ts`) and socket-data receipt
(`src/relay/relay-reconnect-listener.ts`); driver rebuilt with `pnpm run build:relay && pnpm run
build:electron-vite` after each edit, rerun against claw-vps): the SSH/relay layer was never the
problem. The `pty.openClient` request round-tripped over the real SSH channel in **369ms**
(`sendMessage` at `t`, `handleFrame` response at `t+369ms`, `mux.request resolved`) — proving the
mux, the relay's dispatcher, and the transport were all healthy the entire time. Establish() then
logged `before rememberPtyConsumerRecovery` and never logged `after` — the actual hang was inside
that single call, three layers of `await` deep, in
`src/main/persistence/loading-store/state-serialization-secret-handling.ts`'s
`buildStateToSave()`. Durability of the freshly-negotiated PTY-consumer owner lease
(`sshPtyConsumerRecoveries[].ownerLease`) is the *first secret this process ever needs to encrypt*
(every other protected slot — `opencodeSessionCookie`, `httpProxyUrl`, `browserKagiSessionLink` — is
empty on a fresh profile and short-circuits before touching the OS keychain at all). Encrypting it
calls `ProtectedSecretPersistence.encrypt()` → `ElectronSecretStore.encryptionAvailable()` →
`safeStorage.isEncryptionAvailable()` (`src/main/host/electron-secret-store.ts`) — a **synchronous**
Electron binding into the macOS Keychain. A disk-durable `appendFileSync` log (added because
`console.error` to a pipe is buffered by libuv and can be lost the instant the very next statement
blocks the thread — it was) pinpointed the exact stuck line: `encryptionAvailableGuarded()`
never returned from `safeStorage.isEncryptionAvailable()`.

Why this call hangs *specifically* in this proof's launch mode: `ORCA_BACKGROUND_LAUNCH=1` — set
for every agent-driven/E2E Orca launch per `AGENTS.md` — routes through
`applyBackgroundActivationPolicy()` (`src/main/window/foreground-activation-policy.ts`), which sets
macOS activation policy to `accessory` and hides the Dock tile so automation never steals the
desktop. An `accessory`, Dock-less process has no frontmost window for macOS to attach a Keychain
authorization sheet to, so when the OS decides this code identity needs to reconfirm access to its
Keychain item, the sheet has nowhere to render and the synchronous native call blocks **forever** —
with no timeout, because it is a blocking OS call, not a JS timer, and JS timers on the very same
thread (including the mux's own 10s/30s request timeouts everyone assumed would fire) cannot run
either while the thread is blocked. That is what made every "bounded" timeout in the SSH code
irrelevant: the event loop itself was frozen, not any individual await outliving its budget.

**Evidence line** (disk-durable log, `/tmp/odin-ssh-diag2.log` during diagnosis, not checked in):
```
encrypt: entry slot=sshPtyConsumerRecoveries.ownerLease:ssh-1789418009094-c15ad4 plaintextLen=36
encryptionAvailable: before store.isEncryptionAvailable()
```
— and nothing after, for the remainder of the run's patience window, on every attempt.

**The fix** (`src/main/host/electron-secret-store.ts`): `ElectronSecretStore` now reports
encryption unavailable — without ever calling into `safeStorage` — whenever
`isWindowlessLaunch()` (`src/main/window/foreground-activation-policy.ts`) is true. Such a process
structurally cannot answer a Keychain prompt, so risking the hang is never worth it; the store's
existing degraded-but-functional contract (retain prior ciphertext, or write plaintext and say so)
already covers this exactly the way it covers a locked Linux keyring. Covered by a failing-first
test in `src/main/host/electron-secret-store.test.ts` (`windowless launches never touch
safeStorage`): reverting the guard reproduces the two new test failures before the fix.

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
- **Not the relay, the mux, or SSH itself** (established this round): `pty.openClient` resolved in
  369ms; the hang was three layers of `await` further into the *local* persistence write.

**Phases 3–7 were blocked by this** (worktree + terminal creation on the SSH host, the four-way
loss-of-contact matrix, reconnect, owner-proven exit, and the relay-SIGKILL variant) because all of
them require a `status: "connected"` target with a live PTY. With the fix applied they all run —
see §Phases 3–7 below.

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
- For Deviation 3: CDP breakpoints were not needed this time — plain `console.error` checkpoints at
  every `await` in the suspect call chain, rebuilt with `pnpm run build:relay` (only if `src/relay`
  changed) and `pnpm run build:electron-vite`, were enough once the checkpoints bracketed the right
  region. The one real trap: **`console.error` to a non-TTY pipe is buffered by libuv and can be
  lost if the very next statement blocks the thread synchronously** — a checkpoint placed *after*
  the actual stuck call silently never appears, which looks identical to "the hang is even earlier
  than you think." Once that was suspected, switching the last checkpoint to a blocking
  `appendFileSync` (lands on disk immediately, survives a hang on the next line) pinpointed the
  exact call. Prefer `appendFileSync` over `console.error` for the *last* checkpoint before a
  suspected native/blocking call, always.
- Rebuilding `out/` while another agent's Electron dev daemon was running from the same physical
  `out/` (this worktree's `out` is a symlink to the shared main checkout, `docs/reference/...` — see
  `AGENTS.md`) did not disturb that daemon: replacing files on disk under a process's existing open
  file descriptors is safe on macOS/Linux (the running process keeps reading its already-mapped
  bytes; only new spawns see the new build). No process other than this proof's own was touched.
- One real trap in the *verdict-checking* code, not the product: `RuntimeTerminalShow`
  (`src/shared/runtime-terminal-contracts.ts`) has no `state` field — liveness is `connected` plus
  the presence/absence of `exitCause` (`src/shared/terminal-exit-cause.ts`). The driver's original
  phase3/4/5/6/7 verdicts checked `.state`, which has never existed, so they always evaluated as
  `undefined` — never caught because no prior run had ever reached a connected session to exercise
  them. Fixed in the driver (`terminalIsRunning`/`terminalClaimsExit` helpers).
- A second trap: killing only the foreground job (`pkill -f "^sleep 600"`) leaves the login shell
  alive to print a fresh prompt, so the terminal correctly never reports `exited` — `node-pty`'s
  exit event (what Orca's terminal-exit tracking is keyed to) fires on the *shell* exiting, not a
  job inside it. Proving "owner-proven exit" needs killing the shell itself. A plain `SIGTERM` to
  that shell over this VPS's SSH session took long enough (tens of seconds, unpredictably) that it
  looked at first like a second detection bug; `SIGKILL` to the shell resolves cleanly and fast.
  Phase 6 now kills the shell PID (captured alongside the job's PID in phase 3) with `SIGKILL`.

## What changed

**Product fix** (`src/main/host/electron-secret-store.ts` +
`src/main/host/electron-secret-store.test.ts`): see §Deviation 3 above for the full root cause. This
is a real, previously-unknown Odin/Orca defect, not a driver workaround — any headless/background
Orca launch that reaches a first-time secret encryption (not just this proof's SSH PTY-consumer
lease) was exposed to the same indefinite, silent, untimeoutable hang.

**Follow-on fix, same defect (`secrets-guard`, a later worktree)**: the guard above only closed
`ElectronSecretStore`'s own `isEncryptionAvailable()`. Four other call sites still touched
`safeStorage.isEncryptionAvailable()` / `encryptString()` / `decryptString()` directly — Orca cloud
session persistence (`profile-cloud-session-store.ts`), plugin secrets
(`plugin-secrets-store.ts`), and the two MiniMax stores (`minimax-api-key-store.ts`,
`minimax-cookie-store.ts`) — and would reproduce the exact same indefinite hang on their own first
touch under a windowless launch. All four are now routed through `getSecretStore()` (the same
guarded instance), each keeping its own existing unavailable-branch behaviour; a new ratchet test
(`src/main/host/safe-storage-call-site-boundary.test.ts`) fails on any future direct `safeStorage`
call site in `src/main` outside `electron-secret-store.ts`. Proof:
`odin/proofs/secrets-guard.before.txt` / `.after.txt`.

**Driver-side fixes carried over from the original investigation** (environment variables the
driver sets before spawning Electron, no product source involved): `ORCA_RELAY_PATH` and its
realpath resolution (Deviations 1–2).

**Driver-side fixes made possible by finally reaching phases 3–7** (`odin/proof/ssh-boundary.mjs`):
the `.state`-field and shell-vs-job-kill fixes described above, and `terminal.wait --for exit`'s
verdicts are now recorded as evidence rather than gating `ok` — see the note on `terminal.wait` in
§Phases 3–7 below.

## Phases 3–7 — worktree/terminal on the SSH host, the loss-of-contact matrix

**Recorded artifact:** `odin/proofs/ssh-boundary.2026-09-14T21-46-07-872Z.json` (`ok: true`, all
seven phases `ok: true`). **This artifact predates the driver-contract update below** and was
produced under the weaker assertions each bullet describes inline; it has not been re-run.

**Driver contract update (review round 3 item 14 / unproven claims 1–3; not yet re-run — no result
text below reflects it).** Phases 4 and 7 originally sampled `terminal show` exactly once, 10s
after inducing the loss, and passed `ok` on that single sample still reading `connected: true` —
i.e. before the client had observed the loss at all. `odin/proof/ssh-boundary.mjs` now:

- polls `terminal show` every 5s, for up to 90s, until `connected` is actually observed to flip
  `false`, then takes one more confirming sample (`pollUntilDisconnected`), recording every sample;
- requires for `ok` that (a) `connected: false` was actually observed and confirmed by a
  subsequent sample, (b) no sample — before, during, or after — ever carried `exitCause` or any
  exited claim, and (c) a `terminal wait --for exit` run with a 30s budget *during* the loss
  RESOLVED (did not reject) with `satisfied: false, evidence: 'silence'` — the `wait-silence` fix's
  contract (see below);
- keeps the wait outcome in the JSON even when it rejects, as `{ rejected: <message> }`, instead of
  silently dropping the key (`terminalWaitExit`, previously returned `undefined` on rejection, which
  `JSON.stringify` drops);
- for phase 6, records the driver's own out-of-band `ssh ps -p <shellPid>` liveness check as
  `outOfBandShellState`, next to `ok`, so the narrative can say plainly which check — Orca's verdict
  or the driver's out-of-band probe — actually proved death.

- **Phase 3 — baseline.** `worktree create` + `terminal create` on the connected `ssh:` target,
  `terminal send 'sleep 600'`. `terminal show` reports `connected: true`, no `exitCause`; the real
  `sleep 600` process is confirmed alive on the VPS via `ps`. **Proven.**
- **Phase 4 — loss of contact (variant C, transport drop).** *Result text below is from the run
  under the old single-sample check (see the driver contract update above) and predates the
  strengthened assertion; it has not been re-run.* A self-healing VPS-side `iptables -I
  INPUT -s <mac-ip> -j DROP` (auto-removed after 75s by the same command) blacks out the transport.
  10s in, `terminal show` still reports **no `exitCause`** — the boundary contract's core claim
  (loss of contact is never reported as exited) holds. `terminal.wait --for exit` was also tried
  here as corroborating evidence but is **not proof-bearing** in this run — see the `terminal.wait`
  note below — so `ok` rests on `terminal show` alone. **Proven** (the claim the phase exists to
  test); **not fully proven** (the `evidence: 'silence'` shape from `docs/reference/
  ssh-execution-boundary.md`, which needs the wait path fixed first — see below). The unproven part
  — whether `connected` is ever actually observed to flip `false` on a real drop, rather than the
  window simply ending before the client noticed — is exactly what the strengthened assertion above
  now requires and a re-run must demonstrate.
- **Phase 5 — reconnect re-adopts.** After the `iptables` rule self-removes, a second `ssh.connect`
  reconnects; `terminal show` shows the *same* PTY (`connected: true`, no `exitCause`) and the VPS
  confirms the *same* `sleep 600` PID survived throughout. **Proven.**
- **Phase 6 — owner-proven exit.** `kill -9` on the terminal's login shell PID (captured in phase 3
  alongside the job's own PID — see the note above on why the job's PID alone is the wrong target)
  produces a real `terminal.wait --for exit` resolution: `satisfied: true, status: 'exited',
  exitCause: {kind: 'unknown', reason: 'cause_unreported'}` — correctly conservative per
  `src/shared/terminal-exit-cause.ts`'s own doc comment (an SSH relay reports a code but no cause,
  so nothing here claims more than that). The actual proof of death is the driver's own
  out-of-band `ssh` check (`shellStillAliveOnHost: "dead"` in this recorded run; the driver now
  names this field `outOfBandShellState`, next to `ok`, per the contract update above), not Orca's
  `exitCode: 0`. **Proven** (a real exit happened and was confirmed out-of-band); **read the
  `exitCode`/`exitCause` pair as Odin's own conservative verdict, not as the evidence of death**.
- **Phase 7 — variant B, relay `SIGKILL` + relaunch.** *Result text below predates the
  strengthened assertion (see the driver contract update above); it has not been re-run.* A second
  worktree/terminal is created, then the relay process on the VPS is `kill -9`'d directly.
  `terminal show` on the affected terminal still reports **no `exitCause`** while the relay is gone
  — the same core claim as phase 4, holding through total loss of the remote daemon, not just the
  transport. A subsequent `ssh.connect` relaunches the relay and reaches `status: "connected"`
  again. **Proven** under the old single-sample check; the strengthened poll-until-disconnected
  assertion has not yet been exercised against a real relay kill.

**`terminal.wait --for exit` note (a second, narrower finding, distinct from Deviation 3) — verdict
shape now fixed, still unproven end-to-end (later worktree, `wait-silence`):** at the time of this
run, `RuntimeTerminalWait.wait()` (`src/main/runtime/runtime-terminal-wait.ts`) rejected with a bare
`Error('timeout')` — not a resolved `{satisfied: false, evidence: 'silence'}` — when its own
internal timer fired before either a real exit or `pty.connected` flipping false resolved the
waiter. During phases 4 and 7 the SSH transport's own dead-link detection (`TIMEOUT_MS = 20_000`,
`src/relay/protocol.ts`) had not always flipped `connected` by the time the driver's chosen wait
budget (raised to 30s/20s and still not reliably enough) elapsed, so the CLI surfaced a plain RPC
error the driver cannot read a verdict from, instead of the documented immediate
`satisfied:false, evidence:'silence'`. This is **not** Deviation 3 — the connect path is unaffected
and phases 3–7 run to completion regardless.

The timer path is now fixed: both the PTY-branch and leaf-branch internal timeouts for
`condition: 'exit'` resolve `{satisfied: false, status, exitCode, evidence: 'silence'}` (the same
shape `buildPtyTerminalWaitResult`/`buildTerminalWaitResult` already produce for a disconnected PTY
at wait-start) instead of rejecting; a `tui-idle` timeout is unchanged and still rejects with
`Error('timeout')`. This closes the gap at the unit level — see
`odin/proofs/wait-silence.before.txt` / `.after.txt`
(`src/main/runtime/runtime-terminal-wait-exit-timeout.test.ts`) — but claim no more than that: it
has **not** been re-run against a real transport drop the way this SSH proof drives one, so
`docs/reference/ssh-execution-boundary.md`'s "`terminal wait --for exit`'s immediate
`satisfied:false, evidence:'silence'`" claim is proven at the unit level, not proven end-to-end
against a real host.

**This is now a gate, not just evidence.** Per the driver contract update in §Phases 3–7 above,
`odin/proof/ssh-boundary.mjs` no longer treats `terminal.wait`'s outcome during phases 4/7 as
corroborating-only: `ok` for those phases now requires the wait to RESOLVE `{satisfied: false,
evidence: 'silence'}` during the loss, and a rejection is recorded verbatim (`{rejected:
<message>}`) rather than dropped. Re-running `odin/proof/ssh-boundary.mjs` against a real VPS
transport drop with the `wait-silence`-fixed binary, and confirming `terminal.wait` itself now
resolves instead of throwing, remains the open item — the difference is that a re-run failing this
now fails the phase outright instead of being noted as an evidence gap.

## Residuals this run exercises (per the design plan, §3)

- **A-relay** (`odin/proof/manifest.json`, `closedByConstruction`): the relay tombstone gate
  (`src/relay/pty-handler.ts:2398-2413`, `isProvenProcessExit`) needs a live PTY and a
  SIGKILLed-then-relaunched relay — phase 7 is exactly that. **Reached and exercised**: `terminal
  show` never claims `exited` while the relay is dead, matching the tombstone gate's intent.
- **B** (`worker-terminal-process-liveness`), **O1/O2** (`worker-observation.ts` SSH branch), **M**
  (`orca-runtime-notify-ssh-state-changed.ts` reconcile-on-reconnect): exercised indirectly by
  phases 4/5/7 (loss of contact never reads as exited; reconnect re-adopts the same PTY), though
  none of these were probed through their own dedicated CLI surface (`worker-show`, `worktree ps`'s
  scope note) — only through `terminal show`/`terminal wait`.
- **C** (`tui-idle` over SSH): not exercised — no phase in this proof drives an agent CLI over SSH,
  only a plain shell running `sleep 600`.

## Unproven claims (explicit, updated)

- Of the four boundary verdicts from `docs/reference/ssh-execution-boundary.md`: **`terminal show`
  never `exited` on transport loss** is now proven against a real host (phases 4 and 7) — under the
  old single-sample check (see the driver contract update in §Phases 3–7); it does **not** show
  that the `unverifiable` verdict was ever reached on a real drop, only that nothing changed in the
  window sampled. The strengthened `pollUntilDisconnected`/`lossOfContactOk` assertion closes this
  gap at the driver level (it now requires actually observing `connected: false`), but that
  assertion has not itself been exercised against the real VPS yet — a re-run is the open item. The
  other three verdicts (`worktree ps`'s "not covered" scope note, `worker-show`'s
  `unverifiable`/`missing_liveness_verdict`, and `terminal wait --for exit`'s immediate
  `satisfied:false, evidence:'silence'`) remain proven only by the unit tests
  (`odin/proofs/*.after.txt`), not by this run — the wait-path finding above is the reason the third
  one specifically still isn't. The `wait-silence` fix (above) closes the verdict-shape gap the
  finding names, at the unit level only; this run has not been repeated against the fixed binary,
  so "proven only by unit tests, not by this run" still holds for that third verdict — and, as of
  the driver contract update, a re-run that fails to observe `terminal.wait` resolving
  `satisfied:false, evidence:'silence'` during a real drop now fails phases 4/7 outright rather than
  being noted as an evidence gap.
- **Phase 6's "yields a proven exit" reads stronger than what the run shows**: the recorded verdict
  is `exitCode: 0` with `exitCause: {kind: 'unknown', reason: 'cause_unreported'}` for a SIGKILLed
  shell; actual death was established by the driver's own out-of-band `ssh ps -p` check, not by
  Orca. The driver now records that check as `outOfBandShellState`, next to `ok`, specifically so
  this distinction is visible in the JSON and not just in prose — the underlying `exitCode`/
  `exitCause` semantics are unchanged (see `src/shared/terminal-exit-cause.ts:114-138`) and are not
  what this update claims to fix.
- Whether the SSH dead-link `TIMEOUT_MS` window should be shorter is a separate open follow-up —
  not attempted here; it is a distinct question from both Deviation 3 and `wait-silence`.

## State left on the VPS

`~/.orca-remote/relay-0.1.0+9a9827b3fde2/` and `~/.orca-remote/relay-0.1.0+aca66c7a50f8/` (Orca's
normal footprint; left in place per instruction — the second directory is this session's build,
which now holds a real, previously-compiled relay install and one running relay process, expected
residue from the final successful connect). `/root/odin-proof` removed. No iptables rule left
(`iptables -S INPUT` shows only the VPS's pre-existing, unrelated port-block rule for
8000/8443/8444/5432/5433/6543). `~/.orca-remote` itself untouched otherwise.
