# SPECIFICATION.md

## Product Shape

TraceCue is the canonical package, CLI, MCP server, and plugin identity. The legacy Browser Debug CLI name and `browser-debug`/`browser-debug-mcp` bins remain compatibility aliases in this migration slice.

TraceCue is a Node.js CLI package backed by Playwright and local metadata tools. It should be usable from any product repository and should not require the caller to run an MCP server.

The Phase 2a design baseline uses Node.js 20 or newer, ESM modules, and a local CLI binary named `browser-debug`. The final npm package name can still be confirmed during release planning, but runtime code should not depend on a scoped package name.

## Planned Architecture

- CLI entrypoint: accepts commands, options, and JSON input/output flags.
- Core library: owns Playwright session management, observation, actions, and artifact creation.
- Browser supervisor: keeps a reusable browser context alive when fast iterative debugging is needed.
- Observation layer: summarizes URL, title, accessibility tree, visible text, form controls, action candidates, console errors, failed requests, screenshots, and selected metadata.
- Action layer: performs explicit actions such as click, fill, select, press, scroll, wait, navigate, screenshot, and trace capture.
- Report layer: converts session evidence into issue reports and handoff notes.
- Review core: converts normalized browser evidence into deterministic UI review findings.
- Quality signal layer: summarizes local review evidence into visual hierarchy, rendered state, responsive layout, interaction, accessibility, page expectations, evidence completeness, release-readiness, and model-boundary signals.
- Site review layer: discovers routes, runs viewport matrices, applies action risk policy, and emits coverage.
- Artifact index layer: groups local review artifacts, evidence classes, rerun guidance, and local safety boundaries for developer handoff.
- Manifest suggestion layer: turns target review coverage and rendered-state evidence into local suggestions for better reruns without editing runtime code for specific applications.
- Content UX advisory layer: evaluates manifest opt-in source-to-screen content contracts, selector-scoped state contracts, required user-question evidence, review briefs, and rubric criteria from existing target review evidence without creating review findings or changing release gates.
- Resource status layer: reads local process-visible memory, swap, cgroup, and pressure signals before browser-heavy work without launching Playwright, writing artifacts, mutating host cache, changing swap, deleting files, or controlling arbitrary processes.
- Resource guard layer: reuses resource status for review preflight and route/viewport rechecks, emits additive `resource_guard` data, warns on heavy screenshot/trace artifacts, and can stop browser work only when explicitly set to `fail-critical`.
- Resource artifact layer: inventories `.browser-debug/` artifact usage, proposes cleanup candidates, and performs explicit artifact-root-only cleanup with receipts when `--execute` is provided.
- Daemon lifecycle layer: adds optional local idle-timeout and max-lifetime shutdown guards to detached ephemeral browser workers.
- Persistent browser session layer: starts a retained Playwright context and page through local CLI/session metadata, exchanges commands through a local artifact-root file queue, enforces TTL and idle-timeout guards, restricts navigation to an origin allowlist, records value-silent receipts, supports manual-login checkpoints, observes the retained page, hands the current page state to local review artifacts, and shuts down context and browser on stop.
- Agent advisory layer: creates bounded local evidence packages from review artifact indexes, generates handoff prompts for local subscription agents, lists and inspects local request status from package/result artifacts, imports untrusted advisory JSON, and renders separate advisory reports without direct API calls, external upload, credential storage, or deterministic gate changes.
- Agent execution layer: plans and runs subscription-style local agent or API-style provider execution from bounded agent packages through dedicated provider adapters, exposes status/list metadata, and normalizes output as advisory-only results without mutating deterministic review artifacts or existing workflow status semantics.
- Playwright Test regression layer: stores a disabled-by-default mode contract for `disabled`, `import_only`, `local_run`, and `external_ci`; imports bounded Playwright Test JSON/JUnit/HTML-reference artifacts as advisory local evidence; projects normalized results into non-engineer review cards, evidence-quality limits, optional baseline comparison, and standard/deep/xhigh review inputs; creates CLI-only local run plans that require `--execute` plus a matching plan hash before spawning the fixed Playwright CLI; retrieves exact existing GitHub Actions artifacts only through read-only `gh run list/view/download` commands; and supports approved external-CI fetch settings that resolve the latest matching successful run before explicit download without triggering or mutating CI.
- Agentic Human Review layer: creates owner-readable plans and metadata packages from existing review artifact indexes for human-like visual, UX, content, comprehension, subjective perception, risk, and improvement review. Execution is CLI-only, requires an exact plan hash plus exact transfer flags, writes `agentic_human_review_advisory` output, blocks generic `agent execution` bypass, and remains excluded from MCP profiles. Schema v2 adds explicit human-review dimensions, provider instruction contracts, review-quality benchmarks, reader-experience review, mechanical-versus-human comparison, human-review coverage, and actionability scoring.
- Agentic Human Review content evidence intake layer: optionally reads workspace-confined content evidence JSON during proposal or plan creation, normalizes analyzer-neutral source types for `video`, `web_page`, `pdf`, `meeting_notes`, `document`, `transcript`, and `other`, accepts bounded summaries, content units, observed claims, limitations, privacy, and provenance fields, and rejects raw media, raw binaries, base64/blob/data URI payloads, raw HTML/PDF bytes, full documents, and full transcripts. Existing `--video-evidence` remains a compatibility input and is projected into generic supplemental `content_evidence`. Plans, packages, provider filters, advisory results, report-quality diagnostics, and Markdown reports carry path-free content-evidence summaries, source-type lists, content-unit counts, and content-understanding levels without running or naming an analyzer, downloading remote content, uploading evidence, calling providers during planning, reading credentials, exposing MCP tools, or altering deterministic review output.
- Agentic Human Review source-text reading and understanding layer: optionally reads a workspace-confined `--source-text` file during proposal or plan creation, accepts plain text or analyzer-neutral JSON exports for video transcripts, web-page text, PDF-extracted text, meeting notes, documents, transcripts, and other text sources, chunks and hashes the source locally, and produces bounded `source_reading_review` and `source_understanding_review` records derived from the full text. The source-reading review contains narrative flow, key points, concrete examples, tensions, cautions, recommended direction, source excerpt refs, effort-specific quality targets, and a natural review seed for editorial synthesis. The source-understanding review contains thesis, audience promise, narrative arc, turning points, repeated motifs, must-not-miss points, tensions, limitations, reviewer implications, evidence claims, assistant-reference quality target, hash-only local source excerpt refs, and coverage diagnostics. The natural full-review composer uses those structured records as source material, builds a target-independent editorial narrative plan, cross-checks that plan against existing normalized reader-impact signals, findings, role opinions, action recommendations, and verification signals, rewrites the result into owner-facing paragraphs, and applies effort-specific composition: `standard` focuses on a practical source-grounded review, `deep` adds audience value, concrete examples, and prioritization, and complete `xhigh` integrates critique, verification, counterpoints, evidence limits, and what would change the conclusion. The composer suppresses fake-provider scaffolding, internal `Step`/`role` markers, operational effort labels, duplicate or near-duplicate source anchors, assistant-reference target labels, target-specific heuristics, and boundary boilerplate from the prose body when those values remain available in structured metadata. Full source text and chunk text are never persisted in JSON or Markdown and are never transferred to providers. Raw media, raw binaries, base64/blob/data URI payloads, credential-bearing fields, and raw/full structured payload fields are rejected. Provider payloads can receive only bounded source-reading and source-understanding review records under the existing `allow-page-text` boundary; source-understanding refs are compacted to source ids and hashes without excerpt text or source locators before provider transfer. Agentic Human Review remains advisory-only, MCP-excluded, gate-neutral, and claim-ineligible for equality or superiority proof.
- Agentic Human Review benchmark/calibration layer: provides read-only benchmark case inspection, structured benchmark requirement coverage, fixture-aware calibration diagnostics, direct-vs-TraceCue advisory comparison, editorial-quality comparison against workspace-confined reference reviews, batch comparison, reusable human-baseline registry/overlay/draft/approval/claim-readiness diagnostics, owner-labeled human baseline validation/comparison, evidence-set validation and summary, dogfood evidence-pack summarization and review-pack projection, evidence-set regeneration planning, evaluator policy diagnostics, xhigh round planning and simulation, longitudinal quality rollups, claim policy/audit diagnostics, a mechanical claim standard gate, provider capability snapshots, evidence plans, page-type rubric profiles, orchestration diagnostics, owner-baseline requirement contracts, and privacy/disclosure audit metadata without executing providers, writing benchmark artifacts by default, mutating deterministic review artifacts, or changing release gates. Evidence-set and claim-readiness summaries must prove the required benchmark-case by effort matrix explicitly, unwrap supported TraceCue CLI and public API runtime-result artifacts for calibration/comparison/human-baseline inputs, preserve raw advisory-result validation for result entries, classify missing result, mechanical-incomplete, failed-calibration, and missing-comparison blockers separately, report missing `direct-vs-tracecue` comparisons by case, and keep weak calibration coverage as a blocker for any later owner claim review. Dogfood evidence-pack summarization consumes a workspace-confined evidence-set manifest, evidence-set output, or dogfood pack manifest and emits a compact owner-review digest with matrix status, claim-review status, and advisory regeneration handoff while suppressing detailed result paths, source paths, raw provider responses, credentials, full source text, chunk text, candidate/reference prose, and concrete rerun commands. Dogfood evidence-pack review packs reuse the same summary and claim-gate data to emit owner-facing ready/blocked/incomplete status, standard/deep/xhigh matrix badges, grouped blockers, top owner actions, trust/safety flags, and pathless advanced references while suppressing raw hash values and concrete commands. Advisory normalization exposes `review_claims` only through `claim_integrity`, rejects placeholder or evidence-missing proof claims from strict claim-numerator eligibility, and keeps rejected claims diagnostic. Claim audits classify forbidden-claim policy matches by source, polarity, and gate-blocking status so evidence-backed absence or coverage checks do not become proof-claim blockers while ambiguous or affirmative forbidden text still fails closed. Comparisons expose metric-level regression diagnostics, critical regressed metrics, owner-baseline coverage gaps, editorial-quality effort-target diagnostics, and evidence-backed forbidden-claim absence gaps. Editorial-quality comparison accepts only bounded reference review text or JSON as its baseline, emits hashes, scores, deltas, strengths, gaps, and diagnostics without outputting reference prose, candidate prose, source text, local paths, or source locators, and keeps equality/superiority claim flags false. The claim standard gate consumes the summarized evidence set and optional claim policy, evaluates claim-readiness, longitudinal quality, comparison regressions, owner-baseline matches, xhigh completion, synthetic/local evidence exclusion, and per-result claim audits, exits non-zero when the gate does not pass, emits a read-only minimal rerun plan for unresolved blockers, and still keeps human-equivalent and human-superior claim states false. The evidence-set regeneration planner consumes that gate output and an optional target registry, derives dependency-ordered provider-result repair, calibration, comparison, human-baseline comparison, summary, claim-readiness, longitudinal-quality, and claim-standard-gate command templates, and records that none were executed by the planner. Direct human-baseline comparison may accept a supported validation runtime-result wrapper as the baseline input only by extracting and revalidating the embedded baseline contract. Verified owner-labeled human baselines may be attached to proposals or plans as workspace-confined JSON and converted into path-free plan-hash-bound contracts for provider payloads and later comparison.
- Agentic Human Review staged effort execution layer: `agentic review run --execution-mode staged` is an additive execution strategy for approved `standard`, `deep`, and `xhigh` plans, not a replacement for the default one-shot run. It validates the same plan artifact, supplied plan hash, exact transfer flags, provider/model/surface match, provider capability hash, and live dogfood opt-in before any provider call. Staged execution splits the planned effort roles into bounded provider requests, records normalized non-final stage summaries, then deterministically aggregates them into one final `agentic_human_review_advisory` result. Stage outputs are not accepted by report-quality, calibration, comparison, evidence-set, longitudinal quality, or claim gates as final evidence. The final result keeps the original owner-baseline requirement contract, benchmark coverage contract, model resolution metadata, transfer permissions, and no-raw-response/no-credential boundaries; true multi-call execution is recorded separately from effort completion, and incomplete staged aggregation still remains non-proof, claim-ineligible, and unable to authorize equality, superiority, owner claim-readiness, or release gates.
- Agentic Human Review Responses adapter layer: runs as an optional loopback-only local HTTP adapter that accepts the existing generic provider request contract, validates the local bearer token and disclosure contract, builds a bounded Responses-compatible request with provider-side storage disabled, and returns normalized advisory JSON without storing raw provider responses or credentials. The adapter parses provider output in memory by accepting direct advisory JSON first and, only when needed, extracting exactly one unambiguous provider-authored advisory JSON object from a JSON string, a single JSON Markdown fence, or prose wrapped around one balanced JSON object; malformed JSON guessing, multiple-candidate selection, raw output persistence, and validation bypass are not allowed. When benchmark calibration is enabled, the adapter output contract should ask for exact benchmark coverage records, structured advisory findings, evidence-reference identifiers, and non-placeholder review claims backed by request-catalog evidence or planned role output, then canonicalize safe provider aliases without inventing positive coverage or owner evidence. When an owner-baseline requirement contract is present, the adapter must require one canonical `owner_baseline_findings` record per required owner-label obligation with matching owner label ids, linked criterion ids when present, and evidence references from the request catalog; target-specific criteria without linked owner labels remain fallback obligations. Role-level findings and generic advisory findings may still be normalized into advisory output, but they cannot satisfy the owner-baseline proof contract unless the same proof is present in `owner_baseline_findings`. Normalized advisory results retain `owner_baseline_findings` separately and merge those records into `agentic_human_review_findings` so downstream human-baseline comparison sees the same evidence-backed owner-label surface that adapter validation accepted. Owner-baseline required mentions, required dimensions, and forbidden claims are merged with the benchmark case into an effective coverage contract; provider input and repair context expose compact `required_benchmark_coverage` templates for the full effective contract and compact `required_owner_baseline_coverage` templates for owner-baseline provenance, and post-validation requires matching `benchmark_requirement_coverage` rows with exact strings and catalog-backed evidence references. The provider JSON schema must require the nested benchmark coverage arrays when effective coverage is active and should set `minItems` from the active required coverage contract. Repair context also exposes path-oriented coverage repair targets for missing rows. Forbidden owner-baseline claims are absence checks and must be represented as structured absence rows instead of prose discussion. If a repaired provider response still omits forbidden-claim absence rows, the adapter may complete only those missing absence rows from canonical templates after confirming the provider advisory does not assert the forbidden claim and a catalog evidence id is available; those rows must carry adapter-derived provenance and cannot authorize equality, superiority, release approval, or deterministic gate effects. Owner-baseline and benchmark catalog entries must be prioritized ahead of optional artifact references so bounded catalogs cannot evict required proof identifiers, and provider instructions plus external provider payloads must remain size-bounded by using a compact provider-facing `review_request` view instead of duplicating long owner-baseline arrays, nested provider-instruction owner contracts, plan/package text and visual contracts, owner summaries, or local paths. The original inbound TraceCue request remains the post-validation authority, while the provider-facing view preserves plan hash, effort, roles, xhigh strict-output requirements, effective benchmark requirements, compact owner-baseline criteria, and catalog-backed evidence-reference ids. Generated provider request-size failures may report non-secret section byte counts, but must not store request payloads, raw provider responses, credentials, or local artifact contents. The provider request and repair context must include a compact `required_owner_baseline_findings` contract derived from the approved baseline and evidence catalog, including `owner_label_id`, required owner label ids, linked criterion ids, required fields, and recommended evidence-reference ids. The adapter must not synthesize missing findings from baseline text, role summaries, generic advisory prose, benchmark coverage rows, or coverage patch output. Repair prompts may include redacted missing criterion ids, missing fields, owner label ids, required benchmark coverage templates, required owner-baseline finding templates, required owner-baseline coverage templates, forbidden-claim semantics gaps, coverage repair targets, xhigh missing conditions, invalid review-claim reasons, placeholder role-output stage/role/round metadata, and allowed evidence-reference ids, but repaired output remains subject to the same fail-closed validation. Placeholder role output includes explicit placeholder flags, `reported_by_provider=false`, and role-output summary wording such as a reviewer did not return, role output was not available, or missing output from a role; those records do not count as reported role/round coverage and must be replaced rather than accepted. Ordinary content findings about unavailable page data remain valid provider-authored role output. Forbidden-claim records are absence checks: `present` means the forbidden claim appears in the advisory output, not that the check was covered, and `present=true` combined with absence wording is a semantic contradiction that must be repaired or rejected.
- Agentic Human Review adapter claim-filtering layer: provider-authored `review_claims` are normalized as optional proof candidates. The adapter removes candidates with placeholder text, missing support, unknown role support, or human-equivalent/human-superior wording before returning advisory data, emits bounded `adapter_claim_filtering` diagnostics without claim text, raw provider bodies, credentials, or local paths, and lets TraceCue result normalization carry those diagnostics into `claim_integrity`. The completed advisory run is still usable for report-quality and debugging, but strict claim-numerator eligibility remains false whenever any candidate was rejected. Staged final synthesis may count roles reported in prior normalized stage summaries as support for a retained claim; stage outputs themselves remain non-final evidence.
- Agentic Human Review owner-baseline recovery layer: records whether a candidate advisory result was generated from an owner-baseline requirement contract matching the approved baseline being compared. Human-baseline comparison, evidence-set summaries, claim-standard-gate blockers, and evidence regeneration plans must distinguish ordinary low alignment from a missing or mismatched candidate owner-baseline contract. When the candidate result lacks the matching owner-baseline contract, local comparison regeneration is insufficient; the claim-standard-gate rerun plan must include an approval-required provider result target, and the evidence regeneration planner must resolve that target only from a validated matching owner-contract plan or an explicit target-registry row. Older result plans without a matching owner-baseline requirement contract must remain unresolved rather than being reused silently.
- Visual evidence layer: records browser screenshots, standalone images, mock images, screen captures, window captures, and desktop app captures as metadata-only local evidence with dimensions, hashes, privacy flags, and artifact references but without raw pixel embedding or provider calls.
- Visual review provider policy layer: adds planning-only disclosure metadata to `agent execution plan` records so future AI-assisted visual review provider work starts from explicit no-raw-pixel, no-provider-call, no-MCP-execution boundaries.
- Visual review result preparation layer: turns existing review artifact indexes into metadata-only future visual review result contracts while reading only visual evidence metadata and keeping provider execution disabled.
- Visual review execution layer: runs explicit CLI-only provider adapters from preparation artifacts, sends metadata/local references only, normalizes untrusted advisory output into visual review results, and keeps raw pixels, existing reviews, release gates, and MCP execution unchanged.
- Visual review dashboard layer: aggregates local visual review preparation, execution, and result metadata for CLI, dashboards, and safe MCP clients without writing artifacts, calling providers, reading raw pixels, or changing gates.
- MCP execution gate policy layer: reports required safety gates and current exposure for approved admin-only agent execution plus future MCP write/execute candidates without changing MCP permissions or running providers from the report.
- Operation registry layer: centralizes risky operation families, roadmap group mapping, risk taxonomy, MCP exposure state, approval gates, capability exclusions, and read-only boundaries so capability and gate reports no longer maintain separate operation lists by hand.
- Operation roadmap layer: derives a read-only phase governance report from the operation registry and draft phase memory, exposing A proposal, B implementation-plan, and C local boundary implementation contracts for phases 60-155 without promoting draft entries into formal product-plan commitments or live execution permission.
- Operation contracts layer: derives shared Phase 61-64 contracts for risk taxonomy, gate schema, execute-token shape, and receipt shape from the registry/roadmap foundation without issuing tokens, writing receipts, enabling harnesses, or expanding MCP write/execute authority.
- Operation policy layer: reads repository-local admin policy defaults and reports Phase 65-68 CLI plan readiness, disabled generic harness state, safe MCP readiness, and approved admin-only agent execution exposure without mutating policy, issuing tokens, writing receipts from the report, or running live side effects from the report.
- Operation admin readiness layer: derives Phase 69-70 MCP admin token-flow, generic harness bridge readiness, and approved admin-only agent execution bridge state from policy and registry metadata without issuing or storing tokens, dispatching the generic harness, or expanding MCP write/execute authority beyond agent execution plan/run.
- Operation provider readiness layer: derives Phase 71-78 provider MCP plan, bounded disclosure, env credential guard, approved admin-only fake/local/API execution exposure, and safe MCP status/list readiness from existing provider and MCP profile metadata without reading credential values, calling providers, executing local runners, or transferring evidence from the readiness report.
- Capture planning layer: reports required safety gates for screen, window, and desktop app capture without calling OS capture APIs, writing artifacts, reading pixels, enumerating processes, or changing MCP execution permissions.
- Capture handoff layer: reads an existing workspace image file for metadata and labels it as screen, window, or desktop app evidence without writing artifacts, exposing MCP tools, calling providers, or embedding raw pixels in JSON.
- Desktop review provider-preparation planning layer: reads capture handoff JSON metadata only and reports future review/preparation readiness without rereading image bytes, writing artifacts, exposing MCP tools, calling providers, transferring evidence, or mutating existing reviews.
- Standalone image review layer: reviews workspace-confined image files without launching a browser, embedding raw pixels in JSON, calling providers, uploading evidence, or changing MCP execution exposure.
- Identity audit layer: reads local identity metadata and local Git configuration to report canonical repository URL, legacy repository URL, checkout name, legacy alias, artifact-root migration, and rename-readiness boundaries without mutating Git, contacting remotes, launching browsers, or writing artifacts.
- Language settings layer: reads TraceCue-local dashboard settings, separates dashboard display locale from artifact output language, normalizes the supported 14-locale contract, reports source-language and translation boundaries, and exposes read-only CLI/API/MCP inspection without contacting parent repositories, writing files, launching browsers, or calling providers.
- Schema layer: defines stable JSON contracts for envelopes, artifacts, target manifests, findings, reports, and adapter I/O.
- Adapter layer: keeps CLI as the source of truth and exposes the same core through MCP adapters. Stdio preserves the compatibility profile surface, while explicit HTTP transport is limited to safe-profile loopback requests.
- Consumer usage guide: documents the external-repository connection flow for CLI, MCP stdio, safe HTTP MCP, and Codex plugin users without changing runtime permissions or requiring source inspection. It also documents target runtime readiness so missing consumer API/backend services are interpreted as target-state findings rather than Browser Debug CLI connection failures.

