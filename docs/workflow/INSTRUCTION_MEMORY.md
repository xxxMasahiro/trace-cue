# Instruction Memory

This file records durable implementation instructions for autonomous agent
work in this repository. Agents must follow this workflow unless a newer
developer or repository instruction explicitly supersedes it.

## Core Principle

Agents should assume autonomous implementation by default. Developer approval
is not required during the normal implementation flow except at the approval
points explicitly listed in this file, or when an irregular condition, safety
issue, external dependency, destructive operation, unclear requirement, or
repository policy conflict makes approval necessary.

Implementation must always be designed for changeability. Do not hard-code
product names, repository names, URLs, file paths, branch names, provider names,
model names, or fixed values into reusable product code or automation. Keep
them configurable and replaceable. Existing functionality must not be traded
off or regressed.

## Mandatory Pre-Implementation Gates

For every developer-approved implementation range, equivalent continuation
instruction, or non-trivial implementation task, `A. Pre-Implementation
Proposal` and `B. Implementation Plan` are mandatory sequencing gates before
any file mutation, state-mutating command, implementation work, commit, push,
pull request, merge, or CI action.

These gates are developer-approval checkpoints. Present `A.
Pre-Implementation Proposal` and stop until the developer approves A. After A
is approved, prepare and present `B. Implementation Plan`, then stop until the
developer approves B. Only after B is approved may implementation begin. After
B approval, implementation proceeds autonomously under the approved plan until
completion unless this file requires separate approval, the developer
interrupts, the plan materially changes, or an irregular condition occurs.

Skipping, silently merging, deferring, or reconstructing these gates after
implementation has started is a protocol violation. Repeat A and B for each
newly approved implementation range before the first edit. Prior proposal or
plan text may be referenced, but it is insufficient unless refreshed against
the current repository state and current range.

Multiple `xhigh`-class high-reasoning subagent review is mandatory before any
non-trivial implementation proposal or implementation plan. A change is
non-trivial if it affects runtime code, product behavior, contracts, schemas,
tests, security, external transfer, provider behavior, MCP or tool exposure,
release, CI, GitHub operations, verification gates, or durable workflow
authority. For typo-only, formatting-only, or mechanical synchronization
changes that do not alter behavior or authority, the agent may record a brief
reason that the multi-subagent gate is not applicable. If classification is
uncertain, apply the gate.

If required subagent tools are unavailable for a non-trivial change, stop and
report the blocker or ask for direction. Do not silently continue. If any
existing-feature tradeoff appears necessary, stop before planning or
implementation and ask the developer.

## Start

Use this template when the developer asks the agent to implement a numbered
roadmap range:

```text
Start:
[Roadmap: start number - end number] must be implemented step by step in the
order A -> B -> C -> D -> E -> F -> End.

After [Roadmap: start number] is complete, continue to
[Roadmap: start number + 1]. After [Roadmap: start number + 1] is complete,
continue to the next integer step. Continue in order until
[Roadmap: end number] is complete, then report to the developer.

After A and B are approved, implementation through C and D is autonomous by
default, so developer approval is not required unless this workflow explicitly
requires it or an irregular condition occurs. E and F are separate
post-completion approval checkpoints. Do not stop the development flow
unnecessarily after B approval.
```

## A. Pre-Implementation Proposal

Before implementation:

1. Read the invariant rules in both the parent workflow entry instructions and
   this repository's `AGENTS.MD`. Parent repositories remain read-only for
   TraceCue work.
2. Follow the product-development workflow used by this repository.
3. Apply the mandatory multi-subagent rule from `Mandatory Pre-Implementation
   Gates`. Use distinct `xhigh`-class high-reasoning subagents to inspect risks,
   missing requirements, refactoring opportunities, ecosystem fit, reuse,
   generality, and no-regression concerns for every non-trivial proposal.
4. Consolidate the subagent findings into one systematic pre-implementation
   proposal with accepted, deferred, and rejected findings.
5. Keep the proposal focused on the roadmap slice and on preserving existing
   behavior.

The proposal gate must visibly include the roadmap range or task scope,
repository boundary confirmation, documents read, invariant and safety risks,
refactorability and reuse opportunities, ecosystem fit, generality, existing
behavior that must not regress, an explicit no-tradeoff statement,
approval-bound operations, verification and evidence strategy, and subagent
findings or the recorded reason the multi-subagent gate is not applicable.
After presenting the proposal gate, stop and wait for developer approval before
preparing the implementation plan.

## B. Implementation Plan

After the proposal:

1. Read the same invariant rules and relevant product/workflow documents again
   as needed.
2. Produce an implementation plan that maps the roadmap slice to concrete code,
   document, contract, and verification changes.
