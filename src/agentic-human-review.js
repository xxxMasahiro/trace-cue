import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  artifactObject,
  artifactRelPath,
  createArtifactId,
  ensureArtifactRoot,
  resolveArtifactRoot,
  writeJsonArtifact,
  writeTextArtifact
} from './artifacts.js';
import { AGENT_SURFACES } from './agent.js';
import { CLI_NAME, DEFAULT_ARTIFACT_ROOT, SCHEMA_VERSION } from './constants.js';
import { redact, redactString, truncateText } from './redaction.js';
import {
  buildAgenticProviderReadiness,
  executeAgenticHumanReviewApiProvider,
  providerBoundary as providerBoundaryRecord,
  resolveAgenticHumanReviewProvider
} from './agentic-human-review-providers.js';

export const AGENTIC_HUMAN_REVIEW_VERSION = '1.0.0';

const DEFAULT_PROVIDER_ID = 'fake-agent';
const DEFAULT_MODEL_ID = 'fake-model';
const DEFAULT_REVIEW_EFFORT = 'standard';
const DEFAULT_SUBAGENT_EFFORT = 'medium';
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_SNIPPETS = 20;
const MAX_EVIDENCE_REFS = 50;
const MAX_ROLE_OPINIONS = 12;
const MAX_FINDINGS = 50;
const MAX_PROPOSAL_BRIEF_BYTES = 32 * 1024;

const REVIEW_EFFORTS = new Set(['quick', 'standard', 'deep', 'xhigh']);
const SUBAGENT_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const CONFIDENCE_VALUES = new Set(['low', 'medium', 'high', 'inconclusive']);
const SEVERITIES = new Set(['info', 'low', 'medium', 'high', 'critical']);

const TRANSFER_CLASSES = Object.freeze([
  { id: 'raw_pixels', flag: 'allow-raw-pixels', label: 'Screenshot or image pixels' },
  { id: 'page_text', flag: 'allow-page-text', label: 'Visible page or screen text' },
  { id: 'dom_summary', flag: 'allow-dom-summary', label: 'DOM or semantic summary' },
  { id: 'url', flag: 'allow-url', label: 'URL, route, or navigation metadata' },
  { id: 'artifact_refs', flag: 'allow-artifact-refs', label: 'Local artifact references' },
  { id: 'accessibility_summary', flag: 'allow-accessibility-summary', label: 'Accessibility or comprehension summary' }
]);

const RUBRIC_AREAS = Object.freeze([
  'first_impression',
  'visual_perception',
  'ui_ux_clarity',
  'readability',
  'meaning_and_comprehension',
  'copy_and_tone',
  'trust_and_credibility',
  'emotional_reception',
  'information_architecture',
  'flow_and_next_action_clarity',
  'accessibility_and_comprehension',
  'risk_and_misleading_content',
  'strengths',
  'improvement_suggestions'
]);

export async function runAgenticHumanReviewPropose(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const now = materializeNow(context.now);
  const artifactRootInput = options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT;
  const id = context.createId?.('agentic-human-review-proposal', now) ?? createArtifactId(now, 'agentic-human-review-proposal');
  const maxBytes = parseMaxBytes(options['max-bytes']);
  if (!maxBytes.ok) {
    return errorResult('AGENTIC_REVIEW_INVALID_MAX_BYTES', maxBytes.message, { max_bytes: options['max-bytes'] });
  }
  if (options.execute) {
    return errorResult('AGENTIC_REVIEW_PROPOSE_EXECUTE_NOT_SUPPORTED', 'agentic review propose is planning-intake only and does not accept --execute.', {
      option: 'execute'
    });
  }

  let root;
  try {
    root = await ensureArtifactRoot(cwd, artifactRootInput);
  } catch (error) {
    return errorResult('ARTIFACT_ROOT_INVALID', error.message, { artifact_root: artifactRootInput });
  }

  const briefRead = await resolveProposalBrief(options, context);
  if (!briefRead.ok) {
    return errorResult(briefRead.error.code, briefRead.error.message, briefRead.error.details);
  }

  const effort = normalizeReviewEffort(options.effort ?? options['review-effort'] ?? inferReviewEffort(briefRead.brief));
  if (!effort.ok) {
    return errorResult('AGENTIC_REVIEW_INVALID_EFFORT', effort.message, { effort: options.effort ?? options['review-effort'] });
  }
  const defaultSubagentEffort = normalizeSubagentEffort(options['default-subagent-effort']);
  if (!defaultSubagentEffort.ok) {
    return errorResult('AGENTIC_REVIEW_INVALID_SUBAGENT_EFFORT', defaultSubagentEffort.message, {
      default_subagent_effort: options['default-subagent-effort']
    });
  }
  const roleEfforts = parseRoleEfforts(options['role-efforts']);
  if (!roleEfforts.ok) {
    return errorResult('AGENTIC_REVIEW_INVALID_ROLE_EFFORTS', roleEfforts.message, { role_efforts: options['role-efforts'] });
  }
  const provider = resolveProviderDescriptor(options.provider, context);
  if (!provider.ok) {
    return errorResult(provider.error.code, provider.error.message, provider.error.details);
  }
  const model = { id: options.model ?? provider.provider.default_model ?? DEFAULT_MODEL_ID };
  const surface = findSurface(options.surface);
  if (!surface) {
    return errorResult('AGENTIC_REVIEW_SURFACE_NOT_FOUND', 'No agent surface matched the requested agentic review surface.', {
      surface: options.surface,
      available_surfaces: AGENT_SURFACES.map((item) => item.id)
    });
  }

  const orchestration = buildEffortOrchestration({
    effort: effort.value,
    defaultSubagentEffort: defaultSubagentEffort.value,
    roleEfforts: roleEfforts.value
  });
  const reviewIndexPreview = await buildProposalReviewIndexPreview({
    cwd,
    options,
    artifactRootInput,
    id,
    now,
    brief: briefRead.brief,
    maxBytes: maxBytes.value,
    provider: provider.provider
  });
  if (!reviewIndexPreview.ok) {
    return errorResult(reviewIndexPreview.error.code, reviewIndexPreview.error.message, reviewIndexPreview.error.details);
  }

  const proposalRel = artifactRelPath(artifactRootInput, 'agentic-human-review-proposals', id, 'proposal.json');
  const receiptRel = artifactRelPath(artifactRootInput, 'receipts', `${id}-agentic-proposal.json`);
  const structuredIntent = buildStructuredIntent({
    brief: briefRead.brief,
    targetAudience: options['target-audience'],
    expectedImpression: options['expected-impression']
  });
  const proposalBase = redact({
    schema_version: SCHEMA_VERSION,
    proposal_version: AGENTIC_HUMAN_REVIEW_VERSION,
    type: 'agentic_human_review_proposal',
    id,
    status: 'proposal_ready',
    created_at: now.toISOString(),
    proposal_path: proposalRel,
    source_request: {
      input_mode: briefRead.inputMode,
      brief_hash: hashText(briefRead.brief),
      brief_excerpt: truncateText(briefRead.brief, 600),
      review_index_path: reviewIndexPreview.reviewIndexPath,
      review_index_hash: reviewIndexPreview.reviewIndexHash,
      case_id: stringOrNull(options['case-id']),
      fixture_id: stringOrNull(options['fixture-id'])
    },
    structured_intent: structuredIntent,
    plan_candidate: {
      review_index_path: reviewIndexPreview.reviewIndexPath,
      intent: structuredIntent.purpose,
      effort: orchestration.review_effort.mode,
      default_subagent_effort: orchestration.default_subagent_effort,
      role_efforts: orchestration.role_efforts,
      provider_id: provider.provider.id,
      model_id: model.id,
      surface_id: surface.id,
      target_audience: structuredIntent.target_audience,
      expected_impression: structuredIntent.expected_impression,
      dogfood_metadata: buildDogfoodMetadataFromOptions(options)
    },
    human_explanation: {
      plain_language_summary: explainProposal({ structuredIntent, orchestration, transferPermissions: reviewIndexPreview.transferPermissions }),
      what_will_be_reviewed: reviewScope(structuredIntent.purpose).review_targets,
      likely_reader_questions: reviewScope(structuredIntent.purpose).likely_reader_questions,
      sub_agent_roles: orchestration.sub_agents.map((agent) => ({
        role: agent.role,
        display_name: agent.display_name,
        effort: agent.effort,
        purpose: agent.purpose
      })),
      disclosure_summary: disclosureSummary(reviewIndexPreview.transferPermissions),
      proposal_performed_only: true,
      provider_execution_requires_approved_plan: true
    },
    review_effort: orchestration.review_effort,
    default_subagent_effort: orchestration.default_subagent_effort,
    role_efforts: orchestration.role_efforts,
    sub_agents: orchestration.sub_agents,
    rounds: orchestration.rounds,
    transfer_preview: reviewIndexPreview.transferPermissions,
    provider: provider.provider,
    model,
    surface: surfaceSummary(surface),
    next_commands: {
      plan: {
        argv: buildPlanCommandArgs({ proposalPath: proposalRel, reviewIndexPath: reviewIndexPreview.reviewIndexPath }),
        display: buildPlanCommand({ proposalPath: proposalRel, reviewIndexPath: reviewIndexPreview.reviewIndexPath })
      },
      run: {
        available_after_plan: true,
        reason: 'A fresh plan hash is created only by agentic review plan.'
      }
    },
    approval: {
      proposal_is_not_approval: true,
      plan_hash_created: false,
      provider_execution_authorized: false,
      transfer_authorized: false,
      execute_flag_accepted: false,
      mcp_execution_allowed: false
    },
    boundary: agenticHumanReviewBoundary({
      writes_artifacts: true,
      planning_only: true
    }),
    gate_effect: 'none'
  });
  const proposalHash = computeProposalHash(proposalBase);
  const proposal = redact({
    ...proposalBase,
    proposal_hash: proposalHash
  });
  const receipt = redact({
    schema_version: SCHEMA_VERSION,
    type: 'agentic_human_review_proposal_receipt',
    id,
    created_at: now.toISOString(),
    proposal_path: proposalRel,
    proposal_hash: proposalHash,
    status: 'proposal_completed_execution_not_started',
    provider_call_performed: false,
    api_call_performed: false,
    external_evidence_transfer: false,
    raw_pixels_read: false,
    raw_pixels_transferred: false,
    page_text_transferred: false,
    dom_summary_transferred: false,
    url_metadata_transferred: false,
    artifact_refs_transferred: false,
    accessibility_summary_transferred: false,
    raw_provider_response_stored: false,
    credential_values_recorded: false,
    mcp_execution_exposed: false,
    gate_effect: 'none'
  });

  await writeJsonArtifact(root, ['agentic-human-review-proposals', id, 'proposal.json'], proposal);
  await writeJsonArtifact(root, ['receipts', `${id}-agentic-proposal.json`], receipt);

  return {
    status: 'ok',
    data: {
      agentic_human_review_proposal: proposal,
      proposal_hash: proposalHash,
      approval_required: true,
      boundary: proposal.boundary
    },
    warnings: [...briefRead.warnings, ...reviewIndexPreview.warnings],
    errors: [],
    artifacts: [
      artifactObject({
        type: 'agentic_human_review_proposal',
        path: proposalRel,
        description: 'Local non-executing conversational agentic human review proposal.'
      }),
      artifactObject({
        type: 'agentic_human_review_proposal_receipt',
        path: receiptRel,
        description: 'Content-free receipt for the proposal step.'
      })
    ]
  };
}

