import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateJsonSchemaSubset } from './json-schema-subset.js';
import { getSchema } from './schema-registry.js';

export const MEDIA_REVIEW_COMPARISON_SCHEMA_VERSION = '1.0.0';
export const MEDIA_REVIEW_COMPARISON_POLICY_RELATIVE = 'ops/MEDIA_REVIEW_COMPARISON_POLICY.json';

const moduleRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
let cachedPolicy;

export async function loadMediaReviewComparisonPolicy(context = {}) {
  if (context.mediaReviewComparisonPolicy) {
    return validatePolicy(structuredClone(context.mediaReviewComparisonPolicy));
  }
  if (!cachedPolicy || context.disableMediaReviewComparisonPolicyCache) {
    const root = path.resolve(context.packageRoot ?? moduleRoot);
    let value;
    try {
      value = JSON.parse(await readFile(path.join(root, MEDIA_REVIEW_COMPARISON_POLICY_RELATIVE), 'utf8'));
    } catch (error) {
      throw comparisonPolicyError('MEDIA_REVIEW_COMPARISON_POLICY_UNAVAILABLE', 'The media comparison policy is unavailable.', error?.code);
    }
    cachedPolicy = validatePolicy(value);
  }
  return structuredClone(cachedPolicy);
}

export function mediaReviewComparisonPolicyIdentity(policy) {
  return createHash('sha256').update(stableJson(policy)).digest('hex');
}

function validatePolicy(policy) {
  const validation = validateJsonSchemaSubset(policy, getSchema('media_review_comparison_policy'));
  if (!validation.ok) {
    throw comparisonPolicyError('MEDIA_REVIEW_COMPARISON_POLICY_INVALID', 'The media comparison policy is invalid.');
  }
  if (policy.input.maximum_total_input_bytes < policy.input.maximum_result_bytes * 2
    || policy.output.maximum_metric_diffs < policy.metrics.length
    || policy.matching.maximum_moved_timing_distance_us < policy.matching.stable_timing_tolerance_us
    || new Set(policy.metrics.map((metric) => metric.id)).size !== policy.metrics.length
    || policy.metrics.some((metric) => metric.classification !== ({
      technical: 'deterministic_measurement',
      transcript: 'provider_measurement',
      advisory: 'advisory_evaluation'
    })[metric.domain])
    || new Set(policy.input.producer_finding_limits.map((entry) => entry.policy_identity)).size !== policy.input.producer_finding_limits.length
    || policy.boundary.public_results_only !== true
    || Object.entries(policy.boundary).some(([key, value]) => key !== 'public_results_only' && value !== false)) {
    throw comparisonPolicyError('MEDIA_REVIEW_COMPARISON_POLICY_INVALID', 'The media comparison policy weakens a required comparison boundary.');
  }
  return Object.freeze(structuredClone(policy));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function comparisonPolicyError(code, message, reason = null) {
  const error = new Error(message);
  error.code = code;
  error.details = reason ? { reason } : {};
  return error;
}
