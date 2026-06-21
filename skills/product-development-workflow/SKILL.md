---
name: product-development-workflow
description: Product-local workflow for TraceCue development.
---

# Product Development Workflow

Use this skill inside the TraceCue repository.

## Sequence

1. Read `AGENTS.MD`.
2. Check `docs/workflow/HANDOFF.md` and `docs/workflow/TASK_TRACKER.md`.
3. Confirm the active phase in `docs/product/IMPLEMENTATION_PLAN.md`.
4. Keep product documents synchronized when requirements, specification, plan, tasks, or handoff state change.
5. Run `./tools/product-gate` before reporting the product state as ready.

## Boundaries

- Phase 0 is scaffold and document sync only.
- Ask before runtime implementation, dependency installation, GitHub publication, npm publication, or external service behavior.
- Keep Playwright runtime work local-first and artifact-safe.
