# VERIFICATION.md

## Verification Scope

Current verification checks repository structure, document synchronization, security defaults, review/MCP local boundaries, CI configuration, design-system placeholders, product operation mode, local MVP runtime behavior, review platform behavior, and browser smoke coverage.

## Product-Local Commands

```bash
npm test
npm run test:browser
npm run test:pack
npm run release:check
./tools/check_product_structure.sh
./tools/check_product_docs.sh
./tools/check_product_security.sh
./tools/check_product_ci.sh
./tools/check_product_design_system.sh
./tools/test_product_repository.sh
./tools/product-gate
```

`./tools/test_product_repository.sh` and `./tools/product-gate` run structure, docs, security, CI manifest, design-system, product mode, `npm test`, and `npm run test:pack` when `package.json` is present. `npm run test:browser` is intentionally separate because it launches local Chromium. `npm run release:check` is a no-publish convenience wrapper for no-browser and package dry-run checks.

## Lesson-Side Commands

From `/home/masahiro/projects/ai-driven-development-lesson`:

```bash
./tools/product-scaffold-check check --repo /home/masahiro/projects/agent-toolbox/browser-debug-cli --context free-development --product-type all --git-optional --ci-optional
./tools/product-repository-authority status --repo /home/masahiro/projects/agent-toolbox/browser-debug-cli --context free-development --product-type all --git-optional --ci-optional
./tools/check_workflow_pair_sync.sh --repo /home/masahiro/projects/agent-toolbox/browser-debug-cli
```

## Current Runtime Checks

The current implementation includes command parser tests, deterministic JSON error tests, `doctor` tests for environment, schema-versioning, and artifact-retention metadata, review parser tests, schema command tests, target manifest tests, action risk classification tests, MCP adapter allowlist tests, shell-safe action input tests, headed/devtools launch-mode tests, session/report/spec tests, daemon parser tests, redaction tests, architecture regressions for generic runtime boundaries, shared evidence helpers, local daemon boundaries, review/MCP security boundaries, local package dry-run verification, and Playwright smoke tests for local file observation, screenshot/trace artifacts, click actions, form controls, keyboard input, deterministic scroll, wait actions, reports, spec export, process-scoped supervision, daemon start/status/stop, deterministic review findings, mock metrics, target manifest review, route discovery, viewport execution, and coverage artifacts. Manual local checks can use:

```bash
node ./bin/browser-debug.js observe --url http://127.0.0.1:3000/ --screenshot --trace --timeout 15000 --json
node ./bin/browser-debug.js supervise --url http://127.0.0.1:3000/ --actions '[{"type":"observe"}]' --timeout 15000 --json
node ./bin/browser-debug.js daemon start --url http://127.0.0.1:3000/ --timeout 15000 --json
node ./bin/browser-debug.js daemon status --daemon <id> --json
node ./bin/browser-debug.js daemon stop --daemon <id> --json
node ./bin/browser-debug.js review --url http://127.0.0.1:3000/ --viewport mobile --screenshot --report --timeout 15000 --json
node ./bin/browser-debug.js schema list --json
node ./bin/browser-debug.js schema get --name review --json
node ./bin/browser-debug.js mcp serve --json
```

For this session, `http://127.0.0.1:5173/` was observed successfully with screenshot and trace artifacts, and `http://127.0.0.1:5174/` was not listening.

## Planned Review Platform Checks

Phase 7 review-platform implementation includes focused checks before any release claim:

- Parser tests for `review --url`, `review --target`, `schema list`, `schema get`, and MCP adapter entrypoints.
- Schema tests for envelopes, artifacts, findings, target manifests, review results, and MCP tool metadata.
- No-browser unit tests for target manifest validation, viewport matrix expansion, action risk classification, redaction, shell-safe action input, and MCP tool output shape.
- Architecture tests that prevent Control Center-specific runtime literals, persistent browser profile reuse, storage-state persistence, HTTP/socket listeners, arbitrary shell execution, unapproved upload paths, and destructive cleanup commands.
- Browser smoke fixture tests for console errors, empty renders, horizontal overflow, clipped text, missing accessible names, nonblank screenshots, route coverage, viewport coverage, and local artifact placement.
- Mock comparison tests for local metrics and dimension mismatch `inconclusive` behavior.
- MCP adapter tests for stdio/local-only behavior, tool allowlist, schema-compatible responses, no shell tool, no cleanup tool, and no external upload by default.

Optional acceptance checks against the Dashboard Control Center and FrameCue Control Center may run only when those local servers are listening. Those checks should use target manifests or fixtures and should not introduce product-specific branches into the runtime.

## Release Readiness Checks

`CHANGELOG.md`, `.github/workflows/ci.yml`, `ops/CI_MANIFEST.tsv`, and `docs/workflow/RELEASE.md` are release-readiness files. They do not authorize publish actions. npm credentials, license changes, and `npm publish` remain approval-bound.

## Phase 2a Design Checks

- Product documents describe the same CLI binary, package baseline, JSON contract, artifact root, and safety defaults.
- `TASK_TRACKER.md` and `HANDOFF.md` agree on the current phase and next approval boundary.
- No npm publication path is added in the local MVP phase.
- Playwright visual checks are required after browser-runtime behavior changes when a suitable local target is available.

## Phase 7 Design Checks

- Product documents describe the same review-platform direction, target manifest model, CLI/MCP adapter boundary, and security defaults.
- Review findings keep deterministic, heuristic, model-advisory, and owner-required outcomes separate.
- MCP remains an adapter over the CLI/core contract, not a separate runtime owner.
- Model/API review remains opt-in and is not part of deterministic local gates.
- Target-specific Control Center details remain in manifests, fixtures, or acceptance evidence, not generic runtime code.
