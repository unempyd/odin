#!/usr/bin/env bash
# Odin Linux proof runner — re-derivable evidence for odin/proofs/linux-proofs.<sha>.txt.
#
# odin/proofs/linux-proofs.txt was produced ad hoc against a stray copy of the tree, pinned to
# Odin 37a8b5489f (~20 commits behind HEAD at review round 3 — see the round-3 review's item 16
# and deviation 11), with no checked-in script to reproduce it. This script is that script.
#
# From the repo root on macOS with Docker Desktop, it:
#   1. Makes a real, self-contained `git clone --local` of HEAD (not a bind mount of the working
#      tree as-is) so the container gets a genuine `.git` with full history. A linked worktree's
#      `.git` is a text file (`gitdir: /Users/.../.git/worktrees/<name>`) pointing at an absolute
#      host path that does not exist inside the container, and a plain tarball/archive copy would
#      drop history entirely — odin/proof/run-proofs.sh needs real history, since it runs
#      `git worktree add --detach "$UPSTREAM_SHA"` against the very tree it is given. A local
#      clone also naturally excludes node_modules/out (gitignored, never committed), so there is
#      no symlink-across-host-paths problem to route around inside the container either.
#   2. Bind-mounts that clone read-only into a `node:24-bookworm` (linux/x86_64) container and
#      copies it to a container-local dir (`/work`) — native modules such as node-pty must
#      compile inside the container against the container's own glibc/ABI, and a build cannot
#      write into a read-only mount.
#   3. Installs with the pnpm version pinned in the repo's own `package.json` `packageManager`
#      field (never hardcoded), activated through corepack.
#   4. Runs odin/proof/run-proofs.sh (all residuals from odin/proof/manifest.json, or just
#      `--only <id>` — see below) and, unless `--only` is set, the twelve process-ownership test
#      files linux-proofs.txt names, directly through vitest with real `ps`/`/proc`. No separate
#      build step runs: every proof and ownership test executes its TypeScript source straight
#      through vitest — none of them import anything under `out/` — so `pnpm run build:*` (which
#      also assumes a macOS/Electron toolchain this container does not have) is neither required
#      nor invoked; the only "build" these proofs need is the native-module rebuild pnpm's own
#      postinstall performs for linux-x64.
#   5. Writes odin/proofs/linux-proofs.<sha>.txt recording the Odin sha, the resolved container
#      image digest, and the per-residual / per-file results captured verbatim from the container.
#   6. Exits non-zero if the clone, the container, the install, any residual, or any ownership
#      test file fails.
#
# Usage: odin/proof/run-proofs-linux.sh [--only <id>] [--timeout-sec <seconds>] [--memory <docker-mem>]
#   --only <id>        forward to run-proofs.sh as `--only <id>` and skip the twelve-file
#                       ownership run — for a fast smoke test, not a substitute for the full run.
#   --timeout-sec <n>   wall-clock budget for the whole `docker run` (default 5400 = 90 min for
#                       the full suite; pass a smaller budget for a smoke test). Enforced with
#                       `timeout`/`gtimeout` if either is on PATH; otherwise the run is unbounded
#                       and a warning is printed — the caller is still responsible for an outer
#                       foreground timeout per AGENTS.md.
#   --memory <n>        docker `--memory` limit (default 3500m, mirroring the Docker Desktop 4 GB
#                       VM this was validated against — node-pty's node-gyp rebuild is the part
#                       that feels memory pressure).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="node:24-bookworm"
ONLY=""
TIMEOUT_SEC="5400"
DOCKER_MEMORY="3500m"

while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --timeout-sec) TIMEOUT_SEC="$2"; shift 2 ;;
    --memory) DOCKER_MEMORY="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "docker not found on PATH" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node not found on PATH" >&2; exit 1; }

cd "$ROOT"
SHA="$(git rev-parse HEAD)"
SHORT_SHA="$(git rev-parse --short=10 HEAD)"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "WARNING: working tree has uncommitted changes; this run reflects committed HEAD ($SHA) only (via a real 'git clone --local'), not the working tree." >&2
fi

PM_SPEC="$(node -e "console.log(require('$ROOT/package.json').packageManager)")"
PM_VERSION="${PM_SPEC#pnpm@}"
PM_VERSION="${PM_VERSION%%+*}"
if [ -z "$PM_VERSION" ]; then
  echo "could not read packageManager from package.json" >&2
  exit 1
fi

OWNERSHIP_TEST_FILES="src/main/pty/posix-pty-process-groups.integration.test.ts src/main/pty/posix-pty-process-groups.test.ts src/main/pty/posix-pty-foreground-group.test.ts src/main/providers/agent-foreground-process-batch.test.ts src/main/providers/agent-foreground-process.test.ts src/main/providers/agent-foreground-process-real-rows.test.ts src/main/providers/posix-pane-foreground-fingerprint.test.ts src/shared/process-table-snapshot.test.ts src/shared/cheap-process-table-snapshot.test.ts src/main/daemon/terminal-host-session-reaping-leak.test.ts src/main/daemon/terminal-host-process-inspection.test.ts src/main/runtime/orchestration/worker-terminal-process-liveness.test.ts"
for f in $OWNERSHIP_TEST_FILES; do
  [ -f "$ROOT/$f" ] || { echo "ownership test file missing at HEAD: $f" >&2; exit 1; }
done

