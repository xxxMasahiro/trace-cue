export const DEFAULT_MCP_PROFILE = 'full';
export const MCP_PROFILE_NAMES = Object.freeze(['safe', 'full', 'admin']);

const SAFE_PROFILE_TOOLS = Object.freeze([
  'browser_debug_doctor',
  'browser_debug_target_validate',
  'browser_debug_resource_status',
  'browser_debug_resource_artifacts_plan',
  'browser_debug_agent_surfaces_list',
  'browser_debug_agent_requests_list',
  'browser_debug_agent_requests_show',
  'browser_debug_agent_workflow_status',
  'browser_debug_agent_workflow_index',
  'browser_debug_agent_execution_status',
  'browser_debug_agent_execution_list',
  'browser_debug_schema_list',
  'browser_debug_schema_get'
]);

const FULL_PROFILE_TOOLS = Object.freeze([
  'browser_debug_doctor',
  'browser_debug_observe',
  'browser_debug_review',
  'browser_debug_target_init',
  'browser_debug_target_validate',
  'browser_debug_resource_status',
  'browser_debug_resource_artifacts_plan',
  'browser_debug_agent_surfaces_list',
  'browser_debug_agent_requests_list',
  'browser_debug_agent_requests_show',
  'browser_debug_agent_workflow_status',
  'browser_debug_agent_workflow_index',
  'browser_debug_agent_execution_status',
  'browser_debug_agent_execution_list',
  'browser_debug_review_target',
  'browser_debug_schema_list',
  'browser_debug_schema_get'
]);

export const MCP_PROFILES = Object.freeze({
  safe: Object.freeze({
    name: 'safe',
    description: 'No-browser/no-delete/no-provider MCP surface for discovery and local read-only planning.',
    tools: SAFE_PROFILE_TOOLS,
    boundaries: Object.freeze({
      browser_launched: false,
      writes_artifacts: false,
      deletes_files: false,
      provider_call: false,
      shell_used: false,
      external_listener: false
    })
  }),
  full: Object.freeze({
    name: 'full',
    description: 'Compatibility MCP surface for local observe, review, target, schema, and planning workflows.',
    tools: FULL_PROFILE_TOOLS,
    boundaries: Object.freeze({
      browser_launched: true,
      writes_artifacts: true,
      deletes_files: false,
      provider_call: false,
      shell_used: false,
      external_listener: false
    })
  }),
  admin: Object.freeze({
    name: 'admin',
    description: 'Explicit local-maintenance MCP profile. Phase 31 keeps it equivalent to full.',
    tools: FULL_PROFILE_TOOLS,
    boundaries: Object.freeze({
      browser_launched: true,
      writes_artifacts: true,
      deletes_files: false,
      provider_call: false,
      shell_used: false,
      external_listener: false
    })
  })
});

