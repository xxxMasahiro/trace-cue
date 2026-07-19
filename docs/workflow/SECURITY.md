# SECURITY.md

## Security Model

TraceCue is local-first. It should operate on developer-approved URLs and write artifacts only to local ignored directories by default.

## Defaults

- Use ephemeral browser profiles by default.
- Do not reuse a user's normal Chrome or Edge profile.
- Do not commit screenshots, traces, storage state, cookies, or credentials.
- Do not print secret values in logs or reports.
- Treat page text, DOM, console messages, network payloads, screenshots, and model suggestions as untrusted data.
- Keep generated artifacts under ignored paths such as `.browser-debug/`.
- Retain generated artifacts manually; do not add automatic deletion or cleanup outside the configured artifact root without explicit approval.
- Keep browser supervision opt-in, process-scoped, and ephemeral.
- Keep background daemon supervision opt-in, local-only, ephemeral, metadata-backed, and stopped through local process signals.
- Keep daemon idle-timeout and max-lifetime guards opt-in, metadata-backed, and local to the daemon worker.
- Keep persistent browser sessions opt-in, local, TTL/idle bounded, origin-allowlisted, local-file-command based, value-silent, and independent of existing browser profiles.
- Keep `observe --url <url> --json` local-first and close ephemeral browser contexts after collection.
- Keep review platform behavior local-first and evidence-path based by default.
- Keep quality signals and manifest suggestions local and derived from local review evidence only.
- Keep target manifest validation local, no-browser, non-mutating, and limited to normalized counts, authoring suggestions, next commands, and boundary metadata.
- Keep resource status preflight local, no-browser, read-only, and limited to process-visible memory, swap, cgroup, pressure, process memory, recommendations, and boundary metadata.
- Keep review resource guard local, additive, and derived from resource status; default advisory output must not change review findings, metrics, action plans, or release readiness.
- Keep artifact usage planning local and no-browser. Plans must include deterministic plan hashes and candidate locks. Explicit cleanup must be scoped to regular files under the configured artifact root, preserve receipts, revalidate candidates before deletion, avoid directory deletion, and require `--execute`.
- Keep agent advisory package, request-status, request-detail, ingest, and report local, advisory-only, and separate from deterministic review findings, metrics, action plans, and release readiness.
- Keep agent execution provider surfaces behind the Phase 29 execution adapter: dry-run planning, explicit execution, bounded disclosure, local receipts, and advisory-only normalization.
- Keep agent execution separate from existing workflow status. Dry-run planning is local and no-network by default, writes only local execution metadata and receipts, and does not execute providers or runners.
- Keep API execution gated by a dry-run plan, explicit `--execute`, env-only credentials, bounded disclosure policy, local receipts, and advisory-only result normalization.
- Keep Agentic Human Review as a dedicated CLI-only owner-layer. Planning must be no-provider and produce a human-readable plan hash contract; execution must require explicit `--execute`, the approved plan hash, exact transfer flags, provider/model/surface matching, content-free receipts, advisory-only normalization, and no MCP exposure. Generic `agent execution` must reject Agentic Human Review packages.
- Keep Agentic Human Review schema v2 advisory-only and bounded. Human-review dimensions, provider instruction contracts, review-quality benchmarks, reader-experience review, mechanical-versus-human comparison, human-review coverage, and actionability scores must not mutate deterministic findings, metrics, release gates, existing review artifacts, or MCP permissions.
- Keep Agentic Human Review editorial synthesis local, derived, and non-authoritative. It may reformat existing normalized advisory-result sections and supplied bounded content-evidence summaries, excerpt units, observed claims, and limitations into a source-attributed owner-readable summary, but it must not call providers, expand provider prompts or adapter schemas, read raw pixels, transfer evidence, read credentials, store raw provider responses, expose MCP tools, create or repair findings, satisfy owner-baseline or benchmark proof contracts, change claim integrity, authorize owner decisions, mutate report-quality metrics, change release gates, or enable human-equivalent or human-superior claims.
- Keep Agentic Human Review source understanding local, bounded, and non-authoritative. `--source-text` may read full workspace-confined text locally to derive `source_reading_review` and `source_understanding_review`, but result JSON, Markdown reports, provider payloads, receipts, execution records, and logs must not persist full source text or chunk text. Provider payloads may include only bounded source-reading and source-understanding review records under the existing page-text transfer boundary; source-understanding refs must be compacted to ids and hashes without excerpt text or source locators before external transfer. The `editorial_integrator` may show that source understanding was used before summary-only material, and the natural review body may rewrite bounded source-understanding signals into effort-profiled owner-facing prose, including xhigh critique, verification, counterpoints, evidence limits, and conclusion-change conditions when the xhigh contract is complete. Scaffold markers, internal role/step labels, operational effort labels, quality-target metadata, duplicate or near-duplicate source anchors, and boundary boilerplate must stay out of the prose body when they are already represented structurally. This layer must not call providers, translate source evidence, transfer full source text, store raw provider responses, satisfy proof contracts, authorize owner decisions, alter claim integrity, mutate deterministic findings, change release gates, or enable human-equivalent or human-superior claims.
- Keep Agentic Human Review benchmark, calibration, maturity, human-baseline, longitudinal-quality, source-text effort quality, evidence regeneration planning, and claim-standard-gate diagnostics read-only by default. Benchmark cases, structured benchmark requirement coverage, human-baseline registry/overlay/draft/approval/claim-readiness output, owner-labeled human baseline validation/comparison, source-text standard/deep/xhigh effort-matrix verification, evidence-set summaries, evidence regeneration plans, batch comparisons, evaluator policy diagnostics, xhigh round planning/simulation, claim policy/audit output, claim standard gate output, rubric profiles, calibration comparisons, direct-vs-TraceCue comparisons, editorial-quality comparisons, standard/deep/xhigh maturity plans, benchmark-case matrices, report-quality maturity gaps, and live-provider dogfood readiness may report advisory quality diagnostics, but they must not call providers, read credentials, write benchmark artifacts by default, mutate deterministic review output, change release gates, or authorize human-equivalent or human-superior claims. Editorial-quality comparisons must accept only workspace-confined reference reviews, reject raw media/binary/full-source/credential-bearing reference inputs, and suppress reference prose, candidate prose, source text, local paths, and source locators from output. Source-text effort quality must require standard, deep, and xhigh workspace-confined result artifacts, may optionally read a workspace-confined reference review, may compare bounded source ids/hashes internally to report same-source invariant status, and must suppress full source text, chunk text, direct raw source aliases, candidate full reviews, reference prose, private source identity values, result paths, source locators, source titles, provider responses, and credentials from output. The claim standard gate may return a failed command status for automation, and the evidence regeneration planner may emit dependency-ordered command templates, but those statuses and templates are not deterministic release gates and do not create execution permission. AI baseline drafts are never owner evidence; approved baselines require owner approval metadata before `owner_labeled` evidence can verify; synthetic, deterministic, fixture-only, fake, injected, or local-pipeline markers must remain excluded from owner-baseline verification and future claim-numerator evidence. When a verified owner baseline is attached to `agentic review propose` or `agentic review plan`, only a redacted requirement contract may enter plan hashes or provider payloads; local evidence paths and approval artifacts must stay workspace-confined. Real-provider proof-readiness must stay case-aware: duplicate result counts cannot satisfy a missing benchmark-case/effort cell, supported CLI/API runtime-result wrappers can be unwrapped only for their declared artifact family, raw run-runtime pointers must not be counted as result evidence, missing result cells, mechanical-contract incomplete cells, failed calibration cells, missing case-level `direct-vs-tracecue` comparisons, owner-baseline mismatches, comparison regressions, and raw policy attempts to authorize equality or superiority remain separate blockers, and weak calibration cannot be converted into a claim by wording or prompt changes.
- Keep downstream Agentic Human Review source-text quality owner context whitelist-only, non-proof, and gate-neutral. `owner_review_context.source_text_quality` may carry only bounded counts, statuses, booleans, effort names, pass-condition summaries, output-safety summaries, context diagnostics, and freshness by effort; it must not expose full source text, chunk text, candidate or reference prose, result paths, source locators, source titles, private source identity values, raw hashes, provider responses, credentials, warnings, blockers, claim-readiness conditions, passed states, equality or superiority claim states, release gates, proof status, future claim numerators, provider rerun approval, artifact-write permission, or automatic rerun authority. Prebuilt evidence-set owner context is untrusted input and must be reconstructed from the allowed shape before downstream reuse; unsafe provider/proof/claim/release/artifact-write/rerun authority flags must be forced non-authoritative and may only leave safe diagnostics.
- Keep Agentic Human Review dogfood evidence-pack summarization and review-pack projection read-only, workspace-confined, and proof-neutral. They may summarize evidence-set or dogfood pack manifests into matrix status, owner-review digest, claim-review status, advisory regeneration handoff, owner-facing status, standard/deep/xhigh matrix badges, grouped blockers, top owner actions, trust/safety flags, and pathless advanced references, but they must not call providers, read credential values, transfer evidence externally, write artifacts, launch browsers, expose MCP execution, automatically rerun provider or local commands, output concrete rerun commands, emit detailed result paths or source paths, expose raw hash values in review packs, expose raw provider responses, expose full source text or chunk text, expose candidate/reference prose, mutate deterministic findings, change release gates, or authorize human-equivalent or human-superior claims.
- Keep Agentic Human Review `xhigh` effort enforcement mechanical and fail-closed. Provider-native effort controls may be requested where supported, but TraceCue must not treat provider effort selection as proof that `xhigh` was performed. `xhigh` claim-readiness requires observable role, round, critique, verification, synthesis, structured benchmark, local evidence-reference, placeholder-rejection, and mechanical completion metadata; missing or placeholder provider output, missing case/effort alignment, or missing evidence references must block strict claim-numerator eligibility without changing deterministic release gates.
- Keep Agentic Human Review report-quality diagnostics effort-aware and non-authoritative. Standard and deep missing dedicated critique or verification output may be reported only as expected effort gaps when those roles were not planned, while xhigh missing dedicated critique or verification output must remain a policy warning under the mechanical xhigh contract. This classification must not add provider calls, rewrite provider output, change scores as proof, mutate deterministic review output, change release gates, expose MCP execution, or authorize human-equivalent or human-superior claims.
- Keep Agentic Human Review staged `standard`, `deep`, and `xhigh` execution under the same CLI-only approval boundary as one-shot execution. Staged mode may make multiple provider calls only after the original plan hash, exact transfer flags, provider/model/surface, provider capability hash, and live dogfood gate pass; it must store no raw provider responses, record no credential values, expose no MCP tool, treat stage outputs as non-final normalized metadata, and allow only the final aggregated advisory result to enter existing quality and claim diagnostics.
- Keep Agentic Human Review proof claims fail-closed. `review_claims` and `claim_integrity` may help humans inspect advisory evidence, but unsupported, placeholder, evidence-missing, equality, or superiority claim text must remain diagnostic and excluded from claim-numerator eligibility. Comparison metric diagnostics, owner-baseline gap diagnostics, forbidden-claim absence checks, claim-standard-gate `rerun_plan` targets, and evidence regeneration plans must not be treated as proof, provider execution approval, artifact-write permission, automatic rerun authority, or deterministic release-gate state. Evidence regeneration provider-rerun templates may use plan paths, plan hashes, and transfer flags only after validating an explicit approved-plan registry row or the generic result -> execution -> plan artifact chain; missing, unreadable, mismatched, case/effort-misaligned, or tampered approved-plan data must remain unresolved instead of becoming a trusted provider command.
- Keep Agentic Human Review owner-baseline recovery fail-closed. A candidate result that was produced without a matching owner-baseline requirement contract cannot become ready owner-baseline comparison evidence through local comparison regeneration alone. Claim-standard-gate and evidence regeneration diagnostics may identify the need for a provider result rerun, but the rerun remains approval-required and must resolve only to a matching owner-contract plan or explicit target-registry row. Older plans or results that lack the matching owner-baseline contract must remain unresolved rather than being silently trusted.
- Keep the Agentic Human Review Responses adapter optional, loopback-only, bearer-token gated, upstream-credential-separated, size bounded, no-store, no-tools, and advisory-only. It may convert approved generic provider requests into Responses-compatible provider requests, but it must not become a direct review command, MCP tool, credential store, raw-response store, raw-pixel transfer path, owner-baseline generator, or deterministic release gate. Stronger adapter prompts, schemas, evidence-reference catalogs, compact provider-facing request views, non-secret request section byte diagnostics, required benchmark coverage templates, required owner-baseline finding templates, required owner-baseline coverage templates, canonical `owner_baseline_findings` enforcement, bounded repair retries, owner-baseline structured-finding validation, effective benchmark coverage validation, placeholder role-output diagnostics, or alias normalization must shape advisory output only; they must not authorize broader transfer, raw response persistence, human-equivalent or human-superior claims, or proof from AI drafts and synthetic/local fixtures. Role-level findings, generic advisory findings, and prose may be retained as advisory context, but they must not satisfy owner-baseline proof without matching canonical `owner_baseline_findings` records with catalog-backed evidence. Placeholder diagnostics may expose only bounded stage id, stage kind, role, round, reason, and planned-role-match metadata; they must not persist raw provider bodies, request payloads, credentials, local paths, or rejected provider prose. Unknown provider-supplied evidence-reference ids must not be treated as local evidence references, and owner-baseline forbidden-claim coverage must remain an evidence-backed absence check rather than an advisory claim.
- Keep Responses adapter forbidden-claim absence completion repair-after-attempt only. The adapter may complete missing forbidden-claim absence rows only after a provider repair attempt, only from canonical required coverage templates, only when the provider advisory does not assert that forbidden claim, and only with a catalog-backed evidence reference. Completed rows must be marked adapter-derived, remain advisory-only, and must not become human-equivalent, human-superior, release-approval, deterministic-gate, required-mention, required-dimension, owner-baseline-finding, or prose-derived proof. The completion path must not store raw provider responses, request payloads, credentials, endpoint strings, local paths, or raw artifact contents.
- Keep Responses adapter coverage patch repair provider-authored and bounded. When full replacement repair has already run and the only remaining failure is absent benchmark coverage rows, the adapter may request one missing-only coverage patch from the provider, but it must merge only exact missing labels with catalog-backed evidence references and then re-run the same fail-closed validation. The patch path must not infer required mentions, dimensions, owner-baseline proof, or evidence from prose, URLs, case text, local paths, owner-baseline findings, target-specific branches, relaxed thresholds, or raw artifacts, and it must not store raw provider responses, request payloads, credentials, endpoint strings, local paths, or raw artifact contents.
- Keep Responses adapter owner-baseline label obligations canonical and provider-authored. When an owner-baseline requirement contract is present, every required owner label must be represented by canonical `owner_baseline_findings` with the matching owner label id, linked criterion ids when present, and catalog-backed evidence references; target-specific criteria without linked owner labels remain fallback obligations. Role-level findings, generic advisory findings, benchmark coverage rows, coverage patch output, summaries, page text, target URLs, or prose matches must not be promoted into owner-label proof, and unknown owner label ids or unknown evidence references must remain fail-closed.
- Keep Agentic Human Review provider model resolution fail-closed for live provider execution. Provider-neutral abstract model ids may appear in proposal and plan metadata, but generic API execution must resolve a concrete model from the approved plan/run request or the provider runtime model environment variable before fetch. If only an abstract model is available, the run must fail before provider calls, evidence transfer, raw response handling, or credential disclosure, and diagnostics may report only model ids, source labels, and environment variable names, never credential values.
- Keep the Agentic Human Review generic API provider timeout env-only and contract-bound. Optional timeout overrides may change the provider capability hash and therefore require a fresh approved plan before execution, but they must not read credential values, store secrets, store raw provider responses, expose MCP execution, or weaken default size boundaries.
- Keep the Agentic Human Review Responses adapter upstream timeout explicit and diagnostic-only. The adapter `--timeout` governs the adapter-to-provider request and remains separate from `AGENTIC_HUMAN_REVIEW_API_TIMEOUT_MS`, which governs the TraceCue generic provider request to the adapter. Long dogfood runs must align both timers explicitly, and the default packaged CLI path must keep the repository-local HTTP(S) transport on the configured timers instead of injecting bundled fetch header-timeout defaults. Startup metadata and failure responses may expose the effective timeout and safe duration/failure-class/cause-code fields, but must not expose credential values, raw provider responses, provider request bodies, stack traces, or credential-bearing endpoint strings.
- Keep subscription-agent execution limited to configured local runner callbacks or audited fixed CLI adapters. A fixed adapter may use an already-authenticated supported CLI only with a verified native executable identity, fixed arguments, `shell: false`, a safe allowlisted environment, private temporary state, bounded input/output/time, and process-group cancellation. Do not automate SaaS web UIs or accept browser-supplied executables, arguments, environment values, credentials, or free-form shell commands.
- Keep execution output separate from review findings, metrics, existing action plans, release readiness, resource guard output, artifact cleanup behavior, and existing workflow status meanings.
- Keep content UX advisory manifest opt-in, advisory-only, local-only, bounded to inline source data, limited to bounded review evidence summaries, and separate from existing review findings, action plans, metrics, and release gates.
- Keep content UX page handoff and manifest-authoring output local, bounded, and non-mutating.
- Keep content UX review brief and rubric evaluation output local, bounded, manifest-driven, advisory-only, and separate from existing review findings, action plans, metrics, and release gates.
- Keep review artifact indexes local and evidence-path based; they summarize local artifacts but do not upload, delete, or authorize publication.
- Keep MCP compatibility as local adapters over explicit core operations. Stdio remains the compatibility default; explicit HTTP transport is limited to safe-profile, loopback-only, bearer-token-gated requests.
- Keep plugin metadata local and limited to the stdio MCP adapter and review skill. The packaged `.mcp.json` must not be changed into an HTTP endpoint by default.
- Keep MCP client configuration helpers token-free and no-side-effect. They may emit installed-bin launch metadata, local-checkout launch metadata, absolute local package entrypoint paths, and placeholders, but must not read or print token values, write config files, launch listeners, or broaden MCP permissions.
- Keep MCP capability policy helpers read-only and no-side-effect. They may report profile, transport, bounded full-profile supervise, approved admin-only persistent session tools, approved admin-only agent execution tools, and exclusion metadata, but must not start servers, write files, read credentials, or turn `admin` into any write/execute permission beyond persistent session control and agent execution plan/run.
- Keep consumer usage guidance local, generic, token-free, credential-free, and instructional only. It must not write client config files, launch servers, broaden MCP permissions, publish packages, mutate marketplace state, or authorize evidence transfer.
- Keep consumer target runtime prerequisites in consumer repository policy. Missing local API/backend services may surface as target browser-health findings or `needs_attention`, but TraceCue must not hide them through app-specific runtime branches.
- Keep identity audit read-only and local. It may read product identity metadata and local Git configuration, but it must not mutate Git, contact remotes, write artifacts, launch browsers, broaden MCP permissions, remove legacy aliases, or migrate artifact roots.
- Keep release readiness local and no-publish. It may report package metadata, local release-candidate checks, dry-run status, provenance, and 2FA policy, but it must not read npm tokens, contact registries, publish packages, change package identity, change license state, mutate marketplace state, trigger remote CI, or upload evidence.
- Keep artifact-root policy, status, and migration readiness compatibility-preserving. They may report canonical/future root policy, dual-read/write compatibility, and fixture-confined migration boundaries, but they must not run real migration against developer artifacts, remove legacy artifact-root compatibility, delete files outside the configured artifact root, or broaden MCP permissions.
- Keep legacy alias audit and removal readiness compatibility-preserving. They may report current alias usage, removal blockers, migration guidance, and fail-closed removal state, but they must not remove package bins, MCP aliases, plugin aliases, artifact-root compatibility, or product-doc commitments without explicit approval.
- Keep constrained shell readiness plan-only and fail-closed. It may report use cases, threat model, command schema, CLI plan, and MCP readiness, but it must not import child-process APIs, run shell interpreters, read environment or credential values, mutate files, contact networks, expose MCP shell execution, or accept free-form command text.
- Keep final hardening readiness report-only. It may list local regression and gate plans, but it must not launch browsers, run MCP smoke execution, trigger remote CI, mutate Git, publish packages, call providers, execute shell commands, migrate artifacts, remove aliases, or promote product docs.
- Keep language settings, localization resources, report templates, translation readiness, and translation dry-run local, read-only or dry-run-only, provider-free, and role-separated. Dashboard display locale, artifact output language, UI chrome resources, generated report template chrome, and deterministic fake dry-run output may be inspected by CLI/API/MCP where exposed, but they must not translate source evidence, translate canonical enums, mutate files, launch browsers, call providers, read credentials, contact parent or consumer repositories, or change review gates.
- Keep Agentic Human Review editorial synthesis language alignment local, derived, and advisory-only. The builder may read TraceCue-local language settings and existing normalized advisory-result data to select or report artifact output language metadata, but it must not translate source evidence, raw page text, provider output, repository documentation, canonical enums, selectors, URLs, logs, screenshots, traces, or report bodies; must not expand provider prompts, adapter schemas, MCP tools, proof contracts, metrics, claims, owner decisions, or release gates; and must record source-text preservation when translation execution is disabled.
- Keep operation registry local, read-only, and policy-inspection only. It may classify future operation families, risks, gates, and current MCP exposure, but it must not write artifacts, delete files, capture pixels, call providers, translate evidence, publish packages, migrate artifact roots, remove aliases, run shell commands, broaden MCP permissions, contact parent or consumer repositories, or grant execution authority.
- Keep operation roadmap reporting local, read-only, and governance-only. It may report draft phase A/B/C boundary contracts, sequence, risk, related operations, and approval-bound status, but it must not promote draft phases into product-plan commitments, issue execution tokens, enable execution harnesses, trigger remote CI, write artifacts, delete files, capture pixels, call providers, translate evidence, publish packages, migrate artifact roots, remove aliases, run shell commands, broaden MCP permissions, contact parent or consumer repositories, or grant execution authority.
- Keep operation contracts reporting local, read-only, and contract-only. It may report Phase 61-64 risk taxonomy, gate schema, execute-token shape, receipt shape, and selected registry operation context, but it must not issue tokens, enforce live gates, write receipts, enable execution harnesses, write artifacts, delete files, capture pixels, call providers, translate evidence, publish packages, migrate artifact roots, remove aliases, run shell commands, broaden MCP permissions, contact parent or consumer repositories, or grant execution authority.
- Keep operation policy reporting local, read-only, and readiness-only. It may read repository-local admin policy defaults and report Phase 65-68 CLI plan readiness, disabled generic harness state, safe MCP readiness, and approved admin-only agent execution exposure, but it must not mutate policy config, issue tokens, write receipts from the report, enable generic execution harnesses, write artifacts from the report, delete files, capture pixels, call providers from the report, translate evidence, publish packages, migrate artifact roots, remove aliases, run shell commands, broaden MCP permissions beyond agent execution plan/run, contact parent or consumer repositories, or grant unrelated execution authority.
- Keep operation admin readiness reporting local, read-only, and readiness-only. It may report Phase 69-70 MCP admin execute-token flow, generic harness bridge readiness, and approved admin-only agent execution bridge state, but it must not issue or store tokens, write receipts from the report, enable generic execution harnesses, write artifacts from the report, delete files, capture pixels, call providers from the report, translate evidence, publish packages, migrate artifact roots, remove aliases, run shell commands, broaden MCP permissions beyond agent execution plan/run, contact parent or consumer repositories, or grant unrelated execution authority.
- Keep operation provider readiness reporting local, read-only, and readiness-only. It may report Phase 71-78 provider MCP planning, disclosure defaults, provider catalog metadata, credential environment variable names, approved admin-only fake/local/API execution exposure, and safe MCP status/list contract metadata, but it must not read credential values, call providers, execute local runners, transfer evidence, write artifacts, delete files, capture pixels, translate evidence, publish packages, migrate artifact roots, remove aliases, run shell commands, broaden MCP permissions beyond agent execution plan/run, contact parent or consumer repositories, or grant unrelated execution authority.
- Keep visual review result preparation local, metadata-only, review-index based, and provider-disabled. It may read review artifact indexes and visual evidence metadata but must not read raw screenshot/image bytes, report bodies, DOM payloads, trace contents, console payloads, network payloads, credentials, or environment values.
- Keep visual review execution CLI-only, preparation-based, metadata/local-reference only, and isolated behind provider adapters. It may call local runners or the generic API adapter only after explicit --execute, but it must not read or transfer raw pixels, store raw provider responses, store credential values, mutate existing reviews, change release gates, or expose MCP execution.
- Keep visual review dashboard read-only. It may inspect local visual review metadata and expose safe MCP inspection, but it must not write artifacts, call providers, read raw pixels, mutate existing reviews, or change release gates.
- Keep MCP execution gate policy read-only. It may report required gates for future MCP expansion, but it must not change MCP permissions, write artifacts, delete files, call providers, read credentials, read raw pixels, run shell commands, or change release gates.
- Keep capture readiness and planning read-only. They may report screen, window, and desktop app capability, privacy, artifact-contract, and planning gates, but they must not capture pixels, call OS capture APIs, load native capture dependencies, enumerate windows or processes, write artifacts, call providers, transfer evidence, expose MCP execution, or change release gates.
- Keep capture metadata handoff workspace-confined and CLI/API-only. It may read an existing workspace image file for metadata, but it must not call OS capture APIs, enumerate windows or processes, write artifacts, call providers, transfer evidence, expose MCP tools, embed raw pixels in JSON, or change release gates.
- Keep desktop review provider-preparation planning CLI/API-only and read-only. It may read capture handoff JSON metadata, but it must not reread image bytes, create preparation artifacts, call providers, transfer evidence, expose MCP tools, mutate existing reviews, or change release gates.
- Keep model or vision review disabled by default and label any future model output as advisory untrusted data.

