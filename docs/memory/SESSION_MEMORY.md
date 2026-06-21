# SESSION_MEMORY.md

## Verbatim English Handoff Text

```text
Continue from the current TraceCue checkout root.
Read AGENTS.MD and docs/workflow/HANDOFF.md, confirm the current state, then resume.
```

## Session State

- Future development in this repository should be conducted in English.
- Phase 1 is complete.
- Local Git is initialized on `main`.
- Initial scaffold commit: `87e39f5 Initial browser debug CLI scaffold`.
- Product-gate evidence is recorded under `.git/product-gate-evidence/`.
- Phase 2a package/runtime design has started; the next approval-bound step is runtime/package implementation or, separately, public GitHub repository creation.

## 2026-06-17 Phase 2a Package/Runtime Design

- Began package/runtime design under `skills/product-development-workflow/SKILL.md`.
- At that point, no runtime implementation, dependency installation, GitHub repository creation, CI, npm work, push, or browser launch had been performed.
- Working CLI binary is `browser-debug`.
- Runtime baseline is Node.js 20 or newer with ESM modules.
- First implementation slice is `doctor`, command parsing, deterministic JSON errors, and focused tests.
- First Playwright slice is one-shot `observe --url <url> --json` with an ephemeral context and ignored `.browser-debug/` artifacts.
- Phase 2a design verification passed with `./tools/product-gate`.
- Implemented the first no-browser runtime/package slice: private local package metadata, `browser-debug` bin, ESM CLI modules, `doctor`, parser, deterministic JSON errors, planned-command stubs, and `tests/cli.test.js`. This was superseded by the later Playwright-backed local MVP.
- At that point, `observe --url <url> --json` validated the URL and returned an explicit unimplemented error without launching a browser. This was superseded by the later Playwright-backed local MVP.
- `npm test` is wired into `./tools/product-gate` through `./tools/test_product_repository.sh`.
- Verification passed with `npm test`, `./tools/product-gate`, `git diff --check`, `doctor --json`, and the no-browser `observe` stub.
- That approval boundary was later crossed for local Playwright implementation, then for public GitHub repository creation, remote setup, push, and remote `main` CI after developer approval.

## 2026-06-17 Local MVP Runtime

- Installed `playwright` as a runtime dependency.
- Implemented Playwright-backed `observe --url <url> --json` with ephemeral Chromium contexts, structured page observation, local observation artifacts, optional screenshots, console summaries, failed-request summaries, and basic redaction.
- Implemented `observe --trace` with local Playwright trace zip artifacts and trace-content warnings.
- Implemented local `.browser-debug/` artifact handling for sessions, observations, screenshots, reports, and specs.
- Implemented `session start`, `session close`, simple `act`, `report`, and `spec export` using file-backed local session metadata.
- Implemented `supervise --url <url> --actions <json-array>` for process-scoped ephemeral browser supervision.
- Implemented `daemon start`, `daemon status`, and `daemon stop` for local background ephemeral browser supervision.
- Added `npm run test:browser` for real Playwright smoke coverage.
- Strengthened browser smoke coverage for form controls, keyboard input, deterministic scroll, wait actions, screenshots, reports, and spec export.
- Added deterministic headed/devtools launch-mode regression coverage without requiring a GUI display.
- Added `npm run test:pack` local package dry-run verification. The current script uses a `/tmp` npm cache so sandboxed product checks do not need to write cache data under the product repository.
- Added `CHANGELOG.md` and `docs/workflow/RELEASE.md` for local release readiness without publishing.
- Added browser smoke coverage for supervised ordered actions in one ephemeral context.
- Added architecture regression coverage for generic runtime boundaries, shared evidence helpers, and local Node CLI packaging.
- Added architecture and browser smoke coverage for local daemon boundaries and start/status/stop.
- Added local GitHub Actions CI configuration, `ops/CI_MANIFEST.tsv`, `tools/check_product_ci.sh`, and `npm run release:check` without remote execution or publishing.
- Verification passed with `npm test`, `npm run test:browser`, `node ./bin/browser-debug.js doctor --json`, Dashboard Control Center observation at `http://127.0.0.1:5173/`, screenshot review, and trace artifact existence checks.
- `http://127.0.0.1:5174/` was not listening during verification.
- Final checks also passed with `./tools/product-gate`, `git diff --check`, lesson-side product scaffold check, lesson-side product repository authority status, and lesson-side workflow-pair sync check.
- Completed after developer approval: public GitHub repository creation at `https://github.com/xxxMasahiro/browser-debug-cli`, remote `origin` setup, local `main` fast-forward, `origin/main` push, and GitHub Actions `main` CI verification.
- Updated GitHub Actions checkout and Node setup actions to v5 after the first remote run reported Node 20 action-runtime deprecation annotations.
- Next approval-bound work: public package naming, license changes, npm publication, existing-browser-profile reuse, OAuth/login automation, external daemon control channels, external upload, or credential storage.

## 2026-06-17 Phase 11 Review Handoff

