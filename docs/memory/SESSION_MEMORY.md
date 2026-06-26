# SESSION_MEMORY.md

## Reset Notice

The previous session memory was intentionally cleared at the developer's request on 2026-06-27.

This file now records only the pre-implementation draft roadmap for the TraceCue Agentic Human Review feature. This is a draft roadmap, not a formal product plan, release commitment, live execution permission, provider/API transfer approval, or MCP execution approval. Do not promote this roadmap into `docs/product/*` unless the developer explicitly approves that promotion.

## TraceCue Agentic Human Review Draft Roadmap

### Basic Concept

Add a review capability to TraceCue that is close to a substitute for a human reviewer. The target is not limited to UI/UX. It includes web pages, images, screenshots, text shown on the screen, information architecture, first impression, emotional reception, subjective user perception, and improvement suggestions.

AI agents should operate as multiple sub-agents, and the review depth should vary according to a user-selectable effort mode. The result must remain `advisory-only` and must not be mixed into existing deterministic findings or gate decisions.

### Slice 26: Human Review Boundary And Enforcement

Purpose:
- Define the scope of human-substitute review.
- Treat visual acuity, recognition ability, comprehension, reading ability, sensitivity, subjective review, and "how a person viewing this page would feel" as explicit review targets.
- Separate deterministic findings from agent advisory output.
- Mechanically enforce plan/run separation, plan hash validation, approval receipts, MCP execution prohibition, and advisory-only result writing.

Deliverables:
- Human review boundary contract.
- Advisory-only writer contract.
- Plan/run separation.
- Plan hash and approval receipt model.
- MCP transfer and execution exclusion for the initial stage.
- Regression tests proving that agent advisory output cannot mutate deterministic findings or gate status.

### Slice 27: Review Plan And Human Explanation

Purpose:
- Generate a review plan from a user's natural-language request.
- Explain, in non-engineer-readable language, what will be reviewed, from what perspective, with which sub-agents, at what effort level, and what information may be transferred.
- Require developer approval before any provider execution or deep review begins.

Deliverables:
- `agentic review plan` command.
- Human-readable review explanation.
- Exact command preview.
- Disclosure summary.
- Approval prompt metadata.
- Plan artifact with stable hash.
- No-execution guarantee for planning.

### Slice 28: Multimodal Review Package

Purpose:
- Build a structured package for the AI agents.
- Include visual evidence and content evidence together rather than sending only an image.
- Keep every transferable input controlled by explicit permission flags.

Deliverables:
- Review package schema.
- Image and screenshot references.
- Extracted screen text.
- DOM text summary.
- Accessibility or semantic structure summary.
- URL, route, viewport, target audience, expected impression, rubric, user questions, and existing evidence references.
- Transfer-scope metadata for raw pixels, page text, DOM summary, URL, and artifact references.

### Slice 29: Effort Mode And Sub-Agent Orchestration

Purpose:
- Implement flexible review effort selection.
- Separate the overall review effort from individual sub-agent effort.
- Allow role-specific effort overrides so the user or coordinating agent can tune review depth without manually composing complex commands.

Effort model:

```text
review_effort   = sub-agent count, roles, and review rounds
subagent_effort = reasoning depth for each sub-agent
```

Default modes:

| Mode | Default behavior |
| --- | --- |
| `quick` | 1 agent. Review first impression and obvious visual or text problems. |
| `standard` | 3 agents. Split Visual/UX, Content/Copy, and Accessibility/Comprehension. |
| `deep` | 5+ agents. Independently review visual quality, reading comprehension, sensitivity, flow, risk, and improvement suggestions. |
| `xhigh` | Multiple rounds. Include critic, verifier, and synthesis roles to re-check contradictions and missed issues. |

Sub-agent roles:
- Visual Reviewer.
- UX Reviewer.
- Content Reviewer.
- Audience Reviewer.
- Accessibility Reviewer.
- Risk Reviewer.
- Synthesis Agent.

Deliverables:
- `review_effort` schema.
- `default_subagent_effort` schema.
- `role_efforts` override schema.
- Provider effort mapping when supported.
- Fallback behavior when the provider does not support reasoning effort directly.
- Multi-agent result collation.

### Slice 30: CLI-Only Approved Execution

Purpose:
- Make the first executable implementation CLI-only.
- Let the agent decide an appropriate command during the CLI conversation, but require TraceCue owner-layer validation before execution.
- Reject execution unless the approved plan hash, `--execute`, and required transfer permission flags match.

Example planned command shape:

