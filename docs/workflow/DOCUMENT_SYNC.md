# Document Synchronization

## Purpose

TraceCue keeps implementation, product contracts, workflow state, verification,
and security boundaries synchronized over one pull-request or push range. The
range check is an omission guard. It proves that required authority files
changed in the same integration range; it does not prove that their prose is
semantically correct.

## Policy

`ops/DOCUMENT_SYNC_POLICY.json` is the machine-readable authority. Its structure
is defined by `schemas/document-sync-policy.schema.json`. The policy contains
excluded paths, reusable document groups, and additive classifications. When
multiple classifications match, all required groups are combined. A weaker
classification never removes requirements from a stronger one.

Path patterns support exact paths, `*` within one path segment, and `**` across
segments. Trigger `any_of` requires at least one match, trigger `all_of`
requires every pattern to match at least one changed file, and `none_of`
prevents a rule from matching. Required `all_of` paths must all change;
required `any_of` groups require at least one listed alternative.

## Classifications

- Canonical product changes keep requirements, specification, implementation
  plan, task tracker, and handoff synchronized.
- Task tracker and handoff are one workflow-state pair.
- Document-sync authority and CI-governance changes update their policy,
  manifests, verification, routing, and product authorities.
- Durable development instructions and their machine policy update the
  instruction authority, product workflow skill, routing, product authorities,
  verification, security, policy schema, and manifests together. An
  `INSTRUCTION_MEMORY.md`-only change is rejected.
- Agentic Human Review, provider/external-send boundaries, MCP authority,
  persistent browser sessions, evidence contracts, evaluation, and claims
  require product, verification, and security synchronization. These policy
  rules are not exemptible.
- The provider/external-send classification explicitly includes the Control
  Center AI connection schema, private connection actions and store, audited
  subscription adapters and their version contracts, the fixed process runner,
  and the runtime schema-subset validator. Adding a provider-specific adapter is
  additive implementation work, not an exemption from product, verification,
  and security synchronization.
- Dashboard shared defaults and local persistence implementation require the
  same product, verification, and security synchronization.
- Temporary developer/session memory, ignored local dashboard overrides, ignored browser
  evidence, dependencies, builds, coverage, and test reports neither trigger a
  rule nor satisfy one.
- Design-only implementation repairs continue to follow the design-system
  routing table. A mock changes only when it is an approved visual authority or
  the change defines a new visual specification. Interaction, accessibility,
  navigation, copy meaning, or state meaning is product behavior rather than a
  design-only repair.

The tracked `ops/DASHBOARD_SETTINGS.json` file is a shared default and is not a
local-settings exclusion. Only the ignored `ops/DASHBOARD_SETTINGS.local.json`
user override is excluded.
- Tests-only refactors do not automatically require product documents. Changes
  to verification meaning, evidence acceptance, or CI wiring still require the
  relevant verification or CI authorities under repository routing rules.

The path classifier cannot reliably distinguish every internal refactor from a
semantic behavior change. `AGENTS.MD`, review, focused tests, and product gates
remain authoritative for changes that are not covered by a mechanical path
classification. Adding meaningless prose only to satisfy the range checker is
not valid synchronization.

Development workflow semantics remain a separate responsibility from path
classification. `ops/DEVELOPMENT_WORKFLOW_POLICY.json` maps stable instruction
rule identifiers to registered checks and required review fields. Its checker
does not parse prose or claim that conversational approval, design quality, or
unattested model and effort settings were mechanically proven.

## CI

The `repository-contracts` job checks out full history, runs lightweight
structure, document, security, CI, design-system, product-mode, and
document-sync contract checks, then compares the event base and head commits.
Pull requests use the pull-request base/head SHAs. Main pushes use the push
before/head SHAs. Manual runs accept an optional base SHA and otherwise inspect
the current single-commit range. Missing, zero, or unavailable commits fail
closed. Renames and deletions are included. Product tests, package smoke, and
browser smoke remain in their existing jobs and are not duplicated.

The integration range, not each individual commit, is the synchronization
unit. Implementation and documentation may be separate commits inside one
range. Commit-level enforcement is deferred unless atomic cherry-pickability
becomes an explicit product requirement.

## Git Hook

Run `./tools/install-git-hooks` to opt into the managed repository-local
`pre-push` check. Run `./tools/install-git-hooks --uninstall` to remove only the
managed setting. The installer changes only this repository's local
`core.hooksPath`, does not use npm lifecycle hooks, and refuses to replace or
remove another configured hook path.

The hook does not fetch. Existing branch updates use the remote branch SHA.
New branches use the locally available remote default-branch tracking ref and
fail clearly when it is unavailable. CI remains the final authority because
local hooks can be bypassed.

## Recovery

Fix false positives by changing the JSON policy and its rejection tests in the
same TraceCue change. Do not bypass a security-sensitive rule with a commit
message, temporary memory entry, dashboard setting, generated artifact, or
unreviewed exception file. Recovery is a normal Git revert of the policy,
checker, hook, or CI wiring; no artifact migration, credential cleanup,
provider call, external transfer, browser execution, or parent/FrameCue change
is required.

Verification orchestration authorities are a dedicated non-exemptible class.
Changes to the execution policy or schema, runner, CI composition, package
artifact transport, Playwright cache boundary, product-gate evidence, or their
contract tests require synchronized product requirements, specification,
implementation plan, workflow state, verification, security, CI, test, and
security manifests. Temporary memory and generated evidence cannot satisfy this
class.
