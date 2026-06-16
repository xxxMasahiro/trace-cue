# VERIFICATION.md

## Verification Scope

Phase 0 verification checks repository structure, document synchronization, security defaults, and design-system placeholders. It does not launch a browser.

## Product-Local Commands

```bash
./tools/check_product_structure.sh
./tools/check_product_docs.sh
./tools/check_product_security.sh
./tools/check_product_design_system.sh
./tools/test_product_repository.sh
./tools/product-gate
```

## Lesson-Side Commands

From `/home/masahiro/projects/ai-driven-development-lesson`:

```bash
./tools/product-scaffold-check check --repo /home/masahiro/projects/agent-toolbox/browser-debug-cli --context free-development --product-type all --git-optional --ci-optional
./tools/product-repository-authority status --repo /home/masahiro/projects/agent-toolbox/browser-debug-cli --context free-development --product-type all --git-optional --ci-optional
./tools/check_workflow_pair_sync.sh --repo /home/masahiro/projects/agent-toolbox/browser-debug-cli
```

## Later Runtime Checks

After implementation starts, add command tests, Playwright smoke tests, artifact redaction tests, headed-mode checks, and CI coverage.
