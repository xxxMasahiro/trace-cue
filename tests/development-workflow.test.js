import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateDevelopmentWorkflowContract,
  parseManifestIds,
  validateDevelopmentWorkflowPolicy
} from '../tools/lib/development-workflow.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const policy = validateDevelopmentWorkflowPolicy(JSON.parse(
  await readFile(path.join(repoRoot, 'ops/DEVELOPMENT_WORKFLOW_POLICY.json'), 'utf8')
));
const policySchema = JSON.parse(await readFile(
  path.join(repoRoot, 'schemas/development-workflow-policy.schema.json'),
  'utf8'
));
const instructionText = await readFile(path.join(repoRoot, policy.instruction_authority), 'utf8');
const testPlanText = await readFile(path.join(repoRoot, 'ops/TEST_PLAN_MANIFEST.tsv'), 'utf8');
const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));

test('development workflow policy is strict and session-bound without fixed selection values', () => {
  assert.equal(policy.subagent_review.configuration_source, 'active_user_session');
  assert.equal(policy.subagent_review.model_binding, 'inherit_current_session');
  assert.equal(policy.subagent_review.effort_binding, 'inherit_current_session');
  assert.equal(policy.subagent_review.fixed_override_allowed, false);
  assert.equal(policy.subagent_review.minimum_distinct_reviewers >= 2, true);
  assert.equal(policySchema.properties.schema_version.const, policy.schema_version);
  assert.equal(policySchema.additionalProperties, false);
  assert.equal(policySchema.$defs.subagentReview.additionalProperties, false);
  assert.equal(JSON.stringify(policy).includes('gpt-'), false);
  assert.equal(JSON.stringify(policy).includes('xhigh'), false);
  assert.throws(() => validateDevelopmentWorkflowPolicy({ ...policy, unsupported: true }), /unsupported field/);
  assert.throws(() => validateDevelopmentWorkflowPolicy({ ...policy, model: 'fixed-model' }), /fixed model or effort field model/);
  assert.throws(() => validateDevelopmentWorkflowPolicy({
    ...policy,
    subagent_review: { ...policy.subagent_review, effort: 'fixed-effort' }
  }), /fixed model or effort field effort/);
  assert.throws(() => validateDevelopmentWorkflowPolicy({
    ...policy,
    subagent_review: { ...policy.subagent_review, fixed_override_allowed: true }
  }), /fixed_override_allowed must be false/);
  assert.throws(() => validateDevelopmentWorkflowPolicy({
    ...policy,
    subagent_review: { ...policy.subagent_review, minimum_distinct_reviewers: 1 }
  }), /at least 2/);
  assert.throws(() => validateDevelopmentWorkflowPolicy({
    ...policy,
    subagent_review: {
      ...policy.subagent_review,
      required_report_fields: policy.subagent_review.required_report_fields.filter((field) => field !== 'reviewer_count')
    }
  }), /must include reviewer_count/);
  assert.throws(() => validateDevelopmentWorkflowPolicy({
    ...policy,
    instruction_authority: './docs/workflow/INSTRUCTION_MEMORY.md'
  }), /normalized POSIX repository-relative path/);
  assert.throws(() => validateDevelopmentWorkflowPolicy({
    ...policy,
    rules: [...policy.rules, structuredClone(policy.rules[0])]
  }), /Duplicate development workflow rule id/);
  assert.throws(() => validateDevelopmentWorkflowPolicy({
    ...policy,
    rules: [{ ...policy.rules[0], instruction_anchor: 'workflow-rule:wrong' }, ...policy.rules.slice(1)]
  }), /instruction_anchor must be workflow-rule:changeability/);
  assert.throws(() => validateDevelopmentWorkflowPolicy({
    ...policy,
    rules: [{ ...policy.rules[0], applicability: ['unknown'] }, ...policy.rules.slice(1)]
  }), /unsupported value unknown/);
});

test('rule ids, instruction anchors, test ids, scripts, and required files stay synchronized', () => {
  const existingRepositoryFiles = new Set(policy.required_repository_files);
  const result = evaluateDevelopmentWorkflowContract(policy, {
    instructionText,
    registeredTestIds: parseManifestIds(testPlanText),
    packageScripts: packageJson.scripts,
    existingRepositoryFiles
  });
  assert.equal(result.status, 'pass');
  assert.equal(result.missing_instruction_anchors.length, 0);
  assert.equal(result.unregistered_instruction_anchors.length, 0);
  assert.equal(result.duplicate_instruction_anchors.length, 0);
  assert.equal(result.missing_test_ids.length, 0);
  assert.equal(result.missing_package_scripts.length, 0);
  assert.equal(result.missing_repository_files.length, 0);
});

test('contract evaluation rejects missing anchors, checks, scripts, files, and policy references', () => {
  const existingRepositoryFiles = new Set(policy.required_repository_files);
  existingRepositoryFiles.delete('tests/development-workflow.test.js');
  const result = evaluateDevelopmentWorkflowContract(policy, {
    instructionText: instructionText
      .replace('`workflow-rule:changeability`', 'changeability')
      .concat('\n`workflow-rule:unregistered`\n`workflow-rule:workflow-evidence`\n')
      .replace('ops/DEVELOPMENT_WORKFLOW_POLICY.json', 'policy-not-linked.json'),
    registeredTestIds: new Set(),
    packageScripts: {},
    existingRepositoryFiles
  });
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.missing_instruction_anchors, ['workflow-rule:changeability']);
  assert.deepEqual(result.unregistered_instruction_anchors, ['workflow-rule:unregistered']);
  assert.deepEqual(result.duplicate_instruction_anchors, ['workflow-rule:workflow-evidence']);
  assert.equal(result.missing_test_ids.includes('architecture'), true);
  assert.equal(result.missing_package_scripts.includes('test'), true);
  assert.deepEqual(result.missing_repository_files, ['tests/development-workflow.test.js']);
  assert.deepEqual(result.missing_policy_references, ['ops/DEVELOPMENT_WORKFLOW_POLICY.json']);
});

test('development-process instructions do not pin xhigh while product effort contracts remain separate', async () => {
  assert.doesNotMatch(instructionText, /xhigh[^\n]{0,80}subagent|subagent[^\n]{0,80}xhigh/i);
  assert.match(instructionText, /active\s+user session's selected model\s+and reasoning effort/i);
  const requirements = await readFile(path.join(repoRoot, 'docs/product/REQUIREMENTS.md'), 'utf8');
  assert.match(requirements, /standard/);
  assert.match(requirements, /deep/);
  assert.match(requirements, /xhigh/);
});
