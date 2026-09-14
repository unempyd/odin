import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { getOrcaUserDataPath, resolveOrcaManagedCodexHomePath } from '../codex/codex-home-paths'

// Why: revoking mirror consent must remove the credential copies it already made, not just stop future ones.
export function clearMirroredCodexCredentials(): void {
  rmSync(join(resolveOrcaManagedCodexHomePath(), 'auth.json'), { force: true })
  rmSync(join(getOrcaUserDataPath(), 'codex-runtime-home', 'system-default-auth.json'), {
    force: true
  })
}
