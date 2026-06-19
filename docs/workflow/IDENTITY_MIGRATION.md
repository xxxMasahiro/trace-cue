# IDENTITY_MIGRATION.md

## Purpose

This runbook defines how to rename Browser Debug CLI identity surfaces after explicit approval. It is documentation only; Phase 34 does not rename the package, repository, CLI command, MCP server, plugin, display name, license, or publication state.

## Identity Surfaces

Rename work must be contract-driven through `src/product-identity.js` and verified across:

- `package.json` package name, version, bin names, exports, and package file set.
- CLI bin names such as `browser-debug`.
- MCP bin and server names such as `browser-debug-mcp`.
- `.mcp.json` server key and args.
- `.codex-plugin/plugin.json` name, repository, display name, and skill path.
- `ops/PRODUCT_PROFILE.json` display identity.
- Package dry-run and packed-install smoke paths.
- README, changelog, release, security, verification, and workflow state documents.
- GitHub repository URL and remote only when remote rename is explicitly approved.

## Migration Order

1. Record the approved target names, owner, package scope, and release intent in the implementation plan.
2. Update `src/product-identity.js` first.
3. Update manifests, package metadata, plugin metadata, MCP config, docs, and tests to derive from the identity contract.
4. Run local verification before any remote action.
5. Commit local changes only after checks pass.
6. Perform remote repository rename, push, PR, merge, main CI, npm publication, or marketplace registration only when each action is separately approved by workflow policy.

## Verification

Required local checks for an approved identity migration:

```bash
npm test
npm run test:pack
npm run test:pack-install
npm run release:check
./tools/product-gate
git diff --check
```

Packed-install smoke must verify CLI entrypoints, MCP entrypoints, package API identity exports, plugin metadata, `.mcp.json`, and package tarball naming from the new identity values.

## Boundaries

- Do not rename identities by scattered literal replacement without updating `src/product-identity.js`.
- Do not change public package name, license, npm publication, plugin marketplace state, GitHub repository name, or remote URL without explicit approval.
- Do not use an identity migration to change security boundaries, MCP profile behavior, artifact disclosure policy, credential handling, or external upload policy.
- Keep old command compatibility only if a separate compatibility policy is approved and tested.