## Approval Required

- External service upload.
- OAuth or browser-login automation.
- Webhooks.
- Persistent credential storage.
- Reading existing browser profiles.
- Network-dependent security audits.
- Remote deletion or package publication.
- Browser profile reuse, storageState persistence outside the approved explicit artifact-auth opt-in, arbitrary shell execution, automatic artifact cleanup, cleanup outside the configured artifact root, or MCP-exposed cleanup execution.
- Model or API review integration outside the Phase 29 agent execution adapter boundary.
- Agentic Human Review MCP exposure, generic `agent execution` routing for Agentic Human Review packages, execution without the approved plan hash, execution without exact transfer flags, raw provider response storage, credential value storage, or treating `agentic_human_review_advisory` output as deterministic release-gate proof.
- Agentic Human Review provider payload expansion that sends local plan paths, execution paths, deterministic review paths, raw review artifacts, raw provider responses, credential values, or credential-bearing non-loopback HTTP endpoints.
- Agentic Human Review provider execution when the run-time provider capability hash differs from the approved plan, when the endpoint contains URL credentials or sensitive query tokens, or when redirects would change the approved endpoint.
- Treating Agentic Human Review structured benchmark coverage, human-baseline registry/overlay/draft/approval/claim-readiness output, owner-labeled human baseline validation/comparison, evidence-set summaries, evidence regeneration plans, batch comparisons, evaluator policy diagnostics, xhigh simulations, longitudinal rollups, claim audits, or claim standard gate output as permission to call providers, transfer evidence, expose MCP execution, mutate deterministic findings, change release gates, treat AI drafts as proof, skip owner approval metadata, or claim human-equivalent or human-superior review quality.
- Agentic Human Review Responses adapter binding to non-loopback hosts, accepting non-loopback Host or Origin headers, forwarding the inbound adapter bearer token upstream, accepting raw pixel bytes, sending local plan or execution paths upstream, enabling provider tools, enabling provider-side storage, persisting provider responses, exposing through MCP, or storing credential values.
- MCP exposure for visual review result preparation, visual review execution, visual review aggregation, or desktop image review handoff execution.
- Sending screenshots, traces, raw DOM, source text, console logs, network evidence, or reports outside the local process.
- Provider execution outside the Phase 29 dry-run, explicit `--execute`, env-only credential, bounded-disclosure, local-receipt, advisory-only boundary; provider SDK integration; provider endpoint expansion beyond an approved adapter; persistent provider credential storage; or exposing agent/API execution through safe/full/HTTP MCP or any MCP surface other than the approved stdio admin agent execution plan/run tools.
- Agent execution that bypasses dry-run planning, explicit `--execute`, local receipts, env-only credential loading, bounded disclosure policy, or advisory-only normalization.
- Any provider credential value in CLI arguments, committed files, package artifacts, workflow files, reports, receipts, `.env` auto-loading, or persistent local storage.
- Raw provider response persistence.
- Raw screenshot, trace, DOM, console, network, sourceData, report body, cookie, storage state, existing browser profile, or raw review artifact transfer by default.
- SaaS web UI automation for subscription-agent execution.
- Reading arbitrary source-data files or remote source-data URLs from target manifests.
- Socket MCP transport, remote HTTP MCP listeners, HTTP `full` or `admin` profiles, MCP cleanup execution, MCP capture execution, MCP shell tools, or credential-bearing MCP workflows beyond env-only agent execution through stdio admin.
- Remote browser control channels.
- System memory-cache mutation, swap configuration, host cache deletion, privileged host helpers, or arbitrary process control.
- Any action policy that executes input-required, mutating, destructive, or external actions without an explicit target manifest allowlist.
- Plugin marketplace registration, plugin installation-state mutation, package license changes, public package naming, or npm publication.
- Artifact-root migration or legacy alias removal.
- Translation execution, external localization providers, or repository-document localization beyond the current English product documentation policy.
- Operation registry, operation roadmap, operation contracts, operation policy, operation admin readiness, or operation provider readiness promotion beyond read-only policy inspection, including any draft-roadmap product-plan commitment, token issuance, token storage, receipt writing outside approved agent execution, write harness, credential value read, external evidence transfer outside bounded agent execution, remote CI trigger, cleanup execution, capture execution, provider execution outside approved stdio admin agent execution, translation execution, package publication, artifact-root migration, legacy alias removal, shell execution, or MCP write/execute exposure beyond agent execution plan/run.
- Release readiness, artifact-root readiness, alias removal readiness, constrained shell readiness, or final hardening readiness promotion into live publication, real migration, alias removal, shell execution, remote CI, product-doc promotion, or MCP write/execute exposure.

