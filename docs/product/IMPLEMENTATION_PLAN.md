# IMPLEMENTATION_PLAN.md

## Preconditions

- Work stays in `/home/masahiro/projects/agent-toolbox/browser-debug-cli`.
- The lesson repository remains the parent workflow source.
- Phase 0 is documentation and scaffold only.
- Runtime browser automation starts only after the scaffold and initial documents are verified.

## Phase Plan

### Phase 0: Scaffold and Document Sync

- Create the standard product repository structure.
- Add product-local `AGENTS.MD`, docs, ops manifests, skills, tools, `src/`, and `tests/`.
- Synchronize the initial five documents:
  - `docs/product/REQUIREMENTS.md`
  - `docs/product/SPECIFICATION.md`
  - `docs/product/IMPLEMENTATION_PLAN.md`
  - `docs/workflow/TASK_TRACKER.md`
  - `docs/workflow/HANDOFF.md`
- Run structure, document, security, design-system, and workflow-pair checks.

### Phase 1: Local Git

- Confirm the user wants to enter local Git mode.
- Run `git init`.
- Review `git status`.
- Create an initial commit once scaffold checks pass.
- Decide whether `.githooks/` should be added for product-local hooks.

### Phase 2a: Package and Runtime Design

- Record the local package baseline without installing dependencies.
- Use `browser-debug` as the working CLI binary name.
- Use Node.js 20 or newer and ESM modules.
- Define the command surface, JSON output contract, artifact layout, and security defaults.
- Keep the first implementation slice limited to `doctor`, command parsing, deterministic JSON errors, and focused tests.
- Keep the first Playwright slice limited to one-shot `observe --url <url> --json` with an ephemeral context.
- Keep long-running browser supervision opt-in and later than one-shot observation.
- Do not create a GitHub repository, install dependencies, launch browsers, add CI, or publish packages in this phase.

### Phase 2b: GitHub Public Repository

- Confirm public OSS repository name and owner. Completed with `xxxMasahiro/browser-debug-cli`.
- Use `gh auth status` and `gh repo create` only after approval. Completed after developer approval.
- Push the initial branch. Completed by fast-forwarding local `main` and pushing `origin/main`.
- Add remote-sync notes to the handoff. Completed.

### Phase 3: CI

- Add `.github/workflows/` and `ops/CI_MANIFEST.tsv`. Completed locally.
- Add product-local CI manifest validation without remote execution. Completed with `tools/check_product_ci.sh`.
- Run local checks before push. Completed locally.
- Confirm GitHub Actions status after a remote repository and push exist. Completed for `main` push CI.

### Phase 4: npm Package Design and Local CLI Scaffold

- Add `package.json`. Completed for the private local package.
- Use `browser-debug` as the local CLI binary name. Completed.
- Use ESM modules and Node.js 20 or newer. Completed.
- Keep the package private and `UNLICENSED` until public release naming and licensing are approved.
- Add package metadata, test commands, browser smoke commands, and distribution file declarations. Completed for the local MVP slice.
- Add local package dry-run verification without publishing. Completed with `npm run test:pack` and aggregate product-gate wiring.
- Add a local release-readiness command without publishing. Completed with `npm run release:check`.
- Preserve the Phase 2a design baseline unless the user approves a design change.

### Phase 5: MVP Runtime

- Implement `doctor`. Completed for local environment and safety checks.
- Implement command parsing and deterministic JSON error output. Completed for the planned command surface.
- Implement one-shot `observe`. Completed with Playwright-backed ephemeral Chromium contexts.
- Implement session start and simple actions. Completed for file-backed local session metadata and ephemeral action execution.
- Implement opt-in process-scoped browser supervision. Completed with `supervise --url <url> --actions <json-array>`.
- Implement opt-in local background browser daemon supervision. Completed with `daemon start`, `daemon status`, and `daemon stop` using an ephemeral local worker process.
- Implement artifact directory handling. Completed for sessions, observations, screenshots, traces, reports, and spec exports under `.browser-debug/`.
- Add focused tests for command parsing, observation output, action coverage, and safety boundaries. Completed with `npm test` and `npm run test:browser`.
- Add headed/devtools launch-mode regression coverage. Completed with deterministic no-GUI tests in `npm test`.
- Define JSON schema versioning details and the default artifact retention policy. Completed with `doctor` metadata, product docs, and deterministic tests.
- Keep authentication automation, external daemon control channels, profile reuse, credential handling, and external upload for later approved phases.

### Phase 6: Release

- Add release notes and changelog. Completed locally with `CHANGELOG.md`.
- Add release readiness checklist and publication blockers. Completed locally with `docs/workflow/RELEASE.md`.
- Confirm npm account and publishing method.
- Publish only after CI and release checklist pass.

### Phase 7: Review Platform and CLI/MCP Adapter

