# SESSION_MEMORY.md

Session memory reset: 2026-07-12.

Next-session handoff:

1. Work in `/home/masahiro/projects/agent-toolbox/trace-cue`.
2. Treat this file as temporary carryover only. Read `AGENTS.MD`, the parent repository `AGENTS.MD`, `docs/workflow/INSTRUCTION_MEMORY.md`, `docs/workflow/HANDOFF.md`, `docs/workflow/TASK_TRACKER.md`, `docs/product/REQUIREMENTS.md`, `docs/product/SPECIFICATION.md`, and `docs/product/IMPLEMENTATION_PLAN.md` before continuing.
3. The document-sync range enforcement slice is complete and recorded in `docs/workflow/HANDOFF.md` and `docs/workflow/TASK_TRACKER.md`.
4. The Control Center settings persistence slice separates tracked shared defaults at `ops/DASHBOARD_SETTINGS.json` from ignored user choices at `ops/DASHBOARD_SETTINGS.local.json`. Ordinary settings save is one validated atomic local write.
5. The existing Japanese display, both-viewport default, AI suggestions, and mandatory external-send confirmation were migrated to the ignored local file before the tracked defaults were normalized.
6. Language, Control Center, Playwright Test mode, and approved external-CI setting writers use the shared local store. Local settings cannot enable credentials, providers, external sending, browsers, shell, MCP, destructive behavior, translation execution, or release gates.
7. The parent lesson repository and FrameCue were read only and were not modified by this work.
8. The next practical product work after settings authority is ready remains the approved Agentic Human Review real-page standard/deep/xhigh dogfood regeneration documented in `docs/workflow/HANDOFF.md`.
9. Keep stop conditions active: no npm publication, package/license changes, marketplace registration, provider/API expansion, MCP permission expansion, external upload, cleanup outside the artifact root, shell execution, browser profile reuse, credential storage, or parent/consumer repository mutation without explicit approval.
