import {
  artifactObject,
  artifactRelPath,
  createArtifactId,
  ensureArtifactRoot,
  writeJsonArtifact,
  writeTextArtifact
} from './artifacts.js';
import {
  CAPTURE_HANDOFF_JSON_MAX_BYTES,
  normalizeCaptureHandoffContract,
  readCaptureHandoffJsonInput
} from './capture-handoff.js';
import { DEFAULT_ARTIFACT_ROOT, SCHEMA_VERSION } from './constants.js';
import { createVisualEvidenceArtifact, readWorkspaceImageFile } from './visual-evidence.js';

const MIN_REVIEWABLE_DIMENSION = 64;
const DEFAULT_IMAGE_REVIEW_MAX_BYTES = 20 * 1024 * 1024;

const SOURCE_KIND_BY_IMAGE_REVIEW_SOURCE = Object.freeze({
  image: 'image_file',
  screen: 'screen_capture',
  window: 'window_capture',
  'desktop-app': 'desktop_app_capture'
});

export const IMAGE_REVIEW_SOURCE_IDS = Object.freeze(Object.keys(SOURCE_KIND_BY_IMAGE_REVIEW_SOURCE));
const IMAGE_REVIEW_SOURCE_BY_KIND = Object.freeze(Object.fromEntries(
  Object.entries(SOURCE_KIND_BY_IMAGE_REVIEW_SOURCE).map(([source, kind]) => [kind, source])
));

export async function runImageReview(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const artifactRootInput = options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT;
  const now = materializeNow(context.now);
  const id = context.createId?.('image-review', now) ?? createArtifactId(now, 'image-review');
  const maxBytes = parseMaxBytes(options['max-bytes']);
  if (!maxBytes.ok) {
    return failure('IMAGE_REVIEW_INVALID_MAX_BYTES', maxBytes.message, { max_bytes: options['max-bytes'] });
  }

  let root;
  try {
    root = await ensureArtifactRoot(cwd, artifactRootInput);
  } catch (error) {
    return failure('ARTIFACT_ROOT_INVALID', error.message, { artifact_root: artifactRootInput });
  }

  let image;
  try {
    image = await readWorkspaceImageFile({
      cwd,
      inputPath: options.image,
      maxBytes: maxBytes.value
    });
  } catch (error) {
    return failure(error.code ?? 'IMAGE_REVIEW_INPUT_READ_FAILED', error.message, {
      image: options.image,
      ...(error.details ?? {})
    });
  }

  const sourceSelection = await resolveImageReviewSourceSelection({
    cwd,
    image,
    maxBytes: Math.min(maxBytes.value, CAPTURE_HANDOFF_JSON_MAX_BYTES),
    options,
    stdinText: context.stdinText
  });
  if (!sourceSelection.ok) {
    return failure(sourceSelection.code, sourceSelection.message, sourceSelection.details);
  }

  const visualEvidence = await createVisualEvidenceArtifact({
    id,
    root,
    artifactRoot: artifactRootInput,
    sourceKind: sourceSelection.source_kind,
    sourcePath: image.workspace_path,
    buffer: image.buffer,
    purpose: 'standalone_image_review',
    capture: sourceSelection.capture,
    labels: ['standalone_image_review', sourceSelection.source],
    createdAt: now
  });

  const reviewRel = artifactRelPath(artifactRootInput, 'reviews', id + '.json');
  const findings = imageReviewFindings({ media: image.media, visualEvidencePath: visualEvidence.artifact.path });
  const status = findings.length > 0 ? 'needs_attention' : 'passed';
  const imageReview = {
    schema_version: SCHEMA_VERSION,
    id,
    status,
    created_at: now.toISOString(),
    review: {
      id,
      mode: 'image_file',
      status,
      source_kind: sourceSelection.source_kind,
      source_selection: sourceSelection.source,
      source_path: image.workspace_path,
      capture_handoff_id: sourceSelection.capture_handoff?.id ?? null,
      source_verified_by_trace_cue: false,
      caller_declared_provenance: sourceSelection.source !== 'image',
      browser_launched: false,
      provider_call_performed: false,
      external_evidence_transfer: false,
      deterministic_browser_review_unchanged: true
    },
    image_review: {
      id,
      status,
      source: {
        kind: sourceSelection.source_kind,
        selection: sourceSelection.source,
        path: image.workspace_path,
        caller_declared_provenance: sourceSelection.source !== 'image',
        source_verified_by_trace_cue: false,
        capture_performed_by_trace_cue: false
      },
      capture_handoff: sourceSelection.capture_handoff,
      media: image.media,
      visual_evidence: {
        path: visualEvidence.artifact.path,
        media: visualEvidence.data.media,
        privacy: visualEvidence.data.privacy,
        boundary: visualEvidence.data.boundary
      },
      advisory: {
        deterministic_only: true,
        human_visual_review_replaced: false,
        provider_call_performed: false,
        next_step: 'Use this metadata-only image review as local evidence, then run an approved visual provider or human review workflow when subjective judgment is required.'
      }
    },
    findings,
    metrics: {
      finding_count: findings.length,
      format: image.media.format,
      media_type: image.media.media_type,
      source_kind: sourceSelection.source_kind,
      bytes: image.media.bytes,
      width: image.media.width,
      height: image.media.height,
      dimensions_available: image.media.dimensions_available,
      browser_launched: false,
      provider_call_performed: false,
      max_input_bytes: maxBytes.value
    },
    quality_signals: imageQualitySignals(image.media, findings),
    evidence_summary: {
      visual_evidence_path: visualEvidence.artifact.path,
      source_kind: sourceSelection.source_kind,
      capture_handoff_path: sourceSelection.capture_handoff?.input_path ?? null,
      capture_handoff_hash: sourceSelection.capture_handoff?.input_hash ?? null,
      raw_pixels_in_json: false,
      binary_content_included: false,
      local_artifact_paths: [visualEvidence.artifact.path, reviewRel]
    },
    environment: {
      cwd,
      artifact_root: artifactRootInput
    },
    boundary: imageReviewBoundary({
      captureHandoffJsonRead: Boolean(sourceSelection.capture_handoff),
      captureHandoffMediaSha256Matched: sourceSelection.capture_handoff?.media_sha256_matched === true
    })
  };

  const artifacts = [
    artifactObject({
      type: 'image_review',
      path: reviewRel,
      description: 'Local standalone image review metadata without embedded image bytes.'
    }),
    visualEvidence.artifact
  ];

  if (options.report) {
    const reportRel = artifactRelPath(artifactRootInput, 'reports', id + '.md');
    await writeTextArtifact(root, ['reports', id + '.md'], imageReviewMarkdown(imageReview));
    artifacts.push(artifactObject({
      type: 'image_review_report',
      path: reportRel,
      description: 'Markdown summary for the local standalone image review.'
    }));
    imageReview.image_review.report_path = reportRel;
  }

  const artifactIndex = await writeImageReviewArtifactIndex({
    id,
    root,
    artifactRoot: artifactRootInput,
    artifacts,
    imageReview
  });
  imageReview.artifact_index = artifactIndex.data;
  await writeJsonArtifact(root, ['reviews', id + '.json'], imageReview);
  artifacts.push(artifactIndex.artifact);

  return {
    status: 'ok',
    data: imageReview,
    warnings: [],
    errors: [],
    artifacts
  };
}