const TOOL_REGISTRY = Object.freeze([
  {
    name: 'browser_debug_doctor',
    minimumProfile: 'safe',
    description: 'Run Browser Debug CLI doctor and return the standard JSON envelope.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    effects: effects({ browserLaunched: false, writesArtifacts: false }),
    toCliArgs: () => ['doctor', '--json']
  },
  {
    name: 'browser_debug_observe',
    minimumProfile: 'full',
    description: 'Observe one approved URL with local Playwright evidence.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      additionalProperties: false,
      properties: {
        url: { type: 'string' },
        screenshot: { type: 'boolean' },
        trace: { type: 'boolean' },
        timeout: { type: 'string' }
      }
    },
    effects: effects({ browserLaunched: true, writesArtifacts: true }),
    toCliArgs: (args) => withCommonOptions(['observe', '--url', args.url], args)
  },
  {
    name: 'browser_debug_review',
    minimumProfile: 'full',
    description: 'Run a deterministic local browser review for one URL.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      additionalProperties: false,
      properties: {
        url: { type: 'string' },
        viewport: { type: 'string' },
        screenshot: { type: 'boolean' },
        report: { type: 'boolean' },
        timeout: { type: 'string' }
      }
    },
    effects: effects({ browserLaunched: true, writesArtifacts: true }),
    toCliArgs: (args) => withCommonOptions(['review', '--url', args.url], args)
  },
  {
    name: 'browser_debug_target_init',
    minimumProfile: 'full',
    description: 'Create a local target manifest artifact for manifest-driven review.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      additionalProperties: false,
      properties: {
        url: { type: 'string' },
        name: { type: 'string' },
        viewport: { type: 'string' },
        maxRoutes: { type: 'number' },
        timeout: { type: 'string' }
      }
    },
    effects: effects({ browserLaunched: false, writesArtifacts: true }),
    toCliArgs: (args) => {
      const output = withCommonOptions(['target', 'init', '--url', args.url], args);
      if (args.name) {
        output.splice(-1, 0, '--name', String(args.name));
      }
      if (args.maxRoutes !== undefined) {
        output.splice(-1, 0, '--max-routes', String(args.maxRoutes));
      }
      return output;
    }
  },
  {
    name: 'browser_debug_target_validate',
    minimumProfile: 'safe',
    description: 'Validate a local target manifest without launching a browser.',
    inputSchema: {
      type: 'object',
      required: ['target'],
      additionalProperties: false,
      properties: {
        target: { type: 'string' }
      }
    },
    effects: effects({ browserLaunched: false, writesArtifacts: false }),
    toCliArgs: (args) => ['target', 'validate', '--target', args.target, '--json']
  },
  {
    name: 'browser_debug_resource_status',
    minimumProfile: 'safe',
    description: 'Report local memory, swap, cgroup, and pressure signals without launching a browser.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    effects: effects({ browserLaunched: false, writesArtifacts: false }),
    toCliArgs: () => ['resource', 'status', '--json']
  },
  {
    name: 'browser_debug_resource_artifacts_plan',
    minimumProfile: 'safe',
    description: 'Report local Browser Debug CLI artifact size and cleanup candidates without deleting files.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxBytes: { type: 'string' },
        olderThan: { type: 'string' }
      }
    },
    effects: effects({ browserLaunched: false, writesArtifacts: false }),
    toCliArgs: (args) => {
      const output = ['resource', 'artifacts', 'plan'];
      if (args.maxBytes !== undefined) {
        output.push('--max-bytes', String(args.maxBytes));
      }
      if (args.olderThan !== undefined) {
        output.push('--older-than', String(args.olderThan));
      }
      output.push('--json');
      return output;
    }
  },
  {
    name: 'browser_debug_agent_surfaces_list',
    minimumProfile: 'safe',
    description: 'List local agent advisory surfaces without launching a browser or calling providers.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    effects: effects({ browserLaunched: false, writesArtifacts: false }),
    toCliArgs: () => ['agent', 'surfaces', 'list', '--json']
  },
  {
    name: 'browser_debug_agent_requests_list',
    minimumProfile: 'safe',
    description: 'List local agent advisory package/request status without writing artifacts.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        package: { type: 'string' },
        artifactRoot: { type: 'string' }
      }
    },
    effects: effects({ browserLaunched: false, writesArtifacts: false }),
    toCliArgs: (args) => withOptionalOptions(['agent', 'requests', 'list'], args, {
      package: '--package',
      artifactRoot: '--artifact-root'
    })
  },
  {
    name: 'browser_debug_agent_requests_show',
    minimumProfile: 'safe',
    description: 'Show one local agent advisory request detail without writing artifacts.',
    inputSchema: {
      type: 'object',
      required: ['package'],
      additionalProperties: false,
      properties: {
        package: { type: 'string' },
        agentResult: { type: 'string' },
        artifactRoot: { type: 'string' }
      }
    },
    effects: effects({ browserLaunched: false, writesArtifacts: false }),
    toCliArgs: (args) => withOptionalOptions(['agent', 'requests', 'show'], args, {
      package: '--package',
      agentResult: '--agent-result',
      artifactRoot: '--artifact-root'
    })
  },
  {
    name: 'browser_debug_agent_workflow_status',
    minimumProfile: 'safe',
    description: 'Read local agent workflow status without writing artifacts or calling providers.',
    inputSchema: {
      type: 'object',
      required: ['workflow'],
      additionalProperties: false,
      properties: {
        workflow: { type: 'string' }
      }
    },
    effects: effects({ browserLaunched: false, writesArtifacts: false }),
    toCliArgs: (args) => ['agent', 'workflow', 'status', '--workflow', args.workflow, '--json']
  },
  {
    name: 'browser_debug_agent_workflow_index',
    minimumProfile: 'safe',
    description: 'Index local agent workflows without writing artifacts or calling providers.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        artifactRoot: { type: 'string' }
      }
    },
    effects: effects({ browserLaunched: false, writesArtifacts: false }),
    toCliArgs: (args) => withOptionalOptions(['agent', 'workflow', 'index'], args, {
      artifactRoot: '--artifact-root'
    })
  },
  {
    name: 'browser_debug_agent_execution_status',
    minimumProfile: 'safe',
    description: 'Read local agent execution status without executing providers.',
    inputSchema: {
      type: 'object',
      required: ['execution'],
      additionalProperties: false,
      properties: {
        execution: { type: 'string' }
      }
    },
    effects: effects({ browserLaunched: false, writesArtifacts: false, providerCall: false }),
    toCliArgs: (args) => ['agent', 'execution', 'status', '--execution', args.execution, '--json']
  },
  {
    name: 'browser_debug_agent_execution_list',
    minimumProfile: 'safe',
    description: 'List local agent execution metadata without executing providers.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        artifactRoot: { type: 'string' }
      }
    },
    effects: effects({ browserLaunched: false, writesArtifacts: false, providerCall: false }),
    toCliArgs: (args) => withOptionalOptions(['agent', 'execution', 'list'], args, {
      artifactRoot: '--artifact-root'
    })
  },
  {
    name: 'browser_debug_review_target',
    minimumProfile: 'full',
    description: 'Run a deterministic local browser review for a target manifest.',
    inputSchema: {
      type: 'object',
      required: ['target'],
      additionalProperties: false,
      properties: {
        target: { type: 'string' },
        report: { type: 'boolean' },
        timeout: { type: 'string' }
      }
    },
    effects: effects({ browserLaunched: true, writesArtifacts: true }),
    toCliArgs: (args) => withCommonOptions(['review', '--target', args.target], args)
  },
  {
    name: 'browser_debug_schema_list',
    minimumProfile: 'safe',
    description: 'List machine-readable Browser Debug CLI schemas.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    effects: effects({ browserLaunched: false, writesArtifacts: false }),
    toCliArgs: () => ['schema', 'list', '--json']
  },
  {
    name: 'browser_debug_schema_get',
    minimumProfile: 'safe',
    description: 'Get one machine-readable Browser Debug CLI schema.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      additionalProperties: false,
      properties: { name: { type: 'string' } }
    },
    effects: effects({ browserLaunched: false, writesArtifacts: false }),
    toCliArgs: (args) => ['schema', 'get', '--name', args.name, '--json']
  }
]);