## Current Runtime Status

Persistent browser sessions are local and opt-in. A persistent session may retain one Playwright browser context and page across CLI invocations through a local file-command queue under the configured artifact root. The session must have TTL and idle-timeout guards, an origin allowlist, local metadata, and stop behavior that closes the context and browser. It must not use `launchPersistentContext`, `userDataDir`, existing Chrome profiles, OAuth automation, password automation, external upload, remote control channels, or credential-value printing. `session checkpoint --export-storage-state` may export Playwright storageState only when explicitly requested; `session start --storage-state` may import only from the configured artifact auth directory. Both directions must write value-silent metadata or receipts and must not print cookie or token values.

MCP persistent session tools are available only through stdio `admin`. Safe MCP, full MCP, and HTTP MCP do not expose `browser_debug_session_*` tools. Full MCP may expose bounded process-scoped `browser_debug_supervise`, which runs ordered actions in one ephemeral context and closes it before returning; it is not a persistent session and cannot export storageState.

Operation policy reporting remains local, read-only, and safe-MCP inspectable. Operation admin readiness reporting derives Phase 69-70 MCP admin token-flow, generic harness bridge readiness, and approved admin-only agent execution bridge state from policy and registry metadata; it writes no artifacts, issues no tokens, stores no tokens, dispatches no generic harness, performs no live execution from the report, and exposes safe MCP inspection through `browser_debug_operation_admin_readiness`. Operation provider readiness reporting derives Phase 71-78 provider MCP plan, disclosure, credential guard, approved admin-only fake/local/API execution exposure, and status/list readiness from provider and MCP profile metadata; it writes no artifacts, reads no credential values, calls no providers, executes no local runners, transfers no evidence, and exposes safe MCP inspection through `browser_debug_operation_provider_readiness`.

The stdio `admin` MCP profile may invoke the existing `agent execution plan` and `agent execution run --execute` paths with an idempotency key. Safe/full MCP and HTTP MCP cannot invoke execution. Admin MCP execution reuses the Phase 29 plan-match validation, env-only credential handling, bounded disclosure, local receipts, and advisory-only normalization; it must not store credential values, persist raw provider responses, launch browsers, mutate review artifacts, or change deterministic gates.

Artifact cleanup planning records candidate locks and deterministic plan hashes, and MCP exposes planning only. Explicit CLI cleanup revalidates plan hashes when supplied, revalidates path/type/size/mtime/content-hash locks immediately before deletion, writes receipt audit fields, and never deletes directories. MCP cleanup execution remains unavailable.

Capture readiness reports static platform capability, privacy policy, and future artifact/receipt contracts without OS capture API calls, native capture dependencies, window enumeration, process enumeration, raw pixel reads, artifact writes, or MCP execution. MCP exposes capture readiness and planning as read-only safe-profile tools only; capture execution remains unavailable.

Localization resources and report templates provide baseline generated chrome plus supported-locale stubs with deterministic fallback. Translation readiness and dry-run inspect generated UI/report chrome only, preserve raw evidence and canonical enums, call no providers, read no credentials, write no artifacts, and expose only read-only MCP readiness.

Release readiness, artifact-root status/migration readiness, legacy alias removal readiness, constrained shell readiness, and final hardening readiness are local inspection or fail-closed surfaces only. They expose safe MCP readiness/status where configured, but they do not publish packages, run real artifact migration, remove aliases, run shell commands, launch browsers from the report, trigger remote CI, mutate Git, call providers, read credential values, or promote `docs/product/` roadmap commitments.

