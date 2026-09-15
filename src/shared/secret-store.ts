/**
 * SecretStore abstracts at-rest secret encryption that the desktop gets from
 * Electron's `safeStorage` (OS keychain). A plain-Node host installs its own
 * implementation so core modules never import `electron`.
 *
 * The contract mirrors safeStorage exactly, including the part that matters most:
 * `isEncryptionAvailable()` may return false. A store that cannot seal must say so
 * rather than throw; how a caller degrades is its own decision (persistence retains
 * the prior sealed blob rather than writing plaintext). See `describeProtectionGap()`,
 * which exists so the reason reaches the user, not a console warning nobody reads.
 */

export type SecretStore = {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(cipher: Buffer): string
  /**
   * Why separate from `isEncryptionAvailable()`: that answers "can this host seal and
   * unseal at all", which must stay true for a backend that seals weakly — flipping it
   * would stop `decryptWithStatus()` even attempting, and every already-stored
   * credential would read back empty. This answers the different question a user cares
   * about: "is my data actually protected at rest?"
   *
   * Non-null means the protection is not what a user would assume — either no sealing,
   * or sealing with a backend that does not meaningfully protect. Null means sealed.
   */
  describeProtectionGap(): string | null
}

/**
 * Why a global symbol and not a module-level `let`: `vi.resetModules()` gives the
 * re-imported graph a fresh copy of this module, so a store installed before the reset
 * would silently read back as uninstalled — and `getSecretStore()` throws on that.
 * Anchoring to the realm keeps one instance per process however often the module
 * registry is rebuilt.
 */
const SLOT = Symbol.for('orca.host.secretStore')

type Slot = { [SLOT]?: SecretStore | null }

function slot(): Slot {
  return globalThis as unknown as Slot
}

function read(): SecretStore | null {
  return slot()[SLOT] ?? null
}

export function setSecretStore(store: SecretStore): void {
  slot()[SLOT] = store
}

export function getSecretStore(): SecretStore {
  const current = read()
  if (!current) {
    throw new Error(
      'SecretStore not initialized — call setSecretStore() during startup before reading or writing secrets'
    )
  }
  return current
}

export function hasSecretStore(): boolean {
  return read() !== null
}

const UNAVAILABLE_SECRET_STORE_STUB: SecretStore = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error('SecretStore not initialized; encryption is unavailable')
  },
  decryptString: () => {
    throw new Error('SecretStore not initialized; encryption is unavailable')
  },
  describeProtectionGap: () =>
    'The secret store has not started yet, so this secret cannot be sealed.'
}

const WARNED_UNINSTALLED_SLOT = Symbol.for('orca.host.secretStore.warnedUninstalled')

type WarnedUninstalledSlot = { [WARNED_UNINSTALLED_SLOT]?: boolean }

function warnedUninstalledSlot(): WarnedUninstalledSlot {
  return globalThis as unknown as WarnedUninstalledSlot
}

/**
 * Same contract as `getSecretStore()`, for a caller reachable before `setSecretStore()` runs
 * during startup (`main-process-preflight.ts`, `orcad-entry.ts`): the four safeStorage-backed
 * stores routed through `getSecretStore()` by odin(secrets-guard) — MiniMax API key/cookie,
 * plugin secrets, cloud session — used to call `safeStorage` directly and degrade gracefully;
 * routing them through the throwing `getSecretStore()` turned a race into an uncaught error.
 * Falls back to reporting "unavailable" instead, with the same one-time warning discipline as
 * the windowless-launch guard (electron-secret-store.ts).
 */
export function getSecretStoreOrUnavailable(): SecretStore {
  const current = read()
  if (current) {
    return current
  }
  if (!warnedUninstalledSlot()[WARNED_UNINSTALLED_SLOT]) {
    warnedUninstalledSlot()[WARNED_UNINSTALLED_SLOT] = true
    console.warn(
      '[secrets] SecretStore read before setSecretStore() ran during startup — treating ' +
        'encryption as unavailable for this call instead of throwing. Consequences: protected ' +
        'settings and SSH PTY owner leases are not persisted; the MiniMax API key/cookie are ' +
        'written in plaintext; plugin secrets refuse to read or write; a saved cloud session ' +
        'reads back as decrypt-failed.'
    )
  }
  return UNAVAILABLE_SECRET_STORE_STUB
}

/** Test-only: drop the installed store so suites do not leak one across files. */
export function _resetSecretStoreForTests(): void {
  slot()[SLOT] = null
  warnedUninstalledSlot()[WARNED_UNINSTALLED_SLOT] = false
}
