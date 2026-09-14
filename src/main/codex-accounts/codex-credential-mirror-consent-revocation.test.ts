import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearMirroredCodexCredentials } from './codex-credential-mirror-consent-revocation'

// G2: revocation deleted auth.json and the system-default-auth.json snapshot but left the full
// credential sitting in shared-runtime-auth-provenance.json (authJson / runtimeAuthJson), so a
// revoked user still had a stored credential copy on disk. Revocation must remove every copy.
describe('clearMirroredCodexCredentials provenance scrub (G2)', () => {
  let userDataDir: string
  let previousUserDataPath: string | undefined

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-revocation-'))
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = userDataDir
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
  })

  it('removes the credential copy stored in shared-runtime-auth-provenance.json', () => {
    const provenancePath = join(
      userDataDir,
      'codex-runtime-home',
      'shared-runtime-auth-provenance.json'
    )
    writeFileSync(
      provenancePath,
      `${JSON.stringify({ owner: 'system-default', authJson: '{"tokens":{"refresh_token":"secret"}}' })}\n`,
      'utf-8'
    )

    clearMirroredCodexCredentials()

    expect(existsSync(provenancePath)).toBe(false)
  })
})