The local runtime launches Playwright Chromium only for developer-provided `http`, `https`, or `file` URLs. It uses ephemeral contexts by default, writes ignored local artifacts, and closes browser contexts after each observation, action, review, process-scoped supervised run, or stopped daemon run. The local daemon uses a detached worker process, ignored metadata under `.browser-debug/daemons/`, optional local idle/max-lifetime timers, and local process signals only. Persistent browser sessions are the only retained-context exception: they remain local, TTL/idle bounded, origin-allowlisted, command-file based, and stopped through TraceCue session controls; they do not reuse existing browser profiles and do not print cookie or token values. The review platform writes local target manifests, review, layout, screenshot, mock metric, coverage, page expectation, rendered-state evidence, review artifact index, action-plan, advisory, quality-signal, resource-guard, manifest suggestion, optional content UX advisory, optional content UX handoff output, optional content UX review brief/rubric output, and report artifacts under `.browser-debug/`. Language settings read TraceCue-local dashboard settings or defaults, expose bounded `language_settings` metadata in review and dashboard output, and keep translation execution disabled. Operation registry reads only in-process registry metadata and emits policy inspection for future operation groups, current MCP exposure, risks, gates, and boundaries; it writes no artifacts, performs no execution, and grants no MCP permission. Operation roadmap reporting derives phase A/B/C boundary contracts from local runtime metadata and draft memory context; it writes no artifacts, performs no live execution, issues no execution tokens, triggers no remote CI, and does not promote Phase 61-155 into formal product-plan commitments. Operation contracts reporting derives Phase 61-64 contract shapes from local registry and roadmap metadata; it writes no artifacts, issues no tokens, writes no receipts, enables no execution harness, performs no live execution, and exposes only safe MCP inspection. Agent advisory handoff writes local task packages, prompts, normalized advisory results, advisory reports, and receipts under `.browser-debug/`; request status and request detail read local package/result metadata only and request detail writes no artifacts. Agent execution planning writes local dry-run execution metadata and receipts under `.browser-debug/agent-executions/`. Agent execution run requires a matching dry-run plan and explicit `--execute`, routes through the dedicated provider adapter module, writes local run receipts and normalized advisory results, and records dashboard status/list fields. The deterministic fake provider stays local; the configured local runner callback runs only when provided by the embedding process; the generic API adapter uses only named environment variables and an injected or runtime `fetch` transport for bounded package/prompt disclosure. Agent execution does not store credential values, persist raw provider responses, expose agent/API execution through MCP outside the approved stdio `admin` plan/run bridge, launch browsers, mutate review artifacts, or change deterministic review gates. Visual review result preparation writes local metadata-only preparation artifacts and receipts from review artifact indexes and visual evidence metadata only; it does not read raw pixels, call providers, transfer evidence, expose MCP execution, or mutate existing reviews. Visual review execution requires an explicit preparation artifact and --execute, runs only provider adapters, sends metadata/local references only, writes normalized visual review result artifacts and receipts, and does not read raw pixels, store raw provider responses or credentials, expose MCP execution, mutate existing reviews, or change release gates. Desktop image review from capture handoff verifies the handoff source path and media hash against a workspace image before propagating caller-declared screen, window, or desktop app provenance; it does not capture OS pixels, verify surface identity, call providers, transfer evidence, expose MCP execution, or claim TraceCue performed the capture. Visual review aggregation reads existing local visual review result metadata for one preparation, groups untrusted advisory findings, reports conflicts and source effects, writes no artifacts, performs no provider/API calls, reads no raw pixels, exposes no MCP tool, mutates no existing reviews, and changes no gates. Visual review dashboard reads local visual review preparation, execution, result, and language-setting metadata only; it writes no artifacts, performs no provider/API calls, reads no raw pixels, exposes no MCP execution, mutates no existing reviews, and changes no gates. Target manifest validation reads only the explicitly provided manifest input, reuses the normalizer, emits counts and authoring suggestions, does not launch Chromium, does not mutate manifest files, and does not copy sourceData values into output. Resource status preflight reads local process-visible memory, swap, cgroup, pressure, and process memory signals; it does not launch Chromium, write artifacts, mutate system cache, configure swap, delete files, execute shell commands, use privileged helpers, upload evidence, or reuse profiles. Review resource guard reuses that signal for browser-heavy reviews and can stop launch only when explicitly configured with `fail-critical`. Artifact planning reads the configured artifact root without deletion. Explicit artifact cleanup deletes only selected regular files under the configured artifact root and writes a receipt; it does not mutate system cache, configure swap, execute shell commands, use privileged helpers, upload evidence, reuse profiles, or control arbitrary processes. Content UX advisory may use bounded selector, text, accessible-name, allowed-attribute, user-question, review-brief, and rubric evidence already collected by target review, but it does not read arbitrary source-data files or URLs and does not copy source values or expected evidence phrases into advisory findings, action plans, readiness summaries, page handoff, manifest-authoring suggestions, review brief/rubric summaries, or Markdown reports. The MCP stdio adapter exposes profile-gated tool surfaces and preserves compatibility with packaged `.mcp.json`. The HTTP MCP transport is explicit, safe-profile-only, loopback-only, bearer-token gated, Host/Origin validated, request-size bounded, and isolated in the approved transport module. `trace-cue mcp config` emits token-free installed-bin and local-checkout client metadata and placeholders only; it does not launch a listener, write config files, read token values, print token values, or expand MCP profile permissions. `trace-cue mcp capabilities` emits read-only profile, transport, admin policy, and registry-derived excluded-operation metadata only; it does not launch a listener, write config files, read credentials, or expand MCP permissions. `trace-cue mcp execution gates` derives risky operation entries from the operation registry and remains read-only. `trace-cue operation roadmap` remains read-only and is exposed through safe MCP as `browser_debug_operation_roadmap`. `trace-cue operation contracts` remains read-only and is exposed through safe MCP as `browser_debug_operation_contracts`. `docs/workflow/CONSUMER_USAGE.md` is packaged as instructional guidance for external repositories, including target runtime readiness guidance; it does not write client configuration, launch MCP servers, store credentials, expose token values, publish packages, register plugins, authorize external evidence transfer, or hide missing consumer API/backend state through runtime branches. MCP exposes artifact planning but not cleanup execution, read-only local agent status plus approved stdio `admin` agent execution plan/run, approved stdio `admin` persistent session tools, read-only language settings inspection, operation registry, operation roadmap, and operation contracts inspection, and capability policy inspection without enabling unrelated admin write/execute tools. Plugin metadata points to the stdio adapter and the plugin-facing review skill. The runtime and plugin metadata do not read an existing browser profile, persist storage state by default or outside explicit artifact-auth opt-in, automate login, upload artifacts outside the bounded Phase 29 execution policy, store credentials, expose remote HTTP listeners, expose socket control channels, expose HTTP `full` or `admin`, execute arbitrary shell commands, mutate plugin marketplace state, read arbitrary source-data files or URLs, mutate host memory configuration, or contact external services beyond developer-provided page URLs and explicit agent execution API endpoints.

Current redaction is a defensive baseline for common secret-like strings and sensitive URL parameters; page content and artifacts remain untrusted data and should not be treated as sanitized proof of secrecy. Trace zip files can contain raw page content and must remain local under ignored `.browser-debug/` paths.

The control-center browser surface is a dedicated local review plane, not a generic control plane. `control-center status` builds a body-free read model and `/api/dashboard` remains GET-only. `control-center serve` is loopback-only, Host/Origin validated, cache-disabled with `Cache-Control: no-store`, and isolated in `src/control-center-server.js`. The original eight action endpoint paths remain unchanged. Separate namespaced endpoints may persist the bounded Control Center preferences and orchestrate one page-review operation through existing TraceCue browser review and Agentic Human Review APIs.

Agentic review preparation accepts only URL, purpose, effort, viewport, AI-suggestion preference, and a current server-issued opaque AI selection. Browser-supplied provider or adapter ids, model ids outside that opaque selection, endpoint, credential, token, plan, hash, transfer flag, artifact root, executable path, command, or execute authority is rejected. Credentials may enter only through the paired fixed-catalog AI setup channel described below or through existing provider configuration; subscription authentication remains owned by the supported audited CLI. Before any external AI call, the user must see the concrete configured service, model, TraceCue review method, and exact evidence classes and approve a fresh time-bounded nonce. The nonce is stored only as a hash and bound to the prepared disclosure and plan contract. It is single-use. Dispatch is never retried automatically; restart uncertainty becomes `dispatch_unknown` to avoid duplicate evidence transfer or provider billing.

Operation files stay under the configured workspace-confined artifact root,
defaulting to `.browser-debug/control-center-agentic-reviews/`. Browser projections are whitelist-only and omit query strings, paths, hashes, internal provider/adapter ids, endpoint data, credential values, request bodies, raw provider responses, and executable commands. They may show only server-issued opaque AI option ids and bounded user-facing service, model, connection-type, and provider-native effort labels. Only normalized advisory findings and safe summaries are shown. AI output and user decisions do not mutate deterministic findings, proof contracts, owner authority, product gates, or release gates. The browser server still must not expose arbitrary actions, generic provider controls or credential inputs, MCP JSON-RPC, cleanup, shell execution, raw artifact serving, CI trigger/rerun/cancel, automatic retry, or external upload beyond the explicitly confirmed review disclosure. The dedicated paired API setup field is the only credential-input exception. Design-system changes grant no runtime authority.

Repeat-review admission uses a random 256-bit browser key only to reconcile a
lost local response. The browser keeps the pending key and payload in memory,
and the server stores only a scoped digest plus canonical request digest. A
matching active or historical replay returns the existing operation before
capacity evaluation and never schedules a second browser or provider review;
payload drift fails with a conflict. Raw keys must not enter URLs, browser
storage, logs, projections, operation artifacts, or results. This exact-once
admission contract does not weaken the no-retry boundary after external
dispatch may have started.

Every Control Center browser API call has a centralized bounded deadline. The
deadline includes pairing, action-token bootstrap, response headers, and JSON
body parsing and rejects independently of browser abort behavior. AI connection
operations use a separately declared longer bound. A malformed successful body
has no trusted error envelope and is handled as transport uncertainty. A
deadline neither cancels a server-side provider action nor proves that it did
not run. It only releases the UI for action-specific authoritative state reads.
Review polling is suspended during review mutation and reconciliation so a
stale periodic read cannot overwrite the result. External dispatch uncertainty
retains its strict no-automatic-retry boundary, and API credentials are never
resubmitted automatically.

Page-owned AbortControllers and operation generations make explicit navigation
authoritative over late preparation, status, and repeat responses. Component
cleanup aborts pending fetches and delays; a response from an invalidated page
cannot initiate navigation or write current-page state.

The purpose-led Control Center navigation is presentation-only authority. Its
three ordinary destinations and five work-stage labels may route to existing
views and summarize current structured local evidence, but they must not turn
free-form status text, next-action text, command handoffs, paths, effort labels,
or stage selection into execution. The exact existing eight POST actions remain
the complete allowlist; no generic action endpoint is introduced. Purpose titles
for `standard`, `deep`, and `xhigh` select only the existing proposal effort and
do not authorize provider calls, browser launch, evidence transfer, plan/run
execution, or completion. Client timers, fake percentages, canned findings,
synthetic decisions, synthetic recheck results, and evidence-free completion are
prohibited. Removing technical Regression, Evidence, Findings, Advanced,
persistence, and diagnostic disclosures from the ordinary Settings page does not
remove or expand their backend, CLI, API, read-model, security, or disclosure
boundaries.

Playwright Test integration is advisory regression evidence only and is disabled by default. `import_only` may import workspace-confined local artifacts but must not launch browsers, spawn processes, contact networks, call `gh`, or change gates. `playwright-test review-material` and Control Center review projection may read only normalized `playwright_test_result` artifacts, must reject raw Playwright/JUnit/HTML inputs, and must not read raw logs, traces, screenshots, attachments, or source artifact bodies; they must not call providers or APIs, expose MCP execution, write artifacts, trigger CI, or turn review cards into TraceCue findings, proof, or release gates. `local_run` is CLI-only and requires an explicit local plan, matching plan hash, fixed Playwright CLI arguments, timeout handling, `--execute`, local receipts, and redaction; it must not be exposed through MCP or as a Control Center browser-run button. `external_ci` may retrieve existing GitHub Actions artifacts through read-only `gh run list`, `gh run view`, and `gh run download` with exact repository, numeric run id, exact artifact name, confirmation token, and `--execute`; approved external-CI settings may store only non-secret repository/workflow/branch/event/artifact policy, and `fetch-approved` must resolve one matching successful run before delegating to the exact download path. It must not call `workflow_dispatch`, rerun, cancel, approve, comment, set statuses, mutate PRs, or write remote CI state. `/api/dashboard` and Control Center read-model generation must not spawn processes, launch browsers, contact networks, call `gh`, download artifacts, or perform heavy artifact scans. Playwright Test results remain local, advisory, and gate-neutral: they must not mutate TraceCue deterministic findings, Agentic Human Review proof, release gates, product gates, owner-baseline status, or claim readiness.