## Planned CLI Surface

The Phase 2a command surface is:

```text
browser-debug doctor
browser-debug session start
browser-debug session close --session <id>
browser-debug observe --url <url> --json
browser-debug supervise --url <url> --actions <json-array> --json
browser-debug daemon start --url <url> --json
browser-debug daemon status --daemon <id> --json
browser-debug daemon stop --daemon <id> --json
browser-debug resource status --json
browser-debug resource artifacts plan --json
browser-debug resource artifacts cleanup --dry-run --json
browser-debug resource artifacts cleanup --execute --json
browser-debug agent surfaces list --json
browser-debug agent package --review-index <review-artifact-index> --surface <surface-id> --json
browser-debug agent requests list --json
browser-debug agent requests show --package <agent-package> --json
browser-debug agent workflow create --package <agent-package> --json
browser-debug agent workflow status --workflow <agent-workflow> --json
browser-debug agent workflow index --json
browser-debug agent workflow report --workflow <agent-workflow> --json
browser-debug agent execution plan --package <agent-package> --surface <surface-id> --provider <provider-id> --model <model-id> --json
browser-debug agent execution run --execution <agent-execution> --package <agent-package> --surface <surface-id> --provider <provider-id> --model <model-id> --execute --json
browser-debug agent execution status --execution <agent-execution> --json
browser-debug agent execution list --json
browser-debug playwright-test status --json
browser-debug playwright-test mode --mode disabled|import_only|local_run|external_ci --confirm set-playwright-test-mode --json
browser-debug playwright-test import --input <playwright-test-artifact> --confirm import-playwright-test-result --json
browser-debug playwright-test review-material --result <id|path> [--baseline <id|path>] --json
browser-debug playwright-test local plan [--cwd <workspace-dir>] [--config <workspace-config>] [--reporter <reporter>] --json
browser-debug playwright-test local run --plan <plan-json> --plan-hash <sha256> --execute --json
browser-debug playwright-test external-ci readiness --repo <owner/repo> --json
browser-debug playwright-test external-ci list --repo <owner/repo> --json
browser-debug playwright-test external-ci view --repo <owner/repo> --run-id <number> --json
browser-debug playwright-test external-ci fetch --repo <owner/repo> --run-id <number> --artifact-name <name> --confirm fetch-playwright-test-ci-artifact --execute --json
browser-debug playwright-test external-ci approve-settings --repo <owner/repo> --artifact-name <name> --confirm approve-playwright-test-ci-settings --json
browser-debug playwright-test external-ci resolve-approved --json
browser-debug playwright-test external-ci fetch-approved --confirm fetch-approved-playwright-test-ci-artifact --execute --json
browser-debug agentic review propose --brief <request> [--review-index <review-artifact-index>] [--human-baseline <owner-baseline-json>] [--video-evidence <video-evidence-json>] [--content-evidence <content-evidence-json>] [--source-text <workspace-text-or-json>] [--effort quick|standard|deep|xhigh] --json
browser-debug agentic review plan --review-index <review-artifact-index>|--proposal <agentic-review-proposal> [--human-baseline <owner-baseline-json>] [--video-evidence <video-evidence-json>] [--content-evidence <content-evidence-json>] [--source-text <workspace-text-or-json>] [--intent <text>|--input <text|@file|->] [--effort quick|standard|deep|xhigh] --json
browser-debug agentic review provider-readiness [--provider <provider>|--proposal <proposal>|--plan <plan>] --json
browser-debug agentic review run --plan <agentic-review-plan> --plan-hash <sha256> [--allow-raw-pixels] [--allow-page-text] [--allow-url] [--allow-artifact-refs] [--allow-accessibility-summary] --execute --json
browser-debug agentic review run --plan <agentic-review-plan> --plan-hash <sha256> --execution-mode staged [--allow-raw-pixels] [--allow-page-text] [--allow-url] [--allow-artifact-refs] [--allow-accessibility-summary] --execute --json
browser-debug agentic review report-quality --result <agentic-review-result> [--execution <agentic-review-execution>] --json
browser-debug agentic review benchmark list --json
browser-debug agentic review benchmark show --case <benchmark-case-id> --json
browser-debug agentic review dogfood readiness --json
browser-debug agentic review dogfood plan --case <benchmark-case-id> --json
browser-debug agentic review dogfood evidence-pack summarize --input <dogfood-evidence-pack-or-evidence-set> --json
browser-debug agentic review dogfood evidence-pack review-pack --input <dogfood-evidence-pack-or-evidence-set> --json
browser-debug agentic review calibrate --result <agentic-review-result> --case <benchmark-case-id> --json
browser-debug agentic review compare --baseline <agentic-review-result-or-reference-review> --candidate <agentic-review-result> [--comparison-kind direct-vs-tracecue|editorial-quality] --json
browser-debug agentic review compare batch --dataset <agentic-evidence-set> --json
browser-debug agentic review evidence-set validate --input <agentic-evidence-set> --json
browser-debug agentic review evidence-set summarize --input <agentic-evidence-set> --json
browser-debug agentic review evidence-set regenerate plan --evidence-set <agentic-evidence-set> --claim-gate <claim-standard-gate> [--target-registry <regeneration-target-registry>] --json
browser-debug agentic review human-baseline registry [--input <human-baseline-registry>] --json
browser-debug agentic review human-baseline overlay --case <benchmark-case-id> [--registry <human-baseline-registry>] [--input <case-overlay>] --json
browser-debug agentic review human-baseline draft --overlay <case-overlay> [--registry <human-baseline-registry>] --json
browser-debug agentic review human-baseline approval --draft <baseline-draft> --decision approved|needs-edits|rejected [--approver <id>] [--approved-at <iso8601>] [--edit-diff <summary>] --json
browser-debug agentic review human-baseline validate --input <owner-labeled-human-baseline> --json
browser-debug agentic review human-baseline compare --baseline <owner-labeled-human-baseline> --result <agentic-review-result> [--case <benchmark-case-id>] --json
browser-debug agentic review human-baseline claim-readiness --evidence-set <agentic-evidence-set> [--policy <claim-policy>] --json
browser-debug agentic review evaluator policy [--input <evaluator-policy>] --json
browser-debug agentic review xhigh plan --plan <agentic-review-plan> --json
browser-debug agentic review xhigh simulate --plan <agentic-review-plan> --round-input <xhigh-round-input> --json
browser-debug agentic review quality longitudinal --evidence-set <agentic-evidence-set> --json
browser-debug agentic review quality source-text --standard <agentic-review-result> --deep <agentic-review-result> --xhigh <agentic-review-result> [--reference-review <workspace-text-or-json>] --json
browser-debug agentic review claim policy [--input <claim-policy>] --json
browser-debug agentic review claim standard-gate --evidence-set <agentic-evidence-set> [--policy <claim-policy>] --json
browser-debug agentic review claim audit --result <agentic-review-result> [--policy <claim-policy>] --json
browser-debug agentic review status --execution <agentic-review-execution> --json
browser-debug agentic review list --json
npm run ahr:responses-adapter -- --json
browser-debug visual review prepare --review-index <review-artifact-index> --json
browser-debug visual review run --preparation <preparation> --surface <surface> --provider <provider> --model <model> --execute --json
browser-debug visual review status --execution <visual-review-execution> --json
browser-debug visual review list --json
browser-debug visual review dashboard --json
browser-debug identity audit --json
browser-debug settings show --json
browser-debug settings language --json
browser-debug settings language policy --json
browser-debug visual review plan --capture-handoff <workspace-json|-> --json
browser-debug capture plan [--source screen|window|desktop-app|all] --json
browser-debug capture handoff --image <workspace-image> --source screen|window|desktop-app --json
browser-debug agent ingest --package <agent-package> --input <agent-result-json> --json
browser-debug agent report --review-index <review-artifact-index> --agent-result <agent-result> --json
browser-debug target init --url <url> --json
browser-debug target validate --target <manifest> --json
browser-debug act --session <id> --action <json>
browser-debug report --session <id>
browser-debug spec export --session <id>
browser-debug review --url <url> --json
browser-debug review --target <manifest> --json
browser-debug schema list --json
browser-debug schema get --name <schema> --json
browser-debug mcp serve [--profile safe|full|admin]
browser-debug mcp serve --transport http --profile safe --host 127.0.0.1 --port <port>
browser-debug mcp config [--client generic|codex] [--profile safe|full|admin] --json
browser-debug mcp config --transport http --profile safe --host 127.0.0.1 --port <port> [--endpoint /mcp] [--token-env BROWSER_DEBUG_MCP_HTTP_TOKEN] --json
browser-debug mcp capabilities [--profile safe|full|admin|all] [--scope all|profiles|excluded] --json
browser-debug mcp execution gates [--operation <id>|all] [--profile safe|full|admin|all] --json
trace-cue operation registry [--operation <id>|all] [--group <id>|all] [--risk <id>|all] --json
trace-cue operation roadmap [--phase <n>|all] [--group <id>|all] [--risk <id>|all] --json
trace-cue operation contracts [--scope <id>|all] [--operation <id>|all] --json
trace-cue operation policy [--scope <id>|all] [--operation <id>|all] --json
trace-cue operation admin-readiness [--scope <id>|all] [--operation <id>|all] --json
trace-cue operation provider-readiness [--scope <id>|all] [--operation <id>|all] --json
```

The MVP implementation order is:

1. `doctor` with environment and safety checks.
2. Command parsing and deterministic JSON error output without launching a browser.
3. `observe --url <url> --json` with an ephemeral headless Playwright context.
4. Artifact directory handling under `.browser-debug/`.
5. Session start, explicit actions, reports, and spec export after one-shot observation is stable.

## Current Implemented Slice

The repository now includes a private local Node.js package named `trace-cue` with the canonical `trace-cue` executable at `bin/trace-cue.js` and legacy `browser-debug` aliases. The implementation is ESM-only and uses Playwright as its browser runtime dependency.

Implemented behavior:

- `browser-debug doctor --json` returns the standard JSON envelope and local environment checks.
- Parser errors return deterministic JSON envelopes when `--json` is used.
- Planned command names are parsed explicitly.
- `observe --url <url> --json` validates absolute `http`, `https`, or `file` URLs, launches an ephemeral Chromium context, captures structured page state, writes a local observation artifact, and closes the context.
- `observe --screenshot` writes a local screenshot artifact.
- `observe --trace` writes a local Playwright trace zip and emits a warning because traces can contain page content.
- `observe --headed` launches a visible browser mode when the host environment supports it.
- `observe --devtools` launches visible browser mode with DevTools enabled when the host environment supports it.
- `supervise --url <url> --actions <json-array>` launches one ephemeral Chromium context, applies ordered local actions in that same process-scoped context, writes observation metadata for the initial page and each action, writes local supervision metadata under `.browser-debug/sessions/`, and closes the context before process exit.
- `daemon start --url <url>` starts a detached local worker process with one ephemeral Chromium context, writes daemon metadata under `.browser-debug/daemons/`, writes an initial observation, and returns a daemon ID and process ID. `daemon status --daemon <id>` reads metadata and checks whether the process is alive. `daemon stop --daemon <id>` sends a local process signal and records the stopped state.
- `daemon start --idle-timeout <duration>` and `daemon start --max-lifetime <duration>` add optional lifecycle metadata and local worker timers that stop the daemon after inactivity or a fixed lifetime without external control channels.
- `resource status --json` reports local memory, swap, cgroup, pressure, and current process memory signals. It returns `data.resource_status`, recommendations, local safety boundaries, and warnings for elevated pressure without launching a browser, writing artifacts, mutating system cache, configuring swap, deleting files, uploading evidence, or reusing profiles.
- `resource artifacts plan --json` reports `.browser-debug/` usage, largest files, top-level directory totals, cleanup candidates, and local boundaries without deleting files.
- `resource artifacts cleanup --dry-run --json` reports the same cleanup proposal without deleting files. `resource artifacts cleanup --execute --json` deletes only selected regular files under the configured artifact root, preserves receipts, and writes an `artifact_cleanup_receipt` artifact.
- `agent surfaces list --json` returns provider-neutral local agent surfaces. Local subscription-agent surfaces are available for local handoff; the generic API provider surface is listed as approval-bound and does not execute network requests.
- `agent package --review-index <path> --surface <id> --json` reads an explicitly provided local review artifact index, creates `.browser-debug/agent-packages/<id>/packet.json`, `.browser-debug/agent-packages/<id>/prompt.md`, and an evidence-packet receipt. The package includes bounded triage, coverage, evidence-class, rerun, and local artifact-reference metadata only. It does not copy raw screenshot bytes, trace contents, raw DOM, console payloads, network payloads, reports, or sourceData values.
- `agent requests list --json` scans local `.browser-debug/agent-packages/` and `.browser-debug/agent-results/` metadata and reports whether each advisory package is `waiting_for_agent` or `advisory_imported`. `--package <path>` narrows the status to one workspace-relative package. The command is read-only, does not launch a browser, does not contact providers, does not upload evidence, does not store credentials, does not expose MCP agent execution, and does not mutate review artifacts.
- `agent requests show --package <path> --json` reads one workspace-relative package and returns package metadata, disclosure policy, local artifact-reference summaries, source review index metadata, selected/latest result paths, bounded advisory result summary, and dashboard handoff hints. `--agent-result <path>` can select a specific matching workspace-relative result. The command is read-only, writes no artifacts, does not launch a browser, does not contact providers, does not upload evidence, does not store credentials, does not expose MCP agent execution, and does not mutate review artifacts.
- `agent workflow create --package <path> --json` reads one workspace-relative package, writes `.browser-debug/agent-workflows/<id>/workflow.json` plus a workflow receipt, and records dashboard-oriented package, prompt, agent-review, ingest, report-pending, request status, and provider-boundary metadata. The manifest contains local references and bounded metadata only; it does not copy raw artifact bytes, execute agents, contact providers, upload evidence, store credentials, launch a browser, expose MCP agent execution, or mutate review artifacts.
- `agent workflow status --workflow <path> --json` reads one workspace-relative workflow manifest, recomputes current status from local package/result metadata, and reports `waiting_for_agent`, `advisory_imported`, or `package_missing` with dashboard handoff commands. The command is read-only and writes no artifacts.
- `agent workflow index --json` scans local `.browser-debug/agent-workflows/` manifests and returns aggregate workflow status counts, report-pending counts, and explicit provider boundary flags without writing artifacts, launching a browser, contacting providers, uploading evidence, storing credentials, exposing MCP agent execution, or mutating review artifacts.
- `agent workflow report --workflow <path> --json` reads one workflow status snapshot, writes a bounded Markdown summary under `.browser-debug/reports/`, and keeps deterministic review artifacts unchanged. It does not launch a browser, contact providers, upload evidence, store credentials, expose MCP agent execution, or mutate review artifacts.
- `playwright-test status --json` reports the current mode, latest imported or fetched result summary, approved external-CI settings, freshness, compact review projection, and advisory-only boundaries. `playwright-test mode` writes the mode only after the confirmation token. `playwright-test import` normalizes workspace-confined Playwright Test JSON/JUnit/HTML-reference artifacts into local result and receipt artifacts without launching browsers, spawning processes, contacting networks, or changing review gates. `playwright-test review-material` reads only normalized `playwright_test_result` artifacts, rejects raw Playwright/JUnit/HTML inputs, emits non-engineer review cards, evidence-quality limits, optional baseline comparison, and standard/deep/xhigh review-input blocks, and performs no provider/API/MCP/browser/CI execution. `playwright-test local plan` creates a bounded local run plan, and `playwright-test local run` executes only with `--execute` and the matching plan hash. `playwright-test external-ci list|view|fetch` uses read-only `gh run` inspection/download commands; exact fetch requires exact run id, exact artifact name, confirmation, and `--execute`. `playwright-test external-ci approve-settings|resolve-approved|fetch-approved` stores non-secret approved fetch policy, resolves the latest matching successful run through read-only `gh run list`, and downloads only after confirmation plus `--execute`; it scans the downloaded artifact, imports it locally, and never triggers, reruns, cancels, or writes remote CI state.
- `agentic review propose --brief <request> --json` writes a local non-executing proposal under `.browser-debug/agentic-human-review-proposals/`, translates conversational intent into a review scope, effort mode, role split, and transfer preview, and records that proposal output is not approval for execution or transfer.
- `agentic review plan --review-index <path>|--proposal <path> --json` reads an existing review artifact index or a verified proposal, writes a local Agentic Human Review package, plan, and planning receipt under `.browser-debug/`, explains the review scope in plain language, selects sub-agent roles by effort mode, records transfer permissions, and computes a fresh canonical plan hash without provider execution.
- `agentic review provider-readiness --json` reports provider catalog, environment-variable names, transfer policy, and approval gates without reading credential values, calling providers, transferring evidence, or writing artifacts.
- `agentic review run --plan <path> --plan-hash <sha256> --execute --json` validates the plan contract, stored hash, supplied hash, exact run command, provider/model/surface match, package hash, provider capability hash, exact transfer flags, and live dogfood opt-in when benchmark/dogfood provider-API execution is requested before running a configured agentic review adapter. It writes local execution, approval receipt, run receipt, advisory result, and Markdown report artifacts without storing raw provider responses or credentials, mutating deterministic review output, or exposing MCP execution. The generic API adapter is environment-variable configured, timeout/size bounded, and stores only normalized advisory output. Its optional request timeout override is part of the provider capability contract, so changing it requires a fresh approved plan hash before execution.
- `agentic review run --execution-mode staged` is valid only for approved `standard`, `deep`, and `xhigh` plans. It keeps the default one-shot command compatible while allowing a manually selected staged strategy for long dogfood runs. Each provider stage uses the existing env-only provider path and exact transfer boundary, stores no raw provider response, records only normalized stage metadata, and remains CLI-only. The final advisory is written only after deterministic aggregation under the original plan; incomplete staged output remains advisory and cannot authorize equality, superiority, release gates, or owner claim-readiness.
- `agentic review report-quality --result <path> [--execution <path>] [--evaluator-policy <path>] --json` validates the advisory contract, optionally verifies execution/result pairing, and returns completeness, evidence coverage, verification coverage, human-review coverage, structured benchmark requirement coverage, actionability, effort expectations, classified quality diagnostics, evaluator policy diagnostics, human-review maturity, longitudinal quality evaluation gaps, and warnings with no provider calls, writes, or gate changes. Missing dedicated critique or verification output is classified as an expected effort gap for efforts that do not plan those roles, while missing dedicated critique or verification remains a policy warning when the active effort requires the `xhigh` mechanical contract. The maturity block records current effort, benchmark case, live-provider dogfood evidence, missing standard/deep/xhigh evidence, missing benchmark cases, comparison/history requirements, and keeps human-equivalent and human-superior claim flags false.
- Agentic Human Review proposal, plan, package, rubric, advisory, and report-quality schemas now include `human_review_schema_version: "2.0.0"` where applicable. Plans include human review, provider instruction, and review benchmark contracts; packages include technical evidence and mechanical review summaries; advisory results include reader experience, mechanical-versus-human comparison, and human-review coverage.
- `agentic review benchmark list|show`, `agentic review calibrate`, `agentic review compare`, `agentic review compare batch`, `agentic review evidence-set validate|summarize|regenerate plan`, `agentic review human-baseline registry|overlay|draft|approval|validate|compare|claim-readiness`, `agentic review evaluator policy`, `agentic review xhigh plan|simulate`, `agentic review quality longitudinal`, `agentic review quality source-text`, `agentic review claim policy|standard-gate|audit`, `agentic review dogfood readiness`, `agentic review dogfood plan`, and `agentic review dogfood evidence-pack summarize|review-pack` are read-only calibration and dogfood planning surfaces. They use local benchmark case definitions, reusable rubric/templates, owner-labeled human baseline JSON, approval metadata, evidence-set manifests, dogfood evidence-pack manifests, supported TraceCue CLI/API runtime-result wrappers, claim-gate rerun plans, optional regeneration target registries, standard/deep/xhigh source-text result artifacts, and existing advisory results to report required-mention coverage, required-dimension coverage, owner-label coverage, target-specific must-not-miss coverage, structured evidence-backed record completeness, forbidden-claim detection, role/round coverage, source-understanding completion, source-text non-persistence, effort-specific editorial deltas, dissent handling, direct-vs-TraceCue mechanical-context gain, actionability, evaluator-policy gaps, batch deltas, longitudinal trends, claim readiness, benchmark-completion readiness, manual live-provider readiness, standard/deep/xhigh dogfood planning, benchmark-case matrix coverage, dogfood evidence-pack owner-review digest status, owner-facing review-pack status, grouped blockers, top owner actions, blocker categories for missing results, mechanical incompleteness, failed calibration, missing calibration cells, missing comparisons, claim-standard-gate pass/fail state, metric-level comparison regressions, claim-integrity failures, minimal rerun targets, evidence-regeneration dependency order, and safety-boundary status. AI baseline drafts are not proof, synthetic or fixture-only approval markers prevent owner-baseline verification, approved baselines require owner approval metadata, target-specific must-not-miss criteria must be linked to evidence-backed owner labels before `owner_labeled` can verify, owner-label coverage is scored from structured findings with local evidence references rather than loose text matches, forbidden-claim absence only scores when absence evidence is backed by local evidence references, and evidence sets report synthetic/local/fake origins separately from real-provider claim-numerator eligibility. The dogfood evidence-pack summary reports matrix status, owner-review context digest, claim-review status, and regeneration handoff without outputting detailed result paths, source paths, raw provider responses, credentials, full source text, chunk text, candidate/reference prose, or concrete rerun commands. The dogfood evidence-pack review pack reuses that summary and claim-gate data to report owner-facing status, standard/deep/xhigh matrix badges, blocker groups, top owner actions, trust/safety flags, and pathless advanced references without raw hash values, raw source/provider data, or concrete commands. The claim standard gate returns a failed command status when owner claim-review readiness does not pass and may emit command templates for minimal reruns; the evidence-set regeneration planner can convert those templates into dependency-ordered command plans, and provider-rerun templates are resolved only after validating an explicit approved-plan registry row or the generic result -> execution -> plan artifact chain, but both commands remain advisory-only and never mutate release gates or run the reruns themselves. These commands do not call providers, read credential values, write artifacts, launch browsers, mutate deterministic review output, or expose MCP tools.
- Evidence-set, human-baseline claim-readiness, longitudinal-quality, claim-standard-gate, and evidence-regeneration outputs may include optional `owner_review_context.source_text_quality` when the evidence set references a source-text effort-matrix quality artifact. This context is a whitelist projection for owner review only. It carries counts, status booleans, effort names, pass-condition summaries, output-safety summaries, and regeneration freshness by effort while omitting paths, raw hashes, private source identity values, source titles, locators, source text, chunk text, candidate or reference prose, provider responses, credentials, and rerun command execution. The projection cannot change evidence-set warnings, claim-readiness conditions, claim-standard blockers, pass/fail state, equality or superiority claim states, release gates, proof status, automatic rerun authority, or future claim numerators. Downstream consumers re-sanitize existing evidence-set output context before propagation, force unsafe provider/proof/claim/release/artifact-write/rerun authority flags to non-authoritative values, and expose the typed owner-context contract through the schema registry and schema files.
- Agentic Human Review packages include additive `visual_evidence_package_v2`, `visible_text_provenance`, `visible_text_reading_contract`, and `screen_text_understanding_contract` sections. They describe visual references, bounded visible text sources, screen-text review tasks, OCR boundaries, and raw-byte exclusion policy without embedding raw pixel bytes, raw DOM, raw report bodies, credential values, or raw provider responses.
- Agentic Human Review provider payloads apply approved transfer flags to both package-level and plan-level visual/text contracts. When `allow-page-text` is not approved, visible text snippets and provenance sources are replaced with zero-count transfer-safe contracts before a provider API request is built.
- Agentic Human Review results include Quality Evaluator v3, Human Report v3, live dogfood gate metadata, benchmark-completion readiness, and `xhigh_multi_round_review` completion metadata. These fields summarize human likeness, visual specificity, content reading, sensibility, specific fixes, safety boundary, reader story, retained value, lost value, priority fix, missing role/round/critique/synthesis output, and release-gate non-mutation while remaining advisory-only with `gate_effect: none`.
- Agentic Human Review report-quality results include `quality_warning_classification_version`, `quality_expectations`, `quality_diagnostics`, `quality_diagnostic_summary`, `quality_effort_notes`, and `policy_diagnostics` as optional additive fields. Existing `quality_warnings` remains a compatibility array of policy-warning or failure-risk messages; expected effort gaps stay visible in structured diagnostics and Markdown effort notes without being promoted into warning messages.
- Agentic Human Review plans, provider requests, adapter output validation, advisory results, report-quality output, xhigh planning/simulation, evidence-set summaries, human-baseline comparisons, claim-readiness diagnostics, and longitudinal quality rollups include an `xhigh` mechanical effort contract. The contract records provider-native effort binding, strict structured-output requirements, placeholder rejection, required role/round coverage, synthesis integration, structured benchmark records with local evidence-reference identifiers, repair-readiness metadata, multi-step execution readiness, and strict claim-numerator eligibility. A provider may still choose how to reason internally, but TraceCue counts `xhigh` proof-readiness only when these observable contract fields are satisfied.
- `npm run ahr:responses-adapter -- --json` starts the optional Agentic Human Review Responses adapter. It binds to a loopback host only, accepts exactly one configured path, requires the adapter bearer token from the configured environment variable, reads the upstream provider credential from a separate provider-key environment variable or fallback provider-key environment variable, rejects raw pixel bytes and local path disclosure, builds a Responses request with `store: false`, no provider tools, bounded JSON schema output, validates benchmark output, structured findings, owner-baseline coverage, and optional review claims against the request evidence-reference catalog and planned role contract, and returns normalized advisory JSON only. The adapter may recover from provider formatting wrappers by extracting one clear advisory JSON object from memory, but it rejects malformed, multiple, non-JSON-fenced, array, primitive, or non-advisory outputs without storing raw text. Invalid review claims are repairable only through bounded redacted retry context and are rejected again if they remain placeholder, unsupported, or evidence-missing. The adapter does not store raw provider responses, does not record credential values, does not mutate deterministic findings or release gates, and is not exposed through MCP.
- `agentic review status --execution <path> --json` and `agentic review list --json` read local Agentic Human Review execution metadata only. Generic `agent execution plan/run` rejects Agentic Human Review proposals and packages so this owner-layer contract cannot be bypassed through the older execution surface.
- `agent ingest --package <path> --input <json> --json` validates and normalizes untrusted agent output from inline JSON, stdin, or a workspace-relative `@file` into `agent_advisory`, `agent_advisory_findings`, `agent_advisory_action_plan`, `agent_advisory_readiness`, and `owner_decision_requests`. These outputs are separate from review `findings`, `metrics.finding_count`, existing `action_plan`, and `quality_signals.release_readiness`.
- `agent report --review-index <path> --agent-result <path> --json` writes a separate Markdown advisory report under `.browser-debug/reports/` without mutating existing review artifacts.
- `session start --url <url>` without persistent-session options preserves the legacy local metadata behavior and can attach the first observation.
- `session start --url <url> --ttl <duration> [--idle-timeout <duration>] [--origin-allowlist <origin-list>]` starts an opt-in persistent browser session backed by one retained Playwright context and page. Persistent session startup records metadata and receipts under the configured artifact root, enforces TTL and idle-timeout guards, and restricts navigation to the supplied or seed-derived origin allowlist.
- `session start --url <login-url> --headed --manual-checkpoint <name> --ttl <duration>` opens a headed persistent session for manual login handoff. TraceCue does not enter passwords, automate OAuth, or bypass authentication. Completion is recorded later by checkpoint conditions.
- `session start --storage-state <artifact-auth-json>` imports Playwright storageState only when the file resolves under the configured artifact auth directory. StorageState import is explicit, local, value-silent, and never a default.
- `session status --session <id>`, `session stop --session <id>`, `session act --session <id> --action <json>`, `session observe --session <id>`, `session checkpoint --session <id>`, and `session review --session <id>` operate on a persistent session without replacing the legacy `session close`, `act`, `report`, or `spec export` behavior.
- `act --session <id> --action <json>` supports simple local actions such as `navigate`, `observe`, `screenshot`, `click`, `fill`, `select`, `press`, `scroll`, and `wait`. Legacy metadata sessions use the existing ephemeral page visit path, while persistent sessions run actions against the retained page. Fill values are needed for execution but are not printed in outputs, specs, receipts, or action history.
- `session observe --session <id> [--screenshot]` observes the retained page and can write local screenshot evidence without destroying the session.
- `session checkpoint --session <id> --name <name> [--until-url <pattern>] [--until-selector <selector>] [--export-storage-state]` records manual-login or other handoff evidence from the retained page. Completion checks are bounded by timeout and record URL, timestamp, redacted summary, observation artifacts, and optional value-silent storageState export metadata.
- `session review --session <id> [--screenshot] [--report]` builds a local review handoff artifact index from the current retained page state without changing `review --url` behavior.
- `report --session <id>` writes a Markdown report.
- `spec export --session <id>` writes a JSON action/spec export.
- `review --url <url>` runs a single-URL deterministic local review, captures observation and layout evidence, optionally captures screenshots and mock metrics, writes review artifacts, and returns evidence-backed findings.
- `review --target <manifest>` runs a manifest-driven site review with generic route discovery, explicit expected-route execution, optional page expectation checks, viewport matrix execution, coverage artifacts, local review artifact indexes, and aggregated findings.
- `review --resource-guard advisory|fail-critical|off` controls additive local resource guard behavior. Advisory is the default. Fail-critical can stop before browser launch or skip remaining target work only when resource status is critical. Resource guard output does not change review findings, `metrics.finding_count`, existing `action_plan`, or `quality_signals.release_readiness`.
- `target init --url <url>` writes a reusable local target manifest artifact under `.browser-debug/targets/` with same-origin scope, seed route, empty expected route and page lists, viewport matrix, route budget, screenshot defaults, and safe local review boundaries.
- `target validate --target <manifest>` or `target validate --input -` loads a target manifest through the same normalization contract as target review, returns route/page/content UX counts, manifest-authoring suggestions, review next commands, and explicit local-first boundaries, and does not launch a browser, mutate the manifest, expose sourceData values, upload artifacts, or reuse profiles.
- Review results include `action_plan`, `review_advisory`, `quality_signals`, `evidence_summary`, and `artifact_index` objects. Target review results also include `manifest_suggestions`, and can include `local_content_ux_advisory`, `content_ux_findings`, `content_ux_action_plan`, `content_ux_readiness`, `content_ux_page_handoff`, `content_ux_manifest_authoring`, `content_ux_review_brief`, and `content_ux_rubric_evaluation` only when the target manifest explicitly enables it. `action_plan` prioritizes review findings, groups developer next actions, and reports a local release gate. Content UX action/readiness/page/authoring/brief/rubric output is separate and advisory-only. `review_advisory` is a local heuristic signal that summarizes browser health, rendered state, layout, accessibility, interaction, mock, and coverage concerns without claiming human or model aesthetic approval. `quality_signals` gives structured developer handoff data for visual hierarchy, rendered state, responsive layout, interaction affordance, accessibility structure, evidence completeness, local release readiness, route coverage, page expectations, optional content UX advisory, and the disabled model-review boundary. `artifact_index` points to a local artifact index JSON that groups evidence classes and rerun guidance.
- `schema list` and `schema get --name <schema>` expose machine-readable JSON contracts for envelopes, artifacts, findings, target manifests, review results, and MCP tool metadata.
- `browser-debug-mcp` provides a local stdio MCP adapter with an allowlisted tool surface over the same CLI/core contracts, including target manifest initialization, target manifest validation, local resource status preflight, local artifact usage planning, target review, and read-only local agent advisory/status inspection. It does not expose artifact cleanup execution, write-producing advisory commands, or agent execution run.
- `browser-debug-mcp --profile safe|full|admin` selects the MCP tool surface at launch. No-profile `browser-debug-mcp` and the packaged `.mcp.json` resolve to `full` for compatibility with the existing adapter. `safe` exposes no-browser/no-delete/no-provider tools only, including local agent surfaces, request status/detail, workflow status/index, and execution status/list. `full` may expose bounded process-scoped `browser_debug_supervise` but does not expose persistent sessions. `admin` is explicit and exposes only the approved stdio `agent execution plan/run` bridge and approved stdio persistent session tools beyond `full`; it does not expose cleanup execution, Agentic Human Review, unrelated provider/API execution, safe/full/HTTP persistent session control, shell, socket listeners, HTTP `full` or `admin`, external upload, provider credentials, existing-browser-profile reuse, or arbitrary process control.
- `browser-debug-mcp --transport http --profile safe --host 127.0.0.1 --port <port>` starts an explicit safe HTTP MCP endpoint. It binds only to loopback hosts, requires a bearer token from `BROWSER_DEBUG_MCP_HTTP_TOKEN` by default, validates loopback Host and Origin headers, limits request bodies, accepts one JSON-RPC object per POST, and uses the same safe-profile allowlist as stdio. It does not expose `full` or `admin` over HTTP.
- `browser-debug mcp config --json` emits reusable stdio MCP client configuration without launching a server, writing files, or reading credentials. Generated client config defaults to the `safe` profile; the packaged `.mcp.json` remains compatibility `full`; generated `local_checkout` metadata contains the current checkout's `node` launch command and absolute MCP entrypoint for unpublished local use.
- `browser-debug mcp config --transport http --profile safe --port <port> --json` emits token-free launch and client-connection metadata for the explicit safe HTTP MCP endpoint, including the URL, token environment variable name, authorization header placeholder, protocol version, body limit, safe-profile boundaries, and a `local_checkout.launch` alternative for unpublished local use.
- `browser-debug mcp capabilities --json` emits a read-only MCP capability policy report with profile tool surfaces, transport support, the current admin policy, explicit excluded operations, and boundary flags. It does not launch a server, write files, read token values, store credentials, or enable write/execute operations.
- `trace-cue operation registry --json` emits the shared read-only operation registry with roadmap groups, risk taxonomy, current MCP exposure flags, required gates, capability exclusion metadata, and boundary flags. It is the source for risky operation metadata used by `mcp capabilities` and `mcp execution gates`; registry presence does not authorize execution.
- `trace-cue operation roadmap --json` emits read-only draft phase A/B/C boundary contracts with phase, group, risk, sequence, related registry operations, approval-bound status, and no-live-execution boundary flags. It does not promote Phase 61-155 into product-plan commitments or authorize execution.
- `trace-cue operation contracts --json` emits the shared read-only Phase 61-64 operation contracts for risk taxonomy, plan/execute/receipt gate shapes, execute-token fields, receipt fields, selected registry operations, and no-live-execution boundary flags. It does not issue tokens, write receipts, enable a harness, or authorize execution.
- `trace-cue operation policy --json` emits the read-only Phase 65-68 operation policy and readiness report with admin policy defaults, selected registry operation context, contract references, CLI plan readiness, disabled harness state, safe MCP readiness, and no-live-execution boundary flags. It does not change policy config, issue tokens, write receipts, enable a harness, or authorize execution.
- `trace-cue operation admin-readiness --json` emits the read-only Phase 69-70 MCP admin readiness report with execute-token flow prerequisites, harness bridge prerequisites, selected registry operation context, admin policy requirements, approved agent execution bridge state, approval boundary flags, and no-live-execution boundary flags. It does not issue tokens, store tokens, expand MCP admin execution beyond the approved agent execution bridge, dispatch a generic harness, or authorize execution from the readiness report.
- `trace-cue operation provider-readiness --json` emits the read-only provider readiness report with Phase 71-78 provider MCP plan readiness, disclosure contract defaults, env credential guard names, approved admin-only fake/local/API execution exposure, safe MCP status/list contract metadata, selected registry operation context, and no-provider-call boundary flags for the report itself. It accepts registry operation ids and canonicalizes capability-id aliases such as provider API execution to the registry operation id. It does not read credential values, call providers, execute local runners, or transfer evidence from the readiness report.
- `trace-cue mcp execution gates --json` now derives operation entries from the shared operation registry while preserving read-only behavior and current MCP write/execute exclusion.
- `trace-cue settings show --json` and `trace-cue settings language --json` layer ignored `ops/DASHBOARD_SETTINGS.local.json` over tracked `ops/DASHBOARD_SETTINGS.json`, or use built-in defaults when neither exists. Explicit `--settings` input remains a single-file compatibility path. The commands keep dashboard display locale and artifact output language independent, normalize locale aliases, expose text direction and `Intl` locale metadata, and report translation execution as disabled.
- `trace-cue settings language policy --json` returns the supported 14-locale contract, separate `dashboard_display` and `artifact_output` roles, source/UI/explicit output modes, reserved translation modes, and local read-only boundary flags. It writes no files, launches no browser, calls no providers, reads no credentials, and does not contact the parent lesson repository.
- Review and visual review dashboard outputs include bounded `language_settings` metadata. The metadata does not translate source evidence, raw page text, selectors, URLs, logs, screenshots, traces, or report bodies, and it does not change deterministic findings, `metrics.finding_count`, existing action plans, quality signals, release readiness, artifact cleanup, or gates.
- `docs/workflow/CONSUMER_USAGE.md` is a packaged external-repository usage guide. It explains how to run the CLI from a consumer repository, how to generate MCP stdio and safe HTTP MCP setup metadata, how to treat the Codex plugin as a discovery wrapper, how to keep consumer target manifests and raw `.browser-debug/` artifacts local, and how to document target runtime/API prerequisites in the consumer repository.
- MCP profile selection happens at server launch or trusted adapter context, not per MCP request. `tools/list` and `tools/call` fail closed for invalid profiles or out-of-profile tool names.
- MCP `@file` structured input is workspace-confined. Absolute paths, parent traversal, symlink escapes, non-regular files, and oversized files are rejected for MCP requests. Normal CLI `@file` behavior is unchanged outside MCP-restricted contexts.
- Product identity metadata is explicit and reusable. The current package name, CLI bin name, MCP bin name, MCP server name, plugin name, display name, repository URL, and packaged skill path remain unchanged, but tests, package dry-run checks, and packed-install smoke derive expectations from the identity contract so a future approved rename can be implemented predictably.
- Browser screenshot capture now writes additive `visual_evidence` metadata records next to existing screenshot artifacts. The metadata includes dimensions, hashes, source kind, privacy flags, and local artifact references only.
- `agent execution plan` records now include `visual_review_provider_policy` planning metadata. This policy is not an execution path, never embeds raw pixels, never calls providers, never authorizes external evidence transfer, and remains excluded from MCP execution surfaces.
- `visual review prepare --review-index <path>` reads an existing local review artifact index and referenced visual evidence metadata, then writes `.browser-debug/visual-review-results/<id>/preparation.json` plus a receipt. The command produces a future `visual_review_result` template and disclosure contract without reading raw screenshot/image bytes, calling providers, transferring evidence, exposing MCP execution, or mutating existing review artifacts.
- `act --input -`, `supervise --input -`, `--action @file`, and `--actions @file` support shell-safe structured input while preserving inline JSON compatibility.
- `npm test` runs deterministic no-browser tests, including headed/devtools launch-mode regression through an injected Playwright browser type and architecture regressions for generic runtime boundaries, shared page evidence helpers, local daemon boundaries, and local Node CLI packaging. `npm run test:browser` runs Playwright smoke tests for observation, screenshots/traces, click actions, form controls, keyboard input, scroll, wait, reports, spec export, supervised ordered actions, and local daemon start/status/stop.
- `npm run test:pack` runs `npm pack --dry-run --json` with an identity-derived `/tmp` npm cache path to verify the package file set without publishing.
- `.github/workflows/ci.yml` defines GitHub Actions jobs for Node.js checks, package dry-run verification, explicit Chromium installation, and browser smoke tests. It uses current GitHub action major versions for checkout and Node setup. `ops/CI_MANIFEST.tsv` and `tools/check_product_ci.sh` validate that definition locally.
- `npm run release:check` runs no-browser and package release-readiness checks without publishing. Browser smoke coverage remains a separate explicit local check because it launches Chromium.
- `CHANGELOG.md` and `docs/workflow/RELEASE.md` track unreleased local changes, release blockers, local readiness checks, and no-publish boundaries.

The package is marked `private` and `UNLICENSED` until public release naming, licensing, and npm publication are approved.

## Implemented Review Platform

The review platform is implemented as a reusable layer above the current Playwright runtime. It does not reimplement Playwright and does not clone the full Playwright MCP tool surface. It collects local browser evidence, normalizes that evidence, and emits developer-facing findings with explicit evidence and confidence.