```bash
trace-cue agentic review run \
  --plan <approved-plan-path> \
  --allow-raw-pixels \
  --allow-page-text \
  --execute \
  --json
```

Boundaries:
- No automatic execution.
- No MCP image transfer.
- No MCP page-text transfer.
- No MCP agentic review execution in the initial stage.
- Provider credentials are env-only.
- Raw provider responses are not stored.
- Results are advisory-only.

Deliverables:
- `agentic review run` command.
- Owner-layer plan validation.
- Transfer permission validation.
- Provider capability validation.
- Receipt writing.
- Fake provider execution path.
- Injected transport test path.

### Slice 31: Human Review Rubric And Output Contract

Purpose:
- Avoid dependence on free-form prompts.
- Define the human-review criteria as schemas.
- Support subjective review, including "how a person viewing this page would feel", while keeping evidence, confidence, uncertainty, and disagreement explicit.

Rubric areas:
- First impression.
- Visual perception.
- UI/UX clarity.
- Readability.
- Meaning and comprehension.
- Copy and tone.
- Trust and credibility.
- Emotional reception.
- Information architecture.
- Flow and next action clarity.
- Accessibility and comprehension.
- Risk and misleading content.
- Strengths.
- Improvement suggestions.

Deliverables:
- Human review rubric schema.
- Prompt template contract.
- JSON-only output normalization.
- Malformed provider response handling.
- Confidence model.
- Evidence reference model.
- Uncertainty and dissent model.

### Slice 32: Advisory Result, Consensus, And Reports

Purpose:
- Integrate AI-agent review output into the existing advisory layer.
- Preserve each sub-agent's view while also producing a readable synthesis.
- Make the output useful to non-engineers without hiding evidence, uncertainty, or disagreement.

Deliverables:
- `agentic_human_review_advisory` result type.
- Per-sub-agent opinion records.
- Consensus summary.
- Dissent and contradiction summary.
- Subjective audience-reaction summary.
- Evidence references to image regions, text snippets, route, viewport, and package inputs.
- Confidence and severity.
- Suggested fixes.
- Report, dashboard, and aggregate compatibility.
- Mechanical separation from deterministic findings, `metrics.finding_count`, and gate status.

### Slice 33: Disclosure, Safety, And Product Gate

Purpose:
- Make the safety boundary mechanically enforceable rather than relying on protocol text.
- Synchronize workflow, security, verification, schemas, and package smoke coverage.
- Pass the product gate with explicit regression tests for the new boundaries.

Deliverables:
- Disclosure summary for images, screenshots, page text, DOM summary, URL, and artifact references.
- Pixel and content transfer receipt.
- Optional future region allowlist/blocklist and masking design.
- Secret and redaction regression tests.
- No credential persistence tests.
- No raw provider response storage tests.
- MCP transfer and execution exclusion tests.
- Advisory-only separation tests.
- Product gate coverage.

## Expected Flow

```text
Natural-language request
 -> trace-cue agentic review plan
 -> non-engineer-readable explanation of review scope
 -> developer approval
 -> plan hash and approval receipt
 -> trace-cue agentic review run --plan ... --execute
 -> owner-layer validation
 -> sub-agent review
 -> consensus report
```

## Mechanical Enforcement Requirements

- Planning must not execute providers.
- Provider execution must require an approved plan.
- The run command must reject a modified or mismatched plan hash.
- Raw pixels, page text, DOM summary, and other transferable inputs must require explicit permission flags.
- MCP-based image transfer, page-text transfer, and agentic review execution must remain unavailable in the initial implementation.
- AI-agent output must be written only to `agentic_human_review_advisory`.
- AI-agent output must not mutate deterministic findings, `metrics.finding_count`, release readiness, or gate status.
- Raw provider responses must not be stored.
- Credentials must be env-only and must never be written to artifacts, receipts, reports, tests, logs, or committed files.
- Product-local tests must prove every boundary above.

## Initial MVP Scope

The realistic first implementation scope is Slice 26-30:

- CLI-only.
- Fake provider plus injected transport.
- Natural-language plan generation with human-readable explanation.
- Developer approval before execution.
- Plan hash and receipt.
- `--execute` required.
- Raw pixels and page text individually permission-gated.
- MCP image and text transfer prohibited.
- Results remain advisory-only.
- Deterministic findings and gate decisions remain unchanged.

## Approval Boundaries

The following remain separately approval-bound:

- Raw pixel transfer through MCP.
- Page text or DOM transfer through MCP.
- Agentic review execution through MCP.
- External API transfer by default.
- Provider SDK additions.
- Persistent credential storage.
- Raw provider response storage.
- Automatic review execution.
- Promotion into deterministic findings.
- Promotion into release gates or product gates.
- Claims that the feature provides guaranteed human-equivalent or human-superior judgment.

## Follow-Up Draft Roadmap: Slices 34-42

This section extends the TraceCue Agentic Human Review draft roadmap after the Slice 26-33 foundation. It remains a draft roadmap, not a formal product plan, release commitment, provider/API transfer approval, MCP execution approval, or approval to weaken the safety boundaries already implemented.

Step 1 has been completed separately:
- The local Slice 26-33 implementation was pushed to `origin/main`.
- GitHub Actions `CI` completed successfully for commit `6498667`.
- The local working tree was clean and synchronized with `origin/main` after CI success.

### Slice 34: Conversational Review Request Intake

Purpose:
- Allow developers and non-engineers to request an agentic review without manually composing complex commands.
- Convert a natural-language review request into a structured review intent.
- Keep this step planning-only, with no provider execution, no external transfer, and no MCP exposure.

Deliverables:
- `agentic review propose` command.
- `--brief`, `--input`, and `@file` support.
- Structured review intent containing target, purpose, target audience, expected impression, requested review areas, and effort candidates.
- Non-engineer-readable explanation of what the review would inspect.
- No-execution guarantee for proposal generation.

Completion criteria:
- A natural-language request can produce a readable review proposal.
- The proposal does not execute `agentic review plan` or `agentic review run`.
- MCP exposure remains unavailable.

### Slice 35: Proposal-To-Plan Candidate Conversion

Purpose:
- Convert a conversational proposal into a candidate input for the existing `agentic review plan` flow.
- Explain required evidence-transfer permissions before a plan hash is finalized.
- Make approval content understandable before any execution can happen.

Deliverables:
- Effort-mode inference.
- Role-specific effort inference.
- Required transfer-flag explanation for raw pixels, page text, DOM summary, URL, and artifact references.
- Exact command preview for the next planning step.
- Human-readable safety and disclosure summary.

Completion criteria:
- The user can see what evidence would be used and why.
- The proposal identifies required transfer permissions in plain language.
- No plan/run approval gate is bypassed.

### Slice 36: Safe Bridge From Proposal To Existing Plan/Run

Purpose:
- Connect `agentic review propose` to the already implemented plan/run safety layer.
- Reuse the existing plan hash, `--execute`, transfer-flag, advisory-only, and MCP-exclusion mechanisms.
- Ensure a convenience flow cannot become a bypass path.

Deliverables:
- Agentic review proposal schema.
- Proposal receipt.
- `agentic review plan --proposal <path>` support.
- Proposal-to-plan provenance metadata.
- Regression tests proving that proposal output cannot run providers directly.

Completion criteria:
- A proposal can create a normal `agentic review plan`.
- The resulting plan still requires plan hash validation and exact run flags.
- Existing `agentic review plan/run` safety behavior remains unchanged.

### Slice 37: Real AI Provider Readiness

Purpose:
- Define real provider connection requirements before allowing provider calls.
- Keep the implementation readiness-focused before adding live transfer.
- Make provider capability, disclosure, credential, cost, timeout, and failure behavior explicit.

Deliverables:
- Provider capability registry.
- Env-only credential policy.
- Declared transferable evidence types per provider.
- Raw response non-storage policy.
- Cost, timeout, retry, and size-limit metadata.
- Provider readiness command or metadata surface.

Completion criteria:
- TraceCue can report what a provider is allowed to receive before execution.
- Credential values are not read, logged, stored, or committed.
- No real provider call is performed in this slice.

### Slice 38: Minimal Approved Real AI Provider Execution

Purpose:
- Add the first live provider adapter behind the existing approval gates.
- Execute only when the stored plan, supplied plan hash, `--execute`, provider selection, and transfer flags all match.
- Normalize provider output into advisory-only results without storing raw responses.

Deliverables:
- Provider adapter interface.
- Request builder.
- Response normalizer.
- Secret redaction.
- Failure receipt.
- Raw response non-storage regression coverage.

Completion criteria:
- Real provider execution is possible only through an approved plan.
- Output remains `agentic_human_review_advisory`.
- Credentials and raw provider responses are not stored.
- MCP exposure remains unavailable.

### Slice 39: Multi-Role Independent Review Execution

Purpose:
- Execute role-specific reviews independently for `standard`, `deep`, and `xhigh` modes.
- Preserve each role's perspective instead of collapsing results too early.
- Make effort selection meaningful across roles.

