#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  loadVerificationPolicy,
  runVerificationPlan
} from './verification-orchestration.mjs';
import { verifyCiProofImport } from './ci-proof-import.mjs';
import { checkGitSync } from '../check_git_sync.mjs';
import {
  captureProcessIdentity,
  isProcessIdentityAlive,
  readDirectoryEntriesBounded,
  withCrashSafeTransition
} from '../../src/safe-local-store.js';

const RECEIPT_VERSION = '2.2.0';
const PREVIOUS_RECEIPT_VERSION = '2.1.0';
const LEGACY_RECEIPT_VERSION = '2.0.0';
const RELEASE_BATCH_VERSION = '1.0.0';
const MAX_RELEASE_BATCH_COMMIT_BYTES = 16 * 1024;
const MARKER_TEXT = 'product-gate-evidence-v2\n';
const ARCHIVE_MARKER_TEXT = 'product-gate-evidence-archive-v1\n';
const MAX_METADATA_LENGTH = 4096;
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_AGE_SECONDS = 3600;
const RELEASE_BATCH_RECORD_CAPABILITY = Symbol('release-batch-record');
const RECEIPT_ADMISSION_CAPABILITY = Symbol('receipt-admission');
const CI_PROOF_RECORD_CAPABILITY = Symbol('ci-proof-record');
const MAX_DERIVED_INDEX_BYTES = 4 * 1024 * 1024;
const SOURCE_ID_PATTERN = /^(?:repositories\.product|product\.(?:docs|workflow|git|ci|security|approvals|design_system|gates))(?:\.[A-Za-z0-9_.-]+)?$/u;
const CONTEXTS = new Set(['all', 'free-development', 'product-improvement', 'external-integration', 'lesson-maintenance', 'custom']);
const STATUSES = new Set(['not_run', 'passed', 'failed', 'blocked', 'unknown', 'optional', 'cached', 'stale', 'not_applicable']);
const AUTHORITIES = new Set(['authoritative', 'manual_required', 'advisory', 'not_collected']);
const RECEIPT_FIELDS = new Set([
  'schema_version', 'kind', 'event_id', 'attempt_key', 'source_id', 'context', 'status', 'authority',
  'required_in_context', 'observed_at', 'max_age_seconds', 'product_root', 'head_sha', 'tree_sha',
  'worktree_state', 'input_fingerprint', 'policy_fingerprint', 'command_fingerprint', 'result_digest',
  'execution_mode', 'source_artifacts', 'blocked_by', 'next_command', 'detail_code', 'safe_summary',
  'reason', 'next_action', 'evidence_batch_id', 'evidence_batch_digest', 'verification_task_id'
]);
const DEFAULT_POLICY_PATHS = Object.freeze([
  'ops/EVIDENCE_DETAIL_MANIFEST.tsv',
  'ops/TEST_PLAN_MANIFEST.tsv',
  'ops/VERIFICATION_EXECUTION_POLICY.json',
  'schemas/verification-execution-policy.schema.json',
  'tools/product-gate-evidence',
  'tools/lib/product_gate_evidence.sh',
  'tools/lib/product-gate-evidence.mjs'
]);

function sha256(...values) {
  const hash = createHash('sha256');
  for (const value of values) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    hash.update(String(buffer.length));
    hash.update('\0');
    hash.update(buffer);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function rawSha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function safeId(value) {
  const text = String(value).replace(/[^A-Za-z0-9._-]/gu, '-').replace(/^-+|-+$/gu, '') || 'evidence';
  return `${text.slice(0, 80)}-${sha256(value).slice(0, 12)}`;
}

function evidenceRoot(repoRoot) {
  return path.join(repoRoot, '.git', 'product-gate-evidence');
}

function legacyEvidencePath(repoRoot) {
  return path.join(evidenceRoot(repoRoot), 'legacy');
}

function indexPath(repoRoot) {
  return path.join(evidenceRoot(repoRoot), 'index.tsv');
}

function ledgerPath(repoRoot) {
  return path.join(evidenceRoot(repoRoot), 'ledger.jsonl');
}

function receiptsPath(repoRoot) {
  return path.join(evidenceRoot(repoRoot), 'receipts-v2');
}

function detailsPath(repoRoot) {
  return path.join(evidenceRoot(repoRoot), 'details');
}

function batchesPath(repoRoot) {
  return path.join(evidenceRoot(repoRoot), 'release-batches-v1');
}

function inactiveArchivePath(repoRoot) {
  return path.join(evidenceRoot(repoRoot), 'inactive-archive-v1');
}

function markerPath(repoRoot) {
  return path.join(receiptsPath(repoRoot), '.product-gate-evidence-v2');
}

function validateRepoRoot(repoRoot) {
  const resolved = path.resolve(repoRoot);
  if (resolved === path.parse(resolved).root) throw new Error('Evidence repository root is unsafe.');
  return resolved;
}

function validateSourceId(value) {
  if (!SOURCE_ID_PATTERN.test(value)) throw new Error(`Invalid product gate evidence source_id: ${value}`);
  return value;
}

function validateContext(value) {
  if (!CONTEXTS.has(value)) throw new Error(`Invalid product gate evidence context: ${value}`);
  return value;
}

function validateStatus(value) {
  if (!STATUSES.has(value)) throw new Error(`Invalid product gate evidence status: ${value}`);
  return value;
}

function validateAuthority(value) {
  if (!AUTHORITIES.has(value)) throw new Error(`Invalid product gate evidence authority: ${value}`);
  return value;
}

function validateBoolean(value, label) {
  if (value !== true && value !== false) throw new Error(`${label} must be boolean.`);
  return value;
}

function validateAge(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Invalid product gate evidence max age: ${value}`);
  return number;
}

function parentCompatibleTimestamp(value) {
  if (value === 'not_collected') return value;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid product gate evidence timestamp: ${value}`);
  return parsed.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

async function ensureSafeDirectory(directory, mode = 0o700) {
  await mkdir(directory, { recursive: true, mode });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Product gate evidence directory is unsafe: ${path.basename(directory)}`);
  }
}

async function ensureSafeEvidenceRoot(repoRoot) {
  const gitDirectory = path.join(repoRoot, '.git');
  const gitInfo = await lstat(gitDirectory);
  if (!gitInfo.isDirectory() || gitInfo.isSymbolicLink()) throw new Error('Product gate evidence requires a safe Git directory.');
  await ensureSafeDirectory(evidenceRoot(repoRoot));
}

async function assertOptionalSafeDirectory(directory, label) {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} is unsafe.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function validateSafeMetadata(value, label, { allowEmpty = true } = {}) {
  const text = String(value ?? '');
  if ((!allowEmpty && !text) || text.length > MAX_METADATA_LENGTH || /[\0\r\n]/u.test(text)) {
    throw new Error(`${label} must be a bounded single-line value.`);
  }
  const absoluteUnix = /(^|[\s='"(])\/(?:home|tmp|var|etc|Users|mnt)\//u;
  const absoluteWindows = /(?:^|[\s='"(])[A-Za-z]:[\\/]/u;
  const secretAssignment = /(?:^|\b)(?:authorization|cookie|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\s*[:=]\s*\S+/iu;
  const environmentAssignment = /(?:^|\s)[A-Z][A-Z0-9_]{2,}=\S+/u;
  if (absoluteUnix.test(text) || absoluteWindows.test(text) || text.includes('://') || secretAssignment.test(text) || environmentAssignment.test(text) || /-----BEGIN [A-Z ]+PRIVATE KEY-----/u.test(text)) {
    throw new Error(`${label} contains forbidden path, environment, URL, or secret-bearing data.`);
  }
  return text;
}

function runGit(repoRoot, args, { buffer = false, allowFailure = false } = {}) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: buffer ? null : 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr ?? '').trim()}`);
  }
  return result;
}