Implemented review components:

- `playwright-runtime`: shared browser, context, page, action, screenshot, and trace execution.
- `evidence-model`: normalized DOM, accessibility, bounding box, computed style, console, network, viewport, and artifact evidence.
- `review-engine`: deterministic and bounded heuristic rules for browser health, rendered state, layout integrity, interaction quality, accessibility basics, mock fidelity, evidence quality, heading hierarchy, landmarks, image alt text, broken visible images, explicit or semantically marked lingering loading indicators, empty data containers, contrast, overlap, and mobile target sizing.
- `site-review`: target manifest loading, route discovery, viewport matrix execution, action risk policy, budgets, and coverage reporting.
- `reporter`: JSON and Markdown issue reports with artifact references, reproduction steps, prioritized action plans, developer triage summaries, manifest suggestions, local artifact indexes, local heuristic advisory data, and implementation-focused fix candidates.
- `content-ux-advisory`: pure local helper that reads normalized manifest data and target review summaries, then returns advisory source-to-screen, selector-scoped state, and user-question signals without Playwright, filesystem access, or artifact reads.
- `resource-status`: pure local preflight helper that reads process-visible memory, swap, cgroup, and pressure state without Playwright, shell execution, host mutation, artifact writes, or external transfer.
- `resource-guard`: reusable review guard that classifies local resource pressure before browser work and before each target route/viewport review.
- `resource-artifacts`: local artifact usage and explicit cleanup helper scoped to the configured artifact root with dry-run and receipt behavior.
- `schema`: machine-readable contracts for envelopes, findings, artifacts, target manifests, reports, and MCP tool I/O.
- `cli-adapter`: the primary command surface for review workflows.
- `mcp-adapter`: thin local MCP adapters over the same core through `browser-debug-mcp`; stdio remains the compatibility default, and HTTP is explicit, loopback-only, token-gated, and safe-profile-only.

The review MVP supports:

```text
browser-debug review --url <url> --viewport <name-or-size> --screenshot --json
```

It should produce the standard JSON envelope with `data.review`, `data.findings`, `data.metrics`, `data.action_plan`, `data.review_advisory`, `data.quality_signals`, additive `data.resource_guard`, and `data.environment`, plus artifact descriptors. Findings should include:

```text
id
category
severity
confidence
source
selector
rect
route
viewport
message
evidence
artifacts
repro
priority
impact
recommendation
fix_candidates
implementation_notes
owner_decision_required
```

The initial deterministic categories are:

- `browser_health`: console errors, page errors, failed requests, navigation failures, broken visible images, and timeout warnings.
- `layout_integrity`: empty render, horizontal overflow, clipped text, explicit lingering loading indicators, empty data containers without empty-state messaging, overlapping visible elements, zero-size important elements, and off-viewport primary controls.
- `interaction_quality`: actionability, focus visibility, hover/focus evidence, target size, mobile touch-target sizing, disabled state, and basic keyboard path signals.
- `accessibility_basics`: missing accessible names, unlabeled form controls, duplicate IDs, heading hierarchy issues, missing main landmarks, missing image alt text, low text contrast, and basic ARIA/name issues.
- `mock_fidelity`: optional screenshot-to-mock metrics, masked regions, and conservative inconclusive states.
- `evidence_quality`: missing screenshots, unstable captures, missing environment metadata, and review limitations.

The site review command supports a generic target manifest:

```text
browser-debug review --target <manifest> --json
```

The target manifest should describe:

```text
baseUrl
scope
seeds
expectedRoutes
pages
sourceData
localContentUxAdvisory
viewportMatrix
actionPolicy
budgets
artifacts
masks
regions
appHints
```

The runtime must not contain product-specific branches for individual applications, localhost ports, route names, menu labels, or page IDs. Those targets can be represented as local manifests, fixtures, or acceptance evidence outside the generic review runtime.

Route discovery is generic and uses same-origin anchors and navigation action candidates in the current implementation. Manifest `expectedRoutes` are also enqueued as explicit review targets, so owners can cover known routes that are not discoverable from the initial crawl. Optional manifest `pages` are also enqueued as review targets and can define `name`, `url` or `path`, `priority`, `viewports`, `expectations.text`, `expectations.selectors`, `expectations.dataBindings`, and optional page-level `mock` metrics. Coverage output reports expected, discovered, visited, skipped, failed, expected-missing routes, and page expectation checks. Queued routes or pages that cannot be reviewed because `budgets.maxRoutes` is exhausted are recorded as skipped with `reason=route_budget_exceeded`. Later enhancements may add history navigation, DOM metadata, redirects, and app-provided manifest hints without changing the core contract.

`target init` exists so a developer or agent can create a starting manifest before reviewing a whole application. The generated manifest is intentionally generic: it does not include application-specific route names or control labels, and it expects owners to add known `expectedRoutes`, `pages`, route budgets, viewport matrices, masks, or regions as needed. `target validate` exists as a no-browser authoring checkpoint after those edits. It reports normalized manifest counts and advisory authoring gaps without reading arbitrary source-data files or URLs, exposing sourceData values, launching Chromium, or writing changes back to the manifest. After editing, `expectedRoutes` and `pages` are review inputs, not just passive coverage expectations.

Action exploration should be risk-gated. The default policy may execute navigation and read-only state-revealing actions. Input-required, mutating, destructive, and external actions require explicit manifest allowlists and must remain local-first.

Mock comparison is optional. The current local implementation compares PNG dimensions, hashes, and byte-difference metrics without adding image-processing dependencies. If actual and mock dimensions differ, the result is `inconclusive` rather than a false pass/fail claim. Pixel heatmaps and region crops remain later compatible enhancements.

## Local Quality Signals Contract

`quality_signals` is an additive review output object. It is designed for developer triage and agent handoff, not final product approval. Single-URL review includes:

```text
visual_hierarchy
rendered_state
responsive_layout
interaction_affordance
accessibility_structure
evidence_completeness
developer_handoff
release_readiness
model_review_boundary
```

Target-manifest review includes:

```text
route_coverage
page_expectations
content_ux
viewport_coverage
rendered_state
finding_summary
evidence_completeness
developer_handoff
release_readiness
model_review_boundary
```

The `model_review_boundary` signal must remain `not_enabled` with `external_evidence_transfer=false` until a separately approved model or vision review layer exists. Local release readiness is a review gate over the current evidence only; it does not authorize package publication, license changes, marketplace registration, npm publication, or evidence upload.

For target reviews, `quality_signals.route_coverage` includes expected manifest route counts, visited route-viewport counts, skipped route counts, and route-budget-exceeded counts so agents can decide whether to raise the route budget, split a manifest, or rerun the review. `quality_signals.page_expectations` includes expected page counts, checked pages, failed pages, skipped pages, missing text expectations, and missing selector expectations so agents can identify page-state mismatches before human or model approval. `quality_signals.content_ux` is present only for manifest opt-in advisory runs and summarizes source-to-screen, selector-scoped binding, and required user-question advisory counts without affecting release readiness. `quality_signals.rendered_state` summarizes broken-image, loading-indicator, and empty-container findings across visited route viewports.

`manifest_suggestions` is an additive target-review output. It suggests manifest-only improvements such as adding named page expectations, pinning important expected routes, raising or splitting exhausted route budgets, reviewing failed page expectations, and adding fixtures or page expectations for rendered-state gaps. Suggestions are advisory and never mutate manifest files automatically.

## Local Content UX Advisory Contract

`local_content_ux_advisory` is an additive target-review output. It is emitted only when a target manifest declares `localContentUxAdvisory.enabled=true`. Absent or disabled configuration keeps target review output compatible with previous behavior.

The manifest contract is:

```text
sourceData
localContentUxAdvisory.enabled
localContentUxAdvisory.audience
localContentUxAdvisory.goal
localContentUxAdvisory.checks
localContentUxAdvisory.requiredUserQuestions[]
localContentUxAdvisory.reviewBrief
localContentUxAdvisory.rubric[]
pages[].role
pages[].expectations.dataBindings[]
pages[].expectations.userQuestions[]
```

`sourceData` supports bounded inline JSON entries with `id`, `data`, optional `required`, and optional `maxSizeBytes`. The local implementation does not read arbitrary manifest paths or remote source URLs. If a source entry declares a `path` or `url`, the advisory records that the external reference was ignored and asks the owner to provide bounded inline data or approve a future loader design.

Each `dataBindings` entry can declare `id`, `sourceId`, JSON Pointer `pointer`, optional `selector`, `target`, `attribute`, `match`, `severity`, and `required`. `target="text"` checks either reviewed page text or selector-scoped element text when `selector` is provided. `target="attribute"` requires a selector and an attribute name from the bounded element-evidence allowlist. `target="data-state"` checks selector-scoped state attributes such as `data-state`, `data-status`, `aria-current`, `aria-selected`, `aria-expanded`, or `aria-pressed`. `target="data-risk"` checks selector-scoped risk attributes such as `data-risk`, `data-severity`, `aria-invalid`, or `aria-disabled`.

`requiredUserQuestions` and page-level `userQuestions` can declare `id`, `question`, optional `pageId`, optional `selector`, `expectedEvidence`, `matchMode`, `textMatch`, `severity`, and `required`. The advisory checks whether the reviewed page text or selector-scoped element text contains enough evidence for the target user to answer the declared question. This is a local heuristic information-architecture signal, not subjective product approval.

`reviewBrief` can declare `summary`, `userRoles`, and `decisionNeeds[]`. `rubric[]` can declare `id`, `category`, optional `pageId`, optional `selector`, `criterion`, `expectedEvidence`, `matchMode`, `textMatch`, `severity`, and `required`. Manifest pages can declare a generic `role` such as `status_overview`, `triage_detail`, or `decision_gate`. The local advisory evaluates decision needs and rubric criteria against reviewed page text or selector-scoped element text, but it does not copy expected evidence values or source values into report output.

The output includes status, counts, advisory signals, separate `content_ux_findings`, separate `content_ux_action_plan`, separate `content_ux_readiness`, separate `content_ux_page_handoff`, separate `content_ux_manifest_authoring`, separate `content_ux_review_brief`, separate `content_ux_rubric_evaluation`, source-data availability counts, user-question counts, limitations, and `quality_signals.content_ux`. It does not copy source values, full page text, raw DOM, screenshots, console payloads, or network payloads into the advisory output or Markdown report. It is advisory-only: it must not create review findings, change `metrics.finding_count`, change the existing `action_plan`, change `quality_signals.release_readiness`, or authorize external evidence transfer.

`content_ux_findings` are not entries in the existing `findings` array and do not use the review finding schema. They are bounded developer-handoff records derived from local advisory signals with category, severity, confidence, source signal, selector/page context, sanitized evidence summary, recommendation, and `gate_effect="none"`. `content_ux_action_plan` groups those advisory records into content-owner next actions and sets `legacy_action_plan_unchanged=true`. `content_ux_readiness` summarizes advisory-only readiness and sets `legacy_release_readiness_unchanged=true`, `blocking_release_gate=false`, and `external_evidence_transfer=false`.

`content_ux_findings.category` can include `content_contract`, `source_data_alignment`, `status_clarity`, `information_architecture`, `action_clarity`, `navigation_clarity`, `coverage_contract`, or `review_scope`. Existing manifests that declare `workflow_state_clarity` or `next_action_clarity` as rubric categories remain accepted as legacy-compatible aliases, but generated templates and default advisory findings use the domain-neutral category names. `content_ux_page_handoff` groups advisory findings by manifest page, including page status, finding count, top categories, and bounded top findings. `content_ux_manifest_authoring` suggests manifest-only improvements such as declaring audience or goal, adding inline source data, adding page data bindings, adding user questions, fixing binding pointers, or strengthening action and navigation contracts. These suggestions are advisory and never mutate the manifest automatically.

`content_ux_review_brief` summarizes declared audience, page roles, and decision needs. `content_ux_rubric_evaluation` summarizes rubric criteria by category and records passed, owner-review, and inconclusive criteria. Both are local, advisory-only, additive, and separate from review findings and release readiness.

## Local Artifact Index Contract

Each review writes a local `review_artifact_index` JSON artifact under `.browser-debug/review-artifacts/`. The index records the review ID, review mode, artifact root, artifact descriptors, evidence classes, triage summary, coverage summary when available, rerun guidance, and local safety boundaries. The index is a handoff aid only; it does not upload evidence, delete artifacts, reuse browser profiles, store credentials, or authorize publication.

## Local Resource Status Contract

`resource status` is a no-browser preflight command for planning browser-heavy work. It reads process-visible system memory, swap, cgroup memory limits, Linux memory pressure data when available, and current Node.js process memory. The standard JSON envelope includes `data.resource_status.status`, memory snapshots, cgroup snapshots, pressure snapshots, process memory, thresholds, recommendations, a `cache_policy`, and explicit local boundaries.

The command status reflects successful inspection, while `data.resource_status.status` can be `ok`, `watch`, or `critical`. `watch` and `critical` produce warnings and recommendations such as reducing route or viewport budgets, splitting manifests, validating target manifests before browser review, capturing screenshots and traces selectively, and stopping unneeded Browser Debug CLI daemons. These are planning signals, not deterministic product gates.

The command must not launch a browser, write artifacts, upload evidence, reuse browser profiles, mutate system cache, change swap configuration, delete files, execute shell commands, run privileged helpers, or control arbitrary processes. Any future host cleanup, swap configuration, cleanup outside the configured artifact root, or privileged memory operation requires a separate approved design, security documentation, tests, and operator approval.

## Local Resource Guard and Artifact Safety Contract

`review --resource-guard advisory|fail-critical|off` reuses the local resource status contract. It records preflight checks before single-URL review and route/viewport checks during target review. Advisory is the default and emits warnings only. Fail-critical can stop browser launch or skip remaining target work only when the resource status is critical. The output is additive under `data.resource_guard` and must not change review findings, `metrics.finding_count`, existing `action_plan`, or `quality_signals.release_readiness`.

`resource artifacts plan` inventories the configured artifact root and returns summary totals, top-level directory totals, largest files, cleanup candidates, and no-delete boundaries. `resource artifacts cleanup --dry-run` returns the same proposal without deleting files. `resource artifacts cleanup --execute` deletes selected regular files only under the configured artifact root and writes a local receipt under `receipts/`. It does not follow symlinks, mutate system cache, configure swap, execute shell commands, use privileged helpers, upload evidence, reuse profiles, control arbitrary processes, or expose cleanup execution through MCP.

## Agent Advisory Handoff Contract

The agent advisory layer is a local handoff/import contract for subscription-capable local agents and a future API-provider boundary. It is not direct model/API execution and is not a deterministic review gate.

The surface registry uses provider-neutral records:

```text
id
kind: subscription_surface | api_provider
transport: local_files | local_stdio | provider_api
status: available | approval_required | disabled
external_evidence_transfer
credential_mode
implemented
capabilities
boundaries
```

`local-subscription-agent` and `local-stdio-agent` are available local surfaces. `generic-api-provider` is an approval-bound boundary marker only; it does not contact a provider, require credentials, upload evidence, or send artifacts outside the local process.

`agent_task_package` records:

```text
source review artifact index
surface
disclosure_policy
evidence_packet
prompt metadata
local safety boundary
```

The disclosure policy defaults to metadata and local artifact references only. Raw screenshots, trace contents, raw DOM, console payloads, network payloads, sourceData values, and report bodies are excluded by default. The command writes content-free receipts with hashes, included evidence classes, sensitive artifact reference types, and explicit `api_call_performed=false`.

`agent_request_status` records:

```text
package id, package path, prompt path, receipt path
source review artifact index and review id
task and surface
status: waiting_for_agent | advisory_imported
imported result paths and latest result path
advisory finding count and owner decision request count
local safety boundary flags
```

The request status command is a local index over package/result metadata. It does not execute an agent, call a provider API, upload evidence, store credentials, mutate review artifacts, or change deterministic gates.

`agent_request_detail` records one request's local handoff detail:

```text
package path, prompt path, receipt path
status and selected/latest result paths
source review artifact index metadata
package disclosure policy and local artifact-reference summary
bounded advisory finding/action/owner-decision counts
dashboard handoff hints and local safety boundary flags
```

The request detail command is read-only over local package/result metadata. It does not write artifacts, execute an agent, call a provider API, upload evidence, store credentials, mutate review artifacts, or change deterministic gates.

`agent_workflow` records one local dashboard or automation handoff workflow:

```text
workflow id, name, path, receipt path, and evaluated time
package path, prompt path, request status, and request detail
step state for package, agent review, ingest, and report
dashboard handoff commands for status, index, ingest, and report
provider boundary flags
local safety boundary flags
```

Workflow create writes only local workflow metadata and a receipt under `.browser-debug/`. Workflow status and index are read-only over workflow/package/result metadata. Workflow report writes a bounded local Markdown status summary. These commands do not execute an agent, call a provider API, upload evidence, store credentials, mutate review artifacts, expose MCP agent execution, or change deterministic gates.

`agent_advisory_result` records imported advisory output as untrusted text. It may include visual design, content information architecture, user journey, mock interpretation, implementation diagnosis, accessibility advisory, and evidence-quality categories. It must set `gate_effect="none"`, `legacy_action_plan_unchanged=true`, `legacy_release_readiness_unchanged=true`, and `blocking_release_gate=false`. Imported advisory output must never execute shell commands, browser actions, file edits, cleanup, publication, dependency changes, manifest mutations, or external uploads.

## Agent Execution Contract

The agent execution layer is an additive bridge from local packages to local subscription runners or API provider adapters. The current implementation covers the no-network dry-run plan, explicit run parser/API surface, dedicated provider adapter registry, deterministic fake provider, configured local runner callback boundary, env-only generic API provider adapter, local status, and local list contract. This layer is not a replacement for review, workflow, ingest, or report commands. It must keep the existing package, workflow, ingest, report, resource, daemon, cleanup, and review contracts intact.

`agent_execution` records:

```text
execution id, name, path, receipt path, created time, updated time
package path, prompt path, source review artifact index, workflow path
surface id, surface kind, provider id, model id, runner id
mode: dry_run_plan | run
status: planned | running | completed | failed | blocked
step state for plan, runner/provider call, advisory normalization, ingest, and report
advisory result path, normalized result summary, and dashboard handoff commands
credential requirement names and credential source labels without values
disclosure policy, evidence transfer policy, and artifact class summary
boundary flags and gate effect
```

The dry-run command:

```text
browser-debug agent execution plan --package <agent-package> --surface <surface-id> --provider <provider-id> --model <model-id> --json
```

is the default no-network operation. It validates the package, resolves the surface, records the disclosure policy, records provider/model selection metadata, and writes local plan metadata plus a receipt under `.browser-debug/agent-executions/`. It sets `api_call_performed=false`, `external_evidence_transfer=false`, `automatic_upload=false`, `credential_values_recorded=false`, `credential_storage="none"`, `persistent_credential_storage=false`, `raw_response_stored=false`, `raw_provider_response_stored=false`, `existing_review_mutated=false`, and `gate_effect="none"`. When invoked through stdio MCP `admin`, it also records `mcp_execution_exposed=true` and a hashed idempotency key; direct CLI plans keep `mcp_execution_exposed=false`.

The run command:

```text
browser-debug agent execution run --execution <agent-execution> --package <agent-package> --surface <surface-id> --provider <provider-id> --model <model-id> --execute --json
```

requires a prior dry-run execution record and an explicit `--execute` flag, and fails deterministically without either. Runtime validation rejects package, surface, provider, or model mismatches between the run request and the dry-run plan. The provider adapter registry is dedicated to agent execution and is not reachable from review, resource, daemon, cleanup, Playwright, visual review, or shell paths. The stdio MCP `admin` execution tools reuse this same CLI/core path instead of implementing a separate provider adapter path.

Implemented providers:

- `fake-agent`: deterministic local provider for no-browser provider success/failure and dashboard contract coverage. It performs no API call or external transfer.
- `local-runner`: configured local runner callback boundary for subscription-style execution. It uses provider/model identifiers and package API context callbacks, not free-form shell input or SaaS web UI automation.
- `subscription-cli`: audited fixed CLI adapter boundary for an already-authenticated supported CLI. It binds exact provider, model, provider-native effort, and executable identity; accepts no free-form executable, command, argv, environment, endpoint, or credential input; and returns normalized advisory data under the same Agentic Human Review contract.
- `generic-api-provider`: one-shot provider API adapter. It reads endpoint and credential values only from `BROWSER_DEBUG_AGENT_API_ENDPOINT` and `BROWSER_DEBUG_AGENT_API_TOKEN`, never from CLI arguments, committed files, package artifacts, workflow files, reports, receipts, `.env` auto-loading, or persistent local storage. Tests use injected transports rather than live network calls.

Execution may send only bounded package and prompt content allowed by the disclosure policy. By default, it must not transfer raw screenshots, trace contents, raw DOM, console payloads, network payloads, sourceData values, report bodies, cookies, storage state, existing browser profile data, or raw review artifacts. API execution must record that an API call occurred and which bounded evidence classes were sent, but it must not store raw provider responses. Runner/provider output is normalized into `agent_advisory_result` and remains untrusted advisory data.

