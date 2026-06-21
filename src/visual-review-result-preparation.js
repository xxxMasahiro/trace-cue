import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  artifactObject,
  artifactRelPath,
  createArtifactId,
  ensureArtifactRoot,
  writeJsonArtifact
} from './artifacts.js';
import { CLI_NAME, DEFAULT_ARTIFACT_ROOT, SCHEMA_VERSION } from './constants.js';
import { redact } from './redaction.js';
import { buildVisualReviewProviderPolicy } from './visual-review-provider-policy.js';

const DEFAULT_PREPARATION_MAX_BYTES = 2 * 1024 * 1024;
const MAX_VISUAL_EVIDENCE_REFS = 25;

export async function runVisualReviewResultPreparation(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const now = materializeNow(context.now);
  const artifactRootInput = options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT;
  const id = context.createId?.('visual-review-preparation', now) ?? createArtifactId(now, 'visual-review-preparation');

  if (options.execute) {
    return failure('VISUAL_REVIEW_PREPARATION_EXECUTE_NOT_SUPPORTED', 'visual review prepare does not execute providers. Omit --execute and use the preparation artifact for a later approved execution phase.');
  }

  const maxBytes = parseMaxBytes(options['max-bytes']);
  if (!maxBytes.ok) {
    return failure('VISUAL_REVIEW_PREPARATION_INVALID_MAX_BYTES', maxBytes.message, { max_bytes: options['max-bytes'] });
  }

  let root;
  try {
    root = await ensureArtifactRoot(cwd, artifactRootInput);
  } catch (error) {
    return failure('ARTIFACT_ROOT_INVALID', error.message, { artifact_root: artifactRootInput });
  }

  const reviewIndexInput = await readWorkspaceJson({
    cwd,
    inputPath: options['review-index'],
    label: 'review artifact index',
    maxBytes: maxBytes.value
  });
  if (!reviewIndexInput.ok) {
    return failure(reviewIndexInput.error.code, reviewIndexInput.error.message, reviewIndexInput.error.details);
  }

  const reviewIndex = reviewIndexInput.value;
  const artifactRefs = normalizeArtifactReferences(reviewIndex.artifacts);
  const visualRefs = artifactRefs.filter(isVisualEvidenceReference).slice(0, MAX_VISUAL_EVIDENCE_REFS);
  const visualEvidenceReads = await Promise.all(visualRefs.map((artifact) => readVisualEvidenceMetadata({
    cwd,
    artifact,
    maxBytes: maxBytes.value
  })));
  const readableVisualEvidence = visualEvidenceReads
    .filter((item) => item.ok)
    .map((item) => item.visual_evidence);
  const warnings = visualEvidenceReads
    .filter((item) => !item.ok)
    .map((item) => item.warning);

  const status = readableVisualEvidence.length === 0
    ? 'blocked_missing_visual_evidence'
    : 'prepared';
  const preparationRel = artifactRelPath(artifactRootInput, 'visual-review-results', id, 'preparation.json');
  const receiptRel = artifactRelPath(artifactRootInput, 'receipts', id + '.json');
  const providerPolicy = buildVisualReviewProviderPolicy({
    disclosureMode: 'local_reference',
    agentPackage: {
      packet: {
        evidence_packet: {
          artifacts: artifactRefs.map((artifact) => ({
            type: artifact.type,
            path: artifact.path,
            content_included: false
          }))
        }
      }
    },
    surface: {
      id: options.surface ?? null,
      kind: options.surface ? 'planned_surface' : null,
      transport: options.surface ? 'metadata_only' : null,
      credential_mode: 'none'
    },
    provider: {
      id: options.provider ?? null,
      kind: options.provider ? 'planned_provider' : null,
      implemented: false
    },
    model: {
      id: options.model ?? null,
      selected: Boolean(options.model)
    }
  });

  const preparation = redact({
    schema_version: SCHEMA_VERSION,
    id,
    status,
    created_at: now.toISOString(),
    source: {
      review_artifact_index_path: reviewIndexInput.relativePath,
      review_artifact_index_hash: hashText(reviewIndexInput.text),
      review_id: stringOrNull(reviewIndex.id),
      review_mode: stringOrNull(reviewIndex.mode),
      artifact_count: artifactRefs.length,
      evidence_classes: normalizeStringArray(reviewIndex.evidence_classes)
    },
    visual_evidence: {
      status: readableVisualEvidence.length === 0 ? 'missing' : 'ready',
      metadata_only: true,
      reference_count: visualRefs.length,
      readable_count: readableVisualEvidence.length,
      unreadable_count: warnings.length,
      max_references: MAX_VISUAL_EVIDENCE_REFS,
      references: readableVisualEvidence,
      missing_references: visualEvidenceReads
        .filter((item) => !item.ok)
        .map((item) => item.reference)
    },
    provider_policy: providerPolicy,
    disclosure_policy: {
      scope: 'visual_review_result_preparation',
      local_artifact_paths_included: artifactRefs.length > 0,
      visual_evidence_metadata_included: readableVisualEvidence.length > 0,
      raw_artifact_content_included: false,
      raw_pixels_included: false,
      binary_content_included: false,
      screenshot_binary_included: false,
      raw_dom_included: false,
      trace_content_included: false,
      console_payloads_included: false,
      network_payloads_included: false,
      raw_report_body_included: false,
      source_data_values_included: false,
      external_evidence_transfer: false,
      external_evidence_transfer_authorized: false,
      provider_execution_authorized: false,
      requires_owner_review_before_external_transfer: true,
      redaction_applied: true
    },
    result_contract: visualReviewResultContract(),
    result_template: visualReviewResultTemplate({ id }),
    execution: {
      enabled: false,
      execute_supported: false,
      provider_call_planned: false,
      provider_call_performed: false,
      provider_execution_authorized: false,
      external_evidence_transfer: false,
      external_evidence_transfer_authorized: false,
      mcp_execution_exposed: false,
      future_phase_required: true
    },
    dashboard_handoff: {
      preparation_path: preparationRel,
      receipt_path: receiptRel,
      package_command: `${CLI_NAME} agent package --review-index ${reviewIndexInput.relativePath} --json`,
      next_safe_action: readableVisualEvidence.length === 0
        ? 'Capture visual evidence with review --image or browser review screenshot before preparing AI visual review execution.'
        : 'Review the preparation artifact, then use a later approved visual provider execution workflow when available.'
    },
    gate_effect: 'none',
    browser_launched: false,
    provider_call_performed: false,
    api_call_performed: false,
    automatic_upload: false,
    external_evidence_transfer: false,
    credential_values_read: false,
    credential_values_recorded: false,
    raw_provider_response_stored: false,
    raw_pixels_included: false,
    existing_review_mutated: false,
    mcp_execution_exposed: false,
    boundary: visualReviewResultPreparationBoundary()
  });

  const receipt = redact({
    schema_version: SCHEMA_VERSION,
    type: 'visual_review_result_preparation_receipt',
    id,
    created_at: now.toISOString(),
    preparation_path: preparationRel,
    source_review_artifact_index_path: reviewIndexInput.relativePath,
    source_review_artifact_index_hash: hashText(reviewIndexInput.text),
    preparation_hash: hashJson(preparation),
    status,
    visual_evidence_reference_count: visualRefs.length,
    visual_evidence_metadata_count: readableVisualEvidence.length,
    raw_pixels_included: false,
    binary_content_included: false,
    external_evidence_transfer: false,
    provider_call_performed: false,
    api_call_performed: false,
    credential_values_recorded: false,
    mcp_execution_exposed: false
  });

  await writeJsonArtifact(root, ['visual-review-results', id, 'preparation.json'], preparation);
  await writeJsonArtifact(root, ['receipts', id + '.json'], receipt);

  return {
    status: 'ok',
    data: {
      visual_review_result_preparation: preparation,
      visual_review_result_template: preparation.result_template,
      boundary: visualReviewResultPreparationBoundary()
    },
    warnings,
    errors: [],
    artifacts: [
      artifactObject({
        type: 'visual_review_result_preparation',
        path: preparationRel,
        description: 'Local metadata-only preparation for a future visual review result.'
      }),
      artifactObject({
        type: 'visual_review_result_preparation_receipt',
        path: receiptRel,
        description: 'Content-free receipt for local visual review result preparation.'
      })
    ]
  };
}