async function hashUntrackedFiles(repoRoot, paths) {
  const records = [];
  for (const relativePath of paths.sort()) {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/u).includes('..')) {
      throw new Error(`Unsafe untracked evidence input path: ${relativePath}`);
    }
    const absolute = path.resolve(repoRoot, relativePath);
    const relative = path.relative(repoRoot, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Evidence input escapes repository: ${relativePath}`);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      records.push([relativePath, 'symlink', sha256(await readlink(absolute))]);
    } else if (info.isFile()) {
      if (info.size > MAX_UNTRACKED_FILE_BYTES) throw new Error(`Untracked evidence input is too large: ${relativePath}`);
      records.push([relativePath, 'file', sha256(await readFile(absolute))]);
    } else {
      records.push([relativePath, 'other', String(info.mode)]);
    }
  }
  return records;
}

export async function snapshotRepository(repoRootInput) {
  const repoRoot = validateRepoRoot(repoRootInput);
  const headSha = String(runGit(repoRoot, ['rev-parse', 'HEAD']).stdout).trim();
  const treeSha = String(runGit(repoRoot, ['rev-parse', 'HEAD^{tree}']).stdout).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(headSha) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(treeSha)) throw new Error('Git HEAD or tree SHA is not a full object id.');
  const status = runGit(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { buffer: true }).stdout;
  const staged = runGit(repoRoot, ['diff', '--cached', '--binary', '--no-ext-diff', 'HEAD'], { buffer: true }).stdout;
  const unstaged = runGit(repoRoot, ['diff', '--binary', '--no-ext-diff'], { buffer: true }).stdout;
  const untrackedRaw = runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'], { buffer: true }).stdout;
  const untracked = untrackedRaw.toString('utf8').split('\0').filter(Boolean);
  const untrackedRecords = await hashUntrackedFiles(repoRoot, untracked);
  return Object.freeze({
    head_sha: headSha,
    tree_sha: treeSha,
    worktree_state: status.length === 0 ? 'clean' : 'dirty',
    input_fingerprint: sha256(status, staged, unstaged, stableJson(untrackedRecords))
  });
}

export async function computePolicyFingerprint(repoRootInput, policyPaths = DEFAULT_POLICY_PATHS) {
  const repoRoot = validateRepoRoot(repoRootInput);
  const records = [];
  for (const relativePath of [...policyPaths].sort()) {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.split('/').includes('..')) throw new Error(`Unsafe evidence policy path: ${relativePath}`);
    const absolute = path.join(repoRoot, relativePath);
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error(`Unsafe evidence policy authority: ${relativePath}`);
    records.push([relativePath, sha256(await readFile(absolute))]);
  }
  if (records.length === 0) throw new Error('No product gate evidence policy authorities were found.');
  return sha256(stableJson(records));
}

function commandFingerprint(argv, environmentProfile = 'local') {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((entry) => typeof entry !== 'string' || !entry || /[\0\r\n]/u.test(entry))) {
    throw new Error('Evidence command argv must be a non-empty array of bounded strings.');
  }
  return sha256(stableJson({ argv, environment_profile: environmentProfile }));
}

function freshnessForReceipt(receipt, snapshot, policyFingerprint, evidencePolicy, now = Date.now()) {
  if (receipt.status === 'not_run' || receipt.status === 'not_applicable') return 'not_collected';
  if (receipt.schema_version !== RECEIPT_VERSION) return 'stale';
  const observed = Date.parse(receipt.observed_at);
  if (!Number.isFinite(observed)
    || observed - now > evidencePolicy.max_future_observation_skew_ms
    || now - observed > receipt.max_age_seconds * 1000) return 'stale';
  if (
    receipt.head_sha !== snapshot.head_sha
    || receipt.tree_sha !== snapshot.tree_sha
    || receipt.input_fingerprint !== snapshot.input_fingerprint
    || receipt.worktree_state !== snapshot.worktree_state
    || receipt.policy_fingerprint !== policyFingerprint
  ) return 'stale';
  return 'current';
}

function buildHumanFields(sourceId, status, sourceArtifacts, blockedBy, nextCommand) {
  const safeSummary = `${sourceId} ${status}`;
  const reason = status === 'passed'
    ? `Recorded evidence passed using ${sourceArtifacts || 'declared product checks'}.`
    : status === 'not_run' || status === 'not_applicable'
      ? 'No executable evidence was collected for this source.'
      : `Recorded evidence requires attention; blocked_by=${blockedBy || 'none'}.`;
  const nextAction = status === 'passed' || status === 'not_applicable'
    ? 'Inspect details when a workflow decision needs supporting evidence.'
    : `Review the source-specific detail and rerun the displayed command preview: ${nextCommand || 'not_applicable'}`;
  return { safeSummary, reason, nextAction };
}

async function prepareReceiptDirectory(repoRoot) {
  const directory = receiptsPath(repoRoot);
  await ensureSafeEvidenceRoot(repoRoot);
  await ensureSafeDirectory(directory);
  const marker = markerPath(repoRoot);
  try {
    const handle = await open(marker, 'wx', 0o600);
    try {
      await handle.writeFile(MARKER_TEXT, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const markerInfo = await lstat(marker);
    if (markerInfo.isFile() && !markerInfo.isSymbolicLink() && await readFile(marker, 'utf8') === MARKER_TEXT) return directory;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Product gate evidence marker is unsafe or invalid.');
}

async function prepareInactiveArchive(repoRoot, kind) {
  if (!['receipts', 'release-batches'].includes(kind)) throw new Error('Evidence archive kind is invalid.');
  await ensureSafeEvidenceRoot(repoRoot);
  const root = inactiveArchivePath(repoRoot);
  const marker = path.join(root, '.product-gate-evidence-archive-v1');
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const initializing = path.join(evidenceRoot(repoRoot), `.inactive-archive-v1.initializing-${process.pid}-${randomUUID()}`);
    await mkdir(initializing, { mode: 0o700 });
    let published = false;
    try {
      const handle = await open(path.join(initializing, path.basename(marker)), 'wx', 0o600);
      try {
        await handle.writeFile(ARCHIVE_MARKER_TEXT, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(initializing);
      await rename(initializing, root);
      published = true;
      await syncDirectory(evidenceRoot(repoRoot));
    } finally {
      if (!published) await rm(initializing, { recursive: true, force: true }).catch(() => {});
    }
    rootInfo = await lstat(root);
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('Evidence inactive archive root is unsafe.');
  }
  let markerInfo;
  try {
    markerInfo = await lstat(marker);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('Evidence inactive archive is not owned by this store.');
    throw error;
  }
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.nlink !== 1
    || await readFile(marker, 'utf8') !== ARCHIVE_MARKER_TEXT) {
    throw new Error('Evidence inactive archive marker is unsafe or invalid.');
  }
  const destination = path.join(root, kind);
  await ensureSafeDirectory(destination);
  return destination;
}

async function tryWriteReceipt(repoRoot, evidencePolicy, receipt, serialized, reservation = null) {
  const directory = await prepareReceiptDirectory(repoRoot);
  const limits = evidencePolicy.store_limits;
  const claim = path.join(directory, safeId(receipt.event_id));
  const current = await readReceipts(repoRoot, evidencePolicy);
  const reservedCount = reservation?.count ?? 0;
  const reservedBytes = reservation?.bytes ?? 0;
  if (!Number.isSafeInteger(reservedCount) || reservedCount < 0
    || !Number.isSafeInteger(reservedBytes) || reservedBytes < 0) {
    throw new Error('Evidence receipt admission reservation is invalid.');
  }
  const hardCount = limits.receipt_retention_count + limits.ingress_overflow_count + reservedCount;
  const hardBytes = limits.receipt_retention_bytes + limits.ingress_overflow_bytes + reservedBytes;
  if (current.entry_count >= hardCount || current.total_bytes + Buffer.byteLength(serialized) > hardBytes) {
    return { stored: false, capacity: true };
  }
  await mkdir(claim, { mode: 0o700 });
  const receiptFile = path.join(claim, 'receipt.json');
  await atomicWrite(receiptFile, serialized);
  return { stored: true, capacity: false, receiptFile };
}

async function writeAdmittedReceipt(repoRoot, evidencePolicy, receipt, {
  receiptAdmissionToken,
  indexLockHeld = false,
  receiptAdmissionReservation = null
} = {}) {
  const serialized = `${stableJson(receipt)}\n`;
  await prepareReceiptDirectory(repoRoot);
  if (receiptAdmissionToken === RECEIPT_ADMISSION_CAPABILITY) {
    let retentionAttempted = false;
    while (true) {
      const admitted = await tryWriteReceipt(repoRoot, evidencePolicy, receipt, serialized, receiptAdmissionReservation);
      if (admitted.stored) return admitted.receiptFile;
      if (retentionAttempted) throw new Error('Product gate evidence receipt store has no safe retention capacity.');
      if (!indexLockHeld) throw new Error('Receipt admission capability requires the evidence index lock.');
      await rebuildDerivedEvidenceLocked(repoRoot);
      retentionAttempted = true;
    }
  }

  const limits = evidencePolicy.store_limits;
  const started = Date.now();
  let retentionAttempted = false;
  while (true) {
    const remainingMs = limits.lock_timeout_ms - (Date.now() - started);
    if (remainingMs <= 0) throw new Error('Timed out waiting for product gate evidence receipt admission.');
    const admitted = await withCrashSafeTransition({
      directory: evidenceRoot(repoRoot),
      prefix: '.receipt-admission.transition-',
      timeoutMs: remainingMs,
      task: () => tryWriteReceipt(repoRoot, evidencePolicy, receipt, serialized)
    });
    if (admitted.entered && admitted.value?.stored) return admitted.value.receiptFile;
    if (admitted.entered && admitted.value?.capacity) {
      if (retentionAttempted) throw new Error('Product gate evidence receipt store has no safe retention capacity.');
      await rebuildDerivedEvidence(repoRoot);
      retentionAttempted = true;
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, limits.lock_timeout_ms - (Date.now() - started)))));
  }
}

async function withReceiptAdmission(repoRoot, evidencePolicy, task) {
  await prepareReceiptDirectory(repoRoot);
  const timeoutMs = evidencePolicy.store_limits.lock_timeout_ms;
  const started = Date.now();
  while (true) {
    const remainingMs = timeoutMs - (Date.now() - started);
    if (remainingMs <= 0) throw new Error('Timed out waiting for product gate evidence receipt admission.');
    const admitted = await withCrashSafeTransition({
      directory: evidenceRoot(repoRoot),
      prefix: '.receipt-admission.transition-',
      timeoutMs: remainingMs,
      task
    });
    if (admitted.entered) return admitted.value;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, timeoutMs - (Date.now() - started)))));
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicWrite(file, text, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await handle?.close();
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function validateReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Evidence receipt must be an object.');
  const unknown = Object.keys(receipt).filter((key) => !RECEIPT_FIELDS.has(key));
  if (unknown.length) throw new Error(`Evidence receipt contains forbidden or unknown fields: ${unknown.join(', ')}`);
  if (![LEGACY_RECEIPT_VERSION, PREVIOUS_RECEIPT_VERSION, RECEIPT_VERSION].includes(receipt.schema_version) || receipt.kind !== 'product-gate-evidence-receipt') throw new Error('Unsupported product gate evidence receipt.');
  validateSourceId(receipt.source_id);
  validateContext(receipt.context);
  validateStatus(receipt.status);
  validateAuthority(receipt.authority);
  validateBoolean(receipt.required_in_context, 'required_in_context');
  validateAge(receipt.max_age_seconds);
  const observedAt = Date.parse(receipt.observed_at);
  if (!Number.isFinite(observedAt) || new Date(observedAt).toISOString() !== receipt.observed_at) {
    throw new Error('Evidence observed_at must be a canonical UTC timestamp.');
  }
  for (const field of ['head_sha', 'tree_sha']) if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(receipt[field])) throw new Error(`Evidence ${field} must be a full SHA.`);
  for (const field of ['input_fingerprint', 'policy_fingerprint', 'command_fingerprint', 'result_digest', 'attempt_key']) {
    if (!/^[0-9a-f]{64}$/u.test(receipt[field])) throw new Error(`Evidence ${field} must be SHA-256.`);
  }
  if (!['clean', 'dirty'].includes(receipt.worktree_state)) throw new Error('Evidence worktree_state is invalid.');
  if (!['manual', 'executed', 'git-observation', 'ci-proof-import'].includes(receipt.execution_mode)) throw new Error('Evidence execution_mode is invalid.');
  for (const field of ['event_id', 'observed_at', 'product_root', 'execution_mode', 'source_artifacts', 'blocked_by', 'next_command', 'detail_code', 'safe_summary', 'reason', 'next_action']) {
    validateSafeMetadata(receipt[field], field, { allowEmpty: ['source_artifacts', 'blocked_by', 'next_command'].includes(field) });
  }
  if (!Number.isFinite(Date.parse(receipt.observed_at))) throw new Error('Evidence observed_at is invalid.');
  const batchFields = [receipt.evidence_batch_id, receipt.evidence_batch_digest, receipt.verification_task_id];
  if (batchFields.some((value) => value !== undefined)) {
    if (receipt.schema_version !== RECEIPT_VERSION
      || !/^release-[a-f0-9]{32}$/u.test(receipt.evidence_batch_id ?? '')
      || !/^[a-f0-9]{64}$/u.test(receipt.evidence_batch_digest ?? '')
      || !/^[a-z0-9][a-z0-9_-]*$/u.test(receipt.verification_task_id ?? '')) {
      throw new Error('Evidence release batch binding is invalid.');
    }
  }
  const expectedAttemptKey = sha256(stableJson({
    sourceId: receipt.source_id,
    context: receipt.context,
    observedAt: receipt.observed_at,
    head: receipt.head_sha,
    tree: receipt.tree_sha,
    input: receipt.input_fingerprint,
    policy: receipt.policy_fingerprint,
    command: receipt.command_fingerprint,
    eventId: receipt.event_id,
    ...(receipt.schema_version === RECEIPT_VERSION ? {
      evidenceBatchId: receipt.evidence_batch_id ?? null,
      evidenceBatchDigest: receipt.evidence_batch_digest ?? null,
      verificationTaskId: receipt.verification_task_id ?? null
    } : {})
  }));
  if (receipt.attempt_key !== expectedAttemptKey) throw new Error('Evidence receipt attempt_key integrity check failed.');
  const expectedResultDigest = receipt.schema_version === LEGACY_RECEIPT_VERSION
    ? sha256(stableJson({ status: receipt.status, authority: receipt.authority, blockedBy: receipt.blocked_by }))
    : sha256(stableJson(Object.fromEntries(
      Object.entries(receipt).filter(([field]) => field !== 'result_digest')
    )));
  if (receipt.result_digest !== expectedResultDigest) throw new Error('Evidence receipt result_digest integrity check failed.');
  if (receipt.status === 'passed' && receipt.worktree_state === 'dirty' && receipt.authority === 'authoritative') {
    throw new Error('Dirty successful evidence cannot be authoritative.');
  }
  if (receipt.execution_mode === 'manual' && receipt.authority === 'authoritative') throw new Error('Manual evidence cannot be authoritative.');
  return receipt;
}

export async function recordEvidence({
  repoRoot: repoRootInput,
  sourceId,
  context,
  status,
  requiredInContext = true,
  authority,
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
  sourceArtifacts = '',
  blockedBy = '',
  nextCommand = '',
  executionMode,
  argv = ['manual'],
  snapshot,
  policyFingerprint,
  evidenceBatchId,
  evidenceBatchDigest,
  verificationTaskId,
  releaseBatchToken,
  receiptAdmissionToken,
  receiptAdmissionReservation,
  indexLockHeld = false,
  ciProofRecordToken,
  rebuild = true,
  now = new Date()
}) {
  const repoRoot = validateRepoRoot(repoRootInput);
  validateSourceId(sourceId);
  validateContext(context);
  validateStatus(status);
  validateBoolean(requiredInContext, 'requiredInContext');
  const age = validateAge(maxAgeSeconds);
  const safeArtifacts = validateSafeMetadata(sourceArtifacts, 'source_artifacts');
  const safeBlockedBy = validateSafeMetadata(blockedBy, 'blocked_by');
  const safeNextCommand = validateSafeMetadata(nextCommand, 'next_command');
  const evidencePolicy = await readVerificationEvidencePolicy(repoRoot);
  const observationTime = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(observationTime)
    || observationTime - Date.now() > evidencePolicy.max_future_observation_skew_ms) {
    throw new Error('Evidence observation time is invalid or too far in the future.');
  }
  const currentSnapshot = snapshot ?? await snapshotRepository(repoRoot);
  const currentPolicy = policyFingerprint ?? await computePolicyFingerprint(repoRoot);
  let effectiveAuthority = authority ?? (executionMode === 'manual' ? 'manual_required' : 'authoritative');
  if (executionMode === 'manual') effectiveAuthority = 'manual_required';
  if (status === 'passed' && currentSnapshot.worktree_state !== 'clean') effectiveAuthority = 'advisory';
  validateAuthority(effectiveAuthority);
  const observedAt = now.toISOString();
  const eventId = `${observedAt.replace(/[^0-9TZ]/gu, '-')}-${safeId(sourceId)}-${randomUUID()}`;
  const commandDigest = commandFingerprint(argv);
  const human = buildHumanFields(sourceId, status, safeArtifacts, safeBlockedBy, safeNextCommand);
  const hasBatchBinding = Boolean(evidenceBatchId || evidenceBatchDigest || verificationTaskId);
  if (hasBatchBinding && releaseBatchToken !== RELEASE_BATCH_RECORD_CAPABILITY) {
    throw new Error('Release batch evidence can only be recorded by the complete release recorder.');
  }
  if (receiptAdmissionReservation !== undefined
    && receiptAdmissionToken !== RECEIPT_ADMISSION_CAPABILITY) {
    throw new Error('Evidence receipt admission reservations are internal to complete release recording.');
  }
  const claimsAuthoritativeCiPass = sourceId === evidencePolicy.ci_proof_source_id
    && status === 'passed'
    && effectiveAuthority === 'authoritative';
  if ((executionMode === 'ci-proof-import' || claimsAuthoritativeCiPass)
    && ciProofRecordToken !== CI_PROOF_RECORD_CAPABILITY) {
    throw new Error('CI proof evidence can only be recorded by the authenticated proof importer.');
  }
  const batchBinding = hasBatchBinding
    ? {
        evidence_batch_id: evidenceBatchId,
        evidence_batch_digest: evidenceBatchDigest,
        verification_task_id: verificationTaskId
      }
    : {};
  const attemptKey = sha256(stableJson({
    sourceId,
    context,
    observedAt,
    head: currentSnapshot.head_sha,
    tree: currentSnapshot.tree_sha,
    input: currentSnapshot.input_fingerprint,
    policy: currentPolicy,
    command: commandDigest,
    eventId,
    evidenceBatchId: evidenceBatchId ?? null,
    evidenceBatchDigest: evidenceBatchDigest ?? null,
    verificationTaskId: verificationTaskId ?? null
  }));
  const receiptFields = {
    schema_version: RECEIPT_VERSION,
    kind: 'product-gate-evidence-receipt',
    event_id: eventId,
    attempt_key: attemptKey,
    source_id: sourceId,
    context,
    status,
    authority: effectiveAuthority,
    required_in_context: requiredInContext,
    observed_at: observedAt,
    max_age_seconds: age,
    product_root: `[external-product-repository]/${path.basename(repoRoot)}`,
    head_sha: currentSnapshot.head_sha,
    tree_sha: currentSnapshot.tree_sha,
    worktree_state: currentSnapshot.worktree_state,
    input_fingerprint: currentSnapshot.input_fingerprint,
    policy_fingerprint: currentPolicy,
    command_fingerprint: commandDigest,
    execution_mode: executionMode,
    source_artifacts: safeArtifacts,
    blocked_by: safeBlockedBy,
    next_command: safeNextCommand,
    detail_code: `${safeId(sourceId)}.detail`,
    safe_summary: human.safeSummary,
    reason: human.reason,
    next_action: human.nextAction,
    ...batchBinding
  };
  const receipt = validateReceipt({
    ...receiptFields,
    result_digest: sha256(stableJson(receiptFields))
  });
  const receiptFile = await writeAdmittedReceipt(repoRoot, evidencePolicy, receipt, {
    receiptAdmissionToken,
    indexLockHeld,
    receiptAdmissionReservation
  });
  if (rebuild) await ensureReceiptProjected(repoRoot, receipt.event_id);
  return { receipt, path: receiptFile };
}

async function recordVerifiedCiProofEvidence({
  repoRoot: repoRootInput,
  context,
  proof,
  remoteObservation,
  now = new Date()
}) {
  const repoRoot = validateRepoRoot(repoRootInput);
  validateContext(context);
  const authority = await readVerificationPolicyDocument(repoRoot);
  const policy = authority.policy.evidence_policy;
  const snapshot = await snapshotRepository(repoRoot);
  if (snapshot.worktree_state !== 'clean' || proof?.head_sha !== snapshot.head_sha || proof?.tree_sha !== snapshot.tree_sha) {
    throw new Error('CI proof evidence requires the current clean checkout revision.');
  }
  if (!remoteObservation || proof.repository !== remoteObservation.repository
    || String(proof.run_id) !== String(remoteObservation.run_id)
    || Number(proof.run_attempt) !== Number(remoteObservation.run_attempt)
    || proof.workflow_path !== remoteObservation.workflow_path
    || proof.artifact_name !== remoteObservation.artifact_name
    || !/^[a-f0-9]{64}$/u.test(proof.proof_digest ?? '')
    || !Number.isSafeInteger(Number(remoteObservation.artifact_id))
    || Number(remoteObservation.artifact_id) <= 0) {
    throw new Error('CI proof evidence remote observation is inconsistent.');
  }
  return recordEvidence({
    repoRoot,
    sourceId: policy.ci_proof_source_id,
    context,
    status: 'passed',
    requiredInContext: false,
    authority: 'authoritative',
    maxAgeSeconds: 3600,
    sourceArtifacts: `GitHub Actions run=${proof.run_id};attempt=${proof.run_attempt};artifact=${proof.artifact_name}`,
    blockedBy: '',
    nextCommand: 'npm run verification:ci-proof:import',
    executionMode: 'ci-proof-import',
    argv: ['node', 'tools/verification.mjs', 'import-ci-proof', '--run-id', String(proof.run_id)],
    snapshot,
    policyFingerprint: await computePolicyFingerprint(repoRoot),
    ciProofRecordToken: CI_PROOF_RECORD_CAPABILITY,
    now
  });
}

async function recordReleaseEvidenceBatch({
  repoRoot: repoRootInput,
  context = 'free-development',
  plan,
  result,
  beforeSnapshot,
  afterSnapshot,
  now = new Date()
}) {
  const repoRoot = validateRepoRoot(repoRootInput);
  validateContext(context);
  const verificationAuthority = await readVerificationPolicyDocument(repoRoot);
  const verificationPolicy = verificationAuthority.policy;
  const policy = verificationPolicy.evidence_policy;
  if (policy.release_batch_required !== true) throw new Error('Release evidence batching is not enabled by verification policy.');
  if (plan?.profile !== policy.release_profile || result?.profile !== policy.release_profile
    || plan?.scope !== 'complete' || result?.scope !== 'complete') {
    throw new Error('Release evidence requires the complete configured release profile.');
  }
  if (result.status !== 'passed' || result.release_ready_claim_allowed !== true || result.worktree_preserved !== true) {
    throw new Error('Release evidence requires one fully passed, worktree-preserving release run.');
  }
  const expectedTasks = expectedProfileTasks(verificationPolicy, policy.release_profile);
  if (stableJson(plan.tasks) !== stableJson(expectedTasks)) {
    throw new Error('Release evidence plan does not match the complete current release profile.');
  }
  const before = beforeSnapshot ?? await snapshotRepository(repoRoot);
  const after = afterSnapshot ?? await snapshotRepository(repoRoot);
  assertMatchingCleanSnapshots(before, after);
  const policyFingerprint = await computePolicyFingerprint(repoRoot);
  if (plan.policy_fingerprint !== verificationAuthority.fingerprint
    || result.policy_fingerprint !== verificationAuthority.fingerprint) {
    throw new Error('Release evidence policy changed before the batch was recorded.');
  }
  const resultById = new Map(result.results?.map((entry) => [entry.id, entry]) ?? []);
  if (resultById.size !== plan.tasks.length || plan.tasks.some((task) => resultById.get(task.id)?.status !== 'passed')) {
    throw new Error('Release evidence task results are incomplete or failed.');
  }
  const requirements = await readEvidenceRequirements(repoRoot);
  const sourceBindings = [];
  const sourceOwners = new Map();
  for (const task of plan.tasks) {
    for (const sourceId of task.provides) {
      if (!requirements.has(sourceId)) continue;
      validateSourceId(sourceId);
      if (sourceOwners.has(sourceId)) throw new Error(`Release evidence source has multiple task owners: ${sourceId}`);
      sourceOwners.set(sourceId, task.id);
      sourceBindings.push({
        source_id: sourceId,
        task_id: task.id,
        command_fingerprint: commandFingerprint(task.argv)
      });
    }
  }
  const requiredSources = [...requirements]
    .filter(([, requirement]) => requirement.requiredMode === 'required' && requirementApplies(requirement, context))
    .map(([sourceId]) => sourceId)
    .sort();
  const missing = requiredSources.filter((sourceId) => !sourceOwners.has(sourceId));
  if (missing.length) throw new Error(`Release evidence policy does not mechanically own required source(s): ${missing.join(', ')}`);
  const taskResults = plan.tasks.map((task) => {
    const taskResult = resultById.get(task.id);
    return {
      id: task.id,
      status: taskResult.status,
      exit_code: taskResult.exit_code,
      reason: taskResult.reason,
      duration_ms: taskResult.duration_ms,
      output_digest: sha256(taskResult.output ?? '')
    };
  });
  const createdAt = now.toISOString();
  const commandBindings = expectedTasks.map((task) => ({
    id: task.id,
    command_fingerprint: commandFingerprint(task.argv)
  }));
  const toolFingerprint = sha256(stableJson({
    tree_sha: after.tree_sha,
    command_bindings: commandBindings
  }));
  const graphFingerprint = sha256(stableJson({
    release_tasks: expectedTasks.map((task) => ({
      id: task.id,
      kind: task.kind,
      locks: task.locks,
      depends_on: task.depends_on,
      provides: task.provides
    })),
    ci_graph: verificationPolicy.ci_graph
  }));
  const configurationFingerprint = sha256(stableJson({
    limits: verificationPolicy.limits,
    cache_policy: verificationPolicy.cache_policy,
    evidence_policy: verificationPolicy.evidence_policy
  }));
  const artifactDigest = await computeReleaseArtifactDigest(repoRoot, policy.release_artifact_paths);
  const seed = {
    context,
    created_at: createdAt,
    head_sha: after.head_sha,
    tree_sha: after.tree_sha,
    input_fingerprint: after.input_fingerprint,
    policy_fingerprint: policyFingerprint,
    verification_policy_fingerprint: verificationAuthority.fingerprint,
    tool_fingerprint: toolFingerprint,
    graph_fingerprint: graphFingerprint,
    configuration_fingerprint: configurationFingerprint,
    artifact_digest: artifactDigest,
    plan_digest: sha256(stableJson(plan)),
    result_digest: sha256(stableJson(result)),
    task_results: taskResults,
    source_bindings: sourceBindings
  };
  const batchId = `release-${sha256(stableJson(seed)).slice(0, 32)}`;
  const batchFields = {
    schema_version: RELEASE_BATCH_VERSION,
    kind: 'verification-release-evidence-batch',
    batch_id: batchId,
    profile: policy.release_profile,
    context,
    created_at: createdAt,
    before_snapshot: before,
    after_snapshot: after,
    policy_fingerprint: policyFingerprint,
    verification_policy_fingerprint: verificationAuthority.fingerprint,
    tool_fingerprint: toolFingerprint,
    graph_fingerprint: graphFingerprint,
    configuration_fingerprint: configurationFingerprint,
    artifact_digest: artifactDigest,
    plan_digest: seed.plan_digest,
    result_digest: seed.result_digest,
    worktree_preserved: true,
    release_ready_claim_allowed: true,
    task_results: taskResults,
    source_bindings: sourceBindings.sort((a, b) => a.source_id.localeCompare(b.source_id)),
    ci_proof_included: false,
    remote_ci_replaces_local_release: false
  };
  const batch = validateReleaseBatch({
    ...batchFields,
    batch_digest: sha256(stableJson(batchFields))
  });
  if (batch.source_bindings.length > policy.store_limits.receipt_retention_count) {
    throw new Error('The configured receipt retention capacity cannot hold one complete release batch.');
  }
  const receiptAdmissionReservation = {
    count: batch.source_bindings.length,
    bytes: policy.store_limits.receipt_retention_bytes
  };
  const releaseLock = await acquireIndexLock(repoRoot);
  const recorded = [];
  try {
    try {
      await withReceiptAdmission(repoRoot, policy, async () => {
        await ensureReleaseBatchAdmission(repoRoot, policy, batch);
        await writeReleaseBatch(repoRoot, batch);
        for (const binding of batch.source_bindings) {
          const task = plan.tasks.find((candidate) => candidate.id === binding.task_id);
          const requirement = requirements.get(binding.source_id);
          recorded.push(await recordEvidence({
            repoRoot,
            sourceId: binding.source_id,
            context,
            status: 'passed',
            requiredInContext: requirement.requiredMode === 'required' && requirementApplies(requirement, context),
            authority: 'authoritative',
            sourceArtifacts: `verification release task=${task.id};batch=${batch.batch_id}`,
            blockedBy: '',
            nextCommand: 'npm run verification:release:evidence',
            executionMode: 'executed',
            argv: task.argv,
            snapshot: after,
            policyFingerprint,
            evidenceBatchId: batch.batch_id,
            evidenceBatchDigest: batch.batch_digest,
            verificationTaskId: task.id,
            releaseBatchToken: RELEASE_BATCH_RECORD_CAPABILITY,
            receiptAdmissionToken: RECEIPT_ADMISSION_CAPABILITY,
            receiptAdmissionReservation,
            indexLockHeld: true,
            rebuild: false,
            now
          }));
        }
        const receiptBytes = recorded.reduce((total, entry) => total + Buffer.byteLength(`${stableJson(entry.receipt)}\n`), 0);
        if (receiptBytes > policy.store_limits.receipt_retention_bytes) {
          throw new Error('The configured receipt retention bytes cannot hold one complete release batch.');
        }
        await commitReleaseBatch(repoRoot, batch, recorded.map(({ receipt }) => receipt));
      });
    } catch (error) {
      await rebuildDerivedEvidenceLocked(repoRoot).catch(() => {});
      throw error;
    }
  } finally {
    await releaseLock();
  }
  await rebuildDerivedEvidence(repoRoot);
  return { batch, recorded, path: path.join(batchesPath(repoRoot), batch.batch_id, 'batch.json') };
}

export async function runReleaseVerificationAndRecord({
  loadedPolicy,
  plan,
  context,
  jobs,
  signal
}) {
  const repoRoot = validateRepoRoot(loadedPolicy?.root);
  if (!plan || plan.profile !== loadedPolicy.policy?.evidence_policy?.release_profile) {
    throw new Error('Release evidence execution requires the configured release profile.');
  }
  const beforeSnapshot = await snapshotRepository(repoRoot);
  if (beforeSnapshot.worktree_state !== 'clean') {
    throw new Error('Release evidence execution requires a clean worktree before verification starts.');
  }
  const result = await runVerificationPlan({ loadedPolicy, plan, jobs, signal });
  if (result.status !== 'passed') return { result, evidenceBatch: null };
  let recordedResult = result;
  const gitSyncTask = plan.tasks.find((task) => task.provides.includes('product.git.sync'));
  if (gitSyncTask) {
    const startedAt = Date.now();
    const observation = checkGitSync({ cwd: repoRoot });
    recordedResult = {
      ...result,
      results: result.results.map((entry) => entry.id === gitSyncTask.id
        ? {
            ...entry,
            status: 'passed',
            exit_code: 0,
            duration_ms: entry.duration_ms + (Date.now() - startedAt),
            output: `${JSON.stringify(observation)}\n`,
            reason: 'final_remote_recheck'
          }
        : entry)
    };
  }
  const evidenceBatch = await recordReleaseEvidenceBatch({
    repoRoot,
    context: context ?? loadedPolicy.policy.evidence_policy.default_context,
    plan,
    result: recordedResult,
    beforeSnapshot,
    afterSnapshot: await snapshotRepository(repoRoot)
  });
  return { result: recordedResult, evidenceBatch };
}

export async function importVerifiedCiProofEvidence({
  repoRoot: repoRootInput,
  runId,
  context
}) {
  const repoRoot = validateRepoRoot(repoRootInput);
  const loadedPolicy = await loadVerificationPolicy({ root: repoRoot });
  const snapshot = await snapshotRepository(repoRoot);
  const verified = await verifyCiProofImport({ loadedPolicy, snapshot, runId });
  const recorded = await recordVerifiedCiProofEvidence({
    repoRoot,
    context: context ?? loadedPolicy.policy.evidence_policy.ci_proof_default_context,
    proof: verified.proof,
    remoteObservation: verified.remote_observation
  });
  return {
    schema_version: verified.schema_version,
    kind: verified.kind,
    status: verified.status,
    repository: verified.repository,
    run_id: verified.run_id,
    run_attempt: verified.run_attempt,
    head_sha: verified.head_sha,
    workflow_path: verified.workflow_path,
    artifact_name: verified.artifact_name,
    proof_digest: verified.proof_digest,
    evidence_event_id: recorded.receipt.event_id
  };
}

function assertMatchingCleanSnapshots(before, after) {
  for (const snapshot of [before, after]) {
    if (!snapshot || snapshot.worktree_state !== 'clean') throw new Error('Release evidence requires a clean worktree before and after verification.');
  }
  for (const field of ['head_sha', 'tree_sha', 'input_fingerprint', 'worktree_state']) {
    if (before[field] !== after[field]) throw new Error(`Release evidence repository ${field} changed during verification.`);
  }
}

async function readVerificationPolicyDocument(repoRoot) {
  const file = path.join(repoRoot, 'ops', 'VERIFICATION_EXECUTION_POLICY.json');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('Verification evidence policy is unsafe.');
  const source = await readFile(file, 'utf8');
  return { policy: JSON.parse(source), fingerprint: rawSha256(source) };
}

async function readVerificationEvidencePolicy(repoRoot) {
  const authority = await readVerificationPolicyDocument(repoRoot);
  const policy = authority.policy.evidence_policy;
  const limits = policy?.store_limits;
  const positiveFields = [
    'lock_timeout_ms', 'stale_lock_ms', 'receipt_retention_count', 'receipt_retention_bytes',
    'release_batch_retention_count', 'release_batch_retention_bytes', 'ingress_overflow_count', 'ingress_overflow_bytes'
  ];
  if (!policy || !limits || !Number.isSafeInteger(policy.max_future_observation_skew_ms)
    || policy.max_future_observation_skew_ms < 0
    || positiveFields.some((field) => !Number.isSafeInteger(limits[field]) || limits[field] < 1)
    || limits.stale_lock_ms < limits.lock_timeout_ms) {
    throw new Error('Verification evidence store limits are invalid.');
  }
  return policy;
}

function expectedProfileTasks(policy, profile) {
  const requested = policy.profiles?.[profile];
  if (!Array.isArray(requested) || !requested.length || !Array.isArray(policy.tasks)) {
    throw new Error('Verification release profile is missing.');
  }
  const byId = new Map(policy.tasks.map((task) => [task.id, task]));
  const selected = new Set();
  const include = (id) => {
    if (selected.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new Error(`Verification release profile references unknown task: ${id}`);
    for (const dependency of task.depends_on) include(dependency);
    selected.add(id);
  };
  for (const id of requested) include(id);
  return policy.tasks.filter((task) => selected.has(task.id));
}

async function computeReleaseArtifactDigest(repoRoot, relativePaths) {
  const records = [];
  let fileCount = 0;
  let totalBytes = 0;
  const walk = async (relativePath) => {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/u).includes('..')) {
      throw new Error(`Release evidence artifact path is unsafe: ${relativePath}`);
    }
    const target = path.resolve(repoRoot, relativePath);
    const relative = path.relative(repoRoot, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Release evidence artifact escaped the repository: ${relativePath}`);
    }
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`Release evidence artifact is symlinked: ${relativePath}`);
    if (info.isDirectory()) {
      const entries = await readdir(target);
      for (const entry of entries.sort()) await walk(path.join(relativePath, entry));
      return;
    }
    if (!info.isFile() || info.nlink !== 1) throw new Error(`Release evidence artifact is not a private regular file: ${relativePath}`);
    fileCount += 1;
    totalBytes += info.size;
    if (fileCount > 2000 || totalBytes > 128 * 1024 * 1024 || info.size > 16 * 1024 * 1024) {
      throw new Error('Release evidence artifact set exceeds its bounded limits.');
    }
    records.push([relative.replaceAll('\\', '/'), info.size, sha256(await readFile(target))]);
  };
  for (const relativePath of relativePaths) await walk(relativePath);
  if (!records.length) throw new Error('Release evidence artifact set is empty.');
  return sha256(stableJson(records));
}

