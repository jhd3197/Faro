#!/usr/bin/env bash
# Runs inside the ci-local container: every step of .github/workflows/ci.yml,
# in order, against a copy of the working tree. Unlike CI it keeps going after
# a failure and prints a summary, so one run shows everything that's broken.
set -u
export CARGO_TARGET_DIR=/cache/target CHROME_PATH=/usr/bin/google-chrome CARGO_TERM_COLOR=never NO_COLOR=1

# CI's dtolnay/rust-toolchain@stable always takes the newest stable; so do we,
# or a lint added in a new release only shows up after the push.
rustup update stable --no-self-update >/dev/null 2>&1
echo "rustc: $(rustc --version)"

find /w -mindepth 1 -delete 2>/dev/null; mkdir -p /w
(cd /src && tar --exclude=./node_modules --exclude=./src-tauri/target --exclude=./.shots -cf - .) | tar -xf - -C /w
cd /w

declare -a NAMES=() RESULTS=()
step() {
  local name="$1"; shift
  local log="/logs/$(echo "$name" | tr -c 'A-Za-z0-9' '_').log"
  local t0=$SECONDS
  echo "::: $name"
  if ( "$@" ) >"$log" 2>&1; then RESULTS+=("PASS"); else RESULTS+=("FAIL"); tail -40 "$log"; fi
  NAMES+=("$name ($((SECONDS - t0))s)")
}

step "actionlint" actionlint -shellcheck= .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/release-notes.yml
step "npm ci" npm ci --cache /cache/npm --no-audit --no-fund
step "unit tests" npm run test:unit
step "typescript + vite build" npm run build
step "UI tests" npm run test:ui
step "cargo check" bash -c "cd src-tauri && cargo check --locked --workspace"
step "rust tests" bash -c "cd src-tauri && cargo test --locked -p faro --lib && cargo test --locked -p faro-cli"
step "S3 CLI audit" bash -c "cargo build --locked --manifest-path src-tauri/Cargo.toml -p faro-cli && ln -sfn /cache/target src-tauri/target && python3 scripts/audit-s3-cli.py"
step "clippy" bash -c "cd src-tauri && cargo clippy --locked --workspace --all-targets -- -D warnings"

echo
echo "===== ci-local summary ($(rustc --version)) ====="
fail=0
for i in "${!NAMES[@]}"; do
  printf '%s  %s\n' "${RESULTS[$i]}" "${NAMES[$i]}"
  [ "${RESULTS[$i]}" = FAIL ] && fail=1
done
echo "logs: scripts/ci-local/logs/"
[ $fail = 0 ] && echo "ALL GREEN" || echo "NOT GREEN"
exit $fail
