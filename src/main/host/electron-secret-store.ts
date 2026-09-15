import { safeStorage } from 'electron'
import type { SecretStore } from '../../shared/secret-store'
import { isWindowlessLaunch } from '../window/foreground-activation-policy'

/**
 * Electron-backed SecretStore for the desktop app: a pass-through to
 * `electron.safeStorage`, which seals against the OS keychain.
 */
export class ElectronSecretStore implements SecretStore {
  isEncryptionAvailable(): boolean {
    return encryptionAvailableGuarded()
  }

  encryptString(plainText: string): Buffer {
    return safeStorage.encryptString(plainText)
  }

  decryptString(cipher: Buffer): string {
    return safeStorage.decryptString(cipher)
  }

  describeProtectionGap(): string | null {
    if (!encryptionAvailableGuarded()) {
      // Why platform-specific: the fix differs, and "encryption unavailable" alone
      // sends users looking in the wrong place.
      return process.platform === 'linux'
        ? 'The OS keyring is unavailable, so secrets are stored unencrypted. Install and unlock gnome-keyring or kwallet to seal them.'
        : 'The OS keychain is unavailable, so secrets are stored unencrypted.'
    }
    // Why this is not folded into isEncryptionAvailable(): on Linux with no keyring,
    // Electron falls back to `basic_text`, which "encrypts" with a hardcoded password.
    // It round-trips, so sealing and unsealing genuinely work and must keep working —
    // reporting it unavailable would strand every credential already stored this way.
    // But it protects nothing, and reporting it as sealed is the actual lie.
    return describeLinuxBackendGap()
  }
}

// Why: safeStorage.isEncryptionAvailable() (and, transitively, encryptString/decryptString) can
// synchronously block the whole main process waiting for an OS keychain authorization prompt on
// first touch. A windowless launch (ORCA_BACKGROUND_LAUNCH, or E2E-headless — proof drivers, tests,
// and benchmarks; no production path sets either) sets `accessory` activation policy and hides the
// Dock tile (foreground-activation-policy.ts), so macOS has no frontmost window to attach that
// prompt to and the call never returns — freezing ssh.connect (and everything else on the event
// loop) forever with no timeout and no diagnosable error (odin/proofs/ssh-boundary.md §Deviation 3).
// Such a run cannot answer a prompt anyway, so report unavailable up front rather than risk the
// hang. Scoped to darwin: the Keychain-prompt hang is a macOS-only failure mode — Linux/Windows have
// no equivalent blocking prompt, so tripping the guard there would degrade real at-rest protection
// for no reason.
//
// What "unavailable" degrades, per consumer (none of this is "retain prior ciphertext, or write
// plaintext" uniformly — each caller has its own unavailable-branch behavior):
//  - Protected slots (ProtectedSecretPersistence: opencodeSessionCookie, httpProxyUrl,
//    browserKagiSessionLink, SSH PTY owner leases): the prior ciphertext is kept, but a NEW value
//    is silently not persisted (`degraded: true`, blob unchanged).
//  - MiniMax API key / cookie (minimax-api-key-store.ts, minimax-cookie-store.ts): written to disk
//    in PLAINTEXT, with a console.warn at the call site.
//  - Plugin secrets (plugin-secrets-store.ts): reads and writes both REFUSE.
//  - Cloud session (profile-cloud-session-store.ts): reads back as `decrypt-failed`.
function encryptionAvailableGuarded(): boolean {
  if (process.platform === 'darwin' && isWindowlessLaunch()) {
    warnWindowlessSecretsGuardTripped()
    return false
  }
  return safeStorage.isEncryptionAvailable()
}

let warnedWindowlessSecretsGuardTripped = false

/** One-time: repeating this on every OSC/status tick or secret read would drown the console. */
function warnWindowlessSecretsGuardTripped(): void {
  if (warnedWindowlessSecretsGuardTripped) {
    return
  }
  warnedWindowlessSecretsGuardTripped = true
  console.warn(
    '[secrets] Windowless launch (ORCA_BACKGROUND_LAUNCH or E2E-headless) — refusing to touch ' +
      'the macOS Keychain to avoid an unattended hang with no window to authorize its prompt. ' +
      'Consequences for this run: protected settings and SSH PTY owner leases are not persisted; ' +
      'the MiniMax API key/cookie are written in plaintext; plugin secrets refuse to read or ' +
      'write; a saved cloud session reads back as decrypt-failed.'
  )
}

/** Test-only: lets a suite re-observe the one-time warning within the same process. */
export function _resetWindowlessSecretsGuardWarningForTest(): void {
  warnedWindowlessSecretsGuardTripped = false
}

// Electron omits getSelectedStorageBackend at runtime outside Linux despite its type declaration.
function describeLinuxBackendGap(): string | null {
  if (process.platform !== 'linux') {
    return null
  }
  const probe = (safeStorage as Partial<typeof safeStorage>).getSelectedStorageBackend
  if (typeof probe !== 'function') {
    return null
  }
  let backend: string
  try {
    backend = probe.call(safeStorage)
  } catch {
    return null
  }
  return backend === 'basic_text'
    ? 'Secrets are obfuscated with a built-in key, not protected by the OS keyring. Install and unlock gnome-keyring or kwallet, then restart Orca, to seal them properly.'
    : null
}
