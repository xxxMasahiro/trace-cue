# VERIFICATION.md

## Verification Scope

Current verification checks repository structure, document synchronization, security defaults, review/MCP/plugin local boundaries, Agentic Human Review plan/run/status/list boundaries, Agentic Human Review schema v2 human-review coverage/report-quality/provider payload boundaries, Agentic Human Review effort-aware report-quality diagnostic classification, Agentic Human Review structured benchmark requirement coverage, human-baseline registry/overlay/draft/approval/claim-readiness diagnostics, evidence-set validation and summary, batch comparison, evaluator policy, xhigh round planning and simulation, longitudinal quality, claim policy/audit and claim-standard-gate boundaries, Agentic Human Review benchmark/calibration/provider capability/evidence-planning boundaries, Agentic Human Review AHR-25-40 Visual Evidence Package v2, Visible Text Reading, dogfood readiness/plan, maturity and longitudinal-quality diagnostics, direct-vs-TraceCue comparison, xhigh round-plan v2, Quality Evaluator v3, Human Report v3, transfer approval preview, provider failure diagnostics boundaries, and the loopback Agentic Human Review Responses adapter boundary, MCP profile gating, MCP-only file-input confinement, MCP read-only agent status tools, MCP safe HTTP transport boundaries, token-free installed-bin and local-checkout MCP client configuration output, read-only MCP capability policy output, packaged external-repository usage guidance, consumer runtime-readiness guidance, product identity alignment, local language settings/localization/translation readiness boundaries, read-only operation registry, operation roadmap, operation contracts, operation policy, operation admin readiness, operation provider readiness, release readiness, artifact-root readiness, legacy alias readiness, constrained shell readiness, and final hardening readiness boundaries, CI configuration, design-system placeholders, product operation mode, local MVP runtime behavior, review platform behavior, dogfood target workflow behavior, no-browser target manifest validation, no-browser local resource status preflight, review resource guard behavior, daemon lifecycle guards, artifact usage planning, explicit artifact-root cleanup receipts, cleanup plan hashes and candidate locks, local agent advisory package/request-status/request-detail/workflow/ingest/report behavior, local agent execution plan/run/status/list behavior, deterministic fake provider execution, configured local runner callback execution, env-only generic API adapter behavior, expected-route execution, route-budget coverage accounting, page expectation coverage, rendered-state findings, manifest suggestions, opt-in content UX advisory behavior, selector-scoped advisory contracts, required user-question advisory checks, dedicated content UX handoff output, page-level content UX handoff, manifest-authoring suggestions, review brief/rubric evaluation, local artifact indexes, local review-quality signals, browser smoke coverage, Phase 29 agent execution boundaries, Phase 30 packed install release-hardening boundaries, Phase 31 MCP profile boundaries, Phase 32 rename-readiness boundaries, Phase 33 MCP read-only agent status boundaries, Phase 34 safe HTTP MCP foundation boundaries, Phase 35/38 MCP integration-hardening boundaries, Phase 36 MCP capability policy boundaries, Phase 37 consumer usage boundaries, Phase 39 consumer runtime-readiness boundaries, Phase 41 visual evidence metadata boundaries, Phase 42 visual review provider policy boundaries, Phase 43 standalone image review boundaries, Phase 44 visual review result preparation boundaries, Phase 45 visual review execution boundaries, Phase 46 visual review dashboard boundaries, Phase 47 MCP execution gate boundaries, Phase 48 capture planning/readiness boundaries, Phase 49 capture handoff boundaries, Phase 50 desktop review provider-preparation planning boundaries, Slice 7-8 capture schema/readiness/fail-closed execution boundaries, Phase 59 language settings foundation boundaries, Slice 9-12 provider-free localization and translation readiness boundaries, Phase 60 operation registry foundation boundaries, Phase 60.1 operation roadmap boundary-contract boundaries, Phase 61-64 operation contract foundation boundaries, Phase 65-68 operation policy/readiness boundaries, Phase 69-70 operation admin readiness boundaries, Phase 71-78 provider MCP readiness/execution/status-list boundaries, and Phase 120-155 release/artifact/alias/shell/final readiness boundaries.

Agentic Human Review dogfood evidence-pack summary coverage verifies `agentic review dogfood evidence-pack summarize` and `agentic review dogfood evidence-pack review-pack` for workspace-confined dogfood pack manifests, direct evidence-set manifests, and evidence-set output wrappers; matrix completeness by benchmark case and effort rather than total counts; ready/incomplete review-pack status projection; owner-facing standard/deep/xhigh matrix badges; grouped blocker and top-owner-action projection; owner-review-context re-sanitization from untrusted evidence-set output; claim-readiness, longitudinal-quality, and claim-standard-gate reuse; unsupported provider/model/surface and `--execute` rejection; outside-workspace rejection; schema/API/package parity; and suppression of detailed result paths, source paths, raw hash values in review packs, raw provider responses, credential values, full source text, chunk text, candidate/reference prose, concrete rerun commands, provider/API execution, artifact writes, browser launch, MCP exposure, automatic reruns, proof claims, release-gate mutation, and human-equivalent or human-superior claim authorization.

Playwright Test Integration Roadmap 1-18 coverage verifies mode defaults and mode writes, parser conflicts, read-only status/reporting, workspace-confined JSON/JUnit/HTML-reference import, normalized-result-only review-material projection, raw artifact rejection, non-engineer review cards, evidence-quality limits, standard/deep/xhigh review-input blocks, baseline comparison, local-run planning, explicit `--execute` plus plan-hash gating, fakeable fixed Playwright CLI execution, timeout and receipt output, read-only `gh run list/view/download` adapter behavior, exact artifact-name and numeric run-id requirements, downloaded artifact scan/import, Control Center regression read model and action endpoints, schema registry/file parity, API exports, package discovery, architecture/process isolation, MCP non-exposure, and no mutation of TraceCue deterministic findings, Agentic Human Review proof, product release gates, or CI state.

Persistent browser session verification covers Slice 0-8 boundary contracts, parser behavior, detached local worker behavior, retained page actions, observation, manual checkpoints, local review handoff, explicit storageState admin opt-in, schema parity, and MCP exposure. No-browser tests must prove that safe MCP and full MCP do not expose `browser_debug_session_*`, HTTP MCP does not expose persistent sessions, stdio `admin` exposes only the approved session tools, `browser_debug_supervise` is bounded and full-profile only, storageState import is confined to the configured artifact auth directory, action values are not written to terminal output, legacy session metadata remains compatible, and architecture tests prevent `launchPersistentContext`, `userDataDir`, existing-profile reuse, unapproved listeners, OAuth/password automation, external upload, and cookie/token value printing. Browser smoke tests must cover a retained context across start/status/act/observe/checkpoint/review/stop because this slice changes browser runtime behavior.

Owner-labeled human baseline registry, overlay, draft, approval, validation, comparison, and claim-readiness diagnostics are covered as read-only Agentic Human Review diagnostics; they compare workspace-confined owner labels to advisory result metadata, require approval metadata before owner-labeled evidence verifies, mechanically require target-specific must-not-miss criteria linked to evidence-backed owner labels before approval or validation can produce comparison-ready owner evidence, keep AI drafts non-proof, and do not call providers, write artifacts, expose MCP execution, or authorize equality/superiority claims. Owner-baseline contract propagation coverage verifies `--human-baseline` proposal/plan intake, fail-closed unapproved baseline rejection, plan-hash-bound path-free contract output, provider payload propagation, Responses adapter canonical `owner_baseline_findings` repair for every required owner-label obligation and target-specific criterion fallback, normalized result retention of `owner_baseline_findings`, comparison-visible merge into `agentic_human_review_findings`, size-bounded provider instructions and compact provider payload contract views that avoid duplicating long owner-baseline arrays, direct comparison from supported validation wrappers after embedded-baseline revalidation, and human-baseline comparison selecting evidence-backed exact owner-label or criterion findings before broad unbacked text matches while text-only matches remain insufficient. Adapter provider-payload compaction coverage verifies real-shaped owner-baseline requests stay under the configured request-size cap while preserving `required_benchmark_coverage`, label-granular `required_owner_baseline_findings`, `required_owner_baseline_coverage`, effective benchmark requirements, xhigh strict-output requirements, owner label ids, catalog-backed evidence refs, local path stripping, no credential disclosure, and non-secret request section byte diagnostics on overflow. Provider-facing request compaction must treat `input.required_*` templates as canonical, keep proof ids and evidence ids there, remove duplicated exact benchmark and owner-baseline prose from compact `review_request.plan` and package metadata, and bound provider output schema lengths and array counts without weakening post-validation. Adapter owner-baseline repair hardening coverage verifies request-derived `required_owner_baseline_findings`, repair context templates with recommended evidence-reference ids, strict rejection of role-level-only owner-baseline proof, conservative identifier aliases including evidence-reference aliases, label-granular repair filtering, and continued rejection of free-text-only owner-baseline discussion, unknown owner labels, and unknown evidence references. Effective owner-baseline coverage tests verify request-derived `required_benchmark_coverage` and `required_owner_baseline_coverage` templates, owner-baseline required mention/dimension/forbidden-claim evidence-reference catalog priority, repair prompts for missing coverage rows, effective benchmark coverage validation that combines benchmark and owner-baseline requirements, evidence-backed forbidden-claim absence rows, and no synthesis from prose or threshold relaxation. Proof-readiness hardening additionally requires no-browser coverage for request-aware adapter benchmark contracts, forbidden-claim presence-versus-absence semantics, repair/rejection of contradictory forbidden-claim records, structured findings with evidence-reference identifiers, safe alias normalization without fabricated coverage, supported CLI/API runtime-result wrapper aggregation, raw run-wrapper rejection as result evidence, explicit benchmark-case by effort matrices, blocker classification for missing results, mechanical incompleteness, failed calibration, missing comparisons, case-level `direct-vs-tracecue` gaps, and weak calibration claim-readiness blockers.

Editorial-quality comparison coverage verifies `agentic review compare --comparison-kind editorial-quality` reading a workspace-confined reference review text or JSON artifact, comparing it to a candidate advisory result's `editorial_synthesis.full_review`, emitting effort-target scores and diagnostics, rejecting raw media/binary/full-source/credential-bearing reference inputs, suppressing reference prose and candidate prose from JSON output, preserving false equality/superiority claim flags, and keeping provider calls, evidence transfer, MCP exposure, deterministic mutation, and release-gate mutation disabled.

Agentic Human Review provider model-resolution coverage verifies that provider-neutral abstract model ids can remain in proposal/plan artifacts for configurable planning, but cannot reach live provider API dispatch as executable upstream model names. No-browser tests must cover unresolved abstract models failing before fetch with `AGENTIC_REVIEW_PROVIDER_MODEL_UNRESOLVED`, runtime model environment fallback producing a concrete provider payload model, non-secret `model_resolution` metadata in payloads/executions/receipts/results, Responses adapter rejection of abstract request models before provider fetch, and continued credential-value and raw-provider-response non-storage.

Agentic Human Review adapter claim-filtering coverage verifies that provider-authored `review_claims` are optional proof candidates. No-browser tests must cover adapter-side filtering of placeholder, unsupported, unknown-role, equality, and superiority candidates without provider retry; safe `adapter_claim_filtering` diagnostics in adapter responses and normalized advisory results; result-level `claim_integrity` propagation that keeps rejected-candidate runs out of future claim-numerator evidence; direct generic-provider equality/superiority claim exclusion; staged final synthesis accepting prior normalized stage roles as valid support; and proof-ready evidence-set matrix fixtures that explicitly reset claim integrity only when retained claims are supported. Coverage must also prove that filtering does not store raw provider responses, credential values, local paths, raw provider bodies, or rejected claim text, and does not weaken owner-baseline, benchmark, xhigh, claim-standard-gate, MCP, deterministic-review, or release-gate boundaries.

Proof-claim integrity and minimal rerun planning coverage requires focused no-browser tests for fail-closed `review_claims` normalization, placeholder and unsupported claim rejection, adapter repair retries for invalid review claims, strict claim-numerator exclusion through result proof eligibility, evidence-set `claim_integrity` propagation, claim-standard-gate claim-audit failures, forbidden-claim audit provenance that separates blocking affirmative or ambiguous matches from non-blocking evidence-backed absence checks, comparison `metric_diagnostics`, human-baseline diagnostics for missing owner labels and evidence-backed forbidden-claim absence, and claim-standard-gate `rerun_plan` output. The rerun plan is verification guidance only: it must emit command templates and target metadata without calling providers, writing artifacts, launching browsers, mutating release gates, or automatically rerunning failed cells. Evidence regeneration planning coverage must prove that `agentic review evidence-set regenerate plan` consumes workspace-confined evidence-set and claim-gate artifacts, rejects `--execute`, classifies missing calibration cells, resolves provider-rerun plan paths/hashes/transfer flags only after validating explicit registry rows or the result -> execution -> plan artifact chain, fails closed for missing or tampered approved-plan data, marks provider-result reruns as approval-required templates, emits downstream summary/claim-readiness/longitudinal/gate commands, exposes schema/API/package coverage, and still performs no provider execution, artifact writes, browser launch, MCP exposure, or gate mutation.

