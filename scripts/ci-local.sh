#!/usr/bin/env bash
# The `check` job of .github/workflows/ci.yml, on this machine.
#
# For building without spending CI minutes: run this before a batch of
# commits and push once. The heavy measurements in proving.yml (the corpus,
# Stripe-sized diffs, real servers) are not here and stay on GitHub.
#
#   scripts/ci-local.sh            lint, typecheck, test, build, packages,
#                                  action bundle, release gate on the fixture
#   scripts/ci-local.sh --quick    lint, typecheck and test only
#   scripts/ci-local.sh --image    also build and prove the proxy image (Docker)
#   scripts/ci-local.sh --install  also install from a local registry and use it
#
# Every step runs under `capped` when it is installed, so a small machine is
# not taken down by a runaway step. Stops at the first failure and says which.
set -euo pipefail
cd "$(dirname "$0")/.."

quick=false image=false install=false
for arg in "$@"; do
  case "$arg" in
    --quick) quick=true ;;
    --image) image=true ;;
    --install) install=true ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

logs="${TMPDIR:-/tmp}/invariant-ci-local"
mkdir -p "$logs"
cap() {
  if command -v capped >/dev/null 2>&1; then capped --mem 2400 -- "$@"; else "$@"; fi
}

step() {
  local name="$1"; shift
  local log="$logs/$(echo "$name" | tr ' A-Z' '-a-z').log"
  local started=$SECONDS
  printf '%-44s' "$name"
  if cap "$@" >"$log" 2>&1; then
    echo "ok ($((SECONDS - started))s)"
  else
    echo "FAILED ($((SECONDS - started))s)"
    tail -40 "$log"
    echo
    echo "full log: $log"
    exit 1
  fi
}

step "oasdiff is the pinned release" node --import tsx -e \
  'import("@invariant/diff").then(async (m) => { await m.assertUsableOasdiff(); })'
step "lint" npx biome check .
step "typecheck" npx tsc --build
step "test" npx vitest run --reporter=dot --maxWorkers=2
if $quick; then echo "quick checks passed"; exit 0; fi

step "build the published packages" pnpm build
step "check the published packages" pnpm check:packages
# The bundle in the working tree has to be what the source builds; CI compares
# with the commit, which here may not exist yet.
step "action bundle is current" bash -c '
  before=$(cat packages/action/bundle/* | sha256sum)
  pnpm --filter @invariant/action bundle
  after=$(cat packages/action/bundle/* | sha256sum)
  [ "$before" = "$after" ] || { echo "the bundle was stale; it has been rebuilt, commit it"; exit 1; }'
step "release gate on the fixture (--full)" bash -c \
  'cd fixtures/provider-acme && timeout 360 pnpm exec invariant check --full'

if $image; then
  step "proxy image" bash -c 'pnpm bundle:sidecar && node --import tsx scripts/image.mts'
fi
if $install; then
  step "install from a registry" node --import tsx scripts/install-test.mts
fi

echo "local CI passed"