- Phase 7 through Phase 10 review-platform work was completed before this state: deterministic review, target manifests, route and viewport coverage, risk-gated actions, conservative mock metrics, local stdio MCP adapter, plugin metadata, quality signals, expected route execution, and route-budget skip coverage.
- Phase 11 is complete for optional manifest `pages`, page-specific viewports, deterministic expected text and selector checks, page-level mock metrics, local `review_artifact_index` artifacts, `coverage.pages`, and `quality_signals.page_expectations`.
- The implementation remains generic and local-first. No Control Center-specific runtime branches, external upload, model/API review, OAuth/login automation, existing-profile reuse, HTTP/socket MCP transport, npm publication, license change, or marketplace mutation was added.
- Current local verification includes `npm test`, `npm run test:browser`, product-local checks, release readiness checks, and parent workflow authority checks.

## 2026-06-18 Phase 12 Rendered-State Dogfood Handoff

- Phase 12 is complete for generic rendered-state dogfood hardening.
- Layout evidence records image load state, visible loading indicators, and empty table/list/grid containers.
- Review findings flag broken visible images, lingering loading indicators after the review wait, and empty data containers without visible empty-state messaging.
- Single-URL and target quality signals include rendered-state summaries.
- Markdown reports include a Developer Triage section and rendered-state quality signal status.
- Target review output includes manifest suggestions for missing page expectations, unpinned expected routes, exhausted route budgets, failed page checks, and rendered-state gaps.
- Browser smoke coverage verifies rendered-state findings, evidence summaries, developer triage reports, and manifest suggestions.
- The implementation remains generic and local-first. No Control Center-specific runtime branches, external upload, model/API review, OAuth/login automation, existing-profile reuse, HTTP/socket MCP transport, npm publication, license change, or marketplace mutation was added.

## 2026-06-18 Phase 14 Content UX Advisory Handoff

- Phase 14 is complete for manifest opt-in local content UX advisory.
- Target manifests support bounded inline `sourceData`, `localContentUxAdvisory`, and page `expectations.dataBindings`.
- Target review emits `local_content_ux_advisory` and `quality_signals.content_ux` only when `localContentUxAdvisory.enabled=true`.
- The advisory checks source-to-screen text bindings without creating findings, changing `metrics.finding_count`, changing `action_plan`, or changing `quality_signals.release_readiness`.
- The advisory module is pure local code without Playwright, filesystem reads, artifact reads, external transfer, or target-specific runtime branches.
- Schema registry/file parity, source-value non-disclosure, report output, and browser-smoke invariance are covered by tests.
- The implementation remains generic and local-first. No arbitrary source-data file or URL loader, Control Center-specific runtime branch, external upload, model/API review, OAuth/login automation, existing-profile reuse, HTTP/socket MCP transport, npm publication, license change, or marketplace mutation was added.

## 2026-06-18 Phase 15 Content UX Heuristic Strengthening Handoff

- Phase 15 is complete for selector-scoped local content UX advisory.
- Target review evidence summaries include bounded element evidence with selectors, text, accessible names, allowed attributes, and rectangles.
- `pages[].expectations.dataBindings` now evaluates selector-scoped `text`, explicit `attribute`, `data-state`, and `data-risk` targets.
- `localContentUxAdvisory.requiredUserQuestions` and page `expectations.userQuestions` now provide advisory information-architecture and user-journey checks.
- `templates/status-dashboard-content-ux-target-manifest.json` provides a reusable disabled-by-default status-dashboard manifest example.
- The implementation remains generic, local-first, and advisory-only. It does not create review findings, change `metrics.finding_count`, change the existing `action_plan`, change `quality_signals.release_readiness`, read arbitrary source-data files or URLs, add Control Center-specific runtime branches, upload evidence, call models/APIs, automate OAuth/login, reuse existing profiles, add HTTP/socket MCP transport, publish packages, change license, or mutate marketplace state.

## 2026-06-18 Phase 16 Content UX Handoff Output Handoff

- Phase 16 is complete for dedicated content UX handoff outputs.
- Target review emits additive `content_ux_findings`, `content_ux_action_plan`, and `content_ux_readiness` only when `localContentUxAdvisory.enabled=true`.
- `content_ux_findings` stay separate from review `findings` and do not change `metrics.finding_count`.
- `content_ux_action_plan` stays separate from the existing `action_plan` and records `legacy_action_plan_unchanged=true`.
- `content_ux_readiness` stays separate from `quality_signals.release_readiness` and records `legacy_release_readiness_unchanged=true`, `blocking_release_gate=false`, and `external_evidence_transfer=false`.
- Markdown reports include a bounded Content UX Developer Handoff section without copying source values or full page text.
- The implementation remains generic, local-first, and advisory-only. It does not read arbitrary source-data files or URLs, add Control Center-specific runtime branches, upload evidence, call models/APIs, automate OAuth/login, reuse existing profiles, add HTTP/socket MCP transport, publish packages, change license, or mutate marketplace state.

## 2026-06-18 Phase 17 Content UX Practical Handoff