function validateReleaseBatch(batch) {
  const fields = [
    'schema_version', 'kind', 'batch_id', 'profile', 'context', 'created_at', 'before_snapshot',
    'after_snapshot', 'policy_fingerprint', 'verification_policy_fingerprint', 'plan_digest', 'result_digest', 'worktree_preserved',
    'tool_fingerprint', 'graph_fingerprint', 'configuration_fingerprint', 'artifact_digest',
    'release_ready_claim_allowed', 'task_results', 'source_bindings', 'ci_proof_included',
    'remote_ci_replaces_local_release', 'batch_digest'
  ];
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)
    || Object.keys(batch).some((field) => !fields.includes(field))
    || batch.schema_version !== RELEASE_BATCH_VERSION
    || batch.kind !== 'verification-release-evidence-batch'
    || !/^release-[a-f0-9]{32}$/u.test(batch.batch_id ?? '')
    || !/^[a-z0-9][a-z0-9_.-]*$/u.test(batch.profile ?? '')
    || !CONTEXTS.has(batch.context)
    || !Number.isFinite(Date.parse(batch.created_at))
    || new Date(Date.parse(batch.created_at)).toISOString() !== batch.created_at
    || batch.worktree_preserved !== true
    || batch.release_ready_claim_allowed !== true
    || batch.ci_proof_included !== false
    || batch.remote_ci_replaces_local_release !== false) {
    throw new Error('Verification release evidence batch is invalid.');
  }
  assertMatchingCleanSnapshots(batch.before_snapshot, batch.after_snapshot);
  for (const field of [
    'policy_fingerprint', 'verification_policy_fingerprint', 'tool_fingerprint', 'graph_fingerprint', 'configuration_fingerprint',
    'artifact_digest', 'plan_digest', 'result_digest', 'batch_digest'
  ]) {
    if (!/^[a-f0-9]{64}$/u.test(batch[field] ?? '')) throw new Error(`Verification release batch ${field} is invalid.`);
  }
  if (!Array.isArray(batch.task_results) || !batch.task_results.length
    || batch.task_results.some((entry) => !/^[a-z0-9][a-z0-9_-]*$/u.test(entry?.id ?? '')
      || entry.status !== 'passed' || !/^[a-f0-9]{64}$/u.test(entry.output_digest ?? ''))) {
    throw new Error('Verification release batch task results are invalid.');
  }
  if (!Array.isArray(batch.source_bindings) || !batch.source_bindings.length
    || batch.source_bindings.some((entry) => !SOURCE_ID_PATTERN.test(entry?.source_id ?? '')
      || !/^[a-z0-9][a-z0-9_-]*$/u.test(entry?.task_id ?? '')
      || !/^[a-f0-9]{64}$/u.test(entry?.command_fingerprint ?? ''))) {
    throw new Error('Verification release batch source bindings are invalid.');
  }
  const taskIds = new Set(batch.task_results.map((entry) => entry.id));
  if (new Set(batch.source_bindings.map((entry) => entry.source_id)).size !== batch.source_bindings.length
    || batch.source_bindings.some((entry) => !taskIds.has(entry.task_id))) {
    throw new Error('Verification release batch source ownership is invalid.');
  }
  const body = { ...batch };
  delete body.batch_digest;
  if (sha256(stableJson(body)) !== batch.batch_digest) throw new Error('Verification release batch digest is invalid.');
  return batch;
}