MCP exposure is limited to stdio `admin` tools `browser_debug_agent_execution_plan` and `browser_debug_agent_execution_run`. The run tool requires `execute: true`, package/surface/provider/model arguments, an idempotency key, and a matching prior execution plan. The MCP layer rejects unknown tool arguments so credentials, endpoint values, tokens, or environment values cannot be supplied as MCP arguments. Safe, full, and HTTP MCP profiles do not expose these execution tools.

`agent execution status --execution <path> --json` reads one local execution record and reports current state, normalized advisory result path, missing credential hints, receipt paths, dashboard handoff commands, dashboard status fields, and boundary flags. `agent execution list --json` scans local execution records and returns aggregate planned/running/completed/failed/blocked counts, advisory-result counts, and boundary flags for dashboards and local automation. Status and list are read-only and must not launch browsers, call providers, upload evidence, store credentials, write review artifacts, or change deterministic gates.

The planned layer keeps dashboard user experience aligned across subscription and API modes:

```text
agent package -> agent execution plan/run -> agent execution status/list -> agent ingest/report -> agent workflow status/index/report
```

It does not change review `findings`, `metrics.finding_count`, existing `action_plan`, `quality_signals.release_readiness`, `resource_guard`, artifact cleanup behavior, target manifest behavior, or existing `agent_workflow` status meanings.

## Agentic Human Review Responses Adapter Contract

The Responses adapter is a local bridge for manual Agentic Human Review dogfood. It is started separately from the main CLI execution flow with `npm run ahr:responses-adapter`. The existing `agentic review run` command still owns proposal, plan, plan-hash, transfer-flag, `--execute`, receipt, advisory normalization, and report-quality semantics.

The generic provider endpoint should point to the loopback adapter URL. The adapter then converts the TraceCue request into a Responses-compatible provider request and dispatches it upstream. This keeps upstream provider details, model choice, endpoint override, and provider credential loading out of the approved AHR plan/run artifact contract.

Adapter configuration is environment-variable and option driven:

- `AGENTIC_HUMAN_REVIEW_API_TOKEN`: local adapter bearer token expected from TraceCue's generic provider call.
- `AGENTIC_HUMAN_REVIEW_OPENAI_API_KEY`: preferred upstream provider key environment variable for the adapter.
- `OPENAI_API_KEY`: fallback upstream provider key environment variable for developer convenience.
- `AGENTIC_HUMAN_REVIEW_OPENAI_MODEL`: upstream model name when the approved plan does not supply a usable model id.
- `AGENTIC_HUMAN_REVIEW_OPENAI_RESPONSES_ENDPOINT`: optional upstream endpoint override for compatible providers.
- `AGENTIC_HUMAN_REVIEW_API_ENDPOINT`: generic provider endpoint; for this flow it should be the adapter loopback URL.
- `AGENTIC_HUMAN_REVIEW_API_TIMEOUT_MS`: optional positive-integer timeout for the TraceCue generic provider request. The default remains 30000 ms.
- Adapter `--timeout <ms>`: optional positive-integer timeout for the adapter's upstream provider request. This is intentionally separate from `AGENTIC_HUMAN_REVIEW_API_TIMEOUT_MS`; long live dogfood runs must align both values explicitly. The adapter startup output must report the effective timeout without printing credential values.

For long loopback dogfood, TraceCue's generic provider path, the Responses adapter's upstream provider path, and the packaged adapter CLI startup path use a repository-local bounded HTTP(S) transport by default instead of relying on bundled fetch transport defaults. The transport is still timeout, redirect, response-size, and credential-disclosure bounded by the existing provider contracts; injected test transports remain supported. This prevents a hidden client header-timeout default from ending an approved slow dogfood run before the configured `AGENTIC_HUMAN_REVIEW_API_TIMEOUT_MS` or adapter `--timeout` value.

Boundary behavior:

- The adapter binds only to loopback hosts and rejects non-loopback Host or Origin headers.
- The adapter accepts POST requests only on the exact configured path.
- The inbound adapter bearer token is never forwarded upstream; the upstream Authorization header uses the separate provider key.
- Provider model resolution is source-aware and fail-closed. The adapter resolves the upstream model from explicit adapter configuration, then the provider model environment variable, then the approved TraceCue request model. Abstract or local-only placeholder ids such as `generic-agentic-review-model`, fake-provider models, and injected-runner models are rejected before provider fetch, and diagnostics report only the source, env name, requested id, blocked id, and effective id when available.
- Raw pixel bytes, local plan paths, local execution paths, and local filesystem references are rejected or stripped before provider dispatch.
- The provider request sets `store: false`, sends no provider tools, requests JSON advisory output, and treats all page/evidence text as untrusted evidence.
- Benchmark-enabled provider output must include exact required-mention, required-dimension, and forbidden-claim records with non-empty evidence and evidence-reference ids from the request catalog. Unknown evidence-reference ids are not converted into local references.
- Forbidden-claim records are absence records. A `present=false` value means the forbidden claim is absent from the advisory output; coverage-style fields such as `covered` do not make the forbidden claim present unless the record explicitly says the claim was detected.
- Bounded contract repair retries may request a complete replacement advisory object when benchmark or `xhigh` mechanical fields are incomplete, but repair retries do not expand transfer permission, provider authority, credential handling, raw response storage, or claim permission.
- Provider responses are parsed in memory, size bounded, normalized to advisory JSON, redacted, and not stored as raw provider responses.
- Upstream provider request failures may report only allowlisted diagnostics such as timeout, duration, failure class, and safe cause/code metadata. They must not print stack traces, credential values, raw provider responses, provider request bodies, or credential-bearing endpoints.
- Adapter output remains advisory-only with `gate_effect: none`; it does not mutate deterministic findings, metrics, release gates, existing review artifacts, MCP permissions, or visual review artifacts.

The TraceCue `generic-api-provider` descriptor exposes a separate model-resolution contract:

```text
default_model: provider-neutral abstract placeholder
abstract_model_ids: provider-declared non-executable placeholders
runtime_model_env: environment variable name for a concrete upstream model
model_resolution_policy: explicit plan/run model or runtime model env required for live adapter execution
```

`agentic review plan` may preserve an abstract default model for provider-neutral planning and plan-hash review. `agentic review run` resolves the effective provider model before building the API payload. If the approved plan/run model is abstract and the runtime model environment variable is not configured, the run fails with `AGENTIC_REVIEW_PROVIDER_MODEL_UNRESOLVED` before fetch, before provider calls, and before evidence transfer. Successful runtime-env fallback records `model_resolution` in the provider payload, execution record, run receipt, and advisory result without recording credential values or raw provider responses.

## MCP Adapter Contract

MCP compatibility is implemented as an adapter, not as the product owner layer. The CLI remains the complete source of truth.

The stdio MCP adapter:

- Uses local process stdio communication.
- Preserves compatibility by resolving no-profile `browser-debug-mcp` and packaged `.mcp.json` launches to the `full` profile.
- Calls the same CLI/core contracts used by local commands.
- Exposes profile-selected allowlists from the reusable profile registry.
- Returns the same envelope families as the CLI.

The safe HTTP MCP transport:

- Is launched explicitly with `browser-debug-mcp --transport http --profile safe --host 127.0.0.1 --port <port>`.
- Binds only to loopback hosts and rejects non-loopback bind hosts.
- Requires a bearer token from `BROWSER_DEBUG_MCP_HTTP_TOKEN` by default. Token values are never returned in public metadata or error responses.
- Validates Host and Origin headers as loopback when present.
- Limits request body size and accepts one JSON-RPC object per POST in this phase.
- Returns `MCP-Protocol-Version: 2025-06-18` with JSON responses.
- Exposes only the same safe-profile tool surface as stdio.

The MCP client configuration helper:

- Is launched through `browser-debug mcp config --json`.
- Produces reusable JSON for humans, shell scripts, Codex, and other MCP-capable agents.
- Uses `browser-debug-mcp` as the package-level command in generated examples.
- Includes `local_checkout` metadata with the current package root, MCP bin path, and `node`-based launch/config objects for agents that are using a local checkout before publication or installation.
- Defaults generated stdio client configuration to the `safe` profile; packaged `.mcp.json` remains the compatibility `full` profile.
- Defaults generated HTTP client configuration to safe profile, loopback host, `/mcp`, `BROWSER_DEBUG_MCP_HTTP_TOKEN`, and a fixed local client port suitable for external MCP client settings.
- Does not launch a listener, mutate files, contact the network, read token values, print token values, or create credentials.
- Reports `token_env` and placeholder authorization header syntax only.

The MCP capability policy helper:

- Is launched through `browser-debug mcp capabilities --json`.
- Can filter output by `--profile safe|full|admin|all` and `--scope all|profiles|excluded`.
- Reports supported transports, launch-selected profile surfaces, the current admin policy, and excluded operations.
- Records that `admin` is distinct from `full`, exposes only the approved stdio agent execution plan/run tools and approved stdio persistent session tools, and keeps unrelated write/execute tools excluded.
- Does not launch a listener, mutate files, contact the network, read token values, print token values, create credentials, or broaden MCP permissions.

The `safe` profile is no-browser, no-delete, no-provider, no-shell, and no-external-listener in its tool effects. It includes no-browser discovery, schema, target validation, resource status, artifact planning, read-only local agent advisory/status inspection, and MCP capability policy inspection. The `full` profile remains a stdio compatibility profile for local observe/review/target workflows plus bounded process-scoped supervise. The `admin` profile remains explicit and adds only the approved stdio agent execution plan/run bridge and approved stdio persistent session tools.

MCP does not expose artifact cleanup execution, package generation, ingest, report writing, workflow creation, execution planning outside the approved stdio `admin` agent execution plan bridge, `agent execution run` outside the approved stdio `admin` path, provider/API execution outside the approved agent execution adapter path, persistent session control outside stdio `admin`, arbitrary shell execution, browser profile reuse, default storage-state persistence, OAuth, external upload, credential handling, or gate mutation. HTTP transport does not expose `full`, `admin`, or persistent session tools.

Any socket MCP transport, remote HTTP listener, HTTP `full` or `admin` profile, MCP cleanup execution, MCP agent/API execution beyond approved stdio `admin` agent execution plan/run, shell tool, credential-bearing workflow, external model integration, external upload, or existing-profile reuse requires separate approval, security documentation, and tests.

## Browser Modes

- `headless`: default fast mode for structured observation and regression debugging.
- `headed`: visible browser mode for final UI/UX quality, animation, hover, focus, and operation feel.
- `devtools`: headed mode with DevTools for targeted inspection.

Long-running browser supervision is opt-in. `supervise` is process-scoped, uses an ephemeral context, does not reuse a user's normal browser profile, and closes before CLI exit. `daemon start` is background-scoped, uses a detached local worker with an ephemeral context, writes only ignored local metadata and observations, and stops through `daemon stop`. The default `observe` path still launches an ephemeral context, collects the requested evidence, and closes cleanly after one page observation.

## AI Interaction Contract

The CLI should expose structured observations and action candidates. The AI decides the next action outside the CLI, then sends that action back to the CLI. This keeps the tool agent-independent and avoids binding the product to one model, one chat UI, or one MCP runtime.

Review output should distinguish deterministic findings, heuristic findings, model-advisory findings, and owner-required decisions. "No findings" means no configured rule violation was observed; it must not be presented as proof that the design is good.

## Artifact Contract

Artifacts should be local by default and written under an ignored product workspace directory such as `.browser-debug/`. Planned artifact types include:

- screenshots
- traces
- console summaries
- network failure summaries
- accessibility summaries
- action history
- issue reports

Sensitive browser data must not be emitted unless a later approved feature defines safe redaction and explicit consent.

The initial artifact layout is:

```text
.browser-debug/
  sessions/
  observations/
  screenshots/
  traces/
  reports/
  specs/
  daemons/
  targets/
  reviews/
  layouts/
  diffs/
  coverage/
  review-artifacts/
  receipts/
```

Committed files must not include `.browser-debug/`, screenshots, traces, cookies, storage state, existing browser profiles, credentials, or secret-like values.

The default artifact retention policy is manual retention. Browser Debug CLI does not automatically delete generated artifacts and does not upload artifacts. Developers may remove the ignored `.browser-debug/` root themselves after reviewing whether screenshots, traces, reports, or session metadata are still needed, or run explicit artifact-root-scoped cleanup with `resource artifacts cleanup --execute`. Built-in cleanup must remain explicit, local-only, receipt-backed, tested, and limited to selected regular files under the configured artifact root.

## JSON Output Contract

Every command that supports `--json` should return an object with these top-level fields:

```text
schema_version
command
status
observed_at
data
warnings
errors
artifacts
```

Errors must be structured and non-secret-bearing. Page content, console output, network data, screenshots, traces, and model suggestions remain untrusted data.

## Schema Versioning Contract

The local MVP schema version is `0.1.0`. This version applies to top-level JSON envelopes, artifact descriptors, local session metadata, daemon metadata, supervision metadata, observation artifacts, and spec exports unless a file declares a more specific artifact schema.

Compatible changes may add fields while keeping existing field names, meanings, and JSON types stable. Breaking changes include renaming fields, removing fields, changing field types, or changing status/error vocabulary semantics; those changes require a schema version bump, synchronized product documents, and regression tests.

`doctor --json` exposes `data.schema_version_policy` and `data.artifact_retention` so agents and scripts can inspect the current compatibility and artifact-retention policy without scraping documents.

## Plugin Bundle Contract

The repository includes local Codex plugin metadata:

```text
.codex-plugin/plugin.json
.mcp.json
skills/browser-debug-review/SKILL.md
templates/review-target-manifest.json
```

The plugin bundle points to the local stdio MCP adapter and the plugin-facing review skill. It does not register a marketplace entry, publish a package, change the license, add external upload, add OAuth, add credential storage, or change the packaged `.mcp.json` into an HTTP endpoint. The optional HTTP MCP transport is a separate explicit safe-profile launch mode.

## Runtime Security Contract

- Browser contexts are ephemeral by default.
- Existing browser profiles and credentials are not read or written.
- Cookies, storage state, and local storage values are not printed, committed, or exported by default. The only supported storageState persistence path is explicit admin opt-in under the configured artifact auth directory with value-silent receipts.
- Artifact root paths must stay inside the current workspace.
- Observation and report data applies basic redaction to common secret-like strings and sensitive URL query parameters.
- Trace zip files are raw local evidence and can contain unredacted page content. They must remain under ignored `.browser-debug/` paths unless a future approved workflow defines safer handling.
- Process-scoped supervision and background daemon supervision both use ephemeral contexts. The background daemon does not create a persistent browser profile, persistent storage state, external control channel, HTTP listener, socket server, or artifact upload path.
- Persistent browser sessions do not use existing profiles, `launchPersistentContext`, or `userDataDir`. They retain only a Playwright context created by TraceCue, enforce TTL/idle shutdown, communicate through local artifact-root command files, and close context/browser on stop or expiry.

## OSS Workflow Contract

The repository should move through these phases:

- Phase 0: scaffold and synchronized planning documents.
- Phase 1: local Git initialization and first commit.
- Phase 2a: package/runtime design without network, dependency installation, or runtime implementation.
- Phase 2b: public GitHub repository creation through `gh`.
- Phase 3: GitHub Actions CI.
- Phase 4: npm package metadata and CLI packaging implementation.
- Phase 5: MVP Playwright implementation.
- Phase 6: release and npm publish flow.

The current repository implements local CI configuration, local CI validation, release readiness documentation, dry-run package verification, public GitHub repository creation, `origin/main` synchronization, and remote GitHub Actions `main` CI verification. It does not execute npm publication or other public release actions.

## Out of Scope for Phase 0

- Runtime CLI implementation.
- Dependency installation.
- Browser launch.
- GitHub remote creation.
- npm package publication.
- Remote CI workflow execution.

## Out of Scope for Phase 2a

- Dependency installation.
- Browser launch.
- Runtime Playwright implementation.
- GitHub remote creation.
- Remote CI workflow execution.
- npm package publication.

## Out of Scope for the Current Local MVP

- Existing browser profile reuse.
- Authentication automation, OAuth flows, webhook handling, external upload, and credential storage.
- Remote trace storage or trace upload.
- GitHub remote setup, remote CI workflow execution, npm publication, or external upload.

## Out of Scope for the Review Platform MVP

- Full Playwright API parity.
- Full Playwright MCP tool parity.
- Human-style subjective design approval as deterministic proof.
- Model or vision review as a required dependency.
- External model/API calls without explicit opt-in.
- Product-specific runtime branches for individual applications.
- Persistent browser profile reuse, default storageState persistence, authentication automation, OAuth, webhooks, or credential storage.
- Socket MCP server mode, remote HTTP MCP listeners, HTTP `full` or `admin` MCP profiles, MCP execution tools, or arbitrary shell execution.

## Visual Evidence Core Contract

Visual evidence records use the `visual_evidence` schema and are stored as metadata JSON under `.browser-debug/visual-evidence/`. A record contains the source kind, source path or artifact reference, media byte size, SHA-256 hash, media type, dimensions when detectable, labels, masks, regions, privacy flags, and boundary flags.

The core recognizes browser screenshots, image files, mock images, screen captures, window captures, and desktop app captures as source kinds. Step 2 implements the shared metadata and path-confinement layer and attaches metadata-only records to existing browser screenshot capture paths. Later phases may add CLI image review, AI visual review, MCP planning, approved MCP execution, screen/window capture, desktop review, and multi-agent review on top of this shared core.

The core is local-only. It does not embed raw pixels in JSON, call providers, upload evidence, store credentials, store raw provider responses, expose MCP execution, mutate existing review artifacts, or change deterministic review gates.

## Phase 43 Standalone Image Review

Standalone image review is implemented as `review --image <workspace-file> --json`. It is a no-browser mode that uses the visual evidence core to read a workspace-relative image file, records metadata-only visual evidence, writes an `image_review` result under `reviews/`, writes a review artifact index under `review-artifacts/`, and optionally writes a Markdown report. It performs deterministic evidence-quality checks only and does not claim aesthetic approval or human-equivalent visual judgment.

## Phase 51 Desktop Image Review From Capture Handoff

Desktop image review extends standalone image review with optional capture handoff verification:

```text
trace-cue capture handoff --image <workspace-image> --source screen|window|desktop-app --json > capture-handoff.json
trace-cue review --image <workspace-image> --capture-handoff <workspace-json|-> --json
trace-cue visual review prepare --review-index <review-artifact-index> --json
```

`review --image --capture-handoff` reads the handoff JSON, accepts full envelopes or inner `capture_handoff` objects, requires `status=metadata_only`, requires source kind `screen_capture`, `window_capture`, or `desktop_app_capture`, verifies `source.path` against the reviewed workspace image path, and verifies `media.sha256` against the reviewed image bytes. After those checks pass, the image review and visual evidence metadata record the caller-declared source kind, capture handoff id, handoff input path or input source, handoff hash, source path match, and media hash match.

The command still does not perform OS capture, enumerate screens, enumerate windows, enumerate processes, launch a browser, call providers, transfer evidence, expose MCP execution, or claim human-equivalent visual judgment. The provenance remains caller-declared and `source_verified_by_trace_cue=false` until a separate approved capture execution phase exists.

## Phase 53-55 Visual Review Aggregation

`visual review aggregate --preparation <workspace-json> --json` is a read-only aggregation command over existing local visual review result artifacts:

```text
trace-cue visual review aggregate --preparation .browser-debug/visual-review-results/<id>/preparation.json --json
```

The command reads the selected preparation JSON and scans existing `.browser-debug/visual-review-results/*/result.json` records whose `preparation_id` or `preparation_path` matches that preparation. It optionally reads matching `execution.json` metadata. It returns `visual_review_aggregation` with source metadata, result and reviewer counts, source effects, reviewer summaries, source-attributed aggregation findings, conflict records, owner decision requests, the original query, `gate_effect=none`, and read-only boundary flags.

Aggregation groups untrusted visual advisory findings deterministically by category, message, route, and viewport. A group is `corroborated` when more than one reviewer source reports it. Severity disagreements are preserved as conflicts that require owner review. Text fields are bounded, malformed artifacts are skipped with warnings, result scanning is limit-bound, and no raw provider response body is stored.

Aggregation never writes artifacts, runs providers, reads raw pixels, reads credentials, mutates existing reviews, changes deterministic findings, changes release gates, or exposes a MCP tool. `mcp capabilities` and `mcp execution gates` report `visual_review_aggregation` as currently excluded from safe/full/admin MCP profiles until separate read-exposure gates are approved.

## Agentic Human Review Editorial Synthesis

