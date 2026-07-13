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
npm run document-sync:contract-check
npm run document-sync:check
npm run development-workflow:contract-check
npm run development-workflow:check
```

## Range Enforcement

- `docs/workflow/DOCUMENT_SYNC.md` is the human operating contract.
- `ops/DOCUMENT_SYNC_POLICY.json` is the machine-readable classification and
  required-document authority.
- Synchronization is evaluated over the complete pull-request or push range,
  not each individual commit.
- Temporary memory, ignored local dashboard overrides, and ignored/generated artifacts
  cannot satisfy a required document group.
- The tracked dashboard defaults remain reviewable repository content; only
  `ops/DASHBOARD_SETTINGS.local.json` is a local exclusion.
- AHR, external-send/provider, MCP, persistent-session, evidence, evaluation,
  and claim changes require security and verification synchronization.
- Dashboard shared defaults and local-settings persistence changes also require
  product, verification, and security synchronization.
- Durable instruction and development workflow policy changes require the
  instruction authority, dynamic session-bound subagent policy, routing,
  product, verification, security, schema, and manifest authorities to move
  together. An instruction-only change must fail the range check.
- The mechanical checker detects omissions; semantic correctness still
  requires role-specific document review and focused product tests.
- Verification policy, runner, CI owner graph, package artifact, Playwright
  cache, or product-gate evidence changes must synchronize the five canonical
  product/workflow authorities plus verification, security, CI, test, security,
  policy, and schema authorities. Generated receipts and cached artifacts never
  satisfy that synchronization requirement.