async function writeReleaseBatch(repoRoot, batch) {
  await ensureSafeEvidenceRoot(repoRoot);
  await ensureSafeDirectory(batchesPath(repoRoot));
  const directory = path.join(batchesPath(repoRoot), batch.batch_id);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Verification release batch directory is unsafe.');
  const file = path.join(directory, 'batch.json');
  try {
    const existing = validateReleaseBatch(JSON.parse(await readFile(file, 'utf8')));
    if (existing.batch_digest !== batch.batch_digest) throw new Error('Verification release batch id already has different content.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await atomicWrite(file, `${stableJson(batch)}\n`);
  }
}

async function commitReleaseBatch(repoRoot, batch, receipts) {
  const directory = path.join(batchesPath(repoRoot), batch.batch_id);
  const committedReceipts = receipts.map((receipt) => ({
    source_id: receipt.source_id,
    event_id: receipt.event_id,
    result_digest: receipt.result_digest
  })).sort((a, b) => a.source_id.localeCompare(b.source_id));
  if (committedReceipts.length !== batch.source_bindings.length
    || new Set(committedReceipts.map((receipt) => receipt.source_id)).size !== committedReceipts.length
    || stableJson(committedReceipts.map((receipt) => receipt.source_id))
      !== stableJson(batch.source_bindings.map((binding) => binding.source_id).sort())) {
    throw new Error('Verification release batch receipts are incomplete.');
  }
  const fields = {
    schema_version: '1.0.0',
    kind: 'verification-release-evidence-batch-commit',
    batch_id: batch.batch_id,
    batch_digest: batch.batch_digest,
    receipt_count: committedReceipts.length,
    receipts: committedReceipts
  };
  const commit = { ...fields, commit_digest: sha256(stableJson(fields)) };
  const file = path.join(directory, 'committed.json');
  try {
    const existing = JSON.parse(await readFile(file, 'utf8'));
    if (stableJson(existing) !== stableJson(commit)) {
      throw new Error('Verification release batch is already committed with different receipts.');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await atomicWrite(file, `${stableJson(commit)}\n`);
  }
}

async function readReleaseBatchCommit(file, batch) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_RELEASE_BATCH_COMMIT_BYTES) {
    throw new Error('Verification release batch commit marker is unsafe.');
  }
  const commit = JSON.parse(await readFile(file, 'utf8'));
  const fields = {
    schema_version: commit.schema_version,
    kind: commit.kind,
    batch_id: commit.batch_id,
    batch_digest: commit.batch_digest,
    receipt_count: commit.receipt_count,
    receipts: commit.receipts
  };
  const expectedSources = batch.source_bindings.map((binding) => binding.source_id).sort();
  const committedSources = Array.isArray(commit.receipts)
    ? commit.receipts.map((receipt) => receipt?.source_id)
    : [];
  if (commit.schema_version !== '1.0.0'
    || commit.kind !== 'verification-release-evidence-batch-commit'
    || commit.batch_id !== batch.batch_id
    || commit.batch_digest !== batch.batch_digest
    || !Number.isSafeInteger(commit.receipt_count)
    || commit.receipt_count !== batch.source_bindings.length
    || commit.receipt_count !== commit.receipts?.length
    || commit.receipts.some((receipt) => !SOURCE_ID_PATTERN.test(receipt?.source_id ?? '')
      || typeof receipt.event_id !== 'string' || !receipt.event_id
      || !/^[a-f0-9]{64}$/u.test(receipt.result_digest ?? ''))
    || new Set(committedSources).size !== committedSources.length
    || stableJson(committedSources) !== stableJson([...committedSources].sort())
    || stableJson(committedSources) !== stableJson(expectedSources)
    || sha256(stableJson(fields)) !== commit.commit_digest) {
    throw new Error('Verification release batch commit marker is invalid.');
  }
  return commit;
}