## Review Platform Security Boundaries

The review platform preserves the current local-first security model while expanding evidence collection. Review findings, screenshots, layout snapshots, mock metrics, console data, network summaries, source snippets, model suggestions, and generated reports remain untrusted data.

The review platform must:

- Store review artifacts only under ignored `.browser-debug/` paths by default.
- Reference screenshots, traces, diffs, and reports by local artifact path instead of inlining large raw payloads into terminal output.
- Separate deterministic findings from heuristic or model-advisory findings.
- Report missing baselines, unstable screenshots, and mock dimension mismatches as `inconclusive`.
- Use target manifest scope, route budgets, and action policy to prevent unintended browsing or destructive interaction.
- Default to same-origin route discovery for site review.
- Execute only navigation and read-only state-revealing actions unless the target manifest explicitly allows broader action classes.
- Keep `review_advisory` local and heuristic; it must not claim model review, human aesthetic approval, or deterministic design quality proof.
- Keep `quality_signals` local and evidence-derived; release-readiness signals are local review gates only and do not authorize publication or external transfer.
- Keep `manifest_suggestions` local and advisory; they may guide manifest edits but must not mutate files, execute broader actions, or authorize external evidence transfer.
- Keep `target validate` local and advisory; it may report normalized counts and authoring suggestions but must not launch a browser, mutate manifest files, read arbitrary source-data files or URLs, copy source values into output, or authorize external evidence transfer.
- Keep `resource status` local and advisory; it may report memory, swap, cgroup, pressure, process memory, warnings, and recommendations but must not launch a browser, write artifacts, mutate system cache, configure swap, delete files, execute shell commands, use privileged helpers, control arbitrary processes, upload evidence, or authorize host cleanup.
- Keep `resource_guard` local and additive; default advisory mode must not change review findings, `metrics.finding_count`, existing `action_plan`, or `quality_signals.release_readiness`, and fail-critical mode must stop only browser-heavy work.
- Keep `resource artifacts plan` local and no-delete; it may report usage, cleanup candidates, candidate locks, and plan hashes but must not mutate files.
- Keep `resource artifacts cleanup --execute` scoped to the configured artifact root, regular files, candidate-lock revalidation, plan-hash revalidation when supplied, no directory deletion, and local receipts; it must not be exposed as an MCP cleanup tool.
- Keep MCP profile selection fail-closed and launch-scoped. The no-profile/default MCP adapter may preserve current `full` compatibility, but low-trust clients should use `--profile safe`.
- Keep the MCP `safe` profile no-browser, no-delete, no-provider, no-shell, and no write/execute effects by construction. Read-only local agent advisory/status MCP tools may be exposed through `safe` only when they do not write artifacts, launch browsers, execute providers, upload evidence, mutate review artifacts, or change gates.
- Keep HTTP MCP transport safe-profile-only, loopback-only, bearer-token gated, Host/Origin validated, request-size bounded, and isolated from the MCP core and runtime modules that own review, resource, agent, provider, cleanup, daemon, and browser behavior.
- Keep MCP capability policy reporting read-only. It may list excluded operations, bounded full-profile supervise exposure, approved stdio `admin` persistent session exposure, and approved stdio `admin` agent execution exposure, but it must not expose cleanup execution, unrelated provider/API execution, visual review result preparation, shell tools, safe/full/HTTP persistent session control, credential handling, HTTP `full` or `admin`, socket transport, or remote listeners.
- Keep the MCP `admin` profile explicit and reserved for local-maintenance expansion; it must not bypass cleanup receipts, explicit execution gates, local-only boundaries, or separate security review requirements.
- Keep consumer usage guidance as documentation over existing CLI/MCP/plugin surfaces. It must not be treated as approval for new transports, broader profiles, execution tools, cleanup tools, provider/API calls, credential-bearing workflows, publication, or marketplace registration.
- Keep MCP structured `@file` input workspace-confined. MCP callers must not be able to read absolute paths, parent-traversal paths, symlink escapes, non-regular files, or oversized files through target manifests or other structured input.
- Keep product identity changes explicit and reviewable. Centralized identity metadata does not authorize package renaming, repository renaming, public package naming, license changes, marketplace registration, npm publication, external upload, credential handling, or MCP transport expansion beyond the approved safe HTTP foundation.
- Keep `agent package` scoped to existing local review artifact indexes and metadata-only artifact references; it must not copy raw screenshots, trace contents, raw DOM, console payloads, network payloads, sourceData values, or report bodies into transfer-ready output by default.
- Keep `agent requests list` and `agent requests show` read-only over local package/result metadata; they must not write artifacts, launch browsers, execute agents, call providers, upload evidence, store credentials, mutate review artifacts, or expose MCP agent execution.
- Keep `agent workflow create` scoped to local package metadata and `.browser-debug/agent-workflows/` plus receipt artifacts; it must not launch browsers, execute agents, call providers, upload evidence, store credentials, mutate review artifacts, or expose MCP agent execution.
- Keep `agent workflow status` and `agent workflow index` read-only over local workflow/package/result metadata; they must not write artifacts, launch browsers, execute agents, call providers, upload evidence, store credentials, mutate review artifacts, or expose MCP agent execution.
- Keep `agent workflow report` scoped to bounded local workflow status summaries under `.browser-debug/reports/`; it must not launch browsers, execute agents, call providers, upload evidence, store credentials, mutate review artifacts, or expose MCP agent execution.
- Keep `agent execution plan` as local dry-run metadata only; it must not call providers, execute local runners, upload evidence, store credentials, launch browsers, mutate review artifacts, or change deterministic gates.
- Keep `agent execution run` gated by explicit `--execute`, env-only credentials, configured provider or runner adapters, local receipts, and advisory-only normalization; it must not accept free-form shell commands, automate SaaS web UIs, store raw provider responses, persist credential values, mutate existing review artifacts, or change deterministic gates.
- Keep `agent execution status` and `agent execution list` read-only over local execution metadata; they may be exposed through MCP as status inspection only and must not call providers, execute local runners, upload evidence, store credentials, launch browsers, mutate review artifacts, or change deterministic gates.
- Keep MCP `agent execution run` limited to the approved stdio `admin` path. Safe/full/HTTP profiles and any future MCP execution exposure outside that path require a separate security review, explicit allowlist change, and tests.
- Keep `agentic review propose` local and non-executing. It may write proposals and receipts under the configured artifact root, but it must not create plan hashes, authorize provider execution, authorize evidence transfer, call providers, read credentials, launch browsers, mutate review artifacts, or expose MCP tools.
- Keep `agentic review plan` local and planning-only. It may read a verified proposal or review index and write packages, plans, and receipts under the configured artifact root, but it must not call providers, read raw pixels during planning, transfer page text, store credentials, launch browsers, mutate review artifacts, or expose MCP tools.
- Keep Agentic Human Review content evidence intake bounded, analyzer-neutral, and source-type generic. `--content-evidence` may read a workspace-confined regular JSON file and carry bounded summaries, content units, claims, limitations, coverage, privacy, and provenance for video, web page, PDF, meeting-note, document, transcript, or other content sources into proposals, plans, packages, advisory results, provider payload filters, report-quality diagnostics, and reports. `--video-evidence` remains a compatibility input that may be projected into generic supplemental `content_evidence`. Both inputs must reject raw media, raw binaries, base64/blob/data URI payloads, raw HTML/PDF bytes, full documents, full transcripts, and truthy raw/full privacy or boundary declarations; may accept explicit false-valued privacy or boundary fields that document raw/full content absence; strip local paths and source locators before provider transfer; keep source-type display labels, bounded-evidence density, and content-review-strength guidance as presentation metadata rather than proof; avoid treating `--allow-raw-pixels` as content-transfer approval; avoid calling or naming an analyzer; avoid downloading or uploading remote content; avoid MCP exposure; avoid owner-baseline, benchmark, claim, or gate satisfaction; and remain advisory-only.
- Keep Agentic Human Review source-text reading and source understanding local, bounded, and source-type generic. `--source-text` may read workspace-confined regular text or analyzer-neutral JSON for transcripts, page text, PDF-extracted text, meeting notes, documents, transcripts, or other textual sources, but the full source text and chunk text must not be persisted in JSON, Markdown, receipts, provider payloads, or reports. TraceCue may store only metadata, hashes, chunk indexes, bounded source-reading excerpts, hash-only local source-understanding excerpt refs, and derived `source_reading_review` and `source_understanding_review` records; must reject raw media, raw binaries, base64/blob/data URI payloads, credential-bearing fields, and raw/full structured content fields; must not download remote content, call or name an analyzer, automate external tools, expose MCP tools, satisfy owner-baseline or benchmark proof contracts, mutate deterministic findings, change release gates, or authorize human-equivalent or human-superior claims. Provider transfer may include only bounded source-reading and source-understanding records under the existing page-text transfer approval boundary; source-understanding refs must be compacted to source ids and hashes before provider transfer and must never include full source text, chunk text, excerpt text, or local source locators. The local `editorial_integrator` may record how source understanding and TraceCue analysis were combined, but it remains advisory-only and non-proof.
- Keep `agentic review quality source-text` read-only over existing source-text result artifacts. It may compare standard, deep, and xhigh metadata, hashes, counts, scores, pairwise deltas, xhigh readiness signals, same-source identity invariants, source-reading/source-understanding source id consistency, raw source/chunk alias diagnostics, output-safety status, and optional reference-review scores, but it must not output full source text, chunk text, candidate review prose, reference review prose, private source identity values, result paths, source locators, source titles, provider payloads, provider responses, credentials, proof-contract satisfaction, deterministic gate changes, or MCP execution authority.
- Keep `agentic review provider-readiness` read-only. It may report provider catalog metadata and environment-variable names, but it must not read credential values, call providers, transfer evidence, write artifacts, mutate review artifacts, or expose MCP tools.
- Keep `agentic review provider-readiness` read-only and plan-contract aware. When a plan is supplied, readiness must validate the plan hash and package contract before reporting provider status.
- Keep `agentic review run` gated by explicit `--execute`, the approved plan hash, package-hash validation, provider capability hash, exact transfer flags, provider/model/surface matching, local receipts, and advisory-only normalization. Generic API provider execution must remain in the dedicated provider adapter module, use env-only endpoint/credential configuration, enforce timeout and size limits, reject credential-bearing non-loopback HTTP endpoints, reject benchmark/dogfood provider-API execution before fetch unless manual live dogfood opt-in is present, avoid sending local plan/execution/deterministic-review paths in provider payloads, apply transfer-flag filtering to both plan-level and package-level visual/text contracts, and avoid storing raw provider responses or credential values. Agentic review run must not mutate deterministic review artifacts, change release gates, or be callable through generic `agent execution` or MCP.
- Keep `agentic review report-quality`, `agentic review status`, and `agentic review list` read-only over local Agentic Human Review result and execution metadata; they must not call providers, execute local runners, upload evidence, store credentials, launch browsers, mutate review artifacts, or change deterministic gates. Report-quality must reject non-advisory artifacts and optional execution/result mismatches, and its maturity output must keep human-equivalent and human-superior claim flags false.
- Keep `agentic review benchmark list/show`, `agentic review calibrate`, `agentic review compare`, `agentic review dogfood readiness`, and `agentic review dogfood plan` read-only over benchmark metadata, existing advisory results, provider env-name readiness, standard/deep/xhigh maturity planning, benchmark-case matrices, and manual dogfood planning metadata. They must not call providers, read credential values, upload evidence, launch browsers, write artifacts by default, expose MCP tools, mutate review artifacts, change deterministic gates, or authorize equality/superiority claims.
- Keep `agentic review human-baseline registry|overlay|draft|approval|validate|compare|claim-readiness` read-only over workspace-confined registry, overlay, draft, approved-baseline, evidence-set, and existing advisory result artifacts. They may normalize owner labels and compare required dimensions, owner labels, required mentions, and forbidden claims, but owner-label scoring must require structured candidate findings with local evidence references, text-only matches must remain diagnostic, and synthetic or fixture-only approval markers must prevent owner-baseline verification. When owner-baseline criteria include owner labels, adapter-produced findings must cite matching owner label ids and catalog-backed local evidence-reference ids, and repair prompts may expose only redacted criterion ids, owner label ids, required fields, xhigh-condition gaps, and allowed evidence-reference ids. These commands must not create human labels without owner input, call providers, read credential values, upload evidence, launch browsers, write artifacts, expose MCP tools, mutate review artifacts, change deterministic gates, or authorize equality/superiority claims.
- Keep Agentic Human Review Visual Evidence Package v2, visible-text provenance, Visible Text Reading contracts, screen-text understanding contracts, Quality Evaluator v3, Human Report v3, benchmark-completion readiness, `xhigh` completion assessment, transfer approval previews, and provider failure diagnostics advisory-only. They must not embed raw pixel bytes, raw DOM, raw report bodies, credential values, raw provider responses, cookies, storage state, or release-gate authority.
- Keep Agentic Human Review Responses adapter repair and failure diagnostics allowlisted. Adapter repair context may disclose only missing contract checklist records, approved criterion ids, owner label ids, required fields, role/round/synthesis gaps, safe counts, timeout/byte metadata, and recommended local evidence-reference ids. Persisted failure diagnostics may include safe loopback adapter codes and staged context, but must not include raw provider responses, request payloads, provider request bodies, authorization headers, credential values, endpoint or URL strings, local paths, stack traces, cookies, sessions, or arbitrary nested payloads.
- Keep Agentic Human Review Responses adapter provider-output JSON wrapper recovery memory-only and fail-closed. The adapter may parse direct JSON, one JSON-string wrapper, one JSON Markdown fence, or one prose-wrapped balanced JSON object, but it must not persist rejected raw text, use permissive parsers or code execution, guess malformed JSON, select among multiple candidates, bypass post-validation, print provider output text, expose endpoint strings, record credential values, mutate deterministic findings, or change release gates.
- Keep language settings, locale resources, report templates, and translation readiness inspection read-only through CLI/API/MCP. Keep translation dry-run deterministic and provider-free. They must not write settings/resource/template files, localize repository documentation, translate raw evidence, translate canonical enums, call providers, read credentials, mutate reviews, expose MCP translation execution, or change gates.
- Keep Agentic Human Review report-template localization limited to TraceCue-owned fixed report text. Locale resources may change headings, labels, fallback sentences, composer connective phrases, source-type display labels, source-text preservation explanations, effort-stance text, and evidence-scope labels according to artifact output language settings, but they must not translate provider-authored advisory text, source page text, supplemental content evidence text, selectors, URLs, evidence identifiers, canonical enums, owner decisions, credentials, raw media, or repository documentation. The local editorial composer may reorder and summarize already-normalized bounded evidence into owner-readable paragraphs, but it must not fabricate source coverage, infer full-source proof, convert summary-only evidence into human-equivalence proof, or treat standard/deep output as dedicated verification.
- Keep `review --image --capture-handoff` caller-declared. It may verify local path and media hash consistency, but it must not claim TraceCue captured the screen, window, or desktop app or verified OS surface identity.
- Keep `visual review aggregate` read-only and source-attributed. It may group existing local advisory output, but it must not write artifacts, call providers, read raw pixels, expose MCP tools, mutate deterministic reviews, or affect release gates.
- Keep `agent ingest` as schema normalization for untrusted advisory JSON only; `@file` input must remain workspace-relative, and it must not execute suggested commands, browser actions, file edits, cleanup, publication, dependency changes, manifest mutations, external upload, or API calls.
- Keep `agent report` separate from existing review reports; it must not mutate review JSON or deterministic gate output.
- Keep `local_content_ux_advisory`, `content_ux_findings`, `content_ux_action_plan`, `content_ux_readiness`, `content_ux_page_handoff`, and `content_ux_manifest_authoring` manifest opt-in and advisory-only; they may use bounded inline `sourceData` and bounded target-review element summaries in process but must not copy source values or full page text into advisory messages or Markdown reports.
- Keep `content_ux_review_brief` and `content_ux_rubric_evaluation` manifest opt-in and advisory-only; they may use manifest-declared page roles, decision needs, rubric criteria, and bounded target-review text summaries in process but must not copy source values, expected evidence phrases, or full page text into Markdown reports.
- Keep content UX manifest-authoring output as suggestions only; it must not write or mutate target manifest files automatically.
- Keep content UX handoff output separate from review findings, `metrics.finding_count`, the existing `action_plan`, and `quality_signals.release_readiness`.
- Treat manifest source `path` or `url` references as ignored advisory inputs until a separate approved loader design defines scope, size limits, redaction, and tests.
- Keep `artifact_index` local and evidence-path based; it is rerun guidance and artifact inventory, not a permission to transfer evidence.
- Keep `model_review_boundary` disabled with `external_evidence_transfer=false` until model/vision review receives explicit approval and security documentation.
- Keep API-provider agent surfaces executable only through the Phase 29 execution adapter boundary with dry-run planning, explicit execution, env-only credentials, bounded disclosure, local receipts, and advisory-only normalization.
- Keep arbitrary shell execution, external upload, persistent browser profile reuse, default storageState persistence outside explicit artifact-auth opt-in, OAuth, webhook handling, and credential storage out of the review MVP.

