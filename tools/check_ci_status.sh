#!/usr/bin/env bash
set -euo pipefail

ROOT="${CI_STATUS_REPOSITORY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
POLICY="$ROOT/ops/VERIFICATION_EXECUTION_POLICY.json"
required=0
policy_workflow="$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(p.ci_graph.workflow_contract.name);' "$POLICY")"
policy_workflow_path="$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(p.evidence_policy.ci_proof_workflow_path);' "$POLICY")"
policy_remote="$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(p.evidence_policy.ci_proof_repository_remote);' "$POLICY")"
workflow="$policy_workflow"
workflow_path="$policy_workflow_path"
remote_name="$policy_remote"
commit=""
run_id=""
retry_count="${CI_STATUS_RETRY_COUNT:-3}"
timeout_seconds="${CI_STATUS_TIMEOUT_SECONDS:-30}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --required) required=1; shift ;;
    --commit) commit="${2:-}"; shift 2 ;;
    --run-id) run_id="${2:-}"; shift 2 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done

[[ "$retry_count" =~ ^[1-9][0-9]*$ ]] || { printf 'CI_STATUS_RETRY_COUNT must be positive.\n' >&2; exit 1; }
[[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || { printf 'CI_STATUS_TIMEOUT_SECONDS must be positive.\n' >&2; exit 1; }
[[ "$workflow" =~ ^[A-Za-z0-9._[:space:]-]+$ ]] || { printf 'Workflow name contains unsupported characters.\n' >&2; exit 1; }
[[ "$remote_name" =~ ^[A-Za-z0-9._-]+$ ]] || { printf 'Remote name contains unsupported characters.\n' >&2; exit 1; }

if ! command -v gh >/dev/null 2>&1; then
  printf 'gh is not installed; remote CI could not be checked.\n' >&2
  [[ "$required" -eq 1 ]] && exit 1 || exit 0
fi
identity="$({
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    const root = process.argv[1];
    const remote = process.argv[2];
    const policy = JSON.parse(readFileSync(process.argv[3], "utf8"));
    const { githubRepositoryIdentity } = await import(pathToFileURL(process.argv[4]).href);
    const value = githubRepositoryIdentity(root, remote, policy.evidence_policy.ci_proof_repository_hosts);
    process.stdout.write(`${value.hostname}\t${value.repository}`);
  ' "$ROOT" "$remote_name" "$POLICY" "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/github-repository-identity.mjs"
} 2>/dev/null)" || { printf 'GitHub repository could not be derived from configured remote %s.\n' "$remote_name" >&2; exit 1; }
IFS=$'\t' read -r github_host repo <<<"$identity"
[[ -n "$github_host" && "$repo" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]] || { printf 'GitHub repository could not be derived from configured remote %s.\n' "$remote_name" >&2; exit 1; }
if ! timeout "$timeout_seconds" gh auth token --hostname "$github_host" >/dev/null 2>&1; then
  printf 'gh is not authenticated; remote CI could not be checked.\n' >&2
  [[ "$required" -eq 1 ]] && exit 1 || exit 0
fi

[[ "$workflow_path" =~ ^[A-Za-z0-9._/-]+\.ya?ml$ ]] || { printf 'Workflow path contains unsupported characters.\n' >&2; exit 1; }

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
    gh_retry api --hostname "$github_host" -X GET "repos/$repo/actions/runs" -f per_page=50 \
      --jq "[.workflow_runs[] | select(.head_sha == \"$commit\" and .name == \"$workflow\" and .path == \"$workflow_path\")][0].id // empty" 2>/dev/null
  )"
fi
[[ "$run_id" =~ ^[1-9][0-9]*$ ]] || { printf 'No matching CI run found for commit %s.\n' "$commit" >&2; exit 1; }

run_tsv="$(gh_retry api --hostname "$github_host" -X GET "repos/$repo/actions/runs/$run_id" --jq '[.name,.path,.head_sha,.status,(.conclusion // "")] | @tsv')"
IFS=$'\t' read -r actual_workflow actual_path actual_head status conclusion <<<"$run_tsv"
[[ "$actual_workflow" == "$workflow" ]] || { printf 'CI workflow mismatch: %s\n' "$actual_workflow" >&2; exit 1; }
[[ "$actual_path" == "$workflow_path" ]] || { printf 'CI workflow path mismatch: %s\n' "$actual_path" >&2; exit 1; }
[[ "$actual_head" == "$commit" ]] || { printf 'CI commit mismatch: %s\n' "$actual_head" >&2; exit 1; }
[[ "$status" == "completed" && "$conclusion" == "success" ]] || {
  printf 'CI run is not successful: %s/%s\n' "$status" "$conclusion" >&2
  exit 1
}

jobs_tsv="$(gh_retry api --hostname "$github_host" --paginate -X GET "repos/$repo/actions/runs/$run_id/jobs" --jq '.jobs[] | [.name,.status,(.conclusion // "")] | @tsv')"
[[ -n "$jobs_tsv" ]] || { printf 'CI run has no jobs.\n' >&2; exit 1; }
if ! awk -F '\t' '$2 != "completed" || $3 != "success" { print "CI job is not successful: " $1 " (" $2 "/" $3 ")" > "/dev/stderr"; failed=1 } END { exit failed ? 1 : 0 }' <<<"$jobs_tsv"; then
  exit 1
fi

printf 'Remote CI passed for %s at %s (run %s, all jobs successful).\n' "$workflow" "$commit" "$run_id"