function retiredEvidenceIdentity(name) {
  const match = /^\.retired-(\d+)-(\d+)-[a-f0-9-]{36}$/u.exec(name);
  return match ? { dev: match[1], ino: match[2] } : null;
}

async function inspectRetiredEvidenceDirectory(directory, entry, { maxEntries, maxFileBytes, allowedName }) {
  const identity = retiredEvidenceIdentity(entry.name);
  if (!identity || !entry.isDirectory() || entry.isSymbolicLink()) return null;
  const retiredDirectory = path.join(directory, entry.name);
  const directoryInfo = await lstat(retiredDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
    || String(directoryInfo.dev) !== identity.dev || String(directoryInfo.ino) !== identity.ino) {
    throw new Error('Evidence retirement quarantine identity is inconsistent.');
  }
  const entries = await readDirectoryEntriesBounded(retiredDirectory, { maxEntries });
  let storageBytes = 0;
  for (const child of entries) {
    if (!allowedName(child.name) || !child.isFile() || child.isSymbolicLink()) {
      throw new Error('Evidence retirement quarantine contains an unexpected file set.');
    }
    const info = await lstat(path.join(retiredDirectory, child.name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxFileBytes) {
      throw new Error('Evidence retirement quarantine contains an unsafe file.');
    }
    storageBytes += info.size;
  }
  return {
    directory: retiredDirectory,
    directory_info: directoryInfo,
    storage_bytes: storageBytes,
    allowed_names: new Set(entries.map((child) => child.name)),
    retired: true
  };
}

function receiptStoreScanCapacity(limits) {
  // A complete release batch may temporarily coexist with the normally bounded
  // receipt set until its commit marker is durable and retention can run.
  return {
    count: (limits.receipt_retention_count * 2) + limits.ingress_overflow_count,
    bytes: (limits.receipt_retention_bytes * 2) + limits.ingress_overflow_bytes
  };
}

async function readReceipts(repoRoot, evidencePolicy) {
  const directory = receiptsPath(repoRoot);
  const limits = evidencePolicy.store_limits;
  const scanCapacity = receiptStoreScanCapacity(limits);
  let entries;
  try {
    const rootInfo = await lstat(evidenceRoot(repoRoot));
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Product gate evidence root is unsafe.');
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Product gate evidence receipt store is unsafe.');
    entries = await readDirectoryEntriesBounded(directory, {
      maxEntries: scanCapacity.count + 1
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return { receipts: [], incomplete: [], entry_count: 0, total_bytes: 0 };
    throw error;
  }
  const receipts = [];
  const incomplete = [];
  const eventIds = new Set();
  let totalBytes = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error('Product gate evidence receipt store contains a symlink.');
    if (!entry.isDirectory()) continue;
    const retired = await inspectRetiredEvidenceDirectory(directory, entry, {
      maxEntries: 2,
      maxFileBytes: 1024 * 1024,
      allowedName: (name) => name === 'receipt.json' || /^\.receipt\.json\.\d+\.[a-f0-9-]{36}\.tmp$/u.test(name)
    });
    if (retired) {
      totalBytes += retired.storage_bytes;
      incomplete.push({ ...retired, archive_kind: 'receipts' });
      continue;
    }
    if (!/^[A-Za-z0-9._-]{1,192}$/u.test(entry.name)) throw new Error('Product gate evidence receipt identity is unsafe.');
    const claimDirectory = path.join(directory, entry.name);
    const directoryInfo = await lstat(claimDirectory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error(`Unsafe product gate evidence receipt: ${entry.name}`);
    const claimEntries = await readDirectoryEntriesBounded(claimDirectory, { maxEntries: 2 });
    const claimNames = claimEntries.map((item) => item.name);
    if (!claimNames.includes('receipt.json')) {
      const pendingNames = claimNames.filter((name) => /^\.receipt\.json\.\d+\.[a-f0-9-]{36}\.tmp$/u.test(name));
      if (pendingNames.length !== claimNames.length || claimEntries.some((item) => !item.isFile() || item.isSymbolicLink())) {
        throw new Error(`Product gate evidence receipt has an unexpected file set: ${entry.name}`);
      }
      let pendingBytes = 0;
      for (const pending of pendingNames) {
        const pendingInfo = await lstat(path.join(claimDirectory, pending));
        if (!pendingInfo.isFile() || pendingInfo.isSymbolicLink() || pendingInfo.nlink !== 1 || pendingInfo.size > 1024 * 1024) {
          throw new Error(`Product gate evidence receipt has an unsafe pending file: ${entry.name}`);
        }
        pendingBytes += pendingInfo.size;
      }
      totalBytes += pendingBytes;
      incomplete.push({ directory: claimDirectory, directory_info: directoryInfo, storage_bytes: pendingBytes, allowed_names: new Set(pendingNames), archive_kind: 'receipts' });
      continue;
    }
    if (claimEntries.length !== 1 || claimEntries[0].name !== 'receipt.json' || !claimEntries[0].isFile()) {
      throw new Error(`Product gate evidence receipt has an unexpected file set: ${entry.name}`);
    }
    const file = path.join(claimDirectory, 'receipt.json');
    let info;
    try {
      info = await lstat(file);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) throw new Error(`Unsafe product gate evidence receipt: ${entry.name}`);
    totalBytes += info.size;
    if (totalBytes > scanCapacity.bytes) {
      throw new Error('Product gate evidence receipt store exceeds its bounded ingress capacity.');
    }
    const receipt = validateReceipt(JSON.parse(await readFile(file, 'utf8')));
    if (safeId(receipt.event_id) !== entry.name || eventIds.has(receipt.event_id)) {
      throw new Error('Product gate evidence receipt directory identity is inconsistent.');
    }
    eventIds.add(receipt.event_id);
    receipts.push({
      receipt,
      file,
      directory: claimDirectory,
      directory_info: directoryInfo,
      storage_bytes: info.size,
      archive_kind: 'receipts'
    });
  }
  if (totalBytes > scanCapacity.bytes) {
    throw new Error('Product gate evidence receipt store exceeds its bounded ingress capacity.');
  }
  return { receipts, incomplete, entry_count: receipts.length + incomplete.length, total_bytes: totalBytes };
}

async function readReleaseBatches(repoRoot, evidencePolicy) {
  const directory = batchesPath(repoRoot);
  const limits = evidencePolicy.store_limits;
  let entries;
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Verification release batch store is unsafe.');
    entries = await readDirectoryEntriesBounded(directory, {
      maxEntries: limits.release_batch_retention_count + limits.ingress_overflow_count
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return { batches: new Map(), records: [], total_bytes: 0 };
    throw error;
  }
  const batches = new Map();
  const records = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error('Verification release batch store contains a symlink.');
    const retired = await inspectRetiredEvidenceDirectory(directory, entry, {
      maxEntries: 3,
      maxFileBytes: 4 * 1024 * 1024,
      allowedName: (name) => ['batch.json', 'committed.json'].includes(name)
        || /^\.(?:batch|committed)\.json\.\d+\.[a-f0-9-]{36}\.tmp$/u.test(name)
    });
    if (retired) {
      totalBytes += retired.storage_bytes;
      records.push({ ...retired, batch: null, committed: false, archive_kind: 'release-batches' });
      continue;
    }
    if (!entry.isDirectory() || !/^release-[a-f0-9]{32}$/u.test(entry.name)) {
      throw new Error('Verification release batch store contains an unexpected entry.');
    }
    const batchDirectory = path.join(directory, entry.name);
    const directoryInfo = await lstat(batchDirectory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error(`Verification release batch directory is unsafe: ${entry.name}`);
    const batchEntries = await readDirectoryEntriesBounded(batchDirectory, { maxEntries: 3 });
    const names = batchEntries.map((item) => item.name).sort();
    const pendingNames = names.filter((name) => /^\.(?:batch|committed)\.json\.\d+\.[a-f0-9-]{36}\.tmp$/u.test(name));
    if (names.some((name) => !['batch.json', 'committed.json'].includes(name) && !pendingNames.includes(name))) {
      throw new Error(`Verification release batch has an unexpected file set: ${entry.name}`);
    }
    if (!names.includes('batch.json')) {
      let pendingBytes = 0;
      for (const pending of pendingNames) {
        const pendingInfo = await lstat(path.join(batchDirectory, pending));
        if (!pendingInfo.isFile() || pendingInfo.isSymbolicLink() || pendingInfo.nlink !== 1 || pendingInfo.size > 4 * 1024 * 1024) {
          throw new Error(`Verification release batch has an unsafe pending file: ${entry.name}`);
        }
        pendingBytes += pendingInfo.size;
      }
      totalBytes += pendingBytes;
      records.push({
        batch: null,
        directory: batchDirectory,
        directory_info: directoryInfo,
        storage_bytes: pendingBytes,
        committed: false,
        allowed_names: new Set(pendingNames),
        archive_kind: 'release-batches'
      });
      continue;
    }
    if (pendingNames.length > 0) {
      throw new Error(`Verification release batch has an unexpected pending file: ${entry.name}`);
    }
    const file = path.join(batchDirectory, 'batch.json');
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4 * 1024 * 1024) {
      throw new Error(`Verification release batch file is unsafe: ${entry.name}`);
    }
    const batch = validateReleaseBatch(JSON.parse(await readFile(file, 'utf8')));
    if (batch.batch_id !== entry.name || batches.has(batch.batch_id)) throw new Error('Verification release batch identity is inconsistent.');
    let storageBytes = info.size;
    try {
      const commitFile = path.join(batchDirectory, 'committed.json');
      const commit = await readReleaseBatchCommit(commitFile, batch);
      storageBytes += (await lstat(commitFile)).size;
      totalBytes += storageBytes;
      if (totalBytes > limits.release_batch_retention_bytes + limits.ingress_overflow_bytes) {
        throw new Error('Verification release batch store exceeds its bounded ingress capacity.');
      }
      const storedBatch = { ...batch, committed_receipts: commit.receipts };
      batches.set(batch.batch_id, storedBatch);
      records.push({ batch: storedBatch, directory: batchDirectory, directory_info: directoryInfo, storage_bytes: storageBytes, committed: true, allowed_names: new Set(['batch.json', 'committed.json']), archive_kind: 'release-batches' });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        totalBytes += storageBytes;
        records.push({ batch, directory: batchDirectory, directory_info: directoryInfo, storage_bytes: storageBytes, committed: false, allowed_names: new Set(['batch.json']), archive_kind: 'release-batches' });
        continue;
      }
      throw error;
    }
  }
  if (totalBytes > limits.release_batch_retention_bytes + limits.ingress_overflow_bytes) {
    throw new Error('Verification release batch store exceeds its bounded ingress capacity.');
  }
  return { batches, records, total_bytes: totalBytes };
}

async function ensureReleaseBatchAdmission(repoRoot, evidencePolicy, batch) {
  const limits = evidencePolicy.store_limits;
  const hardCount = limits.release_batch_retention_count + limits.ingress_overflow_count;
  const hardBytes = limits.release_batch_retention_bytes + limits.ingress_overflow_bytes;
  const requiredBytes = Buffer.byteLength(`${stableJson(batch)}\n`) + MAX_RELEASE_BATCH_COMMIT_BYTES;
  let current = await readReleaseBatches(repoRoot, evidencePolicy);
  if (current.records.length >= hardCount || current.total_bytes + requiredBytes > hardBytes) {
    await rebuildDerivedEvidenceLocked(repoRoot);
    current = await readReleaseBatches(repoRoot, evidencePolicy);
  }
  if (current.records.length >= hardCount || current.total_bytes + requiredBytes > hardBytes) {
    throw new Error('Verification release batch store has no safe retention capacity.');
  }
}

async function archiveRetainedEvidenceDirectory(repoRoot, record, allowedNames, onPhase) {
  const current = await lstat(record.directory);
  if (!current.isDirectory() || current.isSymbolicLink()
    || current.dev !== record.directory_info.dev || current.ino !== record.directory_info.ino) {
    throw new Error('Evidence retention target changed before removal.');
  }
  const entries = await readDirectoryEntriesBounded(record.directory, { maxEntries: allowedNames.size + 1 });
  if (entries.some((entry) => !allowedNames.has(entry.name) || !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('Evidence retention target contains an unexpected file set.');
  }
  for (const entry of entries) {
    const info = await lstat(path.join(record.directory, entry.name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error('Evidence retention target contains an unsafe file.');
    }
  }
  await onPhase?.('validated', { directory: record.directory });
  const archiveDirectory = await prepareInactiveArchive(repoRoot, record.archive_kind);
  const archived = path.join(archiveDirectory, `${path.basename(record.directory)}-${randomUUID()}`);
  await rename(record.directory, archived);
  let moved = true;
  try {
    const archivedInfo = await lstat(archived);
    if (!archivedInfo.isDirectory() || archivedInfo.isSymbolicLink()
      || archivedInfo.dev !== current.dev || archivedInfo.ino !== current.ino) {
      throw new Error('Evidence retention target changed during archival.');
    }
    const archivedEntries = await readDirectoryEntriesBounded(archived, { maxEntries: allowedNames.size + 1 });
    if (archivedEntries.length !== entries.length
      || archivedEntries.some((entry) => !allowedNames.has(entry.name) || !entry.isFile() || entry.isSymbolicLink())) {
      throw new Error('Evidence retention target changed after archival.');
    }
    await onPhase?.('archived', { directory: record.directory, archived });
    moved = false;
    await Promise.all([syncDirectory(path.dirname(record.directory)), syncDirectory(archiveDirectory)]);
  } finally {
    if (moved) {
      try { await rename(archived, record.directory); } catch {}
    }
  }
}

function newestReceiptFirst(left, right) {
  return Date.parse(right.receipt.observed_at) - Date.parse(left.receipt.observed_at)
    || right.receipt.event_id.localeCompare(left.receipt.event_id);
}

async function retainBoundedEvidenceHistory({
  repoRoot,
  receiptStore,
  batchStore,
  batches,
  evidencePolicy,
  snapshot,
  policyFingerprint,
  now,
  onRetirementPhase
}) {
  const limits = evidencePolicy.store_limits;
  const receipts = receiptStore.receipts;
  const semanticRows = latestRows(receipts, snapshot, policyFingerprint, batches, evidencePolicy, now);
  const committed = batchStore.records
    .filter((record) => record.committed)
    .map((record) => ({ ...record, batch: batches.get(record.batch.batch_id) ?? record.batch }))
    .sort((left, right) => Date.parse(right.batch.created_at) - Date.parse(left.batch.created_at)
      || right.batch.batch_id.localeCompare(left.batch.batch_id));
  const retainedBatchIds = new Set(semanticRows
    .filter((row) => row.evidence_batch_valid && row.evidence_batch_id)
    .map((row) => row.evidence_batch_id));
  let retainedBatchBytes = 0;
  for (const batchId of retainedBatchIds) {
    retainedBatchBytes += committed.find((record) => record.batch.batch_id === batchId)?.storage_bytes ?? 0;
  }
  if (retainedBatchIds.size > limits.release_batch_retention_count
    || retainedBatchBytes > limits.release_batch_retention_bytes) {
    throw new Error('Current release evidence exceeds the configured batch retention capacity.');
  }
  for (const record of committed) {
    if (retainedBatchIds.has(record.batch.batch_id)) continue;
    if (record.storage_bytes > limits.release_batch_retention_bytes) {
      throw new Error('A verification release batch exceeds the configured retention capacity.');
    }
    if (retainedBatchIds.size >= limits.release_batch_retention_count
      || retainedBatchBytes + record.storage_bytes > limits.release_batch_retention_bytes) continue;
    retainedBatchIds.add(record.batch.batch_id);
    retainedBatchBytes += record.storage_bytes;
  }

  for (const record of batchStore.records) {
    const incompleteExpired = !record.committed
      && (record.retired === true || now - record.directory_info.mtimeMs > limits.stale_lock_ms);
    if ((record.committed && !retainedBatchIds.has(record.batch.batch_id)) || incompleteExpired) {
      await archiveRetainedEvidenceDirectory(repoRoot, record, record.allowed_names, onRetirementPhase);
    }
  }
  const retainedBatches = new Map([...batches]
    .filter(([batchId]) => retainedBatchIds.has(batchId)));

  const byEventId = new Map(receipts.map((record) => [record.receipt.event_id, record]));
  const requiredReceiptIds = new Set();
  for (const batch of retainedBatches.values()) {
    for (const receipt of batch.committed_receipts) requiredReceiptIds.add(receipt.event_id);
  }
  for (const row of semanticRows) requiredReceiptIds.add(row.event_id);
  const sortedReceipts = [...receipts].sort(newestReceiptFirst);

  let retainedReceiptBytes = 0;
  for (const eventId of requiredReceiptIds) retainedReceiptBytes += byEventId.get(eventId)?.storage_bytes ?? 0;
  if (requiredReceiptIds.size > limits.receipt_retention_count
    || retainedReceiptBytes > limits.receipt_retention_bytes) {
    throw new Error('Current evidence exceeds the configured receipt retention capacity.');
  }
  const retainedReceiptIds = new Set(requiredReceiptIds);
  for (const record of sortedReceipts) {
    if (retainedReceiptIds.has(record.receipt.event_id)) continue;
    if (retainedReceiptIds.size >= limits.receipt_retention_count
      || retainedReceiptBytes + record.storage_bytes > limits.receipt_retention_bytes) continue;
    retainedReceiptIds.add(record.receipt.event_id);
    retainedReceiptBytes += record.storage_bytes;
  }
  for (const record of receipts) {
    if (!retainedReceiptIds.has(record.receipt.event_id)) {
      await archiveRetainedEvidenceDirectory(repoRoot, record, new Set(['receipt.json']), onRetirementPhase);
    }
  }
  for (const record of receiptStore.incomplete) {
    if (record.retired === true || now - record.directory_info.mtimeMs > limits.stale_lock_ms) {
      await archiveRetainedEvidenceDirectory(repoRoot, record, record.allowed_names, onRetirementPhase);
    }
  }
  return {
    receipts: receipts.filter((record) => retainedReceiptIds.has(record.receipt.event_id)),
    batches: retainedBatches
  };
}

async function bindCurrentReleaseArtifacts(repoRoot, batches, evidencePolicy) {
  if (batches.size === 0) return batches;
  let currentDigest = null;
  try {
    currentDigest = await computeReleaseArtifactDigest(repoRoot, evidencePolicy.release_artifact_paths);
  } catch {
    currentDigest = null;
  }
  return new Map([...batches].map(([batchId, batch]) => [batchId, {
    ...batch,
    artifact_current: batch.profile === evidencePolicy.release_profile
      && currentDigest !== null
      && batch.artifact_digest === currentDigest
  }]));
}

async function readEvidenceRequirements(repoRoot) {
  const file = path.join(repoRoot, 'ops', 'EVIDENCE_DETAIL_MANIFEST.tsv');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) {
    throw new Error('Evidence detail manifest is unsafe.');
  }
  const requirements = new Map();
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (fields.length !== 18) throw new Error('Evidence detail manifest row must contain exactly 18 fields.');
    const [sourceId, requiredMode, contextsText] = fields;
    validateSourceId(sourceId);
    if (!['required', 'optional', 'contextual'].includes(requiredMode)) throw new Error(`Invalid evidence requirement mode: ${requiredMode}`);
    if (requirements.has(sourceId)) throw new Error(`Duplicate evidence requirement source: ${sourceId}`);
    const contexts = contextsText.split('|');
    if (contexts.length === 0 || contexts.some((context) => !CONTEXTS.has(context))) {
      throw new Error(`Invalid evidence requirement contexts: ${contextsText}`);
    }
    requirements.set(sourceId, { requiredMode, contexts: new Set(contexts) });
  }
  return requirements;
}

function requirementApplies(requirement, context) {
  return requirement.contexts.has('all') || requirement.contexts.has(context) || context === 'all';
}

function completeActiveRows(rows, requirements, repoRoot, evidencePolicy) {
  const contexts = new Set([evidencePolicy.default_context ?? 'all']);
  for (const row of rows) {
    const requirement = requirements.get(row.source_id);
    if (requirement?.requiredMode === 'required' && requirementApplies(requirement, row.context)) {
      contexts.add(row.context);
    }
  }
  const completed = rows.map((row) => {
    const requirement = requirements.get(row.source_id);
    if (!requirement) return row;
    return {
      ...row,
      required_in_context: requirementApplies(requirement, row.context) && requirement.requiredMode === 'required'
    };
  });
  for (const context of contexts) {
    for (const [sourceId, requirement] of requirements) {
      const required = requirementApplies(requirement, context)
        && requirement.requiredMode === 'required';
      if (!required) continue;
      const present = completed.some((row) => row.source_id === sourceId && (row.context === context || row.context === 'all'));
      if (present) continue;
      completed.push({
        source_id: sourceId,
        context,
        status: 'not_run',
        freshness_state: 'not_collected',
        required_in_context: true,
        authority: 'not_collected',
        observed_at: 'not_collected',
        max_age_seconds: 0,
        product_root: `[external-product-repository]/${path.basename(repoRoot)}`,
        product_head: 'none',
        source_artifacts: 'ops/EVIDENCE_DETAIL_MANIFEST.tsv',
        blocked_by: sourceId,
        next_command: './tools/product-gate-evidence status',
        detail_code: `${sourceId}.detail`,
        safe_summary: `${sourceId} not_run`,
        reason: 'Required current evidence has not been collected.',
        next_action: 'Run the source-specific product verification before treating the repository as ready.',
        synthetic: true
      });
    }
  }
  return completed.sort((a, b) => `${a.source_id}\0${a.context}`.localeCompare(`${b.source_id}\0${b.context}`));
}

function parseLegacyIndex(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (fields.length !== 13) continue;
    // Full-SHA rows are produced by this helper and must be recoverable only
    // from their atomic receipts. Only pre-v2 short-SHA rows are carried as
    // stale migration context.
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(fields[9])) continue;
    const safeLegacyMetadata = (value, label) => {
      try {
        return validateSafeMetadata(value, label);
      } catch {
        return '[legacy metadata omitted]';
      }
    };
    rows.push({
      source_id: fields[0], context: fields[1], status: fields[2], freshness_state: fields[3],
      required_in_context: fields[4] === 'true', authority: fields[5], observed_at: fields[6],
      max_age_seconds: Number(fields[7]), product_root: fields[8], product_head: fields[9],
      source_artifacts: safeLegacyMetadata(fields[10], 'legacy source_artifacts'),
      blocked_by: safeLegacyMetadata(fields[11], 'legacy blocked_by'),
      next_command: safeLegacyMetadata(fields[12], 'legacy next_command'),
      legacy: true
    });
  }
  return rows;
}

