#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools/lib/product_common.sh
source "$SCRIPT_DIR/lib/product_common.sh"

ROOT="$(product_repo_root)"
failed=0
workflow_path="$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(p.evidence_policy.ci_proof_workflow_path);' "$ROOT/ops/VERIFICATION_EXECUTION_POLICY.json")"
[[ "$workflow_path" =~ ^[A-Za-z0-9._/-]+\.ya?ml$ && "$workflow_path" != /* && "/$workflow_path/" != *"/../"* ]] || {
  printf 'Configured workflow path is unsafe: %s\n' "$workflow_path" >&2
  exit 1
}

require_nonempty() {
  product_require_nonempty_file "$ROOT" "$1" || failed=1
}

require_file() {
  product_require_file "$ROOT" "$1" || failed=1
}

require_dir() {
  product_require_dir "$ROOT" "$1" || failed=1
}

for rel in \
  AGENTS.MD \
  CHANGELOG.md \
  .codex-plugin/plugin.json \
  .githooks/pre-push \
  .mcp.json \
  package.json \
  package-lock.json \
  bin/trace-cue.js \
  bin/trace-cue-control-center.js \
  bin/trace-cue-mcp.js \
  bin/browser-debug.js \
  bin/browser-debug-mcp.js \
  ops/CONTROL_CENTER_AI_SETUP_CATALOG.json \
  schemas/artifact.schema.json \
  schemas/agentic-human-review-advisory.schema.json \
  schemas/agentic-human-review-package.schema.json \
  schemas/agentic-human-review-plan.schema.json \
  schemas/agentic-human-review-proposal.schema.json \
  schemas/agentic-human-review-provider-readiness.schema.json \
  schemas/agentic-human-review-receipt.schema.json \
  schemas/agentic-human-review-report-quality.schema.json \
  schemas/agentic-human-review-source-text-quality.schema.json \
	  schemas/development-workflow-policy.schema.json \
	  schemas/document-sync-policy.schema.json \
	  schemas/verification-execution-policy.schema.json \
	  schemas/capture-handoff.schema.json \
	  schemas/capture-plan.schema.json \
	  schemas/envelope.schema.json \
	  schemas/finding.schema.json \
  schemas/human-review-rubric.schema.json \
	  schemas/identity-audit.schema.json \
	  schemas/language-settings.schema.json \
  schemas/mcp-execution-gates.schema.json \
  schemas/operation-registry.schema.json \
  schemas/operation-roadmap.schema.json \
  schemas/operation-contracts.schema.json \
  schemas/operation-policy.schema.json \
  schemas/operation-admin-readiness.schema.json \
  schemas/operation-provider-readiness.schema.json \
  schemas/playwright-test-external-ci.schema.json \
  schemas/playwright-test-integration.schema.json \
  schemas/playwright-test-local-run-plan.schema.json \
  schemas/playwright-test-result.schema.json \
  schemas/e2e-result-review-material.schema.json \
  schemas/control-center-intake.schema.json \
  schemas/control-center-ai-setup.schema.json \
  schemas/verification-release-evidence-batch.schema.json \
  schemas/mcp-tool.schema.json \
  schemas/review.schema.json \
  schemas/target-manifest.schema.json \
  schemas/visual-review-result-preparation.schema.json \
  schemas/visual-review-dashboard.schema.json \
  schemas/visual-review-execution.schema.json \
  schemas/visual-review-result.schema.json \
  src/api.js \
  src/safe-local-store.js \
  src/control-center-agentic-review-config.js \
  src/control-center-ai-readiness.js \
  src/control-center-ai-setup-catalog.js \
  src/control-center-ai-setup-runtime.js \
  src/control-center-codex-login.js \
  src/control-center-pairing.js \
  src/control-center-intake.js \
  src/control-center-launcher.js \
  src/control-center-server.js \
  src/agentic-human-review.js \
  src/agentic-human-review-providers.js \
  src/capture-handoff.js \
	  src/capture-plan.js \
	  src/identity-audit.js \
	  src/input.js \
  src/language-settings.js \
  src/locale-policy.js \
  src/cli.js \
  src/daemon.js \
  src/daemon-worker.js \
  src/mcp.js \
  src/mcp-execution-gates.js \
  src/mcp-profiles.js \
  src/operation-registry.js \
  src/operation-roadmap.js \
  src/operation-contracts.js \
  src/operation-policy.js \
  src/operation-admin-readiness.js \
  src/operation-provider-readiness.js \
  src/playwright-test-artifacts.js \
  src/playwright-test-external-ci.js \
  src/playwright-test-import.js \
  src/playwright-test-integration.js \
  src/playwright-test-local-run.js \
  src/playwright-test-regression.js \
  src/e2e-result-review-material.js \
  src/playwright-test-runners.js \
  src/page-evidence.js \
  src/product-identity.js \
  src/observe.js \
  src/review.js \
  src/visual-review-result-preparation.js \
  src/visual-review-execution.js \
  src/visual-review-dashboard.js \
  src/schema-registry.js \
  src/sessions.js \
  src/supervisor.js \
  src/target.js \
  templates/review-target-manifest.json \
  tests/architecture.test.js \
  tests/cli.test.js \
	  tests/agentic-human-review.test.js \
	  tests/development-workflow.test.js \
  tests/document-sync.test.js \
	  tests/package-artifact.test.js \
	  tests/ci-proof-import.test.js \
	  tests/control-center-goal-completion.test.js \
	  tests/fixtures/safe-store-lock-worker.mjs \
	  tests/verification-ci.test.js \
	  tests/verification-evidence.test.js \
	  tests/verification-orchestration.test.js \
  tests/playwright-test.test.js \
  tests/browser-smoke.test.js \
  tests/pack-install-smoke.test.js \
  docs/product/REQUIREMENTS.md \
  docs/product/SPECIFICATION.md \
  docs/product/IMPLEMENTATION_PLAN.md \
  docs/design-system/DESIGN_SYSTEM.md \
  docs/design-system/tokens.json \
  docs/design-system/components.json \
  docs/workflow/TASK_TRACKER.md \
  docs/workflow/HANDOFF.md \
  docs/workflow/DOCUMENT_SYNC.md \
  docs/workflow/RELEASE.md \
  docs/workflow/SECURITY.md \
  docs/workflow/VERIFICATION.md \
  docs/memory/README.md \
  ops/STAGE_MANIFEST.tsv \
  ops/TEST_PLAN_MANIFEST.tsv \
  ops/CI_MANIFEST.tsv \
  ops/DEVELOPMENT_WORKFLOW_POLICY.json \
  ops/DOCUMENT_SYNC_POLICY.json \
	  ops/VERIFICATION_EXECUTION_POLICY.json \
  ops/DASHBOARD_SETTINGS.json \
  ops/DESIGN_SYSTEM_MANIFEST.tsv \
  ops/DASHBOARD_MANIFEST.tsv \
  ops/PRODUCT_MANIFEST.tsv \
  ops/PRODUCT_OPERATION_MODE.tsv \
  ops/PRODUCT_PROFILE.json \
  ops/OPERATION_POLICY.json \
  ops/REPOSITORY_INDEX.json \
  ops/SECURITY_MANIFEST.tsv \
  ops/EVIDENCE_DETAIL_MANIFEST.tsv \
  skills/product-development-workflow/SKILL.md \
  skills/trace-cue-review/SKILL.md \
  skills/browser-debug-review/SKILL.md \
  skills/product-doc-sync/SKILL.md \
  skills/product-security/SKILL.md \
  skills/product-test/SKILL.md \
  skills/product-design-system/SKILL.md \
  tools/product-gate \
  tools/product-mode \
  tools/product-gate-evidence \
	  tools/pack-dry-run.mjs \
	  tools/pack-install-smoke.mjs \
	  tools/check_rename_readiness.mjs \
  tools/check_product_structure.sh \
  tools/check_product_docs.sh \
  tools/check_product_security.sh \
  tools/check_product_ci.sh \
  tools/check_product_design_system.sh \
  tools/check_development_workflow.mjs \
  tools/check_document_sync.mjs \
	  tools/check_git_sync.mjs \
	  tools/check_verification_ci.mjs \
	  tools/check_ci_status.sh \
  tools/install-git-hooks \
  tools/test_product_repository.sh \
	  tools/verification.mjs \
	  tools/lib/development-workflow.mjs \
	  tools/lib/document-sync.mjs \
	  tools/lib/ci-proof-import.mjs \
	  tools/lib/github-repository-identity.mjs \
	  tools/lib/package-artifact.mjs \
	  tools/lib/product-gate-evidence.mjs \
	  tools/lib/safe-zip.mjs \
	  tools/lib/verification-ci.mjs \
	  tools/lib/verification-orchestration.mjs \
  tools/lib/product_common.sh \
  tools/lib/product_gate_evidence.sh; do
  require_nonempty "$rel"
done

require_nonempty "$workflow_path"

for rel in .codex-plugin .githooks .github .github/workflows bin schemas src templates tests docs/product docs/workflow docs/design-system docs/memory ops skills tools; do
  require_dir "$rel"
done

for rel in REQUIREMENTS.md SPECIFICATION.md IMPLEMENTATION_PLAN.md TASK_TRACKER.md HANDOFF.md AGENT.md; do
  if [[ -e "$ROOT/$rel" ]]; then
    printf 'root-level duplicate or legacy file is not allowed: %s\n' "$rel" >&2
    failed=1
  fi
done

for rel in \
  ops/STAGE_MANIFEST.tsv \
  ops/TEST_PLAN_MANIFEST.tsv \
  ops/CI_MANIFEST.tsv \
  ops/DESIGN_SYSTEM_MANIFEST.tsv \
  ops/DASHBOARD_MANIFEST.tsv \
  ops/PRODUCT_MANIFEST.tsv \
  ops/PRODUCT_OPERATION_MODE.tsv \
  ops/SECURITY_MANIFEST.tsv \
  ops/EVIDENCE_DETAIL_MANIFEST.tsv; do
  product_check_tsv "$ROOT/$rel" || {
    printf 'invalid TSV: %s\n' "$rel" >&2
    failed=1
  }
done

[[ "$failed" -eq 0 ]] || {
  printf 'Product structure check failed.\n' >&2
  exit 1
}

printf 'Product structure check passed.\n'