async function writeImageReviewArtifactIndex({ id, root, artifactRoot, artifacts, imageReview }) {
  const rel = artifactRelPath(artifactRoot, 'review-artifacts', id + '.json');
  const data = {
    schema_version: SCHEMA_VERSION,
    id,
    mode: 'image_file',
    local_only: true,
    external_upload: false,
    artifact_root: artifactRoot,
    artifact_count: artifacts.length,
    evidence_classes: ['visual evidence metadata', 'image metadata'],
    artifacts: artifacts.map((artifact) => ({
      type: artifact.type,
      path: artifact.path,
      description: artifact.description
    })),
    triage: {
      status: imageReview.status,
      local_release_gate: 'not_applicable',
      model_review_enabled: false
    },
    coverage_summary: null,
    rerun: {
      command: 'trace-cue review --image ' + imageReview.image_review.source.path + rerunSourceOption(imageReview.image_review.source, imageReview.image_review.capture_handoff) + ' --json',
      guidance: [
        'Rerun the same workspace image after updating the captured evidence.',
        'Use owner-approved visual provider or human review workflows for subjective judgment.'
      ]
    },
    boundaries: {
      screenshots_may_contain_page_content: false,
      visual_evidence_may_reference_sensitive_content: true,
      traces_may_contain_page_content: false,
      profile_reuse: false,
      credential_storage: false,
      raw_pixels_in_json: false,
      provider_call_performed: false,
      external_upload: false,
      source_verified_by_trace_cue: false,
      caller_declared_provenance: imageReview.image_review.source.caller_declared_provenance,
      capture_handoff_json_read: Boolean(imageReview.image_review.capture_handoff),
      capture_handoff_media_sha256_matched: imageReview.image_review.capture_handoff?.media_sha256_matched === true,
      mcp_execution_exposed: false
    }
  };
  await writeJsonArtifact(root, ['review-artifacts', id + '.json'], data);
  return {
    data,
    artifact: artifactObject({
      type: 'review_artifact_index',
      path: rel,
      description: 'Local index of standalone image review artifacts and evidence classes.'
    })
  };
}