async function migrateLegacyIndex(repoRoot) {
  let info;
  try {
    info = await lstat(indexPath(repoRoot));
  } catch (error) {
    if (error?.code === 'ENOENT') return { migrated: false, count: 0 };
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_DERIVED_INDEX_BYTES) {
    throw new Error('Legacy product gate evidence index is unsafe.');
  }
  const text = await readFile(indexPath(repoRoot), 'utf8');
  const legacyRows = parseLegacyIndex(text);
  if (legacyRows.length === 0) return { migrated: false, count: 0 };
  await ensureSafeEvidenceRoot(repoRoot);
  const directory = legacyEvidencePath(repoRoot);
  await ensureSafeDirectory(directory);
  const digest = sha256(text);
  const archive = path.join(directory, `index-v1-${digest}.tsv`);
  try {
    const archiveInfo = await lstat(archive);
    if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || sha256(await readFile(archive)) !== digest) {
      throw new Error('Archived legacy product gate evidence index is unsafe or inconsistent.');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await atomicWrite(archive, text);
  }
  await atomicWrite(path.join(directory, 'migration-v2.json'), `${stableJson({
    schema_version: '1.0.0',
    kind: 'product-gate-evidence-legacy-migration',
    archive: path.relative(repoRoot, archive).replaceAll('\\', '/'),
    sha256: digest,
    row_count: legacyRows.length,
    migrated_at: parentCompatibleTimestamp(new Date())
  })}\n`);
  return { migrated: true, count: legacyRows.length, archive };
}

function completeReleaseBatchIds(receipts, batches) {
  const receiptByEvent = new Map(receipts.map(({ receipt }) => [receipt.event_id, receipt]));
  const completeBatchIds = new Set();
  for (const [batchId, batch] of batches) {
    const bindingBySource = new Map(batch.source_bindings.map((binding) => [binding.source_id, binding]));
    const complete = batch.committed_receipts.length === batch.source_bindings.length
      && batch.committed_receipts.every((committed) => {
        const receipt = receiptByEvent.get(committed.event_id);
        const binding = bindingBySource.get(committed.source_id);
        return receipt?.source_id === committed.source_id
          && receipt.result_digest === committed.result_digest
          && receipt.evidence_batch_id === batchId
          && receipt.evidence_batch_digest === batch.batch_digest
          && receipt.verification_task_id === binding?.task_id
          && receipt.command_fingerprint === binding?.command_fingerprint;
      });
    if (complete && batch.artifact_current === true) completeBatchIds.add(batchId);
  }
  return completeBatchIds;
}