- Phase 17 is complete for practical local content UX handoff output.
- `content_ux_findings` now categorize local advisory signals into status clarity, action clarity, navigation clarity, information architecture, source alignment, content contracts, coverage contracts, and review scope.
- Target review emits additive `content_ux_page_handoff` with page status, owner-review need, finding count, top categories, and bounded top findings.
- Target review emits additive `content_ux_manifest_authoring` with manifest-only suggestions for audience, goal, source data, data bindings, user questions, next-action contracts, and navigation contracts.
- Target init and reusable templates expose the expanded content UX check vocabulary while keeping advisory opt-in disabled by default.
- Markdown reports include page-level content UX summaries and manifest-authoring suggestion counts.
- The implementation remains generic, local-first, advisory-only, and non-mutating. It does not read arbitrary source-data files or URLs, add Control Center-specific runtime branches, upload evidence, call models/APIs, automate OAuth/login, reuse existing profiles, add HTTP/socket MCP transport, publish packages, change license, or mutate marketplace state.

## 2026-06-18 Phase 18 Content UX Review Brief and Rubric Handoff

- Phase 18 is complete for local content UX review brief and rubric evaluation.
- Target manifests can declare page `role`, `localContentUxAdvisory.reviewBrief`, and `localContentUxAdvisory.rubric`.
- Target review emits additive `content_ux_review_brief` with audience, page-role, and decision-need summaries.
- Target review emits additive `content_ux_rubric_evaluation` with rubric criteria status, category counts, owner-review counts, and inconclusive counts.
- Markdown reports include a bounded Content UX Review Brief section.
- Packaged content UX templates and tests use domain-neutral status-dashboard vocabulary while keeping selector-scoped state/risk advisory coverage.
- The preferred default content UX categories are `status_clarity` and `action_clarity`; existing manifest rubric categories `workflow_state_clarity` and `next_action_clarity` remain accepted as legacy-compatible aliases.
- Lesson-specific Dashboard Control Center workflow, Git, CI, blocker, repository-selection, and next-safe-action semantics belong in lesson-owned target manifests or fixtures, not Browser Debug CLI runtime code.
- The implementation remains generic, local-first, advisory-only, and non-mutating. It does not change review findings, `metrics.finding_count`, the existing `action_plan`, or `quality_signals.release_readiness`; it does not read arbitrary source-data files or URLs, add Control Center-specific runtime branches, upload evidence, call models/APIs, automate OAuth/login, reuse existing profiles, add HTTP/socket MCP transport, publish packages, change license, or mutate marketplace state.

## 2026-06-18 Phase 19 Target Manifest Validation Handoff

- Phase 19 is complete for no-browser target manifest validation.
- `browser-debug target validate --target <manifest> --json` and `browser-debug target validate --input - --json` validate edited target manifests through the existing normalization contract.
- Validation output includes manifest counts, content UX authoring suggestions, review next commands, and explicit local-first boundaries.
- The local MCP adapter exposes `browser_debug_target_validate`, and the package API exports `runTargetValidate`.
- The implementation remains generic, local-first, no-browser, and non-mutating. It does not launch Chromium, mutate manifests, expose sourceData values, read arbitrary source-data files or URLs, upload evidence, reuse profiles, add HTTP/socket MCP transport, change review findings, change `metrics.finding_count`, change the existing `action_plan`, or change `quality_signals.release_readiness`.

## 2026-06-18 Phase 20 Resource Status Preflight Handoff

- Phase 20 is complete for no-browser local resource status preflight.
- `browser-debug resource status --json` reports process-visible memory, swap, cgroup, pressure, and Node.js process memory signals.
- Resource status output includes status classification, thresholds, warnings, recommendations, cache policy, and explicit local-first boundaries.
- The local MCP adapter exposes `browser_debug_resource_status`, and the package API exports resource status collection and parsing helpers.
- The implementation remains generic, local-first, no-browser, read-only, and non-mutating. It does not launch Chromium, write artifacts, mutate system cache, configure swap, delete files, execute shell commands, use privileged helpers, upload evidence, reuse profiles, add HTTP/socket MCP transport, control arbitrary processes, change review findings, change `metrics.finding_count`, change the existing `action_plan`, or change `quality_signals.release_readiness`.

## 2026-06-18 Phase 21-24 Resource Safety Handoff

- Phase 21-24 is complete for local resource safety integration.
- `browser-debug review --resource-guard advisory|fail-critical|off` emits additive `resource_guard` output, runs review preflight and target route/viewport rechecks, warns for screenshot/trace pressure, and can stop browser launch only in explicit `fail-critical` mode.
- Resource guard output does not change review findings, `metrics.finding_count`, existing `action_plan`, or `quality_signals.release_readiness`.
- `browser-debug daemon start --idle-timeout <duration>` and `browser-debug daemon start --max-lifetime <duration>` add optional local lifecycle guards with daemon metadata and worker shutdown.
- `browser-debug resource artifacts plan --json` and `browser-debug resource artifacts cleanup --dry-run --json` report artifact usage and cleanup candidates without deletion.
- `browser-debug resource artifacts cleanup --execute --json` deletes selected regular files only under the configured artifact root and writes a receipt under `.browser-debug/receipts/`.
- The local MCP adapter exposes `browser_debug_resource_artifacts_plan` only; cleanup execution is not exposed through MCP.
- The implementation remains generic, local-first, and bounded. It does not mutate system cache, configure swap, execute shell commands, use privileged helpers, upload evidence, reuse profiles, add HTTP/socket MCP transport, expose MCP cleanup execution, clean outside the configured artifact root, or control arbitrary processes.

