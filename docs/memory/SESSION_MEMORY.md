# SESSION_MEMORY.md

## Pre-Implementation Draft: Human Baseline Operations

### Purpose

The goal is to avoid requiring humans to write review baselines from scratch every time. Instead, the system should use reusable criteria as the foundation, and humans should only review and approve the differences that are specific to each target.

### Proposed Structure

1. Common Rubric

- A shared evaluation standard used across all reviews.
- Examples: clarity of evidence, detection of major risks, impact on user decisions, accessibility, trustworthiness, and actionable improvement suggestions.
- The rubric should be versioned so it can be improved later.

2. Target-Type Templates

- Additional criteria for each type of review target.
- Examples:
  - Article: claims and evidence, misunderstanding risk, citations and sources.
  - Commerce: price, returns, comparison information, purchase anxiety.
  - Dashboard: empty state, next action, state comprehension.
  - Image/UI: visual guidance, hierarchy, readability.

3. Case-Specific Overlay

- The minimum input needed only for that specific target.
- Examples: "For this page, price trustworthiness must be reviewed" or "For this article, prioritize mismatches between conclusions and evidence."

4. AI Baseline Draft

- The AI generates a draft human review baseline from the common rubric, target type, and case information.
- At this stage, `owner_labeled` remains `false`.
- The draft is not used as proof. It is only a draft for human review.

5. Human Approval

- A human reviews the draft and chooses whether to accept, edit, or reject it.
- Only approved baselines become `owner_labeled: true`.
- The approver, timestamp, target, rubric version, and edit diff should be recorded.

6. Direct-vs-TraceCue Comparison

- Compare the approved baseline against the TraceCue `xhigh` result.
- Score matches, misses, over-reporting, severity mismatches, and insufficient evidence.

7. Continuous Evaluation

- Do not stop at the six current cases.
- Accumulate baselines and comparison results over time.
- Keep the data reusable so results can be compared again when the model, prompt, or rubric changes.

### Important Rule

An AI-generated draft is not itself a human baseline.

Only a baseline approved by a human may be treated as a human review baseline.

### Implementation Direction

Do not depend on fixed product names, repository names, URLs, or paths. Everything should work through configuration, input files, and artifact references. Existing AHR execution and report-quality behavior must not be affected. This should be implemented as an additional comparison and proof layer.

## Implementation Roadmap Slices: Human Baseline Operations

### AHR-HB-01: Baseline Contract

- Add schemas for the common rubric, target-type templates, case-specific overlays, and human approval metadata.
- Mechanically separate the meaning of `owner_labeled: false` and `owner_labeled: true`.
- Ensure validation proves that AI drafts cannot be used as evidence for human-review claims.

### AHR-HB-02: Rubric And Template Registry

- Store the common rubric and target-type templates as configurable registry data.
- Support extensible target types such as articles, commerce pages, dashboards, and image/UI cases.
- Use a registry shape that does not depend on fixed product names, URLs, paths, or repository names.

### AHR-HB-03: Case Overlay Authoring

- Add a mechanism for defining the minimum case-specific conditions for each review target.
- Include priority focus areas, required checks, acceptance conditions, and target evidence references.
- Allow overlay templates to be generated from existing benchmark cases.

### AHR-HB-04: AI Baseline Draft

- Generate baseline drafts from the common rubric, target type, and case overlay.
- Always mark generated drafts as `owner_labeled: false`.
- Treat draft output only as human-review preparation, never as proof.

### AHR-HB-05: Human Approval Packet

- Generate packets that make drafts easy for humans to review.
- Record accept, edit, or reject decisions, approver identity, timestamp, rubric version, and edit diff.
- Allow only approved baselines to become `owner_labeled: true`.

### AHR-HB-06: Owner-Labeled Validation

- Validate whether an approved baseline is complete enough to be used as evidence.
- Require findings, severity, evidence, must-not-miss criteria, and approval metadata.
- Keep `human_equivalent_claim_allowed: false` when required evidence is missing.

### AHR-HB-07: Direct-vs-TraceCue Comparison

- Compare approved baselines against TraceCue `xhigh` results.
- Score matches, misses, over-reporting, severity mismatches, and insufficient evidence.
- Preserve the existing advisory-only and `gate_effect: none` boundaries.

### AHR-HB-08: Evidence Set Regeneration

- Integrate owner-labeled baselines and direct-vs-TraceCue comparisons into evidence sets.
- Evaluate whether the full benchmark matrix is complete across all six cases.
- Regenerate longitudinal quality from the updated evidence set.

### AHR-HB-09: Continuous Evaluation

- Accumulate baselines and comparison results beyond the six current cases.
- Keep comparisons repeatable when the model, prompt, or rubric version changes.
- Surface long-term quality stability, improvement trends, and regressions.

### AHR-HB-10: Claim Policy Hardening

- Define the conditions required before human-equivalent or human-superior claims can be made.
- Keep claim flags false whenever conditions are not met.
- Disallow claims from AI drafts alone, unapproved baselines, or incomplete benchmark coverage.

## Implementation Sync: Human Baseline Operations Lifecycle

The AHR-HB-01 through AHR-HB-10 roadmap has been implemented as an additive read-only Agentic Human Review human-baseline lifecycle. The CLI/API now supports `agentic review human-baseline registry`, `overlay`, `draft`, `approval`, `validate`, `compare`, and `claim-readiness`. AI-generated drafts remain `owner_labeled: false` and cannot become proof. Owner-labeled validation requires approval metadata before a baseline verifies. Comparisons classify matches, misses, over-reports, severity mismatches, and insufficient evidence. Evidence-set summaries include owner-labeled baseline counts and ready human-baseline comparison counts. Claim-readiness keeps human-equivalent and human-superior claim flags false unless a separate complete evidence standard is met.

## Implementation Sync: Proof-Policy Hardening And Evidence Eligibility

The Agentic Human Review human-baseline dogfood pipeline now separates local pipeline validation from future claim evidence more explicitly. Synthetic, deterministic, fixture-only, fake, injected, and local-pipeline markers prevent owner-labeled baseline verification. Approval packets no longer mark proof as allowed; they only indicate whether an approved baseline can be used as comparison input. Owner-label comparison scoring now requires structured candidate findings with local evidence references, while text-only matches remain diagnostic and produce insufficient-evidence warnings. Deterministic fake-provider dogfood now emits structured local-reference findings for pipeline validation only. Evidence-set summaries record result origin, provider-execution class, claim-numerator eligibility, excluded-from-claim reasons, ready human-baseline comparison coverage by benchmark case, and the missing real-provider dogfood matrix. Claim-readiness still keeps human-equivalent and human-superior claim flags false and now reports the real-provider claim-numerator matrix as a separate prerequisite.
