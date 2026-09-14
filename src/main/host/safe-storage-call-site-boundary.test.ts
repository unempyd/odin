import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard the safeStorage chokepoint at the tree level rather than per call site.
 *
 * `safeStorage.isEncryptionAvailable()` (and, transitively, `encryptString`/
 * `decryptString`, which the guarded path never calls without checking it first)
 * can block the whole main process forever on a windowless launch — no window to
 * attach the macOS Keychain prompt to, no timeout (odin/proofs/ssh-boundary.md
 * §Deviation 3; froze ssh.connect). `electron-secret-store.ts` is the only file
 * that may touch `safeStorage` directly; every other call site must go through
 * `getSecretStore()` so the windowless guard applies. Four such unrouted sites
 * (profile-cloud-session-store.ts, plugin-secrets-store.ts, and the two MiniMax
 * stores) reproduced the same hang risk on first touch before this test existed.
 *
 * Zero-tolerance, not an allowlist: a new direct call site is exactly the bug
 * this test exists to catch, so it can never be "grandfathered in".
 */
const REPOSITORY_ROOT = resolve(__dirname, '..', '..', '..')
const MAIN_DIRECTORY = 'src/main/'
const OWNER_FILE = 'src/main/host/electron-secret-store.ts'
const SCANNED_EXTENSIONS = ['.ts', '.tsx']
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'out', 'build', '.git'])

/** A member access or destructured call, not an import statement or a comment. */
const SAFE_STORAGE_USAGE = /\bsafeStorage\s*[.[]/

function isTestFile(path: string): boolean {
  return /\.(?:test|spec)\.tsx?$/.test(path) || path.includes('/__tests__/')
}

function collectSourceFiles(root: string): string[] {
  let found: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return found
  }
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry)) {
      continue
    }
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      found = found.concat(collectSourceFiles(full))
      continue
    }
    if (SCANNED_EXTENSIONS.some((extension) => full.endsWith(extension))) {
      found.push(full)
    }
  }
  return found
}

/** Drop comment-only lines so prose about safeStorage is not an offender. */
function codeText(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

describe('safeStorage call-site boundary', () => {
  const files = collectSourceFiles(join(REPOSITORY_ROOT, MAIN_DIRECTORY))
  const offenders = files
    .map((file) => relative(REPOSITORY_ROOT, file).split('\\').join('/'))
    .filter((path) => !isTestFile(path))
    .filter((path) => path !== OWNER_FILE)
    .filter((path) =>
      SAFE_STORAGE_USAGE.test(codeText(readFileSync(join(REPOSITORY_ROOT, path), 'utf8')))
    )

  it('scans a plausible number of files', () => {
    // A broken root or extension list would make the guard silently vacuous.
    expect(files.length).toBeGreaterThan(200)
  })

  it('has no direct safeStorage call site outside electron-secret-store.ts', () => {
    expect(
      offenders,
      'New direct safeStorage usage in src/main. Route it through getSecretStore() ' +
        `(src/shared/secret-store.ts) instead — see ${OWNER_FILE} for why a windowless ` +
        'launch must never touch safeStorage directly.'
    ).toEqual([])
  })
})