## 2026-06-19 Phase 27 Agent Request Detail Handoff

- Phase 27 is complete for local agent request detail output.
- `browser-debug agent requests show --package <path> --json` returns one advisory handoff package detail with package metadata, disclosure policy, source review index metadata, local artifact-reference summaries, selected/latest result paths, bounded advisory result summary, dashboard handoff hints, and boundary flags.
- `browser-debug agent requests show --package <path> --agent-result <path> --json` selects a matching workspace-relative imported result and rejects mismatched result/package pairs.
- The implementation remains read-only, local-first, and advisory-only. It does not write artifacts, launch browsers, call provider APIs, upload evidence, store credentials, expose MCP agent execution, mutate review artifacts, or change deterministic review findings, metrics, existing action plans, or release readiness.

## 2026-06-19 Phase 31 MCP Profile Gating Handoff

- Phase 31 is complete for launch-selected MCP profiles.
- No-profile `browser-debug-mcp` and the packaged `.mcp.json` keep current compatibility by resolving to the `full` profile.
- `browser-debug-mcp --profile safe` exposes no-browser/no-delete/no-provider tools for doctor, schema, target validation, resource status, and artifact planning.
- `browser-debug-mcp --profile admin` is explicit but remains equivalent to `full` in this phase; it does not expose cleanup execution, agent/API execution, daemon/session control, shell tools, HTTP/socket transport, external upload, provider credentials, profile reuse, or arbitrary process control.
- The reusable profile registry lives in `src/mcp-profiles.js`, and package API exports include `DEFAULT_MCP_PROFILE`, `MCP_PROFILES`, `getMcpTools`, and `resolveMcpProfile`.
- MCP `@file` structured input is workspace-confined and rejects absolute paths, parent traversal, symlink escapes, non-regular files, and oversized files. Normal CLI `@file` behavior is unchanged outside MCP-restricted contexts.

## 2026-06-19 Phase 28 Agent Workflow Status Handoff

- Phase 28 is complete for local agent workflow status output.
- `browser-debug agent workflow create --package <path> --json` writes a local `.browser-debug/agent-workflows/<id>/workflow.json` manifest and workflow receipt for dashboard/local automation handoff.
- `browser-debug agent workflow status --workflow <path> --json` recomputes current workflow state from local package/result metadata and reports waiting, imported, or package-missing state without writing artifacts.
- `browser-debug agent workflow index --json` aggregates local workflow manifests and reports waiting/imported/package-missing/report-pending counts.
- `browser-debug agent workflow report --workflow <path> --json` writes a bounded local Markdown workflow status summary without mutating review artifacts.
- At the end of Phase 28, provider/API execution was still unimplemented and approval-bound; workflow output only recorded provider-boundary metadata and did not call providers, upload evidence, store credentials, expose MCP agent execution, launch browsers, mutate review artifacts, or change deterministic gates. Phase 29 later added the bounded execution adapter described below.

## 2026-06-19 Verbatim Resume Note

````text
はい、問題なく再開できます。

次回はこの情報だけで十分です。

```text
browser-debug-cli
branch: feature/agent-execution-doc-sync
commit: 1af1fcd Document agent execution integration plan
状態: clean
内容: Phase 29 Agent Execution Integration の文書同期のみ完了。runtime 実装は未着手。
次: Phase 29a から実装開始、または push/PR/main CI に進む。
```

親リポジトリは変更していません。次回は「前回の `1af1fcd` から Phase 29a を進めてください」または「push/PR/main CI まで進めてください」でスムーズに続けられます。
````

## 2026-06-19 Phase 29 Agent Execution Foundation Slice

- Implemented the first Phase 29 runtime foundation slice for `agent_execution` before provider adapters were added.
- Added `src/agent-execution.js`, `agent execution plan/status/list`, and the first `agent execution run` parser/API surface with explicit `--execute` enforcement.
- Added `agent_execution` schema registry/file parity and package API exports.
- Fixed product-local gate evidence source validation so documented `product.design_system.*` evidence rows can be recorded under their canonical source id.
- Dry-run execution plans write local metadata and receipts under `.browser-debug/agent-executions/` and `.browser-debug/receipts/`.
- Preserved existing `agent_workflow` status semantics, deterministic review findings, metrics, existing action plans, release readiness, resource guard behavior, artifact cleanup behavior, and MCP allowlist boundaries.
- Verification so far: `node --check src/agent-execution.js`, `node --check src/cli.js`, `node --check src/parser.js`, `npm test`, `./tools/check_product_structure.sh`, `./tools/check_product_docs.sh`, `./tools/check_product_security.sh`, `./tools/check_product_design_system.sh`, `./tools/product-gate`, and `npm run release:check`.
- The follow-up provider-runner isolation slice is complete in the adapter completion entry below.