Security tests block unapproved use of persistent browser profiles, storageState persistence outside explicit artifact-auth opt-in, unapproved listeners, arbitrary shell execution, external upload paths, host cache/swap mutation, cleanup outside the configured artifact root, and MCP cleanup execution.

## Document Synchronization Security

- The document-sync checker reads repository-relative path names and local Git
  metadata only. It must not read changed file bodies, credential values,
  browser evidence bodies, provider responses, cookies, storage state, raw
  pixels, or private source content.
- The checker and hook must not fetch, push, contact a network, call providers,
  launch browsers, execute MCP tools, upload evidence, mutate review artifacts,
  or change release gates. Git invocations are fixed read-only argument lists.
- Temporary memory, ignored local dashboard overrides, ignored browser evidence, build
  outputs, coverage, dependencies, and test reports cannot satisfy a sensitive
  rule. AHR, external-send/provider, MCP, persistent-session, evidence,
  evaluation, and claim classifications cannot be bypassed by an exception
  record or commit message.
- Hook installation is explicit and repository-local. It must refuse another
  configured hook path and uninstall only `.githooks`; npm lifecycle and global
  Git configuration changes are prohibited.
- The CI job receives read-only repository contents permission and no secrets.
  Missing comparison history fails closed rather than disabling enforcement.

## Development Workflow Policy Security

- Development workflow checks read only the repository-local JSON policy,
  instruction authority, test manifest, package scripts, and required-file
  metadata. Required paths are repository-relative, regular, non-symlink files.
- The checker performs no model or provider lookup, credential or environment
  value read, Git mutation, network request, browser launch, MCP action,
  external transfer, artifact write, approval creation, or runtime execution.
- Model and reasoning-effort names are runtime inputs outside the repository
  policy. The policy permits only active-session inheritance and rejects fixed
  override fields. When runtime attestation is unavailable, output must not
  claim a specific effective setting.
- Machine policy output is an omission and consistency signal, not proof of
  approval authenticity, reviewer identity provenance, semantic design quality,
  no-regression completeness, or human-equivalent review quality.
- Development workflow checks must not broaden provider, external-send, MCP,
  browser-session, persistent credential, evidence, deterministic finding,
  release-gate, CI permission, or remote-operation authority.

## Local Dashboard Settings Security

- Tracked `ops/DASHBOARD_SETTINGS.json` is shared defaults and is never written
  by Control Center, Playwright Test, CLI setting actions, or MCP inspection.
- Ignored `ops/DASHBOARD_SETTINGS.local.json` accepts only allowlisted language,
  ordinary Control Center preference, and non-secret Playwright Test branches.
  Unknown safety, persistence, credential, token, cookie, authorization, shell,
  provider, browser, MCP, external-send, destructive, and gate authority cannot
  be enabled through the overlay.
- External-send confirmation remains mandatory even if the local JSON is hand
  edited. Approved external-CI settings retain env-or-gh-auth-only credential
  handling and never store credential values.
- Reads reject oversized, malformed, non-object, non-regular, symlinked, or
  workspace-escaping files. Writes are size bounded, serialized per workspace,
  mode 0600, temporary-file based, and atomically renamed.
- Saving settings performs no browser launch, provider/API call, network or
  `gh` operation, shell/process execution, MCP execution, artifact upload,
  deterministic finding mutation, or release-gate change.

## Verification Execution And Evidence Security

- Verification commands are fixed argv arrays from the repository policy.
  Shell evaluation, absolute executable paths, unknown commands, unbounded
  concurrency, missing limits, and persistent PASS reuse fail closed.
- Verification child processes do not inherit credential-bearing environment
  variables or live-provider opt-in flags from the caller.
- Resource locks isolate Control Center output, browser runtime, package work,
  settings, and evidence mutation. Timeouts and first failure terminate the
  process group and descendants; a success receipt is not written before the
  command and required cleanup finish.
- Shared-runner regression tests must prove the policy-owned fail-closed timeout
  outcome without treating host scheduling latency as runtime authority. A
  wider test-only observation limit does not extend the configured lock timeout,
  and atomic state reads must validate the required record predicate before use.
- Evidence projection must reject symlinked Git evidence roots, receipt stores,
  detail stores, or legacy archives before a write. Receipt reads recompute
  integrity-bound attempt and full-record result digests, and the parent-facing index and
  active detail contain no raw logs, environment values, URLs, credentials, or
  host-specific absolute paths.
- Legacy evidence migration is local and non-destructive: the previous index is
  archived by content digest, never treated as current PASS, and never used to
  suppress missing current required evidence. Parent compatibility checks are
  read-only and cannot edit parent files or weaken parent rejection rules.
- Cached, v2.0, v2.1, missing-required, cross-context detail, standalone,
  partial, mixed-batch, and manually weakened requirement or expiry fields
  cannot satisfy v2.2 authority. Contextual rows stay non-required until a
  dedicated applicability observer proves otherwise.
- Package work uses marked per-run temporary directories and removes them on
  success and failure. Tar inspection rejects traversal, duplicate paths,
  symlinks, hardlinks, unsupported types, invalid checksums, trailing content,
  manifest changes, digest changes, wrong run, wrong revision, wrong package,
  or wrong producer toolchain.
- Dry-run and real npm pack JSON use the same fixed-argv, shell-free, bounded
  file capture. Empty, replaced, short-read, changed, multiply linked, or
  oversized output fails before JSON is trusted; child stdout is not accumulated
  without a bound.
- Playwright cross-run cache scope is browser binaries only. Its key is an exact
  OS, architecture, lockfile, and browser-revision identity with no prefix
  restore. Cache hit never skips browser execution and never stores profiles,
  cookies, storage state, traces, screenshots, reports, receipts, or PASS state.
- Product-gate receipt directories are marked, non-symlink, and repository-local
  below `.git`. Per-attempt receipts are atomic authorities; derived indexes are
  rebuilt under an owner/nonce lock. A live owner lock is never broken by age
  alone. Manual and dirty success cannot be authoritative.