Phase 7 extends the local MVP into a reusable review platform. It preserves the existing local-first Playwright runtime, schema compatibility rules, artifact boundaries, and security invariants. It does not reimplement Playwright, clone the full Playwright MCP surface, or add product-specific branches for individual Control Centers.

Current status: completed for local deterministic review, target manifests, route/viewport coverage, risk classification, conservative mock metrics, local stdio MCP adapter, schema registry, package API exports, and package file-set readiness. Model or vision review remains a later explicit opt-in layer and was not implemented.

#### Phase 7a: Specification and Schema Planning

- Completed: synchronized requirements, specification, implementation plan, security, verification, task tracker, and handoff before runtime work began.
- Completed: defined review JSON contracts for target manifests, review runs, findings, route coverage, viewport coverage, action coverage, layout evidence, mock metrics, and reports.
- Completed: added machine-readable schema files for the existing envelope family and the new review contracts.
- Completed: added `schema list` and `schema get`.
- Completed: recorded compatibility rules: additive fields are allowed within the current schema version, while removals, renames, type changes, status vocabulary changes, artifact path semantic changes, and action vocabulary changes require a schema version bump.
- Completed: kept human text output non-contractual; JSON envelopes, error codes, artifact descriptors, findings, action types, and exit codes are contractual.

#### Phase 7b: Review MVP for One URL

- Completed: added `browser-debug review --url <url> --viewport <name-or-size> --screenshot --json`.
- Completed: reused existing Playwright observation, artifact, redaction, and envelope helpers.
- Completed: captured layout evidence for deterministic findings: visible element rectangles, overflow metrics, accessible names, basic computed styles, focusability, console errors, failed requests, final URL, response status, screenshot descriptors, and environment metadata.
- Completed: produced `data.review`, `data.findings`, `data.metrics`, and `data.environment` in the standard JSON envelope.
- Completed: emitted local artifacts under ignored `.browser-debug/` paths, including `reviews/`, `layouts/`, screenshots, mock metrics, coverage, and Markdown reports when requested.
- Completed: implemented deterministic finding categories first: `browser_health`, `layout_integrity`, `interaction_quality`, `accessibility_basics`, `mock_fidelity`, and `evidence_quality`.
- Completed: kept trace capture outside review MVP because trace zip files can contain raw page content.

#### Phase 7c: Target Manifest and Site Review

- Completed: added `browser-debug review --target <manifest> --json`.
- Completed: defined a generic target manifest with `baseUrl`, `scope`, `seeds`, `expectedRoutes`, `viewportMatrix`, `actionPolicy`, `budgets`, `artifacts`, `masks`, `regions`, and optional `appHints`.
- Completed: kept Control Center examples out of runtime-specific branches.
- Completed: implemented route and review run IDs for deduplication while avoiding dependency on one framework or one route style.
- Completed: added support for shell-safe structured input such as `--input -`, `--target @file`, `--actions @file`, and `--action @file`.

#### Phase 7d: Route Discovery, Viewport Matrix, and Coverage

- Completed: discovered routes from same-origin anchors and navigation action candidates.
- Completed: normalized route records with URL, pathname, search, hash, and route source.
- Completed: ran each route through named viewport profiles such as desktop, laptop, and mobile.
- Completed: recorded discovered, visited, skipped, failed, and expected-missing routes.
- Completed: recorded viewport coverage through coverage artifacts and review metadata.
- Completed: deduplicated route coverage and capped findings to keep output bounded.

#### Phase 7e: Risk-Gated Action Exploration

- Completed: extended action candidates with stable IDs, role/name metadata, selector, risk class, confidence, and preconditions.
- Completed: classified actions as `navigation`, `state_revealing`, `input_required`, `mutating`, `destructive`, or `external`.
- Completed: executed route discovery through navigation candidates only; mutating, destructive, and external actions are not executed by default.
- Completed: kept arbitrary shell execution out of scope.

#### Phase 7f: Mock Comparison

- Completed: added optional `--mock` and conservative local mock metrics. `--mask` and `--region` are parsed for forward compatibility and remain reserved for later image-processing enhancements.
- Completed: normalized viewport before capture and recorded local PNG dimensions, hashes, and byte-difference metrics without adding image-processing dependencies.
- Completed: emitted local mock metrics under ignored `.browser-debug/diffs/`.
- Completed: treated dimension mismatches and missing baselines as `inconclusive`.
- Completed: avoided absolute "matches design" claims; the implementation reports threshold-based local metrics only.

#### Phase 7g: Local MCP Adapter

