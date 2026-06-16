# HANDOFF.md

## Current State

Browser Debug CLI has completed Phase 1. Phase 0 scaffold and document sync are complete, local Git is initialized, the initial scaffold commit exists, and product-gate evidence has been recorded locally.

This file is paired with `docs/workflow/TASK_TRACKER.md`. Keep the HANDOFF and TASK_TRACKER workflow-state pair synchronized whenever task state changes.

## What Has Been Decided

- Product name: Browser Debug CLI.
- Repository path: `/home/masahiro/projects/agent-toolbox/browser-debug-cli`.
- Main purpose: local Playwright-based browser debugging and UI/UX inspection for humans and AI agents.
- Main design choice: agent-independent CLI, not Playwright MCP.
- Debug strategy: fast headless observation by default, headed browser or DevTools for important visual and interaction checks.
- OSS path: local Git, GitHub through `gh`, CI, npm packaging, MVP implementation, release.
- Product-local gate passed.
- Lesson-side scaffold, authority, and workflow-pair checks passed.
- Root agent entry is `AGENTS.MD`; legacy `AGENT.md` is absent.
- `ops/PRODUCT_PROFILE.json` remains `menu_id=free-development` with display name `Browser Debug CLI`.
- `ops/PRODUCT_OPERATION_MODE.tsv` remains `parent_managed` with `managed_by_parent=true`.
- Local Git has been initialized and the initial branch is `main`.
- The first scaffold commit exists.
- Product-gate evidence is recorded under `.git/product-gate-evidence/`.

## Next Step

Stop at the Phase 1 boundary. The next approval-bound step is Phase 2 public GitHub repository creation with `gh`, or a separate approval to begin package/runtime design. Push, remote setup, GitHub repository creation, dependencies, and CI remain out of scope until explicitly approved.

## Restart Notes

- Do not add runtime code before a separate implementation approval.
- Do not create a GitHub repository yet.
- Do not install dependencies yet.
- Do not publish to npm yet.
- If product workflow commands need lesson context, use the product path explicitly to avoid mixing this repository with `task-tracker-repository`.

## Stop Conditions

- Missing canonical docs under `docs/product/` or `docs/workflow/`.
- Root-level duplicate product documents.
- Any committed secret-like data.
- External service, OAuth, webhook, browser profile reuse, or artifact upload requested without a security plan and approval.