- Active receipt and release-batch count/byte ingress is policy bounded.
  Retention validates directory identity and exact file sets before atomically
  moving superseded records to a separately marked inactive archive. Archived
  history is non-authoritative and not automatically deleted; its total disk
  usage is not represented as bounded authority storage.
- Concurrent evidence writers may skip a redundant locked rebuild only after a
  bounded, no-follow, stable-descriptor ledger read proves the exact receipt
  event is already projected. Ledger presence is only a coalescing signal and
  never replaces receipt integrity or full deterministic rebuild authority. A
  zero-link opened descriptor created by concurrent atomic replacement is never
  trusted as evidence and instead forces the locked retry path; multiple links
  remain a hard failure.
- CI artifacts are same-run transport only, short-lived, revision-bound, and
  content-digest verified. They are not external publication, cannot cross
  workflow runs, and cannot replace consumer tests. The final proof contains
  public run metadata and digests only, never raw logs, environment dumps,
  credentials, URLs, or absolute paths.
- Remote status inspection derives repository identity from the policy-selected
  remote, rejects hosts outside the policy allowlist, requires an exact full
  commit, reads GitHub Actions status through authenticated `gh`,
  and performs no rerun, cancel, dispatch, comment, upload, or repository write.

## Control Center Goal Completion Security

- Control Center private stores are fixed namespaces beneath the selected
  workspace. They reject symlinked components, non-regular or multiply linked
  records, realpath escape, oversized pre-read state, replacement races, and
  unowned directories. Directories use 0700 and files use 0600.
- A store ownership marker may be created only by the process that atomically
  created the root. Existing markerless or foreign roots are never adopted or
  cleaned, and projection-only reads never create a root, marker, or child
  directory.
- Read-transition-write state changes hold an owner/nonce cross-process lock
  and enforce an operation revision. Process liveness and owner identity are
  checked before recovery; elapsed time alone never breaks a live lock. If a
  coordinated release transition exhausts its bounded window, only the same
  unchanged nonce, pid, and process identity may remove the logical lock;
  changed or unsafe ownership fails closed.
- Completed Control Center history is never automatically deleted. A bounded
  active set may move older records into private deterministic hash shards, but
  direct id reads continue through inactive history. Archival holds the same
  per-record lock as publication/update and revalidates state, id, revision, and
  timestamp before moving an active copy, preventing stale-snapshot deletion.
- History retention is deferred, coalesced maintenance outside the primary
  operation or intake transaction. Retention lock contention and archive errors
  cannot change a durable action result, delay confirmed external dispatch, or
  rewrite a completed receipt as failed. Transient maintenance retries are
  bounded and unreferenced, so they neither become process-liveness authority
  nor retry forever.
- Safe-store removal quarantines a selected directory under an internal hidden
  name that cannot match a product record id. A post-enumeration `ENOENT` may be
  skipped only as the result of a concurrent authorized move; all other lookup
  errors propagate. Existing no-follow, ownership, link-count, confinement,
  entry-count, and replacement checks remain mandatory.
- Read-only operation-list projection may retry only bounded transient `ENOENT`
  and `SAFE_STORE_FILE_CHANGED` signals produced by an authorized atomic move
  or replacement. It re-runs the complete safe read and record validation each
  time. Malformed data, identity mismatch, unsafe type, permission, link,
  confinement, and unclassified errors are never converted into retries.
- The internal store-factory test boundary is context-injected only and is not
  derived from HTTP, CLI, settings, environment, provider, or persisted data.
  Production uses the safe local store directly; tests may replace the factory
  only to prove classified retry and fail-closed exhaustion deterministically.
- Intake has an equivalent context-only store-factory test boundary for
  deterministic lock ordering. It is not selectable through any external
  input, and production still resolves the safe local store directly.
- Intake expiry cleanup may release source bytes and abandoned unfinished
  receipts, but it never removes a completed receipt. Completed receipt/result
  history remains marker-owned and manual-retention-only.
- File intake uses unpredictable opaque ids, exclusive streaming temporary
  files, per-kind and total quotas, request timeout, media signature and image
  dimension checks, strict UTF-8/NUL rejection, content digests, expiry, and
  marker-owned cleanup. There is no raw-file read API or browser path input.
- Intake capacity includes unexpired staged and live processing receipts plus
  active reservations; moving a receipt into processing does not release quota.
- Active result capacity includes both published results and live publication
  reservations. A token identifies one completion owner, its lease is renewed
  during long processing, and another process requesting the same opaque id may
  only wait for or read the owner's result. It cannot invoke the engine or free
  the slot. A different id remains closed at the configured bound, including
  while the bound is one; safe turnover archives the previous result first.
- A same-id waiter that reaches the per-id lock before its reservation owner
  records `processing` treats the staged receipt only as a bounded wait signal.
  It releases and retries under the remaining completion deadline only after
  revalidating the exact reservation token and live process identity. It cannot
  take ownership, execute the engine, publish a second result, or convert the
  owner's valid handoff into a failure. An invalid, changed, or dead owner ends
  the wait with a retryable owner-lost response; takeover is permitted only to
  a subsequent explicit request through normal admission.
- Completed active or archived ids bypass new-result admission. Publication is
  committed only when result digest, source release, and completed receipt agree.
  Once the per-id lock proves no worker remains, processing without a valid
  pending pair is failed closed, its safe invalid result and owner reservation
  are removed, and the UI is told not to repeat that engine execution.
- A completed same-id retry may reread only a bounded
  `SAFE_STORE_FILE_CHANGED` transition from active intake storage to owned
  history. It must then revalidate the result digest and completed receipt;
  persistent absence, invalid content, links, and unclassified errors fail closed.
- Intake result projection retains source classification plus bounded failure,
  timeout, and skipped counts so the UI cannot convert missing or adverse
  evidence into a successful review. A completed opaque receipt remains
  one-use even if a client attempts to repeat submission; the React surface also
  removes the original submit action until the user explicitly starts another
  intake.
- Every mutation, including upload, requires the exact active Control Center
  Origin and a random per-server CSRF token held only in memory. Missing,
  foreign, stale, or mismatched tokens and Origins fail closed. Vite and
  production share this route contract.
- Static files are package-relative, size bounded, regular, non-symlink, and
  realpath confined. Responses use no-store, CSP, frame denial, MIME sniffing
  denial, and strict referrer policy.
- Static assets, stored records, and advisory results are inspected and read
  through the same no-follow descriptor with a strict byte bound and final
  identity/size/time recheck. Path validation followed by an unrelated path
  read is not sufficient authority.
- The ordinary AI projection exposes only opaque option ids and bounded user-
  facing connection type, service, model, and provider-native effort labels.
  It never exposes internal provider/adapter ids, endpoints, credential names
  or values, fingerprints, hashes, executable paths, command arguments, raw
  discovery output, raw provider responses, absolute paths, or raw uploaded
  content.
- Dashboard and other read-only GET requests never probe a CLI, spawn a process,
  contact a provider, or write capability state. Discovery is an explicit
  exact-Origin and CSRF-protected POST with bounded work and output. Capability
  cache expiry affects display only; cached state never grants dispatch
  authority.
- AI selection uses server-issued opaque ids. Prepare, confirmation, start, and
  dispatch resolve the private exact connection/model/native-effort tuple again.
  Capability revision, settings revision, configuration identity, and
  executable identity remain separate bindings. Drift blocks before external
  transfer; no connection, model, or effort fallback is allowed.
- Private AI capability state and disposable subscription-adapter staging use
  disjoint owned child directories. A markerless staging parent is never
  adopted as a safe state store, and state creation never deletes or trusts
  staged files. Staging admission and cleanup share one safe-store lock, enforce
  bounded active and scan counts, and fail closed on capacity or lock
  contention rather than reusing or deleting an unverified directory.
- The fixed subscription CLI adapter accepts no browser-controlled executable,
  path, argv, environment, working directory, or command. It resolves an
  approved native POSIX binary, resolves installation symlinks to and validates
  their final target, rejects shell scripts, Windows binaries, and unsafe
  writable executables, and verifies the platform-specific byte length and
  SHA-256 digest from the centralized official package contract. The open
  descriptor and path identity are rechecked immediately before fixed
  `shell: false` launch. Root-owned bubblewrap and `prlimit` isolate process,
  user, mount, IPC, UTS, cgroup, and discovery-network namespaces; cap each
  temporary filesystem at 16 MiB and each written file at 2 MiB; expose no host
  workspace; and permit exactly one bounded result file during execution.
  The safe environment, mode-0700 owned staging, disabled web/MCP/shell tools,
  bounded stdin/stdout/stderr, timeout, and process-group TERM/KILL remain
  mandatory. Discovery output is parsed in memory. The execution last-message
  file is temporary private staging only, is strictly validated through a
  no-follow bounded descriptor, and is removed after every attempt; no raw CLI
  output is retained. Process-start, possible-dispatch, temporary-output, and
  credential-read observations accumulate monotonically after execution; no
  parse, validation, cleanup, or unexpected failure may reset an observed
  external-transfer boundary to a safe pre-send state.
- API credentials come from existing provider configuration or the dedicated
  paired, session-only setup vault. Passive reads never inspect their values;
  explicit server-side refresh and execution may consume them only inside the
  private provider boundary without returning or persisting them. Subscription
  login state remains owned by the CLI. Neither connection type returns
  credential values to the browser or records them in receipts.
- TraceCue `standard`, `deep`, and `xhigh` review contracts are independent of
  provider-native effort. Both exact selections are integrity-bound through
  the operation and plan so a provider capability change cannot silently alter
  review depth or model reasoning effort.
- Confirmation binds immutable input, disclosure classes, service identity,
  and a non-secret destination fingerprint. Dispatch rechecks the fingerprint.
  Only an explicit structured all-false transfer boundary proves a pre-send
  failure. A runner exception, missing/partial boundary, or possible
  post-transmission failure is `dispatch_unknown` unless verified provider
  idempotency proves a safe retry.
- Dashboard, status, list, and saved-result GET requests are projection-only.
  Interrupted-state recovery is an exact-Origin and CSRF-protected POST, and a
  verified pre-send failure cannot be mislabeled as an uncertain dispatch.
- In-process background-task membership, not pid liveness alone, determines
  whether locally owned preparing or dispatching work is still active. A task
  that ended before its final save may be recovered without a server restart;
  a different live process owner remains protected.
- The launcher accepts no caller-defined executable or command. Platform
  adapters use fixed argv and `shell: false`; tests inject an opener and CI
  never starts a desktop application.
- Release evidence is authoritative only as a clean unchanged exact-HEAD batch.
  Source receipts cannot be combined across batches. Remote CI proof is a
  separate validated artifact and never substitutes for local release checks.
- CI proof download is authenticated and read-only. The importer requires an
  exact repository, workflow, run, attempt, successful conclusion, unique
  unexpired artifact, and clean local HEAD/tree match, then parses only a
  bounded non-encrypted regular-file ZIP entry with safe path, size, duplicate,
  and CRC checks before rebuilding the expected proof locally.

## Control Center AI Setup Security

Production launch uses a separate private management capability to mint
one-time pairing tokens; the server retains only digests and binds each token to
one runtime instance, issuance time, expiry, and atomic consumption. A successful
exchange returns a memory-only session bearer and a distinct session CSRF value.
In paired mode, all browser mutations require both values. Health and static
assets remain public loopback reads, while direct serve does not grant privileged
mutations. Pairing, session, CSRF, and management values must never enter public
runtime metadata, dashboard projections, logs, errors, artifacts, package files,
or ordinary launcher results.

Pairing exchange acceptance is ambiguous after timeout, malformed response, or
response loss. The one-time fragment token is never replayed. These failures are
classified as session-ended/reopen-required and do not expose an in-place retry
control backed by the permanently rejected exchange promise.

