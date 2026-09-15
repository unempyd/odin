import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  getSecretStore,
  getSecretStoreOrUnavailable,
  hasSecretStore,
  _resetSecretStoreForTests,
  setSecretStore,
  type SecretStore
} from './secret-store'

function fakeStore(overrides: Partial<SecretStore> = {}): SecretStore {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText) => Buffer.from(`sealed:${plainText}`),
    decryptString: (cipher) => cipher.toString().slice('sealed:'.length),
    describeProtectionGap: () => null,
    ...overrides
  }
}

describe('SecretStore registry', () => {
  beforeEach(() => {
    _resetSecretStoreForTests()
  })

  it('throws until a store is installed, rather than defaulting to one that cannot seal', () => {
    expect(hasSecretStore()).toBe(false)
    expect(() => getSecretStore()).toThrow(/SecretStore not initialized/)
  })

  it('returns the installed store', () => {
    const store = fakeStore()
    setSecretStore(store)
    expect(hasSecretStore()).toBe(true)
    expect(getSecretStore()).toBe(store)
    expect(getSecretStore().encryptString('token').toString()).toBe('sealed:token')
  })

  it('lets a later install replace an earlier one, so a test fake wins over the global default', () => {
    setSecretStore(fakeStore())
    setSecretStore(fakeStore({ isEncryptionAvailable: () => false }))
    expect(getSecretStore().isEncryptionAvailable()).toBe(false)
  })

  it('carries a reason when sealing is unavailable, so the degradation can be surfaced', () => {
    setSecretStore(
      fakeStore({
        isEncryptionAvailable: () => false,
        describeProtectionGap: () => 'The OS keyring is unavailable.'
      })
    )
    expect(getSecretStore().describeProtectionGap()).toBe('The OS keyring is unavailable.')
  })
})

// odin(secrets-guard-scope): the four safeStorage-backed stores routed through getSecretStore()
// by odin(secrets-guard) (MiniMax API key/cookie, plugin secrets, cloud session) can be reached
// before setSecretStore() runs during startup — a race that used to call safeStorage directly and
// degrade gracefully, but now throws an uncaught error from getSecretStore()'s uninstalled path.
describe('getSecretStoreOrUnavailable', () => {
  beforeEach(() => {
    _resetSecretStoreForTests()
  })

  it('falls back to reporting unavailable instead of throwing when no store is installed', () => {
    expect(hasSecretStore()).toBe(false)
    expect(() => getSecretStoreOrUnavailable()).not.toThrow()
    expect(getSecretStoreOrUnavailable().isEncryptionAvailable()).toBe(false)
  })

  it('returns the real installed store once one is set', () => {
    const store = fakeStore()
    setSecretStore(store)
    expect(getSecretStoreOrUnavailable()).toBe(store)
  })

  it('warns once about the race, not again on repeat calls', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      getSecretStoreOrUnavailable()
      getSecretStoreOrUnavailable()
      getSecretStoreOrUnavailable()
      expect(warn).toHaveBeenCalledTimes(1)
      const [message] = warn.mock.calls[0]!
      expect(message).toMatch(/SecretStore/)
      expect(message).toMatch(/plaintext/)
      expect(message).toMatch(/decrypt-failed/)
      expect(message).toMatch(/refuse/)
    } finally {
      warn.mockRestore()
    }
  })

  it('warns again after a fresh install-then-reset cycle, since the reason recurs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      getSecretStoreOrUnavailable()
      setSecretStore(fakeStore())
      _resetSecretStoreForTests()
      getSecretStoreOrUnavailable()
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })
})