export function imageReviewBoundary(options = {}) {
  return {
    local_only: true,
    browser_launched: false,
    provider_call_performed: false,
    external_upload: false,
    external_evidence_transfer: false,
    automatic_upload: false,
    raw_pixels_in_json: false,
    binary_content_included: false,
    raw_provider_response_stored: false,
    credential_values_read: false,
    credential_values_recorded: false,
    provider_execution_authorized: false,
    mcp_execution_exposed: false,
    mcp_write_execute_exposed: false,
    workspace_confined_input: true,
    input_realpath_inside_workspace: true,
    regular_file_required: true,
    symlink_escape_allowed: false,
    capture_handoff_json_read: Boolean(options.captureHandoffJsonRead),
    capture_handoff_media_sha256_matched: Boolean(options.captureHandoffMediaSha256Matched),
    requires_owner_review_before_external_transfer: true,
    source_provenance_caller_declared: true,
    source_identity_verified_by_trace_cue: false,
    capture_performed_by_trace_cue: false,
    os_capture_api_used: false,
    window_enumeration_performed: false,
    process_enumeration_performed: false,
    deterministic_browser_review_unchanged: true,
    existing_review_mutated: false
  };
}

export function normalizeImageReviewSource(value) {
  const source = String(value ?? 'image').trim() || 'image';
  const sourceKind = SOURCE_KIND_BY_IMAGE_REVIEW_SOURCE[source];
  if (sourceKind) {
    return { ok: true, source, source_kind: sourceKind };
  }
  return {
    ok: false,
    code: 'INVALID_IMAGE_REVIEW_SOURCE',
    message: `Unsupported image review source: ${source}. Expected one of: ${IMAGE_REVIEW_SOURCE_IDS.join(', ')}.`
  };
}

async function resolveImageReviewSourceSelection({ cwd, image, maxBytes, options, stdinText }) {
  const explicitSource = normalizeImageReviewSource(options.source);
  if (!explicitSource.ok) {
    return {
      ok: false,
      code: explicitSource.code,
      message: explicitSource.message,
      details: { source: options.source }
    };
  }
  if (!options['capture-handoff']) {
    return {
      ok: true,
      ...explicitSource,
      capture: null,
      capture_handoff: null
    };
  }

  const input = await readCaptureHandoffJsonInput({
    cwd,
    input: options['capture-handoff'],
    stdinText,
    maxBytes,
    codePrefix: 'IMAGE_REVIEW_CAPTURE_HANDOFF',
    stdinErrorCode: 'IMAGE_REVIEW_CAPTURE_HANDOFF_STDIN_NOT_AVAILABLE',
    requiredMessage: 'review --image --capture-handoff requires capture handoff JSON.'
  });
  if (!input.ok) {
    return {
      ok: false,
      code: input.error.code,
      message: input.error.message,
      details: input.error.details
    };
  }

  const normalized = normalizeCaptureHandoffContract(input.value, {
    codePrefix: 'IMAGE_REVIEW_CAPTURE_HANDOFF'
  });
  if (!normalized.ok) {
    return {
      ok: false,
      code: normalized.error.code,
      message: normalized.error.message,
      details: normalized.error.details
    };
  }

  const handoff = normalized.captureHandoff;
  const source = handoff.source ?? {};
  const media = handoff.media ?? {};
  if (source.path !== image.workspace_path) {
    return {
      ok: false,
      code: 'IMAGE_REVIEW_CAPTURE_HANDOFF_IMAGE_MISMATCH',
      message: 'review --image path must match capture handoff source.path.',
      details: { image: image.workspace_path, capture_handoff_image: source.path }
    };
  }
  if (media.sha256 !== image.media.sha256) {
    return {
      ok: false,
      code: 'IMAGE_REVIEW_CAPTURE_HANDOFF_HASH_MISMATCH',
      message: 'review --image bytes must match capture handoff media.sha256.',
      details: { image_sha256: image.media.sha256, capture_handoff_sha256: media.sha256 }
    };
  }
  if (options.source !== undefined && explicitSource.source_kind !== source.kind) {
    return {
      ok: false,
      code: 'IMAGE_REVIEW_CAPTURE_HANDOFF_SOURCE_MISMATCH',
      message: 'review --image --source must match the capture handoff source kind when both are provided.',
      details: {
        source: explicitSource.source,
        source_kind: explicitSource.source_kind,
        capture_handoff_source_kind: source.kind
      }
    };
  }

  const sourceId = source.selection ?? IMAGE_REVIEW_SOURCE_BY_KIND[source.kind] ?? 'image';
  const captureHandoff = {
    id: handoff.id ?? null,
    input_path: input.relativePath,
    input_hash: input.textHash,
    input_source: input.source,
    source_selection: sourceId,
    source_kind: source.kind,
    media_sha256_matched: true,
    source_path_matched: true,
    caller_declared_provenance: source.caller_declared_provenance === true,
    source_verified_by_trace_cue: false,
    capture_performed_by_trace_cue: false
  };

  return {
    ok: true,
    source: sourceId,
    source_kind: source.kind,
    capture: {
      handoff_id: captureHandoff.id,
      handoff_path: captureHandoff.input_path,
      handoff_hash: captureHandoff.input_hash,
      handoff_input_source: captureHandoff.input_source,
      source_selection: captureHandoff.source_selection,
      caller_declared_provenance: true,
      source_verified_by_trace_cue: false,
      capture_performed_by_trace_cue: false,
      media_sha256_matched: true,
      source_path_matched: true
    },
    capture_handoff: captureHandoff
  };
}