API credentials use a dedicated bounded octet-stream channel created by a
paired, one-use catalog intent. They must not enter JSON, URLs, browser request
headers, argv, environment variables, browser storage, workspace files,
settings, receipts, or raw diagnostic output. The audited outbound provider
transport may use the value only in its authorization header and must never
return or record it. The server-owned memory vault has strict count, byte,
key-length, idle, and absolute limits. Idle expiry blocks new work and retires
the connection while allowing an already acquired execution lease to finish.
Absolute expiry is a hard boundary: it disables the generation, aborts an
in-flight provider transport, clears the owned credential buffer best-effort,
and closes the adapter even while a lease exists. Replace, disconnect, and
shutdown also retire or clear their owned buffers best-effort. Persistent
Secret Service support is not claimed until a fixed secret runner and isolated
real integration evidence exist; failure must never silently change retention
mode.

The browser keeps the encoded API-key body only until the complete response or
the longer AI-connection deadline settles. Timeout clears the encoded byte
buffer and triggers only an authoritative dashboard read; it does not resubmit
the key. Public review boundaries distinguish the upstream credential source
from the short-lived internal adapter token. A session-vault key is reported as
`control_center_session`, never as provider environment-only; credential values
and private generation identifiers remain excluded.

An unchanged pre-existing API connection cannot be used as evidence that a lost
replacement request committed. Reconciliation requires an authoritative storage
revision increase after the captured pre-action revision before showing a
connected API result.

Provider verification and model discovery use only installed catalog
destinations with exact HTTPS origin, port, path, redirect refusal, bounded
timeouts and responses, and no review evidence. Browser-provided endpoints,
headers, commands, executable paths, and arbitrary models are rejected.
Provider uncertainty is not retried automatically. Fixed subscription login is
a separate write-capable adapter with a supported binary identity, fixed argv,
bounded incremental parser, single-operation ownership, cancellation, timeout,
and status reconciliation. It does not expose raw CLI output or authentication
content and does not weaken the existing read-only execution sandbox. Its
bounded cancellation deadline remains referenced only while it owns shutdown
completion and is cleared on completed cleanup; unrelated runtime handles are
never relied on for this safety boundary. Its
private lock never uses age, PID-only inference, or process-list heuristics to
recover an ambiguous child-binding state. A dead-owner `not_started` lock with
no child can be recovered during the same boot only after unchanged safe-inode
revalidation. Automatic recovery of an ambiguous `pending` binding additionally
requires a valid version 1.1 stored Linux boot identity and a different valid
current boot identity. A same-boot pending binding remains fail-closed and is
surfaced as a computer-restart recovery action. A legacy, missing, malformed,
or unreadable identity cannot prove a pending binding safe; it requires a
separate trusted local repair and is never removed automatically.

The threat model covers remote and cross-origin callers, stale and replayed
sessions, accidental persistence or logging, unpaired browsers, redirects,
configuration drift, and interrupted setup. Root/admin, malicious processes of
the same operating-system user, process-table observers, browser extensions or
developer tools, swap, core dumps, and a compromised supported provider CLI are
outside the boundary. Memory clearing is best-effort and is never described as
complete erasure.

## Media Review Security Boundary

Media review uses an operation-specific private root separate from the normal
workspace artifact root. The root must be unpredictable, outside Git, owned by
the current UID, mode 0700, realpath-stable, marker-owned, device/inode-bound,
and entry/byte/depth bounded. Private files are mode 0600. Absolute locators are
stored only in the private server store and never projected to CLI JSON,
Control Center, ordinary reports, provider payloads, or MCP.

Source identity uses a stable no-follow descriptor and streaming SHA-256 before
processing. Staging and provider-import copies must match that digest. Symlink,
hardlink, special file, owner, mode, signature, containment, inode, device, or
digest drift fails closed. The original source is never deleted by media
cleanup.

Provider execution binds a trusted interpreter, entrypoint, package root,
allowlisted full revision, clean tracked tree, adapter contract, and engine.
Every stage revalidates identity before fixed `shell: false` execution. Browser
input cannot supply executable, path, argv, cwd, environment, engine, model,
root, or provider id. Setup, download, URL ingest, cloud ASR, external send, and
MCP operations are unreachable. Mock output is never production success.
Offline enforcement is application-level: fixed local-file-only argv, trusted
provider identity, offline readiness, and environment restrictions are checked,
but TraceCue does not install a network namespace, firewall, or other kernel-
enforced egress isolation. `network_performed: false` records the supported
orchestration path, not an OS observation of a compromised provider; a
compromised trusted provider or root process remains outside the guarantee.
The trusted checkout identity also does not bind an external provider's
untracked Python environment, installed ASR dependency bytes, or model-weight
bytes. Media results must retain this limitation until the provider exposes a
verified dependency/model identity contract; TraceCue must not infer it by
scanning arbitrary provider-private runtime state.

Normalized transcript material may exist inside the private operation root.
`ephemeral` deletes it after projection and treats cleanup failure as
`cleanup_required`. `project-retained` requires an explicit choice and retains
only the exact marker-owned private root until explicit cleanup or policy TTL;
the body and locator remain non-public. Neither mode copies full transcript,
raw media, raw process output, audio, or frames into normal artifacts or public
results.

Cleanup is a separate operation lifecycle, not an extension of generic artifact
cleanup. It revalidates marker, operation id, UID, mode, device/inode, exact
root/run containment, lease state, file types, links, and bounds; atomically
quarantines the exact root; revalidates it; and deletes only that root. A live
lease, retained root without explicit intent, markerless root, identity drift,
symlink, hardlink, special file, sibling, or normal artifact root is refused.

Technical analysis uses configured trusted FFprobe/FFmpeg candidates with
fixed argv, minimal environment, bounded output, timeout, frame, duration,
stream, and per-allocation limits, and local-file inputs only. The runner closes
stdin for both tools, and FFmpeg additionally receives `-nostdin`. Tool absence is `unavailable` and
never triggers installation. Media URL classification parses text only and
performs no DNS, HTTP, browser navigation, redirect, embed, download, or remote
image request. Credentials and control characters are rejected; query and
fragment are omitted from every projection.

Control Center media uploads use a separate streaming, quota-bound, one-use
source namespace. Paired Origin/CSRF/session checks protect readiness refresh,
start, cancel, and cleanup. Passive GET endpoints do not spawn processes,
access networks, recover state, or mutate artifacts. Restart does not replay an
uncertain operation. Same-UID hostile concurrency, mount namespace attacks,
root/admin, swap, core dumps, and a compromised trusted provider remain stated
limitations rather than false guarantees.

### Prepared Audio Security Extension

Prepared-audio mode preserves the existing operation root and provider trust
boundary. TraceCue gives FrameCue only a caller-owned canonical WAV and a
path-free manifest; it never supplies the original video path to the v2
registration or ASR command. The temporary PCM, WAV, manifest, provider receipt,
payload, and transcript remain under the marker-owned private root. Public and
browser projections carry identities and counts only.

The preparation FFmpeg command is catalog/policy-derived fixed argv with
`shell: false`, closed stdin, local `file,pipe` protocols, one selected audio
stream, removed metadata/chapters, exact codec/rate/channels, `-t`, `-fs`,
allocation/thread/output/timeout bounds, and descendant containment. Reaching
the conservative file cap is failure because it cannot prove completeness.
Containment uncertainty retains the private lease and defers cleanup until the
existing validated restart boundary.

Raw PCM is rebound by owner, 0600 mode, single link, device/inode, size,
modification time, and SHA-256 while the WAV is copied. The published WAV and
provider receipt/payload are read through no-follow descriptors with realpath,
owner, mode, link-count, size, timestamp, and digest checks. Registration,
result, receipt, computation, language, timeline, engine, terminal status, and
payload identities must agree exactly. Symlink, hardlink, replacement,
traversal, oversized body, schema drift, or unexpected field shape fails
closed.

The FrameCue receipt and payload layout used by the v2 adapter is explicitly
revision-bound in the trusted catalog/profile pair. It is not treated as an
undocumented universal provider guarantee. A layout or fixed-command change
requires a new adapter contract and live acceptance. Browser input cannot alter
that layout or select a compatibility fallback.

The manifest records only hashes, byte/sample counts, signed timeline data,
method/settings/tool identities, and false privacy flags. It contains no media
path or URL. Exact transcript text is transient and remains private. Leading
negative cues are clipped or omitted with limitations so signed timeline input
does not bypass non-negative public-time requirements.

Prepared/computation identities support comparison but do not authorize
cross-operation ASR reuse. Real-adapter reuse remains disabled while external
runtime dependencies and model weights are not fully bound. Existing v1 source-
media behavior, MCP execution-disabled profiles, no cloud/fallback/setup rules,
and private cleanup contracts remain unchanged.

## Phase 202-208 Saved Media Review Comparison Security

Comparison is a public-result-only read capability. CLI callers supply two
opaque 32-hex operation ids and an existing relative artifact-root choice; they
cannot supply a result path, URL, executable, argv, provider, analyzer, policy,
schema, or output path. Control Center compares only completed public results
already owned by its media runtime through passive authenticated GET requests.

The stored-result reader resolves the real workspace and artifact directories,
requires confinement, opens the expected result with `O_NOFOLLOW`, and validates
one owner-controlled regular single-link descriptor before and after reading.
It reads exactly the measured size and probes one extra byte so concurrent growth,
shrinkage, short read, or replacement fails closed. Device, inode, size, link
count, ctime, mtime, byte limits, strict UTF-8, JSON, operation-id binding,
complete result schema, node/depth/text/cycle bounds, binary exclusion, forbidden
private/raw keys, and embedded absolute/UNC/file/path or userinfo/query/fragment
URL locator exclusion all fail closed. `file:` variants and protocol-relative
URL/UNC candidates are rejected. Safe special-scheme URL candidates are parsed
after normalization and cannot consume a second scheme, private path, drive
path, or protocol-relative locator hidden behind punctuation. It creates no
directory and writes no receipt or report.

Domain basis identities bind the relevant result, analysis, transcript
projection, timeline, and content-evidence completion states. They deliberately
exclude only run-specific transcript
artifact/receipt/computation ids while retaining provider contract/version,
toolchain, preparation settings, language, analysis policy/settings, analyzer
method, timebase, semantic method, and reviewer thresholds. The historical
configuration identity is not trusted because it also includes source-media
identity. Duplicate finding ids, ambiguous timeline ties, truncated/partial
public evidence, and policy/tool/schema/method drift cannot become definitive
quality claims.

Output limits cap metrics, changes, limitations, and total UTF-8 bytes. When
needed, deterministic truncation removes finding-change entries, marks the
limitation, and recomputes status/summaries before schema validation. The projection
contains only bounded public evidence, hashes, counts, timecodes, methods,
confidence, and recommendations. It contains no raw media/audio/frame/binary,
complete transcript, private payload, source path/name, process output, URL
secret, executable detail, combined score, or implicit persisted comparison.

Provider execution, technical analysis, media preparation, browser launch,
network, external send, cleanup, write, and MCP exposure are false in policy,
schema, runtime, operation registry, API validation, tests, and UI. Existing MCP
profiles and execution gates are unchanged. Same-UID malicious mount-namespace
replacement outside the held file descriptor remains outside this additive
read surface and receives no new authority.

The comparison policy is lazy-loaded by the media runtime. A missing or invalid
comparison policy disables that passive comparison request without weakening or
blocking the ordinary media-review lifecycle. API clients bind returned pair ids
to the requested pair and independently enforce option counts, uniqueness,
summary/classification consistency, and every no-read/write/transfer boundary.
Public comparison input references and API responses accept only completed or
completed-with-limitations status. Metric domain/classification binding keeps
transcript-provider measurements outside deterministic and advisory summaries.