OUT_DIR="$ROOT/odin/proofs"
mkdir -p "$OUT_DIR"
RESULT_FILE="$OUT_DIR/linux-proofs.$SHORT_SHA.txt"
# Deliberately a sibling of $ROOT (i.e. still under /Users), not /tmp or "${TMPDIR:-/tmp}":
# on this machine's Docker Desktop, bind-mounting anything under /tmp (real path
# /private/tmp) silently desyncs — `docker run -v /tmp/x:/y node:24-bookworm cat /y` reports
# "Is a directory" for a plain file, and a mounted directory reads back empty even right after
# being populated on the host. /Users paths mount correctly (verified directly). A first pass at
# this script hit exactly the single-file case of that bug (`/run.sh: /run.sh: Is a directory`,
# docker exit=126) before this was root-caused.
WORKDIR="$(mktemp -d "$(dirname "$ROOT")/.odin-linux-proof-XXXXXX")"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

CLONE_DIR="$WORKDIR/clone"
LOG_TMP="$WORKDIR/run.log"
CONTAINER_SCRIPT="$WORKDIR/container-run.sh"

echo "== cloning HEAD ($SHA) into a container-mountable, worktree-free checkout"
git clone --local --quiet "$ROOT" "$CLONE_DIR"
git -C "$CLONE_DIR" checkout --quiet --detach "$SHA"

echo "== resolving $IMAGE"
docker pull --platform linux/amd64 "$IMAGE" >/dev/null
IMAGE_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null || true)"
[ -n "$IMAGE_DIGEST" ] || IMAGE_DIGEST="$IMAGE (no repo digest — locally built or untagged pull)"

# Written with a single-quoted heredoc so nothing here expands on the host; every variable it
# needs comes in through the container's environment (-e below), not string interpolation.
cat <<'CONTAINER_EOF' > "$CONTAINER_SCRIPT"
set -uo pipefail
echo "== copying tree"
mkdir -p /work
cp -a /repo-ro/. /work/ || { echo "copy failed"; exit 1; }
cd /work
echo "== corepack pnpm ${PM_VERSION}"
corepack enable >/dev/null 2>&1 || true
corepack prepare "pnpm@${PM_VERSION}" --activate || { echo "corepack prepare failed"; exit 1; }
echo "== install (also builds native modules for linux-x64, e.g. node-pty, via postinstall)"
pnpm install --frozen-lockfile || { echo "pnpm install failed"; exit 1; }
echo "== proofs"
if [ -n "${ONLY}" ]; then
  bash odin/proof/run-proofs.sh --only "${ONLY}"
else
  bash odin/proof/run-proofs.sh
fi
proofs_exit=$?
if [ -z "${ONLY}" ]; then
  echo "== ownership-related files"
  # shellcheck disable=SC2086
  ./node_modules/.bin/vitest run --config config/vitest.config.ts ${OWNERSHIP_TEST_FILES}
  ownership_exit=$?
else
  echo "== ownership-related files: skipped (--only ${ONLY} smoke test)"
  ownership_exit=0
fi
echo "node $(node --version) $(uname -s) $(uname -m) ps=$(command -v ps || echo missing)"
if [ "$proofs_exit" -ne 0 ] || [ "$ownership_exit" -ne 0 ]; then
  echo "proofs_exit=$proofs_exit ownership_exit=$ownership_exit"
  exit 1
fi
exit 0
CONTAINER_EOF

TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
else
  echo "WARNING: no 'timeout'/'gtimeout' on PATH — the docker run below is unbounded; the caller must enforce an outer foreground timeout." >&2
fi

RUN_PREFIX=()
if [ -n "$TIMEOUT_BIN" ]; then
  RUN_PREFIX=("$TIMEOUT_BIN" "$TIMEOUT_SEC")
fi

{
  echo "# Linux proof run — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node:24-bookworm container (Docker Desktop, linux/x86_64, ${DOCKER_MEMORY} cap) on a real 'git clone --local' of odin @ $SHA; corepack-pinned pnpm@$PM_VERSION install --frozen-lockfile inside the container"
  echo "# image digest: $IMAGE_DIGEST"
  [ -n "$ONLY" ] && echo "# --only $ONLY smoke test: twelve-file ownership run skipped"
  echo
} > "$LOG_TMP"

set +e
"${RUN_PREFIX[@]}" docker run --rm \
  --platform linux/amd64 \
  --memory "$DOCKER_MEMORY" \
  -v "$CLONE_DIR:/repo-ro:ro" \
  -v "$CONTAINER_SCRIPT:/run.sh:ro" \
  -e "PM_VERSION=$PM_VERSION" \
  -e "ONLY=$ONLY" \
  -e "OWNERSHIP_TEST_FILES=$OWNERSHIP_TEST_FILES" \
  "$IMAGE" \
  bash /run.sh 2>&1 | tee -a "$LOG_TMP"
DOCKER_EXIT="${PIPESTATUS[0]}"
set -e

{
  echo
  echo "docker exit=$DOCKER_EXIT"
} >> "$LOG_TMP"
cp "$LOG_TMP" "$RESULT_FILE"
echo "== wrote $RESULT_FILE"

if [ "$DOCKER_EXIT" -eq 124 ] || [ "$DOCKER_EXIT" -eq 137 ]; then
  { echo "TIMED OUT after ${TIMEOUT_SEC}s (docker exit=$DOCKER_EXIT)"; } | tee -a "$RESULT_FILE" >&2
fi

exit "$DOCKER_EXIT"
