import {
  DEFAULT_MCP_PROFILE,
  MCP_PROFILE_NAMES,
  MCP_PROFILES,
  getMcpTools,
  mcpProfileMetadata,
  resolveMcpProfile
} from './mcp-profiles.js';
import {
  MCP_HTTP_DEFAULT_HOST,
  MCP_HTTP_DEFAULT_PROFILE,
  MCP_HTTP_DEFAULT_TOKEN_ENV
} from './mcp-transport-policy.js';
import { PRODUCT_IDENTITY } from './product-identity.js';

export const MCP_CAPABILITY_POLICY_VERSION = '1.0.0';
export const MCP_CAPABILITY_DEFAULT_SCOPE = 'all';

const CAPABILITY_SCOPES = Object.freeze(['all', 'profiles', 'excluded']);

const EXCLUDED_OPERATIONS = Object.freeze([
  excludedOperation({
    id: 'resource_artifacts_cleanup_execute',
    command: 'resource artifacts cleanup --execute',
    category: 'cleanup',
    cli: true,
    reason: 'Deletes local artifact files and must stay explicit at the CLI boundary.',
    futureReview: 'Requires selected artifact-root receipts, failure-safe dry-run parity, and separate MCP cleanup approval.'
  }),
  excludedOperation({
    id: 'agent_package_ingest_report',
    command: 'agent package / ingest / report',
    category: 'agent_advisory_write',
    cli: true,
    reason: 'Creates or imports local advisory artifacts and reports.',
    futureReview: 'Requires per-command receipts, package/result confinement, and no provider execution.'
  }),
  excludedOperation({
    id: 'agent_workflow_create_report',
    command: 'agent workflow create / report',
    category: 'agent_workflow_write',
    cli: true,
    reason: 'Creates workflow manifests or writes workflow reports under the local artifact root.',
    futureReview: 'Requires workflow receipt parity and clear separation from read-only status/index tools.'
  }),
  excludedOperation({
    id: 'agent_execution_plan',
    command: 'agent execution plan',
    category: 'agent_execution_write',
    cli: true,
    reason: 'Writes dry-run execution plan metadata and receipts.',
    futureReview: 'Requires a separate MCP planning approval and must not imply execution permission.'
  }),
  excludedOperation({
    id: 'agent_execution_run',
    command: 'agent execution run --execute',
    category: 'provider_execution',
    cli: true,
    reason: 'May call configured local runners or provider/API adapters after explicit CLI execution approval.',
    futureReview: 'Requires a dedicated MCP execution design, credential boundary review, and provider disclosure policy.'
  }),
  excludedOperation({
    id: 'daemon_session_control',
    command: 'daemon start/status/stop and session start/act/report/spec',
    category: 'local_runtime_control',
    cli: true,
    reason: 'Controls local browser runtime state or writes browser/session artifacts.',
    futureReview: 'Requires lifecycle receipts, process ownership constraints, and browser artifact disclosure review.'
  }),
  excludedOperation({
    id: 'provider_api_execution',
    command: 'provider/API execution',
    category: 'external_execution',
    cli: true,
    reason: 'May send bounded package/prompt data outside the local process through the Phase 29 adapter.',
    futureReview: 'Requires explicit external-service, credential, and evidence-disclosure approval before MCP exposure.'
  }),
  excludedOperation({
    id: 'arbitrary_shell',
    command: 'arbitrary shell execution',
    category: 'shell',
    cli: false,
    reason: 'No arbitrary shell tool is exposed by the CLI or MCP profiles.',
    futureReview: 'Held out of scope until there is a separate threat model, allowlist design, and operational history.'
  }),
  excludedOperation({
    id: 'http_full_admin_socket_remote',
    command: 'HTTP full/admin, socket transport, or remote HTTP listener',
    category: 'transport_expansion',
    cli: false,
    reason: 'Current HTTP MCP transport is safe-profile-only and loopback-only.',
    futureReview: 'Requires separate transport security design before any broader listener or profile support.'
  })
]);

export function buildMcpCapabilityReport(options = {}) {
  const scope = String(options.scope ?? MCP_CAPABILITY_DEFAULT_SCOPE).trim();
  if (!CAPABILITY_SCOPES.includes(scope)) {
    return {
      ok: false,
      code: 'INVALID_MCP_CAPABILITY_SCOPE',
      message: `Unsupported MCP capability scope: ${scope}. Expected one of: ${CAPABILITY_SCOPES.join(', ')}.`
    };
  }

  const profileSelection = String(options.profile ?? 'all').trim();
  const profiles = selectedProfiles(profileSelection);
  if (!profiles.ok) {
    return profiles;
  }

  return {
    ok: true,
    report: {
      policy_version: MCP_CAPABILITY_POLICY_VERSION,
      scope,
      server_name: PRODUCT_IDENTITY.mcpServerName,
      default_profile: DEFAULT_MCP_PROFILE,
      admin_policy: adminPolicy(),
      profiles: scope === 'excluded' ? [] : profiles.names.map(profileReport),
      transports: scope === 'excluded' ? [] : transportReports(),
      excluded_operations: scope === 'profiles' ? [] : EXCLUDED_OPERATIONS,
      boundaries: boundarySummary(),
      next_steps: nextSteps()
    }
  };
}