function latestRows(receipts, snapshot, policyFingerprint, batches, evidencePolicy, now) {
  const completeBatchIds = completeReleaseBatchIds(receipts, batches);
  const latest = new Map();
  for (const { receipt, file } of receipts) {
    const row = {
      source_id: receipt.source_id,
      context: receipt.context,
      status: receipt.status,
      freshness_state: freshnessForReceipt(receipt, snapshot, policyFingerprint, evidencePolicy, now),
      required_in_context: receipt.required_in_context,
      authority: receipt.authority,
      observed_at: receipt.observed_at,
      max_age_seconds: receipt.max_age_seconds,
      product_root: receipt.product_root,
      product_head: receipt.head_sha,
      source_artifacts: receipt.source_artifacts,
      blocked_by: receipt.blocked_by,
      next_command: receipt.next_command,
      detail_code: receipt.detail_code,
      safe_summary: receipt.safe_summary,
      reason: receipt.reason,
      next_action: receipt.next_action,
      event_id: receipt.event_id,
      receipt_version: receipt.schema_version,
      evidence_batch_id: receipt.evidence_batch_id ?? null,
      evidence_batch_digest: receipt.evidence_batch_digest ?? null,
      verification_task_id: receipt.verification_task_id ?? null,
      command_fingerprint: receipt.command_fingerprint,
      evidence_batch_valid: receipt.evidence_batch_id
        ? completeBatchIds.has(receipt.evidence_batch_id)
          && batches.get(receipt.evidence_batch_id)?.batch_digest === receipt.evidence_batch_digest
          && batches.get(receipt.evidence_batch_id)?.committed_receipts.some((committed) => (
            committed.source_id === receipt.source_id
            && committed.event_id === receipt.event_id
            && committed.result_digest === receipt.result_digest
          ))
        : false,
      file
    };
    const key = `${row.source_id}\0${row.context}`;
    const previous = latest.get(key);
    if (!previous || evidenceRowReplaces(previous, row)) latest.set(key, row);
  }
  return [...latest.values()].sort((a, b) => `${a.source_id}\0${a.context}`.localeCompare(`${b.source_id}\0${b.context}`));
}

function evidenceRowReplaces(previous, candidate) {
  const previousClass = evidenceSelectionClass(previous);
  const candidateClass = evidenceSelectionClass(candidate);
  if (previousClass === 'batch' && candidateClass === 'ordinary') return false;
  if (previousClass === 'ordinary' && candidateClass === 'batch') return true;
  if (previousClass === 'failure' && candidateClass === 'ordinary') return false;
  if (previousClass === 'ordinary' && candidateClass === 'failure') return true;
  return candidate.observed_at > previous.observed_at
    || (candidate.observed_at === previous.observed_at && candidate.event_id > (previous.event_id ?? ''));
}

function evidenceSelectionClass(row) {
  if (row?.freshness_state === 'current' && row.authority === 'authoritative'
    && ['failed', 'blocked', 'unknown'].includes(row.status)) return 'failure';
  if (row?.evidence_batch_valid) return 'batch';
  return 'ordinary';
}

function enforceReleaseBatchCoherence(rows, requirements, batches, policy) {
  if (policy.release_batch_required !== true) return rows;
  const output = rows.map((row) => ({ ...row }));
  const contexts = [...new Set(output.map((row) => row.context))];
  for (const context of contexts) {
    const requiredSources = [...requirements]
      .filter(([, requirement]) => requirement.requiredMode === 'required' && requirementApplies(requirement, context))
      .map(([sourceId]) => sourceId)
      .sort();
    const requiredRows = requiredSources.map((sourceId) => output.find((row) => row.source_id === sourceId
      && (row.context === context || row.context === 'all'))).filter(Boolean);
    if (requiredRows.length !== requiredSources.length) continue;
    if (requiredRows.some((row) => row.status !== 'passed' || row.authority !== 'authoritative'
      || row.freshness_state !== 'current')) continue;
    const batchIds = new Set(requiredRows.map((row) => row.evidence_batch_id).filter(Boolean));
    const batchId = batchIds.size === 1 ? [...batchIds][0] : null;
    const batch = batchId ? batches.get(batchId) : null;
    const boundSources = new Set(batch?.source_bindings?.map((binding) => binding.source_id) ?? []);
    const bindingBySource = new Map(batch?.source_bindings?.map((binding) => [binding.source_id, binding]) ?? []);
    const coherent = Boolean(batch)
      && batch.artifact_current === true
      && batch.context === context
      && batch.after_snapshot.head_sha === requiredRows[0].product_head
      && requiredRows.every((row) => row.evidence_batch_valid
        && row.evidence_batch_digest === batch.batch_digest
        && boundSources.has(row.source_id)
        && row.verification_task_id === bindingBySource.get(row.source_id)?.task_id
        && row.command_fingerprint === bindingBySource.get(row.source_id)?.command_fingerprint);
    if (coherent) continue;
    for (const row of requiredRows) {
      row.freshness_state = 'stale';
      row.reason = 'Required evidence was not produced by one complete exact-revision release batch.';
      row.next_action = 'Run the complete release verification with evidence recording on a clean synchronized revision.';
    }
  }
  return output;
}

async function acquireIndexLock(repoRoot, {
  timeoutMs,
  staleMs,
  alreadySatisfied
} = {}) {
  const storeLimits = (await readVerificationEvidencePolicy(repoRoot)).store_limits;
  const effectiveTimeoutMs = timeoutMs ?? storeLimits.lock_timeout_ms;
  const effectiveStaleMs = staleMs ?? storeLimits.stale_lock_ms;
  if (!Number.isSafeInteger(effectiveTimeoutMs) || effectiveTimeoutMs < 1
    || !Number.isSafeInteger(effectiveStaleMs) || effectiveStaleMs < 1) {
    throw new Error('Product gate evidence lock limits are invalid.');
  }
  const lock = path.join(evidenceRoot(repoRoot), '.index.lock');
  await ensureSafeEvidenceRoot(repoRoot);
  const started = Date.now();
  const nonce = randomUUID();
  const ownerRecord = {
    pid: process.pid,
    process_identity: await captureProcessIdentity(process.pid),
    nonce,
    created_at: new Date().toISOString()
  };
  while (true) {
    if (typeof alreadySatisfied === 'function' && await alreadySatisfied()) return null;
    const remainingMs = effectiveTimeoutMs - (Date.now() - started);
    if (remainingMs <= 0) throw new Error('Timed out waiting for product gate evidence index lock.');
    const attempt = await withCrashSafeTransition({
      directory: evidenceRoot(repoRoot),
      prefix: '.index.lock.transition-',
      timeoutMs: remainingMs,
      task: async () => {
      try {
          await mkdir(lock, { mode: 0o700 });
          await atomicWrite(path.join(lock, 'owner.json'), `${stableJson(ownerRecord)}\n`);
          return { acquired: true };
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
        }
        const observed = await inspectEvidenceLock(lock);
        if (observed.age_ms > effectiveStaleMs && !await isProcessIdentityAlive(observed.owner ?? {})) {
          return { recovered: await quarantineDeadEvidenceLock(lock, observed) };
        }
        return { acquired: false, recovered: false };
      }
    });
    if (attempt.entered && attempt.value?.acquired) {
      return async () => releaseIndexLock(repoRoot, lock, ownerRecord, effectiveTimeoutMs);
    }
    if (typeof alreadySatisfied === 'function' && await alreadySatisfied()) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, effectiveTimeoutMs - (Date.now() - started)))));
  }
}

async function releaseIndexLock(repoRoot, lock, ownerRecord, timeoutMs) {
  const started = Date.now();
  while (true) {
    const remainingMs = timeoutMs - (Date.now() - started);
    if (remainingMs <= 0) throw new Error('Timed out releasing product gate evidence index lock.');
    const attempt = await withCrashSafeTransition({
      directory: evidenceRoot(repoRoot),
      prefix: '.index.lock.transition-',
      timeoutMs: remainingMs,
      task: async () => {
        try {
          const current = await inspectEvidenceLock(lock);
          if (current.owner?.nonce !== ownerRecord.nonce || current.owner?.pid !== ownerRecord.pid) {
            throw new Error('Product gate evidence lock ownership changed.');
          }
          await rm(lock, { recursive: true, force: false });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        return true;
      }
    });
    if (attempt.entered) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, timeoutMs - (Date.now() - started)))));
  }
}