export function visualReviewResultPreparationBoundary() {
  return {
    local_only: true,
    browser_launched: false,
    provider_call_performed: false,
    provider_execution_authorized: false,
    api_call_performed: false,
    automatic_upload: false,
    external_upload: false,
    external_evidence_transfer: false,
    external_evidence_transfer_authorized: false,
    raw_pixels_included: false,
    raw_pixels_in_json: false,
    binary_content_included: false,
    raw_dom_included: false,
    raw_trace_included: false,
    raw_console_payloads_included: false,
    raw_network_payloads_included: false,
    raw_report_body_included: false,
    credential_values_read: false,
    credential_values_recorded: false,
    raw_provider_response_stored: false,
    mcp_execution_exposed: false,
    mcp_write_execute_exposed: false,
    existing_review_mutated: false,
    gate_effect: 'none',
    requires_owner_review_before_external_transfer: true
  };
}

export function visualReviewResultContract() {
  return {
    required_output_schema: 'visual_review_result',
    status_values: ['not_run', 'completed', 'needs_owner_review', 'rejected'],
    advisory_categories: [
      'visual_hierarchy',
      'layout_integrity',
      'content_clarity',
      'interaction_affordance',
      'accessibility_basics',
      'evidence_quality',
      'owner_decision'
    ],
    evidence_reference_only: true,
    raw_pixels_allowed: false,
    external_evidence_transfer_authorized: false,
    provider_execution_authorized: false,
    gate_effect: 'none',
    existing_review_mutation_allowed: false,
    owner_decision_fields_required: true
  };
}

