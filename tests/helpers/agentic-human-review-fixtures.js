export const fixedNow = '2026-06-17T00:00:00.000Z';

export function minimalPngBuffer(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

export function adapterTraceCueRequest() {
  const subAgents = [
    {
      role: 'visual_reviewer',
      display_name: 'Visual Reviewer',
      effort: 'xhigh',
      round: 1
    },
    {
      role: 'content_reviewer',
      display_name: 'Content Reviewer',
      effort: 'xhigh',
      round: 1
    },
    {
      role: 'critic_reviewer',
      display_name: 'Critic Reviewer',
      effort: 'xhigh',
      round: 2
    },
    {
      role: 'verification_reviewer',
      display_name: 'Verification Reviewer',
      effort: 'xhigh',
      round: 2
    },
    {
      role: 'synthesis_agent',
      display_name: 'Synthesis Agent',
      effort: 'xhigh',
      round: 3
    }
  ];
  return {
    schema_version: '0.1.0',
    type: 'agentic_human_review_request',
    plan: {
      id: 'adapter-plan',
      plan_hash: 'a'.repeat(64),
      plan_path_included: false,
      plan_path: '/tmp/local-plan/plan.json',
      intent: 'Review visual UX, visible text comprehension, and likely reader feeling.',
      review_effort: { mode: 'xhigh' },
      sub_agents: subAgents,
      rounds: [1, 2, 3],
      evidence_plan: {
        visual_reference_policy: {
          raw_pixel_bytes_embedded_in_json: false
        }
      }
    },
    package: {
      id: 'adapter-package',
      visual_evidence: {
        reference_count: 1,
        references: [{
          path: '.browser-debug/visual-evidence/local-image.json',
          raw_pixels_embedded_in_json: false
        }],
        raw_pixels_embedded_in_json: false
      },
      content_evidence: {
        text_snippet_count: 1,
        text_snippets: ['Visible heading and supporting copy are available for review.']
      },
      artifact_references: [{
        type: 'review',
        path: '.browser-debug/reviews/local-review.json'
      }],
      disclosure: {
        raw_pixels_embedded_in_json: false,
        raw_artifact_content_included: false,
        raw_pixel_bytes_included: false
      }
    },
    provider: {
      id: 'generic-api-provider',
      kind: 'api_provider',
      transport: 'provider_api'
    },
    model: { id: 'generic-agentic-review-model' },
    surface: { id: 'local-subscription-agent' },
    execution: {
      id: 'adapter-execution',
      execution_path_included: false,
      execution_path: '/tmp/local-plan/execution.json'
    },
    disclosure_policy: {
      approved_transfer_flags: ['allow-page-text', 'allow-raw-pixels'],
      raw_pixels_included: false,
      raw_artifact_content_included: false,
      raw_pixel_bytes_included: false,
      visual_references_included: true,
      page_text_summary_included: true,
      external_evidence_transfer: true,
      mcp_execution_allowed: false
    }
  };
}

export function attachAdapterOwnerBaselineContract(request) {
  request.plan.owner_baseline_requirement_contract = {
    baseline_id: 'owner-baseline-fixed',
    case_id: 'blog-content-value',
    must_not_miss_criteria: [{
      id: 'owner-final-ambiguity',
      dimension: 'content_comprehension',
      summary: 'The review must preserve the target-specific ambiguous ending interpretation.',
      severity: 'high',
      target_specific: true
    }],
    owner_labels: [{
      id: 'owner-label-final-ambiguity',
      must_not_miss_criterion_id: 'owner-final-ambiguity',
      criteria_refs: ['owner-final-ambiguity'],
      target_specific: true,
      evidence_ref_count: 1
    }],
    required_structured_finding_fields: ['must_not_miss_criterion_id', 'owner_label_ids', 'evidence_refs'],
    target_specific_must_not_miss_required: true,
    advisory_only: true,
    gate_effect: 'none'
  };
  return request.plan.owner_baseline_requirement_contract;
}

export function adapterEnv(extra = {}) {
  const tokenEnv = 'AGENTIC_HUMAN_REVIEW_API_' + 'TOKEN';
  const providerKeyEnv = 'AGENTIC_HUMAN_REVIEW_OPENAI_' + 'API_KEY';
  return {
    [tokenEnv]: 'adapter-secret-value',
    [providerKeyEnv]: 'provider-secret-value',
    AGENTIC_HUMAN_REVIEW_OPENAI_MODEL: 'review-model-for-test',
    ...extra
  };
}

export function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: () => null
    },
    text: async () => JSON.stringify(body)
  };
}
