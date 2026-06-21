#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCT_IDENTITY,
  filesystemSafeName,
  normalizeRepositoryUrl,
  buildIdentityAudit
} from '../src/api.js';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const scanRoots = [
  'src',
  'bin',
  'tests',
  'tools',
  '.github/workflows',
  'package.json',
  '.codex-plugin/plugin.json',
  '.mcp.json'
];

const brittlePatterns = [
  {
    pattern: /\/home\/masahiro\/projects\/agent-toolbox\/browser-debug-cli/u,
    reason: 'current absolute checkout path'
  },
  {
    pattern: /browser-debug-cli-/u,
    reason: 'current checkout name used as a temp prefix'
  },
  {
    pattern: /browser-debug-cli-npm-cache/u,
    reason: 'old checkout name used as an npm cache name'
  },
  {
    pattern: /browser-debug-cli-pack-smoke/u,
    reason: 'old checkout name used as a package smoke name'
  }
];

await main();

async function main() {
  const failures = [];
  const plugin = JSON.parse(await readText('.codex-plugin/plugin.json'));
  const mcp = JSON.parse(await readText('.mcp.json'));
  const identityAudit = await buildIdentityAudit({ cwd: repoRoot });

  if (plugin.repository !== PRODUCT_IDENTITY.repositoryUrl) {
    failures.push(`plugin repository ${plugin.repository} must match current repository URL ${PRODUCT_IDENTITY.repositoryUrl}.`);
  }
  if (normalizeRepositoryUrl(plugin.repository) !== normalizeRepositoryUrl(PRODUCT_IDENTITY.repositoryUrl)) {
    failures.push('plugin repository URL must normalize to PRODUCT_IDENTITY.repositoryUrl.');
  }
  if (!Object.hasOwn(mcp.mcpServers ?? {}, PRODUCT_IDENTITY.mcpServerName)) {
    failures.push(`.mcp.json must include canonical server ${PRODUCT_IDENTITY.mcpServerName}.`);
  }
  for (const legacyName of PRODUCT_IDENTITY.legacyMcpServerNames) {
    if (!Object.hasOwn(mcp.mcpServers ?? {}, legacyName)) {
      failures.push(`.mcp.json must preserve legacy server ${legacyName}.`);
    }
  }
  if (identityAudit.repository.root_matches_current_name === false && identityAudit.repository.root_matches_future_name === false) {
    failures.push(`checkout directory ${identityAudit.repository.root_name} must match a configured repository name.`);
  }
  if (identityAudit.repository.origin_remote_url && !identityAudit.repository.origin_matches_current_repository_url && !identityAudit.repository.origin_matches_future_repository_url && !identityAudit.repository.origin_matches_legacy_repository_url) {
    failures.push(`origin remote ${identityAudit.repository.origin_remote_url} is not an approved current, future, or legacy repository URL.`);
  }
  if (filesystemSafeName(PRODUCT_IDENTITY.packageName).includes('/')) {
    failures.push('filesystemSafeName(packageName) must not contain path separators.');
  }

  for (const file of await scanFiles(scanRoots)) {
    const text = await readText(file);
    for (const { pattern, reason } of brittlePatterns) {
      if (pattern.test(text) && !allowedBrittleMatch(file, pattern)) {
        failures.push(`${file} contains ${reason}: ${pattern}`);
      }
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`Rename readiness failure: ${failure}\n`);
    }
    process.exit(1);
  }
  process.stdout.write('Rename readiness check passed.\n');
}

async function scanFiles(entries) {
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(repoRoot, entry);
    const entryStat = await stat(absolute).catch(() => null);
    if (!entryStat) {
      continue;
    }
    if (entryStat.isDirectory()) {
      for (const child of await walk(entry)) {
        files.push(child);
      }
    } else {
      files.push(entry);
    }
  }
  return files.filter((file) => /\.(?:js|mjs|json|yml|yaml|md|sh)$/u.test(file));
}

async function walk(relativeDir) {
  const files = [];
  for (const entry of await readdir(path.join(repoRoot, relativeDir), { withFileTypes: true })) {
    const child = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(child));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

function allowedBrittleMatch(file, pattern) {
  if (file === 'tools/check_rename_readiness.mjs') {
    return true;
  }
  if (file === 'src/product-identity.js' && String(pattern).includes('browser-debug-cli')) {
    return true;
  }
  return false;
}

function readText(relativePath) {
  return readFile(path.join(repoRoot, relativePath), 'utf8');
}
