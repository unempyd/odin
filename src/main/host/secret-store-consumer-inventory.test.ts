import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Ratchet for round-4 review (Opus, material deviation 5): the windowless-launch safeStorage
 * guard's own enumeration (electron-secret-store.ts, docs/reference/windowless-launch-secret-
 * storage.md) named only the consumers Odin's guard commits touched and missed four pre-existing
 * getSecretStore() callers that degrade identically (Linear, Jira, Bitbucket, OpenAI speech).
 * Discovery below is mechanical, so a future consumer is found automatically; only mapping it to
 * a warning phrase can go stale, and doing so fails this test instead of drifting silently.
 */

const MAIN_ROOT = join(__dirname, '..')
const ELECTRON_SECRET_STORE_PATH = join(MAIN_ROOT, 'host/electron-secret-store.ts')
const REFERENCE_DOC_PATH = join(
  MAIN_ROOT,
  '../../docs/reference/windowless-launch-secret-storage.md'
)

// Reports the gap describeProtectionGap() already computes; stores no credential of its own.
const NON_CONSUMER_EXCEPTIONS = new Set([join(MAIN_ROOT, 'host/secret-protection-report.ts')])

function findSecretStoreConsumers(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...findSecretStoreConsumers(path))
      continue
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) {
      continue
    }
    if (path === ELECTRON_SECRET_STORE_PATH || NON_CONSUMER_EXCEPTIONS.has(path)) {
      continue
    }
    const source = readFileSync(path, 'utf8')
    if (source.includes('getSecretStore(') || source.includes('getSecretStoreOrUnavailable(')) {
      found.push(path)
    }
  }
  return found
}

// A phrase that must appear, verbatim, in the evaluated runtime warning for each consumer's
// credential type. Doc completeness (below) checks the filename instead — mechanical, no table.
const CONSUMER_WARNING_PHRASES: Record<string, string> = {
  'protected-secret-persistence.ts': 'protected settings',
  'minimax-api-key-store.ts': 'MiniMax API key/cookie',
  'minimax-cookie-store.ts': 'MiniMax API key/cookie',
  'plugin-secrets-store.ts': 'plugin secrets refuse',
  'profile-cloud-session-store.ts': 'cloud session reads back',
  'linear-token-store.ts': 'Linear token',
  'site-credential-store.ts': 'Jira token',
  'integration-credential-file.ts': 'Bitbucket credential',
  'openai-api-key-store.ts': 'OpenAI speech API key'
}

const consumers = findSecretStoreConsumers(MAIN_ROOT)

describe('secret store consumer inventory', () => {
  it('discovers every known consumer (guards against the walk itself finding nothing)', () => {
    const names = consumers.map((path) => path.split('/').pop())
    for (const name of Object.keys(CONSUMER_WARNING_PHRASES)) {
      expect(names).toContain(name)
    }
  })

  it('has a warning phrase mapped for every discovered consumer', () => {
    const unmapped = consumers
      .map((path) => path.split('/').pop()!)
      .filter((name) => !(name in CONSUMER_WARNING_PHRASES))
    expect(unmapped).toEqual([])
  })

  it("names every discovered consumer's file in the reference doc", () => {
    const doc = readFileSync(REFERENCE_DOC_PATH, 'utf8')
    const missing = consumers
      .map((path) => path.split('/').pop()!)
      .filter((name) => !doc.includes(name))
    expect(missing).toEqual([])
  })
})

describe('secret store consumer inventory — runtime warning', () => {
  const safeStorageMock = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
    getSelectedStorageBackend: vi.fn()
  }
  const originalBackgroundLaunch = process.env.ORCA_BACKGROUND_LAUNCH
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.resetModules()
    vi.doMock('electron', () => ({ safeStorage: safeStorageMock }))
    process.env.ORCA_BACKGROUND_LAUNCH = '1'
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  })

  afterEach(() => {
    vi.doUnmock('electron')
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    if (originalBackgroundLaunch === undefined) {
      delete process.env.ORCA_BACKGROUND_LAUNCH
    } else {
      process.env.ORCA_BACKGROUND_LAUNCH = originalBackgroundLaunch
    }
  })

  it('names every discovered consumer credential type in the tripped guard warning', async () => {
    const { ElectronSecretStore } = await import('./electron-secret-store')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      new ElectronSecretStore().isEncryptionAvailable()
      const message = warn.mock.calls.map((call) => String(call[0])).join('\n')
      const names = consumers.map((path) => path.split('/').pop()!)
      const missing = names.filter((name) => {
        const phrase = CONSUMER_WARNING_PHRASES[name]
        return phrase !== undefined && !message.includes(phrase)
      })
      expect(missing).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })
})
