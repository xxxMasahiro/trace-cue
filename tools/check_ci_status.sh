#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
required=0
workflow="${CI_STATUS_WORKFLOW_NAME:-CI}"
commit=""
run_id=""
retry_count="${CI_STATUS_RETRY_COUNT:-3}"
timeout_seconds="${CI_STATUS_TIMEOUT_SECONDS:-30}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --required) required=1; shift ;;
    --workflow) workflow="${2:-}"; shift 2 ;;
    --commit) commit="${2:-}"; shift 2 ;;
    --run-id) run_id="${2:-}"; shift 2 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done

[[ "$retry_count" =~ ^[1-9][0-9]*$ ]] || { printf 'CI_STATUS_RETRY_COUNT must be positive.\n' >&2; exit 1; }
[[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || { printf 'CI_STATUS_TIMEOUT_SECONDS must be positive.\n' >&2; exit 1; }
[[ "$workflow" =~ ^[A-Za-z0-9._[:space:]-]+$ ]] || { printf 'Workflow name contains unsupported characters.\n' >&2; exit 1; }

if ! command -v gh >/dev/null 2>&1; then
  printf 'gh is not installed; remote CI could not be checked.\n' >&2
  [[ "$required" -eq 1 ]] && exit 1 || exit 0
fi
if ! timeout "$timeout_seconds" gh auth token >/dev/null 2>&1; then
  printf 'gh is not authenticated; remote CI could not be checked.\n' >&2
  [[ "$required" -eq 1 ]] && exit 1 || exit 0
fi

remote_url="$(git -C "$ROOT" remote get-url origin 2>/dev/null || true)"
repo=""
case "$remote_url" in
  https://github.com/*) repo="${remote_url#https://github.com/}"; repo="${repo%.git}" ;;
  git@github.com:*) repo="${remote_url#git@github.com:}"; repo="${repo%.git}" ;;
esac
[[ "$repo" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]] || { printf 'GitHub repository could not be derived from origin.\n' >&2; exit 1; }

if [[ -z "$commit" ]]; then
  commit="$(git -C "$ROOT" rev-parse HEAD)"
fi
[[ "$commit" =~ ^[0-9a-f]{40}$|^[0-9a-f]{64}$ ]] || { printf 'A full commit SHA is required.\n' >&2; exit 1; }

gh_retry() {
  local attempt
  for ((attempt = 1; attempt <= retry_count; attempt += 1)); do
    if timeout "$timeout_seconds" gh "$@"; then return 0; fi
    [[ "$attempt" -lt "$retry_count" ]] && sleep 2
  done
  return 1
}

if [[ -z "$run_id" ]]; then
  run_id="$(
    gh_retry api -X GET "repos/$repo/actions/runs" -f per_page=50 \
      --jq "[.workflow_runs[] | select(.head_sha == \"$commit\" and .name == \"$workflow\")][0].id // empty" 2>/dev/null
  )"
fi
[[ "$run_id" =~ ^[1-9][0-9]*$ ]] || { printf 'No matching CI run found for commit %s.\n' "$commit" >&2; exit 1; }

run_tsv="$(gh_retry api -X GET "repos/$repo/actions/runs/$run_id" --jq '[.name,.head_sha,.status,(.conclusion // "")] | @tsv')"
IFS=$'\t' read -r actual_workflow actual_head status conclusion <<<"$run_tsv"
[[ "$actual_workflow" == "$workflow" ]] || { printf 'CI workflow mismatch: %s\n' "$actual_workflow" >&2; exit 1; }
[[ "$actual_head" == "$commit" ]] || { printf 'CI commit mismatch: %s\n' "$actual_head" >&2; exit 1; }
[[ "$status" == "completed" && "$conclusion" == "success" ]] || {
  printf 'CI run is not successful: %s/%s\n' "$status" "$conclusion" >&2
  exit 1
}

jobs_tsv="$(gh_retry api --paginate -X GET "repos/$repo/actions/runs/$run_id/jobs" --jq '.jobs[] | [.name,.status,(.conclusion // "")] | @tsv')"
[[ -n "$jobs_tsv" ]] || { printf 'CI run has no jobs.\n' >&2; exit 1; }
if ! awk -F '\t' '$2 != "completed" || $3 != "success" { print "CI job is not successful: " $1 " (" $2 "/" $3 ")" > "/dev/stderr"; failed=1 } END { exit failed ? 1 : 0 }' <<<"$jobs_tsv"; then
  exit 1
fi

printf 'Remote CI passed for %s at %s (run %s, all jobs successful).\n' "$workflow" "$commit" "$run_id"