Owner-baseline recovery coverage must prove that human-baseline comparison reports whether the candidate result carries a matching owner-baseline requirement contract, that evidence-set comparison records preserve those fields, and that claim-standard-gate rerun plans add an approval-required provider result target when owner-baseline comparison failure cannot be fixed by local comparison regeneration alone. Evidence regeneration planning must not reuse an old result execution plan for that target unless the plan or target registry proves a matching owner-baseline requirement contract. Without such proof, the provider rerun command stays unresolved with warnings.

Responses adapter long-dogfood coverage must prove that the adapter reports its effective upstream provider timeout in startup output, documents that this timeout is separate from `AGENTIC_HUMAN_REVIEW_API_TIMEOUT_MS`, and returns only allowlisted failure diagnostics for upstream timeout or request failures. Long loopback dogfood coverage must also prove that TraceCue's generic provider path and the adapter's upstream provider path use the repository-local bounded HTTP transport by default so the configured timeout, not Node's bundled fetch header timeout, governs slow response-header waits. Adapter and generic-provider timeout diagnostics may include `duration_ms`, `timeout_ms`, `failure_class`, and safe cause/code values, but must not include credential values, stack traces, raw provider responses, provider request bodies, or credential-bearing endpoint strings.

Staged `standard`, `deep`, and `xhigh` execution coverage must prove that `agentic review run --execution-mode staged` preserves the approved plan hash, exact transfer flags, provider/model/surface match, provider capability hash, owner-baseline requirement contract, benchmark requirement contract, advisory-only boundary, and no-MCP/no-raw-response/no-credential-value guarantees while aggregating multiple normalized provider stage outputs into one final advisory result. Focused tests must cover successful staged aggregation for each supported claim-evidence effort, incomplete stage output remaining non-proof and claim-ineligible, staged drift rejection before provider fetch, Responses adapter `store:false` and `tools:[]` behavior for staged calls, stage metadata not being accepted as a final advisory artifact, and human-equivalent or human-superior claim flags staying false.

Effort-aware report-quality diagnostic coverage must prove that standard and deep results classify missing dedicated critique or verification as expected effort gaps rather than policy warnings, while incomplete xhigh results continue to emit policy warnings, maturity gaps, and strict missing-condition diagnostics. Focused tests must cover embedded advisory `report_quality`, standalone `agentic review report-quality`, evaluator policy diagnostics, Markdown effort-note/warning rendering, schema parity, and preservation of advisory-only/no-provider/no-write/no-MCP/no-gate-mutation boundaries.

Responses adapter contract-recovery coverage must prove that repairable failures are aggregated across benchmark, owner-baseline, optional claim, and full or staged effort output contracts before a repair retry is built. Focused tests must cover missing-only repair context, filtered owner-baseline finding templates, recommended evidence-reference ids, path-oriented coverage repair targets, nested benchmark coverage schema `required` and `minItems` values derived from the active contract, repair-after-attempt completion for missing forbidden-claim absence rows with adapter-derived provenance, provider-authored missing-row coverage patch repair after exhausted full repair, rejection of coverage patch rows whose labels do not exactly match missing records or whose evidence refs are unknown, coverage-style forbidden checks that lack explicit absence semantics remaining repairable rather than silently passing, stage-aware role/round validation, final-stage synthesis requirements, summary-placeholder role output being excluded from reported role/round coverage, ordinary page-content not-available wording remaining valid reported output, truthy placeholder-generated flags remaining invalid, safe `placeholder_outputs` stage/role/round repair metadata, safe loopback adapter diagnostics persisted to execution records and run receipts, request/response size-limit CLI help and startup metadata, and continued exclusion of raw provider responses, request payloads, credentials, endpoint strings, local paths, target-specific branches, deterministic review mutation, MCP exposure, and release-gate mutation.

Agentic Human Review editorial synthesis coverage must prove that the synthesis is derived only from existing normalized advisory-result data. Focused tests must cover JSON result output, Markdown report rendering, advisory-only and gate-neutral boundaries, source refs that point only to existing result sections and ids, no provider prompt or adapter schema expansion, no extra API calls, no raw provider response or credential persistence, no deterministic finding or metric mutation, no proof-contract satisfaction, 14-locale artifact output language settings alignment, source/UI/explicit/unresolved language modes, JSON and Markdown language metadata agreement, source-text preservation when translation execution is disabled, no source evidence or provider-output translation, no MCP exposure, and limited fallback behavior when findings, reported role opinions, source-understanding records, or bounded content signals are too sparse for a fuller editorial review. Source-text reading and source-understanding coverage must prove that `agentic review propose` and `agentic review plan --source-text` can read workspace-confined plain text or analyzer-neutral JSON, reject raw media, raw binaries, base64/blob/data URI payloads, credential-like structured fields, and raw/full structured content fields, persist no full source text or chunk text, derive effort-aware `source_reading_review` and `source_understanding_review` output, include source-understanding material in editorial synthesis, `editorial_integrator`, report-quality diagnostics, provider compact payloads, and Markdown reports, expose schema/API/package coverage, include provider payload data only under the existing page-text transfer boundary, compact source-understanding provider refs to ids and hashes without excerpt text or source locators, keep fake-provider scaffolding, internal `Step`/`role` markers, operational effort labels, assistant-reference target labels, duplicate or near-duplicate source anchors, target-specific heuristics, and boundary boilerplate out of the natural review body, show effort-profiled prose differences for standard/deep/xhigh, verify the source-text/source-understanding natural-composition matrix across video, web page, PDF, meeting-note, and document source types, include xhigh critique, verification, counterpoint, evidence-limit, and conclusion-change-condition language when the xhigh contract is complete, and preserve no-provider/no-MCP/no-proof/no-gate-mutation/no-human-equivalence/no-human-superiority boundaries. Source-text effort-quality coverage must prove `agentic review quality source-text` validates standard/deep/xhigh result artifacts, reports source-understanding completion, source-text non-persistence, same-source identity invariant status, source-reading/source-understanding source id consistency, direct raw source-text alias diagnostics, raw chunk alias diagnostics, effort-specific editorial hashes and deltas, xhigh critique readiness, optional reference-review scoring without reference metadata false positives, output-safety category flags, schema/API/package parity, `--execute` rejection, and no full-source/chunk/candidate/reference prose, private source identity value, path, locator, source title, provider, MCP, proof, or release-gate leakage.

Manual proof-evidence regeneration should use the same generic sequence for every target artifact and benchmark case: produce or update owner-approved generic plus target-specific human-baseline criteria, run approved standard/deep/xhigh dogfood through the existing plan-hash and exact-transfer-flag path, regenerate calibration, direct-vs-TraceCue, human-baseline comparison, evidence-set summary, claim-readiness, longitudinal quality, and claim-standard-gate outputs, then inspect the gate `blockers` and `rerun_plan` before deciding whether another approved provider run is warranted. Human-equivalent and human-superior claims remain false unless a separately approved claim standard changes the active policy.

## Product-Local Commands

```bash
npm test
npm run test:rename-readiness
npm run test:browser
npm run test:pack
npm run test:pack-install
npm run release:check
./tools/check_product_structure.sh
./tools/check_product_docs.sh
./tools/check_product_security.sh
./tools/check_product_ci.sh
./tools/check_product_design_system.sh
./tools/test_product_repository.sh
./tools/product-gate
```

`./tools/test_product_repository.sh` and `./tools/product-gate` run structure, docs, security, CI manifest, design-system, product mode, `npm test`, `npm run test:rename-readiness`, `npm run test:pack`, and `npm run test:pack-install` when `package.json` is present. `npm run test:browser` is intentionally separate because it launches local Chromium. `npm run release:check` is a no-publish convenience wrapper for no-browser, rename-readiness, package dry-run, and packed install smoke checks.

## Lesson-Side Commands

From `/home/masahiro/projects/ai-driven-development-lesson`:

```bash
PRODUCT_REPO_ROOT="$(git -C /path/to/current-trace-cue-checkout rev-parse --show-toplevel)"
./tools/product-scaffold-check check --repo "$PRODUCT_REPO_ROOT" --context free-development --product-type all --git-optional --ci-optional
./tools/product-repository-authority status --repo "$PRODUCT_REPO_ROOT" --context free-development --product-type all --git-optional --ci-optional
./tools/check_workflow_pair_sync.sh --repo "$PRODUCT_REPO_ROOT"
```

## Current Runtime Checks

The current implementation includes command parser tests, deterministic JSON error tests, `doctor` tests for environment, schema-versioning, and artifact-retention metadata, resource status tests for deterministic memory/cgroup/pressure fixtures and read-only boundaries, resource guard fail-critical tests, artifact plan/dry-run/execute receipt tests, agent surfaces/package/request-status/request-detail/workflow/ingest/report tests, agent execution plan/run/status/list tests for fake provider, configured local runner, missing API configuration, injected API transport, normalized advisory results, and dashboard status/list aggregation, review parser tests, schema command tests, schema registry/file parity tests, target init tests, target validate tests, target manifest tests, opt-in content UX advisory tests, selector-scoped binding tests, required user-question tests, dedicated content UX handoff tests, page handoff tests, manifest-authoring suggestion tests, review brief/rubric tests, action risk classification tests, MCP adapter allowlist tests, MCP safe HTTP transport tests, shell-safe action input tests, headed/devtools launch-mode tests, session/report/spec tests, daemon parser and lifecycle option tests, redaction tests, architecture regressions for generic runtime boundaries, shared evidence helpers, local daemon boundaries, resource status read-only boundaries, resource guard and artifact cleanup boundaries, agent advisory local handoff/workflow boundaries, agent execution provider adapter boundaries, visual review result preparation boundaries, content UX advisory purity, review/MCP/plugin security boundaries, local package dry-run verification, packed install smoke verification, and Playwright smoke tests for local file observation, screenshot/trace artifacts, click actions, form controls, keyboard input, deterministic scroll, wait actions, reports, spec export, process-scoped supervision, daemon start/status/stop, deterministic review findings, action plans, local review advisory output, quality signals, rendered-state findings, mock metrics, target manifest review, target reports, manifest suggestions, content UX advisory opt-in invariance, selector-scoped content UX advisory, content UX Developer Handoff reports, content UX page handoff output, manifest-authoring output, content UX review brief/rubric output, route discovery, explicit expected-route execution, route-budget skip coverage, viewport execution, and coverage artifacts. Manual local checks can use:

Phase 11 adds no-browser coverage for optional manifest page normalization and browser smoke coverage for page expectation checks, page-specific mock metrics, review artifact indexes, `coverage.pages`, and `quality_signals.page_expectations`.

Phase 12 adds browser smoke coverage for broken visible images, lingering loading indicators, empty table/list/grid containers, `quality_signals.rendered_state`, Developer Triage report output, and target review `manifest_suggestions`.

Phase 14 adds no-browser coverage for schema parity, manifest content UX advisory normalization, and source-value non-disclosure. It also adds browser smoke coverage proving `localContentUxAdvisory.enabled=true` emits advisory output without changing findings, metrics, action plans, or release readiness.

Phase 15 adds no-browser and browser smoke coverage for selector-scoped `text`, `attribute`, `data-state`, `data-risk`, and required user-question advisory checks while preserving advisory-only gate behavior.

Phase 16 adds no-browser and browser smoke coverage for additive `content_ux_findings`, `content_ux_action_plan`, `content_ux_readiness`, Markdown Content UX Developer Handoff output, source-value non-disclosure, disabled-output absence, and unchanged review findings, `metrics.finding_count`, existing `action_plan`, and `quality_signals.release_readiness`.

Phase 17 adds no-browser and browser smoke coverage for expanded content UX categories, additive `content_ux_page_handoff`, additive `content_ux_manifest_authoring`, Markdown page/authoring summaries, source-value non-disclosure, disabled-output absence, and unchanged review findings, `metrics.finding_count`, existing `action_plan`, and `quality_signals.release_readiness`.

Phase 18 adds no-browser and browser smoke coverage for additive `content_ux_review_brief`, additive `content_ux_rubric_evaluation`, Markdown brief/rubric summaries, source-value non-disclosure, disabled-output absence, and unchanged review findings, `metrics.finding_count`, existing `action_plan`, and `quality_signals.release_readiness`.

Phase 19 adds no-browser coverage for `target validate` parser/runtime behavior, invalid manifest errors, manifest count output, source-value non-disclosure, MCP validation wiring, and local-first boundaries without launching a browser.

Phase 20 adds no-browser coverage for `resource status` parser/runtime behavior, deterministic memory/cgroup/pressure fixture output, MCP resource status wiring, API export, warnings and recommendations, and read-only local-first boundaries without launching a browser, writing artifacts, mutating system cache, configuring swap, deleting files, executing shell commands, using privileged helpers, uploading evidence, reusing profiles, or controlling arbitrary processes.

