#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
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

const RECEIPT_VERSION = '2.1.0';
const LEGACY_RECEIPT_VERSION = '2.0.0';
const MARKER_TEXT = 'product-gate-evidence-v2\n';
const MAX_METADATA_LENGTH = 4096;
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_AGE_SECONDS = 3600;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_STALE_LOCK_MS = 30000;
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
  'reason', 'next_action'
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

function freshnessForReceipt(receipt, snapshot, policyFingerprint, now = Date.now()) {
  if (receipt.status === 'not_run' || receipt.status === 'not_applicable') return 'not_collected';
  if (receipt.schema_version === LEGACY_RECEIPT_VERSION) return 'stale';
  const observed = Date.parse(receipt.observed_at);
  if (!Number.isFinite(observed) || now - observed > receipt.max_age_seconds * 1000) return 'stale';
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
  if (![LEGACY_RECEIPT_VERSION, RECEIPT_VERSION].includes(receipt.schema_version) || receipt.kind !== 'product-gate-evidence-receipt') throw new Error('Unsupported product gate evidence receipt.');
  validateSourceId(receipt.source_id);
  validateContext(receipt.context);
  validateStatus(receipt.status);
  validateAuthority(receipt.authority);
  validateBoolean(receipt.required_in_context, 'required_in_context');
  validateAge(receipt.max_age_seconds);
  for (const field of ['head_sha', 'tree_sha']) if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(receipt[field])) throw new Error(`Evidence ${field} must be a full SHA.`);
  for (const field of ['input_fingerprint', 'policy_fingerprint', 'command_fingerprint', 'result_digest', 'attempt_key']) {
    if (!/^[0-9a-f]{64}$/u.test(receipt[field])) throw new Error(`Evidence ${field} must be SHA-256.`);
  }
  if (!['clean', 'dirty'].includes(receipt.worktree_state)) throw new Error('Evidence worktree_state is invalid.');
  if (!['manual', 'executed', 'git-observation'].includes(receipt.execution_mode)) throw new Error('Evidence execution_mode is invalid.');
  for (const field of ['event_id', 'observed_at', 'product_root', 'execution_mode', 'source_artifacts', 'blocked_by', 'next_command', 'detail_code', 'safe_summary', 'reason', 'next_action']) {
    validateSafeMetadata(receipt[field], field, { allowEmpty: ['source_artifacts', 'blocked_by', 'next_command'].includes(field) });
  }
  if (!Number.isFinite(Date.parse(receipt.observed_at))) throw new Error('Evidence observed_at is invalid.');
  const expectedAttemptKey = sha256(stableJson({
    sourceId: receipt.source_id,
    context: receipt.context,
    observedAt: receipt.observed_at,
    head: receipt.head_sha,
    tree: receipt.tree_sha,
    input: receipt.input_fingerprint,
    policy: receipt.policy_fingerprint,
    command: receipt.command_fingerprint,
    eventId: receipt.event_id
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
  const attemptKey = sha256(stableJson({ sourceId, context, observedAt, head: currentSnapshot.head_sha, tree: currentSnapshot.tree_sha, input: currentSnapshot.input_fingerprint, policy: currentPolicy, command: commandDigest, eventId }));
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
    next_action: human.nextAction
  };
  const receipt = validateReceipt({
    ...receiptFields,
    result_digest: sha256(stableJson(receiptFields))
  });
  const directory = await prepareReceiptDirectory(repoRoot);
  const claim = path.join(directory, safeId(eventId));
  await mkdir(claim, { mode: 0o700 });
  const receiptFile = path.join(claim, 'receipt.json');
  await atomicWrite(receiptFile, `${stableJson(receipt)}\n`);
  if (rebuild) await rebuildDerivedEvidence(repoRoot);
  return { receipt, path: receiptFile };
}

async function readReceipts(repoRoot) {
  const directory = receiptsPath(repoRoot);
  let entries;
  try {
    const rootInfo = await lstat(evidenceRoot(repoRoot));
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Product gate evidence root is unsafe.');
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Product gate evidence receipt store is unsafe.');
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const receipts = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const file = path.join(directory, entry.name, 'receipt.json');
    let info;
    try {
      info = await lstat(file);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error(`Unsafe product gate evidence receipt: ${entry.name}`);
    receipts.push({ receipt: validateReceipt(JSON.parse(await readFile(file, 'utf8'))), file });
  }
  return receipts;
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

function completeActiveRows(rows, requirements, repoRoot) {
  const contexts = [...new Set(rows.map((row) => row.context))];
  if (contexts.length === 0) contexts.push('all');
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

function latestRows(receipts, snapshot, policyFingerprint, now) {
  const latest = new Map();
  for (const { receipt, file } of receipts) {
    const row = {
      source_id: receipt.source_id,
      context: receipt.context,
      status: receipt.status,
      freshness_state: freshnessForReceipt(receipt, snapshot, policyFingerprint, now),
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
      file
    };
    const key = `${row.source_id}\0${row.context}`;
    const previous = latest.get(key);
    if (!previous || row.observed_at > previous.observed_at || (row.observed_at === previous.observed_at && row.event_id > (previous.event_id ?? ''))) latest.set(key, row);
  }
  return [...latest.values()].sort((a, b) => `${a.source_id}\0${a.context}`.localeCompare(`${b.source_id}\0${b.context}`));
}

async function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function acquireIndexLock(repoRoot, { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS, staleMs = DEFAULT_STALE_LOCK_MS } = {}) {
  const lock = path.join(evidenceRoot(repoRoot), '.index.lock');
  await ensureSafeEvidenceRoot(repoRoot);
  const started = Date.now();
  const nonce = randomUUID();
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await atomicWrite(path.join(lock, 'owner.json'), `${stableJson({ pid: process.pid, nonce, created_at: new Date().toISOString() })}\n`);
      return async () => {
        try {
          const owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
          if (owner.nonce !== nonce || owner.pid !== process.pid) throw new Error('Product gate evidence lock ownership changed.');
          await rm(lock, { recursive: true, force: false });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let owner = null;
      let age = 0;
      try {
        owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
        age = Date.now() - Date.parse(owner.created_at);
      } catch {
        try {
          const info = await stat(lock);
          age = Date.now() - info.mtimeMs;
        } catch (statError) {
          if (statError?.code === 'ENOENT') continue;
          throw statError;
        }
      }
      if (age > staleMs && !(await processAlive(Number(owner?.pid)))) {
        const quarantine = `${lock}.stale.${randomUUID()}`;
        try {
          await rename(lock, quarantine);
          await rm(quarantine, { recursive: true, force: true });
          continue;
        } catch (renameError) {
          if (renameError?.code !== 'ENOENT') throw renameError;
        }
      }
      if (Date.now() - started >= timeoutMs) throw new Error('Timed out waiting for product gate evidence index lock.');
      await new Promise((resolve) => setTimeout(resolve, 25));
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

function ledgerText(receipts, repoRoot, snapshot, policyFingerprint, now) {
  return receipts
    .sort((a, b) => a.receipt.event_id.localeCompare(b.receipt.event_id))
    .map(({ receipt, file }) => stableJson({
      event_id: receipt.event_id,
      source_id: receipt.source_id,
      context: receipt.context,
      status: receipt.status,
      freshness_state: freshnessForReceipt(receipt, snapshot, policyFingerprint, now),
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

export async function rebuildDerivedEvidence(repoRootInput, options = {}) {
  const repoRoot = validateRepoRoot(repoRootInput);
  const release = await acquireIndexLock(repoRoot, options);
  try {
    await assertOptionalSafeDirectory(legacyEvidencePath(repoRoot), 'Product gate evidence legacy archive');
    await migrateLegacyIndex(repoRoot);
    const [snapshot, policyFingerprint, receipts, requirements] = await Promise.all([
      snapshotRepository(repoRoot),
      computePolicyFingerprint(repoRoot),
      readReceipts(repoRoot),
      readEvidenceRequirements(repoRoot)
    ]);
    const now = options.now ?? Date.now();
    const rows = completeActiveRows(latestRows(receipts, snapshot, policyFingerprint, now), requirements, repoRoot);
    await writeActiveDetails(repoRoot, rows);
    await atomicWrite(indexPath(repoRoot), indexText(rows));
    await atomicWrite(ledgerPath(repoRoot), ledgerText(receipts, repoRoot, snapshot, policyFingerprint, now));
    return { rows, receipts };
  } finally {
    await release();
  }
}

export async function evidenceStatus(repoRootInput, { now = Date.now() } = {}) {
  const repoRoot = validateRepoRoot(repoRootInput);
  await assertOptionalSafeDirectory(evidenceRoot(repoRoot), 'Product gate evidence root');
  await assertOptionalSafeDirectory(receiptsPath(repoRoot), 'Product gate evidence receipt store');
  await assertOptionalSafeDirectory(detailsPath(repoRoot), 'Product gate evidence detail store');
  await assertOptionalSafeDirectory(legacyEvidencePath(repoRoot), 'Product gate evidence legacy archive');
  const [snapshot, policyFingerprint, receipts, requirements] = await Promise.all([
    snapshotRepository(repoRoot),
    computePolicyFingerprint(repoRoot),
    readReceipts(repoRoot),
    readEvidenceRequirements(repoRoot)
  ]);
  const rows = completeActiveRows(latestRows(receipts, snapshot, policyFingerprint, now), requirements, repoRoot);
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
