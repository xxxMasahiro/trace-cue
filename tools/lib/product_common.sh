#!/usr/bin/env bash

product_repo_root() {
  if [[ -n "${PRODUCT_REPO_ROOT:-}" ]]; then
    printf '%s\n' "$PRODUCT_REPO_ROOT"
    return
  fi
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

product_rel() {
  local root="$1"
  local path="$2"
  printf '%s' "${path#"$root"/}"
}

product_require_file() {
  local root="$1"
  local rel="$2"
  [[ -f "$root/$rel" ]] || {
    printf 'missing file: %s\n' "$rel" >&2
    return 1
  }
}

product_require_nonempty_file() {
  local root="$1"
  local rel="$2"
  [[ -s "$root/$rel" ]] || {
    printf 'missing or empty file: %s\n' "$rel" >&2
    return 1
  }
}

product_require_dir() {
  local root="$1"
  local rel="$2"
  [[ -d "$root/$rel" ]] || {
    printf 'missing directory: %s\n' "$rel" >&2
    return 1
  }
}

product_check_tsv() {
  local file="$1"
  awk -F '\t' '
    /^[[:space:]]*$/ { next }
    {
      if (!seen) {
        columns = NF
        seen = 1
        next
      }
      if (NF != columns) {
        invalid = 1
      }
    }
    END { exit (seen && !invalid) ? 0 : 1 }
  ' "$file"
}
