#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

run_legacy() {
  "$SCRIPT_DIR/check_product_structure.sh"
  "$SCRIPT_DIR/check_product_docs.sh"
  "$SCRIPT_DIR/check_product_security.sh"
  "$SCRIPT_DIR/check_product_ci.sh"
  "$SCRIPT_DIR/check_product_design_system.sh"
  "$SCRIPT_DIR/product-mode" check
  node "$SCRIPT_DIR/check_document_sync.mjs" --worktree
  if [[ -f "$SCRIPT_DIR/../package.json" ]]; then
    (cd "$SCRIPT_DIR/.." && npm test)
    (cd "$SCRIPT_DIR/.." && npm run --if-present test:rename-readiness)
    (cd "$SCRIPT_DIR/.." && npm run --if-present test:pack)
    (cd "$SCRIPT_DIR/.." && npm run --if-present test:pack-install)
  fi
}

case "${VERIFICATION_EXECUTION_ENGINE:-composed}" in
  composed)
    (cd "$SCRIPT_DIR/.." && node ./tools/verification.mjs run --profile core)
    (cd "$SCRIPT_DIR/.." && node ./tools/verification.mjs run --profile package)
    ;;
  legacy)
    run_legacy
    ;;
  *)
    printf 'Unknown VERIFICATION_EXECUTION_ENGINE: %s\n' "$VERIFICATION_EXECUTION_ENGINE" >&2
    exit 1
    ;;
esac

printf 'Product repository tests passed.\n'