Agentic Human Review advisory results may include an optional top-level `editorial_synthesis` object. This object is a derived editorial view over the normalized advisory result and bounded content evidence, not provider-authored proof. It is built after result normalization from existing sections such as `human_report_v3`, `reader_experience_review`, `mechanical_vs_human_review`, reported `role_opinions`, `agentic_human_review_findings`, `owner_baseline_findings`, consensus/dissent summaries, action-plan suggestions, owner decision requests, optional metadata-only `video_evidence` summaries, optional generic `content_evidence` summaries, bounded `content_units`, claims, limitations, source types, content-understanding diagnostics, bounded `source_reading_review`, and bounded `source_understanding_review`. When usable `source_understanding_review` is present, the local composer organizes the full review around the full-source thesis, audience promise, narrative arc, must-not-miss points, tensions, limitations, and reviewer implications before summary-only material. When usable `content_evidence` is present without source understanding, the local composer organizes the full review around the supplied bounded source material first, then the existing advisory signals, cautions, and recommended direction, so generic run summaries do not displace artifact-specific content understanding.

`source_understanding_review` is derived locally from the workspace-confined full source text accepted through `--source-text`. It records schema and version metadata, source type, review effort, understanding depth, topic, thesis, audience promise, narrative arc, turning points, concrete examples, repeated motifs, must-not-miss points, tensions or counterpoints, source limitations, reviewer implications, evidence claims, assistant-reference quality target, source excerpt refs, coverage metrics, advisory-only boundary flags, and `gate_effect=none`. It must never contain full source text or chunk text. Its assistant-reference quality target is an internal dogfood target for comparing standard, deep, and xhigh output against an assistant-style reference review; it does not authorize human-equivalent or human-superior claims.

`agentic review quality source-text` is the read-only verification surface for those source-text dogfood runs. It requires three workspace-confined advisory results for `standard`, `deep`, and `xhigh`, validates each result as an Agentic Human Review advisory artifact, and returns `agentic_human_review_source_text_quality` with source-text metadata counts, bounded source-identity presence and same-source invariant status, source-reading/source-understanding completion, editorial synthesis hashes and quality scores, pairwise effort deltas, xhigh critique/evidence-limit/conclusion-change readiness, optional reference-review comparison summaries, output-safety diagnostics, warnings, and boundary flags. Source identity checks compare source ids, source hashes, input hashes, and chunk-hash sequences internally, but output only statuses, booleans, counts, identity kinds, missing effort names, and mismatch pairs. The output intentionally excludes full source text, chunk text, direct raw source-text aliases, candidate full reviews, reference review prose, private source identity values, result paths, source locators, source titles, raw provider responses, credentials, MCP execution, proof-contract satisfaction, release-gate mutation, and human-equivalent or human-superior claim authorization.

Downstream dogfood diagnostics may reference the source-text quality artifact as optional `owner_review_context.source_text_quality`. The context normalizes CLI/API wrappers, accepts only the declared source-text quality artifact family, treats unreadable or invalid artifacts as context diagnostics rather than evidence-set warnings, re-sanitizes prebuilt evidence-set context before reuse, and reports regeneration freshness by effort without outputting raw hash values. Claim-readiness, longitudinal-quality, claim-standard-gate, and evidence-regeneration planning remain gate-neutral and proof-neutral when this context is present.

When source understanding is available, advisory results may include an optional top-level `editorial_integrator` object. The integrator records the integration strategy, review effort, language, whether source understanding, source reading, and TraceCue analysis were used, bounded evidence-input counts, quality-input scores, assistant-reference target metadata, and advisory-only boundary flags. Its purpose is to show that the final natural-language review used full-source understanding first and cross-checked that understanding against TraceCue findings, role opinions, owner-baseline findings, quality signals, content evidence, and recommendations through a target-independent editorial narrative plan. It is not a new provider, reviewer, proof contract, claim authority, or release gate.

The synthesis contract includes `schema_version`, `synthesis_version`, `status`, `audience`, `tone`, `language`, `language_resolution`, `one_sentence_takeaway`, `full_review`, optional nested `editorial_integrator`, `key_observations`, `key_tensions`, `strengths`, `risks_or_cautions`, `recommended_direction`, `owner_decision_summary`, `limitations`, `source_refs`, `source_ref_details`, `boundary`, `advisory_only=true`, and `gate_effect=none`. Normalized advisory results may also mirror the same integrator at top level as `editorial_integrator` for easier machine consumption. `source_refs` identify existing result sections and ids, while `source_ref_details` provide machine-readable `source_field`, `source_id`, and `source_kind` values without raw artifact bodies, provider prompts, provider responses, credentials, execution internals, or local paths.

The synthesis builder is local and deterministic. It resolves TraceCue-local language settings during `agentic review run`, stores bounded `language_settings` metadata in the normalized advisory result, and uses `artifact_output.language` as the preferred `editorial_synthesis.language` when that artifact language is resolved. If artifact output language is unresolved, the builder uses local source-text inference as a fallback and records the unresolved status in `language_resolution`. When artifact output language differs from the inferred source language, the builder preserves existing source advisory text, records `source_text_policy=preserve_original_without_translation`, `translation_execution_enabled=false`, `raw_evidence_translated=false`, `provider_output_translated=false`, and `report_body_translated=false`, and adds localized report text explaining that source and provider text remains in its original wording rather than pretending translation occurred.

When optional content evidence is present, the synthesis records the normalized `evidence_scope` and may include source-attributed summaries, bounded content units, transcript summaries, visible-text summaries, claims, and limitations as editorial material. Reports must distinguish page-only review from page-plus-content-evidence review so owner-facing text can state whether the summary is based only on page observation or on page observation plus supplied bounded content evidence. Existing video summaries continue to expose `video_evidence:*` references, while generic content records expose `content_evidence:*` references. Both remain path-free before provider payloads and result reports. The synthesis and report layers preserve canonical source-type values while rendering TraceCue-owned display labels for `video`, `web_page`, `pdf`, `meeting_notes`, `document`, `transcript`, and `other` through report templates. Content-evidence validation treats explicit `false` privacy and boundary flags as safe absence metadata, while any truthy or non-empty raw/full content field remains rejected fail-closed.

The content-evidence-first composer groups normalized source records into summary, bounded-unit, claim, caution, narrative, review-effort, and xhigh-quality buckets, then builds a small set of source-ordered paragraphs from those buckets. It must prefer artifact-specific bounded summaries, excerpt units, observed claims, and limitations before generic provider run summaries; classify bounded evidence density as none, unavailable, metadata-only, summary-only, summary-with-claims, excerpt-supported, or rich bounded evidence; keep summary-only and metadata-only conclusions cautious; reflect standard and deep effort gaps without treating them as dedicated verification; suppress duplicate or near-duplicate sentences; avoid template-only paragraphs when a bucket is empty; preserve source text exactly when translation execution is disabled; and localize only TraceCue-owned connective phrases and report chrome. The same composer path applies to `video`, `web_page`, `pdf`, `meeting_notes`, `document`, `transcript`, and `other` source types, without target-specific branches.

The synthesis builder must not call providers, request provider-authored `editorial_synthesis`, `editorial_integrator`, `source_understanding_review`, or language-settings output as proof sections, read raw pixels, read raw video, read raw audio, read frames, translate source evidence, translate provider output, transfer full source text, read credential values, store full source text, store chunk text, store raw provider responses, expose MCP execution, mutate deterministic findings, satisfy owner-baseline proof, repair benchmark coverage, alter claim integrity, authorize owner decisions, or change release gates. Provider-facing payloads may include bounded source-reading and source-understanding input records when the existing page-text transfer boundary is approved, and provider instructions may tell the provider to use those bounded inputs, but the local `source_understanding_review` and `editorial_integrator` records remain TraceCue-derived and non-proof. If the normalized result has too few evidence-backed findings, reported role opinions, source-understanding signals, or bounded content signals, the synthesis must use a limited status and state the limitation instead of fabricating a richer review.

Markdown Agentic Human Review reports render an `Editorial Synthesis` section from the existing result field only, including localized TraceCue-owned section labels, bounded language-setting metadata for the synthesis language, artifact output language, artifact language mode, text direction, translation mode, translation execution flag, source-text preservation flag, source-text policy explanation, and evidence-scope label. When supplemental content evidence is present, reports also render a localized `Content Evidence` section with localized source-type display labels, canonical content-understanding level, bounded-evidence density, content-review-strength guidance, content-unit count, claim count, source titles, and limitations. When source understanding is present, reports render a localized `Source Understanding` section with source type, understanding depth, source-understanding score, assistant-reference target, thesis, narrative arc, must-not-miss points, bounded claims, and limitations. Older results that do not contain `editorial_synthesis`, supplemental `content_evidence`, or `source_understanding_review` remain valid and render without those sections.

## Agentic Human Review Responses Adapter Contract Recovery

Responses adapter post-validation now evaluates all applicable TraceCue contracts before deciding whether a provider advisory is repairable. The validation families are benchmark coverage, owner-approved human-baseline coverage, optional `review_claims` filtering, and either full `xhigh` role/round/critique/synthesis completion or staged-role completion when `stage_execution` is present.

When more than one family fails, the adapter returns the first failure code for backward-compatible status classification and includes `contract_failures` plus merged missing-record details in `error.details`. Repair context uses missing-only templates: satisfied benchmark or owner-baseline rows are not repeated, required owner-baseline finding templates are filtered to missing criterion ids, and allowed evidence ids are derived first from missing records and recommended evidence-reference ids before falling back to the bounded evidence catalog.

For staged `standard`, `deep`, and `xhigh` requests, the adapter validates only the roles and round required by the current stage. Final contract stages must also include synthesis integration. This keeps staged provider calls compatible with the approved multi-call plan while preventing a final-stage response from bypassing TraceCue's mechanical effort and proof contracts.

Generic-provider and staged-provider failure records persist a safe diagnostic subset under `failure_diagnostics.details`. The subset may include provider/adapter error codes, messages, status and byte counts, timeout and duration numbers, model-resolution metadata, stage id/round/roles, contract failure summaries, missing benchmark or owner-baseline records, and recommended evidence-reference ids. It must not persist raw provider responses, raw response bodies, request payloads, provider request bodies, credentials, authorization headers, endpoint strings, URL strings, local paths, cookies, sessions, stack traces, or arbitrary nested payloads.

The adapter CLI accepts and documents `--max-request-bytes` and `--max-provider-response-bytes`, and startup JSON reports the effective values. These limits are configuration for approved dogfood runs, not hidden product-specific constants.

When effective benchmark coverage is active, the adapter's provider JSON schema requires the nested `benchmark_requirement_coverage.required_mentions`, `required_dimensions`, and `forbidden_claims` arrays and derives their `minItems` from the active required coverage templates. Repair context includes `coverage_repair_targets` keyed by JSON path so providers can repair missing forbidden-claim absence rows without repeating satisfied rows. After at least one provider repair attempt, the adapter may complete only missing forbidden-claim absence rows from canonical required coverage templates when the advisory does not assert the forbidden claim and a valid local evidence-reference catalog id is available. Such records are marked with adapter-derived provenance and remain advisory-only; required mentions, required dimensions, owner-baseline findings, and prose-derived coverage are not synthesized.

When full replacement repair is exhausted and the remaining contract failure is limited to missing benchmark coverage rows whose records are absent, the adapter may issue one bounded coverage patch request to the same provider boundary. The patch request includes the prior provider-authored advisory as redacted, size-bounded context, the missing-row `coverage_repair_targets`, and allowed evidence-reference ids. The provider must return only `benchmark_requirement_coverage`; the adapter merges only rows whose exact label matches a missing record and whose evidence references resolve to the local catalog, marks those rows as provider coverage patch repair output, and then re-runs the same benchmark, owner-baseline, claim, and effort validation. Invalid existing rows, unknown evidence references, non-coverage failures, disabled full repair, target-specific branches, prose-only matches, owner-baseline finding projection, local artifact inference, raw response persistence, credential recording, MCP exposure, and release-gate mutation remain out of scope.

## Control Center Read Model And React Surface

`control-center status --json` returns a `control_center` read model that composes existing read-only TraceCue status APIs. The model is body-free and summary-oriented: it includes source-intake capability metadata, display-language settings metadata, Playwright Test regression metadata, review readiness, next action, visual review counts, optional owner-review matrix data, findings counts, setup/safety summaries, source statuses, safe command handoff text, warnings, errors, and explicit boundary flags. It does not include raw artifact bodies, raw pixels, raw provider responses, credential values, browser traces, DOM payloads, network payloads, full source text, chunk text, or executable commands.

`control-center serve` starts a loopback-only server. The server serves the built React + Vite bundle from `dist/control-center`, exposes `GET /api/health` plus GET-only `/api/dashboard`, and rejects non-loopback Host or Origin headers. The original eight bounded action paths remain unchanged and separately reported in server metadata. `/api/settings/control-center` atomically persists display language, default viewport, AI-suggestion preference, and Playwright Test mode to the ignored local override while keeping send confirmation immutable. The separate `/api/settings/ai-connections/{refresh,selection}` actions explicitly refresh private capability state or apply one opaque AI choice with compare-and-swap protection. The dedicated `/api/agentic-review/{prepare,confirmation,start,status,decision,repeat,list}` family orchestrates the existing browser review and Agentic Human Review proposal/plan/run APIs. None of these is a generic action, command, provider, or artifact endpoint.

### Layered Dashboard Settings Store

`src/dashboard-settings-store.js` owns the only mutable dashboard-settings
write path. It reads tracked shared defaults, reads an optional ignored local
override, allowlists supported branches, deeply overlays those branches, and
then pins all safety fields to their non-executing values. Writes are serialized
per workspace, size bounded, confined to a regular non-symlink file, written to
a mode-0600 temporary file, and atomically renamed into place.

Display language, ordinary Control Center preferences, automated-check mode,
and approved external-CI fetch policy all use this store. The React Settings
form submits one combined payload so validation completes before one file
replacement. Legacy dedicated setting endpoints remain compatible and use
serialized read-modify-write updates so unrelated local branches survive.

The React surface lives under `control-center/`. It imports the product-local design-system JSON from `docs/design-system/`, maps those tokens to CSS custom properties, and uses the same read model that the CLI emits. The ordinary UI has three destinations: Confirm, In progress, and Settings. New review accepts a web URL, a plain-language purpose, and one of three purpose-led review choices. Settings combines display language, default viewport, a plain-language automated-check choice, AI suggestions, a compact user-facing AI service/model selection, optional provider-native effort details, and mandatory send confirmation. The footer save atomically applies only the general settings payload. A changed AI choice is applied by its nearby explicit action against the capability-store revision; a conflict retains the draft and offers the latest choices. Playwright and CI remain implementation details rather than ordinary setting labels; raw provider/adapter ids, endpoints, executable paths, and technical artifact controls are not ordinary UI. Credential entry exists only inside the paired, bounded AI setup dialog and is never an ordinary provider control.

The browser surface is intentionally not a landing page, generic command launcher, schema browser, provider console, artifact browser, or raw JSON viewer. It is an execution plane only for its dedicated page-review operation contract. Shell, cleanup, MCP write/execute, arbitrary credential or provider controls, raw artifact serving, CI mutation, and gate-affecting authority remain excluded. The only credential input is the fixed-catalog, session-only API setup channel described below.

### Purpose-Led Control Center Projection

The production Control Center adds an ordinary purpose-led projection while
preserving the existing read-model fields and bounded backend actions. The top
navigation contains `確認` (`confirm`), `進行中` (`running`), and `設定`
(`settings`). The ordinary Settings page follows the accepted 760px-wide
prototype form: display language, default viewport, one concise Playwright Test
mode choice, AI suggestions, one compact AI service/model summary with an
explicit change action, optional provider-native effort under secondary AI
details, mandatory send confirmation, one general-settings save action, and a
contextual explicit apply action only while the AI choice is being changed.
It omits cards, status badges, persistence paths, locale
internals, diagnostics, trust badges, regression import forms, and CI policy
forms. Those existing contracts remain available to backend, CLI, API, and
read-model consumers without being ordinary settings UI.

The ordinary workflow renders five stage labels: `準備` (`prepare`), `確認`
(`review`), `判断` (`decide`), `再確認` (`recheck`), and `完了` (`complete`).
Stage state is derived only from persisted `agentic_review.items` and operation
status. The React client does not create timers, optimistic
percentages, sample findings, synthetic decisions, synthetic recheck results,
or client-only completion. It polls the bounded status endpoint while work is
active and leaves long-running work available after navigation or page close.

The source-intake effort control preserves the existing request field and enum.
It maps `standard` to the selection title `大切な改善点を知りたい` and short
label `大切な改善点を確認`, `deep` to `改善点を詳しく洗い出したい` and
`詳しく確認`, and `xhigh` to `重要な判断の前に念入りに確かめたい` and
`念入りに確認`. These labels select the existing Agentic Human Review effort.
Prepare first runs the TraceCue page review and creates an AHR proposal and plan
locally. If AI is enabled, the operation enters `confirmation_required`; the
provider call starts only after the user confirms the exact disclosure and
one-time revision.

The purpose-led slice preserves the exact existing eight-action metadata
allowlist: `/api/source-intake/proposal`,
`/api/settings/display-language`, `/api/playwright-test/mode`,
`/api/playwright-test/import`, `/api/playwright-test/external-ci/fetch`,
`/api/playwright-test/external-ci/suggest-settings`,
`/api/playwright-test/external-ci/approve-settings`, and
`/api/playwright-test/external-ci/fetch-approved`. Additional namespaced Control
Center preference and agentic-review endpoints are reported separately.
Free-form next-action text, command handoff text, paths, and status labels must
never be converted into execution.

The ordinary projection may declare Complete only when current structured local
evidence supports completion with no unresolved blocker. Proposal readiness,
advisory-only output, absent evidence, or `gate_effect=none` alone cannot produce
a completed workflow state.

### Control Center Agentic Review Operation

Each operation is stored under the configured workspace-confined artifact root,
defaulting to
`.browser-debug/control-center-agentic-reviews/<operation-id>/operation.json`.
The public `control_center_agentic_review` projection exposes goal, safe target
label, TraceCue effort, viewport, opaque AI selection, user-facing service and
model names, provider-native effort label, disclosure, state, decisions, safe
result, and boundary flags. It excludes target query strings, artifact paths,
hashes, internal provider and adapter ids, endpoint data, credential values,
request bodies, raw discovery output, and raw provider responses.

The state machine is `preparing -> confirmation_required -> dispatching ->
validating -> completed`, with terminal `failed` and restart-recovery
`dispatch_unknown`. AI-disabled preparation completes as a local review without
proposal, plan, confirmation, provider call, API call, or evidence transfer.
The send nonce expires after 15 minutes, is persisted only as SHA-256, and is
bound to the disclosure revision plus the prepared plan and transfer contract.
A nonce can start one provider execution.

Provider execution reuses `runAgenticHumanReviewRun`; credentials remain in its
environment/provider boundary. The operation stores only a normalized advisory
projection. Automatic retry and cancellation are unavailable. A process restart
while dispatch is uncertain changes the state to `dispatch_unknown` rather than
calling the provider again. `decision` upserts one `fix`, `later`, or `ask` value
for a returned finding. `repeat` always creates a new operation and browser
review, links it to the previous operation, and either keeps the effort for
`recheck` or advances it for `deeper`.

The browser creates one random 32-byte base64url idempotency key for each
pending `repeat` action and retains the key and exact request only in memory.
It retries that request once only after transport loss and reuses the retained
request for an explicit user retry after a second transport failure. The server
hashes the raw key, derives the child operation id from the parent scope and key
digest, and binds the digest to a canonical request hash covering the parent,
repeat mode, and effective opaque AI selection. Admission is serialized before
capacity evaluation. A matching active or historical operation is returned
without starting background work; a different request for the same key returns
`409 Conflict`. The raw key is absent from URLs, storage, operation records,
projections, results, and artifacts. This local admission reconciliation does
not authorize retry of an uncertain provider dispatch.

Control Center browser requests use centrally declared response-bound classes:
ordinary local requests use the default bound and AI connection discovery uses
a longer bound that exceeds its bounded provider and fixed-process probes. The
deadline starts before pairing and action-token bootstrap and covers response
headers plus JSON body parsing. The wrapper both aborts the underlying fetch and
races the whole operation with an explicit rejecting timer, because an
intercepted, stalled-body, or partially lost response is not guaranteed to
settle from abort alone. Empty, truncated, or malformed JSON on a successful
HTTP status throws transport uncertainty without a server error envelope.

Review status polling is paused synchronously while a user mutation and its
state reconciliation are in flight, so a periodic read cannot supersede the
authoritative post-action read. Timeout is treated as transport uncertainty:
settings, connection refresh and selection, API setup and disconnect,
subscription setup, review start, cancel, and repeat flows read current server
state according to their action contract and never resubmit a credential or
retry uncertain provider execution. The repeat flow retains its memory-only key
until it receives a complete valid child projection. New Review preparation
waits and Review Workspace repeat requests carry page-owned abort signals and
operation generations; component cleanup cancels their fetch and delay, and
every post-await navigation requires the same live generation.

## Document Sync Contract

`ops/DOCUMENT_SYNC_POLICY.json` defines excluded path patterns, reusable
document groups, and additive rules. `schemas/document-sync-policy.schema.json`
defines its versioned shape. `tools/lib/document-sync.mjs` validates policy,
performs bounded `*`/`**` matching, parses NUL-delimited Git rename/delete
records, and evaluates changed paths without file or network side effects.