## 2026-06-19 Phase 29 Agent Execution Adapter Completion

- Completed the remaining Phase 29 implementation plan for agent execution provider adapters.
- Added `src/agent-execution-providers.js` as the dedicated adapter boundary for deterministic fake provider execution, configured local runner callbacks, and env-only generic API execution.
- Updated `agent execution plan` to record provider adapter metadata, dashboard status fields, normalized result paths, and run commands that include `--execution`.
- Updated `agent execution run` to require a matching dry-run execution plan plus explicit `--execute`, reject package/surface/provider/model mismatches, write local run receipts, update execution status, and write normalized advisory results under `.browser-debug/agent-results/`.
- Preserved existing review findings, metrics, action plans, release readiness, resource guard behavior, artifact cleanup behavior, existing `agent_workflow` status meanings, and MCP execution non-exposure.
- The implementation does not accept free-form shell commands, automate SaaS web UIs, persist credential values, store raw provider responses, mutate review artifacts, launch browsers from agent execution, or add provider calls outside the adapter module.
- No-browser coverage now includes fake provider success, configured local runner success, API missing-configuration blocking, injected API transport success, advisory normalization, dashboard status/list aggregation, and provider boundary architecture checks.

## 2026-06-20 Phase 32 Rename Readiness

- Completed Phase 32 rename readiness without renaming the package, repository, plugin, MCP server, CLI commands, display name, license, or publication state.
- Added `src/product-identity.js` for package, CLI, MCP, plugin, repository, skill path, version, and package-check temporary path metadata.
- Exported product identity helpers through the package API and used identity metadata in MCP initialize output, CLI MCP metadata, and the MCP bin help text.
- Replaced hard-coded package dry-run and packed-install smoke paths with identity-derived runners in `tools/pack-dry-run.mjs` and `tools/pack-install-smoke.mjs`.
- Added no-browser and packed-install coverage for package/plugin/MCP/API identity alignment and unchanged current names.
- Updated product manifests, repository index, implementation plan, specification, security/release/verification docs, README, changelog, task tracker, handoff, and AGENTS current phase for the rename-readiness boundary.
- Phase 32 remains local-first and additive. Future package rename, repository rename, CLI rename, MCP server rename, plugin rename, public package naming, license change, marketplace registration, npm publication, or external evidence transfer still requires explicit approval.

## 2026-06-20 Phase 33 MCP Read-Only Agent Status

- Completed Phase 33 MCP read-only agent status without exposing package generation, ingest, report writing, workflow creation, execution planning, `agent execution run`, cleanup execution, provider/API execution, shell tools, daemon/session control, HTTP/socket transport, external upload, credential handling, or gate mutation.
- Added safe/full/admin MCP tools for local agent surfaces, request status/detail, workflow status/index, and execution status/list by reusing the existing CLI/core command contracts.
- Preserved the `safe` profile as no-browser, no-delete, no-provider, no-shell, and no-external-listener.
- Added no-browser MCP coverage for tool listing, safe-profile availability, status/detail calls, packed-install exposure, and continued non-exposure of execution run, cleanup execution, provider/API execution, shell tools, HTTP/socket transport, and write-producing advisory tools.
- Updated product manifests, implementation plan, specification, security/release/verification docs, README, changelog, task tracker, handoff, and AGENTS current phase for the MCP read-only agent status boundary.

## 2026-06-20 Phase 34 Safe HTTP MCP Foundation

- Completed Phase 34 safe HTTP MCP foundation without exposing HTTP `full` or `admin`, socket transport, remote HTTP listeners, cleanup execution, provider/API execution, `agent execution run`, shell tools, external upload, profile reuse, credential storage, or gate mutation through MCP.
- Added `src/mcp-transport-policy.js` and `src/mcp-http-transport.js` for explicit `browser-debug-mcp --transport http --profile safe` operation.
- HTTP MCP transport is loopback-only, bearer-token gated by `BROWSER_DEBUG_MCP_HTTP_TOKEN` by default, Host/Origin validated, request-size bounded, safe-profile-only, and isolated from review, resource, agent, provider, cleanup, daemon, and browser runtime modules.
- Extended `browser-debug mcp serve --json`, `browser-debug-mcp` help, parser options, and package API exports for transport metadata and embedding.
- Added no-browser tests for HTTP metadata, safe-profile-only startup, loopback enforcement, token enforcement, Origin rejection, method rejection, body-size limits, and safe tool listing.
- Added packed-install and architecture/security coverage for HTTP transport files and package API exports.
- Synchronized README integration modes, product requirements/specification/implementation plan, security, verification, release, changelog, manifests, task tracker, handoff, AGENTS current phase, plugin skill, and identity migration runbook.

## 2026-06-20 Phase 35 HTTP MCP Integration Hardening

