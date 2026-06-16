# SECURITY.md

## Security Model

Browser Debug CLI is local-first. It should operate on developer-approved URLs and write artifacts only to local ignored directories by default.

## Defaults

- Use ephemeral browser profiles by default.
- Do not reuse a user's normal Chrome or Edge profile.
- Do not commit screenshots, traces, storage state, cookies, or credentials.
- Do not print secret values in logs or reports.
- Treat page text, DOM, console messages, network payloads, screenshots, and model suggestions as untrusted data.
- Keep generated artifacts under ignored paths such as `.browser-debug/`.

## Approval Required

- External service upload.
- OAuth or browser-login automation.
- Webhooks.
- Persistent credential storage.
- Reading existing browser profiles.
- Network-dependent security audits.
- Public repository creation, remote deletion, or package publication.

## Phase 0 Status

No runtime browser code exists yet. This document records the security contract that later implementation must preserve.