Phase 21-24 add no-browser coverage for review resource guard parser/runtime behavior, critical fail-before-launch behavior, additive resource guard output, daemon lifecycle parser/metadata behavior, artifact usage planning, dry-run no-delete behavior, explicit artifact-root-only cleanup receipts, MCP artifact-plan-only wiring, and architecture boundaries that prevent host cache/swap mutation, shell execution, privileged helpers, external upload, profile reuse, arbitrary process control, cleanup outside `.browser-debug/`, and MCP cleanup execution.

Phase 25 adds no-browser coverage for agent surface listing, bounded evidence package generation, prompt and receipt artifacts, advisory result ingest, advisory report output, schema parity, API-boundary status, unchanged deterministic gate semantics, and architecture boundaries that prevent provider API calls, automatic upload, credential storage, external listeners, shell execution, profile reuse, MCP agent execution, and review artifact mutation.

Phase 26 adds no-browser coverage for `agent requests list`, pending/imported status transitions, single-package filtering, request status schema parity, API export, no browser launch, no provider API calls, no automatic upload, no credential storage, no MCP agent execution, and no review artifact mutation.
Phase 27 adds no-browser coverage for `agent requests show`, pending/imported detail output, selected-result matching, request detail schema parity, API export, no artifact writes, no browser launch, no provider API calls, no automatic upload, no credential storage, no MCP agent execution, and no review artifact mutation.
Phase 28 adds no-browser coverage for `agent workflow create/status/index/report`, local workflow manifests and receipts, post-ingest status recomputation, workflow index aggregation, workflow report output, workflow schema parity, API export, no browser launch, no provider API calls, no automatic upload, no credential storage, no MCP agent execution, no external evidence transfer, and no review artifact mutation.

Phase 29 adds no-browser coverage for `agent execution plan/run/status/list`, dry-run plan receipts, explicit `--execute` plus `--execution` enforcement, provider/model mismatch rejection, deterministic fake provider execution, configured local runner callback execution, env-only generic API provider execution, missing API configuration blocking, bounded disclosure, credential redaction, raw artifact non-transfer, raw provider response non-persistence, advisory normalization, execution schema parity, dashboard execution status/list fields, unchanged `agent_workflow` semantics, unchanged deterministic review gates, and MCP execution non-exposure.

Phase 30 adds packed install smoke coverage for the `npm pack` tarball from a temporary install layout. It verifies packaged CLI entrypoints, package API imports, MCP stdio `tools/list`, schema/template/plugin file presence, selected workflow security docs, `doctor`, `schema list`, and no-browser `target validate` without publication, registry install, package rename, license change, external upload, credential storage, or marketplace mutation.

Phase 31 adds no-browser coverage for MCP `safe`, `full`, and `admin` profile resolution, default/full compatibility, launch metadata, out-of-profile tool rejection, invalid profile rejection, packed-install profile API exports, and MCP-only workspace-confined `@file` input rejection. Browser smoke tests are not required for Phase 31 unless browser runtime behavior changes.

Phase 32 adds no-browser coverage for product identity metadata, package/plugin/MCP alignment, package API identity exports, identity-derived package dry-run paths, and packed-install smoke paths derived from package metadata rather than a hard-coded tarball filename. Browser smoke tests are not required for Phase 32 unless browser runtime behavior changes.

Phase 33 adds no-browser coverage for MCP read-only agent advisory/status tools, safe-profile availability, package/request/workflow/execution status calls, packed-install tool exposure, and continued non-exposure of execution run, cleanup execution, provider/API execution, shell, HTTP/socket transport, and artifact-writing advisory tools. Browser smoke tests are not required for Phase 33 unless browser runtime behavior changes.

Phase 34 adds no-browser coverage for explicit HTTP MCP metadata, safe-profile-only startup, loopback bind enforcement, bearer-token enforcement, Host and Origin validation, method rejection, request body-size limits, safe tool listing over HTTP, package API transport exports, and architecture/security isolation of the approved listener module. Browser smoke tests are not required for Phase 34 unless browser runtime behavior changes.

Phase 37 adds no-browser and packed-install coverage for packaged external-repository usage guidance. Browser smoke tests are not required for Phase 37 unless browser runtime behavior changes.

Phase 39 adds no-browser architecture coverage for packaged consumer runtime-readiness guidance. Browser smoke tests are not required for Phase 39 unless browser runtime behavior changes.

Agentic Human Review AHR-25-40 adds no-browser coverage for Visual Evidence Package v2, Visible Text Reading contracts, transfer approval preview, dogfood readiness, dogfood plan, direct-vs-TraceCue comparison mode, xhigh round-plan v2, Quality Evaluator v3, Human Report v3, provider failure diagnostics, schema/API/parser/CLI parity, packed-install schema resolution, and continued absence of provider calls, credential-value reads, raw provider response storage, raw pixel bytes in JSON, MCP AHR execution, deterministic review mutation, and release-gate mutation from readiness/calibration/planning surfaces. Browser smoke tests are not required unless browser runtime behavior changes.

Phase 44 adds no-browser coverage for `visual review prepare`, metadata-only visual evidence preparation, future `visual_review_result` contract exposure, no-provider/no-transfer/no-MCP-execution boundaries, schema registry parity, API exports, MCP non-exposure, capability-policy exclusion reporting, and packed-install file/API/schema coverage. Browser smoke tests are not required for Phase 44 unless browser runtime behavior changes.

Phase 46 adds no-browser coverage for `visual review dashboard`, read-only aggregation over preparation/execution/result metadata, API exports, schema parity, safe MCP tool exposure, architecture boundaries, and packed-install file/API/schema/MCP coverage. Browser smoke tests are not required for Phase 46 unless browser runtime behavior changes.

Phase 47 adds no-browser coverage for `mcp execution gates`, read-only future MCP planning/execution gate reporting, API exports, schema parity, safe MCP tool exposure, architecture boundaries, and packed-install file/API/schema/MCP coverage. Browser smoke tests are not required for Phase 47 unless browser runtime behavior changes.

Phase 48 and Slice 7-8 add no-browser coverage for `capture readiness`, `capture status`, `capture plan`, fail-closed `capture run --execute`, read-only screen/window/desktop app capture capability/privacy/planning, capture artifact and receipt schema contracts, API exports, schema parity, safe MCP readiness/plan exposure, MCP execute-argument rejection, operation registry/capability boundaries, architecture boundaries, and packed-install file/API/schema/MCP coverage. Browser smoke tests are not required unless browser runtime behavior changes.

Phase 49 adds no-browser coverage for `capture handoff`, workspace-confined existing-image metadata handoff, API exports, schema parity, MCP non-exposure, architecture boundaries, and packed-install file/API/schema coverage. Browser smoke tests are not required for Phase 49 unless browser runtime behavior changes.

Phase 50 adds no-browser coverage for `visual review plan --capture-handoff`, capture handoff metadata-only planning, API exports, schema parity, MCP non-exposure, capability/gate reporting, architecture boundaries, and packed-install file/API/schema coverage. Browser smoke tests are not required for Phase 50 unless browser runtime behavior changes.

Phase 59 and Slice 9-12 add no-browser coverage for `settings show`, `settings language`, `settings language policy`, `settings locale resources`, `settings report templates`, `translation readiness`, `translation dry-run`, fail-closed `translation run --execute`, locale alias normalization, dashboard display locale and artifact output language separation, UI/report locale fallback and RTL guards, raw-evidence/canonical-enum non-translation policy, schema parity, API exports, safe MCP read-only inspection, review/dashboard metadata, provider-free translation boundaries, local settings-file confinement, no credential reads, no network/provider calls, and no artifact writes. Browser smoke tests are not required unless browser runtime behavior changes.

The local dashboard settings store adds focused coverage for shared-default and
local-overlay precedence, tracked-default byte stability, current-user migration,
one-request Control Center saves, legacy writer compatibility, serialized
updates, mode-0600 atomic replacement, malformed JSON preservation, size/type
limits, symlink/workspace escape rejection, immutable external-send confirmation,
and forced-off execution/credential/gate fields. Full CLI/API/MCP tests verify
that isolated test workspaces do not inherit developer preferences. Browser
smoke must verify save, reload projection, success feedback, desktop/mobile
layout, no console errors, and no tracked settings mutation.

Phase 60 adds no-browser coverage for `operation registry`, operation/group/risk selection, schema parity, API exports, safe MCP read-only inspection, registry-derived MCP capability exclusions, registry-derived MCP execution gate operation metadata, package smoke coverage, and architecture boundaries proving no provider execution, deletion, capture, translation execution, npm publication, artifact-root migration, legacy alias removal, shell execution, or MCP write/execute expansion. Browser smoke tests are not required for Phase 60 unless browser runtime behavior changes.

Phase 60.1 adds no-browser coverage for `operation roadmap`, phase/group/risk selection, phase A/B/C boundary contracts, schema parity, API exports, safe MCP read-only inspection, unsupported execution-option rejection, package smoke coverage, and architecture boundaries proving no draft-roadmap promotion, execution-token issuance, live execution, remote CI triggering, provider execution, deletion, capture, translation execution, npm publication, artifact-root migration, legacy alias removal, shell execution, or MCP write/execute expansion. Browser smoke tests are not required for Phase 60.1 unless browser runtime behavior changes.

Phase 61-64 adds no-browser coverage for `operation contracts`, scope/operation selection, risk taxonomy contracts, gate schema shapes, execute-token shape, receipt shape, schema parity, API exports, safe MCP read-only inspection, unsupported execution-option rejection, package smoke coverage, and architecture boundaries proving no token issuance, receipt writing, execution harness enablement, live execution, artifact writes, provider execution, deletion, capture, translation execution, package publication, artifact-root migration, legacy alias removal, shell execution, or MCP write/execute expansion. Browser smoke tests are not required for Phase 61-64 unless browser runtime behavior changes.

Phase 65-68 adds no-browser coverage for `operation policy`, repository-local admin policy config, scope/operation selection, CLI plan readiness, disabled harness readiness, safe MCP readiness inspection, schema parity, API exports, unsupported execution-option rejection, package smoke coverage, and architecture boundaries proving no policy mutation, token issuance, receipt writing, execution harness enablement, admin MCP execution, live execution, artifact writes, provider execution, deletion, capture, translation execution, package publication, artifact-root migration, legacy alias removal, shell execution, or MCP write/execute expansion. Browser smoke tests are not required for Phase 65-68 unless browser runtime behavior changes.

Phase 69-70 adds no-browser coverage for `operation admin-readiness`, MCP admin execute-token flow readiness, MCP admin harness bridge readiness, scope/operation selection, admin policy requirement propagation, safe MCP readiness inspection, schema parity, API exports, unsupported execution-option rejection, package smoke coverage, and architecture boundaries proving no token issuance, token storage, receipt writing, execution harness enablement, admin MCP execution, live execution, artifact writes, provider execution, deletion, capture, translation execution, package publication, artifact-root migration, legacy alias removal, shell execution, or MCP write/execute expansion. Browser smoke tests are not required for Phase 69-70 unless browser runtime behavior changes.

Agentic Human Review roadmap Slice 34-42 adds no-browser coverage for `agentic review propose`, `agentic review plan --proposal`, `agentic review provider-readiness`, approved generic API provider execution through `agentic review run`, `agentic review report-quality`, proposal-hash validation, package-hash validation, exact transfer-flag validation for every externally transferable evidence class, role/claim/critique/rebuttal/integration/dogfood/report-quality metadata, provider adapter isolation, credential sentinel non-disclosure, schema registry/file parity, API exports, operation registry/capability exclusions, MCP tool non-exposure, architecture boundaries, product security checks, and packed-install file/API/schema/MCP coverage. Slice 26-33 coverage remains in place for `agentic review plan/run/status/list`, effort-mode role orchestration, plan-hash validation, tampered-plan rejection, fake provider advisory normalization, injected runner redaction, and generic `agent execution` bypass rejection. AHR-01-12 strengthening adds no-browser coverage for `human_review_schema_version` v2 fields, explicit human-review dimensions, provider instruction contracts, review-quality benchmark contracts, technical evidence and mechanical review summaries, reader-experience review, mechanical-versus-human comparison, human-review coverage/actionability scores, plan validation in provider readiness, result/execution validation in report-quality, conflicting proposal input rejection, provider payload path minimization, and non-loopback HTTP endpoint rejection. Browser smoke tests are not required unless browser runtime behavior changes.

AHR-13-24 adds no-browser coverage for provider capability snapshots and drift rejection, endpoint URL credential/query/redirect hardening, evidence plans that separate visual references from raw pixel bytes, page-type rubric profiles, benchmark case list/show, fixture-aware calibration diagnostics, direct-vs-TraceCue comparison, orchestration v2 contracts, role instruction contracts, consensus/dissent analysis, review-quality evaluator v2, privacy/disclosure audit metadata, provider payload allowlist checks, schema registry/file parity, API exports, packed-install coverage, and continued MCP non-exposure. Live provider dogfood remains manual and env-only; CI uses fake/injected provider seams.

