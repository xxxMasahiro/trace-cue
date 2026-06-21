import path from 'node:path';
import { CLI_NAME, PACKAGE_VERSION } from './constants.js';

export const PRODUCT_IDENTITY = Object.freeze({
  packageName: 'trace-cue',
  legacyPackageNames: Object.freeze(['browser-debug-cli']),
  packageVersion: PACKAGE_VERSION,
  displayName: 'TraceCue',
  legacyDisplayNames: Object.freeze(['Browser Debug CLI']),
  cliBinName: CLI_NAME,
  cliBinPath: './bin/trace-cue.js',
  legacyCliBins: Object.freeze([
    Object.freeze({ name: 'browser-debug', path: './bin/browser-debug.js' })
  ]),
  mcpBinName: `${CLI_NAME}-mcp`,
  mcpBinPath: './bin/trace-cue-mcp.js',
  legacyMcpBins: Object.freeze([
    Object.freeze({ name: 'browser-debug-mcp', path: './bin/browser-debug-mcp.js' })
  ]),
  mcpServerName: 'trace-cue',
  legacyMcpServerNames: Object.freeze(['browser-debug-cli']),
  pluginName: 'trace-cue',
  legacyPluginNames: Object.freeze(['browser-debug-cli']),
  pluginSkillPath: 'skills/trace-cue-review/SKILL.md',
  legacyPluginSkillPaths: Object.freeze(['skills/browser-debug-review/SKILL.md']),
  repositoryName: 'trace-cue',
  futureRepositoryName: 'trace-cue',
  repositoryUrl: 'https://github.com/xxxMasahiro/trace-cue',
  futureRepositoryUrl: 'https://github.com/xxxMasahiro/trace-cue',
  legacyRepositoryUrls: Object.freeze(['https://github.com/xxxMasahiro/browser-debug-cli']),
  npmCacheDirectoryName: 'trace-cue-npm-cache',
  packSmokeDirectoryName: 'trace-cue-pack-smoke',
  packSmokeKeepEnv: 'TRACE_CUE_KEEP_PACK_INSTALL_SMOKE',
  legacyPackSmokeKeepEnvs: Object.freeze(['BROWSER_DEBUG_KEEP_PACK_INSTALL_SMOKE']),
  defaultArtifactRoot: '.browser-debug',
  futureArtifactRoot: '.trace-cue',
  legacyArtifactRoots: Object.freeze(['.browser-debug'])
});

export function packageTarballFilename(identity = PRODUCT_IDENTITY) {
  return `${tarballPackageName(identity.packageName)}-${identity.packageVersion}.tgz`;
}

export function packageInstallDirectory(nodeModules, identity = PRODUCT_IDENTITY) {
  return path.join(nodeModules, ...packageNamePathParts(identity.packageName));
}

export function packageSchemaSpecifier(schemaName, identity = PRODUCT_IDENTITY) {
  return `${identity.packageName}/schemas/${schemaName}`;
}

export function packageBinEntries(identity = PRODUCT_IDENTITY) {
  return Object.freeze([
    Object.freeze({ name: identity.cliBinName, path: identity.cliBinPath, canonical: true }),
    Object.freeze({ name: identity.mcpBinName, path: identity.mcpBinPath, canonical: true }),
    ...identity.legacyCliBins.map((entry) => Object.freeze({ ...entry, canonical: false })),
    ...identity.legacyMcpBins.map((entry) => Object.freeze({ ...entry, canonical: false }))
  ]);
}

export function productIdentitySummary(identity = PRODUCT_IDENTITY) {
  return {
    package_name: identity.packageName,
    legacy_package_names: identity.legacyPackageNames,
    package_version: identity.packageVersion,
    display_name: identity.displayName,
    legacy_display_names: identity.legacyDisplayNames,
    cli_bin_name: identity.cliBinName,
    legacy_cli_bin_names: identity.legacyCliBins.map((entry) => entry.name),
    mcp_bin_name: identity.mcpBinName,
    legacy_mcp_bin_names: identity.legacyMcpBins.map((entry) => entry.name),
    mcp_server_name: identity.mcpServerName,
    legacy_mcp_server_names: identity.legacyMcpServerNames,
    plugin_name: identity.pluginName,
    legacy_plugin_names: identity.legacyPluginNames,
    repository_name: identity.repositoryName,
    future_repository_name: identity.futureRepositoryName,
    repository_url: identity.repositoryUrl,
    future_repository_url: identity.futureRepositoryUrl,
    legacy_repository_urls: identity.legacyRepositoryUrls,
    default_artifact_root: identity.defaultArtifactRoot,
    future_artifact_root: identity.futureArtifactRoot,
    legacy_artifact_roots: identity.legacyArtifactRoots
  };
}

export function filesystemSafeName(value) {
  return String(value)
    .replace(/^@/u, '')
    .replace(/[/\\]+/gu, '-')
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    || 'package';
}

function tarballPackageName(packageName) {
  return packageName.replace(/^@/u, '').replace(/\//gu, '-');
}

function packageNamePathParts(packageName) {
  return packageName.split('/').filter(Boolean);
}
