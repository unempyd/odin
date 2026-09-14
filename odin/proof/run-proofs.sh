#!/usr/bin/env bash
# Odin proof runner — proves each residual failure reproduced on upstream Orca and no longer reproduces on Odin.
#
# For every entry in odin/proof/manifest.json:
#   1. REPRODUCE: copy the proof test files from this checkout into a scratch worktree at the upstream Orca commit
#      and run them there. They must FAIL (or fail to compile because the contract's symbols do not exist yet).
#   2. CLOSE: run the same test files on this checkout. They must PASS.
# Exit code is non-zero if any residual does not reproduce upstream or is not closed here.
#
# Usage: odin/proof/run-proofs.sh [--only <id>]
set -u
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MANIFEST="$ROOT/odin/proof/manifest.json"
UPSTREAM_SHA="$(node -e "console.log(require('$MANIFEST').upstream)")"
ONLY="${2:-}"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/odin-upstream-XXXXXX")"
trap 'cd "$ROOT" && git worktree remove --force "$SCRATCH" >/dev/null 2>&1; rm -rf "$SCRATCH"' EXIT

cd "$ROOT"
git worktree add -q --detach "$SCRATCH" "$UPSTREAM_SHA"
ln -s "$ROOT/node_modules" "$SCRATCH/node_modules"

fail=0
node -e "
const m=require('$MANIFEST');
for (const r of m.residuals) console.log([r.id, r.tests.join(' ')].join('\t'))
" | while IFS=$'\t' read -r id tests; do
  if [ -n "$ONLY" ] && [ "$ONLY" != "$id" ]; then continue; fi
  echo "=== $id"
  for t in $tests; do mkdir -p "$SCRATCH/$(dirname "$t")"; cp "$ROOT/$t" "$SCRATCH/$t"; done
  if (cd "$SCRATCH" && pnpm exec vitest run --config config/vitest.config.ts $tests >"$SCRATCH/$id.before.log" 2>&1); then
    echo "  REPRODUCE: FAILED — proof tests pass on upstream $UPSTREAM_SHA (residual did not reproduce)"; fail=1
  else
    echo "  REPRODUCE: ok — proof tests fail on upstream $UPSTREAM_SHA"
  fi
  if (cd "$ROOT" && pnpm exec vitest run --config config/vitest.config.ts $tests >"$ROOT/odin/proofs/$id.run.log" 2>&1); then
    echo "  CLOSE:     ok — proof tests pass on Odin $(git rev-parse --short HEAD)"
  else
    echo "  CLOSE:     FAILED — see odin/proofs/$id.run.log"; fail=1
  fi
  cp "$SCRATCH/$id.before.log" "$ROOT/odin/proofs/$id.upstream.log"
  [ "$fail" = 1 ] && echo 1 > "$SCRATCH/.fail"
done
[ -f "$SCRATCH/.fail" ] && { echo "SOME PROOFS FAILED"; exit 1; }
echo "ALL PROOFS: reproduced upstream, closed on Odin"
