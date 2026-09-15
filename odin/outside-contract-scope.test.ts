import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Ratchet for the round-3 review's item 1/18: a 37-file cluster of operator-directed repository
 * maintenance (CI hygiene, a docs-site host migration, dependency-alert bumps) landed outside
 * odin/, closed no residual, and was never declared anywhere a reader would check -- contradicting
 * this project's own round-2 rule (`ec69813298`: "nothing outside odin/ that closes no residual").
 *
 * Fix is disclosure, not reversion: every file this branch changes relative to upstream that sits
 * outside odin/, src/, docs/reference/, or isn't README.md itself must be named in
 * odin/outside-contract.json's allow-list, built from the diff at the time of this fix. Future
 * drift of this shape must be declared there too, or this test fails.
 */
const ROOT = join(__dirname, '..')

type OutsideContractCluster = { name: string; files: string[] }
type OutsideContractAllowList = { upstreamRef: string; clusters: OutsideContractCluster[] }

const allowList: OutsideContractAllowList = JSON.parse(
  readFileSync(join(__dirname, 'outside-contract.json'), 'utf8')
)
const allowedFiles = new Set(allowList.clusters.flatMap((cluster) => cluster.files))

function filesChangedSinceUpstream(): string[] {
  return execFileSync('git', ['diff', `${allowList.upstreamRef}..HEAD`, '--name-only'], {
    cwd: ROOT,
    encoding: 'utf8'
  })
    .split('\n')
    .filter(Boolean)
}

const CONTRACT_ROOT_PATTERN = /^(odin\/|src\/|docs\/reference\/)/

describe('outside-contract scope', () => {
  it('names every changed file outside odin/, src/, docs/reference/, README.md in the allow-list', () => {
    const undeclared = filesChangedSinceUpstream().filter(
      (file) => file !== 'README.md' && !CONTRACT_ROOT_PATTERN.test(file) && !allowedFiles.has(file)
    )
    expect(undeclared).toEqual([])
  })

  it('keeps the allow-list from accumulating entries that no longer differ from upstream', () => {
    const changed = new Set(filesChangedSinceUpstream())
    const stale = [...allowedFiles].filter((file) => !changed.has(file))
    expect(stale).toEqual([])
  })
})
