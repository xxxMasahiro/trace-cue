---
name: product-development-workflow
description: Product-local workflow for TraceCue development.
---

# Product Development Workflow

Use this skill inside the TraceCue repository.

## Sequence

1. Read `AGENTS.MD`.
2. Read `docs/workflow/INSTRUCTION_MEMORY.md` and validate its machine mapping in `ops/DEVELOPMENT_WORKFLOW_POLICY.json`.
3. Check `docs/workflow/HANDOFF.md` and `docs/workflow/TASK_TRACKER.md`.
4. Confirm the active phase in `docs/product/IMPLEMENTATION_PLAN.md`.
5. Use multiple independent subagents for non-trivial proposal and plan review. Inherit the active user session's model and reasoning effort when the runtime exposes or verifiably inherits them; otherwise disclose that selection was not exposed and do not claim a specific setting.
6. Keep product documents synchronized when requirements, specification, plan, tasks, or handoff state change.
7. Run `npm run development-workflow:check` and `./tools/product-gate` before reporting the product state as ready.

## Boundaries

- Phase 0 is scaffold and document sync only.
- Ask before runtime implementation, dependency installation, GitHub publication, npm publication, or external service behavior.
- Keep Playwright runtime work local-first and artifact-safe.