export async function runAgenticHumanReviewPlan(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const now = materializeNow(context.now);
  const artifactRootInput = options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT;
  const id = context.createId?.('agentic-human-review-plan', now) ?? createArtifactId(now, 'agentic-human-review-plan');
  const maxBytes = parseMaxBytes(options['max-bytes']);
  if (!maxBytes.ok) {
    return errorResult('AGENTIC_REVIEW_INVALID_MAX_BYTES', maxBytes.message, { max_bytes: options['max-bytes'] });
  }
  if (options.execute) {
    return errorResult('AGENTIC_REVIEW_PLAN_EXECUTE_NOT_SUPPORTED', 'agentic review plan is planning-only and does not accept --execute.', {
      option: 'execute'
    });
  }

  let root;
  try {
    root = await ensureArtifactRoot(cwd, artifactRootInput);
  } catch (error) {
    return errorResult('ARTIFACT_ROOT_INVALID', error.message, { artifact_root: artifactRootInput });
  }

  const proposalRead = await readProposalForPlan({ cwd, options, maxBytes: maxBytes.value });
  if (!proposalRead.ok) {
    return errorResult(proposalRead.error.code, proposalRead.error.message, proposalRead.error.details);
  }
  const planOptions = applyProposalDefaults(options, proposalRead.proposal);
  const reviewIndexPath = planOptions['review-index'];
  if (!reviewIndexPath) {
    return errorResult('AGENTIC_REVIEW_REVIEW_INDEX_REQUIRED', 'agentic review plan requires --review-index or a proposal with a review_index_path.', {
      options: ['review-index', 'proposal']
    });
  }

  const reviewIndexRead = await readWorkspaceJson({
    cwd,
    inputPath: reviewIndexPath,
    label: 'review artifact index',
    maxBytes: maxBytes.value
  });
  if (!reviewIndexRead.ok) {
    return errorResult(reviewIndexRead.error.code, reviewIndexRead.error.message, reviewIndexRead.error.details);
  }

  const reviewArtifact = await readLinkedReviewArtifact({
    cwd,
    reviewIndex: reviewIndexRead.value,
    maxBytes: maxBytes.value
  });
  const intentRead = await resolveIntent(planOptions, context);
  if (!intentRead.ok) {
    return errorResult(intentRead.error.code, intentRead.error.message, intentRead.error.details);
  }

  const effort = normalizeReviewEffort(planOptions.effort ?? planOptions['review-effort']);
  if (!effort.ok) {
    return errorResult('AGENTIC_REVIEW_INVALID_EFFORT', effort.message, { effort: planOptions.effort ?? planOptions['review-effort'] });
  }
  const defaultSubagentEffort = normalizeSubagentEffort(planOptions['default-subagent-effort']);
  if (!defaultSubagentEffort.ok) {
    return errorResult('AGENTIC_REVIEW_INVALID_SUBAGENT_EFFORT', defaultSubagentEffort.message, {
      default_subagent_effort: planOptions['default-subagent-effort']
    });
  }
  const roleEfforts = parseRoleEfforts(planOptions['role-efforts']);
  if (!roleEfforts.ok) {
    return errorResult('AGENTIC_REVIEW_INVALID_ROLE_EFFORTS', roleEfforts.message, { role_efforts: planOptions['role-efforts'] });
  }

  const provider = resolveProviderDescriptor(planOptions.provider, context);
  if (!provider.ok) {
    return errorResult(provider.error.code, provider.error.message, provider.error.details);
  }
  const model = { id: planOptions.model ?? provider.provider.default_model ?? DEFAULT_MODEL_ID };
  const surface = findSurface(planOptions.surface);
  if (!surface) {
    return errorResult('AGENTIC_REVIEW_SURFACE_NOT_FOUND', 'No agent surface matched the requested agentic review surface.', {
      surface: planOptions.surface,
      available_surfaces: AGENT_SURFACES.map((item) => item.id)
    });
  }

  const packageRel = artifactRelPath(artifactRootInput, 'agentic-human-review-packages', id, 'package.json');
  const planRel = artifactRelPath(artifactRootInput, 'agentic-human-review-plans', id, 'plan.json');
  const receiptRel = artifactRelPath(artifactRootInput, 'receipts', `${id}-agentic-plan.json`);
  const reviewPackage = buildReviewPackage({
    id,
    now,
    packagePath: packageRel,
    reviewIndex: reviewIndexRead.value,
    reviewIndexPath: reviewIndexRead.relativePath,
    reviewIndexHash: hashText(reviewIndexRead.text),
    reviewArtifact,
    intent: intentRead.intent,
    targetAudience: planOptions['target-audience'],
    expectedImpression: planOptions['expected-impression']
  });
  const transferPermissions = buildTransferPermissions({ reviewPackage, intent: intentRead.intent, provider: provider.provider });
  const orchestration = buildEffortOrchestration({
    effort: effort.value,
    defaultSubagentEffort: defaultSubagentEffort.value,
    roleEfforts: roleEfforts.value
  });

  const planBase = redact({
    schema_version: SCHEMA_VERSION,
    plan_version: AGENTIC_HUMAN_REVIEW_VERSION,
    type: 'agentic_human_review_plan',
    id,
    status: 'planned',
    created_at: now.toISOString(),
    plan_path: planRel,
    package_path: packageRel,
    package_hash: hashJson(reviewPackage),
    proposal_provenance: proposalRead.proposal
      ? {
          proposal_path: proposalRead.relativePath,
          proposal_hash: proposalRead.proposal.proposal_hash,
          proposal_id: proposalRead.proposal.id,
          proposal_is_not_approval: true
        }
      : null,
    source: reviewPackage.source,
    intent: intentRead.intent,
    review_scope: reviewScope(intentRead.intent),
    human_explanation: {
      plain_language_summary: explainPlan({ reviewPackage, orchestration, transferPermissions }),
      what_will_be_reviewed: reviewScope(intentRead.intent).review_targets,
      likely_reader_questions: reviewScope(intentRead.intent).likely_reader_questions,
      sub_agent_roles: orchestration.sub_agents.map((agent) => ({
        role: agent.role,
        display_name: agent.display_name,
        effort: agent.effort,
        purpose: agent.purpose
      })),
      disclosure_summary: disclosureSummary(transferPermissions),
      exact_run_command: null,
      planning_performed_only: true,
      provider_execution_requires_approval: true
    },
    review_effort: orchestration.review_effort,
    default_subagent_effort: orchestration.default_subagent_effort,
    role_efforts: orchestration.role_efforts,
    sub_agents: orchestration.sub_agents,
    rounds: orchestration.rounds,
    dogfood_metadata: buildDogfoodMetadataFromOptions(planOptions),
    transfer_permissions: transferPermissions,
    disclosure: {
      scope: 'agentic_human_review_plan',
      raw_pixels_may_be_transferred_after_flag: transferPermissions.classes.raw_pixels.required_for_execution,
      page_text_may_be_transferred_after_flag: transferPermissions.classes.page_text.required_for_execution,
      dom_summary_included: transferPermissions.classes.dom_summary.included,
      url_metadata_included: transferPermissions.classes.url.included,
      artifact_references_included: transferPermissions.classes.artifact_refs.included,
      accessibility_summary_included: transferPermissions.classes.accessibility_summary.included,
      external_evidence_transfer_authorized: false,
      provider_execution_authorized: false,
      raw_provider_response_storage_allowed: false
    },
    provider: provider.provider,
    model,
    surface: surfaceSummary(surface),
    rubric: humanReviewRubric(),
    result_contract: {
      required_output_schema: 'agentic_human_review_advisory',
      result_type: 'agentic_human_review_advisory',
      advisory_only: true,
      deterministic_findings_unchanged: true,
      gate_effect: 'none'
    },
    approval: {
      required_before_run: true,
      approval_method: 'cli_execute_with_matching_plan_hash_and_transfer_flags',
      required_plan_hash: null,
      execute_flag_required: true,
      plan_hash_flag_required: true,
      required_transfer_flags: transferPermissions.required_flags,
      mcp_execution_allowed: false
    },
    execution: {
      enabled: false,
      provider_call_performed: false,
      api_call_performed: false,
      external_evidence_transfer: false,
      raw_pixels_read: false,
      raw_pixels_transferred: false,
      page_text_transferred: false,
      dom_summary_transferred: false,
      url_metadata_transferred: false,
      artifact_refs_transferred: false,
      accessibility_summary_transferred: false,
      raw_provider_response_stored: false,
      mcp_execution_exposed: false
    },
    boundary: agenticHumanReviewBoundary({
      writes_artifacts: true,
      planning_only: true
    }),
    gate_effect: 'none'
  });
  const planHash = computePlanHash(planBase);
  const plan = redact({
    ...planBase,
    plan_hash: planHash,
    human_explanation: {
      ...planBase.human_explanation,
      exact_run_command: buildRunCommand({
        planPath: planRel,
        planHash,
        requiredFlags: transferPermissions.required_flags
      })
    },
    approval: {
      ...planBase.approval,
      required_plan_hash: planHash
    }
  });
  const planReceipt = redact({
    schema_version: SCHEMA_VERSION,
    type: 'agentic_human_review_plan_receipt',
    id,
    created_at: now.toISOString(),
    plan_path: planRel,
    package_path: packageRel,
    plan_hash: planHash,
    package_hash: plan.package_hash,
    status: 'planning_completed_execution_not_started',
    provider_call_performed: false,
    api_call_performed: false,
    external_evidence_transfer: false,
    raw_pixels_read: false,
    raw_pixels_transferred: false,
    page_text_transferred: false,
    dom_summary_transferred: false,
    url_metadata_transferred: false,
    artifact_refs_transferred: false,
    accessibility_summary_transferred: false,
    raw_provider_response_stored: false,
    credential_values_recorded: false,
    mcp_execution_exposed: false,
    gate_effect: 'none'
  });

  await writeJsonArtifact(root, ['agentic-human-review-packages', id, 'package.json'], reviewPackage);
  await writeJsonArtifact(root, ['agentic-human-review-plans', id, 'plan.json'], plan);
  await writeJsonArtifact(root, ['receipts', `${id}-agentic-plan.json`], planReceipt);

  const warnings = [...reviewArtifact.warnings, ...intentRead.warnings];
  return {
    status: 'ok',
    data: {
      agentic_human_review_plan: plan,
      agentic_human_review_package: reviewPackage,
      plan_hash: planHash,
      approval_required: true,
      boundary: plan.boundary
    },
    warnings,
    errors: [],
    artifacts: [
      artifactObject({
        type: 'agentic_human_review_plan',
        path: planRel,
        description: 'Local approval-gated agentic human review plan.'
      }),
      artifactObject({
        type: 'agentic_human_review_package',
        path: packageRel,
        description: 'Local multimodal metadata package for agentic human review.'
      }),
      artifactObject({
        type: 'agentic_human_review_plan_receipt',
        path: receiptRel,
        description: 'Content-free receipt for the planning step.'
      })
    ]
  };
}

export async function runAgenticHumanReviewRun(options = {}, context = {}) {
  if (!options.execute) {
    return errorResult('AGENTIC_REVIEW_RUN_REQUIRES_EXECUTE', 'agentic review run requires explicit --execute.', {
      execute_required: true
    });
  }
  if (!options.plan) {
    return errorResult('AGENTIC_REVIEW_PLAN_REQUIRED', 'agentic review run requires --plan <agentic-human-review-plan>.', {
      option: 'plan'
    });
  }
  if (!options['plan-hash']) {
    return errorResult('AGENTIC_REVIEW_PLAN_HASH_REQUIRED', 'agentic review run requires --plan-hash <sha256>.', {
      option: 'plan-hash'
    });
  }

  const cwd = context.cwd ?? process.cwd();
  const now = materializeNow(context.now);
  const artifactRootInput = options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT;
  const maxBytes = parseMaxBytes(options['max-bytes']);
  if (!maxBytes.ok) {
    return errorResult('AGENTIC_REVIEW_INVALID_MAX_BYTES', maxBytes.message, { max_bytes: options['max-bytes'] });
  }

  let root;
  try {
    root = await ensureArtifactRoot(cwd, artifactRootInput);
  } catch (error) {
    return errorResult('ARTIFACT_ROOT_INVALID', error.message, { artifact_root: artifactRootInput });
  }

  const planRead = await readWorkspaceJson({
    cwd,
    inputPath: options.plan,
    label: 'agentic human review plan',
    maxBytes: maxBytes.value
  });
  if (!planRead.ok) {
    return errorResult(planRead.error.code, planRead.error.message, planRead.error.details);
  }

  const validation = validateRunRequest({
    plan: planRead.value,
    planPath: planRead.relativePath,
    suppliedPlanHash: options['plan-hash'],
    options,
    context
  });
  if (!validation.ok) {
    return errorResult(validation.error.code, validation.error.message, validation.error.details);
  }

  const provider = validation.provider;
  const model = validation.model;
  const surface = validation.surface;
  const executionId = context.createId?.('agentic-human-review-execution', now) ?? createArtifactId(now, 'agentic-human-review-execution');
  const resultId = context.createId?.('agentic-human-review-result', now) ?? `${executionId}-result`;
  const executionRel = artifactRelPath(artifactRootInput, 'agentic-human-review-results', executionId, 'execution.json');
  const resultRel = artifactRelPath(artifactRootInput, 'agentic-human-review-results', executionId, 'result.json');
  const reportRel = artifactRelPath(artifactRootInput, 'reports', `${executionId}-agentic-human-review.md`);
  const approvalReceiptRel = artifactRelPath(artifactRootInput, 'receipts', `${executionId}-agentic-approval.json`);
  const runReceiptRel = artifactRelPath(artifactRootInput, 'receipts', `${executionId}-agentic-run.json`);
  const providerResult = await executeAgenticProvider({
    provider,
    model,
    surface,
    plan: planRead.value,
    planPath: planRead.relativePath,
    transferFlags: validation.transferFlags,
    execution: {
      id: executionId,
      execution_path: executionRel,
      result_path: resultRel,
      report_path: reportRel
    },
    maxBytes: maxBytes.value,
    resultId,
    now,
    context
  });
  const boundary = agenticHumanReviewBoundary({
    ...providerResult.boundary,
    writes_artifacts: true,
    planning_only: false
  });
  const execution = buildExecutionRecord({
    id: executionId,
    now,
    status: providerResult.status,
    executionPath: executionRel,
    resultPath: providerResult.ok ? resultRel : null,
    reportPath: providerResult.ok ? reportRel : null,
    approvalReceiptPath: approvalReceiptRel,
    runReceiptPath: runReceiptRel,
    plan: planRead.value,
    planPath: planRead.relativePath,
    planHash: validation.planHash,
    provider,
    model,
    surface,
    transferFlags: validation.transferFlags,
    providerResult,
    boundary
  });
  const approvalReceipt = buildApprovalReceipt({ execution, transferFlags: validation.transferFlags });
  const runReceipt = buildRunReceipt({ execution, providerResult });

  if (providerResult.ok) {
    await writeJsonArtifact(root, ['agentic-human-review-results', executionId, 'result.json'], providerResult.result);
    await writeTextArtifact(root, ['reports', `${executionId}-agentic-human-review.md`], renderAgenticReviewReport(providerResult.result));
  }
  await writeJsonArtifact(root, ['agentic-human-review-results', executionId, 'execution.json'], execution);
  await writeJsonArtifact(root, ['receipts', `${executionId}-agentic-approval.json`], approvalReceipt);
  await writeJsonArtifact(root, ['receipts', `${executionId}-agentic-run.json`], runReceipt);

  const artifacts = [
    artifactObject({
      type: 'agentic_human_review_execution',
      path: executionRel,
      description: 'Local agentic human review execution status record.'
    }),
    artifactObject({
      type: 'agentic_human_review_approval_receipt',
      path: approvalReceiptRel,
      description: 'Content-free receipt for plan hash and transfer permission approval.'
    }),
    artifactObject({
      type: 'agentic_human_review_run_receipt',
      path: runReceiptRel,
      description: 'Content-free receipt for the agentic human review run.'
    })
  ];
  if (providerResult.ok) {
    artifacts.unshift(artifactObject({
      type: 'agentic_human_review_advisory',
      path: resultRel,
      description: 'Normalized untrusted advisory result for agentic human review.'
    }));
    artifacts.push(artifactObject({
      type: 'agentic_human_review_report',
      path: reportRel,
      description: 'Plain-language Markdown report for agentic human review.'
    }));
  }

  if (!providerResult.ok) {
    return {
      status: 'error',
      data: {
        agentic_human_review_execution: execution,
        agentic_human_review_status: execution,
        boundary
      },
      warnings: providerResult.warnings,
      errors: [providerResult.error],
      artifacts
    };
  }

  return {
    status: 'ok',
    data: {
      agentic_human_review_execution: execution,
      agentic_human_review_status: execution,
      agentic_human_review_advisory: {
        id: resultId,
        path: resultRel,
        status: providerResult.result.agentic_human_review_advisory.status,
        gate_effect: 'none',
        untrusted_model_output: true
      },
      boundary
    },
    warnings: providerResult.warnings,
    errors: [],
    artifacts
  };
}

