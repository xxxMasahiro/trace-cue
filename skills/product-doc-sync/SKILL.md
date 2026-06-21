---
name: product-doc-sync
description: Synchronize TraceCue product documents and workflow documents.
---

# Product Doc Sync

## Initial Creation Order

1. `docs/product/REQUIREMENTS.md`
2. `docs/product/SPECIFICATION.md`
3. `docs/product/IMPLEMENTATION_PLAN.md`
4. `docs/workflow/TASK_TRACKER.md`
5. `docs/workflow/HANDOFF.md`

## Later Change Order

1. Update `docs/workflow/TASK_TRACKER.md` and `docs/workflow/HANDOFF.md`.
2. Implement the approved change.
3. Update requirements, specification, and implementation plan to match the completed state.

## Check

Run:

```bash
./tools/check_product_docs.sh
```
