#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools/lib/product_common.sh
source "$SCRIPT_DIR/lib/product_common.sh"

ROOT="$(product_repo_root)"
failed=0

product_require_nonempty_file "$ROOT" docs/workflow/SECURITY.md || failed=1
product_require_nonempty_file "$ROOT" ops/SECURITY_MANIFEST.tsv || failed=1

while IFS= read -r -d '' file; do
  rel="$(product_rel "$ROOT" "$file")"
  case "$rel" in
    .git/*|node_modules/*|dist/*|build/*|coverage/*|test-results/*|playwright-report/*|.browser-debug/*)
      continue
      ;;
  esac
  grep -Iq . "$file" 2>/dev/null || continue
  if grep -Eq '(SECRET|TOKEN|API_KEY|PASSWORD|PRIVATE_KEY)[[:space:]]*[:=][[:space:]]*[^[:space:]#]{8,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY' "$file"; then
    printf 'secret-like data found in %s\n' "$rel" >&2
    failed=1
  fi
done < <(find "$ROOT" -type f -print0)

while IFS= read -r -d '' file; do
  rel="$(product_rel "$ROOT" "$file")"
  printf 'environment file must not be committed: %s\n' "$rel" >&2
  failed=1
done < <(find "$ROOT" -type f \( -name '.env' -o -name '.env.*' \) -print0)

[[ "$failed" -eq 0 ]] || {
  printf 'Product security check failed.\n' >&2
  exit 1
}

printf 'Product security check passed.\n'