Phase 71-78 add no-browser coverage for `operation provider-readiness`, provider MCP planning, bounded disclosure contracts, env credential guard names, admin-only fake/local/API agent execution exposure, safe MCP status/list contract metadata, scope/operation selection, operation capability-id alias canonicalization, safe MCP readiness inspection, schema parity, API exports, unsupported execution/provider-option rejection, credential sentinel non-disclosure, package smoke coverage, and architecture boundaries. Phase 74-76 coverage proves stdio admin MCP can run fake, local-runner, and injected-fetch API execution through the existing Phase 29 plan/run path while safe/full/HTTP remain non-execution, unknown credential arguments are rejected, idempotency keys are hashed, workspace realpath escape is blocked, credential values are not emitted, and raw provider responses are not stored. Browser smoke tests are not required unless browser runtime behavior changes.

Agentic Human Review Responses adapter coverage adds no-browser tests for request conversion, provider `store: false`, provider tools disabled, adapter token/provider credential separation, local path stripping, raw pixel rejection, non-loopback Host rejection, missing bearer rejection, unsafe provider endpoint rejection, provider output-text parsing, single-candidate JSON wrapper recovery, invalid and ambiguous output rejection, benchmark record schema constraints, forbidden-claim absence normalization, unknown evidence-reference rejection, API exports, pack-install file coverage, architecture isolation, and product security allowlisting. Regression coverage must prove direct JSON, JSON-string encoded objects, single JSON fences, and prose-wrapped single JSON objects parse in memory while malformed JSON, multiple candidates, non-JSON fences, arrays, primitives, and non-advisory objects fail closed; a repair-path test must prove a repaired advisory wrapped in provider formatting still reaches normal post-validation without leaking raw `output_text`, credentials, endpoint strings, or local paths. Generic API provider timeout override coverage verifies env-only positive-integer configuration, provider-readiness disclosure, capability-hash drift rejection, and unchanged credential/raw-response/MCP boundaries. Live upstream calls remain manual-only and are not part of CI.

Agentic Human Review quality-gate foundation coverage adds no-browser tests for structured benchmark requirement coverage in provider instructions and normalized advisory results, strict calibration scoring from evidence-backed requirement records, deterministic fake-provider structured findings with local evidence references, synthetic baseline non-verification, text-only owner-label match rejection, owner-baseline contract propagation through proposal/plan/provider payload/adapter validation/comparison, `risk_and_misleading_content` dimension coverage, report-quality benchmark and evaluator-policy warnings, evidence-set validation/summary, evidence-set alias inputs, supported CLI runtime-result wrapper inputs for calibration/comparison/human-baseline artifacts, evidence-set origin and claim-numerator eligibility metadata, owner-labeled human baseline registry/overlay/draft/approval/validation/comparison/claim-readiness, batch comparison, xhigh round planning and simulation, source-text effort-matrix verification, longitudinal quality rollups, claim policy/audit diagnostics, claim-standard-gate pass/fail state, incomplete evidence blockers, permissive-policy rejection, unsupported-option rejection, workspace confinement, read-only `--execute` rejection, schema registry/file parity, API exports, packed-install schema resolution, and continued no-provider-call, no-credential-value-read, no-artifact-write, no-MCP-exposure, no-deterministic-review-mutation, no-release-gate-mutation boundaries.

Phase 120-125 add no-browser coverage for `release readiness`, package metadata/provenance/2FA/publication boundary reporting, package smoke coverage, and fail-closed no-publish boundaries. Phase 126-133 add no-browser coverage for artifact-root policy/status/migration planning, dual-root compatibility, future-root metadata, fixture-confined migration boundaries, schema parity, API exports, safe MCP status inspection, and no real migration. Phase 134-139 add no-browser coverage for `identity aliases`, `identity aliases removal-readiness`, fail-closed `identity aliases remove --execute`, legacy alias compatibility retention, schema/API/MCP exposure, and no alias removal.

Phase 140-148 add no-browser coverage for `shell readiness`, `shell plan`, fail-closed `shell run --execute`, use-case/threat/schema/readiness metadata, safe MCP readiness inspection, and architecture boundaries that prevent child-process imports, shell interpreters, environment value reads, credential reads, file mutation, network access, and MCP shell execution. Phase 149-155 add no-browser coverage for `final readiness`, cross-feature regression matrix metadata, local gate-plan metadata with `executed_by_report=false`, safe MCP readiness inspection, and no browser launch, no remote CI, no Git mutation, no publication, no provider call, no artifact migration, no alias removal, no shell execution, and no product-doc promotion.

```bash
node ./bin/trace-cue.js settings language --json
node ./bin/trace-cue.js settings language policy --json
node ./bin/trace-cue.js operation registry --json
node ./bin/trace-cue.js operation roadmap --json
node ./bin/trace-cue.js operation contracts --json
node ./bin/trace-cue.js operation policy --json
node ./bin/trace-cue.js operation admin-readiness --json
node ./bin/trace-cue.js operation provider-readiness --json
node ./bin/trace-cue.js release readiness --json
node ./bin/trace-cue.js artifact-root status --json
node ./bin/trace-cue.js artifact-root migration plan --json
node ./bin/trace-cue.js identity aliases --json
node ./bin/trace-cue.js identity aliases removal-readiness --json
node ./bin/trace-cue.js shell readiness --json
node ./bin/trace-cue.js shell plan --json
node ./bin/trace-cue.js final readiness --json
node ./bin/trace-cue.js resource status --json
node ./bin/trace-cue.js resource artifacts plan --json
node ./bin/trace-cue.js resource artifacts cleanup --dry-run --json
node ./bin/trace-cue.js agent surfaces list --json
node ./bin/trace-cue.js agent package --review-index .browser-debug/review-artifacts/<id>.json --json
node ./bin/trace-cue.js agent requests list --json
node ./bin/trace-cue.js agent requests show --package .browser-debug/agent-packages/<id>/packet.json --json
node ./bin/trace-cue.js agent workflow create --package .browser-debug/agent-packages/<id>/packet.json --json
node ./bin/trace-cue.js agent workflow status --workflow .browser-debug/agent-workflows/<id>/workflow.json --json
node ./bin/trace-cue.js agent workflow index --json
node ./bin/trace-cue.js agent workflow report --workflow .browser-debug/agent-workflows/<id>/workflow.json --json
node ./bin/trace-cue.js agent execution plan --package .browser-debug/agent-packages/<id>/packet.json --surface local-subscription-agent --provider fake-agent --model fake-model --json
node ./bin/trace-cue.js agent execution run --execution .browser-debug/agent-executions/<id>/execution.json --package .browser-debug/agent-packages/<id>/packet.json --surface local-subscription-agent --provider fake-agent --model fake-model --execute --json
node ./bin/trace-cue.js agent execution status --execution .browser-debug/agent-executions/<id>/execution.json --json
node ./bin/trace-cue.js agent execution list --json
node ./bin/trace-cue.js playwright-test status --json
node ./bin/trace-cue.js playwright-test mode --mode import_only --confirm set-playwright-test-mode --json
node ./bin/trace-cue.js playwright-test import --input test-results/results.json --confirm import-playwright-test-result --json
node ./bin/trace-cue.js playwright-test review-material --result <result-id-or-json-path> --json
node ./bin/trace-cue.js playwright-test local plan --json
node ./bin/trace-cue.js playwright-test local run --plan <plan-json> --plan-hash <sha256> --execute --json
node ./bin/trace-cue.js playwright-test external-ci list --repo owner/repo --json
node ./bin/trace-cue.js playwright-test external-ci fetch --repo owner/repo --run-id <number> --artifact-name <name> --confirm fetch-playwright-test-ci-artifact --execute --json
node ./bin/trace-cue.js playwright-test external-ci approve-settings --repo owner/repo --workflow-name CI --branch main --artifact-name playwright-report --confirm approve-playwright-test-ci-settings --json
node ./bin/trace-cue.js playwright-test external-ci resolve-approved --json
node ./bin/trace-cue.js playwright-test external-ci fetch-approved --confirm fetch-approved-playwright-test-ci-artifact --execute --json
node ./bin/trace-cue.js agentic review propose --brief "Review first impression, UI/UX, content comprehension, trust, and likely viewer feeling." --review-index .browser-debug/review-artifacts/<id>.json --effort standard --json
node ./bin/trace-cue.js agentic review plan --proposal .browser-debug/agentic-human-review-proposals/<id>/proposal.json --json
node ./bin/trace-cue.js agentic review provider-readiness --plan .browser-debug/agentic-human-review-plans/<id>/plan.json --json
node ./bin/trace-cue.js agentic review run --plan .browser-debug/agentic-human-review-plans/<id>/plan.json --plan-hash <sha256> --allow-raw-pixels --allow-page-text --execute --json
node ./bin/trace-cue.js agentic review report-quality --result .browser-debug/agentic-human-review-results/<id>/result.json --json
node ./bin/trace-cue.js agentic review evidence-set validate --input <agentic-evidence-set> --json
node ./bin/trace-cue.js agentic review evidence-set summarize --input <agentic-evidence-set> --json
node ./bin/trace-cue.js agentic review evidence-set regenerate plan --evidence-set <agentic-evidence-set> --claim-gate <claim-standard-gate> --json
node ./bin/trace-cue.js agentic review human-baseline registry --json
node ./bin/trace-cue.js agentic review human-baseline overlay --case <benchmark-case-id> --json
node ./bin/trace-cue.js agentic review human-baseline draft --overlay <case-overlay-json> --json
node ./bin/trace-cue.js agentic review human-baseline approval --draft <baseline-draft-json> --decision approved --approver <owner-id> --approved-at <iso8601> --edit-diff <summary> --json
node ./bin/trace-cue.js agentic review human-baseline validate --input <owner-labeled-human-baseline> --json
node ./bin/trace-cue.js agentic review human-baseline compare --baseline <owner-labeled-human-baseline> --result .browser-debug/agentic-human-review-results/<id>/result.json --json
node ./bin/trace-cue.js agentic review human-baseline claim-readiness --evidence-set <agentic-evidence-set> --json
node ./bin/trace-cue.js agentic review status --execution .browser-debug/agentic-human-review-results/<id>/execution.json --json
node ./bin/trace-cue.js agentic review list --json
npm run ahr:responses-adapter -- --json
node ./bin/trace-cue.js visual review prepare --review-index .browser-debug/review-artifacts/<id>.json --json
node ./bin/trace-cue.js visual review dashboard --json
node ./bin/trace-cue.js agent ingest --package .browser-debug/agent-packages/<id>/packet.json --input @agent-advisory-result.json --json
node ./bin/trace-cue.js agent report --review-index .browser-debug/review-artifacts/<id>.json --agent-result .browser-debug/agent-results/<id>.json --json
node ./bin/trace-cue.js observe --url http://127.0.0.1:3000/ --screenshot --trace --timeout 15000 --json
node ./bin/trace-cue.js supervise --url http://127.0.0.1:3000/ --actions '[{"type":"observe"}]' --timeout 15000 --json
node ./bin/trace-cue.js session start --url http://127.0.0.1:3000/login --headed --manual-checkpoint login --ttl 30m --idle-timeout 10m --json
node ./bin/trace-cue.js session status --session <id> --json
node ./bin/trace-cue.js session act --session <id> --action '{"type":"click","selector":"text=Continue"}' --json
node ./bin/trace-cue.js session observe --session <id> --screenshot --json
node ./bin/trace-cue.js session checkpoint --session <id> --name logged-in --until-url "*/dashboard" --until-selector "[data-testid=dashboard]" --json
node ./bin/trace-cue.js session review --session <id> --screenshot --report --json
node ./bin/trace-cue.js session stop --session <id> --json
node ./bin/trace-cue.js daemon start --url http://127.0.0.1:3000/ --timeout 15000 --json
node ./bin/trace-cue.js daemon status --daemon <id> --json
node ./bin/trace-cue.js daemon stop --daemon <id> --json
node ./bin/trace-cue.js target init --url http://127.0.0.1:3000/ --json
node ./bin/trace-cue.js target validate --target .browser-debug/targets/<id>.json --json
node ./bin/trace-cue.js review --url http://127.0.0.1:3000/ --viewport mobile --screenshot --report --timeout 15000 --json
node ./bin/trace-cue.js review --url http://127.0.0.1:3000/ --resource-guard fail-critical --timeout 15000 --json
node ./bin/trace-cue.js review --target .browser-debug/targets/<id>.json --report --timeout 15000 --json
node ./bin/trace-cue.js schema list --json
node ./bin/trace-cue.js schema get --name review --json
node ./bin/trace-cue.js mcp serve --profile safe --json
node ./bin/trace-cue.js mcp serve --transport http --profile safe --host 127.0.0.1 --port 0 --json
node ./bin/trace-cue.js mcp config --profile safe --json
node ./bin/trace-cue.js mcp config --transport http --profile safe --host 127.0.0.1 --port 8765 --json
node ./bin/trace-cue.js mcp capabilities --profile admin --scope excluded --json
node ./bin/trace-cue.js mcp execution gates --json
node ./bin/trace-cue.js capture plan --json
node ./bin/trace-cue.js capture readiness --json
node ./bin/trace-cue.js capture handoff --image <workspace-image> --source screen --json
node ./bin/trace-cue.js visual review plan --capture-handoff <capture-handoff-json> --json
node ./bin/trace-cue-mcp.js --profile safe
TRACE_CUE_MCP_HTTP_TOKEN=<token> node ./bin/trace-cue-mcp.js --transport http --profile safe --host 127.0.0.1 --port 8765
```