export async function runAgenticHumanReviewStatus(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const maxBytes = parseMaxBytes(options['max-bytes']);
  if (!maxBytes.ok) {
    return errorResult('AGENTIC_REVIEW_INVALID_MAX_BYTES', maxBytes.message, { max_bytes: options['max-bytes'] });
  }
  const executionRead = await readWorkspaceJson({
    cwd,
    inputPath: options.execution,
    label: 'agentic human review execution',
    maxBytes: maxBytes.value
  });
  if (!executionRead.ok) {
    return errorResult(executionRead.error.code, executionRead.error.message, executionRead.error.details);
  }
  return {
    status: 'ok',
    data: {
      agentic_human_review_execution: executionRead.value,
      agentic_human_review_status: executionRead.value,
      boundary: executionRead.value.boundary ?? agenticHumanReviewBoundary()
    },
    warnings: [],
    errors: [],
    artifacts: []
  };
}

export async function runAgenticHumanReviewList(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const artifactRootInput = options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT;
  const root = resolveArtifactRoot(cwd, artifactRootInput);
  const executions = [];
  const warnings = [];
  try {
    const entries = await readdir(path.join(root, 'agentic-human-review-results'), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const executionPath = artifactRelPath(artifactRootInput, 'agentic-human-review-results', entry.name, 'execution.json');
      const executionRead = await readWorkspaceJson({
        cwd,
        inputPath: executionPath,
        label: 'agentic human review execution',
        maxBytes: DEFAULT_MAX_BYTES
      });
      if (executionRead.ok) {
        executions.push(executionRead.value);
      } else {
        warnings.push({
          code: 'AGENTIC_REVIEW_EXECUTION_READ_FAILED',
          message: 'Could not read an agentic human review execution while listing execution status.',
          details: { execution_path: executionPath, reason: executionRead.error.message }
        });
      }
    }
  } catch {
    // Missing execution directory is a valid empty-list state.
  }

  return {
    status: 'ok',
    data: {
      agentic_human_review_executions: executions,
      summary: summarizeExecutions(executions),
      boundary: agenticHumanReviewBoundary({ read_only: true })
    },
    warnings,
    errors: [],
    artifacts: []
  };
}

export async function runAgenticHumanReviewProviderReadiness(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const maxBytes = parseMaxBytes(options['max-bytes']);
  if (!maxBytes.ok) {
    return errorResult('AGENTIC_REVIEW_INVALID_MAX_BYTES', maxBytes.message, { max_bytes: options['max-bytes'] });
  }
  let proposal = null;
  let plan = null;
  if (options.proposal) {
    const proposalRead = await readWorkspaceJson({
      cwd,
      inputPath: options.proposal,
      label: 'agentic human review proposal',
      maxBytes: maxBytes.value
    });
    if (!proposalRead.ok) {
      return errorResult(proposalRead.error.code, proposalRead.error.message, proposalRead.error.details);
    }
    const validation = validateProposalArtifact({ proposal: proposalRead.value, proposalPath: proposalRead.relativePath });
    if (!validation.ok) {
      return errorResult(validation.error.code, validation.error.message, validation.error.details);
    }
    proposal = proposalRead.value;
  }
  if (options.plan) {
    const planRead = await readWorkspaceJson({
      cwd,
      inputPath: options.plan,
      label: 'agentic human review plan',
      maxBytes: maxBytes.value
    });
    if (!planRead.ok) {
      return errorResult(planRead.error.code, planRead.error.message, planRead.error.details);
    }
    plan = planRead.value;
  }
  const providerReadiness = buildAgenticProviderReadiness({
    providerId: options.provider ?? plan?.provider?.id ?? proposal?.plan_candidate?.provider_id ?? 'all',
    surface: options.surface ?? plan?.surface?.id ?? proposal?.plan_candidate?.surface_id ?? null,
    model: options.model ?? plan?.model?.id ?? proposal?.plan_candidate?.model_id ?? null,
    proposal,
    plan,
    context,
    now: materializeNow(context.now)
  });
  if (!providerReadiness.ok) {
    return errorResult(providerReadiness.error.code, providerReadiness.error.message, providerReadiness.error.details);
  }
  return {
    status: 'ok',
    data: {
      agentic_human_review_provider_readiness: providerReadiness.readiness,
      boundary: providerReadiness.readiness.boundary
    },
    warnings: [],
    errors: [],
    artifacts: []
  };
}

export async function runAgenticHumanReviewReportQuality(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const maxBytes = parseMaxBytes(options['max-bytes']);
  if (!maxBytes.ok) {
    return errorResult('AGENTIC_REVIEW_INVALID_MAX_BYTES', maxBytes.message, { max_bytes: options['max-bytes'] });
  }
  const resultRead = await readWorkspaceJson({
    cwd,
    inputPath: options.result,
    label: 'agentic human review result',
    maxBytes: maxBytes.value
  });
  if (!resultRead.ok) {
    return errorResult(resultRead.error.code, resultRead.error.message, resultRead.error.details);
  }
  let execution = null;
  if (options.execution) {
    const executionRead = await readWorkspaceJson({
      cwd,
      inputPath: options.execution,
      label: 'agentic human review execution',
      maxBytes: maxBytes.value
    });
    if (!executionRead.ok) {
      return errorResult(executionRead.error.code, executionRead.error.message, executionRead.error.details);
    }
    execution = executionRead.value;
  }
  const quality = buildReportQuality({
    result: resultRead.value,
    resultPath: resultRead.relativePath,
    execution,
    now: materializeNow(context.now)
  });
  return {
    status: 'ok',
    data: {
      agentic_human_review_report_quality: quality,
      boundary: quality.boundary
    },
    warnings: [],
    errors: [],
    artifacts: []
  };
}

export function agenticHumanReviewBoundary(overrides = {}) {
  return {
    local_only: true,
    browser_launched: false,
    read_only: false,
    writes_artifacts: false,
    planning_only: false,
    provider_call_performed: false,
    api_call_performed: false,
    automatic_upload: false,
    external_upload: false,
    external_evidence_transfer: false,
    raw_pixels_embedded_in_json: false,
    raw_pixels_read: false,
    raw_pixels_transferred: false,
    page_text_transferred: false,
    dom_summary_transferred: false,
    url_metadata_transferred: false,
    artifact_refs_transferred: false,
    accessibility_summary_transferred: false,
    raw_dom_transferred: false,
    request_bytes: null,
    response_bytes: null,
    provider_status_code: null,
    credential_storage: 'none',
    persistent_credential_storage: false,
    credential_values_read: false,
    credential_values_recorded: false,
    raw_response_stored: false,
    raw_provider_response_stored: false,
    deterministic_findings_mutated: false,
    existing_review_mutated: false,
    metrics_finding_count_mutated: false,
    release_gate_mutated: false,
    mcp_execution_exposed: false,
    mcp_write_execute_exposed: false,
    shell_used: false,
    free_form_shell_input_accepted: false,
    dogfood_comparison_performed: false,
    report_quality_gate_effect: 'none',
    gate_effect: 'none',
    advisory_only: true,
    ...overrides
  };
}

export function isAgenticHumanReviewPackage(agentPackage) {
  const packet = agentPackage?.packet ?? agentPackage;
  return packet?.task?.type === 'agentic_human_review'
    || packet?.task?.kind === 'agentic_human_review'
    || packet?.result_contract?.required_output_schema === 'agentic_human_review_advisory'
    || packet?.package_kind === 'agentic_human_review_package'
    || packet?.type === 'agentic_human_review_proposal'
    || packet?.proposal_kind === 'agentic_human_review_proposal'
    || packet?.agentic_human_review === true;
}

function buildReviewPackage({
  id,
  now,
  packagePath,
  reviewIndex,
  reviewIndexPath,
  reviewIndexHash,
  reviewArtifact,
  intent,
  targetAudience,
  expectedImpression
}) {
  const artifactRefs = normalizeArtifactReferences(reviewIndex.artifacts);
  const review = reviewArtifact.value ?? {};
  const textSnippets = extractTextSnippets(review);
  const route = stringOrNull(review.review?.final_url ?? review.review?.input_url ?? review.final_url ?? review.input_url);
  const viewport = review.review?.viewport ?? review.environment?.viewport ?? null;
  return redact({
    schema_version: SCHEMA_VERSION,
    package_version: AGENTIC_HUMAN_REVIEW_VERSION,
    package_kind: 'agentic_human_review_package',
    id,
    created_at: now.toISOString(),
    package_path: packagePath,
    task: {
      type: 'agentic_human_review',
      intent,
      target_audience: truncateText(targetAudience ?? 'The intended viewer or user of the reviewed page, image, or screen.', 500),
      expected_impression: truncateText(expectedImpression ?? 'The reviewer should judge what a person is likely to notice, understand, trust, feel, and want to do next.', 700)
    },
    source: {
      review_artifact_index_path: reviewIndexPath,
      review_artifact_index_hash: reviewIndexHash,
      review_id: stringOrNull(reviewIndex.id ?? review.review?.id),
      review_mode: stringOrNull(reviewIndex.mode ?? review.review?.mode),
      route,
      viewport,
      artifact_count: artifactRefs.length,
      evidence_classes: normalizeStringArray(reviewIndex.evidence_classes)
    },
    visual_evidence: {
      reference_count: artifactRefs.filter(isVisualReference).length,
      references: artifactRefs.filter(isVisualReference).slice(0, MAX_EVIDENCE_REFS),
      raw_pixels_embedded_in_json: false,
      raw_pixels_read_by_planning: false
    },
    content_evidence: {
      text_snippet_count: textSnippets.length,
      text_snippets: textSnippets,
      page_text_included_as_bounded_summary: textSnippets.length > 0,
      raw_dom_included: false,
      raw_report_body_included: false
    },
    semantic_evidence: {
      accessibility_summary: summarizeAccessibility(review),
      information_architecture_summary: summarizeInformationArchitecture(review),
      next_action_summary: summarizeNextActions(review)
    },
    artifact_references: artifactRefs.slice(0, MAX_EVIDENCE_REFS),
    existing_review_state: {
      findings_count: Number(review.metrics?.finding_count ?? review.findings?.length ?? 0),
      local_release_gate: stringOrNull(
        review.quality_signals?.release_readiness?.local_gate
        ?? review.action_plan?.release_gate
        ?? reviewIndex.triage?.local_release_gate
      ),
      deterministic_review_path: reviewArtifact.relativePath,
      deterministic_review_hash: reviewArtifact.hash,
      deterministic_review_mutation_allowed: false
    },
    disclosure: {
      raw_pixels_embedded_in_json: false,
      raw_pixels_read_by_planning: false,
      page_text_summary_included: textSnippets.length > 0,
      dom_summary_included: false,
      url_metadata_included: Boolean(route),
      local_artifact_references_included: artifactRefs.length > 0,
      external_evidence_transfer_authorized: false,
      provider_execution_authorized: false
    },
    boundary: agenticHumanReviewBoundary({
      planning_only: true,
      writes_artifacts: true
    })
  });
}

function buildTransferPermissions({ reviewPackage, intent, provider = null }) {
  const intentWantsText = /\b(copy|content|text|read|readability|comprehension|meaning|tone|文章|文言|読解|内容)\b/i.test(intent);
  const rawPixelsRequired = Number(reviewPackage.visual_evidence?.reference_count ?? 0) > 0;
  const pageTextRequired = intentWantsText || Number(reviewPackage.content_evidence?.text_snippet_count ?? 0) > 0;
  const providerExternal = provider?.external_evidence_transfer === true;
  const providerClasses = new Set(Array.isArray(provider?.transferable_evidence_classes)
    ? provider.transferable_evidence_classes
    : TRANSFER_CLASSES.map((item) => item.id));
  const classRecords = {};
  for (const transferClass of TRANSFER_CLASSES) {
    const included = transferClass.id === 'raw_pixels'
      ? rawPixelsRequired
      : transferClass.id === 'page_text'
        ? pageTextRequired
        : transferClass.id === 'url'
          ? Boolean(reviewPackage.source?.route)
          : transferClass.id === 'artifact_refs'
            ? Number(reviewPackage.source?.artifact_count ?? 0) > 0
          : transferClass.id === 'accessibility_summary'
              ? true
              : false;
    const requiredForExecution = providerExternal
      ? included && providerClasses.has(transferClass.id)
      : transferClass.id === 'raw_pixels'
        ? rawPixelsRequired
        : transferClass.id === 'page_text'
          ? pageTextRequired
          : false;
    classRecords[transferClass.id] = {
      id: transferClass.id,
      label: transferClass.label,
      included,
      flag: transferClass.flag,
      required_for_execution: requiredForExecution,
      transfer_performed_by_planning: false,
      transfer_performed_by_fake_provider: false,
      external_provider_transfer_class: providerExternal && providerClasses.has(transferClass.id)
    };
  }
  const requiredFlags = TRANSFER_CLASSES
    .filter((item) => classRecords[item.id].required_for_execution)
    .map((item) => item.flag);
  return {
    exact_match_required: true,
    required_flags: requiredFlags,
    optional_flags_allowed: [],
    classes: classRecords,
    default_external_transfer: providerExternal,
    mcp_transfer_allowed: false
  };
}

function buildEffortOrchestration({ effort, defaultSubagentEffort, roleEfforts }) {
  const roles = rolesForEffort(effort);
  const roleEffortMap = new Map(roleEfforts.map((item) => [item.role, item.effort]));
  const subAgents = roles.map((role, index) => ({
    id: `${role.id}-${index + 1}`,
    role: role.id,
    display_name: role.display_name,
    effort: roleEffortMap.get(role.id) ?? role.default_effort ?? defaultSubagentEffort,
    purpose: role.purpose,
    round: role.round ?? 1,
    independent_review: role.independent_review !== false
  }));
  return {
    review_effort: {
      mode: effort,
      role_count: subAgents.length,
      rounds: Math.max(...subAgents.map((agent) => agent.round), 1),
      synthesis_required: true,
      critic_or_verifier_included: subAgents.some((agent) => ['critic_reviewer', 'verification_reviewer'].includes(agent.role))
    },
    default_subagent_effort: defaultSubagentEffort,
    role_efforts: roleEfforts,
    rounds: [...new Set(subAgents.map((agent) => agent.round))].sort((left, right) => left - right),
    sub_agents: subAgents
  };
}

