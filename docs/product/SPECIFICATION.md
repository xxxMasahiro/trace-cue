# SPECIFICATION.md

## Product Shape

Browser Debug CLI is planned as a Node.js CLI package backed by Playwright. It should be usable from any product repository and should not require the caller to run an MCP server.

## Planned Architecture

- CLI entrypoint: accepts commands, options, and JSON input/output flags.
- Core library: owns Playwright session management, observation, actions, and artifact creation.
- Browser supervisor: keeps a reusable browser context alive when fast iterative debugging is needed.
- Observation layer: summarizes URL, title, accessibility tree, visible text, form controls, action candidates, console errors, failed requests, screenshots, and selected metadata.
- Action layer: performs explicit actions such as click, fill, select, press, scroll, wait, navigate, screenshot, and trace capture.
- Report layer: converts session evidence into issue reports and handoff notes.

## Planned CLI Surface

The exact names are not frozen, but the intended surface is:

```text
browser-debug doctor
browser-debug session start
browser-debug observe --url <url> --json
browser-debug act --session <id> --action <json>
browser-debug report --session <id>
browser-debug spec export --session <id>
```

## Browser Modes

- `headless`: default fast mode for structured observation and regression debugging.
- `headed`: visible browser mode for final UI/UX quality, animation, hover, focus, and operation feel.
- `devtools`: headed mode with DevTools for targeted inspection.

## AI Interaction Contract

The CLI should expose structured observations and action candidates. The AI decides the next action outside the CLI, then sends that action back to the CLI. This keeps the tool agent-independent and avoids binding the product to one model, one chat UI, or one MCP runtime.

## Artifact Contract

Artifacts should be local by default and written under an ignored product workspace directory such as `.browser-debug/`. Planned artifact types include:

- screenshots
- traces
- console summaries
- network failure summaries
- accessibility summaries
- action history
- issue reports

Sensitive browser data must not be emitted unless a later approved feature defines safe redaction and explicit consent.

## OSS Workflow Contract

The repository should move through these phases:

- Phase 0: scaffold and synchronized planning documents.
- Phase 1: local Git initialization and first commit.
- Phase 2: public GitHub repository creation through `gh`.
- Phase 3: GitHub Actions CI.
- Phase 4: npm package metadata and CLI packaging.
- Phase 5: MVP Playwright implementation.
- Phase 6: release and npm publish flow.

## Out of Scope for Phase 0

- Runtime CLI implementation.
- Dependency installation.
- Browser launch.
- GitHub remote creation.
- npm package publication.
- CI workflow execution.
