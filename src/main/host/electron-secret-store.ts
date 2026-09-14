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

// Why: safeStorage.isEncryptionAvailable() (and, transitively, encryptString/decryptString, which
// ProtectedSecretPersistence never calls without checking this first) can synchronously block the
// whole main process waiting for an OS keychain authorization prompt on first touch. A windowless
// launch (ORCA_BACKGROUND_LAUNCH — every agent-driven/E2E run per AGENTS.md) sets `accessory`
// activation policy and hides the Dock tile (foreground-activation-policy.ts), so macOS has no
// frontmost window to attach that prompt to and the call never returns — freezing ssh.connect (and
// everything else on the event loop) forever with no timeout and no diagnosable error. Such a run
// cannot answer a prompt anyway, so report unavailable up front rather than risk the hang; the
// store's existing degraded-but-functional contract (retain prior ciphertext, or write plaintext)
// already covers this.
function encryptionAvailableGuarded(): boolean {
  if (isWindowlessLaunch()) {
    return false
  }
  return safeStorage.isEncryptionAvailable()
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