function visualReviewResultTemplate({ id }) {
  return {
    schema_version: SCHEMA_VERSION,
    id: id + '-result-template',
    status: 'not_run',
    preparation_id: id,
    visual_review_result: {
      preparation_id: id,
      status: 'not_run',
      summary: null,
      advisory_findings: [],
      owner_decision_requests: [],
      evidence_refs: [],
      gate_effect: 'none'
    },
    boundary: visualReviewResultPreparationBoundary()
  };
}

async function readVisualEvidenceMetadata({ cwd, artifact, maxBytes }) {
  const reference = {
    type: artifact.type,
    path: artifact.path
  };
  const input = await readWorkspaceJson({
    cwd,
    inputPath: artifact.path,
    label: 'visual evidence metadata',
    maxBytes
  });
  if (!input.ok) {
    return {
      ok: false,
      reference,
      warning: {
        code: input.error.code,
        message: 'Could not read visual evidence metadata; raw artifact content was not inspected.',
        details: { ...input.error.details, path: artifact.path }
      }
    };
  }
  return {
    ok: true,
    visual_evidence: normalizeVisualEvidenceMetadata(input.value, input.relativePath)
  };
}

function normalizeVisualEvidenceMetadata(record, relativePath) {
  return {
    id: stringOrNull(record.id),
    path: relativePath,
    purpose: stringOrNull(record.purpose),
    source: {
      kind: stringOrNull(record.source?.kind),
      path: stringOrNull(record.source?.path),
      artifact_path: stringOrNull(record.source?.artifact_path)
    },
    media: {
      bytes: numberOrNull(record.media?.bytes),
      sha256: stringOrNull(record.media?.sha256),
      format: stringOrNull(record.media?.format),
      media_type: stringOrNull(record.media?.media_type),
      width: numberOrNull(record.media?.width),
      height: numberOrNull(record.media?.height),
      dimensions_available: Boolean(record.media?.dimensions_available)
    },
    privacy: {
      may_contain_sensitive_content: record.privacy?.may_contain_sensitive_content !== false,
      may_contain_page_content: Boolean(record.privacy?.may_contain_page_content),
      may_contain_desktop_content: Boolean(record.privacy?.may_contain_desktop_content),
      requires_owner_review_before_external_transfer: record.privacy?.requires_owner_review_before_external_transfer !== false
    },
    boundary: {
      local_only: record.boundary?.local_only !== false,
      raw_pixels_in_json: false,
      binary_content_included: false,
      provider_call_performed: false,
      external_upload: false,
      mcp_execution_exposed: false
    }
  };
}

