#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools/lib/product_common.sh
source "$SCRIPT_DIR/lib/product_common.sh"

ROOT="$(product_repo_root)"
failed=0

product_require_nonempty_file "$ROOT" docs/design-system/DESIGN_SYSTEM.md || failed=1
product_require_nonempty_file "$ROOT" docs/design-system/tokens.json || failed=1
product_require_nonempty_file "$ROOT" docs/design-system/components.json || failed=1
product_require_nonempty_file "$ROOT" ops/DESIGN_SYSTEM_MANIFEST.tsv || failed=1

node -e 'for (const file of process.argv.slice(1)) JSON.parse(require("node:fs").readFileSync(file, "utf8"));' \
  "$ROOT/docs/design-system/tokens.json" \
  "$ROOT/docs/design-system/components.json" || failed=1

[[ "$failed" -eq 0 ]] || {
  printf 'Product design-system check failed.\n' >&2
  exit 1
}

printf 'Product design-system check passed.\n'
