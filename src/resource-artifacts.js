import { mkdir, readdir, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { CLI_NAME, DEFAULT_ARTIFACT_ROOT, SCHEMA_VERSION } from './constants.js';
import { artifactObject, artifactRelPath, createArtifactId, resolveArtifactRoot, writeJsonArtifact } from './artifacts.js';
import { parseDurationMs } from './durations.js';
import { redact, truncateText } from './redaction.js';

export const DEFAULT_ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024;

export async function runResourceArtifactsPlan(options = {}, context = {}) {
  try {
    const plan = await buildArtifactCleanupPlan(options, context);
    return {
      status: 'ok',
      data: {
        artifact_usage: plan.usage,
        cleanup_proposal: plan.proposal,
        boundary: artifactBoundary({ cacheDeleted: false, artifactsWritten: false })
      },
      warnings: plan.warnings,
      errors: [],
      artifacts: []
    };
  } catch (error) {
    return artifactError('ARTIFACT_USAGE_FAILED', error.message, {
      artifact_root: options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT
    });
  }
}

export async function runResourceArtifactsCleanup(options = {}, context = {}) {
  try {
    const execute = Boolean(options.execute);
    const plan = await buildArtifactCleanupPlan(options, context);
    if (!execute) {
      return {
        status: 'ok',
        data: {
          artifact_usage: plan.usage,
          cleanup_proposal: plan.proposal,
          cleanup: {
            dry_run: true,
            execute: false,
            files_deleted: 0,
            bytes_deleted: 0,
            receipt: null,
            note: 'No files were deleted. Pass --execute to remove only selected files under the artifact root.'
          },
          boundary: artifactBoundary({ cacheDeleted: false, artifactsWritten: false })
        },
        warnings: plan.warnings,
        errors: [],
        artifacts: []
      };
    }

    const deleted = [];
    const skipped = [];
    let bytesDeleted = 0;
    for (const candidate of plan.candidates) {
      try {
        await rm(candidate.absolute_path, { force: false });
        deleted.push(relativeCandidate(candidate));
        bytesDeleted += candidate.size_bytes;
      } catch (error) {
        skipped.push({
          path: candidate.path,
          reason: error?.code ?? 'DELETE_FAILED',
          message: truncateText(error.message, 500)
        });
      }
    }
    await removeEmptyDirectories(plan.root).catch(() => {});

    const receiptId = context.createId?.('artifact-cleanup', materializeNow(context.now))
      ?? createArtifactId(materializeNow(context.now), 'artifact-cleanup');
    const receipt = redact({
      schema_version: SCHEMA_VERSION,
      id: receiptId,
      created_at: materializeNow(context.now).toISOString(),
      artifact_root: plan.artifactRoot,
      dry_run: false,
      execute: true,
      files_deleted: deleted.length,
      bytes_deleted: bytesDeleted,
      deleted,
      skipped,
      before: plan.usage.summary,
      cleanup_policy: plan.proposal.policy,
      boundary: artifactBoundary({ cacheDeleted: true, artifactsWritten: true })
    });
    await mkdir(path.join(plan.root, 'receipts'), { recursive: true });
    await writeJsonArtifact(plan.root, ['receipts', `${receiptId}.json`], receipt);

    const receiptArtifact = artifactObject({
      type: 'artifact_cleanup_receipt',
      path: artifactRelPath(plan.artifactRoot, 'receipts', `${receiptId}.json`),
      description: 'Receipt for explicit local artifact cleanup under the artifact root.'
    });
    return {
      status: skipped.length > 0 ? 'error' : 'ok',
      data: {
        artifact_usage: plan.usage,
        cleanup_proposal: plan.proposal,
        cleanup: {
          dry_run: false,
          execute: true,
          files_deleted: deleted.length,
          bytes_deleted: bytesDeleted,
          receipt: receiptArtifact.path,
          skipped
        },
        boundary: artifactBoundary({ cacheDeleted: true, artifactsWritten: true })
      },
      warnings: plan.warnings,
      errors: skipped.length > 0 ? [{
        code: 'ARTIFACT_CLEANUP_PARTIAL',
        message: 'Some selected artifact files could not be deleted.',
        details: { skipped }
      }] : [],
      artifacts: [receiptArtifact]
    };
  } catch (error) {
    return artifactError('ARTIFACT_CLEANUP_FAILED', error.message, {
      artifact_root: options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT
    });
  }
}

export async function buildArtifactCleanupPlan(options = {}, context = {}) {
  const cwd = context.cwd ?? process.cwd();
  const artifactRoot = options['artifact-root'] ?? DEFAULT_ARTIFACT_ROOT;
  const root = resolveArtifactRoot(cwd, artifactRoot);
  const maxBytes = parseByteSize(options['max-bytes'], DEFAULT_ARTIFACT_MAX_BYTES);
  const olderThanMs = parseDurationMs(options['older-than'], {
    name: 'older-than',
    defaultMs: null,
    minMs: 1000
  });
  const nowMs = materializeNow(context.now).getTime();
  const usage = await collectArtifactUsage(root, artifactRoot, { nowMs });
  const candidates = selectCleanupCandidates(usage.files, {
    maxBytes,
    olderThanMs,
    nowMs,
    totalBytes: usage.summary.total_bytes
  });
  const proposal = {
    status: usage.summary.total_bytes > maxBytes || candidates.length > 0 ? 'watch' : 'ok',
    policy: {
      max_bytes: maxBytes,
      older_than_ms: olderThanMs,
      delete_scope: 'artifact_root_regular_files_only',
      symlinks_followed: false,
      receipts_preserved: true,
      requires_execute_flag: true
    },
    candidates: candidates.map(relativeCandidate),
    candidate_count: candidates.length,
    candidate_bytes: candidates.reduce((sum, candidate) => sum + candidate.size_bytes, 0),
    recommended_command: candidates.length > 0
      ? `${CLI_NAME} resource artifacts cleanup --max-bytes ${maxBytes} --execute --json`
      : null
  };
  return {
    root,
    artifactRoot,
    usage: usage.publicUsage,
    proposal,
    candidates,
    warnings: warningsForArtifactUsage(usage.summary, proposal)
  };
}

async function collectArtifactUsage(root, artifactRoot, { nowMs }) {
  const files = [];
  const byTopLevel = new Map();
  let directoryCount = 0;
  let symlinkCount = 0;
  let exists = true;
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory()) {
      exists = false;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
    exists = false;
  }
  if (exists) {
    await walkArtifacts(root, root, files, byTopLevel, () => {
      directoryCount += 1;
    }, () => {
      symlinkCount += 1;
    });
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size_bytes, 0);
  const sortedBySize = [...files].sort((left, right) => right.size_bytes - left.size_bytes);
  const oldest = [...files].sort((left, right) => left.mtime_ms - right.mtime_ms)[0] ?? null;
  const newest = [...files].sort((left, right) => right.mtime_ms - left.mtime_ms)[0] ?? null;
  const summary = {
    artifact_root: artifactRoot,
    root_exists: exists,
    total_bytes: totalBytes,
    file_count: files.length,
    directory_count: directoryCount,
    symlink_count: symlinkCount,
    oldest_file_age_ms: oldest ? Math.max(0, nowMs - oldest.mtime_ms) : null,
    newest_file_age_ms: newest ? Math.max(0, nowMs - newest.mtime_ms) : null
  };
  return {
    summary,
    files,
    publicUsage: {
      schema_version: SCHEMA_VERSION,
      summary,
      by_top_level_directory: [...byTopLevel.values()].sort((left, right) => right.total_bytes - left.total_bytes),
      largest_files: sortedBySize.slice(0, 10).map(relativeCandidate),
      limitations: [
        'Artifact usage is scoped to the configured TraceCue artifact root.',
        'Symbolic links are counted as skipped entries and are not followed.'
      ]
    }
  };
}

