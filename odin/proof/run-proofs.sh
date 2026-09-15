#!/usr/bin/env bash
# Odin proof runner — proves each residual failure reproduced on upstream Orca and no longer reproduces on Odin.
#
# For every entry in odin/proof/manifest.json:
#   1. REPRODUCE: copy the proof test files from this checkout into a scratch worktree at the upstream Orca commit
#      and run them there. The manifest's `reproduce` regex (the behavioural assertion) must appear in the
#      failure output; a missing symbol or an import error does not count.
#   2. CLOSE: run the same test files on this checkout. They must PASS.
# Exit code is non-zero if any residual does not reproduce upstream or is not closed here.
#
# Usage: odin/proof/run-proofs.sh [--only <id>]
set -u
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MANIFEST="$ROOT/odin/proof/manifest.json"
UPSTREAM_SHA="$(node -e "console.log(require('$MANIFEST').upstream)")"

ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --only)
      shift
      if [ $# -eq 0 ] || [ -z "$1" ]; then
        echo "run-proofs.sh: --only requires an id (usage: run-proofs.sh [--only <id>])" >&2
        exit 2
      fi
      ONLY="$1"
      ;;
    *)
      echo "run-proofs.sh: unknown argument '$1' (usage: run-proofs.sh [--only <id>])" >&2
      exit 2
      ;;
  esac
  shift
done

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/odin-upstream-XXXXXX")"
trap 'cd "$ROOT" && git worktree remove --force "$SCRATCH" >/dev/null 2>&1; rm -rf "$SCRATCH"' EXIT

# Why here, not odin/proofs/ directly: these logs are regenerated every run and are debugging
# output, not evidence — unlike the checked-in <id>.before.txt/<id>.after.txt proof files that
# share that directory. Gitignored so a future non-selective `git add` cannot pick them up.
LOGDIR="$ROOT/odin/proofs/logs"
mkdir -p "$LOGDIR"

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
  # REPRODUCE means the named behavioural assertion fails at upstream — a missing symbol, an import
  # error or an infrastructure failure is NOT a reproduction, so the manifest's `reproduce` regex must match.
  reproduce_rx="$(node -e "const m=require('$MANIFEST');console.log(m.residuals.find(r=>r.id==='$id').reproduce||'')")"
  if (cd "$SCRATCH" && "$ROOT/node_modules/.bin/vitest" run --config config/vitest.config.ts $tests >"$LOGDIR/$id.before.log" 2>&1); then
    echo "  REPRODUCE: FAILED — proof tests pass on upstream $UPSTREAM_SHA (residual did not reproduce)"; fail=1
  elif [ -n "$reproduce_rx" ] && ! grep -Eq "$reproduce_rx" "$LOGDIR/$id.before.log"; then
    echo "  REPRODUCE: FAILED — tests failed on upstream but not with the expected assertion /$reproduce_rx/"; fail=1
  else
    echo "  REPRODUCE: ok — /$reproduce_rx/ fails on upstream $UPSTREAM_SHA"
  fi
  if (cd "$ROOT" && "$ROOT/node_modules/.bin/vitest" run --config config/vitest.config.ts $tests >"$LOGDIR/$id.run.log" 2>&1); then
    echo "  CLOSE:     ok — proof tests pass on Odin $(git rev-parse --short HEAD)"
  else
    echo "  CLOSE:     FAILED — see odin/proofs/logs/$id.run.log"; fail=1
  fi
  cp "$LOGDIR/$id.before.log" "$LOGDIR/$id.upstream.log"
  [ "$fail" = 1 ] && echo 1 > "$SCRATCH/.fail"
done
[ -f "$SCRATCH/.fail" ] && { echo "SOME PROOFS FAILED"; exit 1; }
echo "ALL PROOFS: reproduced upstream, closed on Odin"
