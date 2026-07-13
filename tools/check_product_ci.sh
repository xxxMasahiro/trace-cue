#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools/lib/product_common.sh
source "$SCRIPT_DIR/lib/product_common.sh"

ROOT="$(product_repo_root)"
POLICY="$ROOT/ops/VERIFICATION_EXECUTION_POLICY.json"
WORKFLOW_REL="$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(p.evidence_policy.ci_proof_workflow_path);' "$POLICY")"
WORKFLOW_NAME="$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(p.ci_graph.workflow_contract.name);' "$POLICY")"
[[ "$WORKFLOW_REL" =~ ^[A-Za-z0-9._/-]+\.ya?ml$ && "$WORKFLOW_REL" != /* && "$WORKFLOW_REL" != *..* ]] || {
  printf 'invalid configured CI workflow path\n' >&2
  exit 1
}
[[ "$WORKFLOW_NAME" =~ ^[A-Za-z0-9._[:space:]-]+$ ]] || { printf 'invalid configured CI workflow name\n' >&2; exit 1; }
WORKFLOW="$ROOT/$WORKFLOW_REL"
MANIFEST="$ROOT/ops/CI_MANIFEST.tsv"
failed=0

require_pattern() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  if ! grep -Eq "$pattern" "$file"; then
    printf 'missing %s in %s\n' "$label" "$(product_rel "$ROOT" "$file")" >&2
    failed=1
  fi
}

reject_pattern() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  if grep -Eiq "$pattern" "$file"; then
    printf 'forbidden %s in %s\n' "$label" "$(product_rel "$ROOT" "$file")" >&2
    failed=1
  fi
}

product_require_nonempty_file "$ROOT" "$WORKFLOW_REL" || failed=1
product_require_nonempty_file "$ROOT" ops/CI_MANIFEST.tsv || failed=1

if [[ -s "$WORKFLOW" ]]; then
  actual_workflow_name="$(sed -n 's/^name: //p' "$WORKFLOW" | head -n 1)"
  [[ "$actual_workflow_name" == "$WORKFLOW_NAME" ]] || { printf 'workflow name does not match verification policy\n' >&2; failed=1; }
  require_pattern "$WORKFLOW" '^on:$' 'workflow triggers'
  require_pattern "$WORKFLOW" 'pull_request:' 'pull request trigger'
  require_pattern "$WORKFLOW" 'workflow_dispatch:' 'manual trigger'
  require_pattern "$WORKFLOW" 'permissions:' 'permissions block'
  require_pattern "$WORKFLOW" 'contents: read' 'read-only contents permission'
  require_pattern "$WORKFLOW" 'actions/checkout@v5' 'checkout action'
  require_pattern "$WORKFLOW" 'actions/setup-node@v5' 'Node setup action'
  require_pattern "$WORKFLOW" 'actions/cache@v5' 'Playwright binary cache action'
  require_pattern "$WORKFLOW" 'actions/upload-artifact@v7' 'artifact upload action'
  require_pattern "$WORKFLOW" 'actions/download-artifact@v8' 'artifact download action'
  require_pattern "$WORKFLOW" 'node-version:' 'Node version configuration'
  require_pattern "$WORKFLOW" 'run: npm ci' 'locked dependency install'
  require_pattern "$WORKFLOW" 'run: npm test' 'no-browser tests'
  require_pattern "$WORKFLOW" 'run: npm run test:pack' 'package dry-run tests'
  require_pattern "$WORKFLOW" 'pack-install-smoke\.mjs produce' 'single package producer'
  require_pattern "$WORKFLOW" 'pack-install-smoke\.mjs consume' 'same-run package consumers'
  require_pattern "$WORKFLOW" 'playwright install-deps chromium' 'explicit Chromium dependencies'
  require_pattern "$WORKFLOW" 'run: npm run test:browser:run' 'build-free browser smoke tests'
  require_pattern "$WORKFLOW" '^  repository-contracts:' 'repository contracts job'
  require_pattern "$WORKFLOW" '^  package-producer:' 'package producer job'
  require_pattern "$WORKFLOW" '^  package-consumer:' 'package consumer job'
  require_pattern "$WORKFLOW" '^  final-gate:' 'proof-only final job'
  require_pattern "$WORKFLOW" 'cancel-in-progress: true' 'superseded-run cancellation'
  require_pattern "$WORKFLOW" 'fetch-depth: 0' 'full history checkout for range checks'
  require_pattern "$WORKFLOW" 'check_document_sync\.mjs.*--base.*--head' 'base and head document sync range check'
  require_pattern "$WORKFLOW" 'check_product_structure\.sh' 'repository structure contract check'
  require_pattern "$WORKFLOW" 'check_product_security\.sh' 'repository security contract check'
  require_pattern "$WORKFLOW" 'verification:check' 'verification execution policy check'
  require_pattern "$WORKFLOW" 'development-workflow:check' 'current development workflow check'
  reject_pattern "$WORKFLOW" 'npm publish|gh repo|curl |wget |secrets\.' 'release, network upload, or secret usage'
  node "$ROOT/tools/check_verification_ci.mjs" || failed=1
fi

if [[ -s "$MANIFEST" ]]; then
  product_check_tsv "$MANIFEST" || {
    printf 'invalid TSV: ops/CI_MANIFEST.tsv\n' >&2
    failed=1
  }
  require_pattern "$MANIFEST" 'github_actions_node' 'node CI manifest row'
  require_pattern "$MANIFEST" 'github_actions_browser' 'browser CI manifest row'
  require_pattern "$MANIFEST" 'github_actions_package_producer' 'package producer CI manifest row'
  require_pattern "$MANIFEST" 'github_actions_package_consumer' 'package consumer CI manifest row'
  require_pattern "$MANIFEST" 'github_actions_final_gate' 'final gate CI manifest row'
  require_pattern "$MANIFEST" 'github_actions_repository_contracts' 'repository contracts CI manifest row'
  require_pattern "$MANIFEST" 'development_workflow_contract' 'development workflow CI manifest row'
  require_pattern "$MANIFEST" 'verification_execution_contract' 'verification contract CI manifest row'
  require_pattern "$MANIFEST" 'product_ci_manifest' 'local CI validation row'
fi

[[ "$failed" -eq 0 ]] || {
  printf 'Product CI check failed.\n' >&2
  exit 1
}

printf 'Product CI check passed.\n'