async function walkArtifacts(root, current, files, byTopLevel, onDirectory, onSymlink) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relativePath = path.relative(root, absolute).replace(/\\/g, '/');
    if (entry.isSymbolicLink()) {
      onSymlink();
      continue;
    }
    if (entry.isDirectory()) {
      onDirectory();
      await walkArtifacts(root, absolute, files, byTopLevel, onDirectory, onSymlink);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const stat = await lstat(absolute);
    const topLevel = relativePath.split('/')[0] || '.';
    const group = byTopLevel.get(topLevel) ?? { directory: topLevel, total_bytes: 0, file_count: 0 };
    group.total_bytes += stat.size;
    group.file_count += 1;
    byTopLevel.set(topLevel, group);
    files.push({
      path: relativePath,
      absolute_path: absolute,
      top_level_directory: topLevel,
      size_bytes: stat.size,
      mtime_ms: Math.trunc(stat.mtimeMs)
    });
  }
}

function selectCleanupCandidates(files, { maxBytes, olderThanMs, nowMs, totalBytes }) {
  const eligible = files
    .filter((file) => file.top_level_directory !== 'receipts')
    .filter((file) => olderThanMs === null || nowMs - file.mtime_ms >= olderThanMs)
    .sort((left, right) => left.mtime_ms - right.mtime_ms);
  if (olderThanMs !== null) {
    return eligible;
  }
  let projectedTotal = totalBytes;
  const selected = [];
  for (const file of eligible) {
    if (projectedTotal <= maxBytes) {
      break;
    }
    selected.push(file);
    projectedTotal -= file.size_bytes;
  }
  return selected;
}

