# TASK_TRACKER.md

## Current Status

Phase 1 is complete: Phase 0 scaffold and document sync are complete, local Git is initialized, the initial scaffold commit exists, and product-gate evidence has been recorded locally.

This file is paired with `docs/workflow/HANDOFF.md`. Keep the TASK_TRACKER and HANDOFF workflow-state pair synchronized whenever task state changes.

## Completed Work

- [x] Chosen product directory: `/home/masahiro/projects/agent-toolbox/browser-debug-cli`.
- [x] Chosen product direction: OSS browser debugging CLI built on Playwright without MCP runtime dependency.
- [x] Documented headless and headed browser roles.
- [x] Documented future Git, GitHub, CI, npm, MVP, and release phases.
- [x] Created initial requirements, specification, implementation plan, tracker, and handoff drafts.
- [x] Installed product-local skills, tools, ops manifests, evidence-detail manifest, `src/`, and `tests/`.
- [x] Ran product-local gate successfully.
- [x] Ran lesson-side scaffold, authority, and workflow-pair checks successfully.
- [x] Confirmed `AGENTS.MD` is the root agent entry and no legacy `AGENT.md` exists.
- [x] Confirmed `ops/PRODUCT_PROFILE.json` keeps `menu_id=free-development` and display name `Browser Debug CLI`.
- [x] Confirmed `ops/PRODUCT_OPERATION_MODE.tsv` keeps `parent_managed` and `managed_by_parent=true`.
- [x] Initialized local Git and renamed the initial branch to `main`.
- [x] Created the first scaffold commit.
- [x] Recorded product-gate evidence under `.git/product-gate-evidence/`.

## Remaining Work

- [ ] If approved later, create the public GitHub repository with `gh`.
- [ ] If approved later, add CI manifests and GitHub Actions.
- [ ] If approved later, add npm package metadata and runtime CLI implementation.

## Next Step

Stop at the Phase 1 boundary. The next approval-bound step is Phase 2: public GitHub repository creation with `gh`, or a separate approval to begin npm/package/runtime design. Push, remote setup, GitHub repository creation, dependencies, and CI remain out of scope until explicitly approved.

## Stop Conditions

- Runtime Playwright implementation is requested before Phase 0 checks pass.
- GitHub public repository creation is requested without explicit approval.
- npm publish is requested before CI and release planning exist.
- Any secret, cookie, storage state, or credential-like data appears in repository files.