3. Apply the mandatory multi-subagent rule from `Mandatory Pre-Implementation
   Gates`. Use distinct `xhigh`-class high-reasoning subagents to validate every
   non-trivial plan before implementation starts.
4. Keep the plan refactorable, reusable, generic, and compatible with the
   repository ecosystem.
5. Do not introduce trade-offs against existing features.

The implementation-plan gate must visibly include per-roadmap-step mapping to
code, document, contract, manifest, test, and verification changes; ordered edit
sequence; reuse and refactor points; compatibility and no-regression checks;
required local gates from `AGENTS.MD` routing and verification policy; evidence
artifacts or commands to report; and explicit approval and stop triggers.
After presenting the implementation-plan gate, stop and wait for developer
approval before starting implementation.

## C. Implementation

During implementation:

The required A/B gate outputs are pre-implementation reports and do not count as
unnecessary mid-plan reports.

1. Start only after the user-visible `A. Pre-Implementation Proposal` and
   `B. Implementation Plan` gate outputs have both been presented and approved
   by the developer for the current implementation range or task.
2. Implement each roadmap step in strict numeric order.
3. Continue autonomously until the implementation plan is complete.
4. Keep changes scoped to this repository.
5. Keep product documents, workflow documents, contracts, manifests, tests, and
   implementation synchronized when behavior changes.
6. Repeat focused verification and tests until the changed surface is proven.
7. Do not report back mid-plan unless the plan completes, a permitted approval
   point is reached, or an irregular blocking condition occurs.

## D. Git And GitHub Operations

After implementation and local verification are complete:

1. Review the final diff and confirm that only intended files changed.
2. Treat the approved roadmap implementation scope as approval to commit the
   completed implementation after required local checks pass. Do not add a
   separate commit-only approval checkpoint unless an irregular condition,
   unsafe operation, destructive action, unclear requirement, external-send
   decision, repository policy conflict, or unexpected repository state occurs.
3. Commit the completed implementation with a clear commit message only after
   the required local checks pass.
4. Continue push, remote operations, GitHub operations, PR CI, merge, main CI,
   and local/remote synchronization as part of the same approved roadmap
   completion scope. Do not add separate per-action approval checkpoints unless
   an irregular condition occurs.
5. Push the commit to the configured remote branch as part of the approved
   completion scope.
6. Complete the repository's configured integration route as part of the
   approved completion scope:
   - If the repository is using pull requests, complete PR CI, merge, and then
     confirm main CI.
   - If the repository is using direct main pushes for the current task,
     confirm the main CI run for the pushed commit.
7. If CI fails, fix the failure, recommit or amend as appropriate, push again,
   and repeat CI confirmation within the approved scope.
8. Fetch the remote branch and confirm local `HEAD` and the remote tracking
   branch point to the same commit.
9. Confirm that the working tree is clean.

Do not treat implementation as complete while local changes remain uncommitted,
local and remote branches are out of sync, or the main CI status is unknown or
failing.

## E. Next Proposal

After the implementation range is complete and Git/GitHub operations are
finished:

1. Present a pre-implementation proposal for what should be done next.
2. Keep the proposal grounded in the product goal, current repository state,
   completed work, remaining risks, and user-facing value.
3. After presenting the next proposal, stop and wait for developer approval
   before preparing or presenting `F. Roadmap`.

## F. Roadmap

After the next proposal is approved by the developer:

1. Slice the next implementation roadmap into numbered integer steps starting
   at `1` unless the developer requests a different range.
2. Make every slice independently understandable, verifiable, and aligned with
   the implementation goal.
3. Include code, contract, document, test, verification, and release/sync work
   as separate slices when that makes progress easier to audit.
4. Report the completed implementation range and the next roadmap to the
   developer. After presenting the roadmap, stop and wait for developer
   approval of the next implementation range or an equivalent continuation
   instruction before returning to `Start`.

## End And Loop

After the F roadmap checkpoint is approved as the next implementation range or
an equivalent continuation instruction, return to `Start` and continue with
the same workflow.

Developer approval is not required outside the approval points defined here
unless an irregular condition, policy issue, unsafe operation, unclear
requirement, external-send decision, destructive command, or unexpected
repository state makes approval necessary.

## Completion Evidence To Report

When reporting completed implementation work, include:

- commit short SHA and commit subject, if a commit was approved and created
- main CI workflow name, run identifier, and result, if CI was approved and run
- local `HEAD` SHA and remote tracking branch SHA when synchronization was
  approved and completed
- working tree status
- A/B gate evidence: where the pre-implementation proposal and implementation
  plan were presented, where each was approved, plus any refreshed plan
  deviations during implementation
- E/F gate evidence: where the next proposal and roadmap were presented, where
  each was approved, plus the approved next implementation range or equivalent
  continuation instruction
- any irregular condition encountered and how it was resolved