function selectedProfiles(profileSelection) {
  if (profileSelection === 'all') {
    return { ok: true, names: MCP_PROFILE_NAMES };
  }
  const resolved = resolveMcpProfile(profileSelection);
  if (!resolved.ok) {
    return { ok: false, code: 'INVALID_MCP_PROFILE', message: resolved.message };
  }
  return { ok: true, names: [resolved.profile] };
}

function profileReport(profileName) {
  const metadata = mcpProfileMetadata(profileName);
  const tools = getMcpTools(profileName);
  const effectSummary = tools.reduce((summary, tool) => {
    summary.browser_launched ||= Boolean(tool.effects?.browserLaunched);
    summary.writes_artifacts ||= Boolean(tool.effects?.writesArtifacts);
    summary.deletes_files ||= Boolean(tool.effects?.deletesFiles);
    summary.provider_call ||= Boolean(tool.effects?.providerCall);
    summary.shell_used ||= Boolean(tool.effects?.shellUsed);
    summary.external_listener ||= Boolean(tool.effects?.externalListener);
    summary.external_upload ||= Boolean(tool.effects?.externalUpload);
    return summary;
  }, {
    browser_launched: false,
    writes_artifacts: false,
    deletes_files: false,
    provider_call: false,
    shell_used: false,
    external_listener: false,
    external_upload: false
  });

  return {
    name: profileName,
    description: metadata.description,
    default: profileName === DEFAULT_MCP_PROFILE,
    tool_count: tools.length,
    tools: tools.map((tool) => ({
      name: tool.name,
      minimum_profile: tool.minimumProfile,
      effects: tool.effects
    })),
    boundaries: metadata.boundaries,
    effects: effectSummary
  };
}

function transportReports() {
  return [
    {
      transport: 'stdio',
      profiles: MCP_PROFILE_NAMES,
      default_profile: DEFAULT_MCP_PROFILE,
      local_only: true,
      external_listener: false,
      auth_required: false
    },
    {
      transport: 'http',
      profiles: [MCP_HTTP_DEFAULT_PROFILE],
      default_profile: MCP_HTTP_DEFAULT_PROFILE,
      host: MCP_HTTP_DEFAULT_HOST,
      local_only: true,
      external_listener: false,
      auth_required: true,
      token_env: MCP_HTTP_DEFAULT_TOKEN_ENV,
      full_or_admin_supported: false,
      socket_supported: false,
      remote_listener_supported: false
    }
  ];
}

function adminPolicy() {
  return {
    profile_name: 'admin',
    currently_equivalent_to_full: MCP_PROFILES.admin.tools.join('\n') === MCP_PROFILES.full.tools.join('\n'),
    write_execute_tools_exposed: false,
    cleanup_execution_exposed: false,
    agent_execution_run_exposed: false,
    provider_api_execution_exposed: false,
    shell_tools_exposed: false,
    daemon_session_control_exposed: false,
    credential_handling_exposed: false,
    decision: 'read-only policy report only',
    reason: 'Phase 36 records the current MCP capability boundary without adding write, delete, provider, shell, or runtime-control tools.'
  };
}

function boundarySummary() {
  return {
    cleanup_execution: false,
    agent_execution_run: false,
    provider_api_execution: false,
    arbitrary_shell: false,
    socket_transport: false,
    remote_http_listener: false,
    http_full_or_admin: false,
    credential_values_read: false,
    credential_values_stored: false,
    external_upload: false,
    browser_profile_reuse: false,
    config_files_written: false
  };
}

function nextSteps() {
  return [
    'Use this report to inspect current MCP tool/profile exposure before configuring a client.',
    'Keep write, delete, provider/API, shell, daemon/session, and credential-bearing operations on the CLI unless a later phase approves one operation at a time.',
    'Use browser-debug mcp config for token-free client setup metadata.'
  ];
}

function excludedOperation({ id, command, category, cli, reason, futureReview }) {
  return Object.freeze({
    id,
    command,
    category,
    cli_available: cli,
    mcp_safe: false,
    mcp_full: false,
    mcp_admin: false,
    decision: 'not_exposed',
    reason,
    future_review_required: true,
    future_review: futureReview
  });
}