Default roles:
- Visual/UX.
- Content/Copy.
- Accessibility/Comprehension.
- Subjective Impression.
- Risk/Rebuttal.
- Integrator.

Deliverables:
- Role execution records.
- Role-specific prompts or instruction contracts.
- Role-specific effort application.
- Per-role evidence references.
- Per-role limitations and confidence.

Completion criteria:
- Each role writes an independent advisory record.
- Role effort affects the generated task metadata and execution behavior.
- The deterministic review layer remains unchanged.

### Slice 40: Critic, Rebuttal, And Integration Rounds

Purpose:
- Improve review quality in `xhigh` mode by adding review rounds beyond first-pass findings.
- Detect contradictions, unsupported claims, weak subjective impressions, and likely missed issues.
- Produce an integrated result without hiding dissent.

Deliverables:
- Critic round.
- Rebuttal round.
- Consistency check.
- Consensus extraction.
- Dissent and uncertainty extraction.
- Integrator summary.

Completion criteria:
- The final report separates consensus, dissent, and uncertainty.
- Subjective impressions include supporting rationale.
- Weak or unsupported claims can be downgraded or flagged.
- Output remains advisory-only.

### Slice 41: Real-Page Dogfood Foundation

Purpose:
- Create a repeatable way to test agentic review quality on real pages and screenshots.
- Use dogfood runs to evaluate whether reviews are useful to humans.
- Preserve review comparison metadata without turning advisory output into deterministic gates.

Deliverables:
- Dogfood target manifest.
- Repeatable review input set.
- Review quality rubric.
- Snapshot and comparison metadata.
- Fixture strategy for stable examples.

Completion criteria:
- The same target can be reviewed repeatedly and compared.
- Visual, text, content, and flow review quality can be evaluated on real pages.
- Dogfood evidence remains local and approval-bound.

### Slice 42: Report Quality And Human-Usability Tuning

Purpose:
- Make the final review report useful to both non-engineers and developers.
- Turn subjective impressions into actionable, evidence-backed feedback.
- Reduce vague comments, thin opinions, and ambiguous recommendations.

Deliverables:
- Non-engineer summary.
- Developer action plan.
- Priority, impact, and suggested-fix fields.
- Dedicated "how viewers may feel" section.
- Report quality checks for clarity, usefulness, evidence support, and actionability.

Completion criteria:
- Reports explain what users may feel, why, and what to improve.
- Findings are specific enough to guide product work.
- The report distinguishes subjective perception from objective evidence.
- Advisory-only and deterministic-gate separation remains intact.

## Recommended Implementation Order

Implement Slices 34-42 in this order:

```text
34 conversational intake
 -> 35 proposal-to-plan candidate conversion
 -> 36 safe bridge into existing plan/run
 -> 37 real provider readiness
 -> 38 minimal approved provider execution
 -> 39 multi-role independent review
 -> 40 critic/rebuttal/integration rounds
 -> 41 real-page dogfood foundation
 -> 42 report quality tuning
```

The key safety principle is that Slices 34-36 should be completed before live provider execution. That ensures every future provider-backed review still passes through a human-readable approval explanation, stored plan, plan hash, exact transfer flags, explicit `--execute`, local receipts, MCP exclusion, and advisory-only result handling.

## Implementation Sync: Slices 34-42

Status:
- Implemented in TraceCue as a CLI-only Agentic Human Review continuation.

Implemented capabilities:
- `agentic review propose` for non-executing conversational intake and proposal artifacts.
- `agentic review plan --proposal` with proposal-hash verification and fresh plan-hash generation.
- `agentic review provider-readiness` with provider catalog and environment-variable-name diagnostics only.
- Generic API provider execution through the existing approved `agentic review run` path.
- Package-hash validation and exact transfer flags for externally transferable evidence classes.
- `agentic review report-quality` for read-only advisory report quality diagnostics.
- Role execution records, review claims, round records, critique records, rebuttal records, integration records, dogfood metadata, and report-quality metadata in advisory output.
- Provider adapter isolation in `src/agentic-human-review-providers.js`.
- Proposal, provider-readiness, and report-quality schemas.

Preserved boundaries:
- Proposal and readiness do not authorize provider execution or evidence transfer.
- Agentic review execution still requires matching plan hash, explicit `--execute`, provider/model/surface match, package-hash validation, and exact transfer flags.
- Raw provider responses and credential values are not stored.
- Deterministic review findings, metrics, release gates, existing review artifacts, and MCP permissions remain unchanged.
- Agentic Human Review remains excluded from safe, full, and admin MCP profiles.