Optional acceptance checks against local application control surfaces should run only when their local URLs are provided and listening.

## Planned Review Platform Checks

Phase 7 review-platform implementation includes focused checks before any release claim:

- Parser tests for `review --url`, `review --target`, `schema list`, `schema get`, and MCP adapter entrypoints.
- Schema tests for envelopes, artifacts, findings, target manifests, review results, and MCP tool metadata.
- No-browser unit tests for target manifest validation, viewport matrix expansion, action risk classification, redaction, shell-safe action input, and MCP tool output shape.
- Architecture tests that prevent application-specific runtime literals, persistent browser profile reuse, unapproved storage-state persistence outside the explicit artifact-auth opt-in, unapproved listeners, arbitrary shell execution, unapproved upload paths, and cleanup outside the configured artifact root.
- Browser smoke fixture tests for console errors, empty renders, horizontal overflow, clipped text, missing accessible names, nonblank screenshots, route coverage, viewport coverage, and local artifact placement.
- Mock comparison tests for local metrics and dimension mismatch `inconclusive` behavior.
- MCP adapter tests for stdio compatibility behavior, safe HTTP loopback/token boundaries, tool allowlists, schema-compatible responses, no shell tool, no cleanup execution tool, and no external upload by default.
- Resource status tests for no-browser local memory, swap, cgroup, pressure, process memory, warning/recommendation output, MCP wiring, and read-only host boundaries.
- Resource guard and artifact safety tests for advisory/fail-critical review output, daemon lifecycle metadata, artifact usage planning, explicit cleanup receipts, no MCP cleanup execution, and `.browser-debug/`-scoped deletion only.

Optional acceptance checks against local application servers may run only when those servers are listening. Those checks should use target manifests or fixtures and should not introduce product-specific branches into the runtime.

## Phase 8 Dogfood and Plugin Checks

- No-browser tests cover `target init`, generated manifest shape, MCP target tools, and plugin metadata boundaries.
- Browser smoke tests cover enriched findings, `action_plan`, `review_advisory`, target review reports, and route/viewport coverage artifacts.
- Architecture tests verify `.codex-plugin/plugin.json`, `.mcp.json`, and `skills/browser-debug-review/SKILL.md` stay local and keep the packaged MCP config stdio-based.
- Plugin validation should pass with the local plugin validator before publication or marketplace work is proposed.
- Package dry-run verification must include plugin metadata, the plugin-facing skill, and the reusable target manifest template without publishing.

## Phase 9 Review Quality Checks

- Browser smoke tests cover `quality_signals` in single-URL and target review output.
- Browser smoke tests cover image alt text findings, low contrast findings, visible overlap findings, local release readiness, and disabled model-review boundaries.
- Markdown report smoke coverage verifies that the Quality Signals section is present.
- Architecture tests continue to block target-specific runtime branches, existing-profile reuse, unapproved storage-state persistence outside the explicit artifact-auth opt-in, unapproved listeners, arbitrary shell execution, unapproved upload paths, and cleanup outside the configured artifact root.

## Phase 10 Dogfood Route Checks

- Browser smoke tests cover unlinked manifest `expectedRoutes` being visited as explicit review targets.
- Browser smoke tests cover `coverage.routes.expected` and `quality_signals.route_coverage.expected_manifest_routes`.
- Browser smoke tests cover `route_budget_exceeded` skipped routes when `budgets.maxRoutes` prevents full coverage.
- These checks use local fixture pages so they do not depend on a specific application, framework, localhost port, route name, or UI label.

## Phase 11 Page Expectation Checks

- No-browser tests cover optional manifest `pages` normalization, page priority normalization, page-specific viewport merging, and generated manifests with empty `pages`.
- Browser smoke tests cover expected visible text, missing expected selectors, page-specific mobile viewport execution, page-level mock metrics, `coverage.pages`, `quality_signals.page_expectations`, local `review_artifact_index` artifacts, and Markdown report page expectation output.
- These checks use local fixture pages and do not depend on a specific application, framework, localhost port, route name, or UI label.

## Phase 12 Rendered-State Dogfood Checks

- Browser smoke tests cover broken visible images, visible loading indicators that remain after the review wait, and empty table/list/grid containers without visible empty-state messaging.
- Browser smoke tests cover `quality_signals.rendered_state`, `evidence_summary.loading_indicators`, `evidence_summary.empty_containers`, Developer Triage Markdown report output, and target `manifest_suggestions`.
- These checks use local fixture pages and do not depend on a specific application, framework, localhost port, route name, or UI label.

## Phase 13 Dogfood Signal Refinement Checks

- Browser smoke tests cover normal ready/progress business-state text and verify it is not reported as lingering loading UI.
- Loading indicator evidence remains limited to explicit loading semantics, loading-like attributes, roles, or short status text rather than arbitrary ancestor text.
- These checks use local fixture pages and do not depend on a specific application, framework, localhost port, route name, or UI label.

## Phase 14 Content UX Advisory Checks

- No-browser tests cover schema registry/file property parity for review and target manifest schemas.
- No-browser tests cover target manifest `sourceData`, `localContentUxAdvisory`, and page `expectations.dataBindings` normalization.
- No-browser tests cover pure content UX advisory source-to-screen matching and verify source values are not copied into advisory JSON.
- Architecture tests verify the advisory module has no Playwright import, filesystem import, target-specific literals, external control channel, arbitrary shell execution, upload path, or cleanup path.
- Browser smoke tests cover manifest opt-in advisory output, `quality_signals.content_ux`, bounded Markdown report output, and unchanged review findings, `metrics.finding_count`, the existing `action_plan`, and `quality_signals.release_readiness`.
- These checks use local fixture pages and do not depend on a specific application, framework, localhost port, route name, or UI label.

## Phase 15 Content UX Heuristic Checks

- No-browser tests cover selector-scoped text, explicit attribute, state attribute, and risk attribute advisory checks.
- No-browser tests cover `localContentUxAdvisory.requiredUserQuestions` and page `expectations.userQuestions`.
- Browser smoke tests cover real Playwright element evidence for selector-scoped content UX advisory checks.
- Browser smoke tests continue to prove enabled advisory output does not change review findings, `metrics.finding_count`, the existing `action_plan`, or `quality_signals.release_readiness`.
- These checks use local fixture pages and reusable templates instead of runtime branches for a specific application, framework, localhost port, route name, or UI label.

## Phase 16 Content UX Handoff Checks

- No-browser tests cover separate `content_ux_findings`, `content_ux_action_plan`, and `content_ux_readiness` generation from local advisory signals.
- No-browser tests verify content UX handoff output does not copy source values.
- Browser smoke tests verify disabled manifests omit all top-level `content_ux_*` handoff outputs.
- Browser smoke tests verify enabled manifests emit top-level `content_ux_*` handoff outputs and Content UX Developer Handoff report output.
- Browser smoke tests continue to prove enabled advisory output does not change review findings, `metrics.finding_count`, the existing `action_plan`, or `quality_signals.release_readiness`.

## Phase 17 Content UX Practical Handoff Checks

- No-browser tests cover expanded advisory categories for status clarity, action clarity, navigation clarity, information architecture, coverage contracts, and content contracts.
- No-browser tests cover `content_ux_page_handoff` grouping by manifest page.
- No-browser tests cover `content_ux_manifest_authoring` suggestions for missing user questions, next-action contracts, and navigation contracts.
- Browser smoke tests verify enabled manifests emit `content_ux_page_handoff` and `content_ux_manifest_authoring`.
- Browser smoke tests verify Content UX Developer Handoff reports include page and manifest-authoring summary lines.
- Browser smoke tests continue to prove enabled advisory output does not change review findings, `metrics.finding_count`, the existing `action_plan`, or `quality_signals.release_readiness`.

## Phase 18 Content UX Review Brief Checks

- No-browser tests cover manifest page `role`, `localContentUxAdvisory.reviewBrief`, and `localContentUxAdvisory.rubric` normalization.
- No-browser tests cover `content_ux_review_brief` and `content_ux_rubric_evaluation` output while preserving source-value non-disclosure.
- Browser smoke tests verify disabled manifests omit the new review brief and rubric outputs.
- Browser smoke tests verify enabled manifests emit `content_ux_review_brief`, `content_ux_rubric_evaluation`, and Content UX Review Brief report output.
- Browser smoke tests continue to prove enabled advisory output does not change review findings, `metrics.finding_count`, the existing `action_plan`, or `quality_signals.release_readiness`.

## Phase 20 Resource Status Checks

- No-browser tests cover `resource status` parser/runtime behavior with injected local memory, cgroup, and pressure fixtures.
- No-browser tests cover MCP `browser_debug_resource_status` wiring and local API exports.
- Architecture tests verify the resource status module has no Playwright import, no child process use, no external listener, no profile reuse, no storage persistence, no file deletion path, and explicit host-mutation false boundaries.
- `resource status` output is advisory preflight data only; it does not change review findings, `metrics.finding_count`, existing `action_plan`, or `quality_signals.release_readiness`.

## Phase 21-24 Resource Safety Checks

- No-browser tests cover `review --resource-guard fail-critical` stopping before browser launch when resource status is critical.
- No-browser tests cover `resource artifacts plan`, `resource artifacts cleanup --dry-run`, and `resource artifacts cleanup --execute` with local receipts.
- No-browser tests cover MCP `browser_debug_resource_artifacts_plan` while preserving the no-cleanup-tool MCP boundary.
- No-browser tests cover cleanup plan hashes, candidate content-hash locks, optional CLI plan-hash mismatch rejection, pre-delete lock enforcement, no directory deletion, MCP execute-argument rejection, and symlink/root realpath confinement.
- Architecture tests verify resource guard and resource artifacts helpers avoid Playwright imports, shell execution, external listeners, profile reuse, host cache/swap mutation, external upload, privileged helpers, arbitrary process control, and cleanup outside the configured artifact root.
- Resource guard output is additive and does not change review findings, `metrics.finding_count`, existing `action_plan`, or `quality_signals.release_readiness`.

## Phase 25 Agent Advisory Handoff Checks

- No-browser tests cover `agent surfaces list`, `agent package`, `agent ingest`, and `agent report` parser/runtime behavior.
- Schema parity tests cover `agent_surface`, `agent_task_package`, `agent_request_status`, `agent_request_detail`, `agent_workflow`, `agent_advisory_result`, and `agent_disclosure_policy`.
- No-browser tests verify packages include only bounded metadata and local artifact references by default, with raw artifact content excluded.
- No-browser tests verify imported agent advisory output stays separate from review `findings`, `metrics.finding_count`, existing `action_plan`, and `quality_signals.release_readiness`.
- Architecture tests verify the agent advisory module has no Playwright import, provider API call, external listener, shell execution, profile reuse, unapproved storage-state persistence outside the explicit artifact-auth opt-in, automatic upload, credential storage, MCP agent execution, or review artifact mutation path.

## Phase 29 Agent Execution Checks

- Parser tests cover `agent execution plan`, `agent execution run`, `agent execution status`, `agent execution list`, required package/surface/provider/model options, missing `--execute`, unknown provider/model values, and conflict handling.
- Schema parity tests cover a new `agent_execution` schema without breaking existing `agent_workflow`, `agent_advisory_result`, review, resource, daemon, or artifact cleanup schemas.
- No-browser tests cover dry-run plans, local receipts, execution status/list aggregation, missing package behavior, parser-level `--execute` enforcement, required `--execution`, deterministic fake provider success, configured local runner success, API missing-configuration blocking, injected API transport success, advisory-result normalization, and dashboard status/list fields.
- Credential tests verify provider credentials are read only from named environment variables and are never accepted through CLI args, stored in package artifacts, copied into workflow files, printed in JSON, written to reports, written to receipts, or loaded from `.env` automatically.
- Boundary tests verify raw screenshots, traces, DOM, console payloads, network payloads, sourceData values, report bodies, existing browser profile data, and raw provider responses are not transferred or stored by default.
- Invariance tests verify agent execution output does not change review `findings`, `metrics.finding_count`, existing `action_plan`, `quality_signals.release_readiness`, `resource_guard`, artifact cleanup behavior, or existing `agent_workflow` status meanings.
- Architecture tests verify provider calls live only in the dedicated provider adapter boundary and are reachable from MCP only through the approved stdio `admin` agent execution adapter path, never from review, resource, daemon, cleanup, or Playwright runtime modules.
- MCP tests verify safe/full/HTTP profiles do not expose `agent execution run`, stdio `admin` exposes only the approved plan/run tools, unknown MCP execution arguments are rejected, `execute: true` is required, idempotency keys are bounded, and package/execution/prompt reads remain workspace-confined.