async function removeEmptyDirectories(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'receipts') {
      continue;
    }
    const absolute = path.join(root, entry.name);
    await removeEmptyDirectories(absolute).catch(() => {});
    await rm(absolute, { recursive: false }).catch(() => {});
  }
}

function parseByteSize(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const text = String(value).trim().toLowerCase();
  const match = /^(\d+)(?:\s*(b|kb|kib|mb|mib|gb|gib))?$/.exec(text);
  if (!match) {
    throw new Error('max-bytes must be an integer byte size such as 1048576, 512mb, or 1gib.');
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] ?? 'b';
  const multiplier = {
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1000 * 1000,
    mib: 1024 * 1024,
    gb: 1000 * 1000 * 1000,
    gib: 1024 * 1024 * 1024
  }[unit];
  const bytes = amount * multiplier;
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error('max-bytes must be a safe non-negative integer byte size.');
  }
  return bytes;
}

function relativeCandidate(candidate) {
  return {
    path: candidate.path,
    size_bytes: candidate.size_bytes,
    mtime_ms: candidate.mtime_ms
  };
}

function warningsForArtifactUsage(summary, proposal) {
  if (proposal.candidate_count === 0) {
    return [];
  }
  return [{
    code: 'ARTIFACT_CLEANUP_AVAILABLE',
    message: 'Local TraceCue artifacts exceed the configured cleanup policy.',
    details: {
      artifact_root: summary.artifact_root,
      total_bytes: summary.total_bytes,
      candidate_count: proposal.candidate_count,
      candidate_bytes: proposal.candidate_bytes
    }
  }];
}

function artifactBoundary({ cacheDeleted, artifactsWritten }) {
  return {
    local_only: true,
    browser_launched: false,
    artifacts_written: artifactsWritten,
    external_upload: false,
    profile_reuse: false,
    system_cache_mutated: false,
    swap_mutated: false,
    cache_deleted: cacheDeleted,
    deletion_scope: cacheDeleted ? 'artifact_root_only' : 'none',
    privileged_helper_used: false,
    shell_used: false,
    arbitrary_process_control: false
  };
}

function artifactError(code, message, details) {
  return {
    status: 'error',
    data: {},
    warnings: [],
    errors: [{ code, message: truncateText(message, 1000), details: redact(details ?? {}) }],
    artifacts: []
  };
}

function materializeNow(now) {
  if (!now) {
    return new Date();
  }
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value : new Date(value);
}