function rolesForEffort(effort) {
  if (effort === 'quick') {
    return [
      role('general_reviewer', 'General Human Reviewer', 'First impression, obvious UI issues, obvious text/comprehension issues.')
    ];
  }
  if (effort === 'deep') {
    return [
      role('visual_reviewer', 'Visual Reviewer', 'Visual quality, visual perception, and layout clarity.', 'high'),
      role('ux_reviewer', 'UX Reviewer', 'Flow, navigation, interaction clarity, and next action clarity.', 'high'),
      role('content_reviewer', 'Content Reviewer', 'Copy, meaning, tone, and reading comprehension.', 'high'),
      role('audience_reviewer', 'Audience Reviewer', 'Likely audience reaction, first impression, emotional reception, and trust.', 'high'),
      role('accessibility_reviewer', 'Accessibility and Comprehension Reviewer', 'Accessibility basics, cognitive load, and comprehension risks.', 'high'),
      role('risk_reviewer', 'Risk Reviewer', 'Misleading content, credibility risk, and owner-decision needs.', 'high'),
      role('synthesis_agent', 'Synthesis Agent', 'Consensus, dissent, and prioritized improvement suggestions.', 'high')
    ];
  }
  if (effort === 'xhigh') {
    return [
      role('visual_reviewer', 'Visual Reviewer', 'Visual quality, visual perception, and layout clarity.', 'xhigh', 1),
      role('ux_reviewer', 'UX Reviewer', 'Flow, navigation, interaction clarity, and next action clarity.', 'xhigh', 1),
      role('content_reviewer', 'Content Reviewer', 'Copy, meaning, tone, and reading comprehension.', 'xhigh', 1),
      role('audience_reviewer', 'Audience Reviewer', 'Likely audience reaction, first impression, emotional reception, and trust.', 'xhigh', 1),
      role('accessibility_reviewer', 'Accessibility and Comprehension Reviewer', 'Accessibility basics, cognitive load, and comprehension risks.', 'xhigh', 1),
      role('risk_reviewer', 'Risk Reviewer', 'Misleading content, credibility risk, and owner-decision needs.', 'xhigh', 1),
      role('critic_reviewer', 'Critic Reviewer', 'Challenge weak conclusions and look for contradictions.', 'xhigh', 2),
      role('verification_reviewer', 'Verification Reviewer', 'Re-check evidence references, uncertainty, and missed issues.', 'xhigh', 2),
      role('synthesis_agent', 'Synthesis Agent', 'Consensus, dissent, and prioritized improvement suggestions.', 'xhigh', 3)
    ];
  }
  return [
    role('visual_reviewer', 'Visual and UX Reviewer', 'First impression, visual clarity, layout, and interaction clarity.'),
    role('content_reviewer', 'Content and Copy Reviewer', 'Screen text, meaning, tone, and reading comprehension.'),
    role('accessibility_reviewer', 'Accessibility and Comprehension Reviewer', 'Accessibility basics, cognitive load, and comprehension risks.')
  ];
}

function role(id, displayName, purpose, defaultEffort = DEFAULT_SUBAGENT_EFFORT, round = 1) {
  return { id, display_name: displayName, purpose, default_effort: defaultEffort, round };
}

async function executeAgenticProvider({ provider, model, surface, plan, planPath, transferFlags, execution, maxBytes, resultId, now, context }) {
  if (provider.id === 'fake-agent') {
    return fakeAgenticReviewResult({ provider, model, surface, plan, planPath, transferFlags, execution, resultId, now });
  }
  if (provider.id === 'injected-runner') {
    return injectedAgenticReviewResult({ provider, model, surface, plan, planPath, transferFlags, execution, resultId, now, context });
  }
  if (provider.transport === 'provider_api' || provider.external_evidence_transfer === true) {
    const reviewPackageRead = await readReviewPackageForExecution({
      cwd: context.cwd ?? process.cwd(),
      plan,
      maxBytes: maxBytes ?? DEFAULT_MAX_BYTES
    });
    if (!reviewPackageRead.ok) {
      return providerFailure({
        status: 'blocked',
        code: reviewPackageRead.error.code,
        message: reviewPackageRead.error.message,
        details: reviewPackageRead.error.details,
        provider
      });
    }
    const providerResult = await executeAgenticHumanReviewApiProvider({
      provider,
      model,
      surface,
      plan,
      planPath,
      reviewPackage: reviewPackageRead.value,
      transferFlags,
      execution,
      context
    });
    if (!providerResult.ok) {
      return providerResult;
    }
    return {
      ok: true,
      status: providerResult.status,
      result: normalizeAgenticAdvisoryResult({
        id: resultId,
        now,
        plan,
        planPath,
        input: providerResult.input,
        provider,
        model,
        surface,
        transferFlags,
        execution,
        boundary: providerResult.boundary
      }),
      boundary: providerResult.boundary,
      warnings: providerResult.warnings
    };
  }
  return providerFailure({
    status: 'blocked',
    code: 'AGENTIC_REVIEW_PROVIDER_UNKNOWN',
    message: 'No implemented agentic human review provider adapter is available for the requested provider.',
    details: { provider: provider.id },
    provider
  });
}

function fakeAgenticReviewResult({ provider, model, surface, plan, planPath, transferFlags, execution, resultId, now }) {
  const input = {
    summary: 'Deterministic fake agentic human review completed from the approved local plan and metadata package.',
    subjective_perception: {
      first_impression: ['A person is likely to first scan the visible hierarchy, the main message, and the clearest next action.'],
      emotional_reception: ['The review should treat emotional reception as advisory judgment that needs owner review.'],
      trust_and_credibility: ['Trust depends on whether the content, visual structure, and evidence references support the intended message.'],
      cognitive_load: ['Cognitive load should be checked from text density, navigation clarity, and terminology risk.'],
      likely_user_questions: plan.review_scope?.likely_reader_questions ?? []
    },
    readability_comprehension: {
      scanability: 'mixed',
      reading_load: 'medium',
      terminology_risk: [],
      meaning_gaps: [],
      next_action_clarity: []
    },
    role_opinions: (plan.sub_agents ?? []).slice(0, MAX_ROLE_OPINIONS).map((agent) => ({
      role: agent.role,
      display_name: agent.display_name,
      effort: agent.effort,
      round: agent.round,
      summary: `${agent.display_name} reviewed the approved package metadata for ${plan.intent}.`,
      findings: [],
      uncertainties: ['Fake provider output is deterministic scaffolding; use a real approved provider or local runner for substantive judgment.'],
      confidence: { evidence: 'medium', judgment: 'low', implementation: 'inconclusive' }
    })),
    findings: [],
    strengths: ['The review workflow keeps subjective judgment separate from deterministic findings.'],
    improvement_suggestions: ['Run an approved human or provider review when substantive visual, textual, and audience judgment is required.'],
    owner_decision_requests: [{
      id: 'agentic-owner-review-required',
      question: 'Does the owner approve acting on this advisory result after reviewing the evidence and uncertainty?',
      reason: 'Agentic human review is advisory-only and cannot change release gates by itself.'
    }]
  };
  const boundary = providerBoundary({
    provider,
    providerCallPerformed: true,
    apiCallPerformed: false,
    externalEvidenceTransfer: false
  });
  return {
    ok: true,
    status: 'completed',
    result: normalizeAgenticAdvisoryResult({
      id: resultId,
      now,
      plan,
      planPath,
      input,
      provider,
      model,
      surface,
      transferFlags,
      execution,
      boundary
    }),
    boundary,
    warnings: []
  };
}

async function injectedAgenticReviewResult({ provider, model, surface, plan, planPath, transferFlags, execution, resultId, now, context }) {
  const runner = runnerForContext(context, provider.id, model.id);
  if (!runner) {
    return providerFailure({
      status: 'blocked',
      code: 'AGENTIC_REVIEW_RUNNER_NOT_CONFIGURED',
      message: 'The requested injected agentic review runner is not configured in the execution context.',
      details: {
        provider: provider.id,
        model: model.id,
        shell_used: false,
        free_form_shell_input_accepted: false
      },
      provider
    });
  }
  let input;
  try {
    input = await runner({
      schema_version: SCHEMA_VERSION,
      type: 'agentic_human_review_request',
      plan: redact(plan),
      plan_path: planPath,
      transfer_permissions: transferFlags,
      provider,
      model,
      surface,
      execution
    });
  } catch (error) {
    return providerFailure({
      status: 'failed',
      code: 'AGENTIC_REVIEW_RUNNER_FAILED',
      message: 'The configured agentic review runner failed before returning advisory JSON.',
      details: {
        provider: provider.id,
        model: model.id,
        reason: error.message,
        shell_used: false,
        raw_provider_response_stored: false
      },
      provider,
      providerCallPerformed: true
    });
  }
  const boundary = providerBoundary({
    provider,
    providerCallPerformed: true,
    apiCallPerformed: false,
    externalEvidenceTransfer: false
  });
  return {
    ok: true,
    status: 'completed',
    result: normalizeAgenticAdvisoryResult({
      id: resultId,
      now,
      plan,
      planPath,
      input: input?.agentic_human_review_advisory ?? input ?? {},
      provider,
      model,
      surface,
      transferFlags,
      execution,
      boundary
    }),
    boundary,
    warnings: []
  };
}

function normalizeAgenticAdvisoryResult({ id, now, plan, planPath, input, provider, model, surface, transferFlags, execution, boundary }) {
  const roleOpinions = normalizeRoleOpinions(input.role_opinions, plan.sub_agents);
  const findings = normalizeFindings(input.findings ?? input.agentic_human_review_findings, id);
  const ownerDecisions = normalizeOwnerDecisionRequests(input.owner_decision_requests);
  const safeInputSummary = secretSafeText(input.summary ?? 'Agentic human review completed with advisory-only output.', 1200);
  const claims = buildReviewClaims({ resultId: id, input, findings, roleOpinions });
  const roundRecords = buildRoundRecords({ plan, roleOpinions });
  const critiqueRecords = buildCritiqueRecords({ plan, claims, roleOpinions });
  const rebuttalRecords = buildRebuttalRecords({ critiqueRecords });
  const integrationRecord = buildIntegrationRecord({ roleOpinions, findings, critiqueRecords, input });
  const dogfoodMetadata = buildDogfoodMetadata({ plan, resultId: id });
  const qualityPreview = buildReportQualityFromParts({
    roleOpinions,
    findings,
    ownerDecisions,
    claims,
    critiqueRecords,
    integrationRecord
  });
  const status = findings.length > 0 || ownerDecisions.length > 0 || roleOpinions.length > 0
    ? 'owner_review_recommended'
    : 'completed';
  const advisory = {
    schema_version: SCHEMA_VERSION,
    id,
    status,
    source: 'agentic_human_review',
    imported_at: now.toISOString(),
    plan_id: plan.id,
    plan_path: planPath,
    plan_hash: plan.plan_hash,
    review_effort: plan.review_effort?.mode ?? DEFAULT_REVIEW_EFFORT,
    default_subagent_effort: plan.default_subagent_effort ?? DEFAULT_SUBAGENT_EFFORT,
    role_efforts: plan.role_efforts ?? [],
    gate_effect: 'none',
    untrusted_model_output: true,
    existing_review_mutated: false,
    deterministic_findings_unchanged: true
  };
  return redact({
    schema_version: SCHEMA_VERSION,
    id,
    result_type: 'agentic_human_review_advisory',
    agentic_human_review_advisory: advisory,
    non_engineer_summary: {
      plain_language_scope: plan.human_explanation?.plain_language_summary ?? safeInputSummary,
      likely_first_impression: secretSafeText(input.non_engineer_summary?.likely_first_impression ?? input.likely_first_impression ?? 'Reviewers should inspect what a person notices first and whether the page or image communicates the intended message.', 900),
      main_takeaway: safeInputSummary,
      top_concerns: normalizeStringArray(input.non_engineer_summary?.top_concerns ?? input.top_concerns).slice(0, 8),
      top_strengths: normalizeStringArray(input.non_engineer_summary?.top_strengths ?? input.strengths).slice(0, 8),
      owner_decisions_needed: ownerDecisions.map((item) => item.question)
    },
    subjective_perception: {
      first_impression: normalizeStringArray(input.subjective_perception?.first_impression),
      emotional_reception: normalizeStringArray(input.subjective_perception?.emotional_reception),
      trust_and_credibility: normalizeStringArray(input.subjective_perception?.trust_and_credibility),
      cognitive_load: normalizeStringArray(input.subjective_perception?.cognitive_load),
      likely_user_questions: normalizeStringArray(input.subjective_perception?.likely_user_questions)
    },
    readability_comprehension: {
      scanability: normalizeEnum(input.readability_comprehension?.scanability, ['clear', 'mixed', 'hard'], 'mixed'),
      reading_load: normalizeEnum(input.readability_comprehension?.reading_load, ['low', 'medium', 'high'], 'medium'),
      terminology_risk: normalizeStringArray(input.readability_comprehension?.terminology_risk),
      meaning_gaps: normalizeStringArray(input.readability_comprehension?.meaning_gaps),
      next_action_clarity: normalizeStringArray(input.readability_comprehension?.next_action_clarity)
    },
    role_opinions: roleOpinions,
    role_execution_records: buildRoleExecutionRecords({ plan, roleOpinions, boundary }),
    review_claims: claims,
    round_records: roundRecords,
    critique_records: critiqueRecords,
    rebuttal_records: rebuttalRecords,
    integration_record: integrationRecord,
    dogfood_metadata: dogfoodMetadata,
    report_quality: qualityPreview,
    consensus_summary: buildConsensusSummary({ roleOpinions, findings, input }),
    dissent_summary: buildDissentSummary({ roleOpinions, input }),
    agentic_human_review_findings: findings,
    agentic_human_review_action_plan: {
      next_actions: normalizeStringArray(input.agentic_human_review_action_plan?.next_actions ?? input.improvement_suggestions).slice(0, 12),
      suggested_fixes: normalizeStringArray(input.suggested_fixes ?? input.improvement_suggestions).slice(0, 12),
      owner_review_required: true,
      gate_effect: 'none'
    },
    agentic_human_review_readiness: {
      status,
      advisory_only: true,
      blocking_release_gate: false,
      deterministic_findings_unchanged: true,
      metrics_finding_count_unchanged: true,
      existing_review_mutated: false,
      gate_effect: 'none'
    },
    owner_decision_requests: ownerDecisions,
    provider: {
      id: provider.id,
      kind: provider.kind,
      transport: provider.transport
    },
    model: { id: model.id },
    surface: surfaceSummary(surface),
    transfer_permissions: transferFlags,
    execution: {
      id: execution.id,
      execution_path: execution.execution_path,
      result_path: execution.result_path,
      report_path: execution.report_path,
      provider_call_performed: boundary.provider_call_performed,
      api_call_performed: boundary.api_call_performed,
      external_evidence_transfer: boundary.external_evidence_transfer,
      raw_pixels_transferred: boundary.raw_pixels_transferred,
      page_text_transferred: boundary.page_text_transferred,
      dom_summary_transferred: boundary.dom_summary_transferred,
      url_metadata_transferred: boundary.url_metadata_transferred,
      artifact_refs_transferred: boundary.artifact_refs_transferred,
      accessibility_summary_transferred: boundary.accessibility_summary_transferred,
      raw_provider_response_stored: false
    },
    boundary: agenticHumanReviewBoundary(boundary)
  });
}

