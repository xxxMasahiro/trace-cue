# REQUIREMENTS.md

## Purpose

Browser Debug CLI should make browser debugging reusable across repositories and AI agents. It should provide a local Playwright-based command surface that can observe a page, expose safe action candidates, run selected actions, and produce evidence for UI/UX and functional debugging.

## Users

- Developers who want fast browser-debug feedback during feature work.
- AI coding agents that need browser state without depending on Playwright MCP.
- Reviewers who want reproducible UI/UX findings with screenshots, traces, and notes.
- OSS users who want a repository-agnostic CLI they can add to different projects.

## Required Outcomes

- Provide a standalone CLI that can be used from any repository.
- Use Playwright as the browser automation layer.
- Support fast headless observation for routine debugging.
- Support headed browser and DevTools workflows for visual quality, animations, hover, focus, scroll, and final interaction checks.
- Return structured page observations suitable for AI decision making.
- Provide explicit action candidates instead of requiring raw DOM scraping.
- Record reproducible artifacts such as screenshots, traces, console messages, network summaries, and issue reports.
- Keep secrets, cookies, storage state, and existing browser profiles out of committed artifacts.
- Keep the design agent-independent: Codex, other agents, scripts, or humans should all be able to use the same CLI.
- Prepare for OSS distribution through local Git, GitHub publication with `gh`, CI, and npm packaging in later phases.

## Non-Goals

- Do not clone Playwright MCP or require MCP as the runtime interface.
- Do not replace final visual review; the tool should help operate and capture evidence, while humans approve product-level decisions when needed.
- Do not bypass authentication or collect credentials.
- Do not upload artifacts to external services by default.
- Do not implement runtime browser automation during Phase 0.

## Success Criteria

- The repository has the standard product scaffold expected by the lesson workflow.
- The initial five documents are synchronized and describe the same product direction.
- Product-local checks can validate structure, document sync, security, and design-system placeholders.
- The next phase can safely start local Git setup without changing the runtime scope.

## Open Decisions

- CLI package name and npm scope.
- Exact command names and JSON schema details.
- Whether the long-running browser supervisor is always enabled or opt-in.
- Default artifact retention policy.
- Release license and contribution policy.
