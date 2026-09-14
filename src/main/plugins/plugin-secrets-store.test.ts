import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storageMocks = vi.hoisted(() => {
  let available = true
  return {
    get available(): boolean {
      return available
    },
    set available(value: boolean) {
      available = value
    },
    isEncryptionAvailable: vi.fn(() => available),
    encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`, 'utf8')),
    decryptString: vi.fn((value: Buffer) => {
      const text = value.toString('utf8')
      if (!text.startsWith('encrypted:')) {
        throw new Error('wrong key or corrupt ciphertext')
      }
      return text.slice('encrypted:'.length)
    })
  }
})

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: storageMocks.isEncryptionAvailable,
    encryptString: storageMocks.encryptString,
    decryptString: storageMocks.decryptString
  }
}))

import { setSecretStore } from '../../shared/secret-store'
import { ElectronSecretStore } from '../host/electron-secret-store'
import { PluginSecretsStore } from './plugin-secrets-store'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-secrets-'))
  roots.push(root)
  return root
}

beforeEach(() => {
  // Registered after config/scripts/vitest-host-ports-setup.ts's global beforeEach,
  // so this wins: route the store through the real guard, backed by the mocked
  // electron safeStorage above, instead of that setup's always-available fake.
  setSecretStore(new ElectronSecretStore())
  storageMocks.available = true
  storageMocks.isEncryptionAvailable.mockClear()
  storageMocks.encryptString.mockClear()
  storageMocks.decryptString.mockClear()
  storageMocks.encryptString.mockImplementation((value) =>
    Buffer.from(`encrypted:${value}`, 'utf8')
  )
  storageMocks.decryptString.mockImplementation((value) => {
    const text = value.toString('utf8')
    if (!text.startsWith('encrypted:')) {
      throw new Error('wrong key or corrupt ciphertext')
    }
    return text.slice('encrypted:'.length)
  })
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PluginSecretsStore', () => {
  it('encrypts, persists, decrypts, deletes, and isolates plugin namespaces', async () => {
    const root = await tempRoot()
    const first = new PluginSecretsStore(root, 'acme.first')
    const second = new PluginSecretsStore(root, 'acme.second')

    expect(first.set('token', 'top-secret')).toEqual({ ok: true, value: true })
    expect(first.get('token')).toEqual({ ok: true, value: 'top-secret' })
    expect(second.get('token')).toEqual({ ok: true, value: null })
    const persisted = await readFile(join(root, 'acme.first', 'secrets.json.enc'), 'utf8')
    expect(persisted).not.toContain('top-secret')
    if (process.platform !== 'win32') {
      expect((await stat(join(root, 'acme.first', 'secrets.json.enc'))).mode & 0o077).toBe(0)
    }

    first.delete('token')
    expect(first.get('token')).toEqual({ ok: true, value: null })
  })

  it('fails closed without OS encryption and writes no plaintext file', async () => {
    const root = await tempRoot()
    storageMocks.available = false
    const store = new PluginSecretsStore(root, 'acme.demo')

    expect(store.set('token', 'plaintext')).toMatchObject({ ok: false })
    expect(store.get('token')).toMatchObject({ ok: true, value: null })
    await expect(readFile(join(root, 'acme.demo', 'secrets.json.enc'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('reports corrupt or wrong-key ciphertext without returning bytes', async () => {
    const root = await tempRoot()
    const pluginDir = join(root, 'acme.demo')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
      join(pluginDir, 'secrets.json.enc'),
      JSON.stringify({
        version: 1,
        format: 'electron-safe-storage-v1',
        ciphertexts: { token: Buffer.from('not-encrypted').toString('base64') }
      })
    )
    const store = new PluginSecretsStore(root, 'acme.demo')

    expect(store.get('token')).toEqual({ ok: false, error: 'failed to decrypt stored secret' })
  })

  it('refuses ciphertext that would exceed the bounded vault', async () => {
    const root = await tempRoot()
    storageMocks.encryptString.mockReturnValue(Buffer.alloc(6 * 1024 * 1024))
    const store = new PluginSecretsStore(root, 'acme.demo')

    expect(store.set('token', 'small-input')).toMatchObject({ ok: false })
    await expect(readFile(join(root, 'acme.demo', 'secrets.json.enc'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('rejects unsafe plugin namespaces', async () => {
    const root = await tempRoot()
    expect(() => new PluginSecretsStore(root, 'constructor.demo')).toThrow('unsafe plugin key')
  })

  // Why: a windowless launch can never answer the macOS Keychain prompt that
  // safeStorage.isEncryptionAvailable() blocks on, so this store must never touch it
  // (odin/proofs/ssh-boundary.md §Deviation 3; commit da89b6b5b8 fixed the shared guard
  // but left this direct call site unrouted).
  describe('windowless launch', () => {
    const originalBackgroundLaunch = process.env.ORCA_BACKGROUND_LAUNCH

    afterEach(() => {
      if (originalBackgroundLaunch === undefined) {
        delete process.env.ORCA_BACKGROUND_LAUNCH
      } else {
        process.env.ORCA_BACKGROUND_LAUNCH = originalBackgroundLaunch
      }
    })

    it('refuses to store without calling safeStorage.isEncryptionAvailable', async () => {
      process.env.ORCA_BACKGROUND_LAUNCH = '1'
      const root = await tempRoot()
      const store = new PluginSecretsStore(root, 'acme.demo')

      expect(store.set('token', 'plaintext')).toEqual({
        ok: false,
        error: 'OS-backed encryption is unavailable; secret not stored'
      })
      expect(storageMocks.isEncryptionAvailable).not.toHaveBeenCalled()
      expect(storageMocks.encryptString).not.toHaveBeenCalled()
    })

    it('reports unavailable on get without calling safeStorage.isEncryptionAvailable', async () => {
      const root = await tempRoot()
      const pluginDir = join(root, 'acme.demo')
      await mkdir(pluginDir, { recursive: true })
      await writeFile(
        join(pluginDir, 'secrets.json.enc'),
        JSON.stringify({
          version: 1,
          format: 'electron-safe-storage-v1',
          ciphertexts: { token: Buffer.from('encrypted:top-secret').toString('base64') }
        })
      )
      process.env.ORCA_BACKGROUND_LAUNCH = '1'
      const store = new PluginSecretsStore(root, 'acme.demo')

      expect(store.get('token')).toEqual({
        ok: false,
        error: 'OS-backed encryption is unavailable'
      })
      expect(storageMocks.isEncryptionAvailable).not.toHaveBeenCalled()
      expect(storageMocks.decryptString).not.toHaveBeenCalled()
    })
  })
})
