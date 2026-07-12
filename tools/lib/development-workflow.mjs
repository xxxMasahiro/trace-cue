import { normalizeChangedPath } from './document-sync.mjs';

const POLICY_VERSION = '1.0.0';
const ENFORCEMENT_MODES = new Set(['machine', 'hybrid', 'review']);
const FAILURE_MODES = new Set(['block', 'record']);
const APPLICABILITY_VALUES = new Set([
  'non_trivial',
  'browser_surface',
  'verification_or_test',
  'durable_workflow',
  'completion'
]);
const FORBIDDEN_SELECTION_FIELDS = new Set(['model', 'model_id', 'effort', 'reasoning_effort']);
const REQUIRED_SUBAGENT_REPORT_FIELDS = [
  'reviewer_count',
  'review_areas',
  'configuration_visibility',
  'accepted_findings',
  'deferred_findings',
  'rejected_findings'
];

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertSupportedKeys(value, allowed, label) {
  const unsupported = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unsupported.length) {
    throw new Error(`${label} contains unsupported field(s): ${unsupported.join(', ')}.`);
  }
}

function assertStringArray(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
    || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array of non-empty strings.`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${label} must not contain duplicates.`);
  }
}

function normalizePolicyPath(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty repository-relative path.`);
  }
  const normalized = normalizeChangedPath(value);
  if (normalized !== value) {
    throw new Error(`${label} must already be a normalized POSIX repository-relative path.`);
  }
  return normalized;
}

function rejectFixedSelectionFields(value, label = 'policy') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectFixedSelectionFields(item, `${label}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_SELECTION_FIELDS.has(key)) {
      throw new Error(`${label} must not declare fixed model or effort field ${key}.`);
    }
    rejectFixedSelectionFields(nested, `${label}.${key}`);
  }
}

function validateSubagentReview(value) {
  assertObject(value, 'subagent_review');
  assertSupportedKeys(value, [
    'required_for',
    'phases',
    'minimum_distinct_reviewers',
    'configuration_source',
    'model_binding',
    'effort_binding',
    'fixed_override_allowed',
    'configuration_visibility',
    'unavailable_policy',
    'required_report_fields'
  ], 'subagent_review');
  if (JSON.stringify(value.required_for) !== JSON.stringify(['non_trivial'])) {
    throw new Error('subagent_review.required_for must be ["non_trivial"].');
  }
  if (JSON.stringify(value.phases) !== JSON.stringify(['proposal', 'plan'])) {
    throw new Error('subagent_review.phases must preserve proposal then plan ordering.');
  }
  if (!Number.isInteger(value.minimum_distinct_reviewers) || value.minimum_distinct_reviewers < 2) {
    throw new Error('subagent_review.minimum_distinct_reviewers must be at least 2.');
  }
  const expected = {
    configuration_source: 'active_user_session',
    model_binding: 'inherit_current_session',
    effort_binding: 'inherit_current_session',
    fixed_override_allowed: false,
    configuration_visibility: 'runtime_attestation_if_available',
    unavailable_policy: 'use_available_and_disclose_unverified'
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) {
      throw new Error(`subagent_review.${key} must be ${JSON.stringify(expectedValue)}.`);
    }
  }
  assertStringArray(value.required_report_fields, 'subagent_review.required_report_fields', { allowEmpty: false });
  for (const field of REQUIRED_SUBAGENT_REPORT_FIELDS) {
    if (!value.required_report_fields.includes(field)) {
      throw new Error(`subagent_review.required_report_fields must include ${field}.`);
    }
  }
}

