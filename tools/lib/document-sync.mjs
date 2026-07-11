import path from 'node:path';

const POLICY_VERSION = '1.0.0';

function assertSupportedKeys(value, allowed, label) {
  const unsupported = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unsupported.length) throw new Error(`${label} contains unsupported field(s): ${unsupported.join(', ')}.`);
}

function assertStringArray(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array of non-empty strings.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates.`);
}

function validateRequirements(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  assertSupportedKeys(value, ['all_of', 'any_of'], label);
  if (value.all_of !== undefined) assertStringArray(value.all_of, `${label}.all_of`);
  if (value.any_of !== undefined) {
    if (!Array.isArray(value.any_of) || value.any_of.some((group) => !Array.isArray(group))) {
      throw new Error(`${label}.any_of must be an array of path arrays.`);
    }
    value.any_of.forEach((group, index) => assertStringArray(group, `${label}.any_of[${index}]`, { allowEmpty: false }));
  }
  if ((value.all_of?.length ?? 0) === 0 && (value.any_of?.length ?? 0) === 0) throw new Error(`${label} needs all_of or any_of requirements.`);
}

export function validateDocumentSyncPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Document sync policy must be an object.');
  assertSupportedKeys(policy, ['schema_version', 'kind', 'excluded_paths', 'document_groups', 'rules'], 'policy');
  if (policy.schema_version !== POLICY_VERSION) throw new Error(`Unsupported document sync policy version: ${policy.schema_version ?? 'missing'}.`);
  if (policy.kind !== 'document-sync-policy') throw new Error('Document sync policy kind must be document-sync-policy.');
  assertStringArray(policy.excluded_paths, 'excluded_paths');
  if (!policy.document_groups || typeof policy.document_groups !== 'object' || Array.isArray(policy.document_groups) || Object.keys(policy.document_groups).length === 0) {
    throw new Error('document_groups must be a non-empty object.');
  }
  for (const [groupId, requirements] of Object.entries(policy.document_groups)) validateRequirements(requirements, `document_groups.${groupId}`);
  if (!Array.isArray(policy.rules) || policy.rules.length === 0) throw new Error('rules must be a non-empty array.');
  const ruleIds = new Set();
  for (const [index, rule] of policy.rules.entries()) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`rules[${index}] must be an object.`);
    assertSupportedKeys(rule, ['id', 'description', 'trigger', 'required_groups', 'cannot_be_exempted'], `rules[${index}]`);
    if (typeof rule.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(rule.id)) throw new Error(`rules[${index}].id is invalid.`);
    if (ruleIds.has(rule.id)) throw new Error(`Duplicate document sync rule id: ${rule.id}.`);
    ruleIds.add(rule.id);
    if (typeof rule.description !== 'string' || rule.description.length === 0) throw new Error(`rules.${rule.id}.description is required.`);
    const trigger = rule.trigger;
    if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) throw new Error(`rules.${rule.id}.trigger must be an object.`);
    assertSupportedKeys(trigger, ['any_of', 'all_of', 'none_of'], `rules.${rule.id}.trigger`);
    for (const key of ['any_of', 'all_of', 'none_of']) {
      if (trigger[key] !== undefined) assertStringArray(trigger[key], `rules.${rule.id}.trigger.${key}`);
    }
    if ((trigger.any_of?.length ?? 0) === 0 && (trigger.all_of?.length ?? 0) === 0) throw new Error(`rules.${rule.id}.trigger needs any_of or all_of.`);
    assertStringArray(rule.required_groups, `rules.${rule.id}.required_groups`, { allowEmpty: false });
    for (const groupId of rule.required_groups) {
      if (!Object.hasOwn(policy.document_groups, groupId)) throw new Error(`rules.${rule.id} references unknown document group ${groupId}.`);
    }
    if (rule.cannot_be_exempted !== undefined && typeof rule.cannot_be_exempted !== 'boolean') throw new Error(`rules.${rule.id}.cannot_be_exempted must be boolean.`);
  }
  return policy;
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

export function globToRegExp(pattern) {
  const normalized = String(pattern).replaceAll('\\', '/').replace(/^\.\//, '');
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*' && normalized[index + 1] === '*') {
      const followedBySlash = normalized[index + 2] === '/';
      source += followedBySlash ? '(?:.*/)?' : '.*';
      index += followedBySlash ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`);
}

export function normalizeChangedPath(value) {
  const normalized = path.posix.normalize(String(value).replaceAll('\\', '/').replace(/^\.\//, ''));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error(`Changed path must stay repository-relative: ${value}`);
  }
  return normalized;
}

function matchesAny(file, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(file));
}

function ruleMatches(rule, changedFiles) {
  const trigger = rule.trigger;
  if (trigger.none_of?.some((pattern) => changedFiles.some((file) => globToRegExp(pattern).test(file)))) return false;
  if (trigger.all_of?.some((pattern) => !changedFiles.some((file) => globToRegExp(pattern).test(file)))) return false;
  if (trigger.any_of?.length && !changedFiles.some((file) => matchesAny(file, trigger.any_of))) return false;
  return true;
}

export function evaluateDocumentSync(policyInput, changedPaths) {
  const policy = validateDocumentSyncPolicy(policyInput);
  const allChangedFiles = [...new Set(changedPaths.map(normalizeChangedPath))].sort();
  const changedFiles = allChangedFiles.filter((file) => !matchesAny(file, policy.excluded_paths));
  const matchedRules = policy.rules.filter((rule) => ruleMatches(rule, changedFiles));
  const requiredGroupIds = [...new Set(matchedRules.flatMap((rule) => rule.required_groups))].sort();
  const missingAllOf = new Set();
  const missingAnyOf = [];
  for (const groupId of requiredGroupIds) {
    const requirements = policy.document_groups[groupId];
    for (const requiredPath of requirements.all_of ?? []) {
      if (!changedFiles.includes(requiredPath)) missingAllOf.add(requiredPath);
    }
    for (const alternatives of requirements.any_of ?? []) {
      if (!alternatives.some((requiredPath) => changedFiles.includes(requiredPath))) {
        missingAnyOf.push({ group_id: groupId, alternatives });
      }
    }
  }
  return {
    status: missingAllOf.size === 0 && missingAnyOf.length === 0 ? 'pass' : 'fail',
    changed_files: changedFiles,
    excluded_files: allChangedFiles.filter((file) => !changedFiles.includes(file)),
    matched_rules: matchedRules.map((rule) => ({
      id: rule.id,
      description: rule.description,
      cannot_be_exempted: rule.cannot_be_exempted === true
    })),
    required_groups: requiredGroupIds,
    missing_all_of: [...missingAllOf].sort(),
    missing_any_of: missingAnyOf
  };
}

export function parseNameStatusZ(buffer) {
  const fields = buffer.toString('utf8').split('\0');
  if (fields.at(-1) === '') fields.pop();
  const paths = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      if (index + 1 >= fields.length) throw new Error(`Incomplete git name-status record for ${status}.`);
      paths.push(fields[index++], fields[index++]);
    } else {
      if (index >= fields.length) throw new Error(`Incomplete git name-status record for ${status}.`);
      paths.push(fields[index++]);
    }
  }
  return [...new Set(paths.map(normalizeChangedPath))].sort();
}