- Added token-free `browser-debug mcp config` output for reusable stdio and explicit safe HTTP MCP client setup.
- Added `src/mcp-client-config.js` and package API exports for configuration metadata without launching a listener, writing config files, reading token values, printing token values, storing credentials, or broadening MCP permissions.
- Generated stdio config defaults to `safe`; packaged `.mcp.json` and no-profile `browser-debug-mcp` remain compatibility `full`.
- Generated HTTP config is safe-profile-only, loopback-only, token-env based, and emits a placeholder bearer token reference rather than token values.
- Added no-browser tests for `mcp config`, HTTP `full` rejection, token non-disclosure, and no-listener boundaries.
- Added packed-install smoke coverage for the installed HTTP MCP handler `initialize` path without binding a port.
- Synchronized README, plugin skill, product docs, workflow docs, manifests, task tracker, handoff, AGENTS current phase, release notes, verification, and security docs.

## 2026-06-20 Phase 36 MCP Capability Policy

- Added read-only `browser-debug mcp capabilities --json` output for MCP profile, transport, admin policy, and excluded-operation inspection.
- Added `src/mcp-capabilities.js` and package API exports for the no-side-effect policy report.
- Exposed `browser_debug_mcp_capabilities` through safe/full/admin MCP profiles because it does not launch browsers, write artifacts, delete files, call providers, upload evidence, execute shell commands, or open listeners.
- The report records that `admin` is currently equivalent to `full` and that cleanup execution, package/ingest/report writing, workflow creation/report writing, execution planning, `agent execution run`, daemon/session control, provider/API execution, arbitrary shell, socket transport, remote HTTP listeners, and HTTP `full` or `admin` remain excluded from MCP.
- Added no-browser, architecture, and packed-install smoke coverage for CLI/API/MCP policy reporting.
- Synchronized README, plugin skill, product docs, workflow docs, manifests, task tracker, handoff, AGENTS current phase, changelog, release notes, verification, and security docs.

## 2026-06-20 Phase 37 External Repository Usage Quickstart

- Updated the post-merge workflow state after Phase 36 PR CI, main CI, and local/remote synchronization completed.
- Selected external-repository usage guidance as the next low-risk phase because it improves ecosystem adoption without broadening MCP permissions or runtime authority.
- Added packaged `docs/workflow/CONSUMER_USAGE.md` with CLI, MCP stdio, safe HTTP MCP, and Codex plugin connection guidance for consumer repositories.
- Updated README and `skills/browser-debug-review/SKILL.md` so agents can use `mcp config`, `mcp capabilities`, and the packaged guide instead of reading source internals.
- Added package file-set, product manifest, repository index, no-browser architecture, and packed-install smoke coverage for the guide.
- Phase 37 does not change runtime behavior, MCP permissions, publication state, marketplace state, identity names, cleanup execution, provider/API execution, shell tools, remote listeners, or credential handling.

## 2026-06-20 Phase 38 Local Checkout MCP Config Dogfood

- Dogfooded external-repository no-browser usage from a temporary consumer workspace and confirmed `doctor`, `mcp capabilities`, `resource status`, `target init`, and `target validate` work from outside the product repository.
- Identified that `mcp config` still assumed `browser-debug-mcp` was installed and on PATH, which forced unpublished local-checkout users to know package internals.
- Added `local_checkout` metadata to generated stdio and safe HTTP MCP config output, including the current package root, absolute MCP bin path, `node` launch command, stdio `mcpServers`, and safe HTTP launch metadata.
- Preserved installed-bin `launch`, `client_connection`, and `mcpServers` output for compatibility.
- Added no-browser and packed-install smoke assertions for local-checkout metadata without starting listeners, writing config files, reading credentials, emitting token values, expanding MCP permissions, publishing, or renaming identities.

## 2026-06-21 Phase 39 Consumer Runtime Readiness Guidance

- Recorded the external-repository dogfood lesson that Browser Debug CLI connection can be healthy while the reviewed app is missing its own local API/backend runtime.
- Added target runtime-readiness guidance to `docs/workflow/CONSUMER_USAGE.md`, README, and the plugin-facing skill.
- Documented that frontend-only dev servers can correctly produce `needs_attention` or browser-health findings when required API/backend endpoints are absent.
- Kept app-specific startup commands, API base environment variables, degraded-mode expectations, and acceptance notes in the consumer repository rather than Browser Debug CLI runtime branches.
- Added no-browser architecture assertions for generic packaged guidance without consumer-specific product names or local user paths.

## Phase 40 TraceCue Identity Migration

- Canonical product identity is TraceCue / `trace-cue` / `trace-cue-mcp`.
- Legacy `browser-debug` and `browser-debug-mcp` aliases remain supported for existing users.
- The default artifact root remains `.browser-debug/` for compatibility; `.trace-cue/` is reserved as a future artifact root, not the current default.
- The local checkout root may still use the current `browser-debug-cli` directory name until the approved physical workspace rename is performed.

## Phase 41 Visual Evidence Core

- Added a local visual evidence metadata core under `src/visual-evidence.js`.
- Added the `visual_evidence` schema and package/API exports.
- Visual evidence records are metadata-only, local-first, provider-free, MCP-execution-free, and stored under the existing `.browser-debug/visual-evidence/` artifact root. Existing `observe`, `review`, and `supervise` screenshot paths keep their `screenshot` artifacts and additionally emit `visual_evidence` metadata artifacts.

