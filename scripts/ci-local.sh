#!/usr/bin/env bash
# Run the whole CI workflow locally, in Docker, before pushing.
#
#   bash scripts/ci-local.sh
#
# Same image as the CI runner (ubuntu-22.04), newest stable Rust, the same
# steps as .github/workflows/ci.yml (actionlint, unit, build, UI, cargo check,
# Rust tests, S3 audit, clippy). Runs every step even after a failure and ends
# with a PASS/FAIL table; exit code 0 only when all are green. Per-step logs go
# to scripts/ci-local/logs/. Cargo/npm caches live in Docker volumes, so the
# first run is slow (~30 min) and later runs are much faster.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
# Docker on Windows wants a Windows path for bind mounts.
if command -v cygpath >/dev/null; then mroot="$(cygpath -m "$root")"; else mroot="$root"; fi
export MSYS_NO_PATHCONV=1

docker build -q -t faro-ci-local "$mroot/scripts/ci-local" >/dev/null
mkdir -p "$here/ci-local/logs" && rm -f "$here/ci-local/logs/"*.log
# Chrome's sandbox needs user namespaces: the default seccomp profile blocks
# them and Docker Desktop also wants SYS_ADMIN. (The GitHub runner is a full
# VM, so it never hits this; several UI tests don't pass --no-sandbox.)
docker run --rm --security-opt seccomp=unconfined --cap-add SYS_ADMIN \
  -v "$mroot:/src:ro" \
  -v "$mroot/scripts/ci-local/logs:/logs" \
  -v faro-ci-local-cache:/cache \
  -v faro-ci-local-cargo:/usr/local/cargo/registry \
  faro-ci-local bash /src/scripts/ci-local/steps.sh