function buildExecutionRecord({
  id,
  now,
  status,
  executionPath,
  resultPath,
  reportPath,
  approvalReceiptPath,
  runReceiptPath,
  plan,
  planPath,
  planHash,
  provider,
  model,
  surface,
  transferFlags,
  providerResult,
  boundary
}) {
  return redact({
    schema_version: SCHEMA_VERSION,
    execution_version: AGENTIC_HUMAN_REVIEW_VERSION,
    id,
    status,
    mode: 'agentic_human_review_run',
    created_at: now.toISOString(),
    completed_at: status === 'completed' ? now.toISOString() : null,
    execution_path: executionPath,
    result_path: resultPath,
    report_path: reportPath,
    approval_receipt_path: approvalReceiptPath,
    run_receipt_path: runReceiptPath,
    plan_id: plan.id,
    plan_path: planPath,
    plan_hash: planHash,
    package_path: plan.package_path,
    package_hash: plan.package_hash,
    provider,
    model,
    surface: surfaceSummary(surface),
    transfer_permissions: transferFlags,
    steps: {
      plan_validation: {
        status: 'completed',
        plan_hash_matched: true,
        exact_run_command_matched: true
      },
      approval: {
        status: 'completed',
        execute_flag_received: true,
        transfer_flags_matched: true,
        mcp_execution_exposed: false
      },
      provider_execution: {
        status,
        provider_call_performed: boundary.provider_call_performed,
        api_call_performed: boundary.api_call_performed,
        external_evidence_transfer: boundary.external_evidence_transfer,
        request_bytes: boundary.request_bytes,
        response_bytes: boundary.response_bytes,
        provider_status_code: boundary.provider_status_code,
        raw_provider_response_stored: false
      },
      normalize: {
        status: providerResult.ok ? 'completed' : 'blocked',
        expected_schema: 'agentic_human_review_advisory',
        raw_provider_response_stored: false
      }
    },
    dashboard_handoff: {
      status_command: `${CLI_NAME} agentic review status --execution ${executionPath} --json`,
      list_command: `${CLI_NAME} agentic review list --json`,
      rerun_command: buildRunCommand({
        planPath,
        planHash,
        requiredFlags: transferFlags.required_flags
      }),
      next_safe_action: providerResult.ok
        ? 'Review the advisory report with the product owner before acting on subjective findings.'
        : 'Inspect the execution error and rerun only after the plan hash and provider boundary are valid.'
    },
    gate_effect: 'none',
    provider_call_performed: boundary.provider_call_performed,
    api_call_performed: boundary.api_call_performed,
    external_evidence_transfer: boundary.external_evidence_transfer,
    automatic_upload: false,
    credential_storage: 'none',
    persistent_credential_storage: false,
    credential_values_recorded: false,
    raw_response_stored: false,
    raw_provider_response_stored: false,
    raw_pixels_read: false,
    raw_pixels_transferred: boundary.raw_pixels_transferred,
    page_text_transferred: boundary.page_text_transferred,
    dom_summary_transferred: boundary.dom_summary_transferred,
    url_metadata_transferred: boundary.url_metadata_transferred,
    artifact_refs_transferred: boundary.artifact_refs_transferred,
    accessibility_summary_transferred: boundary.accessibility_summary_transferred,
    request_bytes: boundary.request_bytes,
    response_bytes: boundary.response_bytes,
    provider_status_code: boundary.provider_status_code,
    deterministic_findings_mutated: false,
    metrics_finding_count_mutated: false,
    existing_review_mutated: false,
    release_gate_mutated: false,
    mcp_execution_exposed: false,
    boundary
  });
}

function validateRunRequest({ plan, planPath, suppliedPlanHash, options, context }) {
  if (plan.type !== 'agentic_human_review_plan' || plan.result_contract?.required_output_schema !== 'agentic_human_review_advisory') {
    return validationError('AGENTIC_REVIEW_PLAN_CONTRACT_MISMATCH', 'agentic review run requires an agentic_human_review_plan artifact.', {
      plan: planPath,
      type: plan.type ?? null,
      required_output_schema: plan.result_contract?.required_output_schema ?? null
    });
  }
  const recomputedHash = computePlanHash(plan);
  if (plan.plan_hash !== recomputedHash) {
    return validationError('AGENTIC_REVIEW_PLAN_MODIFIED', 'The agentic review plan content no longer matches its stored plan_hash.', {
      plan: planPath,
      stored_plan_hash: plan.plan_hash ?? null,
      recomputed_plan_hash: recomputedHash
    });
  }
  if (suppliedPlanHash !== plan.plan_hash) {
    return validationError('AGENTIC_REVIEW_PLAN_HASH_MISMATCH', 'The supplied --plan-hash does not match the approved plan hash.', {
      plan: planPath,
      supplied_plan_hash: suppliedPlanHash,
      expected_plan_hash: plan.plan_hash
    });
  }

  const requiredFlags = normalizeStringArray(plan.transfer_permissions?.required_flags);
  const suppliedFlags = collectTransferFlags(options);
  const suppliedFlagNames = Object.entries(suppliedFlags)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .sort();
  const requiredFlagNames = [...requiredFlags].sort();
  if (JSON.stringify(suppliedFlagNames) !== JSON.stringify(requiredFlagNames)) {
    return validationError('AGENTIC_REVIEW_TRANSFER_FLAGS_MISMATCH', 'agentic review run requires transfer flags to exactly match the approved plan.', {
      required_flags: requiredFlagNames,
      supplied_flags: suppliedFlagNames
    });
  }

  const expectedCommand = buildRunCommand({
    planPath,
    planHash: plan.plan_hash,
    requiredFlags
  });
  if (plan.human_explanation?.exact_run_command !== expectedCommand) {
    return validationError('AGENTIC_REVIEW_PLAN_COMMAND_MISMATCH', 'The plan run command preview does not match the current plan path, hash, and required transfer flags.', {
      plan: planPath,
      expected_command: expectedCommand
    });
  }

  const provider = resolveProviderDescriptor(options.provider ?? plan.provider?.id, context);
  if (!provider.ok) {
    return validationError(provider.error.code, provider.error.message, provider.error.details);
  }
  const model = { id: options.model ?? plan.model?.id ?? provider.provider.default_model ?? DEFAULT_MODEL_ID };
  const surface = findSurface(options.surface ?? plan.surface?.id);
  if (!surface) {
    return validationError('AGENTIC_REVIEW_SURFACE_NOT_FOUND', 'No agent surface matched the requested agentic review surface.', {
      surface: options.surface ?? plan.surface?.id,
      available_surfaces: AGENT_SURFACES.map((item) => item.id)
    });
  }
  const mismatches = [
    ['provider', plan.provider?.id, provider.provider.id],
    ['model', plan.model?.id, model.id],
    ['surface', plan.surface?.id, surface.id]
  ].filter(([, expected, actual]) => expected && expected !== actual);
  if (mismatches.length > 0) {
    return validationError('AGENTIC_REVIEW_PLAN_RUN_MISMATCH', 'The requested provider, model, or surface does not match the approved plan.', {
      mismatches: mismatches.map(([field, expected, actual]) => ({ field, expected, actual }))
    });
  }
  return {
    ok: true,
    planHash: recomputedHash,
    provider: provider.provider,
    model,
    surface,
    transferFlags: {
      exact_match_required: true,
      required_flags: requiredFlagNames,
      supplied_flags: suppliedFlagNames,
      classes: plan.transfer_permissions?.classes ?? {},
      approved_by_cli_execute: true,
      mcp_transfer_allowed: false
    }
  };
}

function buildApprovalReceipt({ execution, transferFlags }) {
  return redact({
    schema_version: SCHEMA_VERSION,
    type: 'agentic_human_review_approval_receipt',
    id: `${execution.id}-approval`,
    created_at: execution.created_at,
    execution_id: execution.id,
    plan_path: execution.plan_path,
    plan_hash: execution.plan_hash,
    approved_by: 'cli_execute_with_matching_plan_hash_and_transfer_flags',
    execute_flag_received: true,
    transfer_flags: transferFlags.supplied_flags,
    provider_id: execution.provider?.id ?? null,
    model_id: execution.model?.id ?? null,
    surface_id: execution.surface?.id ?? null,
    external_evidence_transfer_authorized: execution.external_evidence_transfer,
    required_transfer_flags: transferFlags.required_flags,
    supplied_transfer_flags: transferFlags.supplied_flags,
    mcp_execution_exposed: false,
    gate_effect: 'none'
  });
}

function buildRunReceipt({ execution, providerResult }) {
  return redact({
    schema_version: SCHEMA_VERSION,
    type: 'agentic_human_review_run_receipt',
    id: `${execution.id}-run`,
    created_at: execution.completed_at ?? execution.created_at,
    execution_id: execution.id,
    execution_path: execution.execution_path,
    result_path: execution.result_path,
    report_path: execution.report_path,
    plan_path: execution.plan_path,
    plan_hash: execution.plan_hash,
    status: execution.status,
    provider_id: execution.provider?.id ?? null,
    model_id: execution.model?.id ?? null,
    provider_call_performed: execution.provider_call_performed,
    api_call_performed: execution.api_call_performed,
    external_evidence_transfer: execution.external_evidence_transfer,
    automatic_upload: false,
    credential_values_recorded: false,
    raw_pixels_read: false,
    raw_pixels_transferred: execution.raw_pixels_transferred,
    page_text_transferred: execution.page_text_transferred,
    dom_summary_transferred: execution.dom_summary_transferred,
    url_metadata_transferred: execution.url_metadata_transferred,
    artifact_refs_transferred: execution.artifact_refs_transferred,
    accessibility_summary_transferred: execution.accessibility_summary_transferred,
    request_bytes: execution.request_bytes,
    response_bytes: execution.response_bytes,
    provider_status_code: execution.provider_status_code,
    raw_response_stored: false,
    raw_provider_response_stored: false,
    existing_review_mutated: false,
    deterministic_findings_mutated: false,
    metrics_finding_count_mutated: false,
    release_gate_mutated: false,
    mcp_execution_exposed: false,
    provider_error_code: providerResult.error?.code ?? null,
    gate_effect: 'none'
  });
}

function renderAgenticReviewReport(result) {
  const summary = result.non_engineer_summary ?? {};
  const advisory = result.agentic_human_review_advisory ?? {};
  const lines = [
    '# Agentic Human Review',
    '',
    `Status: ${advisory.status ?? 'unknown'}`,
    `Plan: ${advisory.plan_path ?? ''}`,
    '',
    '## Plain-Language Review',
    '',
    summary.main_takeaway ?? '',
    '',
    '## Likely First Impression',
    '',
    summary.likely_first_impression ?? '',
    '',
    '## Viewer Feeling And Comprehension',
    '',
    ...normalizeStringArray(result.subjective_perception?.emotional_reception).map((item) => `- ${item}`),
    ...normalizeStringArray(result.subjective_perception?.trust_and_credibility).map((item) => `- ${item}`),
    ...normalizeStringArray(result.readability_comprehension?.meaning_gaps).map((item) => `- ${item}`),
    '',
    '## Role Opinions',
    '',
    ...normalizeRoleOpinions(result.role_opinions).map((item) => `- ${item.display_name}: ${item.summary}`),
    '',
    '## Evidence Claims',
    '',
    ...normalizeReviewClaimsForReport(result.review_claims).map((item) => `- ${item.claim}`),
    '',
    '## Consensus',
    '',
    ...normalizeStringArray(result.consensus_summary?.corroborated_findings).map((item) => `- ${item}`),
    '',
    '## Dissent And Uncertainty',
    '',
    ...normalizeStringArray(result.dissent_summary?.contradictions).map((item) => `- ${item}`),
    ...normalizeStringArray(result.dissent_summary?.minority_opinions).map((item) => `- ${item}`),
    '',
    '## Suggested Fixes',
    '',
    ...normalizeStringArray(result.agentic_human_review_action_plan?.suggested_fixes).map((item) => `- ${item}`),
    '',
    '## Owner Decisions',
    '',
    ...normalizeOwnerDecisionRequests(result.owner_decision_requests).map((item) => `- ${item.question}`),
    '',
    '## Report Quality',
    '',
    `Completeness: ${result.report_quality?.completeness_score ?? 'unknown'}`,
    `Evidence coverage: ${result.report_quality?.evidence_coverage_score ?? 'unknown'}`,
    `Verification coverage: ${result.report_quality?.verification_score ?? 'unknown'}`,
    '',
    '## Boundary',
    '',
    '- Advisory-only result.',
    '- Deterministic findings, metrics, release gates, and existing review artifacts are unchanged.',
    '- Raw provider responses and credential values are not stored.'
  ];
  return `${lines.join('\n')}\n`;
}

function computePlanHash(plan) {
  return hashText(canonicalStringify(hashablePlan(plan)));
}

function computeProposalHash(proposal) {
  return hashText(canonicalStringify(hashableProposal(proposal)));
}

function hashablePlan(plan) {
  const clone = structuredCloneSafe(plan);
  delete clone.plan_hash;
  if (clone.approval) {
    delete clone.approval.required_plan_hash;
  }
  if (clone.human_explanation) {
    delete clone.human_explanation.exact_run_command;
  }
  return clone;
}

function hashableProposal(proposal) {
  const clone = structuredCloneSafe(proposal);
  delete clone.proposal_hash;
  return clone;
}

function buildRunCommand({ planPath, planHash, requiredFlags }) {
  const parts = [
    CLI_NAME,
    'agentic',
    'review',
    'run',
    '--plan',
    planPath,
    '--plan-hash',
    planHash,
    ...[...requiredFlags].sort().map((flag) => `--${flag}`),
    '--execute',
    '--json'
  ];
  return parts.join(' ');
}