## 2026-06-21 Phase 42 Visual Review Provider Policy

- Phase 42 is complete for planning-only visual review provider policy metadata.
- Added `src/visual-review-provider-policy.js`, `schemas/visual-review-provider-policy.schema.json`, package API exports, schema registry coverage, and packed-install verification.
- `agent execution plan` records now include `visual_review_provider_policy` with raw pixels, raw DOM, trace content, console payloads, network payloads, report bodies, credential values, raw provider responses, provider execution authorization, external evidence transfer authorization, and MCP execution all defaulting false.
- `agent execution run` remains unchanged and still requires a prior plan plus explicit `--execute`.
- MCP remains non-executing for provider/API, visual provider execution, cleanup execution, shell, daemon/session control, HTTP full/admin, socket transport, and remote listeners.
- Verification passed: `npm test`, `npm run test:browser`, `npm run test:pack`, `npm run test:pack-install`, `./tools/product-gate`, `npm run release:check`, and `git diff --check`.

## 2026-06-21 Phase 43 Standalone Image Review

- Phase 43 is complete for no-browser standalone image review.
- Added `src/image-review.js`, `schemas/image-review.schema.json`, parser/CLI/API wiring, schema registry coverage, no-browser tests, architecture checks, and packed-install coverage.
- `trace-cue review --image <workspace-file> --json` reads only workspace-relative regular image files through the visual evidence core, writes `reviews/<id>.json`, `review-artifacts/<id>.json`, and `visual-evidence/<id>.json`, and can write a bounded Markdown report with `--report`.
- The mode rejects URL/data URI/stdin/`@file`/absolute/parent-traversal image inputs and rejects provider, model, or execute options.
- No browser launch, provider call, external upload, raw pixel JSON embedding, credential read, MCP execution expansion, or existing URL/target review behavior change was introduced.

## 2026-06-21 Phase 44 Visual Review Result Preparation

- Completed Phase 44 local visual review result preparation without provider execution, raw pixel transfer, external upload, MCP exposure, or deterministic review mutation.
- Added `trace-cue visual review prepare --review-index <review-artifact-index> --json` for metadata-only preparation artifacts and receipts under `.browser-debug/visual-review-results/` and `.browser-debug/receipts/`.
- Added `visual_review_result_preparation` and future `visual_review_result` schemas, package API exports, no-browser tests, architecture boundaries, MCP capability exclusion reporting, and packed-install coverage.
- The implementation reads review artifact indexes and visual evidence metadata only; it does not read raw screenshot/image bytes, report bodies, DOM payloads, trace contents, console payloads, network payloads, credentials, or environment values.

## 2026-06-21 Phase 45 CLI Visual Review Execution

- Completed Phase 45 CLI-only visual review execution from Phase 44 preparation artifacts.
- Added `trace-cue visual review run --preparation <path> --surface <id> --provider <id> --model <id> --execute --json`, plus `visual review status` and `visual review list` for local execution artifacts.
- The implementation validates metadata-only preparation artifacts, runs fake/local/API provider adapters with no raw pixel reads or transfer, normalizes untrusted advisory output into `visual_review_result`, and writes `visual_review_execution` status and receipts.
- MCP exposure remains disabled for visual review execution, raw provider responses and credential values are not stored, existing reviews and release gates are not mutated, and raw-pixel visual provider execution remains a separate future design.

## 2026-06-21 Phase 46 Visual Review Dashboard Integration

- Completed a read-only visual review dashboard slice.
- Added `trace-cue visual review dashboard --json`, `src/visual-review-dashboard.js`, `schemas/visual-review-dashboard.schema.json`, API exports, schema registry wiring, and safe MCP exposure through `browser_debug_visual_review_dashboard`.
- The dashboard reads local visual review preparation, execution, and result metadata only. It writes no artifacts, executes no providers, reads no raw pixels, exposes no MCP execution, mutates no existing reviews, and changes no gates.
- Added no-browser, architecture, schema, MCP, packed-install, product-manifest, security-manifest, README, skill, verification, handoff, task-tracker, and changelog synchronization for Phase 46.

## 2026-06-21 Phase 47 MCP Execution Gate Policy

- Added read-only MCP execution gate policy reporting with `trace-cue mcp execution gates --json`, `src/mcp-execution-gates.js`, `schemas/mcp-execution-gates.schema.json`, API exports, schema registry wiring, and safe MCP exposure through `browser_debug_mcp_execution_gates`.
- The report covers future MCP gate requirements for visual review preparation, visual review execution, agent execution planning/run, and artifact cleanup execution while keeping current MCP write/execute exposure disabled.
- The implementation writes no artifacts, deletes no files, executes no providers, reads no credentials, reads no raw pixels, changes no MCP permissions, mutates no reviews, and changes no gates.

## 2026-06-21 Phase 48 Screen and Window Capture Planning

