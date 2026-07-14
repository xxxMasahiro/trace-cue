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
10. Active TraceCue-only work is Phase 177-181 Control Center AI connection parity. Subscription CLI and API connections now share one opaque non-engineer workflow, while TraceCue `standard`, `deep`, and `xhigh` remain independent from provider-native effort.
11. New private connection contracts live in `src/control-center-ai-connections.js`, `src/control-center-ai-connection-store.js`, and `src/control-center-ai-connection-actions.js`. Dashboard reads are passive; only the protected refresh action may probe capabilities, and dispatch revalidates the exact tuple without fallback.
12. The first fixed subscription adapter is `src/codex-subscription-adapter.js` over `src/fixed-process-runner.js`. It uses a verified native Codex executable, fixed shell-disabled arguments, a safe environment, private staging, bounded I/O/time, disabled web/MCP/shell authority, and stores neither credentials nor raw output.
13. The React/Vite UI and active production mock expose only user-facing service/model/native-effort choices. The prior mock is preserved under `docs/design-system/mockups/control-center/archive/phase-176/`.
14. Phase 177-181 implementation and tracked authorities are complete. Local evidence is 379/379 no-browser tests, 20/20 browser tests, 317 packaged files, passing packed-install/repository/product gates, three passing independent reviews, and zero final TraceCue self-review findings on New Review desktop plus Settings desktop/mobile. The completion commit still requires push, exact CI, clean local/remote synchronization, and exact-HEAD authority refresh.