function buildPlanCommand({ proposalPath, reviewIndexPath }) {
  return buildPlanCommandArgs({ proposalPath, reviewIndexPath }).join(' ');
}

function buildPlanCommandArgs({ proposalPath, reviewIndexPath }) {
  const parts = [
    CLI_NAME,
    'agentic',
    'review',
    'plan'
  ];
  if (proposalPath) {
    parts.push('--proposal', proposalPath);
  }
  if (reviewIndexPath) {
    parts.push('--review-index', reviewIndexPath);
  }
  parts.push('--json');
  return parts;
}

function collectTransferFlags(options) {
  return Object.fromEntries(TRANSFER_CLASSES.map((item) => [item.flag, options[item.flag] === true]));
}

function resolveProviderDescriptor(providerId, context = {}) {
  return resolveAgenticHumanReviewProvider({ providerId: providerId ?? DEFAULT_PROVIDER_ID, context });
}

function findSurface(id) {
  const surfaceId = id ?? AGENT_SURFACES[0]?.id;
  return AGENT_SURFACES.find((surface) => surface.id === surfaceId) ?? null;
}

async function resolveIntent(options, context) {
  const fallback = 'Review this page, image, or screen as a human would, including first impression, visual clarity, text comprehension, trust, emotional reception, and improvement suggestions.';
  if (options.intent) {
    return { ok: true, intent: truncateText(options.intent, 1200), warnings: [] };
  }
  if (!options.input) {
    return { ok: true, intent: fallback, warnings: [] };
  }
  if (options.input === '-') {
    return { ok: true, intent: truncateText(context.stdinText ?? fallback, 1200), warnings: [] };
  }
  if (String(options.input).startsWith('@')) {
    const fileRead = await readWorkspaceText({
      cwd: context.cwd ?? process.cwd(),
      inputPath: String(options.input).slice(1),
      label: 'agentic review intent',
      maxBytes: 32 * 1024
    });
    if (!fileRead.ok) {
      return { ok: false, error: fileRead.error };
    }
    return { ok: true, intent: truncateText(fileRead.text, 1200), warnings: [] };
  }
  return { ok: true, intent: truncateText(options.input, 1200), warnings: [] };
}

async function resolveProposalBrief(options, context) {
  const fallback = 'Review this page, image, or screen as a human would, including first impression, visual clarity, text comprehension, trust, emotional reception, and improvement suggestions.';
  if (options.brief) {
    return { ok: true, brief: truncateText(options.brief, 2000), inputMode: 'brief', warnings: [] };
  }
  if (options.intent) {
    return { ok: true, brief: truncateText(options.intent, 2000), inputMode: 'intent', warnings: [] };
  }
  if (options.input === '-') {
    return { ok: true, brief: truncateText(context.stdinText ?? fallback, 2000), inputMode: 'stdin', warnings: [] };
  }
  if (options.input && String(options.input).startsWith('@')) {
    const fileRead = await readWorkspaceText({
      cwd: context.cwd ?? process.cwd(),
      inputPath: String(options.input).slice(1),
      label: 'agentic review proposal brief',
      maxBytes: MAX_PROPOSAL_BRIEF_BYTES
    });
    if (!fileRead.ok) {
      return { ok: false, error: fileRead.error };
    }
    return {
      ok: true,
      brief: truncateText(fileRead.text, 2000),
      inputMode: 'file',
      warnings: []
    };
  }
  if (options.input) {
    return { ok: true, brief: truncateText(options.input, 2000), inputMode: 'input', warnings: [] };
  }
  return {
    ok: true,
    brief: fallback,
    inputMode: 'fallback',
    warnings: [{
      code: 'AGENTIC_REVIEW_PROPOSAL_BRIEF_DEFAULTED',
      message: 'No explicit proposal brief was provided, so the default human-review request was used.',
      details: {}
    }]
  };
}

function inferReviewEffort(brief) {
  const text = String(brief ?? '').toLowerCase();
  if (/\b(xhigh|highest|multi-round|multiple round|critic|rebuttal|反論|検証|精査|複数ラウンド)\b/.test(text)) {
    return 'xhigh';
  }
  if (/\b(deep|thorough|comprehensive|detailed|詳しく|網羅)\b/.test(text)) {
    return 'deep';
  }
  if (/\b(quick|brief|first impression|短時間|第一印象)\b/.test(text)) {
    return 'quick';
  }
  return DEFAULT_REVIEW_EFFORT;
}

function buildStructuredIntent({ brief, targetAudience, expectedImpression }) {
  return {
    purpose: truncateText(brief, 1200),
    target_audience: truncateText(targetAudience ?? 'The intended viewer or user of the reviewed page, image, or screen.', 500),
    expected_impression: truncateText(expectedImpression ?? 'Judge what a person is likely to notice, understand, trust, feel, and want to do next.', 700),
    requested_review_areas: RUBRIC_AREAS.map((area) => ({
      id: area,
      subjective_judgment_allowed: true,
      evidence_required: true
    }))
  };
}

async function buildProposalReviewIndexPreview({ cwd, options, artifactRootInput, id, now, brief, maxBytes, provider }) {
  if (!options['review-index']) {
    const emptyPackage = {
      visual_evidence: { reference_count: 0 },
      content_evidence: { text_snippet_count: 0 },
      source: { route: null, artifact_count: 0 }
    };
    return {
      ok: true,
      reviewIndexPath: null,
      reviewIndexHash: null,
      transferPermissions: buildTransferPermissions({ reviewPackage: emptyPackage, intent: brief, provider }),
      warnings: [{
        code: 'AGENTIC_REVIEW_PROPOSAL_REVIEW_INDEX_MISSING',
        message: 'The proposal was created without a review index; planning will require --review-index later.',
        details: {}
      }]
    };
  }
  const reviewIndexRead = await readWorkspaceJson({
    cwd,
    inputPath: options['review-index'],
    label: 'review artifact index',
    maxBytes
  });
  if (!reviewIndexRead.ok) {
    return { ok: false, error: reviewIndexRead.error };
  }
  const reviewArtifact = await readLinkedReviewArtifact({
    cwd,
    reviewIndex: reviewIndexRead.value,
    maxBytes
  });
  const packageRel = artifactRelPath(artifactRootInput, 'agentic-human-review-packages', id, 'package.json');
  const reviewPackage = buildReviewPackage({
    id,
    now,
    packagePath: packageRel,
    reviewIndex: reviewIndexRead.value,
    reviewIndexPath: reviewIndexRead.relativePath,
    reviewIndexHash: hashText(reviewIndexRead.text),
    reviewArtifact,
    intent: brief,
    targetAudience: options['target-audience'],
    expectedImpression: options['expected-impression']
  });
  return {
    ok: true,
    reviewIndexPath: reviewIndexRead.relativePath,
    reviewIndexHash: hashText(reviewIndexRead.text),
    transferPermissions: buildTransferPermissions({ reviewPackage, intent: brief, provider }),
    warnings: reviewArtifact.warnings
  };
}

function buildDogfoodMetadataFromOptions(options) {
  const hasDogfood = options['case-id']
    || options['fixture-id']
    || options['baseline-snapshot-hash']
    || options['comparison-run-id'];
  if (!hasDogfood) {
    return null;
  }
  return {
    case_id: stringOrNull(options['case-id']),
    fixture_id: stringOrNull(options['fixture-id']),
    baseline_snapshot_hash: stringOrNull(options['baseline-snapshot-hash']),
    comparison_run_id: stringOrNull(options['comparison-run-id']),
    repeatable_quality_check: true,
    gate_effect: 'none'
  };
}

function explainProposal({ structuredIntent, orchestration, transferPermissions }) {
  return [
    `This proposal turns the request into a candidate review with ${orchestration.review_effort.role_count} reviewer role(s).`,
    `It will ask reviewers to judge first impression, UI/UX, visual understanding, written content, comprehension, trust, feeling, risks, and improvements.`,
    `No provider execution is authorized by this proposal; agentic review plan must create a fresh plan hash before any run.`,
    `Potential transfer flags are: ${transferPermissions.required_flags.map((flag) => `--${flag}`).join(', ') || 'none'}.`,
    `Purpose: ${truncateText(structuredIntent.purpose, 260)}`
  ].join(' ');
}

async function readProposalForPlan({ cwd, options, maxBytes }) {
  if (!options.proposal) {
    return { ok: true, proposal: null, relativePath: null };
  }
  const proposalRead = await readWorkspaceJson({
    cwd,
    inputPath: options.proposal,
    label: 'agentic human review proposal',
    maxBytes
  });
  if (!proposalRead.ok) {
    return { ok: false, error: proposalRead.error };
  }
  const validation = validateProposalArtifact({ proposal: proposalRead.value, proposalPath: proposalRead.relativePath });
  if (!validation.ok) {
    return validation;
  }
  return {
    ok: true,
    proposal: proposalRead.value,
    relativePath: proposalRead.relativePath
  };
}

function validateProposalArtifact({ proposal, proposalPath }) {
  if (proposal?.type !== 'agentic_human_review_proposal') {
    return validationError('AGENTIC_REVIEW_PROPOSAL_CONTRACT_MISMATCH', 'agentic review plan --proposal requires an agentic_human_review_proposal artifact.', {
      proposal: proposalPath,
      type: proposal?.type ?? null
    });
  }
  const recomputedHash = computeProposalHash(proposal);
  if (proposal.proposal_hash !== recomputedHash) {
    return validationError('AGENTIC_REVIEW_PROPOSAL_MODIFIED', 'The agentic review proposal content no longer matches its stored proposal_hash.', {
      proposal: proposalPath,
      stored_proposal_hash: proposal.proposal_hash ?? null,
      recomputed_proposal_hash: recomputedHash
    });
  }
  if (proposal.approval?.provider_execution_authorized === true || proposal.approval?.transfer_authorized === true) {
    return validationError('AGENTIC_REVIEW_PROPOSAL_APPROVAL_INVALID', 'A proposal cannot authorize provider execution or evidence transfer.', {
      proposal: proposalPath
    });
  }
  return { ok: true };
}

function applyProposalDefaults(options, proposal) {
  if (!proposal) {
    return { ...options };
  }
  const candidate = proposal.plan_candidate ?? {};
  return {
    ...options,
    'review-index': options['review-index'] ?? candidate.review_index_path ?? proposal.source_request?.review_index_path ?? undefined,
    intent: options.intent ?? candidate.intent ?? proposal.structured_intent?.purpose,
    effort: options.effort ?? options['review-effort'] ?? candidate.effort,
    'review-effort': options['review-effort'] ?? options.effort ?? candidate.effort,
    'default-subagent-effort': options['default-subagent-effort'] ?? candidate.default_subagent_effort,
    'role-efforts': options['role-efforts'] ?? serializeRoleEfforts(candidate.role_efforts),
    provider: options.provider ?? candidate.provider_id,
    model: options.model ?? candidate.model_id,
    surface: options.surface ?? candidate.surface_id,
    'target-audience': options['target-audience'] ?? candidate.target_audience,
    'expected-impression': options['expected-impression'] ?? candidate.expected_impression,
    'case-id': options['case-id'] ?? candidate.dogfood_metadata?.case_id,
    'fixture-id': options['fixture-id'] ?? candidate.dogfood_metadata?.fixture_id,
    'baseline-snapshot-hash': options['baseline-snapshot-hash'] ?? candidate.dogfood_metadata?.baseline_snapshot_hash,
    'comparison-run-id': options['comparison-run-id'] ?? candidate.dogfood_metadata?.comparison_run_id
  };
}

function serializeRoleEfforts(roleEfforts) {
  if (!Array.isArray(roleEfforts) || roleEfforts.length === 0) {
    return undefined;
  }
  return roleEfforts
    .map((item) => `${item.role}:${item.effort}`)
    .join(',');
}

async function readReviewPackageForExecution({ cwd, plan, maxBytes }) {
  const packageRead = await readWorkspaceJson({
    cwd,
    inputPath: plan.package_path,
    label: 'agentic human review package',
    maxBytes
  });
  if (!packageRead.ok) {
    return { ok: false, error: packageRead.error };
  }
  const packageHash = hashJson(packageRead.value);
  if (plan.package_hash && packageHash !== plan.package_hash) {
    return {
      ok: false,
      error: {
        code: 'AGENTIC_REVIEW_PACKAGE_MODIFIED',
        message: 'The agentic review package content no longer matches the package hash stored in the plan.',
        details: {
          package_path: packageRead.relativePath,
          stored_package_hash: plan.package_hash,
          recomputed_package_hash: packageHash
        }
      }
    };
  }
  return {
    ok: true,
    value: packageRead.value,
    relativePath: packageRead.relativePath
  };
}

async function readLinkedReviewArtifact({ cwd, reviewIndex, maxBytes }) {
  const artifacts = normalizeArtifactReferences(reviewIndex.artifacts);
  const reviewRef = artifacts.find((artifact) => ['review', 'image_review'].includes(artifact.type));
  if (!reviewRef?.path) {
    return {
      ok: false,
      value: null,
      relativePath: null,
      hash: null,
      warnings: [{
        code: 'AGENTIC_REVIEW_SOURCE_REVIEW_NOT_FOUND',
        message: 'The review artifact index did not include a readable review artifact reference.',
        details: {}
      }]
    };
  }
  const read = await readWorkspaceJson({ cwd, inputPath: reviewRef.path, label: 'review artifact', maxBytes });
  if (!read.ok) {
    return {
      ok: false,
      value: null,
      relativePath: reviewRef.path,
      hash: null,
      warnings: [{
        code: 'AGENTIC_REVIEW_SOURCE_REVIEW_READ_FAILED',
        message: 'Could not read the linked review artifact while building the agentic review package.',
        details: { review_artifact_path: reviewRef.path, reason: read.error.message }
      }]
    };
  }
  return {
    ok: true,
    value: read.value,
    relativePath: read.relativePath,
    hash: hashText(read.text),
    warnings: []
  };
}

async function readWorkspaceJson({ cwd, inputPath, label, maxBytes }) {
  const textRead = await readWorkspaceText({ cwd, inputPath, label, maxBytes });
  if (!textRead.ok) {
    return textRead;
  }
  try {
    return {
      ok: true,
      value: JSON.parse(textRead.text),
      text: textRead.text,
      relativePath: textRead.relativePath
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'AGENTIC_REVIEW_INVALID_JSON',
        message: `The ${label} was not valid JSON.`,
        details: { input: inputPath, reason: error.message }
      }
    };
  }
}

