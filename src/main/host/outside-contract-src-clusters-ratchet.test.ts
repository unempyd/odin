import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * src/ mirror of odin/outside-contract-scope.test.ts's srcClusters checks. Lives under src/main/
 * so the upstream proof runner (which copies only the test file into a scratch worktree at the
 * upstream commit) can execute it against upstream's own odin/outside-contract.json.
 */
const ROOT = join(__dirname, '..', '..', '..')

type OutsideContractCluster = { name: string; files: string[] }
type OutsideContractAllowList = {
  upstreamRef: string
  clusters: OutsideContractCluster[]
  srcClusters?: OutsideContractCluster[]
}

function readAllowList(): OutsideContractAllowList {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'odin', 'outside-contract.json'), 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('outside-contract.json is missing — src clusters are not declared')
    }
    throw err
  }
}

const allowList = readAllowList()
const declaredSrcFiles = (allowList.srcClusters ?? []).flatMap((cluster) => cluster.files)

describe('outside-contract src cluster ratchet', () => {
  it('only declares src/ paths in srcClusters', () => {
    const misplaced = declaredSrcFiles.filter((file) => !file.startsWith('src/'))
    expect(misplaced).toEqual([])
  })

  it('keeps every declared srcClusters path on disk', () => {
    const missing = declaredSrcFiles.filter((file) => !existsSync(join(ROOT, file)))
    expect(missing).toEqual([])
  })

  it('declares the safeStorage windowless-launch guard src cluster', () => {
    const names = (allowList.srcClusters ?? []).map((cluster) => cluster.name)
    expect(names).toContain('safe-storage-windowless-launch-guard')
  })
})
