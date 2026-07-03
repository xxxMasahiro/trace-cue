# Product Memory

Use this directory for product-local memory notes when needed.

Optional files:

- `DEVELOPER_MEMORY.md`: temporary developer carryover notes.
- `SESSION_MEMORY.md`: temporary session carryover notes.
- `FAILURE_MEMORY.md`: durable failure memory when explicitly needed.

`SESSION_MEMORY.md` and `DEVELOPER_MEMORY.md` are temporary carryover notes, not protocol authorities. Updating only those two files does not require CI, product verification gates, or product/workflow document synchronization.

Durable protocol and implementation-synchronized requirements, specifications, implementation plans, task tracking, handoff, verification, security, routing, schemas, manifests, and tests must live outside the temporary memory files.

Do not store secrets, credentials, cookies, browser storage, or private page content here.
