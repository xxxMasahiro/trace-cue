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

Implementation is autonomous by default, so developer approval is not required
unless this workflow explicitly requires it or an irregular condition occurs.
Do not stop the development flow unnecessarily.
```

## A. Pre-Implementation Proposal

Before implementation:

1. Read the invariant rules in both the parent workflow entry instructions and
   this repository's `AGENTS.MD`. Parent repositories remain read-only for
   TraceCue work.
2. Follow the product-development workflow used by this repository.
3. Use multiple `xhigh`-class high-reasoning subagents where useful to inspect
   risks, missing requirements, refactoring opportunities, ecosystem fit,
   reuse, and generality.
4. Consolidate the subagent findings into one systematic pre-implementation
   proposal.
5. Keep the proposal focused on the roadmap slice and on preserving existing
   behavior.

## B. Implementation Plan

After the proposal:

1. Read the same invariant rules and relevant product/workflow documents again
   as needed.
2. Produce an implementation plan that maps the roadmap slice to concrete code,
   document, contract, and verification changes.
3. Use multiple `xhigh`-class high-reasoning subagents where useful to
   validate the plan.
4. Keep the plan refactorable, reusable, generic, and compatible with the
   repository ecosystem.
5. Do not introduce trade-offs against existing features.

## C. Implementation

During implementation:

1. Start only after proposal and plan context is synchronized.
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
2. Request developer approval before committing. If the developer's latest
   instruction already explicitly authorizes committing the current change,
   that instruction counts as the commit approval.
3. Commit the completed implementation with a clear commit message only after
   the required local checks pass.
4. Push, remote operations, GitHub operations, PR CI, merge, main CI, and
   local/remote synchronization remain approval-bound until the current
   developer instruction or the approved implementation workflow explicitly
   authorizes those post-commit completion steps.
5. After an approved commit is complete, continue push, integration checks, CI
   confirmation, and local/remote synchronization autonomously when those
   post-commit completion steps are authorized. No additional developer
   approval is required after the commit unless an irregular condition occurs.
6. Push the commit to the configured remote branch only when push is approved
   by the current post-commit completion scope.
7. Complete the repository's configured integration route when CI or
   integration verification is approved by the current post-commit completion
   scope:
   - If the repository is using pull requests, complete PR CI, merge, and then
     confirm main CI.
   - If the repository is using direct main pushes for the current task,
     confirm the main CI run for the pushed commit.
8. If approved CI fails, fix the failure, recommit or amend as appropriate,
   push again, and repeat CI confirmation within the approved scope.
9. Fetch the remote branch and confirm local `HEAD` and the remote tracking
   branch point to the same commit when synchronization is approved.
10. Confirm that the working tree is clean.

Do not treat implementation as complete while local changes remain uncommitted,
local and remote branches are out of sync, or the main CI status is unknown or
failing.

## E. Next Proposal

After the implementation range is complete and Git/GitHub operations are
finished:

1. Present a pre-implementation proposal for what should be done next.
2. Keep the proposal grounded in the product goal, current repository state,
   completed work, remaining risks, and user-facing value.
3. Wait for developer approval before moving from the proposal to the next
   roadmap.

## F. Roadmap

After the next proposal is approved:

1. Slice the next implementation roadmap into numbered integer steps starting
   at `1` unless the developer requests a different range.
2. Make every slice independently understandable, verifiable, and aligned with
   the implementation goal.
3. Include code, contract, document, test, verification, and release/sync work
   as separate slices when that makes progress easier to audit.
4. Wait for developer approval before starting the next implementation range.

## End And Loop

After F is complete and the developer approves the next implementation range,
return to `Start` and continue autonomous development with the same workflow.

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
- any irregular condition encountered and how it was resolved