async function readWorkspaceJson({ cwd, inputPath, label, maxBytes }) {
  if (!inputPath || typeof inputPath !== 'string') {
    return {
      ok: false,
      error: {
        code: 'VISUAL_REVIEW_PREPARATION_INPUT_REQUIRED',
        message: label + ' path is required.',
        details: { label }
      }
    };
  }
  if (path.isAbsolute(inputPath) || inputPath.includes('\0') || inputPath.split(/[\\/]+/).includes('..')) {
    return {
      ok: false,
      error: {
        code: 'VISUAL_REVIEW_PREPARATION_PATH_OUTSIDE_WORKSPACE',
        message: label + ' path must be a workspace-relative path without parent traversal.',
        details: { label, path: inputPath }
      }
    };
  }
  const workspaceRoot = path.resolve(cwd ?? process.cwd());
  const absolutePath = path.resolve(workspaceRoot, inputPath);
  if (!isPathInside(absolutePath, workspaceRoot)) {
    return {
      ok: false,
      error: {
        code: 'VISUAL_REVIEW_PREPARATION_PATH_OUTSIDE_WORKSPACE',
        message: label + ' path must stay inside the workspace.',
        details: { label, path: inputPath }
      }
    };
  }
  try {
    const realWorkspaceRoot = await realpath(workspaceRoot);
    const realInputPath = await realpath(absolutePath);
    if (!isPathInside(realInputPath, realWorkspaceRoot)) {
      return {
        ok: false,
        error: {
          code: 'VISUAL_REVIEW_PREPARATION_REALPATH_OUTSIDE_WORKSPACE',
          message: label + ' real path must stay inside the workspace.',
          details: { label, path: inputPath }
        }
      };
    }
    const stat = await lstat(realInputPath);
    if (!stat.isFile()) {
      return {
        ok: false,
        error: {
          code: 'VISUAL_REVIEW_PREPARATION_INPUT_NOT_FILE',
          message: label + ' must be a regular JSON file.',
          details: { label, path: inputPath }
        }
      };
    }
    if (stat.size > maxBytes) {
      return {
        ok: false,
        error: {
          code: 'VISUAL_REVIEW_PREPARATION_INPUT_TOO_LARGE',
          message: label + ' exceeds the configured byte limit.',
          details: { label, path: inputPath, bytes: stat.size, max_bytes: maxBytes }
        }
      };
    }
    const text = await readFile(realInputPath, 'utf8');
    return {
      ok: true,
      value: JSON.parse(text),
      text,
      relativePath: path.relative(realWorkspaceRoot, realInputPath).split(path.sep).join('/')
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'VISUAL_REVIEW_PREPARATION_READ_FAILED',
        message: 'Could not read ' + label + ' JSON.',
        details: { label, path: inputPath, reason: error.message }
      }
    };
  }
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeArtifactReferences(artifacts) {
  if (!Array.isArray(artifacts)) {
    return [];
  }
  return artifacts.slice(0, 200).map((artifact) => ({
    type: truncateString(artifact?.type ?? 'artifact', 100),
    path: truncateString(artifact?.path ?? '', 500),
    description: truncateString(artifact?.description ?? '', 500),
    content_included: false,
    local_reference: true
  }));
}

function isVisualEvidenceReference(artifact) {
  return artifact.type === 'visual_evidence' || String(artifact.path ?? '').includes('/visual-evidence/');
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => truncateString(item, 200)).filter(Boolean)
    : [];
}

function truncateString(value, maxLength) {
  const text = String(value ?? '').trim();
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

function stringOrNull(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value);
  return text.length > 0 ? text : null;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function parseMaxBytes(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: DEFAULT_PREPARATION_MAX_BYTES };
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, message: 'visual review prepare --max-bytes must be a positive integer.' };
  }
  return { ok: true, value: parsed };
}

function materializeNow(now) {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) {
    return value;
  }
  if (value) {
    return new Date(value);
  }
  return new Date();
}

function hashText(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function hashJson(value) {
  return hashText(JSON.stringify(value));
}

function failure(code, message, details = {}) {
  return {
    status: 'error',
    data: {
      boundary: visualReviewResultPreparationBoundary()
    },
    warnings: [],
    errors: [{ code, message, details }],
    artifacts: []
  };
}
