import { SCHEMA_VERSION } from './constants.js';

export const VISUAL_REVIEW_DISCLOSURE_MODES = Object.freeze([
  'metadata_only',
  'local_reference',
  'explicit_image_transfer'
]);

const MODE_SET = new Set(VISUAL_REVIEW_DISCLOSURE_MODES);
const RAW_CONTENT_FLAGS = Object.freeze({
  raw_pixels_included: false,
  raw_dom_included: false,
  raw_trace_included: false,
  raw_console_payloads_included: false,
  raw_network_payloads_included: false,
  raw_report_body_included: false,
  credential_values_recorded: false,
  raw_provider_response_stored: false
});

export function buildVisualReviewProviderPolicy(options = {}) {
  const mode = normalizeVisualReviewDisclosureMode(options.disclosureMode);
  const visualEvidence = summarizeVisualDisclosureFromAgentPackage(options.agentPackage);
  const explicitTransferRequested = mode === 'explicit_image_transfer';
  const ownerApprovedExternalTransfer = Boolean(options.ownerApprovedExternalTransfer);

  return {
    schema_version: SCHEMA_VERSION,
    scope: 'agent_execution_plan',
    status: explicitTransferRequested && !ownerApprovedExternalTransfer
      ? 'blocked_external_transfer_requires_owner_review'
      : 'planned',
    disclosure_mode: mode,
    provider: providerSummary(options.provider),
    model: modelSummary(options.model),
    surface: surfaceSummary(options.surface),
    visual_evidence: visualEvidence,
    disclosure: {
      visual_evidence_metadata_included: visualEvidence.visual_evidence_reference_count > 0,
      local_artifact_paths_included: visualEvidence.local_artifact_path_references > 0,
      external_evidence_transfer_requested: explicitTransferRequested,
      external_evidence_transfer_authorized: false,
      provider_execution_authorized: false,
      future_execute_required: true,
      requires_owner_review_before_external_transfer: true,
      ...RAW_CONTENT_FLAGS
    },
    execution: {
      planning_only: true,
      provider_call_planned: false,
      provider_call_performed: false,
      execute_flag_required: true,
      prior_plan_required: true,
      mcp_execution_exposed: false
    },
    boundary: visualReviewProviderBoundary()
  };
}

export function summarizeVisualDisclosureFromAgentPackage(agentPackage) {
  const packet = agentPackage?.packet ?? agentPackage ?? {};
  const artifacts = Array.isArray(packet.evidence_packet?.artifacts)
    ? packet.evidence_packet.artifacts
    : [];
  const visualArtifacts = artifacts.filter(isVisualEvidenceArtifact);
  return {
    artifact_reference_count: artifacts.length,
    visual_evidence_reference_count: visualArtifacts.length,
    screenshot_reference_count: artifacts.filter(isScreenshotArtifact).length,
    local_artifact_path_references: artifacts.filter((artifact) => typeof artifact.path === 'string' && artifact.path.length > 0).length,
    content_included_reference_count: artifacts.filter((artifact) => artifact.content_included === true).length,
    metadata_only: true,
    raw_pixels_included: false,
    external_transfer_authorized: false
  };
}

export function normalizeVisualReviewDisclosureMode(value) {
  const mode = String(value ?? 'metadata_only').trim() || 'metadata_only';
  if (!MODE_SET.has(mode)) {
    const error = new Error(`Unsupported visual review disclosure mode: ${mode}.`);
    error.code = 'VISUAL_REVIEW_DISCLOSURE_MODE_UNSUPPORTED';
    error.details = {
      disclosure_mode: mode,
      supported: VISUAL_REVIEW_DISCLOSURE_MODES
    };
    throw error;
  }
  return mode;
}

export function visualReviewProviderBoundary() {
  return {
    planning_only: true,
    provider_call_performed: false,
    provider_execution_authorized: false,
    external_transfer_performed: false,
    external_evidence_transfer_authorized: false,
    automatic_upload: false,
    raw_pixels_included: false,
    raw_dom_included: false,
    raw_trace_included: false,
    raw_console_payloads_included: false,
    raw_network_payloads_included: false,
    raw_report_body_included: false,
    credential_values_recorded: false,
    raw_provider_response_stored: false,
    mcp_execution_exposed: false,
    existing_review_mutated: false,
    future_execute_required: true
  };
}

function isVisualEvidenceArtifact(artifact) {
  const type = String(artifact?.type ?? '');
  const artifactPath = String(artifact?.path ?? '');
  return type === 'visual_evidence' || artifactPath.includes('/visual-evidence/');
}

function isScreenshotArtifact(artifact) {
  const type = String(artifact?.type ?? '');
  const artifactPath = String(artifact?.path ?? '');
  return type === 'screenshot' || artifactPath.includes('/screenshots/');
}

function providerSummary(provider = {}) {
  return {
    id: provider.id ?? null,
    kind: provider.kind ?? null,
    implemented: provider.implemented === true,
    api_call_performed: false,
    external_evidence_transfer: false,
    credential_values_recorded: false,
    raw_provider_response_stored: false
  };
}

function modelSummary(model = {}) {
  return {
    id: model.id ?? null,
    selected: model.selected === true,
    raw_provider_response_stored: false
  };
}

function surfaceSummary(surface = {}) {
  return {
    id: surface.id ?? null,
    kind: surface.kind ?? null,
    transport: surface.transport ?? null,
    external_evidence_transfer: false,
    credential_mode: surface.credential_mode ?? 'none'
  };
}