`tools/check_document_sync.mjs` accepts explicit changed files, a Git
base/head range, or the current worktree. Range mode resolves both commits,
uses their merge base, and reads `git diff --name-status -z --find-renames`.
Unavailable commits are errors rather than skipped checks. Matching rules are
combined by union; every required `all_of` path and each required `any_of`
alternative group must be satisfied inside the same range.

The optional `.githooks/pre-push` entry invokes the same checker. The installer
sets only repository-local `core.hooksPath=.githooks`, refuses unmanaged hook
configuration, and uninstalls only its own setting. It performs no fetch,
network call, credential read, artifact write, browser action, provider call,
MCP action, or external evidence transfer.

The CI `repository-contracts` job alone uses `fetch-depth: 0`. It installs the
lockfile-pinned parser dependency, runs bounded contract-only checks, and
evaluates event-specific base/head SHAs. Existing Node and browser jobs retain
their current responsibility.

## Development Workflow Contract

`ops/DEVELOPMENT_WORKFLOW_POLICY.json` maps stable instruction anchors to an
enforcement mode, applicability labels, registered test ids, required review
fields, and block-or-record failure behavior. The strict
`schemas/development-workflow-policy.schema.json` shape permits only dynamic
`inherit_current_session` model and reasoning-effort bindings and rejects fixed
override fields.

`tools/lib/development-workflow.mjs` validates the policy and evaluates its
links to instruction anchors, `ops/TEST_PLAN_MANIFEST.tsv`, package scripts, and
required repository files. It reuses repository-relative path normalization
from the document-sync library rather than defining another path grammar.
`tools/check_development_workflow.mjs` reads only those repository-local
authorities, rejects symlinked or escaping required files, and emits a bounded
pass/fail contract. It performs no Git mutation, model lookup, provider call,
credential read, browser action, MCP action, network request, or artifact write.

The subagent contract requires at least two distinct reviews for both proposal
and plan phases of non-trivial work. The selected model and reasoning effort
come from the active user session at runtime. When the subagent interface does
not expose or attest effective settings, reports use the available inherited
configuration, mark visibility as unavailable, and make no named model or
effort claim. This repository contract verifies the policy and report fields;
it cannot authenticate conversation events or runtime settings that the host
does not provide.

The existing `repository-contracts` job runs the current-policy check, focused
rejection tests, and parsed-YAML CI composition checks after `npm ci`. Existing
Node jobs execute no-browser regressions and the existing browser job executes
browser smoke. The policy maps those checks without rerunning them in the
contract-only job.

## Verification Orchestration Specification

`ops/VERIFICATION_EXECUTION_POLICY.json` and its strict schema define local task
argv, `contracts`, `core`, `browser`, `package`, `release`, and `focused`
profiles, selectors, resource locks, limits, cache invariants, CI owners, and
execution-instance identities. `tools/lib/verification-orchestration.mjs`
validates that authority, expands dependencies, rejects duplicate providers and
unsafe argv, evaluates conservative changed-path unions, schedules bounded work,
terminates process groups, compares tracked worktree state, and creates CI proof
metadata. Scheduling scans past declaration-order consumers whose dependencies
are still pending, so a later producer can run before an earlier serial
consumer. `tools/verification.mjs` is the plan, run, and proof adapter.
Its parser uses a command-specific allowlist, rejects unknown, duplicate,
missing-value, conflicting, and inapplicable arguments before execution, and
provides stable `release`, `release-evidence`, and `import-ci-proof` operations.
The npm entrypoints resolve the release profile from policy, so renaming a
profile does not require a script change.

Timeout-contract tests judge the configured runtime outcome first. A named
test-only observation bound may be wider than the configured timeout to absorb
shared-runner scheduling delay, but remains narrower than the known fallback it
is intended to detect and does not alter execution policy. Tests that inspect an
atomically replaced JSON state wait for a validated predicate rather than
assuming the first readable snapshot is the committed state they need.

The CI graph has `repository-contracts`, Node 20/22 runtime instances, one
package producer, Node 20/22 package consumers, one browser owner, and
`final-gate`. The producer artifact contains a manifest and tarball bound to the
workflow run and attempt, full HEAD and tree, repository input, policy, command,
producer toolchain, package identity, file-list digest, tarball digest, and size.
Consumers validate these fields and then run the existing install smoke against
the downloaded tarball without invoking `npm pack`.

The local npm dry-run and real package producer capture npm JSON through one
shared fixed-argv helper into an exclusive mode-0600 regular file in the
run-isolated package workspace. This keeps npm 11 output reliable under
non-interactive parent pipes without shell redirection or unbounded in-memory
stdout. The file must be nonempty, bounded, read completely through the same
descriptor, unchanged after reading, and valid as exactly one package manifest
before its file set can pass.
The helper applies one combined byte budget to stdout and stderr, drains both
streams, terminates the process group on overflow or timeout, and excludes raw
child output from authority artifacts. Package input identity also includes a
bounded digest of ignored-excluded untracked file contents, so changing a new
source file without changing its path invalidates the producer manifest.

The package producer builds the Control Center once before packing. The browser
owner installs dependencies, restores only the exact Playwright browser-binary
cache key derived from OS, architecture, lockfile, and browser revision
metadata, verifies or force-installs Chromium, verifies the downloaded producer
manifest and tarball, and materializes only the declared Control Center subtree
before invoking the build-free browser test command once. Materialization is
bounded and accepts regular files only; traversal, duplicates, links, special
types, checksum failure, trailing content, and expansion excess fail closed.
The final job uses `needs` results and emits a proof for the current run and
checkout without executing product tests.

CI verification parses the workflow with the repository-pinned YAML parser and
validates required jobs, matrices, steps, and commands as structured data.
Required owners reject job or step conditions, `continue-on-error`, job
defaults, matrix include/exclude changes, uncontracted matrix dimensions,
alternate shells, working-directory overrides, and shell control operators on
policy-owned commands. Node 20 and 22 must remain actual execution instances,
not merely strings elsewhere in the workflow source.

Product-gate evidence version 2 stores atomic per-attempt receipts below `.git`.
Schema v2.2 local authority is committed only through one complete release
batch whose policy-owned tasks all passed against an unchanged clean full HEAD
and tree. The batch binds the exact task/source receipt set, policy, graph,
configuration, tools, inputs, commands, task results, and release artifact
digest. Standalone, partial, focused, mixed-batch, manual, or dirty successes
are not release authority. The TSV index and JSONL ledger remain locked,
deterministic, rebuildable projections. Stale, malformed, symlinked, or
secret-bearing records fail closed.

After a receipt is committed, its writer acquires the derived-index lock. It
may skip a redundant rebuild only when a bounded, no-follow, stable-descriptor
read of the current ledger already contains that exact event id, which means a
preceding locked rebuild incorporated the receipt. Otherwise it performs the
full deterministic receipt-to-detail/index/ledger rebuild. This coalesces
concurrent writers without turning a derived view into receipt authority. If an
opened ledger descriptor reaches link count zero because another writer
atomically replaced the pathname, the reader treats that descriptor as a
changed projection and enters the normal locked retry/rebuild path. A
multiply-linked, non-regular, or oversized ledger still fails closed.

The Dashboard-facing `index.tsv` is the active compatibility projection and
contains only the latest valid v2.2 batch receipt for each exact source and
context. Its
`observed_at` field is normalized to `YYYY-MM-DDTHH:MM:SSZ`, while the immutable
receipt retains its original high-resolution event time. On the first rebuild
that encounters pre-v2 short-HEAD rows, TraceCue writes the complete prior index
to `.git/product-gate-evidence/legacy/` under a content-digest filename and
writes an atomic migration record. Rebuild then projects only v2 receipts, so
legacy rows remain history but cannot re-enter current authority.

New receipts use schema version 2.2 and bind every persisted authority,
freshness, execution, presentation, and release-batch field into the result
digest. Version 2.0 and 2.1 receipts remain readable as historical records but
are always stale and cannot satisfy current readiness. Receipt reads recompute
the attempt and result digests and validate committed batch membership before
use. Evidence
root and receipt directories must be real directories below the repository Git
directory, never symlinks. Local aggregate status ignores stale optional rows
but continues to reject stale required rows, failed or blocked required rows,
required non-PASS states including cached results, and non-authoritative required
results. Required sources are derived from `required` rows in the evidence
detail manifest; an absent current receipt is projected as `not_run`, while a
`contextual` row is not promoted without a separate applicability decision. The parent
repository consumes only the fixed 13-column projection and independently
rechecks its grammar, full HEAD, age, authority, required evidence, and current
workflow context.

The policy bounds only the active authority stores. During a locked rebuild,
semantic winner receipts and their complete release batches are retained first;
newer non-authoritative history fills remaining count and byte capacity.
Superseded or expired complete/incomplete directories are identity-checked and
atomically renamed into the marker-owned
`.git/product-gate-evidence/inactive-archive-v1/` tree. Archived records are not
scanned for readiness and cannot become authority, but remain locally
inspectable. The inactive archive is intentionally not auto-deleted and has no
claimed total-size guarantee; a future explicit export/compaction operation is
separate work. Receipt admission and a complete release batch use one bounded
transition while the batch holds the derived-index lock, so capacity recovery
uses the already-held lock and cannot self-deadlock.

Each source also projects a bounded `current-v2.json` under the existing
source-scoped details directory. For a single active context, it contains only
the common safe detail fields and uses the same event id, status, whole-second
time, and full HEAD as the active row. For multiple active contexts, it contains
no event id and uses a context-neutral explanation because the parent detail
contract is source-scoped rather than context-scoped. Rebuild also projects a
safe no-event detail for synthesized required `not_run` rows, preventing an old
legacy explanation from being attached to missing current evidence.

## Control Center Goal Completion Contract

The production server accepts separate `workspaceRoot` and `assetRoot` values.
The default asset root is resolved relative to the installed TraceCue module;
it is never derived from the caller's current directory. A dedicated launcher
owns browser opening with a fixed platform adapter, fixed argv, and
`shell: false`. A workspace-scoped runtime receipt and lock permit reuse of a
healthy instance while preventing concurrent ownership. The opener is
replaceable only through an injected test dependency, not browser input. The
runtime receipt and health response bind a protocol version, package version,
and SHA-256 packaged-asset tree identity; a live incompatible server is never
silently reused.

Production and Vite use one API router. Every mutation requires an exact Origin
matching the active loopback scheme, host, and port plus a random per-server
CSRF token obtained from the same-origin dashboard bootstrap. The token exists
only in memory and a request header. It is absent from URLs, bundles, files,
logs, operation projections, and evidence. Static and stored-file access rejects
symlinks, hardlinks where the platform reports multiple links, non-regular
files, realpath escape, replacement races, and oversized reads. Inspection,
bounded reading, digesting, and parsing use the same no-follow file descriptor;
identity, size, and timestamps are rechecked before accepting the buffer.

The intake contract has four source kinds: `url`, `image`, `document_text`, and
`playwright_result`. URL is validated JSON and is not staged. File bodies are
streamed to exclusive private temporary files and atomically committed beneath
the approved intake namespace. Public receipts contain only an opaque id,
source kind, safe display label, byte count, and expiry. Private receipts bind
the content digest, validated media kind, byte count, disclosure classes, and
operation revision. Execution rehashes the file and invalidates confirmation
on any drift. Images are limited to PNG/JPEG/GIF/WebP with matching signatures
and bounded dimensions; documents are NUL-free valid UTF-8 TXT/Markdown/JSON;
Playwright input is JSON or JUnit XML accepted by the existing importer.

File staging reserves item count and bytes under a cross-process quota lock
before streaming and commits the file plus private receipt transactionally.
The reservation calculation includes unexpired staged receipts, live
processing receipts, and active reservations.
Completion first resolves completed or pending state without consuming a new
result slot. Only a staged source enters publication admission. Admission uses
a global cross-process lock, a configurable active-result hard bound, and an
owner/token reservation for the opaque id. The owner renews a bounded lease
during processing and is the only request allowed to invoke the intake engine;
another request for the same id waits on the per-id lock and may only return or
finalize the same result. A waiter can acquire that lock during the narrow
reservation-to-processing handoff before the owner has entered it. In that
case, the staged receipt is a bounded wait signal: the waiter releases the lock,
uses the configured poll interval and remaining completion deadline, and
retries without taking the reservation or invoking the engine. Each staged
cycle revalidates the exact reservation token observed at admission and its
process identity. A changed, invalid, or dead owner ends the wait with the
retryable `CONTROL_CENTER_INTAKE_PUBLICATION_OWNER_LOST` result; the waiter
does not adopt or release that reservation. Another id cannot be admitted while
reservations and active results fill the bound. A completed active or inactive-
history id is an idempotent read and bypasses admission even when history is
locked.

The private schema-v1.1 receipt enters `processing` before engine execution but
is not consumed at that point. The pathless result is written with its canonical
digest, the private source is safely released, and only then does the receipt
atomically publish `completed`, `result_sha256`, `source_released_at`, and the
matching completion time. A valid pending receipt/result pair can be finalized
without engine re-execution after response loss or restart. Once a waiter owns
the free per-id lock, `processing` without a valid pending pair is no longer
live work: it becomes non-retryable `failed`, its safe invalid result and
publication reservation are removed, and later source/result admission may
recover. Safe pathless result projections remain available through bounded
list/open GET endpoints. Reads retry only a bounded transient active-to-history
replacement window, including the initial receipt read for a completed same-id
retry, and revalidate the committed result/receipt pair after that transition;
persistent absence, corruption, digest mismatch, and every unclassified error
fail closed. Cleanup removes expired reservations, expired unfinished receipts,
owned temporary files, and old unreferenced regular files without following
links.

Completed result history is not automatically deleted. The active list keeps a
bounded newest-first set, while older immutable result and receipt records move
under deterministic private hash shards in the same owned store. Direct lookup
by opaque id checks active storage first and then inactive history. Publication
releases its per-intake lock before history selection; history reacquires that
same id lock, re-reads the result and completed receipt, and only then archives
the active copies. A processing or changed record is skipped.
Intake history maintenance is requested only after the result and completed
receipt transaction is durable, then runs as coalesced best-effort maintenance.
Its lock wait or failure is not part of the completion response and cannot
rewrite a committed receipt as failed. Expiry cleanup removes abandoned staged,
failed, or dead processing receipts and released source bytes, but a completed
receipt remains with its result in active or inactive history until explicit
artifact-root cleanup.

Each private store atomically creates its own root before it may create the
namespace/version ownership marker. An existing root without that valid marker
is never adopted, chmodded, cleaned, or populated. Read operations validate an
existing private marked root but do not create directories, markers, or result
folders; an absent store projects an empty list.

The operation store uses revisioned read-transition-write transactions under a
cross-process owner/nonce lock. Locks have bounded acquisition and use process
liveness plus ownership identity; age alone never breaks a live lock. If the
coordinated release transition exhausts its window, a nonce-, pid-, and process-
identity-matched owner may remove only its own unchanged logical lock. A changed
owner or unsafe record is rejected. Existing schema-v1 records remain readable.
Active operation admission is count bounded; a new or reactivated operation may
make room only by moving a terminal revision-revalidated record to inactive
history. Recovery states are fixed as follows:
`preparing` allows an explicit local restart; `confirmation_required` retains a
current confirmation or issues a fresh one; `dispatching` becomes
`dispatch_unknown`; `validating` resumes only from hash-bound persisted result
evidence; `failed` creates a new linked attempt and fresh confirmation when a
send is required; `completed` restores the stored result; and `cancelled` is
available only before external dispatch. In-memory active-task identity takes
precedence over a same-process persisted owner: when the local task has ended,
`preparing` or `dispatching` is recoverable immediately, while an owner in a
different live process remains active.

Completed operation history follows the same manual-retention rule. The active
operation directories are bounded for safe scans; older active history is
copied into deterministic private hash shards and then removed from the active
set without deleting the retained JSON record. Direct id lookup falls back to
inactive history, while an update reactivates the record and removes its
inactive duplicate. Mutation releases the id lock before requesting the history
lock; history then acquires and revalidates a candidate id, preventing lock
inversion and stale-snapshot data loss. History retention is coalesced and
deferred outside the primary operation transaction. A retention lock timeout or
archive error cannot replace a committed action response, consume confirmation
without scheduling dispatch, or report a persisted decision as failed. A
transient maintenance failure is retried only under a bounded retry policy with
unreferenced scheduling, so maintenance can converge while never becoming
process-liveness authority. Safe-store removal first renames the selected
directory to a hidden quarantine name that cannot match any product operation
id, validates and removes that quarantine, and restores it on a failed safety
check when possible. During a bounded directory scan, only `ENOENT` from the
post-enumeration safety lookup is treated as an authorized concurrent move;
every other lookup failure propagates and fails closed. Operation-list loading
performs a bounded delayed retry when an active-to-history move returns
`ENOENT`, or when an authorized atomic record replacement returns
`SAFE_STORE_FILE_CHANGED` between inspection and descriptor opening. The retry
does not apply to malformed JSON, record identity mismatch, unsafe file type,
permissions, links, confinement failures, or any other error. Exhausting the
bound returns the normal fail-closed list error.

Status, list, dashboard, and saved-result GET handlers only project stored
state. `POST /api/agentic-review/recover` owns interrupted-state transitions
behind exact Origin and CSRF validation. Recovery and normal validation hash,
parse, validate, and project one immutable advisory buffer; the result must
match the canonical advisory contract and its execution/plan identity. A
verified pre-send failure becomes `failed` only when the structured runner
boundary explicitly attests false for provider call, API call, and external
evidence transfer. A thrown runner, missing boundary, partial boundary, any
true transfer flag, or unverifiable result becomes `dispatch_unknown`.

AI connection projection is derived from a private revisioned capability store.
It exposes `available`, `setup_required`, or `unavailable`, a safe next action,
opaque option ids, connection-type labels, service display names, model display
names, and supported provider-native effort labels. It never exposes internal
provider or adapter ids, endpoint or credential metadata, executable paths,
binary or configuration hashes, command arguments, or raw discovery output.
The selected AI option is a tuple of connection type, adapter, provider, model,
provider-native effort, capability revision, configuration identity, and, for a
subscription CLI, executable identity. The private record binds that tuple by a
canonical integrity hash and keeps the capability revision separate from the
settings compare-and-swap revision.

`GET /api/dashboard` and every other read-only request use stored capability
state or a non-executing configured-API projection only. They never spawn a CLI,
probe login, contact a provider, or mutate the capability store. Explicit
`POST /api/settings/ai-connections/refresh` performs bounded discovery behind
the normal exact-Origin and CSRF boundary. Explicit
`POST /api/settings/ai-connections/selection` persists one current opaque
selection with compare-and-swap conflict handling. A stale record may explain
availability but is never dispatch authority. Preparation resolves the opaque
selection server-side; start and dispatch re-resolve it and require the exact
tuple and capability revision to remain current. Drift blocks before external
transfer and never falls back to another connection, model, or effort.
The safe connection-state store and the subscription adapter's disposable
working directories use separate owned child namespaces under the artifact
root. Either may be created first without adopting, deleting, or weakening the
other namespace's ownership marker. Disposable-directory admission is
serialized under the safe store, has a centrally bounded active capacity and
bounded scan, removes only safely owned stale entries, and fails closed under
capacity or lock contention. Cleanup uses the same admission lock so a new
review cannot race a retiring private directory.

Subscription and API connections feed the same Agentic Human Review plan,
confirmation, execution, normalization, decision, recheck, and deeper-review
contracts. Their capability adapters may expose different model and native-
effort choices. TraceCue review effort (`standard`, `deep`, or `xhigh`) remains
an independent plan contract and is never derived from provider-native effort.
The exact two selections are carried separately through plan, receipt,
operation, confirmation, and dispatch validation.

The built-in subscription adapter supports an already-authenticated official
native Linux Codex CLI. Its version and feature contract is an explicit audited
allowlist; the initial adapter accepts `@openai/codex` 0.144.1 and fails closed
for every unlisted version or feature catalog. Discovery resolves the package's
native ELF executable through its official package layout, verifies its exact
platform-specific byte length and SHA-256 digest against the centralized
version contract, and keeps the verified descriptor open through each launch.
It requires the fixed root-owned bubblewrap and `prlimit` executables, runs fixed
version/login/feature/model probes with `shell: false`, a safe allowlisted
environment, bounded output, and a timeout, then stores only normalized
capability metadata. Execution uses a private temporary working directory,
prompt stdin, a fixed `codex exec` argument set, isolated 16 MiB temporary
filesystems, a 2 MiB file-size limit, a read-only schema bind, and exactly one
writable bounded result-file bind. The sandbox has no host workspace mount, no
MCP servers, no web search, no inherited shell environment, and receives only
the explicit model and provider-native effort. The normalized result is read
through a no-follow bounded descriptor and strict contract validation; the raw
last-message file exists only in the private disposable staging directory and
is removed after the attempt. Executable paths, commands, credentials, and raw
output are never retained or sent to the browser. Other subscription CLIs
require separate audited adapters; the common opaque connection contract does
not claim they are already supported.