## Phase 30 Packed Install Checks

- `npm run test:pack-install` creates a temporary install layout from the packed tarball under `/tmp`.
- The check verifies packaged `trace-cue`/`trace-cue-mcp` entrypoints, legacy `browser-debug`/`browser-debug-mcp` aliases, public package API imports, schema files, templates, plugin metadata, plugin skill, and selected workflow security docs.
- The check runs `doctor`, `schema list`, `target validate`, API import, and MCP `tools/list` from the packed layout.
- The check is local-only and does not publish, install from registry, change package naming, change license, upload evidence, store credentials, or mutate marketplace state.

## Phase 34 Safe HTTP MCP Checks

- No-browser tests cover `browser-debug mcp serve --transport http --profile safe --json` metadata without starting a listener.
- No-browser tests start the HTTP transport on a loopback ephemeral port with an injected bearer token and verify `tools/list` exposes only the safe profile.
- HTTP transport tests reject missing bearer tokens, non-loopback origins, non-POST methods, oversized bodies, non-safe profiles, and non-loopback bind hosts.
- Architecture tests verify `node:http`, `createServer`, and `listen` stay isolated to `src/mcp-http-transport.js`.
- Security checks allow only the approved safe HTTP transport module to create a listener and continue to block unapproved listeners elsewhere.
- Packed install smoke checks verify the HTTP transport files and package API transport exports are present without changing publication, package naming, license, marketplace, or external evidence boundaries.

## Phase 35 HTTP MCP Integration Checks

- No-browser tests cover `browser-debug mcp config --json` and `browser-debug mcp config --transport http --profile safe --json` output without starting a listener.
- No-browser tests verify generated config defaults to safe profile, emits no token values, provides reusable installed-bin and local-checkout stdio/safe HTTP metadata, and rejects HTTP `full` or `admin`.
- Packed install smoke creates the installed package API safe HTTP handler and completes an authenticated `initialize` request without binding a port.
- Packed install smoke verifies local-checkout MCP metadata resolves to the installed package entrypoint without requiring npm publication or registry install.
- Architecture tests verify MCP client configuration helpers do not import `node:http`, call `createServer`, or call `listen`.

## Phase 36 MCP Capability Policy Checks

- No-browser tests cover `browser-debug mcp capabilities --profile admin --scope excluded --json` and verify the report distinguishes approved stdio `admin` agent execution plan/run exposure from cleanup execution, unrelated provider/API execution, shell, daemon/session, and HTTP `full` or `admin` boundaries that remain false.
- No-browser tests verify `browser-debug mcp capabilities --profile safe --scope profiles --json` reports the safe profile without exposing browser-launching review tools.
- MCP adapter tests expose `browser_debug_mcp_capabilities` through the safe profile and confirm the tool returns the same read-only policy report.
- Architecture tests verify the capability policy helper does not import `node:http`, call `createServer`, or call `listen`.
- Packed install smoke verifies the source file, package API exports, CLI command, and MCP tool remain available from the installed package layout without publishing.

## Phase 51-52 Desktop Image Review Checks

- No-browser tests cover `capture handoff --image`, `review --image --capture-handoff`, path mismatch errors, hash mismatch errors, and provenance propagation into visual evidence metadata.
- No-browser tests verify `visual review prepare` preserves `desktop_app_capture` source kind from reviewed image evidence.
- Parser tests verify `--capture-handoff` and `--source` are accepted only with `review --image`.
- Boundary tests verify desktop image review does not perform OS capture, enumerate windows or processes, call providers, embed raw pixels in JSON, transfer evidence, expose MCP execution, or mutate browser review behavior.

## Phase 53-55 Visual Review Aggregation Checks

- No-browser tests cover `visual review aggregate --preparation`, source-attributed aggregation findings, corroborated findings, severity conflicts, owner decision requests, source effects, malformed artifact warnings, parser conflicts, and package API parity.
- Architecture tests verify `src/visual-review-aggregation.js` is read-only, provider-free, raw-pixel-free, Playwright-free, shell-free, listener-free, and MCP-free.
- Schema parity tests cover `visual_review_aggregation`.
- MCP tests verify no `browser_debug_visual_review_aggregate` tool is exposed through safe/full/admin profiles.
- MCP capability and execution gate tests report `visual_review_aggregation` as currently excluded and gated by no-artifact-write, no-provider-call, no-raw-pixel, untrusted-output-bounding, and source-attribution requirements.
- Packed install smoke verifies the aggregation module, schema, package API exports, schema resolution, and MCP non-exposure from the installed layout.

## Agentic Human Review AHR-41-44 Checks

- No-browser tests cover `xhigh` mechanical effort contracts in provider capability snapshots, approved plans, provider payloads, advisory normalization, report-quality output, and schema registry output.
- Responses adapter tests cover native effort binding for compatible providers, strict structured-output validation, placeholder-output rejection, missing role/round/synthesis rejection, structured benchmark coverage requirements, catalog-backed evidence references, forbidden-claim absence semantics, and local evidence-reference preservation before advisory normalization.
- Evidence-set, human-baseline comparison, claim-readiness, calibration, and longitudinal-quality tests cover strict claim-numerator exclusion when an `xhigh` result lacks mechanical completion, evidence-reference-backed benchmark records, supported CLI/API runtime-result wrapper aggregation, raw run-wrapper result rejection, or case/effort-aligned comparison coverage.
- No-browser tests cover Responses adapter benchmark-enabled output contracts, exact benchmark coverage record guidance, structured advisory findings, evidence-reference identifiers, unknown evidence-reference rejection, provider alias normalization, and continued no-credential/no-local-path/no-raw-response boundaries.
- Evidence-set and claim-readiness tests cover explicit required benchmark-case by effort matrix reporting, duplicate-result insufficiency, missing result blockers, mechanical-incomplete blockers, failed-calibration blockers, missing comparison blockers, missing case-level `direct-vs-tracecue` comparison diagnostics, weak calibration blocking, and text-only owner-label matches remaining insufficient evidence.
- Claim-standard-gate tests cover incomplete evidence-set exit status, owner claim-review ready pass state, human-equivalent and human-superior claim states remaining false, permissive raw policy rejection, unsupported-option rejection, workspace confinement, schema parity, API export, packed-install schema resolution, and MCP non-exposure.
- No-browser CLI tests cover live dogfood opt-in rejection before provider fetch, unknown benchmark-case rejection, visible-text provenance in packages, and transfer-flag masking for plan-level and package-level provider payload sections.
- No-browser CLI tests cover fake-provider complete `xhigh` output and injected-runner incomplete `xhigh` output with missing role/round/critique/synthesis diagnostics.
- Report-quality, benchmark list/show, calibration, execution, result, and package artifacts expose benchmark-completion readiness without mutating deterministic findings, metrics, release gates, MCP exposure, credential storage, or raw provider response storage.
- Report-quality exposes `human_review_maturity` and `longitudinal_quality_evaluation`, including missing standard/deep/xhigh evidence, missing benchmark cases, comparison/history requirements, and explicit false human-equivalent/human-superior claim flags.
- Dogfood readiness and dogfood plan expose a standard/deep/xhigh maturity plan and benchmark-case matrix without executing providers, writing artifacts, reading credentials, or authorizing external transfer.
- Provider readiness and dogfood readiness remain non-executing; real provider dogfood still runs only through `agentic review run` with matching plan hash, package hash validation, provider capability hash, exact transfer flags, explicit `--execute`, and manual live dogfood opt-in when benchmark/dogfood provider API execution is requested.

## Agentic Human Review Content Evidence And Localized Report Checks

- No-browser tests cover `agentic review propose` and `agentic review plan` with optional `--content-evidence` plus compatibility `--video-evidence`, normalized path-free supplemental content evidence, additive content-evidence scope fields, advisory-result content evidence propagation, report-quality content-understanding diagnostics, and source-attributed editorial synthesis records whose full review text uses bounded content summaries, excerpt units, claims, and limitations before generic run summaries when content evidence is usable.
- No-browser tests cover the generic source-type matrix for `video`, `web_page`, `pdf`, `meeting_notes`, `document`, `transcript`, and `other` through plan, run, advisory-result, and Markdown report generation, including localized source-type display labels, canonical source-type preservation, bounded-evidence density, and content-review-strength guidance, so content review is not tied to one analyzer, target site, URL, repository, provider, model, or file path.
- No-browser tests reject content evidence artifacts that contain raw media, raw binaries, base64/blob/data URI payloads, raw HTML/PDF bytes, full documents, full transcripts, or truthy raw/full privacy and boundary declarations, while allowing bounded `content_units` and explicit false-valued privacy or boundary metadata that declares raw/full content is absent.
- No-browser tests cover `agentic review quality source-text` over standard/deep/xhigh source-text result artifacts, including source-understanding completion, full-source/chunk-text non-persistence, same-source identity confirmation, identity mismatch and identity-unavailable diagnostics, source-reading/source-understanding source id mismatch diagnostics, raw source/chunk alias persistence diagnostics, output-safety non-leakage flags, pairwise effort deltas, xhigh critique readiness, optional reference-review comparison without prose leakage or reference-metadata false positives, schema/API/package coverage, and read-only `--execute` rejection.
- No-browser tests cover source-text quality artifacts as downstream `owner_review_context.source_text_quality`, including supported CLI/API wrapper intake, evidence-set baseline-vs-context gate neutrality, forged downstream context re-sanitization, unsafe diagnostic-code fallback, unsafe provider/proof/claim/release/artifact-write/rerun authority-flag neutralization, unchanged evidence-set warnings, unchanged claim-readiness conditions, unchanged claim-standard blockers and pass state, longitudinal propagation, evidence-regeneration invalidation by effort without concrete rerun execution, unreadable and invalid artifact context diagnostics, misplaced result rejection, stale effort detection, schema/package discovery for the owner-context contract, and suppression of paths, private identity values, raw hashes, source text, chunk text, candidate prose, reference prose, credential-like sentinels, warnings, blockers, conditions, passed states, and claim states.
- Provider payload tests verify video summaries and generic supplemental content evidence are included only through existing transfer approval, and local paths, source URLs, source locators, raw media, raw frames, raw HTML/PDF bytes, full transcripts, provider credentials, and raw provider responses remain absent.
- Report-template tests verify TraceCue-owned Agentic Human Review headings, labels, fallback text, composer connective text, source-type display labels, source-text preservation explanations, effort-stance text, and evidence-scope lines resolve through artifact output language settings while provider-authored advisory text and source evidence text remain preserved without translation execution.
- Schema and packed-install tests verify `content_evidence`, `video_evidence`, updated Agentic Human Review package, plan, advisory, report-quality, and localization resources remain discoverable from the packaged layout without publication.
- Product gates must keep this slice no-provider-call during planning, no-analyzer-call, no-remote-download, no-FrameCue-change, no-MCP-expansion, advisory-only, and release-gate-neutral.

## Release Readiness Checks

`CHANGELOG.md`, `.github/workflows/ci.yml`, `ops/CI_MANIFEST.tsv`, and `docs/workflow/RELEASE.md` are release-readiness files. They do not authorize publish actions. npm credentials, license changes, and `npm publish` remain approval-bound.

## Control Center Checks