async function readWorkspaceText({ cwd, inputPath, label, maxBytes }) {
  const resolved = await resolveWorkspacePath({ cwd, inputPath, label });
  if (!resolved.ok) {
    return resolved;
  }
  try {
    const stats = await lstat(resolved.absolutePath);
    if (!stats.isFile()) {
      return {
        ok: false,
        error: {
          code: 'AGENTIC_REVIEW_INPUT_NOT_FILE',
          message: `The ${label} path must be a regular file.`,
          details: { input: inputPath }
        }
      };
    }
    if (stats.size > maxBytes) {
      return {
        ok: false,
        error: {
          code: 'AGENTIC_REVIEW_INPUT_TOO_LARGE',
          message: `The ${label} is larger than the configured max bytes.`,
          details: { input: inputPath, bytes: stats.size, max_bytes: maxBytes }
        }
      };
    }
    const text = await readFile(resolved.absolutePath, 'utf8');
    return { ok: true, text, relativePath: resolved.relativePath };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error.code === 'ENOENT' ? 'AGENTIC_REVIEW_INPUT_NOT_FOUND' : 'AGENTIC_REVIEW_INPUT_READ_FAILED',
        message: `Could not read the ${label}.`,
        details: { input: inputPath, reason: error.message }
      }
    };
  }
}

async function resolveWorkspacePath({ cwd, inputPath, label }) {
  const value = String(inputPath ?? '').trim();
  if (!value || value === '-') {
    return {
      ok: false,
      error: {
        code: 'AGENTIC_REVIEW_INPUT_REQUIRED',
        message: `${label} requires a workspace-relative file path.`,
        details: { input: inputPath }
      }
    };
  }
  if (value.startsWith('@')) {
    return {
      ok: false,
      error: {
        code: 'AGENTIC_REVIEW_INPUT_INDIRECTION_UNSUPPORTED',
        message: `${label} does not accept @file indirection at this boundary.`,
        details: { input: inputPath }
      }
    };
  }
  if (path.isAbsolute(value) || value.includes('\0') || value.split(/[\\/]+/).includes('..')) {
    return {
      ok: false,
      error: {
        code: 'AGENTIC_REVIEW_INPUT_OUTSIDE_WORKSPACE',
        message: `${label} must stay inside the current workspace.`,
        details: { input: inputPath }
      }
    };
  }
  try {
    const root = await realpath(cwd);
    const candidate = path.resolve(cwd, value);
    const resolved = await realpath(candidate);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      return {
        ok: false,
        error: {
          code: 'AGENTIC_REVIEW_INPUT_OUTSIDE_WORKSPACE',
          message: `${label} resolved outside the current workspace.`,
          details: { input: inputPath }
        }
      };
    }
    return { ok: true, absolutePath: resolved, relativePath: value.replace(/\\/g, '/') };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error.code === 'ENOENT' ? 'AGENTIC_REVIEW_INPUT_NOT_FOUND' : 'AGENTIC_REVIEW_INPUT_RESOLUTION_FAILED',
        message: `Could not resolve the ${label}.`,
        details: { input: inputPath, reason: error.message }
      }
    };
  }
}

function normalizeArtifactReferences(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.slice(0, MAX_EVIDENCE_REFS).map((artifact) => ({
    type: stringOrNull(artifact?.type),
    path: stringOrNull(artifact?.path),
    description: stringOrNull(artifact?.description),
    content_included: false,
    local_reference: true
  }));
}

function isVisualReference(artifact) {
  const type = String(artifact?.type ?? '');
  const artifactPath = String(artifact?.path ?? '');
  return type.includes('visual') || type.includes('screenshot') || type.includes('image') || artifactPath.includes('/visual-evidence/') || artifactPath.includes('/screenshots/');
}

function extractTextSnippets(review) {
  const snippets = [];
  for (const finding of Array.isArray(review.findings) ? review.findings : []) {
    const text = truncateText(finding.message ?? finding.summary ?? finding.recommendation ?? '', 400);
    if (text) {
      snippets.push({ source: 'finding', text, content_included: true });
    }
  }
  for (const item of Array.isArray(review.content_ux_findings) ? review.content_ux_findings : []) {
    const text = truncateText(item.message ?? item.summary ?? '', 400);
    if (text) {
      snippets.push({ source: 'content_ux_finding', text, content_included: true });
    }
  }
  const reviewSummary = truncateText(review.review_advisory?.summary ?? review.image_review?.advisory?.next_step ?? '', 400);
  if (reviewSummary) {
    snippets.push({ source: 'review_summary', text: reviewSummary, content_included: true });
  }
  return snippets.slice(0, MAX_TEXT_SNIPPETS);
}

function summarizeAccessibility(review) {
  const accessibility = review.quality_signals?.accessibility ?? review.quality_signals?.accessibility_structure ?? {};
  return {
    status: stringOrNull(accessibility.status) ?? 'unknown',
    summary: truncateText(accessibility.summary ?? 'Accessibility and comprehension should be reviewed by the agentic review roles.', 500)
  };
}

function summarizeInformationArchitecture(review) {
  return {
    status: stringOrNull(review.quality_signals?.visual_hierarchy?.status ?? review.content_ux_readiness?.status) ?? 'unknown',
    summary: truncateText(review.content_ux_review_brief?.summary ?? review.review_advisory?.summary ?? 'Information architecture should be assessed from visible hierarchy, text, route, and next-action clarity.', 500)
  };
}

function summarizeNextActions(review) {
  const nextActions = normalizeStringArray(review.action_plan?.next_actions ?? review.content_ux_action_plan?.next_actions);
  return {
    count: nextActions.length,
    items: nextActions.slice(0, 8)
  };
}

function humanReviewRubric() {
  return {
    schema_version: SCHEMA_VERSION,
    rubric_version: AGENTIC_HUMAN_REVIEW_VERSION,
    output_schema: 'agentic_human_review_advisory',
    areas: RUBRIC_AREAS.map((area) => ({
      id: area,
      required: true,
      evidence_required: true,
      subjective_judgment_allowed: true,
      uncertainty_required: true
    })),
    confidence_model: ['low', 'medium', 'high', 'inconclusive'],
    advisory_only: true,
    gate_effect: 'none'
  };
}

function reviewScope(intent) {
  return {
    intent,
    review_targets: [
      'first impression',
      'visual perception and UI/UX clarity',
      'readability and screen text comprehension',
      'copy tone and meaning',
      'trust, credibility, and emotional reception',
      'information architecture and next action clarity',
      'accessibility and cognitive-load risks',
      'misleading-content or owner-decision risks',
      'strengths and improvement suggestions'
    ],
    likely_reader_questions: [
      'What would a person notice first?',
      'What would they understand or misunderstand?',
      'What would they trust, doubt, or feel uncertain about?',
      'What should be improved before acting on the page or image?'
    ]
  };
}

function explainPlan({ reviewPackage, orchestration, transferPermissions }) {
  return [
    `This plan asks ${orchestration.review_effort.role_count} reviewer role(s) to inspect the target like a human reviewer.`,
    `The review covers first impression, visual clarity, text comprehension, subjective audience reaction, trust, risks, and improvement suggestions.`,
    `It uses local artifact references from ${reviewPackage.source.artifact_count} artifact(s) and keeps execution disabled until the matching plan hash, --execute, and required transfer flags are supplied.`,
    `Planning did not call a provider, read raw pixels, transfer page text, or change deterministic review output.`
  ].join(' ');
}

function disclosureSummary(transferPermissions) {
  return TRANSFER_CLASSES.map((item) => ({
    class: item.id,
    label: item.label,
    included_in_package_metadata: transferPermissions.classes[item.id].included,
    required_flag_for_run: transferPermissions.classes[item.id].required_for_execution ? `--${item.flag}` : null,
    mcp_transfer_allowed: false
  }));
}

function normalizeRoleOpinions(values, plannedAgents = []) {
  const inputValues = Array.isArray(values) && values.length > 0
    ? values
    : plannedAgents.map((agent) => ({
        role: agent.role,
        display_name: agent.display_name,
        effort: agent.effort,
        round: agent.round,
        summary: `${agent.display_name} did not return a separate opinion.`,
        findings: [],
        uncertainties: ['No role-specific output was returned.'],
        confidence: { evidence: 'inconclusive', judgment: 'inconclusive', implementation: 'inconclusive' }
      }));
  return inputValues.slice(0, MAX_ROLE_OPINIONS).map((value, index) => ({
    role: truncateText(value.role ?? plannedAgents[index]?.role ?? `reviewer_${index + 1}`, 120),
    display_name: truncateText(value.display_name ?? plannedAgents[index]?.display_name ?? 'Reviewer', 160),
    effort: normalizeSubagentEffort(value.effort).value ?? DEFAULT_SUBAGENT_EFFORT,
    round: Number.isFinite(Number(value.round)) ? Number(value.round) : 1,
    summary: secretSafeText(value.summary ?? 'Role-specific advisory review.', 900),
    findings: normalizeFindings(value.findings, `${value.role ?? 'role'}-${index + 1}`).slice(0, 8),
    uncertainties: normalizeStringArray(value.uncertainties),
    confidence: normalizeConfidence(value.confidence)
  }));
}

function normalizeFindings(values, resultId) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.slice(0, MAX_FINDINGS).map((finding, index) => ({
    id: truncateText(finding?.id ?? `${resultId}-agentic-finding-${index + 1}`, 120),
    category: truncateText(finding?.category ?? 'human_review_advisory', 120),
    severity: SEVERITIES.has(finding?.severity) ? finding.severity : 'info',
    confidence: normalizeConfidence(finding?.confidence),
    message: secretSafeText(finding?.message ?? finding?.summary ?? 'Agentic human review advisory finding.', 700),
    recommendation: secretSafeText(finding?.recommendation ?? 'Review this advisory item with the owner before implementation.', 900),
    evidence_refs: normalizeArtifactReferences(finding?.evidence_refs ?? finding?.artifacts),
    subjective_judgment: finding?.subjective_judgment !== false,
    owner_decision_required: finding?.owner_decision_required !== false,
    source: 'agentic_human_review_advisory',
    untrusted_text: true,
    gate_effect: 'none'
  }));
}

function normalizeOwnerDecisionRequests(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.slice(0, 25).map((value, index) => ({
    id: truncateText(value?.id ?? `agentic-owner-decision-${index + 1}`, 120),
    question: secretSafeText(value?.question ?? value?.message ?? 'Owner decision required.', 600),
    reason: secretSafeText(value?.reason ?? '', 700),
    gate_effect: 'none',
    untrusted_text: true
  }));
}

function buildConsensusSummary({ roleOpinions, findings, input }) {
  return {
    agreement_count: Number(input.consensus_summary?.agreement_count ?? (roleOpinions.length > 1 ? 1 : 0)),
    corroborated_findings: normalizeStringArray(input.consensus_summary?.corroborated_findings).slice(0, 10),
    shared_positive_observations: normalizeStringArray(input.consensus_summary?.shared_positive_observations ?? input.strengths).slice(0, 10),
    shared_risks: normalizeStringArray(input.consensus_summary?.shared_risks).slice(0, 10),
    finding_count: findings.length
  };
}

function buildDissentSummary({ roleOpinions, input }) {
  return {
    disagreement_count: Number(input.dissent_summary?.disagreement_count ?? 0),
    contradictions: normalizeStringArray(input.dissent_summary?.contradictions).slice(0, 10),
    minority_opinions: normalizeStringArray(input.dissent_summary?.minority_opinions).slice(0, 10),
    owner_decision_required: roleOpinions.length > 1
  };
}

function buildRoleExecutionRecords({ plan, roleOpinions, boundary }) {
  const opinionByRole = new Map(roleOpinions.map((opinion) => [opinion.role, opinion]));
  return (plan.sub_agents ?? []).slice(0, MAX_ROLE_OPINIONS).map((agent) => {
    const opinion = opinionByRole.get(agent.role);
    return {
      role: agent.role,
      display_name: agent.display_name,
      planned_effort: agent.effort,
      round: agent.round,
      status: opinion ? 'reported' : 'missing_output',
      independent_review: agent.independent_review !== false,
      confidence: opinion?.confidence ?? { evidence: 'inconclusive', judgment: 'inconclusive', implementation: 'inconclusive' },
      finding_count: opinion?.findings?.length ?? 0,
      provider_call_performed: boundary.provider_call_performed,
      api_call_performed: boundary.api_call_performed,
      gate_effect: 'none'
    };
  });
}

function buildReviewClaims({ resultId, input, findings, roleOpinions }) {
  const claimValues = Array.isArray(input.review_claims) ? input.review_claims : [];
  const explicitClaims = claimValues.slice(0, 25).map((item, index) => ({
    id: truncateText(item?.id ?? `${resultId}-claim-${index + 1}`, 120),
    claim: secretSafeText(item?.claim ?? item?.message ?? 'Agentic review claim.', 700),
    evidence_refs: normalizeArtifactReferences(item?.evidence_refs ?? item?.artifacts),
    supported_by_roles: normalizeStringArray(item?.supported_by_roles),
    confidence: normalizeConfidence(item?.confidence),
    subjective_judgment: item?.subjective_judgment !== false,
    gate_effect: 'none'
  }));
  const findingClaims = findings.slice(0, 25 - explicitClaims.length).map((finding) => ({
    id: `${finding.id}-claim`,
    claim: finding.message,
    evidence_refs: finding.evidence_refs,
    supported_by_roles: roleOpinions.map((opinion) => opinion.role).slice(0, 5),
    confidence: finding.confidence,
    subjective_judgment: finding.subjective_judgment,
    gate_effect: 'none'
  }));
  return [...explicitClaims, ...findingClaims];
}

function buildRoundRecords({ plan, roleOpinions }) {
  const plannedRounds = Array.isArray(plan.rounds) && plan.rounds.length > 0
    ? plan.rounds
    : [...new Set(roleOpinions.map((item) => item.round))];
  return plannedRounds.map((round) => {
    const opinions = roleOpinions.filter((opinion) => Number(opinion.round) === Number(round));
    return {
      round: Number(round),
      planned_roles: (plan.sub_agents ?? []).filter((agent) => Number(agent.round) === Number(round)).map((agent) => agent.role),
      reported_roles: opinions.map((opinion) => opinion.role),
      status: opinions.length > 0 ? 'reported' : 'missing_output',
      gate_effect: 'none'
    };
  });
}

