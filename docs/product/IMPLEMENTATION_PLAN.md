# IMPLEMENTATION_PLAN.md

## Preconditions

- Work stays in `/home/masahiro/projects/agent-toolbox/browser-debug-cli`.
- The lesson repository remains the parent workflow source.
- Phase 0 is documentation and scaffold only.
- Runtime browser automation starts only after the scaffold and initial documents are verified.

## Phase Plan

### Phase 0: Scaffold and Document Sync

- Create the standard product repository structure.
- Add product-local `AGENTS.MD`, docs, ops manifests, skills, tools, `src/`, and `tests/`.
- Synchronize the initial five documents:
  - `docs/product/REQUIREMENTS.md`
  - `docs/product/SPECIFICATION.md`
  - `docs/product/IMPLEMENTATION_PLAN.md`
  - `docs/workflow/TASK_TRACKER.md`
  - `docs/workflow/HANDOFF.md`
- Run structure, document, security, design-system, and workflow-pair checks.

### Phase 1: Local Git

- Confirm the user wants to enter local Git mode.
- Run `git init`.
- Review `git status`.
- Create an initial commit once scaffold checks pass.
- Decide whether `.githooks/` should be added for product-local hooks.

### Phase 2: GitHub Public Repository

- Confirm public OSS repository name and owner.
- Use `gh auth status` and `gh repo create` only after approval.
- Push the initial branch.
- Add remote-sync notes to the handoff.

### Phase 3: CI

- Add `.github/workflows/` and `ops/CI_MANIFEST.tsv`.
- Run local checks before push.
- Confirm GitHub Actions status.

### Phase 4: npm Package Design

- Add `package.json`.
- Decide CLI binary name, module format, Node version, license, and release scripts.
- Add package metadata, lint/test commands, and distribution files.

### Phase 5: MVP Runtime

- Implement `doctor`.
- Implement one-shot `observe`.
- Implement session start and simple actions.
- Implement artifact directory handling.
- Add focused tests for command parsing, observation output, and safety boundaries.

### Phase 6: Release

- Add release notes and changelog.
- Confirm npm account and publishing method.
- Publish only after CI and release checklist pass.

## Verification Method

- `./tools/product-gate`
- lesson-side `product-scaffold-check` with this repository path.
- lesson-side `product-repository-authority status` with this repository path.
- `check_workflow_pair_sync.sh --repo <this-repo>`.

## Recovery Path

- If scaffold checks fail, fix missing canonical files or manifest format first.
- If document sync fails, update `TASK_TRACKER.md` and `HANDOFF.md` together.
- If security checks fail, remove committed secret-like data and update `SECURITY.md`.
- If Git/GitHub/npm steps are requested too early, stop and return to the phase plan.

## Approval Boundaries

- Ask before runtime implementation.
- Ask before dependency installation or network use.
- Ask before `git init`, commit, push, branch deletion, or remote changes.
- Ask before `gh repo create` or any public GitHub action.
- Ask before npm publish.
- Ask before external uploads, OAuth, webhooks, credential storage, or destructive cleanup.