- Latest prototype-alignment evidence: `site-review-2026-07-10T21-21-03-242Z-d0950f43` reviewed the Japanese Settings page at desktop 1440x980 and mobile 390x844 with screenshots; findings 0, failed routes 0, failed page expectations 0, data bindings 2/2, user questions 4/4, rubric 1/1, content UX passed, and local release gate passed.
- Purpose-led browser checks verify exactly three ordinary top-level destinations for `確認` (`confirm`), `進行中` (`running`), and `設定` (`settings`), plus five visible stages for `準備` (`prepare`), `確認` (`review`), `判断` (`decide`), `再確認` (`recheck`), and `完了` (`complete`).
- Settings browser checks verify the accepted prototype geometry and hierarchy: 760px desktop content width, system/Noto Sans JP font stack, 30px page title, 19px section title, 14px supporting copy, 48px selects, divider-based rows, one general-settings save action plus a contextual AI-choice apply action while editing, mobile stacking without overflow, and no cards, status badges, persistence paths, locale internals, diagnostics, regression-import/CI-policy forms, or trust-boundary badges.
- Effort-selection checks verify the approved purpose titles and short labels map exactly to `standard`, `deep`, and `xhigh`, the existing source-intake proposal payload preserves the selected canonical value, and the UI never describes proposal creation as provider execution, browser execution, review execution, or completion.
- No-regression checks freeze the existing eight action endpoint paths and confirmation/execute boundaries, prove no generic action endpoint was added, and exercise the retained source-intake, display-language, Playwright Test mode/import/external-CI suggestion/approval/fetch actions through their existing server contracts.
- Truthfulness checks fail if the ordinary client introduces timers, simulated percentages, sample findings, synthetic decisions, synthetic recheck results, or completion without structured local evidence. Proposal readiness, advisory-only state, missing evidence, unresolved blockers, and `gate_effect=none` alone must never render a completed workflow.
- Navigation and accessibility checks cover current-page semantics, keyboard-only access, focus movement after destination changes, 44-pixel minimum touch targets, 200 percent zoom, reduced motion, Japanese labels, RTL-compatible layout, 320/390/768/1024/1440-pixel viewports, no horizontal overflow, no clipped text, no fixed-navigation overlap, and detail-page return paths.
- Compatibility checks preserve Regression/Evidence/Findings/Advanced backend, CLI, API, read-model, and bounded-action contracts while allowing the ordinary Settings page to omit their technical displays.
- No-browser tests cover `control-center status --json`, parser rejection for execution-style options, read-only dashboard boundary flags, source-intake capability metadata, display-language metadata, Playwright Test regression metadata/action endpoints, schema registry export, source-status projection, and design-system component metadata.
- Server tests cover loopback-only startup, dashboard GET-only behavior, bounded local POST actions, `Cache-Control: no-store`, `/api/health`, `/api/dashboard`, `/api/source-intake/proposal`, `/api/settings/display-language`, Playwright Test mode/import/external-CI endpoints, JSON content-type enforcement, request-size limits, explicit confirmation tokens, workspace-confined source paths, fixed settings-path persistence, read-only fake `gh run list/download` success paths, non-loopback Origin rejection, non-loopback Host rejection, and missing-build asset handling.
- Control Center agentic-review tests cover persistent prepare/confirmation/start/status/decision/repeat/list state, concrete service disclosure, AI-disabled local review, browser authority-field rejection, hashed one-time nonce storage, plan/disclosure binding, duplicate-start rejection, normalized path/hash/provider/model/raw-response suppression, per-finding decisions, new-operation recheck/deeper, and restart recovery to `dispatch_unknown` without automatic retry.
- The Control Center Playwright smoke uses the built React/Vite application and real loopback HTTP APIs with deterministic injected TraceCue runners. It completes URL/purpose/effort preparation, work-area-centered send confirmation, one provider dispatch, normalized findings, initially unselected decisions, linked deeper review, display-language/viewport/Playwright/AI settings, immutable send confirmation, console-error checks, and 390px no-overflow checks.
- Final 2026-07-11 evidence: `npm test` passed 153 tests; `npm run test:browser` passed 14 tests; mock verification, `release:check`, packed install, all product repository checks, and `product-gate` passed. TraceCue target review `site-review-2026-07-10T23-42-44-565Z-9f5d68d1` covered Confirm list/new, In progress, and Settings at desktop/mobile, with zero findings, `quality_signals.status=passed`, `triage.status=passed`, and `local_release_gate=pass`.
- Architecture tests verify `src/control-center-read-model.js` stays free of HTTP listeners, Playwright, child-process APIs, provider fetches, writes, artifact-root creation, raw-pixel reads, and gate mutation; `src/control-center-actions.js` is limited to confirmed local proposal/settings writes, workspace-confined Playwright Test imports, and explicitly confirmed read-only external-CI artifact fetch wrappers without provider, shell, MCP, or browser authority; and `src/control-center-server.js` is the only listener module.
- Product security checks allowlist only `src/control-center-server.js` for the new listener pattern and continue to fail any unrelated `createServer`, `.listen`, WebSocket, or EventSource runtime addition.
- Vite build and browser smoke checks verify the React browser surface under `control-center/` can compile against `docs/design-system/tokens.json` and `docs/design-system/components.json`, render the concise Settings Playwright Test mode choice from built assets, omit detailed regression and approved-CI policy fields from ordinary settings, and keep `local_run` without a browser-run button.

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
- Target-specific application details remain in manifests, fixtures, or acceptance evidence, not generic runtime code.

## Document Synchronization Verification

- `npm run document-sync:contract-check` covers policy validation, bounded glob
  semantics, additive rule union, canonical/workflow pairing, sensitive AHR,
  MCP, session, evidence requirements, ignored memory/settings, rename/delete
  parsing, complete-range acceptance, invalid-base rejection, and safe hook
  installer behavior.
- `npm run document-sync:check` evaluates tracked and untracked worktree
  changes so local product gates catch missing synchronization before commit.
- CI checks exact event base/head ranges with full history. PR docs may be in a
  different commit from implementation; docs outside the integration range do
  not satisfy it. Missing or zero commits fail closed.
- `check_product_structure.sh`, `check_product_docs.sh`,
  `check_product_security.sh`, `check_product_ci.sh`,
  `check_product_design_system.sh`, and `product-mode check` remain lightweight
  contract gates in the dedicated job. Runtime/package/browser suites remain in
  their existing jobs.
- Browser smoke and a TraceCue self-review are regression evidence only for
  this non-UI slice; document-sync acceptance is determined by the policy,
  rejection tests, repository contracts, and product gate.

## Development Workflow Verification

- `npm run development-workflow:check` validates the current strict policy,
  instruction anchors, required repository files, registered test ids, and
  package scripts without interpreting instruction prose.
- `npm run development-workflow:contract-check` covers unknown fields,
  duplicate or invalid rule mappings, fixed model or effort fields, fixed
  override attempts, insufficient reviewer count, missing anchors, missing
  tests, missing scripts, missing files, missing policy references, and the
  separation between development-process selection and product AHR effort.
- `npm run document-sync:contract-check` verifies that an
  `INSTRUCTION_MEMORY.md`-only range fails and that synchronized workflow,
  product, verification, security, policy, schema, routing, and manifest
  authorities pass together.
- The existing `repository-contracts` job installs the pinned repository parser
  dependency and owns policy, document-sync, structure, security, design-system,
  and structured CI contract checks. Node jobs own no-browser runtime regression
  and browser smoke owns React/Vite browser behavior; the contract-only job does
  not rerun either suite.
- A passing policy contract proves objective structure and registration only.
  It does not authenticate chat approvals, semantic review quality, complete
  no-regression, or effective model and effort settings when the runtime does
  not provide attestation. Reports must state that limitation explicitly.
- This workflow-only slice still runs the existing browser smoke as requested
  regression evidence. No new browser route or visual behavior is introduced.

## Composed Local And Remote Verification

The verification policy is checked with:

```bash
npm run verification:check
npm run verification:plan -- --profile focused --worktree
```

The supported local execution profiles are:

- `npm run verification:focused`: changed-surface checks only. This is partial
  evidence and never a release-ready result.
- `npm run verification:core`: repository contracts and every no-browser test
  owner, including verification infrastructure.
- `npm run verification:browser`: one Control Center build followed by the 15
  browser smoke tests without rebuilding.
- `npm run verification:release`: the exact union of core, package, build, and
  browser owners. This is the only profile allowed to claim complete local
  release verification, but by itself it records no product authority.
- `npm run verification:release:evidence`: resolves the configured release
  profile, reruns it on one clean synchronized revision, and records one complete
  exact-HEAD local authority batch.
- `npm run verification:ci-proof:import`: after remote CI passes, authenticates
  the policy-selected repository/workflow/run/artifact and records separate CI
  proof evidence without replacing the local batch.

The runner uses policy-owned argv, bounded rolling parallelism, declared locks,
per-task timeout and output limits, first-failure process-group cancellation,
deterministic policy-order reporting, and a one-worker fallback. The tracked and
untracked non-ignored worktree snapshot must be unchanged after execution.
An already-aborted signal is covered explicitly: no child process may start,
every pending task is reported cancelled, the overall result fails, and an
external side-effect marker remains absent.
Dependency execution is topological rather than declaration-order dependent:
an earlier serial consumer waiting for a later producer is skipped during that
scheduling pass so the producer can start, after which the consumer runs under
its lock. A focused runner regression freezes this case.
Unknown changed paths select core checks; temporary memory-only changes are
reported as ignored rather than converted into a new PASS receipt.
Credential-bearing environment variables and live-provider opt-in flags are
removed before every verification child process starts.
Successful command output is summarized by default; failed task diagnostics are
shown immediately, and `--json` returns the complete bounded machine result.
The CLI parser rejects unknown, repeated, missing-value, conflicting, and
command-inapplicable arguments before task execution. A misspelled evidence
operation therefore cannot silently fall back to a proof-free release run.

`npm test`, `npm run test:browser`, `npm run release:check`, and
`./tools/product-gate` remain compatibility entrypoints. `test:browser` builds
then calls `test:browser:run`; CI owns the build separately and invokes only the
build-free command. The split CLI and Agentic Human Review files must retain the
same combined test names and assertions.

The package profile builds Control Center before packing and captures both npm
11 dry-run and real producer JSON through one fixed-argv helper into a
run-isolated exclusive mode-0600 file because a piped child stdout may otherwise
yield an empty successful response. Empty, oversized, short-read, changed,
malformed, or non-single-manifest output fails the package gate.

CI distributes Node runtime and package-consumer compatibility while keeping
repository contracts, package production, and browser execution single-owner.
Playwright caching is binary-only and exact-key; all tests still execute.
Package consumers validate one same-run tarball and cannot repack. `final-gate`
runs with `always()`, rejects any failed, skipped, or cancelled owner, binds the
result to the run, attempt, full HEAD, policy, and graph, and does not rerun
provider suites.

The CI contract parses workflow YAML structurally. Mutation tests remove a
required command, append `|| :`, add spaced or ordinary `continue-on-error`,
add job/step conditions, exclude Node 22 from the matrix, alter artifact
bindings, restore cache prefixes, duplicate builds, omit materialization, and
rerun product suites in the proof-only final job; every mutation must fail.

Exact-commit remote verification is:

```bash
./tools/check_ci_status.sh --required --commit "$(git rev-parse HEAD)"
```

Product-gate receipt status recalculates full HEAD, tree, worktree, input,
policy, and age. A manually recorded PASS is `manual_required`, a dirty executed
success is advisory, and stale evidence is not authority-ready. Raw logs,
environment dumps, secrets, URLs, and host-specific absolute paths are forbidden
from authoritative receipt content.

Concurrent-writer tests start twelve independent receipt writers and require
every admitted receipt and derived row to survive within the active lock and
ingress bounds. A
writer may observe its exact event in the stable bounded ledger and coalesce a
redundant rebuild, but corrupt, missing, oversized, replaced, or incomplete
ledger state must force the normal locked rebuild path. Capacity tests prefill
the receipt store and require a multi-source release batch to recover retention,
write every receipt, and commit without reacquiring its own index lock.
The order-sensitive case places an older authoritative failure on the first
lexical release source and requires bounded whole-batch admission to preserve
all pending receipts until commit replaces that semantic winner.

The active evidence index is verified as exactly 13 tab-separated fields with a
whole-second UTC `observed_at` value and full product HEAD. Legacy short-HEAD
rows are copied intact to a digest-named local archive before removal from the
active view; v2.0 receipts remain historical and stale, and repeated rebuilds
must not duplicate or re-import them. Tests also prove that every schema v2.2
field and committed release-batch membership is digest-bound, an empty or
partial store exposes manifest-declared
required evidence as `not_run`, contextual requiredness is never inherited from
a receipt outside its declared contexts, cached results cannot satisfy
readiness, optional stale history cannot block current required evidence, while
required stale, failed, blocked, non-PASS, advisory, dirty, malformed, tampered,
or symlink-directed evidence remains non-authoritative. A single-context active
detail must match its row; a multi-context source must expose no context-specific
event; a synthesized missing row must replace old detail text. Final integration runs
the parent authority command read-only for the TraceCue free-development
context and requires `status=ready` against the exact clean synchronized HEAD.
Because the parent reads a static projection, the TraceCue `status` command
rebuilds freshness before parent inspection. Immediate detection of arbitrary
worktree edits without a producer refresh remains a parent-consumer concern and
is not represented as a TraceCue-only guarantee.

The active v2.2 receipt and release-batch stores are bounded by policy-owned
count and byte limits. Locked retention preserves the semantic current rows and
their complete batches first, then atomically moves superseded and expired
directories into a marker-owned inactive archive. Replacement races, copied
receipt identities, unsafe file sets, crashed archive initialization, future
timestamps, and capacity exhaustion fail closed. Inactive records remain local
and inspectable but are excluded from readiness scans. Their aggregate disk use
is not automatically bounded or deleted; explicit export/compaction remains
deferred.

## Control Center Goal Completion Verification