async function inspectEvidenceLock(lock) {
  const before = await lstat(lock);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Product gate evidence lock is unsafe.');
  let owner = null;
  try {
    owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const after = await lstat(lock);
  if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('Product gate evidence lock changed during inspection.');
  const createdAt = Date.parse(owner?.created_at);
  return {
    owner,
    info: before,
    age_ms: Date.now() - (Number.isFinite(createdAt) ? createdAt : before.mtimeMs)
  };
}

async function quarantineDeadEvidenceLock(lock, observed) {
  const quarantine = `${lock}.stale.${randomUUID()}`;
  let moved = false;
  try {
    await rename(lock, quarantine);
    moved = true;
    const current = await inspectEvidenceLock(quarantine);
    const sameDirectory = current.info.dev === observed.info.dev && current.info.ino === observed.info.ino;
    const sameOwner = observed.owner
      ? current.owner?.nonce === observed.owner.nonce && current.owner?.pid === observed.owner.pid
      : current.owner === null;
    if (!sameDirectory || !sameOwner || await isProcessIdentityAlive(current.owner ?? {})) {
      await rename(quarantine, lock);
      moved = false;
      return false;
    }
    await rm(quarantine, { recursive: true, force: false });
    moved = false;
    return true;
  } finally {
    if (moved) {
      try { await rename(quarantine, lock); } catch {}
    }
  }
}

function indexText(rows) {
  const lines = ['# source_id\tcontext\tstatus\tfreshness_state\trequired_in_context\tauthority\tobserved_at\tmax_age_seconds\tproduct_root\tproduct_head\tsource_artifacts\tblocked_by\tnext_command'];
  for (const row of rows) {
    const fields = [row.source_id, row.context, row.status, row.freshness_state, String(row.required_in_context), row.authority, parentCompatibleTimestamp(row.observed_at), String(row.max_age_seconds), row.product_root, row.product_head, row.source_artifacts, row.blocked_by, row.next_command];
    lines.push(fields.map((field) => String(field ?? '').replace(/[\t\r\n]/gu, ' ')).join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

function ledgerText(receipts, repoRoot, snapshot, policyFingerprint, evidencePolicy, now) {
  return receipts
    .sort((a, b) => a.receipt.event_id.localeCompare(b.receipt.event_id))
    .map(({ receipt, file }) => stableJson({
      event_id: receipt.event_id,
      source_id: receipt.source_id,
      context: receipt.context,
      status: receipt.status,
      freshness_state: freshnessForReceipt(receipt, snapshot, policyFingerprint, evidencePolicy, now),
      authority: receipt.authority,
      observed_at: receipt.observed_at,
      product_head: receipt.head_sha,
      detail_code: receipt.detail_code,
      detail_artifact_path: path.relative(repoRoot, file).replaceAll('\\', '/')
    }))
    .join('\n') + (receipts.length ? '\n' : '');
}

async function writeActiveDetails(repoRoot, rows) {
  const directory = detailsPath(repoRoot);
  await ensureSafeDirectory(directory);
  const bySource = new Map();
  for (const row of rows) {
    const sourceRows = bySource.get(row.source_id) ?? [];
    sourceRows.push(row);
    bySource.set(row.source_id, sourceRows);
  }
  for (const [sourceId, sourceRows] of bySource) {
    validateSourceId(sourceId);
    const sourceDirectory = path.join(directory, sourceId);
    await ensureSafeDirectory(sourceDirectory);
    const row = sourceRows.length === 1 ? sourceRows[0] : null;
    await atomicWrite(path.join(sourceDirectory, 'current-v2.json'), `${stableJson({
      artifact_schema_version: '1.0.0',
      event_id: row?.event_id ?? '',
      source_id: sourceId,
      context: row?.context ?? 'multiple',
      status: row?.status ?? 'unknown',
      freshness_state: row?.freshness_state ?? 'unknown',
      authority: row?.authority ?? 'not_collected',
      observed_at: row ? parentCompatibleTimestamp(row.observed_at) : 'not_collected',
      product_root: row?.product_root ?? `[external-product-repository]/${path.basename(repoRoot)}`,
      product_head: row?.product_head ?? 'none',
      detail_code: row?.detail_code ?? `${sourceId}.detail`,
      safe_summary: row?.safe_summary ?? `${sourceId} has context-specific evidence`,
      reason: row?.reason ?? 'Use the selected workflow context row for the current status and observation.',
      next_action: row?.next_action ?? 'Inspect the selected workflow context before making a readiness decision.',
      source_artifacts: row?.source_artifacts ?? 'context-specific active index rows',
      blocked_by: row?.blocked_by ?? '',
      next_command: row?.next_command ?? './tools/product-gate-evidence status'
    })}\n`);
  }
}

async function rebuildDerivedEvidenceLocked(repoRoot, options = {}) {
  await assertOptionalSafeDirectory(legacyEvidencePath(repoRoot), 'Product gate evidence legacy archive');
  await migrateLegacyIndex(repoRoot);
  const evidencePolicy = await readVerificationEvidencePolicy(repoRoot);
  const [snapshot, policyFingerprint, storedReceiptStore, requirements, storedBatchStore] = await Promise.all([
    snapshotRepository(repoRoot),
    computePolicyFingerprint(repoRoot),
    readReceipts(repoRoot, evidencePolicy),
    readEvidenceRequirements(repoRoot),
    readReleaseBatches(repoRoot, evidencePolicy)
  ]);
  const now = options.now ?? Date.now();
  const storedBatches = await bindCurrentReleaseArtifacts(repoRoot, storedBatchStore.batches, evidencePolicy);
  const retained = await retainBoundedEvidenceHistory({
    repoRoot,
    receiptStore: storedReceiptStore,
    batchStore: storedBatchStore,
    batches: storedBatches,
    evidencePolicy,
    snapshot,
    policyFingerprint,
    now,
    onRetirementPhase: options.onEvidenceRetirementPhase
  });
  const receipts = retained.receipts;
  const batches = retained.batches;
  const rows = enforceReleaseBatchCoherence(
    completeActiveRows(latestRows(receipts, snapshot, policyFingerprint, batches, evidencePolicy, now), requirements, repoRoot, evidencePolicy),
    requirements,
    batches,
    evidencePolicy
  );
  await writeActiveDetails(repoRoot, rows);
  await atomicWrite(indexPath(repoRoot), indexText(rows));
  await atomicWrite(ledgerPath(repoRoot), ledgerText(receipts, repoRoot, snapshot, policyFingerprint, evidencePolicy, now));
  return { rows, receipts, batches: [...batches.values()] };
}

async function ensureReceiptProjected(repoRoot, eventId) {
  if (await ledgerContainsEvent(repoRoot, eventId)) return;
  const release = await acquireIndexLock(repoRoot, {
    alreadySatisfied: () => ledgerContainsEvent(repoRoot, eventId)
  });
  if (!release) return;
  try {
    if (await ledgerContainsEvent(repoRoot, eventId)) return;
    await rebuildDerivedEvidenceLocked(repoRoot);
  } finally {
    await release();
  }
}

async function ledgerContainsEvent(repoRoot, eventId) {
  let handle;
  try {
    handle = await open(ledgerPath(repoRoot), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (classifyOpenedEvidenceLedger(before) === 'replaced') return false;
    const body = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < body.length) {
      const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
      if (bytesRead <= 0) return false;
      offset += bytesRead;
    }
    const probe = Buffer.alloc(1);
    if ((await handle.read(probe, 0, 1, before.size)).bytesRead !== 0) return false;
    const after = await handle.stat();
    if (classifyOpenedEvidenceLedger(after) === 'replaced') return false;
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return false;
    try {
      return body.toString('utf8').split('\n').filter(Boolean)
        .some((line) => JSON.parse(line)?.event_id === eventId);
    } catch {
      return false;
    }
  } finally {
    await handle.close();
  }
}

export function classifyOpenedEvidenceLedger(info) {
  if (!info?.isFile?.() || info.size > MAX_UNTRACKED_FILE_BYTES) {
    throw new Error('Product gate evidence ledger is unsafe or oversized.');
  }
  if (info.nlink === 0) return 'replaced';
  if (info.nlink !== 1) throw new Error('Product gate evidence ledger is unsafe or oversized.');
  return 'readable';
}

export async function rebuildDerivedEvidence(repoRootInput, options = {}) {
  const repoRoot = validateRepoRoot(repoRootInput);
  const release = await acquireIndexLock(repoRoot, options);
  try {
    return await rebuildDerivedEvidenceLocked(repoRoot, options);
  } finally {
    await release();
  }
}

export async function evidenceStatus(repoRootInput, { now = Date.now() } = {}) {
  const repoRoot = validateRepoRoot(repoRootInput);
  const release = await acquireIndexLock(repoRoot);
  try {
    return await evidenceStatusLocked(repoRoot, { now });
  } finally {
    await release();
  }
}

async function evidenceStatusLocked(repoRoot, { now }) {
  await assertOptionalSafeDirectory(evidenceRoot(repoRoot), 'Product gate evidence root');
  await assertOptionalSafeDirectory(receiptsPath(repoRoot), 'Product gate evidence receipt store');
  await assertOptionalSafeDirectory(detailsPath(repoRoot), 'Product gate evidence detail store');
  await assertOptionalSafeDirectory(legacyEvidencePath(repoRoot), 'Product gate evidence legacy archive');
  const evidencePolicy = await readVerificationEvidencePolicy(repoRoot);
  const [snapshot, policyFingerprint, storedReceiptStore, requirements, storedBatchStore] = await Promise.all([
    snapshotRepository(repoRoot),
    computePolicyFingerprint(repoRoot),
    readReceipts(repoRoot, evidencePolicy),
    readEvidenceRequirements(repoRoot),
    readReleaseBatches(repoRoot, evidencePolicy)
  ]);
  const receipts = storedReceiptStore.receipts;
  const batches = await bindCurrentReleaseArtifacts(repoRoot, storedBatchStore.batches, evidencePolicy);
  const rows = enforceReleaseBatchCoherence(
    completeActiveRows(latestRows(receipts, snapshot, policyFingerprint, batches, evidencePolicy, now), requirements, repoRoot, evidencePolicy),
    requirements,
    batches,
    evidencePolicy
  );
  const requiredRows = rows.filter((row) => row.required_in_context);
  let status = 'not_collected';
  if (rows.length) {
    if (requiredRows.some((row) => row.freshness_state === 'stale')) status = 'stale';
    else if (requiredRows.some((row) => ['failed', 'blocked', 'unknown'].includes(row.status))) status = 'failed';
    else if (requiredRows.some((row) => row.status !== 'passed' || row.authority !== 'authoritative')) status = 'blocked';
    else status = 'ready';
  }
  const [legacyLedger, legacyDetails] = await Promise.all([
    lstat(ledgerPath(repoRoot)).then((info) => info.isFile() && !info.isSymbolicLink()).catch((error) => error?.code === 'ENOENT' ? false : Promise.reject(error)),
    lstat(path.join(evidenceRoot(repoRoot), 'details')).then((info) => info.isDirectory() && !info.isSymbolicLink()).catch((error) => error?.code === 'ENOENT' ? false : Promise.reject(error))
  ]);
  return {
    status,
    rows,
    receipts,
    batches: [...batches.values()],
    ledger_status: receipts.length || legacyLedger ? 'ready' : 'not_collected',
    details_status: legacyDetails ? 'ready' : 'not_collected'
  };
}

async function executeAndRecord(options, argv) {
  const before = await snapshotRepository(options.repoRoot);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: options.repoRoot, stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve(Number.isInteger(exitCode) ? exitCode : signal ? 128 : 1));
  });
  const after = await snapshotRepository(options.repoRoot);
  const changedInputs = before.input_fingerprint !== after.input_fingerprint || before.head_sha !== after.head_sha || before.tree_sha !== after.tree_sha;
  const status = code === 0 ? 'passed' : 'failed';
  await recordEvidence({
    ...options,
    status,
    authority: code === 0 && (changedInputs || after.worktree_state !== 'clean') ? 'advisory' : 'authoritative',
    blockedBy: code === 0 ? (changedInputs ? options.sourceId : '') : options.sourceId,
    executionMode: 'executed',
    argv,
    snapshot: after
  });
  return code;
}

function parseOptions(argv) {
  const options = {};
  let index = 0;
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') break;
    const value = argv[++index];
    if (value === undefined) throw new Error(`${arg} requires a value.`);
    const key = arg.replace(/^--/u, '').replace(/-([a-z])/gu, (_, char) => char.toUpperCase());
    options[key] = value;
  }
  return { options, rest: argv.slice(index + 1) };
}

function repoRootFrom(options) {
  return validateRepoRoot(options.repo ?? process.env.PRODUCT_REPO_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
}

async function gitStatusEvidence(repoRoot, context, maxAgeSeconds) {
  const snapshot = await snapshotRepository(repoRoot);
  const branch = String(runGit(repoRoot, ['branch', '--show-current'], { allowFailure: true }).stdout).trim() || 'detached';
  const upstreamResult = runGit(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFailure: true });
  const upstream = upstreamResult.status === 0 ? String(upstreamResult.stdout).trim() : '';
  let synchronized = false;
  await recordEvidence({
    repoRoot, sourceId: 'product.git.worktree', context,
    status: snapshot.worktree_state === 'clean' ? 'passed' : 'failed',
    authority: 'authoritative', maxAgeSeconds,
    sourceArtifacts: `git status --short;branch=${branch}`,
    blockedBy: snapshot.worktree_state === 'clean' ? '' : 'product.git.worktree',
    nextCommand: 'git status --short', executionMode: 'git-observation',
    argv: ['git', 'status', '--short'], snapshot, rebuild: false
  });
  if (!upstream) {
    for (const sourceId of ['product.git.upstream', 'product.git.local_remote_sync']) {
      await recordEvidence({
        repoRoot, sourceId, context, status: 'not_run', authority: 'advisory', maxAgeSeconds,
        requiredInContext: false,
        sourceArtifacts: sourceId.endsWith('upstream') ? 'git upstream unavailable' : 'git ahead/behind unavailable',
        blockedBy: 'product.git.upstream', nextCommand: 'git branch -vv', executionMode: 'git-observation',
        argv: ['git', 'branch', '-vv'], snapshot, rebuild: false
      });
    }
  } else {
    await recordEvidence({
      repoRoot, sourceId: 'product.git.upstream', context, status: 'passed', authority: 'authoritative', maxAgeSeconds,
      sourceArtifacts: `git upstream=${upstream}`, blockedBy: '', nextCommand: 'git branch -vv', executionMode: 'git-observation',
      argv: ['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], snapshot, rebuild: false
    });
    const countsResult = runGit(repoRoot, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], { allowFailure: true });
    const counts = countsResult.status === 0 ? String(countsResult.stdout).trim().split(/\s+/u).map(Number) : [NaN, NaN];
    synchronized = counts.length === 2 && counts.every(Number.isSafeInteger) && counts[0] === 0 && counts[1] === 0;
    await recordEvidence({
      repoRoot, sourceId: 'product.git.local_remote_sync', context, status: synchronized ? 'passed' : 'failed', authority: 'authoritative', maxAgeSeconds,
      sourceArtifacts: Number.isSafeInteger(counts[0]) ? `git ahead=${counts[0]};behind=${counts[1]};upstream=${upstream}` : 'git ahead/behind unavailable',
      blockedBy: synchronized ? '' : 'product.git.local_remote_sync', nextCommand: 'git status -sb', executionMode: 'git-observation',
      argv: ['git', 'rev-list', '--left-right', '--count', 'HEAD...@{u}'], snapshot, rebuild: false
    });
  }
  const syncStatus = snapshot.worktree_state !== 'clean' || (upstream && !synchronized) ? 'failed' : upstream ? 'passed' : 'blocked';
  const syncBlocker = snapshot.worktree_state !== 'clean'
    ? 'product.git.worktree'
    : upstream && !synchronized
      ? 'product.git.local_remote_sync'
      : upstream
        ? ''
        : 'product.git.upstream';
  await recordEvidence({
    repoRoot, sourceId: 'product.git.sync', context, status: syncStatus,
    authority: syncStatus === 'blocked' ? 'manual_required' : 'authoritative', maxAgeSeconds,
    sourceArtifacts: `git status --short;branch=${branch};upstream=${upstream || 'none'};synchronized=${synchronized}`,
    blockedBy: syncBlocker, nextCommand: 'git status -sb', executionMode: 'git-observation',
    argv: ['git', 'status', '-sb'], snapshot, rebuild: false
  });
  await rebuildDerivedEvidence(repoRoot);
}

async function main(argv = process.argv.slice(2)) {
  const command = argv.shift() ?? 'status';
  const parsed = parseOptions(argv);
  const options = parsed.options;
  const repoRoot = repoRootFrom(options);
  if (command === 'status') {
    await rebuildDerivedEvidence(repoRoot);
    const result = await evidenceStatus(repoRoot);
    process.stdout.write(`Product gate evidence index: .git/product-gate-evidence/index.tsv\nStatus: ${result.status}\nLedger: ${result.ledger_status}\nDetails: ${result.details_status}\n`);
    return 0;
  }
  if (command === 'rebuild') {
    const result = await rebuildDerivedEvidence(repoRoot);
    process.stdout.write(`Product gate evidence index rebuilt (${result.rows.length} row(s)).\n`);
    return 0;
  }
  if (command === 'manual') {
    const status = validateStatus(options.status);
    const result = await recordEvidence({
      repoRoot,
      sourceId: options.sourceId,
      context: options.context,
      status,
      requiredInContext: options.required !== 'false',
      authority: 'manual_required',
      maxAgeSeconds: options.maxAge ?? DEFAULT_MAX_AGE_SECONDS,
      sourceArtifacts: options.sourceArtifacts ?? '',
      blockedBy: options.blockedBy ?? '',
      nextCommand: options.nextCommand ?? '',
      executionMode: 'manual',
      argv: ['manual-record', options.sourceId, status]
    });
    process.stdout.write(`Product gate evidence recorded: ${result.receipt.source_id} ${result.receipt.context} ${result.receipt.status} ${result.receipt.event_id}\n`);
    return 0;
  }
  if (command === 'execute') {
    if (parsed.rest.length === 0) throw new Error('Evidence execute requires command argv after --.');
    return executeAndRecord({
      repoRoot,
      sourceId: options.sourceId,
      context: options.context,
      maxAgeSeconds: options.maxAge ?? DEFAULT_MAX_AGE_SECONDS,
      sourceArtifacts: options.sourceArtifacts ?? '',
      nextCommand: options.nextCommand ?? ''
    }, parsed.rest);
  }
  if (command === 'git-status') {
    await gitStatusEvidence(repoRoot, validateContext(options.context ?? 'free-development'), validateAge(options.maxAge ?? 300));
    return 0;
  }
  throw new Error(`Unknown product gate evidence helper command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`product gate evidence error: ${error.message}\n`);
    process.exitCode = 2;
  });
}
