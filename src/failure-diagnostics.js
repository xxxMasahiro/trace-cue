import { redactString, truncateText } from './redaction.js';

const PERSISTABLE_FAILURE_DIAGNOSTIC_KEYS = new Set([
  'advisory_only',
  'api_call_performed',
  'boundary',
  'claim',
  'claim_id',
  'code',
  'contract_failures',
  'contract_repair_attempts_performed',
  'credential_values_recorded',
  'details',
  'duration_ms',
  'evidence_ref_count',
  'evidence_reference_ids',
  'expected',
  'failure_cause_code',
  'failure_cause_name',
  'failure_class',
  'failure_diagnostics',
  'forbidden_claims',
  'gate_effect',
  'index',
  'invalid_review_claim_count',
  'invalid_review_claims',
  'loopback_adapter_error_code',
  'loopback_adapter_error_details',
  'loopback_adapter_error_message',
  'loopback_adapter_error_observed',
  'loopback_adapter_response_bytes',
  'loopback_adapter_response_code',
  'max_provider_response_bytes',
  'max_request_bytes',
  'max_response_bytes',
  'message',
  'missing_benchmark_record_count',
  'missing_benchmark_records',
  'missing_condition_count',
  'missing_conditions',
  'missing_critique_roles',
  'missing_fields',
  'missing_owner_baseline_record_count',
  'missing_owner_baseline_records',
  'missing_required_mentions',
  'missing_roles',
  'missing_rounds',
  'model_resolution_source',
  'provider_call_performed',
  'provider_status_code',
  'raw_provider_response_stored',
  'reason',
  'recommended_evidence_ref_ids',
  'request_bytes',
  'request_model_abstract',
  'request_section_bytes',
  'response_bytes',
  'runtime_model_env',
  'section',
  'stage',
  'stage_error',
  'stage_id',
  'stage_roles',
  'stage_round',
  'status_code',
  'status',
  'supported_role_count',
  'synthesis_integrated',
  'timeout_ms'
]);

const PERSISTABLE_FAILURE_CONTAINER_KEYS = new Set([
  'contract_failures',
  'details',
  'failure_diagnostics',
  'forbidden_claims',
  'invalid_review_claims',
  'loopback_adapter_error_details',
  'missing_benchmark_records',
  'missing_owner_baseline_records',
  'missing_required_mentions',
  'request_section_bytes',
  'stage_error',
  'stage_roles'
]);

const BLOCKED_FAILURE_DIAGNOSTIC_KEY_PATTERN = /(?:authorization|body|cookie|endpoint|headers|password|payload|provider_request|provider_response|raw_response|raw_provider_response|request_payload|secret|session|token|url)/i;

export function filterPersistableFailureDiagnosticDetails(value, { depth = 0, parentKey = null } = {}) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return truncateText(redactString(value), 700);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((item) => filterPersistableFailureDiagnosticDetails(item, { depth: depth + 1, parentKey }))
      .filter((item) => item !== undefined && item !== null);
  }
  if (typeof value !== 'object' || depth > 6) {
    return null;
  }
  const parentAllowsRecordKeys = PERSISTABLE_FAILURE_CONTAINER_KEYS.has(parentKey);
  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    if (BLOCKED_FAILURE_DIAGNOSTIC_KEY_PATTERN.test(key) && key !== 'raw_provider_response_stored') {
      continue;
    }
    if (!PERSISTABLE_FAILURE_DIAGNOSTIC_KEYS.has(key) && !parentAllowsRecordKeys) {
      continue;
    }
    const nextValue = filterPersistableFailureDiagnosticDetails(nested, { depth: depth + 1, parentKey: key });
    if (nextValue === undefined || nextValue === null) {
      continue;
    }
    output[key] = nextValue;
  }
  return output;
}
