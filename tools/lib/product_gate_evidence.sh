#!/usr/bin/env bash

product_gate_evidence_repo_root() {
  if [[ -n "${PRODUCT_REPO_ROOT:-}" ]]; then
    printf '%s\n' "$PRODUCT_REPO_ROOT"
    return
  fi
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

product_gate_evidence_helper() {
  local dir
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  printf '%s/product-gate-evidence.mjs\n' "$dir"
}

product_gate_evidence_index() {
  printf '%s/.git/product-gate-evidence/index.tsv\n' "$(product_gate_evidence_repo_root)"
}

product_gate_evidence_dir() {
  printf '%s/.git/product-gate-evidence\n' "$(product_gate_evidence_repo_root)"
}

product_gate_evidence_ledger() {
  printf '%s/ledger.jsonl\n' "$(product_gate_evidence_dir)"
}

product_gate_evidence_details_dir() {
  printf '%s/receipts-v2\n' "$(product_gate_evidence_dir)"
}

product_gate_evidence_record() {
  local source_id="${1:-}"
  local context="${2:-}"
  local status="${3:-}"
  local required_in_context="${4:-true}"
  # The legacy authority argument is accepted for source compatibility. Manual
  # records are always downgraded by the helper and can never claim authority.
  local _requested_authority="${5:-manual_required}"
  local max_age_seconds="${6:-3600}"
  local source_artifacts="${7:-}"
  local blocked_by="${8:-}"
  local next_command="${9:-}"
  local repo helper
  repo="$(product_gate_evidence_repo_root)"
  helper="$(product_gate_evidence_helper)"
  node "$helper" manual \
    --repo "$repo" \
    --source-id "$source_id" \
    --context "$context" \
    --status "$status" \
    --required "$required_in_context" \
    --max-age "$max_age_seconds" \
    --source-artifacts "$source_artifacts" \
    --blocked-by "$blocked_by" \
    --next-command "$next_command"
}

product_gate_evidence_run() {
  local source_id="${1:-}"
  local context="${2:-}"
  local source_artifacts="${3:-}"
  local next_command="${4:-}"
  local max_age_seconds="${5:-3600}"
  local repo helper
  shift 5 || true
  if [[ "${1:-}" == "--" ]]; then
    shift
  fi
  if [[ "$#" -eq 0 ]]; then
    product_gate_evidence_record "$source_id" "$context" "blocked" "true" "manual_required" "$max_age_seconds" "$source_artifacts" "$source_id" "$next_command"
    return 2
  fi
  repo="$(product_gate_evidence_repo_root)"
  helper="$(product_gate_evidence_helper)"
  node "$helper" execute \
    --repo "$repo" \
    --source-id "$source_id" \
    --context "$context" \
    --source-artifacts "$source_artifacts" \
    --next-command "$next_command" \
    --max-age "$max_age_seconds" \
    -- "$@"
}

product_gate_evidence_git_status() {
  local context="${1:-free-development}"
  local max_age_seconds="${2:-300}"
  local repo helper
  repo="$(product_gate_evidence_repo_root)"
  helper="$(product_gate_evidence_helper)"
  node "$helper" git-status --repo "$repo" --context "$context" --max-age "$max_age_seconds"
}

product_gate_evidence_status() {
  local repo helper
  repo="$(product_gate_evidence_repo_root)"
  helper="$(product_gate_evidence_helper)"
  node "$helper" status --repo "$repo"
}

product_gate_evidence_rebuild() {
  local repo helper
  repo="$(product_gate_evidence_repo_root)"
  helper="$(product_gate_evidence_helper)"
  node "$helper" rebuild --repo "$repo"
}