Focused contract tests must reject symlinked or hardlinked store, lock, intake,
static, and evidence paths; replacement races; oversized or slow streams;
quota exhaustion; abandoned input; traversal and header injection; MIME/magic
mismatch; invalid UTF-8 and binary text; oversized image dimensions; expired
opaque ids; missing/foreign/stale Origin or CSRF; concurrent launch/start/
confirm/cancel; nonce, input, service, destination, disclosure, and revision
drift; duplicate provider dispatch; and credential/path/raw-input leakage.
They also require an existing markerless store to remain untouched, live
processing receipts to consume quota, projection-only GETs to leave a fresh
workspace unchanged, runner exceptions and incomplete transfer boundaries to
be dispatch-unknown, and an explicit all-false boundary to remain the only
retryable no-send failure.
History tests hold publication/update locks while another completion requests
retention, require both public operations to succeed, verify inactive hash
shards retain old records, and require direct opaque-id status/result lookup and
one-use semantics after active-list retirement. Additional contention tests hold
the global history-maintenance lock while a decision, confirmed external-review
start, and intake completion return; each primary action must complete before
the lock is released, the provider dispatch must still be scheduled, and the
persisted result must remain successful. Expiry coverage advances beyond the
intake TTL, triggers cleanup with a later upload, and requires the completed
result, receipt, direct lookup, and one-use rejection to remain intact.
Publication-admission tests use separate Node processes to hold one long-running
owner, start a same-id retry, and attempt a different id at the active-result
bound. They require one engine execution, renewed owner lease, a capacity error
for the different id, and the same result for both owner and waiter. Bound-one
turnover must archive the previous result, admit the next, and preserve both
direct opaque-id reads. A full active store plus a held history lock must still
return an already completed archived id without new admission. Dead-owner and
same-process-idle processing receipts without a pending result must become
non-retryable failures; a missing or invalid pending result must remove its safe
result and reservation so a later upload and publication can succeed. A valid
pending pair must still finalize without running the engine again.

Safe-store lock tests deliberately occupy the release-transition prefix past a
short owner window. The exact nonce/pid/process-identity owner must remove its
unchanged logical lock and allow a later acquisition after the transition
finishes; a changed owner remains rejected. Result and operation list tests race
active-to-history movement and permit only bounded transient re-reads while
persistent missing, malformed, or digest-invalid matching records fail closed.

Package verification builds the Control Center once, includes the built assets
in the tarball, installs it into a clean external directory, launches it from an
unrelated cwd with an injected opener, verifies a second launcher reuses the
healthy instance, and verifies browser-open failure still returns the safe
loopback URL. No CI test may open the desktop browser.

Recovery tests cover crash before send, during send, after response, and during
validation. `dispatching` and unverifiable `validating` may not execute another
provider request. A recovered validation must prove the persisted result and
execution identity before local normalization. A persisted owner equal to the
current server process is also covered: once the in-memory background task is
absent, dispatch becomes unknown and preparation exposes explicit resume,
without waiting for a server restart or treating another live process as idle.

Browser verification divides coverage instead of multiplying every locale and
viewport combination. The primary Japanese flow runs at 390, 768, and 1440
pixels; representative English and RTL flows verify labels, direction, focus,
keyboard operation, overflow, dialogs centered in the work area, and no
overlap. Existing eight actions, three top-level destinations, five stages,
effort values, external-send confirmation, CLI/MCP compatibility, and browser/
CI execution prohibitions remain regression checks.
The 768-pixel check also requires a one-column readable side navigation; the
file-intake flow dispatches a real browser drop event and proves submission
reaches upload without relying on a native file input value. Settings checks
compare the approved labels and green enabled toggle with the active mock.
The production/mock comparison also freezes the one-line purpose control and
right-aligned action footers. Saved-result coverage imports mixed, timed-out,
and empty Playwright results; requires visible total/pass/fail/timeout/skipped
facts and truthful danger/warning styling; proves a successful file cannot be
submitted again without an explicit prepare-another action; proves a failed
list refresh retains existing work with retry; keeps visible status text on
mobile; checks current-step and decision accessibility state; and verifies the
saved-result page plus mirrored directional symbols in the representative RTL
locale. Intake-only results must have no website-review completion stepper.

Control Center AI connection parity adds focused no-browser coverage for the
private capability record, canonical integrity hash, distinct capability and
settings revisions, TTL/fresh/stale projection, opaque browser option ids,
schema registry parity, cross-process-safe store, compare-and-swap refresh and
selection, configured-API projection, and exact tuple resolution. Tests must
reject tampered records, stale dispatch authority, forged or mismatched opaque
options, capability/configuration/executable drift, unsupported native effort,
credential/path/hash/raw-output leakage, and any implicit connection, model, or
effort fallback.

Read-only dashboard tests inject a process runner and network transport that
fail if called, proving GET performs no discovery, spawn, provider contact, or
store mutation. Explicit refresh and selection tests require the existing
Origin/CSRF mutation boundary and prove conflict responses preserve the winning
revision. Subscription/API parity tests require the same plan, confirmation,
execution, normalized result, decision, recheck, and deeper-review shape while
retaining their distinct truthful connection type and API-call boundary.

Fixed-process tests prove `shell: false`, fixed argv, bounded
stdin/stdout/stderr, timeout and abort handling, inherited-descriptor mapping,
and descendant process-group termination. Codex tests reject a self-declared
package layout whose ELF bytes do not match the centrally pinned official size
and SHA-256 contract, validate strict dynamic model catalogs without fallback,
inspect the exact bubblewrap/prlimit argv, and execute a static binary through
the real local bubblewrap boundary when user namespaces are available. A local
availability-only probe additionally verifies the installed official binary,
login state, feature catalog, and seven-model catalog with discovery networking
disabled; it sends no review content. The tests also prove TraceCue review
method remains unchanged when provider-native effort changes. No automated test
performs a live external AI send or consumes a real subscription/API allowance.

Browser verification uses injected deterministic provider runners with a
user-facing service and model. It checks compact New Review AI summary,
setup-needed recovery, explicit availability update, settings change flow,
provider-native effort under secondary AI details, an explicit AI-choice apply
action separate from the atomic general-settings save, two-page compare-and-swap
conflict recovery with the draft retained, and send confirmation that shows
transferred evidence, destination, and TraceCue review method. It must also prove provider/adapter ids, endpoint, token, CLI command,
executable path, file path, and technical authority fields are absent, and must
retain the existing responsive, focus, RTL, overlap, clipping, console, failed-
request, and horizontal-overflow checks. The active versioned mock is verified
and its previous Phase 176 state remains archived.

Current 2026-07-14 pre-commit local evidence for Phase 177-181 is 379/379
complete no-browser tests, 41/41 focused AI-connection and Agentic Human Review
tests, and 20/20 built React/Vite browser tests. The browser regression covers
late review-route responses, cancellation response loss with successful status
reconciliation and no false warning, cancelled-item next-work exclusion,
settings saved-state reset, and setup-needed availability recovery. Concurrent
release execution may contend for local CPU, so the browser's preparation wait
matches the product's bounded 60-second preparation contract plus fixed test
overhead and reports an early visible preparation error instead of a bare
30-second dialog timeout. Private-staging admission permits only the configured
bound and fails closed;
the fixed-process descendant test waits for readiness before cancellation; the
real bubblewrap invocation and availability-only installed Codex probe pass.
The complete `release:check`, 317-file package dry-run, packed-install smoke,
repository test, and `product-gate` pass. Three independent post-implementation
reviews pass. TraceCue self-review ids
`review-2026-07-14T10-47-32-966Z-6cc72aa5` (desktop New Review),
`review-2026-07-14T10-47-43-624Z-6089c075` (desktop Settings), and
`review-2026-07-14T10-50-34-947Z-235c8957` (mobile Settings after the detected
text-action touch target was raised to 44 by 44 pixels) each report zero final
findings, failed requests, console errors, overlap, clipping, or horizontal
overflow. These checks use no live external AI send and do not consume a
subscription or API allowance. Exact clean-HEAD release and authenticated CI
evidence remain post-commit evidence.

Final 2026-07-13 local evidence for this slice is 357/357 no-browser tests,
16/16 Playwright browser tests, a passing production build and versioned mock
check, 285-file package dry-run, packed-install smoke, and `product-gate`.
TraceCue self-review ids `review-2026-07-13T17-09-09-599Z-64cab64b` (desktop
New Review) and `review-2026-07-13T17-09-30-837Z-d8997383` (mobile
Confirmation list) each report zero findings, failed requests, console errors,
overlap, clipping, or horizontal overflow. These are local regression results;
exact clean-HEAD release evidence and authenticated CI proof are recorded only
after commit and successful remote execution.

The clean-runner compatibility loop also requires server tests to provide an
explicit minimal static asset root instead of inheriting a prior local build.
Timeouts that own completion of CI-proof API calls or stalled intake streams
must keep the event loop alive until they fire or are cleared; background-only
retention and lease maintenance may remain unreferenced. Implementation commit
`aa4d16c` satisfies this contract in GitHub CI run `29270579455`: Node 20 and
Node 22 each completed all 357 no-browser tests without cancellation, Browser
smoke completed all 16 checks, and repository contracts, package producer,
both package consumers, and final proof all passed. Exact closure-HEAD evidence
is then refreshed in the ignored authority store so evidence recording does not
invalidate the tracked revision it proves.

History-move verification also amplifies concurrent operation-list reads while
retention retires a completed record. Internal quarantine names must remain
outside the operation-id namespace, a directory entry that disappears before
its safety recheck may be skipped, and every other unsafe entry remains a hard
failure. Deferred maintenance may retry a transient failure only a bounded
number of times with unreferenced delays, so it neither loses the request nor
keeps a completed process alive. This race check passed 30 consecutive local
runs before the complete 357-test and 16-browser-test suites passed again.

GitHub CI run `29271951752` passed Node 20, Node 22, repository contracts,
package production, and both package consumers, but its browser job failed the
Dashboard reload immediately after an accepted start response was deliberately
lost. Safe atomic replacement can correctly raise `SAFE_STORE_FILE_CHANGED`
when inspection sees the old record and descriptor opening sees the new one.
The list projection now retries that signal and transient move `ENOENT` only,
within the existing bounded read window and with complete validation on every
attempt. The browser flow now asserts the Dashboard response is HTTP 200 before
using the new-review form; four concurrent workers passed five rounds, 20/20 in
total, before complete gate repetition. An internal context-only store factory
now deterministically injects `SAFE_STORE_FILE_CHANGED`: one failure must
recover on the next complete safe read, four failures must exhaust the bound,
and an unclassified safe-store error must fail after its first attempt. The
browser check opens a fresh page for the Dashboard assertion, preventing the
existing work-page status poll from satisfying the response predicate.

GitHub CI run `29273554351` passed Node 22, repository contracts, package
production, both package consumers, and all 16 browser checks, but Node 20
exposed a same-id intake waiter reaching the completion lock between owner
reservation and owner processing-state publication. Verification now forces
that exact order with separate processes and filesystem barriers: the owner is
paused immediately before its first per-id lock, the waiter signals after it
enters that lock and observes the staged receipt, and only then is the owner
released. Both processes must return the same successful result and the stored
result count must remain one; an exclusive marker additionally rejects a second
engine invocation and output roles distinguish the owner from the existing-
result waiter. The waiter uses the remaining configured completion deadline and
bounded poll interval, revalidates the originally observed reservation token
and live process identity on every staged cycle, and never becomes the executor.
Separate cases make the owner fail validation or exit before processing: the
waiter must return owner-lost promptly, the engine marker must remain absent,
and a later explicit completion must succeed. Worker barriers and collection
have fixed deadlines and terminate live children on failure. The focused race
and renewal checks passed in eight concurrent Node 20 runs, and the initial
complete Node 20 suite passed 358/358. Lease verification polls for an actual
later expiry and requires unchanged token and owner. History verification
blocks the injected maintenance dependency, requires primary actions to return
before release, and waits for deferred work to become quiet; these assertions
no longer depend on a 300 ms sleep or one-second host timing. The expanded
owner-loss and cleanup cases also replace the reservation with a valid different
token owned by a live process, assert the retryable detail, bound TERM/KILL and
stream detachment, and require 150 ms of continuous quiet beyond the current
100 ms maximum maintenance retry delay. Independent focused stress passed. The
complete expanded suite then passed 361/361 on exact Node 20.20.2 and 361/361
on the current Node runtime.

Authority refresh requires one complete release profile with clean identical
before/after full HEAD and tree. Every policy-owned source receipt references
the same batch digest and exact task result. Partial, focused, dirty, mixed,
cached, manually labeled, or changed-policy runs cannot become ready. Remote CI
proof import separately rejects wrong repository, HEAD/tree, run/attempt, final
job, owner jobs, policy/graph, or artifact digest and performs no network action
from dashboard reads. The downloaded proof container is parsed with explicit
entry, compressed-size, expanded-size, total-size, duplicate-name, path,
encryption, link, and CRC limits before the single expected JSON proof is
accepted.
