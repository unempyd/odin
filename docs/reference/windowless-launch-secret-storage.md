# Windowless-launch secret storage

## The hang this guards against

`safeStorage.isEncryptionAvailable()` — and, transitively, `encryptString`/
`decryptString`, which every call site in this repo checks availability
before calling — can synchronously block the whole main process on a macOS
Keychain authorization prompt the first time a run touches it. A windowless
launch (`foreground-activation-policy.ts`'s `isWindowlessLaunch()`, true when
`ORCA_BACKGROUND_LAUNCH=1` or the E2E-headless flag combination) sets
`accessory` activation policy and hides the Dock tile, so macOS has no
frontmost window to attach that prompt to. The call never returns: no
timeout, no error, just a frozen event loop. This was found via a real
`ssh.connect` proof against a live host, where it froze the whole process —
see `odin/proofs/ssh-boundary.md` §Deviation 3.

## Who sets the flag

`ORCA_BACKGROUND_LAUNCH` and the E2E-headless combination are set **only** by
proof drivers, tests, benchmarks, and `config/scripts/*` — a tree-wide grep
finds no production or user-facing launch path setting either. A normal
foreground desktop launch is unaffected by this guard; it always has a
window and can answer the prompt normally.

**Not proven fixed:** the same hang's real-world variant — Orca started
hidden by a macOS login item, a window created but never shown, no env flag
set at all — has no evidence either way. `isWindowlessLaunch()` would not
catch that case, since it only looks at the launch-mode env flags.

## The guard

`encryptionAvailableGuarded()` in `src/main/host/electron-secret-store.ts`
reports encryption unavailable, without calling `safeStorage`, when both:

- `process.platform === 'darwin'` — the Keychain prompt is a macOS-only
  failure mode. Linux and Windows have no equivalent blocking prompt, so
  scoping the guard to darwin avoids degrading real at-rest protection on
  platforms where the hang cannot happen.
- `isWindowlessLaunch()` is true.

A one-time `console.warn` fires the first time the guard trips in a process,
naming the cause and the consequences below — see
`_resetWindowlessSecretsGuardWarningForTest()` for tests that need to observe
it more than once.

## What "unavailable" degrades, per consumer

This is **not** one uniform fallback — each caller has its own
unavailable-branch behavior:

| Consumer                                                | Behavior when encryption is unavailable                          |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| Protected slots (`ProtectedSecretPersistence`: `opencodeSessionCookie`, `httpProxyUrl`, `browserKagiSessionLink`, SSH PTY owner leases) | Prior ciphertext is retained; a **new** value is silently **not persisted** (`degraded: true`). |
| MiniMax API key / cookie (`minimax-api-key-store.ts`, `minimax-cookie-store.ts`) | Written to disk in **plaintext**, with a `console.warn` at the call site. |
| Plugin secrets (`plugin-secrets-store.ts`)               | Reads and writes both **refuse**.                                   |
| Cloud session (`profile-cloud-session-store.ts`)          | Reads back as `decrypt-failed`.                                     |

## The uninstalled-store race

Four call sites above route through `getSecretStore()` (`src/shared/secret-store.ts`),
which throws if read before `setSecretStore()` runs during startup
(`main-process-preflight.ts`, `orcad-entry.ts`). A caller reachable before
that point — a race, not the windowless guard above — used to call
`safeStorage` directly and degrade gracefully; routing it through the
throwing accessor turned that race into an uncaught error. Those four call
sites use `getSecretStoreOrUnavailable()` instead, which falls back to a
stub reporting "unavailable" (with the same one-time-warning discipline)
rather than throwing. `getSecretStore()` itself is unchanged and still
throws for every other caller — that fail-loud contract is deliberate for
catching initialization-order bugs elsewhere.