export function validateDevelopmentWorkflowPolicy(policy) {
  assertObject(policy, 'Development workflow policy');
  rejectFixedSelectionFields(policy);
  assertSupportedKeys(policy, [
    'schema_version',
    'kind',
    'instruction_authority',
    'subagent_review',
    'rules',
    'required_repository_files',
    'required_package_scripts'
  ], 'policy');
  if (policy.schema_version !== POLICY_VERSION) {
    throw new Error(`Unsupported development workflow policy version: ${policy.schema_version ?? 'missing'}.`);
  }
  if (policy.kind !== 'development-workflow-policy') {
    throw new Error('Development workflow policy kind must be development-workflow-policy.');
  }
  policy.instruction_authority = normalizePolicyPath(policy.instruction_authority, 'instruction_authority');
  validateSubagentReview(policy.subagent_review);
  assertStringArray(policy.required_repository_files, 'required_repository_files', { allowEmpty: false });
  policy.required_repository_files = policy.required_repository_files
    .map((value, index) => normalizePolicyPath(value, `required_repository_files[${index}]`));
  if (new Set(policy.required_repository_files).size !== policy.required_repository_files.length) {
    throw new Error('required_repository_files must not normalize to duplicates.');
  }
  assertStringArray(policy.required_package_scripts, 'required_package_scripts', { allowEmpty: false });
  if (!Array.isArray(policy.rules) || policy.rules.length === 0) {
    throw new Error('rules must be a non-empty array.');
  }
  const ruleIds = new Set();
  const anchors = new Set();
  for (const [index, rule] of policy.rules.entries()) {
    assertObject(rule, `rules[${index}]`);
    assertSupportedKeys(rule, [
      'id',
      'instruction_anchor',
      'applicability',
      'enforcement_mode',
      'required_test_ids',
      'required_review_fields',
      'failure_mode'
    ], `rules[${index}]`);
    if (typeof rule.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(rule.id)) {
      throw new Error(`rules[${index}].id is invalid.`);
    }
    if (ruleIds.has(rule.id)) throw new Error(`Duplicate development workflow rule id: ${rule.id}.`);
    ruleIds.add(rule.id);
    if (rule.instruction_anchor !== `workflow-rule:${rule.id}`) {
      throw new Error(`rules.${rule.id}.instruction_anchor must be workflow-rule:${rule.id}.`);
    }
    if (anchors.has(rule.instruction_anchor)) {
      throw new Error(`Duplicate development workflow instruction anchor: ${rule.instruction_anchor}.`);
    }
    anchors.add(rule.instruction_anchor);
    assertStringArray(rule.applicability, `rules.${rule.id}.applicability`, { allowEmpty: false });
    for (const applicability of rule.applicability) {
      if (!APPLICABILITY_VALUES.has(applicability)) {
        throw new Error(`rules.${rule.id}.applicability contains unsupported value ${applicability}.`);
      }
    }
    if (!ENFORCEMENT_MODES.has(rule.enforcement_mode)) {
      throw new Error(`rules.${rule.id}.enforcement_mode is invalid.`);
    }
    assertStringArray(rule.required_test_ids, `rules.${rule.id}.required_test_ids`);
    assertStringArray(rule.required_review_fields, `rules.${rule.id}.required_review_fields`);
    if (rule.enforcement_mode === 'machine' && rule.required_test_ids.length === 0) {
      throw new Error(`rules.${rule.id} needs a test id for machine enforcement.`);
    }
    if (rule.enforcement_mode === 'review' && rule.required_review_fields.length === 0) {
      throw new Error(`rules.${rule.id} needs a review field for review enforcement.`);
    }
    if (!FAILURE_MODES.has(rule.failure_mode)) {
      throw new Error(`rules.${rule.id}.failure_mode is invalid.`);
    }
  }
  if (!ruleIds.has('session-bound-subagents')) {
    throw new Error('rules must include session-bound-subagents.');
  }
  const sessionRule = policy.rules.find((rule) => rule.id === 'session-bound-subagents');
  for (const field of REQUIRED_SUBAGENT_REPORT_FIELDS) {
    if (!sessionRule.required_review_fields.includes(field)) {
      throw new Error(`rules.session-bound-subagents.required_review_fields must include ${field}.`);
    }
  }
  if (!policy.required_repository_files.includes(policy.instruction_authority)) {
    throw new Error('required_repository_files must include instruction_authority.');
  }
  return policy;
}

export function parseManifestIds(text) {
  return new Set(String(text)
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('\t', 1)[0])
    .filter(Boolean));
}

export function evaluateDevelopmentWorkflowContract(policyInput, inputs) {
  const policy = validateDevelopmentWorkflowPolicy(structuredClone(policyInput));
  const instructionText = String(inputs.instructionText ?? '');
  const registeredTestIds = inputs.registeredTestIds instanceof Set
    ? inputs.registeredTestIds
    : new Set(inputs.registeredTestIds ?? []);
  const packageScripts = inputs.packageScripts ?? {};
  const existingRepositoryFiles = inputs.existingRepositoryFiles instanceof Set
    ? inputs.existingRepositoryFiles
    : new Set(inputs.existingRepositoryFiles ?? []);
  const instructionAnchors = [...instructionText.matchAll(/`(workflow-rule:[a-z0-9-]+)`/g)]
    .map((match) => match[1]);
  const instructionAnchorCounts = new Map();
  for (const anchor of instructionAnchors) {
    instructionAnchorCounts.set(anchor, (instructionAnchorCounts.get(anchor) ?? 0) + 1);
  }
  const policyAnchors = new Set(policy.rules.map((rule) => rule.instruction_anchor));
  const missingAnchors = policy.rules
    .map((rule) => rule.instruction_anchor)
    .filter((anchor) => !instructionText.includes(`\`${anchor}\``));
  const unregisteredAnchors = [...new Set(instructionAnchors)]
    .filter((anchor) => !policyAnchors.has(anchor))
    .sort();
  const duplicateInstructionAnchors = [...instructionAnchorCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([anchor]) => anchor)
    .sort();
  const missingTestIds = [...new Set(policy.rules.flatMap((rule) => rule.required_test_ids))]
    .filter((testId) => !registeredTestIds.has(testId))
    .sort();
  const missingPackageScripts = policy.required_package_scripts
    .filter((scriptId) => typeof packageScripts[scriptId] !== 'string' || packageScripts[scriptId].length === 0)
    .sort();
  const missingRepositoryFiles = policy.required_repository_files
    .filter((file) => !existingRepositoryFiles.has(file))
    .sort();
  const missingPolicyReference = instructionText.includes('ops/DEVELOPMENT_WORKFLOW_POLICY.json') ? [] : [
    'ops/DEVELOPMENT_WORKFLOW_POLICY.json'
  ];
  return {
    status: [
      missingAnchors,
      unregisteredAnchors,
      duplicateInstructionAnchors,
      missingTestIds,
      missingPackageScripts,
      missingRepositoryFiles,
      missingPolicyReference
    ]
      .every((items) => items.length === 0) ? 'pass' : 'fail',
    rule_count: policy.rules.length,
    dynamic_subagent_binding: {
      configuration_source: policy.subagent_review.configuration_source,
      model_binding: policy.subagent_review.model_binding,
      effort_binding: policy.subagent_review.effort_binding,
      fixed_override_allowed: policy.subagent_review.fixed_override_allowed,
      configuration_visibility: policy.subagent_review.configuration_visibility,
      unavailable_policy: policy.subagent_review.unavailable_policy
    },
    missing_instruction_anchors: missingAnchors,
    unregistered_instruction_anchors: unregisteredAnchors,
    duplicate_instruction_anchors: duplicateInstructionAnchors,
    missing_test_ids: missingTestIds,
    missing_package_scripts: missingPackageScripts,
    missing_repository_files: missingRepositoryFiles,
    missing_policy_references: missingPolicyReference
  };
}