const TOOL_BY_NAME = new Map(TOOL_REGISTRY.map((tool) => [tool.name, tool]));

export function resolveMcpProfile(value, env = {}) {
  const profile = String(value || env.BROWSER_DEBUG_MCP_PROFILE || DEFAULT_MCP_PROFILE).trim();
  if (Object.hasOwn(MCP_PROFILES, profile)) {
    return { ok: true, profile, definition: MCP_PROFILES[profile] };
  }
  return {
    ok: false,
    profile,
    message: `Unsupported MCP profile: ${profile}. Expected one of: ${MCP_PROFILE_NAMES.join(', ')}.`
  };
}

export function getMcpTools(profile = DEFAULT_MCP_PROFILE) {
  const resolved = resolveMcpProfile(profile);
  if (!resolved.ok) {
    return [];
  }
  return resolved.definition.tools.map((name) => publicTool(TOOL_BY_NAME.get(name)));
}

export function resolveMcpTool(profile, name) {
  const resolved = resolveMcpProfile(profile);
  if (!resolved.ok) {
    return { ok: false, code: 'INVALID_PROFILE', message: resolved.message };
  }
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) {
    return { ok: false, code: 'UNKNOWN_TOOL', message: `Unknown tool: ${name}` };
  }
  if (!resolved.definition.tools.includes(name)) {
    return {
      ok: false,
      code: 'TOOL_NOT_IN_PROFILE',
      message: `Tool not available for MCP profile ${resolved.profile}: ${name}`
    };
  }
  return { ok: true, profile: resolved.profile, definition: resolved.definition, tool };
}

export function mcpToolToCliArgs(tool, args = {}) {
  const definition = typeof tool === 'string' ? TOOL_BY_NAME.get(tool) : tool;
  if (!definition) {
    return ['doctor', '--json'];
  }
  return definition.toCliArgs(args);
}

export function mcpProfileMetadata(profile = DEFAULT_MCP_PROFILE) {
  const resolved = resolveMcpProfile(profile);
  if (!resolved.ok) {
    return null;
  }
  return {
    name: resolved.profile,
    default: DEFAULT_MCP_PROFILE,
    available: MCP_PROFILE_NAMES,
    description: resolved.definition.description,
    boundaries: resolved.definition.boundaries
  };
}

function publicTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    minimumProfile: tool.minimumProfile,
    effects: tool.effects
  };
}

function effects(overrides) {
  return Object.freeze({
    browserLaunched: false,
    writesArtifacts: false,
    deletesFiles: false,
    providerCall: false,
    shellUsed: false,
    externalListener: false,
    externalUpload: false,
    ...overrides
  });
}

function withCommonOptions(base, args) {
  const output = [...base];
  if (args.viewport) {
    output.push('--viewport', String(args.viewport));
  }
  if (args.timeout) {
    output.push('--timeout', String(args.timeout));
  }
  if (args.screenshot) {
    output.push('--screenshot');
  }
  if (args.trace) {
    output.push('--trace');
  }
  if (args.report) {
    output.push('--report');
  }
  output.push('--json');
  return output;
}

function withOptionalOptions(base, args, optionMap) {
  const output = [...base];
  for (const [key, flag] of Object.entries(optionMap)) {
    if (args[key] !== undefined) {
      output.push(flag, String(args[key]));
    }
  }
  output.push('--json');
  return output;
}