- Added read-only capture planning with `trace-cue capture plan --json`, `src/capture-plan.js`, `schemas/capture-plan.schema.json`, API exports, schema registry wiring, and safe MCP exposure through `browser_debug_capture_plan`.
- The report covers screen, window, and desktop app capture gates while keeping capture execution disabled.
- The implementation captures no pixels, writes no artifacts, enumerates no windows or processes, calls no providers, transfers no evidence, exposes no MCP execution, mutates no reviews, and changes no gates.

## 2026-06-21 Phase 49 Existing Workspace Image Capture Metadata Handoff

- Added CLI/API-only capture metadata handoff with `trace-cue capture handoff --image <workspace-image> --source <screen|window|desktop-app> --json`, `src/capture-handoff.js`, `schemas/capture-handoff.schema.json`, API exports, and schema registry wiring.
- The handoff reads only workspace-confined existing image files for metadata and labels them as screen, window, or desktop app capture evidence.
- The implementation performs no OS capture, writes no artifacts, exposes no MCP tool, embeds no raw pixels in JSON, calls no providers, transfers no evidence, mutates no reviews, and changes no gates.

## 2026-06-21 Phase 50 Desktop Review Provider-Preparation Planning

- Added CLI/API-only desktop review provider-preparation planning with `trace-cue visual review plan --capture-handoff <workspace-json|-> --json`, `src/desktop-review-provider-preparation-plan.js`, `schemas/desktop-review-provider-preparation-plan.schema.json`, API exports, and schema registry wiring.
- The planner reads capture handoff JSON metadata only and reports future local review and provider-preparation readiness for screen, window, and desktop app evidence.
- The implementation rereads no image bytes, writes no artifacts, exposes no MCP tool, calls no providers, transfers no evidence, mutates no reviews, and changes no gates.

## 2026-06-22 Phase 51-55 Desktop Review and Visual Aggregation

- Added `review --image <workspace-image> --capture-handoff <workspace-json|-> --json` so caller-declared screen, window, and desktop app capture handoff metadata can be path/hash-verified before image review provenance reaches visual evidence metadata.
- Added shared capture handoff contract normalization helpers, stdin support for `--capture-handoff -` in CLI bin shims, API exports, no-browser tests, and package smoke coverage.
- Added read-only `visual review aggregate --preparation <workspace-json> --json`, `src/visual-review-aggregation.js`, `schemas/visual-review-aggregation.schema.json`, API exports, schema registry wiring, source-attributed finding aggregation, conflict reporting, malformed artifact warnings, and MCP non-exposure reporting.
- Desktop image review still performs no OS capture, surface identity verification, provider calls, raw-pixel JSON embedding, external transfer, MCP execution, review mutation, or gate changes.
- Visual aggregation writes no artifacts, runs no providers, reads no raw pixels, reads no credentials, stores no raw provider responses, exposes no MCP tool, mutates no reviews, and changes no gates.

## 2026-06-22 Phase 56 Rename Readiness Audit

- Added read-only `identity audit --json`, `src/identity-audit.js`, `schemas/identity-audit.schema.json`, parser/CLI/API wiring, schema registry coverage, and package smoke coverage.
- The audit reports canonical and legacy repository identity, checkout-name readiness, origin-remote readiness, legacy alias compatibility, artifact-root migration boundaries, and legacy-alias removal boundaries.
- Added `npm run test:rename-readiness` and `tools/check_rename_readiness.mjs` to guard physical checkout rename readiness without contacting remotes or mutating Git.
- Added legacy and canonical MCP config entries so local checkout users can continue using `browser-debug-cli` while `trace-cue` becomes the canonical identity.
- The implementation performs no shell execution, network contact, Git mutation, artifact writes, browser launch, provider execution, MCP execution, artifact-root migration, physical directory rename, remote repository rename, npm publication, or legacy alias removal.

## 2026-06-22 Phase 57 Physical Checkout Rename

- Moved the local repository directory from the legacy checkout name to `trace-cue`.
- Updated identity audit readiness status so moved checkouts can report `physical_rename_complete_remote_rename_pending` when the local directory is canonical and the origin remote still points at the legacy GitHub repository.
- Synchronized AGENTS, implementation plan, task tracker, handoff, release notes, and memory with the local filesystem rename.
- The move changed no Git history, origin remote URL, package name, CLI alias, MCP alias, artifact root, npm publication state, marketplace state, license, provider behavior, MCP permissions, or external transfer policy.

## 2026-06-22 Phase 58 Remote Repository Rename

- Renamed the GitHub repository to `https://github.com/xxxMasahiro/trace-cue`.
- Updated local `origin` to `https://github.com/xxxMasahiro/trace-cue.git`.
- Updated product identity metadata and plugin metadata so the canonical repository URL is `https://github.com/xxxMasahiro/trace-cue`.
- Kept the legacy `https://github.com/xxxMasahiro/browser-debug-cli` URL in legacy repository metadata for compatibility history.
- The remote rename changed no package name, CLI alias, MCP alias, artifact root, npm publication state, marketplace state, license, provider behavior, MCP permissions, or external transfer policy.