- Completed: added a thin MCP stdio adapter with `browser-debug-mcp` and `browser-debug mcp serve` metadata.
- Completed: reused the same CLI/core contracts used by local commands.
- Completed: exposed a narrow allowlist of tools for doctor, observe, review, and schema operations.
- Completed: kept the adapter local and stdio-only.
- Completed: did not add HTTP listeners, socket listeners, remote control channels, arbitrary shell tools, cleanup tools, existing profile reuse, storage-state persistence, OAuth, external upload, or credential handling.
- Completed: added adapter tests that verify tool allowlists and schema-compatible output.

#### Phase 7h: Model or Vision Review Layer

- Completed as boundary: model or vision review remains a later optional layer, not a dependency for deterministic review checks.
- Completed as boundary: no screenshots, traces, raw DOM, source text, console logs, network data, or reports are sent outside the local process.
- Completed as boundary: model output remains unimplemented and out of deterministic pass/fail gates.
- Completed as boundary: untrusted-data handling remains documented in security and review output semantics.

#### Phase 7i: Public API and Packaging Readiness

- Completed: added public `exports` for stable local core APIs while the package remains private and unreleased.
- Completed: excluded internal product documents from the package file set while keeping public README, changelog, schemas, runtime source, and selected workflow security/release/verification docs.
- Completed: kept local dry-run package verification through `npm run test:pack`; packed install smoke remains a release-hardening task before npm publication.
- Completed as boundary: package naming, license choice, npm token handling, and publication remain approval-bound.

## Verification Method

- `./tools/product-gate`
- `./tools/check_product_ci.sh`
- `npm test`
- `npm run test:browser`
- `npm run test:pack`
- `npm run release:check`
- lesson-side `product-scaffold-check` with this repository path.
- lesson-side `product-repository-authority status` with this repository path.
- `check_workflow_pair_sync.sh --repo <this-repo>`.
- Current local runtime checks include command parser tests, JSON error tests, `doctor` schema/retention metadata tests, headed/devtools launch-mode tests, session/report/spec tests, daemon parser tests, redaction tests, architecture regressions for generic runtime boundaries, shared page evidence helpers, and local daemon boundaries, Playwright browser smoke tests with screenshots, traces, click/form/keyboard/scroll/wait actions, supervised ordered actions, daemon start/status/stop, local package dry-run verification, Control Center observation, and aggregate product-gate execution.
- Later release work should add real headed visual checks where a display is available, choose public package naming and license, and publish to npm after approval.
- Phase 7 review-platform checks should add no-browser tests for parser contracts, target manifest validation, route normalization, viewport matrix expansion, action risk classification, finding generation, issue deduplication, schema compatibility, and report shape.
- Phase 7 browser smoke checks should add fixture-based review runs for console errors, failed requests, empty render, horizontal overflow, clipped text, missing labels, screenshots, route coverage, viewport coverage, and artifact placement under ignored `.browser-debug/`.
- Phase 7 mock-comparison checks should prove exact fixture matches are within thresholds, shifted UI produces diff artifacts and metrics, masks suppress volatile regions, dimension mismatches are `inconclusive`, and stable fixtures produce stable findings across repeated runs.
- Phase 7 MCP adapter checks should prove stdio/local-only behavior, tool allowlists, no shell tools, no cleanup tools, no HTTP/socket listener, schema-compatible responses, and no external upload by default.
- Security checks should be extended to guard against `launchPersistentContext`, `userDataDir`, storage-state persistence, external listener creation, arbitrary shell execution, unapproved upload paths, and destructive cleanup commands.

## Recovery Path

- If scaffold checks fail, fix missing canonical files or manifest format first.
- If document sync fails, update `TASK_TRACKER.md` and `HANDOFF.md` together.
- If security checks fail, remove committed secret-like data and update `SECURITY.md`.
- If Git/GitHub/npm steps are requested too early, stop and return to the phase plan.
- If review findings become noisy or subjective, split deterministic findings from heuristic or model-advisory findings and require confidence labels.
- If route discovery over-crawls, reduce scope through target manifest budgets and same-origin route policy.
- If mock comparison is unstable, mark the result `inconclusive` and record environment and capture stability metadata.
- If MCP adapter work starts to diverge from the CLI core, stop and refactor through shared core modules before adding adapter-specific behavior.

## Approval Boundaries

- Ask before new runtime phases that add authentication, external daemon control channels, external upload, profile reuse, or credential handling.
- Ask before new dependency installation or network use.
- Ask before commit, push, branch deletion, or remote changes.
- Ask before `gh repo create`, remote setup, push, or any public GitHub action.
- Ask before npm publish.
- Ask before external uploads, OAuth, webhooks, credential storage, or destructive cleanup.
- Ask before model/API review integration or any evidence leaves the local process.
- Ask before HTTP/socket MCP server mode, remote control channels, persistent session storage, existing-browser-profile reuse, or authentication automation.
- Ask before public API stabilization, npm package file-set changes intended for publication, package naming, license changes, or packed release promotion.