function buildCritiqueRecords({ plan, claims, roleOpinions }) {
  const criticRoles = (plan.sub_agents ?? []).filter((agent) => ['critic_reviewer', 'verification_reviewer'].includes(agent.role));
  const weakClaimCount = claims.filter((claim) => claim.evidence_refs.length === 0 || claim.confidence.evidence === 'low').length;
  if (criticRoles.length === 0) {
    return [{
      role: 'implicit_quality_check',
      status: 'not_planned',
      critique: 'No dedicated critic or verification role was planned for this effort mode.',
      weak_claim_count: weakClaimCount,
      gate_effect: 'none'
    }];
  }
  return criticRoles.map((agent) => {
    const opinion = roleOpinions.find((item) => item.role === agent.role);
    return {
      role: agent.role,
      status: opinion ? 'reported' : 'missing_output',
      critique: opinion?.summary ?? 'Dedicated critique role did not return separate output.',
      weak_claim_count: weakClaimCount,
      gate_effect: 'none'
    };
  });
}

function buildRebuttalRecords({ critiqueRecords }) {
  return critiqueRecords.map((record, index) => ({
    id: `rebuttal-${index + 1}`,
    critique_role: record.role,
    status: record.status === 'reported' ? 'integrated' : 'not_available',
    response: record.status === 'reported'
      ? 'The synthesis should account for this critique before owner action.'
      : 'No separate rebuttal was available; owner review should treat this as residual uncertainty.',
    gate_effect: 'none'
  }));
}

function buildIntegrationRecord({ roleOpinions, findings, critiqueRecords, input }) {
  return {
    status: 'integrated',
    summary: secretSafeText(input.integration_record?.summary ?? input.consensus_summary?.summary ?? 'Role opinions were normalized into one advisory-only report for owner review.', 900),
    role_count: roleOpinions.length,
    finding_count: findings.length,
    critique_count: critiqueRecords.length,
    unresolved_uncertainties: roleOpinions.flatMap((opinion) => opinion.uncertainties).slice(0, 12),
    owner_review_required: true,
    gate_effect: 'none'
  };
}

function buildDogfoodMetadata({ plan, resultId }) {
  const metadata = plan.dogfood_metadata ?? null;
  return {
    enabled: Boolean(metadata),
    result_id: resultId,
    case_id: metadata?.case_id ?? null,
    fixture_id: metadata?.fixture_id ?? null,
    baseline_snapshot_hash: metadata?.baseline_snapshot_hash ?? null,
    comparison_run_id: metadata?.comparison_run_id ?? null,
    input_set_hash: hashText(canonicalStringify({
      plan_id: plan.id,
      plan_hash: plan.plan_hash,
      package_hash: plan.package_hash,
      dogfood_metadata: metadata
    })),
    advisory_only: true,
    gate_effect: 'none'
  };
}

function buildReportQuality({ result, resultPath, execution, now }) {
  const quality = buildReportQualityFromParts({
    roleOpinions: normalizeRoleOpinions(result.role_opinions),
    findings: normalizeFindings(result.agentic_human_review_findings, result.id ?? 'agentic-result'),
    ownerDecisions: normalizeOwnerDecisionRequests(result.owner_decision_requests),
    claims: normalizeReviewClaims(result.review_claims),
    critiqueRecords: Array.isArray(result.critique_records) ? result.critique_records : [],
    integrationRecord: result.integration_record ?? null
  });
  return redact({
    schema_version: SCHEMA_VERSION,
    type: 'agentic_human_review_report_quality',
    generated_at: now.toISOString(),
    result_path: resultPath,
    result_id: result.id ?? null,
    execution_id: execution?.id ?? null,
    ...quality,
    boundary: agenticHumanReviewBoundary({
      read_only: true,
      planning_only: false,
      report_quality_gate_effect: 'none'
    })
  });
}

function buildReportQualityFromParts({ roleOpinions, findings, ownerDecisions, claims, critiqueRecords, integrationRecord }) {
  const completenessScore = clampScore(
    (roleOpinions.length > 0 ? 0.25 : 0)
    + (claims.length > 0 || findings.length > 0 ? 0.25 : 0)
    + (ownerDecisions.length > 0 ? 0.2 : 0)
    + (integrationRecord ? 0.15 : 0)
    + (critiqueRecords.length > 0 ? 0.15 : 0)
  );
  const evidenceCoverageScore = clampScore(
    claims.length === 0
      ? 0
      : claims.filter((claim) => claim.evidence_refs?.length > 0 || claim.confidence?.evidence !== 'low').length / claims.length
  );
  const verificationScore = clampScore(
    critiqueRecords.some((record) => record.status === 'reported' || record.status === 'integrated') ? 1 : 0.35
  );
  return {
    completeness_score: completenessScore,
    evidence_coverage_score: evidenceCoverageScore,
    verification_score: verificationScore,
    role_count: roleOpinions.length,
    finding_count: findings.length,
    claim_count: claims.length,
    owner_decision_count: ownerDecisions.length,
    quality_warnings: reportQualityWarnings({ roleOpinions, claims, ownerDecisions, critiqueRecords }),
    advisory_only: true,
    gate_effect: 'none'
  };
}

function reportQualityWarnings({ roleOpinions, claims, ownerDecisions, critiqueRecords }) {
  const warnings = [];
  if (roleOpinions.length === 0) {
    warnings.push('No role-specific opinions were present.');
  }
  if (claims.length === 0) {
    warnings.push('No explicit evidence claims were present.');
  }
  if (ownerDecisions.length === 0) {
    warnings.push('No owner decision requests were present.');
  }
  if (!critiqueRecords.some((record) => record.status === 'reported' || record.status === 'integrated')) {
    warnings.push('No dedicated critique or verification output was present.');
  }
  return warnings;
}

function normalizeReviewClaims(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.slice(0, 25).map((value, index) => ({
    id: truncateText(value?.id ?? `claim-${index + 1}`, 120),
    claim: secretSafeText(value?.claim ?? value?.message ?? 'Agentic review claim.', 700),
    evidence_refs: normalizeArtifactReferences(value?.evidence_refs ?? value?.artifacts),
    supported_by_roles: normalizeStringArray(value?.supported_by_roles),
    confidence: normalizeConfidence(value?.confidence),
    subjective_judgment: value?.subjective_judgment !== false,
    gate_effect: 'none'
  }));
}

function normalizeReviewClaimsForReport(values) {
  return normalizeReviewClaims(values).slice(0, 12);
}

function clampScore(value) {
  if (!Number.isFinite(Number(value))) {
    return 0;
  }
  return Math.max(0, Math.min(1, Number(value)));
}

function providerFailure({
  status,
  code,
  message,
  details,
  provider,
  providerCallPerformed = false,
  apiCallPerformed = false,
  externalEvidenceTransfer = false
}) {
  const boundary = providerBoundary({
    provider,
    providerCallPerformed,
    apiCallPerformed,
    externalEvidenceTransfer
  });
  return {
    ok: false,
    status,
    error: { code, message, details: redact(details ?? {}) },
    boundary,
    warnings: []
  };
}

function providerBoundary({
  provider,
  providerCallPerformed,
  apiCallPerformed,
  externalEvidenceTransfer,
  requestBytes = null,
  responseBytes = null,
  statusCode = null,
  rawPixelsTransferred = false,
  pageTextTransferred = false,
  domSummaryTransferred = false,
  urlMetadataTransferred = false,
  artifactRefsTransferred = false,
  accessibilitySummaryTransferred = false
}) {
  return agenticHumanReviewBoundary(providerBoundaryRecord({
    provider,
    providerCallPerformed: Boolean(providerCallPerformed),
    apiCallPerformed: Boolean(apiCallPerformed),
    externalEvidenceTransfer: Boolean(externalEvidenceTransfer),
    requestBytes,
    responseBytes,
    statusCode,
    rawPixelsTransferred,
    pageTextTransferred,
    domSummaryTransferred,
    urlMetadataTransferred,
    artifactRefsTransferred,
    accessibilitySummaryTransferred
  }));
}

function runnerForContext(context, providerId, modelId) {
  if (typeof context.agenticHumanReviewRunner === 'function') {
    return context.agenticHumanReviewRunner;
  }
  if (typeof context.agenticReviewRunner === 'function') {
    return context.agenticReviewRunner;
  }
  const runners = context.agenticHumanReviewRunners ?? context.agenticReviewRunners;
  if (!runners || typeof runners !== 'object') {
    return null;
  }
  return runners[modelId] ?? runners[providerId] ?? null;
}

function summarizeExecutions(executions) {
  const summary = {
    total: executions.length,
    completed: 0,
    failed: 0,
    blocked: 0,
    provider_call_performed: false,
    api_call_performed: false,
    external_evidence_transfer: false,
    raw_pixels_transferred: false,
    page_text_transferred: false,
    dom_summary_transferred: false,
    url_metadata_transferred: false,
    artifact_refs_transferred: false,
    accessibility_summary_transferred: false,
    raw_provider_response_stored: false,
    existing_review_mutated: false,
    mcp_execution_exposed: false
  };
  for (const execution of executions) {
    if (Object.hasOwn(summary, execution.status)) {
      summary[execution.status] += 1;
    }
    summary.provider_call_performed ||= Boolean(execution.provider_call_performed);
    summary.api_call_performed ||= Boolean(execution.api_call_performed);
    summary.external_evidence_transfer ||= Boolean(execution.external_evidence_transfer);
    summary.raw_pixels_transferred ||= Boolean(execution.raw_pixels_transferred);
    summary.page_text_transferred ||= Boolean(execution.page_text_transferred);
    summary.dom_summary_transferred ||= Boolean(execution.dom_summary_transferred);
    summary.url_metadata_transferred ||= Boolean(execution.url_metadata_transferred);
    summary.artifact_refs_transferred ||= Boolean(execution.artifact_refs_transferred);
    summary.accessibility_summary_transferred ||= Boolean(execution.accessibility_summary_transferred);
    summary.raw_provider_response_stored ||= Boolean(execution.raw_provider_response_stored);
    summary.existing_review_mutated ||= Boolean(execution.existing_review_mutated);
    summary.mcp_execution_exposed ||= Boolean(execution.mcp_execution_exposed);
  }
  return summary;
}

function normalizeReviewEffort(value) {
  const effort = String(value ?? DEFAULT_REVIEW_EFFORT).trim() || DEFAULT_REVIEW_EFFORT;
  if (!REVIEW_EFFORTS.has(effort)) {
    return { ok: false, message: `Unsupported review effort: ${effort}. Expected one of: ${[...REVIEW_EFFORTS].join(', ')}.` };
  }
  return { ok: true, value: effort };
}

function normalizeSubagentEffort(value) {
  const effort = String(value ?? DEFAULT_SUBAGENT_EFFORT).trim() || DEFAULT_SUBAGENT_EFFORT;
  if (!SUBAGENT_EFFORTS.has(effort)) {
    return { ok: false, message: `Unsupported sub-agent effort: ${effort}. Expected one of: ${[...SUBAGENT_EFFORTS].join(', ')}.` };
  }
  return { ok: true, value: effort };
}

function parseRoleEfforts(value) {
  if (!value) {
    return { ok: true, value: [] };
  }
  const text = String(value).trim();
  if (text && !text.startsWith('[') && !text.startsWith('{')) {
    const output = [];
    for (const chunk of text.split(',').map((item) => item.trim()).filter(Boolean)) {
      const [role, effortValue, ...extra] = chunk.split(':').map((item) => item.trim());
      const effort = normalizeSubagentEffort(effortValue);
      if (!role || !effortValue || extra.length > 0 || !effort.ok) {
        return { ok: false, message: 'role efforts shorthand must use role:effort pairs with supported effort values.' };
      }
      output.push({ role, effort: effort.value });
    }
    return { ok: true, value: output };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, message: `role efforts must be JSON or role:effort shorthand: ${error.message}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, message: 'role efforts must be a JSON array.' };
  }
  const output = [];
  for (const item of parsed) {
    const effort = normalizeSubagentEffort(item?.effort);
    if (!item?.role || !effort.ok) {
      return { ok: false, message: 'each role effort must include role and a supported effort.' };
    }
    output.push({ role: String(item.role), effort: effort.value });
  }
  return { ok: true, value: output };
}

function parseMaxBytes(value) {
  if (value === undefined) {
    return { ok: true, value: DEFAULT_MAX_BYTES };
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return { ok: false, message: 'max-bytes must be a positive number.' };
  }
  return { ok: true, value: Math.floor(number) };
}

function normalizeConfidence(value) {
  if (typeof value === 'string') {
    const normalized = CONFIDENCE_VALUES.has(value) ? value : 'inconclusive';
    return { evidence: normalized, judgment: normalized, implementation: 'inconclusive' };
  }
  return {
    evidence: CONFIDENCE_VALUES.has(value?.evidence) ? value.evidence : 'inconclusive',
    judgment: CONFIDENCE_VALUES.has(value?.judgment) ? value.judgment : 'inconclusive',
    implementation: CONFIDENCE_VALUES.has(value?.implementation) ? value.implementation : 'inconclusive'
  };
}

function normalizeEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => secretSafeText(item, 600))
    .filter(Boolean);
}

function surfaceSummary(surface) {
  return {
    id: surface.id,
    display_name: surface.display_name,
    kind: surface.kind,
    transport: surface.transport,
    external_evidence_transfer: surface.external_evidence_transfer === true,
    credential_mode: surface.credential_mode ?? 'none'
  };
}

function secretSafeText(value, maxLength) {
  return truncateText(redactString(String(value ?? '')), maxLength);
}

function stringOrNull(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return truncateText(value, 500);
}

function hashJson(value) {
  return hashText(canonicalStringify(value));
}

function hashText(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function canonicalStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function validationError(code, message, details) {
  return { ok: false, error: { code, message, details: redact(details ?? {}) } };
}

function errorResult(code, message, details = {}) {
  return {
    status: 'error',
    data: {
      boundary: agenticHumanReviewBoundary()
    },
    warnings: [],
    errors: [{ code, message, details: redact(details) }],
    artifacts: []
  };
}

function materializeNow(value) {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'function') {
    return materializeNow(value());
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  return new Date();
}