function rerunSourceOption(source, captureHandoff) {
  if (captureHandoff?.input_path) {
    return ' --capture-handoff ' + captureHandoff.input_path;
  }
  return source?.selection && source.selection !== 'image' ? ' --source ' + source.selection : '';
}

function imageReviewFindings({ media, visualEvidencePath }) {
  const findings = [];
  if (media.format === 'unknown') {
    findings.push(finding({
      id: 'image-format-unknown',
      severity: 'medium',
      message: 'The image format could not be recognized from file signature or extension.',
      evidence: { format: media.format, media_type: media.media_type },
      artifactPath: visualEvidencePath
    }));
  }
  if (!media.dimensions_available) {
    findings.push(finding({
      id: 'image-dimensions-unavailable',
      severity: 'low',
      message: 'Image dimensions could not be detected, so layout-scale review remains limited.',
      evidence: { format: media.format, width: media.width, height: media.height },
      artifactPath: visualEvidencePath
    }));
  }
  if (Number.isInteger(media.width) && Number.isInteger(media.height) && (media.width < MIN_REVIEWABLE_DIMENSION || media.height < MIN_REVIEWABLE_DIMENSION)) {
    findings.push(finding({
      id: 'image-review-small-canvas',
      severity: 'low',
      message: 'The image canvas is very small for visual review evidence.',
      evidence: { width: media.width, height: media.height, min_reviewable_dimension: MIN_REVIEWABLE_DIMENSION },
      artifactPath: visualEvidencePath
    }));
  }
  return findings;
}

function finding({ id, severity, message, evidence, artifactPath }) {
  return {
    id,
    category: 'evidence_quality',
    severity,
    confidence: 'high',
    source: 'deterministic',
    selector: null,
    rect: null,
    route: null,
    viewport: null,
    message,
    evidence,
    artifacts: [artifactPath],
    repro: ['Run trace-cue review --image <workspace-image> --json from the workspace root.'],
    priority: severity === 'medium' ? 'normal' : 'low',
    impact: 'Limits confidence in standalone image review evidence.',
    recommendation: 'Use a supported image file with detectable dimensions when possible.',
    fix_candidates: [],
    implementation_notes: { deterministic_only: true },
    owner_decision_required: false
  };
}

function imageQualitySignals(media, findings) {
  return {
    evidence_completeness: {
      status: findings.length === 0 ? 'passed' : 'needs_attention',
      dimensions_available: media.dimensions_available,
      format: media.format,
      finding_count: findings.length
    },
    model_review_boundary: {
      status: 'not_run',
      provider_call_performed: false,
      raw_pixels_transferred: false,
      human_visual_review_replaced: false
    }
  };
}

function imageReviewMarkdown(imageReview) {
  const lines = [
    '# Standalone Image Review',
    '',
    '- Status: ' + imageReview.status,
    '- Source: ' + imageReview.image_review.source.path,
    '- Format: ' + imageReview.image_review.media.format,
    '- Dimensions: ' + (imageReview.image_review.media.width ?? 'unknown') + ' x ' + (imageReview.image_review.media.height ?? 'unknown'),
    '- Visual evidence: ' + imageReview.image_review.visual_evidence.path,
    '- Provider call performed: false',
    '- Raw pixels embedded in JSON: false',
    '',
    '## Findings'
  ];
  if (imageReview.findings.length === 0) {
    lines.push('', 'No deterministic evidence-quality findings were produced.');
  } else {
    for (const item of imageReview.findings) {
      lines.push('', '- ' + item.severity + ': ' + item.message);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function parseMaxBytes(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: DEFAULT_IMAGE_REVIEW_MAX_BYTES };
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, message: 'Image review --max-bytes must be a positive integer.' };
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

function failure(code, message, details = {}) {
  return {
    status: 'error',
    data: {
      boundary: imageReviewBoundary()
    },
    warnings: [],
    errors: [{ code, message, details }],
    artifacts: []
  };
}