Discovery reports process creation only when an actual probe process starts.
Model catalogs use a deterministic code-unit tie break after provider priority.
The execution adapter merges process-start, possible-dispatch, temporary-output,
and credential-read observations immediately after the fixed process returns.
Those observations are monotonic across result reading and normalization, so
an unexpected post-dispatch failure remains an uncertain external dispatch and
cannot be offered as a safe implicit retry.

The legacy preconfigured generic API connection is configured through
environment-only endpoint, credential, model, service display name, and
optional provider-native effort values. It remains distinct from the paired,
fixed-catalog, session-managed Control Center API setup contract below.
Passive GET requests never inspect credential values. An explicit server-side
availability refresh checks only whether a preconfigured value is nonempty,
and neither returns nor persists the value. The confirmation digest binds the
user-visible service/model/native-effort selection and a non-secret destination
fingerprint.
Dispatch recalculates the capability and destination identity immediately
before the provider request. A failure after request transmission starts is
uncertain unless a provider contract both declares and honors stable
idempotency.

The React New Review surface derives its controls from source kind. Website and
document inputs retain meaningful purpose and effort choices; image and
Playwright-result inputs omit choices their engines do not consume. Persisted
results join the confirmation list and open by opaque id after reload. Agentic
and intake items are sorted together by their newest available timestamp before
the next action and recent list are derived. A failed result-list refresh keeps
the already displayed items and shows a retryable warning rather than replacing
them with an empty list. Saved results render safe source-specific facts:
image format/dimensions/finding count, document method/character/section counts,
or automated-check total/pass/fail/timeout/skipped counts. Stored Playwright
classification and all decision-relevant counts survive projection. Failed,
timed-out, blocked, stale, or unreadable results use danger; empty or missing
evidence uses warning; only a nonempty passing result uses success. Image and
document preparation and imported evidence use prepared/result-ready states,
not review-complete state or the website-review completion stepper. The saved
timestamp uses the active display locale.
A successful file submission replaces its submit action with an explicit
prepare-another action, while the server's one-use receipt transaction remains
the authoritative duplicate-execution guard.
The purpose field remains the mock's one-line control, and new-review and
settings footer actions remain right aligned at desktop widths. The
five-stage header, close/back actions, method-card geometry, grouped settings,
mandatory send confirmation, typography, spacing, focus treatment, safe error
copy, Japanese/English/Arabic resources, and responsive behavior are checked
against the versioned production mock and product design tokens.
Mobile lists retain a compact visible text badge in addition to color. Current
  steps use `aria-current="step"`, decision buttons use `aria-pressed`, and
  directional symbols mirror under RTL without changing content order.
Review workspaces bind every status response and mutation to the current review
id and request generation, use sequential polling, and discard late responses
from an older route. When a cancellation request succeeds but its response is
lost, the confirmation closes and status is reconciled from storage. A stale-
status warning appears only if that reconciliation fails; a reconciled
cancelled review is labeled not sent and is excluded from the next-work choice.

Release evidence refresh consumes one complete release-profile result with
clean, unchanged before/after HEAD and tree snapshots. The batch binds policy,
graph, input, configuration, tool, task-result, and artifact digests. Only
policy-declared `task -> source` ownership is projected and every source
receipt references the batch digest. A separately imported CI proof validates
repository identity, full HEAD/tree, run and attempt, final job, all required
owner jobs, policy/graph identity, and artifact digest against the local clean
checkout. Neither dashboard reads nor release refresh silently contact GitHub.
Repository identity is parsed once from the policy-selected Git remote and must
match a policy allowlist of GitHub hostnames; the same host and repository value
drive proof creation, authenticated import, and remote status inspection.
Remote status accepts no workflow, workflow-path, or remote override outside
that policy. Release recording temporarily reserves bounded receipt admission
for the complete source set, verifies it fits active count and byte limits, and
performs semantic retention after the batch is committed.

### Control Center AI setup contract

Production launch uses a pairing-authority mode. A launcher-owned management
capability creates a bounded one-time 256-bit pairing token bound to the current
runtime instance and expiry. The server stores only its digest. The browser
removes the token from the URL fragment before rendering, exchanges it once,
and retains the returned session bearer and session-specific CSRF value only in
module memory. Reuse, expiry, a foreign instance, a foreign Origin, and an
unpaired mutation fail closed. Direct `control-center serve` remains readable
but does not grant privileged browser actions. The runtime protocol version
changes whenever this authorization contract changes.

The browser caches one pairing exchange promise because the fragment token is
one-use and removed before rendering. Any pairing timeout, unreadable body, or
invalid exchange response is therefore classified as reopen-required. The UI
does not offer an in-place retry that would reuse a consumed or
acceptance-ambiguous token.

The management capability is separate from public `server.json`, is created in
the existing private runtime namespace, and is never returned by health,
launcher results, stderr, or read-model APIs. The current URL opener passes the
short-lived fragment through a child-process argument; therefore root/admin,
the same operating-system user, process-table observers, browser extensions,
developer tools, swap, and process dumps are outside this feature's protection
boundary. Remote and cross-origin callers, stale sessions, replay, accidental
file/log disclosure, redirects, and unpaired browsers remain in scope.

API setup is a two-step mutation. A paired JSON intent resolves one opaque
service choice from the installed catalog and creates a short-lived one-use
submission id. A dedicated `application/octet-stream` request then accepts one
bounded UTF-8 key after validating Origin, session, CSRF, content type, content
encoding, declared length, timeout, control characters, and replay before or
during body admission. The initial credential store is server-owned memory
with fixed entry, total-byte, key-length, idle, and absolute limits. Idle expiry
removes the active connection and refuses new leases but lets an already
acquired immutable execution lease finish before disposal. Absolute expiry is
hard: it disables the generation, aborts the in-flight provider transport,
clears the owned credential buffer best-effort, and closes the adapter even if
a lease remains. Explicit replace, disconnect, and shutdown retire or clear
their owned buffers best-effort. A restart without the matching in-memory
credential always projects `setup_required`, even if an older cache said
`available`.

The built-in API catalog permits only audited HTTPS destinations and fixed
verification/model-discovery requests. It rejects redirects and browser-provided
endpoints, headers, payloads, and model ids. Remote models are intersected with
the installed catalog before becoming opaque options. Verification occurs only
after an explicit user action, uses bounded transport, includes no review
evidence, and never retries or falls back automatically.

API setup response-loss reconciliation compares the authoritative connection
storage revision with the revision captured before intent creation. An existing
unchanged API connection cannot satisfy a replacement attempt. Only an advanced
revision with an active API session may present the reconciled connected choice;
otherwise the dialog remains open with a truthful retryable error.

The key is absent from the browser request URL and headers and from every
persisted or projected value. The server may use it only as the outbound
provider authorization value inside the audited model-discovery and review
transport. That boundary never logs, records, reflects, or copies the value into
an execution environment.

The public review boundary reports `provider_credential_source` as `none`,
`environment`, `control_center_session`, or `subscription_session`. It reports
provider environment-only handling separately from the internal loopback
adapter token. For a session API connection, `provider_credentials_env_only`
and its compatibility alias are false while
`internal_adapter_credentials_env_only` is true. No credential value or private
runtime identifier is exposed by this projection.

Subscription setup uses a separate audited write-capable Codex login adapter.
It accepts only the supported official CLI descriptor and fixed
`login --device-auth` operation, permits one login operation for the user at a
time, and incrementally parses only a bounded official verification URL and
user code. It stores no raw output, device token, provider token, or auth file
content. Cancellation, timeout, opener failure, server shutdown, and ambiguous
exit reconcile through the fixed login-status probe. Its owner-only lock binds
the manager before child creation and binds the exact child after spawn. A
bounded cancellation deadline remains referenced while it is the only
completion authority and is cleared as soon as the operation finishes; it
therefore cannot disappear with a pending shutdown or keep a completed process
alive. A
dead-owner `not_started` lock with no child is stale after safe inode
revalidation and can be recovered during the same boot. A crash in the narrow
`pending` child-binding interval remains fail-closed during the same kernel
boot. Version 1.1 locks record a validated Linux boot identity; a pending lock
requires a dead owner, absent child, stable safe lock inode, and a different
valid current boot identity before automatic stale removal. Legacy, missing,
malformed, or unreadable boot identities cannot acquire that pending-state
proof retroactively and remain closed for a separate trusted local repair. Only
a valid same-boot version 1.1 pending lock is surfaced as a computer-restart
recovery action.

Each Control Center server owns exactly one AI setup runtime. It exposes no
module-global credential map and never mutates `process.env` or caller-owned
environment objects. Execution uses immutable generation snapshots. The
private binding adds profile revision, configuration identity, credential
generation, and runtime instance identity to the existing exact connection,
model, effort, capability, and executable tuple.

## Phase 188-194 media review contract

`ops/MEDIA_REVIEW_POLICY.json` is the tracked authority for media limits,
retention, adapter-catalog discovery, analyzer candidates, thresholds, and the
public no-body boundary. Environment-specific executable paths, digests, and
revisions live only in an owner-readable local profile selected by the policy.
The tracked adapter catalog defines fixed command templates and compatible
schema majors; runtime substitutions are limited to validated operation ids,
owned roots, owned input paths, validated run paths, and a trusted engine.

Media source decisions are pure and network-free. URL normalization rejects
credentials, controls, oversize values, unsupported schemes, and ambiguous
known-service forms. Public labels omit query and fragment. Known official
player URLs yield playback inspection metadata only; generic HTTPS inputs yield
metadata-only status. Neither decision authorizes acquisition.

Each local run creates an unpredictable marker-owned private operation root.
The root and every retained child are current-UID, mode 0700/0600, realpath-
stable, non-symlink, bounded, and outside Git. A private locator record binds
operation id, device, inode, root identity, retention, lease, source digest,
created time, and expiry. Public records contain only the opaque operation id
and digests. The existing artifact resolver is not extended to absolute paths.

The transcript adapter revalidates the trusted Node, Git, and provider
entrypoint executable identities, package root, expected full revision, commit
object inventory, normal index flags, forced-configuration clean diff, and
tracked-file metadata immediately before readiness, initialization, import,
and execution. It calls only the catalog operations. Initialization output must
be one direct-child absolute run path; import output must be the expected contained media
copy; execution must use the fixed real-ASR confirmation and structured JSON.
The normalized JSONL file is read through a stable bounded no-follow descriptor
and validates UTF-8, line and segment limits, finite ordered time ranges, media
duration, and supported schema major. Unknown additive upstream fields are
ignored rather than echoed.
The projected `toolchain_identity` covers the trusted executables, provider Git
state, profile configuration, and declared engine; it does not cryptographically
bind an external provider's untracked Python environment, installed ASR package
bytes, or model-weight bytes. Those omissions are explicit result limitations,
not an end-to-end reproducibility claim.

The technical adapter resolves only configured trusted FFprobe and FFmpeg
candidates and uses fixed argv with protocol, frame, time, per-allocation,
stream-count, stdout, and stderr limits. The fixed runner closes stdin for both
tools, and FFmpeg additionally receives `-nostdin`. Canonical times are integer
microseconds. Cadence gaps are
explicit timestamp-gap inferences rather than proof of encoder frame loss;
saliency is not called eye tracking; audio/video PTS offset is not called lip
sync.

The orchestrator stages and hashes media once, verifies the provider import
copy, then may run transcript and technical analysis concurrently with maximum
concurrency two. It normalizes completion order by time, kind, and stable id.
The public result contains a bounded technical projection, transcript counts
and identity, canonical timeline, deterministic findings, advisory findings,
content-evidence projection, toolchain identities, settings, limitations, and
privacy boundary. Existing metadata-only `video_evidence` semantics do not
change.

Control Center media intake and operations use a separate safe-store namespace
and streaming validation. Upload returns a one-use opaque source id. Start,
cancel, readiness refresh, and cleanup are paired Origin/CSRF-protected
mutations; status, list, and result GETs are passive projections. The ordinary
dashboard response carries the passive bounded media-operation list so existing
pages do not make a new media endpoint request when the feature is unused. Long-running
work executes in a bounded background task and restart never automatically
replays uncertain work. Ephemeral cleanup failure becomes `cleanup_required`.
Retained work remains private until explicit cleanup.

The existing agentic-review repeat flow also uses that passive dashboard read
model to reconcile a lost or malformed mutation response before retrying. It may
adopt a repeated child only when exactly one operation was absent from the
pre-request baseline and matches both the requested parent and repeat mode;
zero or multiple matches preserve the existing idempotency-key retry path. If
the first passive reconciliation read itself fails, the browser performs one
more passive read before that mutation retry; this does not add another
mutation attempt or change the retained idempotency key.

The initial catalog adapter is `node_git_checkout_cli`, but the orchestration,
request, transcript, evidence, and result contracts do not depend on that
runtime kind. Routine provider revisions require only an owner-readable profile
revision and executable-identity refresh. A provider that changes command
shape, result schema major, or runtime kind requires a new or revised catalog
adapter; it must not be accommodated by browser-supplied argv or provider-
specific branches in the service, CLI, or Control Center.

Operation registry version 1.1 adds the ninth `media_review` group and its
source-inspection, readiness/plan, run, cancel, and cleanup operations. This is
additive to the historical roadmap groups 1-8 and does not expose a media MCP
tool.

## Phase 195-201 shared prepared-audio contract

Media policy version 1.1 adds bounded prepared-audio settings and a bounded
first-decoded-timestamp probe count. Adapter catalog version 1.1 preserves
`caller-owned-local-asr-cli-v1` as `source_media` and adds
`caller-owned-prepared-audio-cli-v2` as `caller_prepared_audio`. Missing
`input_mode`, prepared-audio policy, and decoded-probe-count fields are given
safe legacy defaults only while loading an older injected v1 contract; tracked
v1.1 data remains strictly validated.

For a prepared adapter, planning projects its versioned input contract. Run
execution stages and hashes the source as before, preflights the selected video
and audio streams, and uses bounded FFprobe frame records to find the first
valid decoded timestamp for each stream. The video-relative sample-zero origin
is `audio_first_pts - video_first_pts`, rounded from decimal rationals into
integer microseconds. TraceCue then invokes the configured FFmpeg analyzer once
to produce temporary raw `pcm_s16le`, with fixed local-file argv, `-t`, `-fs`,
protocol, allocation, thread, timeout, output, cancellation, and descendant
containment bounds.

TraceCue publishes one exact canonical WAV and one preparation manifest inside
the marker-owned operation root. The WAV is validated through one no-follow
descriptor for owner, mode, link count, device/inode, size, timestamps, header,
sample boundary, and SHA-256 stability. The JSON manifest records source and
audio identities, exact sample counts, signed timeline origin, zero trim and
padding, preparation producer/method/settings/tool identities, limitations, and
false privacy flags; it records no source locator. Temporary PCM is removed
after publication and all remaining private artifacts use mode 0600 under a
0700 directory.

The v2 transcript adapter calls only the catalog's exact readiness, initialize,
`audio import-prepared`, and prepared `local-asr run` argv. It revalidates the
prepared WAV and manifest before registration and again before execution.
FrameCue receives the WAV and manifest, never the original media path. TraceCue
accepts the result only when registration, source identity, prepared identity,
sample timeline, language, producer, preparation producer/method/settings,
adapter, engine, analysis configuration, computation identity, terminal state,
payload size, and payload SHA-256 agree across the captured result and the
private receipt.

The v2 adapter currently resolves a body-free result through a protected
provider receipt and payload layout declared in the tracked adapter catalog.
That layout is revision-bound rather than a provider-wide compatibility claim.
An otherwise valid provider revision that changes the layout, fixed argv, or
contract shape requires a new versioned catalog adapter and focused live
acceptance; updating only the private revision profile is sufficient only when
all adapter-observed contracts remain unchanged.

Transcript cue seconds are converted with rational decimal parsing and shifted
by the signed sample-zero origin. Partially negative video-relative cues are
clipped to zero; wholly pre-video cues are omitted. The public method projection
binds the prepared contract, audio, preparation manifest/settings,
registration, provider receipt, computation identity, and signed origin. It
does not expose a private receipt layout or transcript body. Existing v1
readiness and result projections omit prepared fields exactly as before.

The service prepares audio before starting the transcript and technical
analysis pair. The provider consumes the prepared WAV while the technical
analyzer performs its independently useful visual/cadence/cut/synchronization
measurements; the source audio is not extracted a second time for ASR. No
cross-operation ASR receipt is reused because the current provider does not
cryptographically bind every transitive runtime and model byte. Comparable
configuration identities remain evidence, not cache authority.

Control Center uses the unchanged Video workflow and shared service. Prepared
audio is automatic and private. Readiness preserves component and overall
`unsupported`, and failures are mapped to bounded user-facing messages without
paths, argv, stderr, receipts, or transcript text. The reusable package API
exports `prepareLocalMediaAudio`; CLI names and options, MCP profiles, generic
artifact handling, provider repositories, and browser-review behavior are
unchanged.

## Phase 202-208 saved media review comparison contract

`ops/MEDIA_REVIEW_COMPARISON_POLICY.json` and its strict schema own accepted
result versions, two 1 MiB input limits, total input bound, producer-policy
finding limits, metric selectors, duration normalization, matching thresholds,
output limits, and false execution boundaries. `media-review-comparison.schema.json`
owns the path-free public output. The existing `media-review-result` schema is
unchanged.

The CLI reader accepts only 32-hex operation ids and resolves
`media-review-results/<operation-id>.json` under the configured workspace-owned
artifact root. It opens with no-follow semantics, requires a regular single-link
file owned by the current UID, reads the exact measured size through one
descriptor, probes one byte for concurrent growth, and compares device, inode,
size, link count, ctime, and mtime before and after bounded strict-UTF-8 parsing.
Full result-schema validation precedes hashing/cloning. An iterative bounded
public-data walk rejects cycles, excessive depth/nodes, raw/private bodies,
binary values, absolute/UNC/file paths, and embedded credential- or query-bearing
URL locators.

The comparison core derives run-independent SHA-256 basis identities for three
domains. Technical basis includes result and analysis completion states, result
schema, integer timebase, complete analysis settings, and analyzer method.
Transcript basis includes result and projection completion states, projection
schema/type, availability/language contract, and provider method while excluding
only per-run prepared-artifact/receipt/computation identities. Advisory basis
binds those bases plus result, timeline, and content-evidence completion states,
timeline schema, semantic method, and reviewer thresholds. The historical
comparable-configuration identity is not used because it includes the per-media
identity. Inputs whose top-level result is `insufficient` are rejected.

Policy metrics produce generic `metric_diffs` with explicit deterministic-
measurement, provider-measurement, or advisory-evaluation classification, raw
deltas and, for counts, per-minute normalized deltas. Only comparable
directional metrics emit
`improved` or `regressed`; informational metrics emit `changed`, and limited or
incompatible domains emit `inconclusive`. Deterministic, provider, and advisory
assessment summaries remain separate. Findings first match an exact id plus classification,
kind, method, and identical start/end time, then bounded interval overlap or
midpoint distance with deterministic tie refusal. Producer finding completeness
is checked against the policy-bound total producer limit rather than independent
class totals. States are `new`, `not_detected_in_candidate`,
`unmatched_inconclusive`, `persistent`, `moved`, or `severity_changed`.
Truncation, partial evidence, duplicate ids, ambiguity, heuristic matching, or
domain drift cannot produce a definitive absent/present quality claim.
Projection truncation removes bounded finding changes deterministically until
the UTF-8 byte limit is met, records the limitation, and recomputes summaries and
status before final schema validation.

`trace-cue media review compare --baseline <operation-id> --candidate
<operation-id> [--artifact-root <relative-path>] [--json]` is read-only and has
no execute/confirm mode. The package API exports policy loading, comparability,
pure comparison, stored-result comparison, and Markdown rendering. Operation
registry 1.2 adds `media_review_compare` with read risk and false MCP exposure.

The Control Center media runtime lazily loads the comparison policy only for the
comparison read, so an unused comparison configuration cannot prevent ordinary
media review startup. It lists bounded completed non-insufficient result choices
and compares two in-memory public results through passive GET endpoints. The result
screen defaults the current operation to After and the newest different result
to Before, labels choices by date, duration, and finding count, and offers one
Compare action plus Swap. It renders domain compatibility, technical deltas,
provider-measured speech indicators, measured finding changes, advisory changes,
source-result navigation, and
collapsed limitations without internal ids, paths, source names, provider
details, or a combined score. Loading, retryable option failure, insufficient
history, and in-flight comparison are distinct states. Abort/generation and pair
binding suppress stale results; pair controls remain disabled in flight. A
duration-normalized value is visually primary whenever it drives assessment,
with raw totals marked supplemental. The completed result receives keyboard
focus while only a short status is announced. Desktop, 390px mobile, keyboard,
touch target, privacy, and overflow behavior are browser-owned contracts. A
result and operation are cleared and operation-id guarded on saved-result
navigation so a prior review cannot remain visible under the new route.
