import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { executeCli } from '../src/cli.js';
import { startMcpHttpServer } from '../src/mcp-http-transport.js';
import {
  buildDesktopReviewProviderPreparationPlan,
  desktopReviewProviderPreparationPlanBoundary
} from '../src/desktop-review-provider-preparation-plan.js';
import { runImageReview } from '../src/image-review.js';
import { buildIdentityAudit, runIdentityAudit, normalizeRepositoryUrl } from '../src/identity-audit.js';
import { runCaptureHandoff, captureHandoffBoundary } from '../src/capture-handoff.js';
import { buildCapturePlan, capturePlanBoundary } from '../src/capture-plan.js';
import {
  runVisualReviewResultPreparation,
  visualReviewResultPreparationBoundary
} from '../src/visual-review-result-preparation.js';
import {
  runVisualReviewExecutionRun,
  visualReviewExecutionBoundary
} from '../src/visual-review-execution.js';
import {
  runVisualReviewDashboard,
  visualReviewDashboardBoundary
} from '../src/visual-review-dashboard.js';
import {
  runVisualReviewAggregation,
  visualReviewAggregationBoundary
} from '../src/visual-review-aggregation.js';
import { handleMcpRequest } from '../src/mcp.js';
import { runObserve } from '../src/observe.js';
import { parseCliArgs } from '../src/parser.js';
import { PRODUCT_IDENTITY, filesystemSafeName } from '../src/product-identity.js';
import { redact, redactUrl } from '../src/redaction.js';
import { classifyActionCandidate, normalizeTargetManifest, runReview } from '../src/review.js';
import { buildLocalContentUxAdvisory } from '../src/content-ux-advisory.js';
import { createTargetManifest } from '../src/target.js';
import { ensureArtifactRoot } from '../src/artifacts.js';
import {
  createVisualEvidenceRecord,
  imageMetadata,
  readWorkspaceImageFile,
  writeVisualEvidenceRecord
} from '../src/visual-evidence.js';
import {
  buildVisualReviewProviderPolicy,
  normalizeVisualReviewDisclosureMode,
  visualReviewProviderBoundary
} from '../src/visual-review-provider-policy.js';
import {
  API_PROVIDER_CREDENTIAL_ENV,
  API_PROVIDER_ENDPOINT_ENV
} from '../src/agent-execution-providers.js';

const fixedNow = '2026-06-17T00:00:00.000Z';

test('doctor returns the JSON envelope without launching a browser', async () => {
  const result = await executeCli(['doctor', '--json'], {
    cwd: process.cwd(),
    nodeVersion: '24.14.1',
    platform: 'linux',
    now: fixedNow,
    importPlaywright: async () => ({ available: false, reason: 'module not found' })
  });

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.schema_version, '0.1.0');
  assert.equal(body.command, 'doctor');
  assert.equal(body.status, 'ok');
  assert.equal(body.observed_at, fixedNow);
  assert.equal(body.data.runtime.minimum_node_major, 20);
  assert.equal(body.data.schema_version_policy.current, '0.1.0');
  assert.equal(body.data.schema_version_policy.stage, 'mvp-pre-1.0');
  assert.equal(body.data.artifact_retention.mode, 'manual');
  assert.equal(body.data.artifact_retention.automatic_cleanup, false);
  assert.equal(body.artifacts.length, 0);
  assert.deepEqual(body.errors, []);
  assert.equal(body.warnings[0].code, 'PLAYWRIGHT_NOT_INSTALLED');
});

test('identity audit reports current and future rename readiness without mutating Git', async () => {
  const parsed = parseCliArgs(['identity', 'audit', '--json']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'identity audit');

  const result = await executeCli(['identity', 'audit', '--json'], {
    now: fixedNow,
    cwd: process.cwd(),
    gitRemoteUrl: `${PRODUCT_IDENTITY.repositoryUrl}.git`
  });
  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'identity audit');
  assert.equal(body.status, 'ok');
  assert.equal(body.data.identity_audit.schema_version, '1.0.0');
  assert.equal(body.data.identity_audit.identity.package_name, PRODUCT_IDENTITY.packageName);
  assert.equal(body.data.identity_audit.repository.origin_matches_current_repository_url, true);
  assert.equal(body.data.identity_audit.repository.origin_matches_future_repository_url, true);
  assert.equal(body.data.identity_audit.repository.remote_rename_pending, false);
  assert.equal(typeof body.data.identity_audit.readiness.physical_directory_rename_completed, 'boolean');
  assert.equal(
    [
      'ready_for_physical_rename_check',
      'physical_rename_complete_remote_rename_pending',
      'identity_rename_complete'
    ].includes(body.data.identity_audit.readiness.status),
    true
  );
  assert.equal(body.data.identity_audit.compatibility.legacy_alias_removal_authorized, false);
  assert.equal(body.data.identity_audit.compatibility.artifact_root_migration_authorized, false);
  assert.equal(body.data.boundary.git_mutated, false);
  assert.equal(body.data.boundary.remote_contact, false);
  assert.equal(body.data.boundary.artifacts_written, false);
  assert.equal(normalizeRepositoryUrl('git@github.com:xxxMasahiro/browser-debug-cli.git'), 'github.com/xxxMasahiro/browser-debug-cli');
  assert.equal(normalizeRepositoryUrl('ssh://git@github.com/xxxMasahiro/browser-debug-cli.git'), 'github.com/xxxMasahiro/browser-debug-cli');
  assert.equal(filesystemSafeName('@scope/trace cue'), 'scope-trace-cue');

  const direct = await runIdentityAudit({}, {
    cwd: process.cwd(),
    gitRemoteUrl: PRODUCT_IDENTITY.futureRepositoryUrl
  });
  assert.equal(direct.data.identity_audit.repository.origin_matches_future_repository_url, true);

  const fixtureParent = await mkdtemp(path.join(tmpdir(), 'trace-cue-identity-audit-'));
  const legacyRoot = path.join(fixtureParent, PRODUCT_IDENTITY.legacyPackageNames[0]);
  const futureRoot = path.join(fixtureParent, PRODUCT_IDENTITY.futureRepositoryName);
  await mkdir(path.join(legacyRoot, '.git'), { recursive: true });
  await mkdir(path.join(futureRoot, '.git'), { recursive: true });
  await writeFile(path.join(legacyRoot, '.git', 'config'), `[remote "origin"]\n\turl = ${PRODUCT_IDENTITY.repositoryUrl}.git\n`, 'utf8');
  await writeFile(path.join(futureRoot, '.git', 'config'), `[remote "origin"]\n\turl = ${PRODUCT_IDENTITY.legacyRepositoryUrls[0]}.git\n`, 'utf8');

  const legacyRootAudit = await buildIdentityAudit({ cwd: legacyRoot });
  assert.equal(legacyRootAudit.repository.physical_rename_pending, true);
  assert.equal(legacyRootAudit.readiness.physical_directory_rename_safe_to_test, true);
  assert.equal(legacyRootAudit.readiness.physical_directory_rename_completed, false);
  assert.equal(legacyRootAudit.readiness.status, 'ready_for_physical_rename_check');

  const futureRootAudit = await buildIdentityAudit({ cwd: futureRoot });
  assert.equal(futureRootAudit.repository.physical_rename_pending, false);
  assert.equal(futureRootAudit.readiness.physical_directory_rename_safe_to_test, false);
  assert.equal(futureRootAudit.readiness.physical_directory_rename_completed, true);
  assert.equal(futureRootAudit.readiness.status, 'physical_rename_complete_remote_rename_pending');

  const completedAudit = await buildIdentityAudit({
    cwd: futureRoot,
    gitRemoteUrl: PRODUCT_IDENTITY.repositoryUrl
  });
  assert.equal(completedAudit.repository.remote_rename_pending, false);
  assert.equal(completedAudit.readiness.status, 'identity_rename_complete');
});

test('resource status reports local memory boundaries without launching a browser', async () => {
  const parsed = parseCliArgs(['resource', 'status', '--json']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'resource status');

  const result = await executeCli(['resource', 'status', '--json'], {
    now: fixedNow,
    ...createResourceStatusContext()
  });

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'resource status');
  assert.equal(body.status, 'ok');
  assert.equal(body.data.resource_status.status, 'ok');
  assert.equal(body.data.resource_status.source, 'proc_meminfo');
  assert.equal(body.data.resource_status.memory.total_bytes, 1024 * 1024 * 1024);
  assert.equal(body.data.resource_status.memory.available_ratio, 0.25);
  assert.equal(body.data.resource_status.memory.swap_used_ratio, 0.25);
  assert.equal(body.data.resource_status.cgroup.version, 'v2');
  assert.equal(body.data.resource_status.cgroup.usage_ratio, 0.5);
  assert.equal(body.data.resource_status.pressure.available, true);
  assert.equal(body.data.resource_status.process.rss_bytes, 64 * 1024 * 1024);
  assert.equal(body.data.resource_status.cache_policy.automatic_system_cache_reclamation, false);
  assert.equal(body.data.resource_status.cache_policy.automatic_swap_configuration, false);
  assert.equal(body.data.boundary.browser_launched, false);
  assert.equal(body.data.boundary.external_upload, false);
  assert.equal(body.data.boundary.profile_reuse, false);
  assert.equal(body.data.boundary.system_cache_mutated, false);
  assert.equal(body.data.boundary.swap_mutated, false);
  assert.equal(body.data.boundary.cache_deleted, false);
  assert.equal(body.data.boundary.shell_used, false);
  assert.deepEqual(body.artifacts, []);
  assert.deepEqual(body.errors, []);
});

test('resource artifacts plan and explicit cleanup stay scoped to the artifact root', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'browser-debug-artifacts-'));
  await writeFile(path.join(cwd, '.gitignore'), '.browser-debug/\n', 'utf8');
  await mkdir(path.join(cwd, '.browser-debug', 'screenshots'), { recursive: true });
  await writeFile(path.join(cwd, '.browser-debug', 'screenshots', 'large-a.png'), '1234567890', 'utf8');
  await writeFile(path.join(cwd, '.browser-debug', 'screenshots', 'large-b.png'), '1234567890', 'utf8');

  const parsed = parseCliArgs(['resource', 'artifacts', 'plan', '--max-bytes', '5', '--json']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'resource artifacts plan');

  const planned = await executeCli(['resource', 'artifacts', 'plan', '--max-bytes', '5', '--json'], {
    cwd,
    now: fixedNow
  });
  assert.equal(planned.exitCode, 0);
  const plannedBody = JSON.parse(planned.stdout);
  assert.equal(plannedBody.command, 'resource artifacts plan');
  assert.equal(plannedBody.data.boundary.browser_launched, false);
  assert.equal(plannedBody.data.boundary.cache_deleted, false);
  assert.equal(plannedBody.data.cleanup_proposal.candidate_count >= 1, true);

  const dryRun = await executeCli(['resource', 'artifacts', 'cleanup', '--max-bytes', '5', '--dry-run', '--json'], {
    cwd,
    now: fixedNow
  });
  assert.equal(dryRun.exitCode, 0);
  const dryRunBody = JSON.parse(dryRun.stdout);
  assert.equal(dryRunBody.data.cleanup.dry_run, true);
  assert.equal(dryRunBody.data.boundary.cache_deleted, false);
  await access(path.join(cwd, '.browser-debug', 'screenshots', 'large-a.png'));

  const cleaned = await executeCli(['resource', 'artifacts', 'cleanup', '--max-bytes', '5', '--execute', '--json'], {
    cwd,
    now: fixedNow,
    createId: () => 'artifact-cleanup-fixed'
  });
  assert.equal(cleaned.exitCode, 0);
  const cleanedBody = JSON.parse(cleaned.stdout);
  assert.equal(cleanedBody.data.cleanup.execute, true);
  assert.equal(cleanedBody.data.cleanup.files_deleted >= 1, true);
  assert.equal(cleanedBody.data.boundary.cache_deleted, true);
  assert.equal(cleanedBody.artifacts[0].type, 'artifact_cleanup_receipt');
  const receipt = JSON.parse(
    await readFile(path.join(cwd, '.browser-debug', 'receipts', 'artifact-cleanup-fixed.json'), 'utf8')
  );
  assert.equal(receipt.execute, true);
  assert.equal(receipt.boundary.deletion_scope, 'artifact_root_only');
});

test('review resource guard can stop critical browser work before launch', async () => {
  let launches = 0;
  const result = await runReview({
    url: 'https://example.test/',
    'resource-guard': 'fail-critical'
  }, {
    now: fixedNow,
    collectResourceStatus: async () => criticalResourceStatus(),
    browserType: {
      async launch() {
        launches += 1;
        throw new Error('browser must not launch');
      }
    }
  });

  assert.equal(result.status, 'error');
  assert.equal(result.errors[0].code, 'RESOURCE_GUARD_CRITICAL');
  assert.equal(result.data.resource_guard.status, 'critical');
  assert.equal(result.data.resource_guard.stop_on_critical, true);
  assert.equal(result.data.resource_guard.boundary.browser_launched_by_guard, false);
  assert.equal(result.warnings.some((warning) => warning.code === 'RESOURCE_GUARD_CRITICAL'), true);
  assert.equal(launches, 0);
});

test('missing command produces a deterministic JSON error', async () => {
  const result = await executeCli(['--json'], { now: fixedNow });

  assert.equal(result.exitCode, 2);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'unknown');
  assert.equal(body.status, 'error');
  assert.equal(body.observed_at, fixedNow);
  assert.equal(body.errors[0].code, 'MISSING_COMMAND');
  assert.deepEqual(body.warnings, []);
  assert.deepEqual(body.artifacts, []);
});

test('observe requires an absolute URL', async () => {
  const result = await executeCli(['observe', '--json'], { now: fixedNow });

  assert.equal(result.exitCode, 2);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'observe');
  assert.equal(body.errors[0].code, 'MISSING_REQUIRED_OPTION');
  assert.equal(body.errors[0].details.option, 'url');
});

test('observe parses a URL and returns a deterministic JSON envelope', async () => {
  const result = await executeCli(
    ['observe', '--url', 'https://example.test/', '--trace', '--json'],
    {
      now: fixedNow,
      observeRunner: async (options) => ({
        status: 'ok',
        data: {
          id: 'observation-fixed',
          input_url: options.url,
          final_url: options.url,
          title: 'Fixture',
          page: { action_candidates: [] }
        },
        warnings: [],
        errors: [],
        artifacts: [{ type: 'observation', path: '.browser-debug/observations/observation-fixed.json' }]
      })
    }
  );

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'observe');
  assert.equal(body.status, 'ok');
  assert.equal(body.data.id, 'observation-fixed');
  assert.equal(result.envelope.data.input_url, 'https://example.test/');
  assert.equal(body.artifacts[0].type, 'observation');
});

test('parser keeps the planned session command surface explicit', () => {
  const parsed = parseCliArgs(['session', 'close', '--session', 'abc123', '--json']);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'session close');
  assert.equal(parsed.json, true);
  assert.equal(parsed.options.session, 'abc123');
});

test('supervise parses actions and returns a deterministic JSON envelope', async () => {
  const result = await executeCli(
    ['supervise', '--url', 'https://example.test/', '--actions', '[{"type":"observe"}]', '--json'],
    {
      now: fixedNow,
      supervisorRunner: async (options) => ({
        status: 'ok',
        data: {
          supervision: {
            id: 'supervision-fixed',
            current_url: options.url,
            action_history: JSON.parse(options.actions)
          },
          final_observation: { title: 'Supervision Fixture' }
        },
        warnings: [],
        errors: [],
        artifacts: [{ type: 'supervision', path: '.browser-debug/sessions/supervision-fixed.json' }]
      })
    }
  );

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'supervise');
  assert.equal(body.status, 'ok');
  assert.equal(body.data.supervision.id, 'supervision-fixed');
  assert.equal(body.data.supervision.action_history[0].type, 'observe');
});

test('review parses URL targets and returns a deterministic JSON envelope', async () => {
  const parsed = parseCliArgs(['review', '--url', 'https://example.test/', '--viewport', 'mobile', '--screenshot', '--resource-guard', 'fail-critical', '--json']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'review');
  assert.equal(parsed.options.url, 'https://example.test/');
  assert.equal(parsed.options.viewport, 'mobile');
  assert.equal(parsed.options.screenshot, true);
  assert.equal(parsed.options['resource-guard'], 'fail-critical');

  const result = await executeCli(
    ['review', '--url', 'https://example.test/', '--json'],
    {
      now: fixedNow,
      reviewRunner: async (options) => ({
        status: 'ok',
        data: {
          review: { id: 'review-fixed', mode: 'single_url', final_url: options.url },
          findings: [],
          metrics: { finding_count: 0 },
          environment: {}
        },
        warnings: [],
        errors: [],
        artifacts: [{ type: 'review', path: '.browser-debug/reviews/review-fixed.json' }]
      })
    }
  );

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'review');
  assert.equal(body.status, 'ok');
  assert.equal(body.data.review.id, 'review-fixed');
});

test('visual evidence core records local image metadata without embedding pixels', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-visual-evidence-'));
  const png = minimalPngBuffer(2, 3);
  await writeFile(path.join(cwd, 'fixture.png'), png);
  const loaded = await readWorkspaceImageFile({ cwd, inputPath: 'fixture.png' });
  assert.equal(loaded.workspace_path, 'fixture.png');
  assert.equal(loaded.media.format, 'png');
  assert.equal(loaded.media.width, 2);
  assert.equal(loaded.media.height, 3);
  assert.equal(loaded.media.bytes, png.length);
  assert.equal(loaded.media.sha256, imageMetadata(png).sha256);

  const record = createVisualEvidenceRecord({
    id: 'visual-fixed',
    createdAt: fixedNow,
    sourceKind: 'image_file',
    sourcePath: loaded.workspace_path,
    buffer: loaded.buffer,
    labels: ['standalone_image']
  });
  assert.equal(record.boundary.local_only, true);
  assert.equal(record.boundary.external_upload, false);
  assert.equal(record.boundary.provider_call_performed, false);
  assert.equal(record.boundary.raw_pixels_in_json, false);
  assert.equal(JSON.stringify(record).includes(png.toString('base64')), false);
  assert.equal(record.privacy.requires_owner_review_before_external_transfer, true);

  const root = await ensureArtifactRoot(cwd);
  record.boundary = {
    ...record.boundary,
    external_upload: true,
    provider_call_performed: true,
    binary_content_included: true,
    mcp_execution_exposed: true
  };
  const written = await writeVisualEvidenceRecord({ id: 'visual-fixed', root, artifactRoot: '.browser-debug', record });
  assert.equal(written.artifact.type, 'visual_evidence');
  assert.equal(written.artifact.path, '.browser-debug/visual-evidence/visual-fixed.json');
  const persisted = JSON.parse(await readFile(path.join(cwd, written.artifact.path), 'utf8'));
  assert.equal(persisted.media.sha256, record.media.sha256);
  assert.equal(persisted.boundary.external_upload, false);
  assert.equal(persisted.boundary.provider_call_performed, false);
  assert.equal(persisted.boundary.binary_content_included, false);
  assert.equal(persisted.boundary.mcp_execution_exposed, false);

  const outside = await mkdtemp(path.join(tmpdir(), 'trace-cue-visual-outside-'));
  await writeFile(path.join(outside, 'outside.png'), png);
  await assert.rejects(
    () => readWorkspaceImageFile({ cwd, inputPath: path.relative(cwd, path.join(outside, 'outside.png')) }),
    /must stay inside the current workspace/
  );
});

test('visual review provider policy stays planning-only and strips raw image transfer by default', () => {
  const policy = buildVisualReviewProviderPolicy({
    disclosureMode: 'explicit_image_transfer',
    agentPackage: {
      packet: {
        evidence_packet: {
          artifacts: [
            { type: 'visual_evidence', path: '.browser-debug/visual-evidence/visual-fixed.json', content_included: false },
            { type: 'screenshot', path: '.browser-debug/screenshots/page.png', content_included: false }
          ]
        }
      }
    },
    surface: { id: 'local-subscription-agent', kind: 'subscription_surface', transport: 'local_files' },
    provider: { id: 'fake-agent', kind: 'local_runner', implemented: true },
    model: { id: 'fake-model', selected: true }
  });

  assert.equal(policy.status, 'blocked_external_transfer_requires_owner_review');
  assert.equal(policy.disclosure.raw_pixels_included, false);
  assert.equal(policy.disclosure.external_evidence_transfer_authorized, false);
  assert.equal(policy.disclosure.provider_execution_authorized, false);
  assert.equal(policy.execution.provider_call_performed, false);
  assert.equal(policy.execution.mcp_execution_exposed, false);
  assert.equal(policy.visual_evidence.visual_evidence_reference_count, 1);
  assert.equal(visualReviewProviderBoundary().future_execute_required, true);
  assert.equal(normalizeVisualReviewDisclosureMode('local_reference'), 'local_reference');
  assert.throws(() => normalizeVisualReviewDisclosureMode('raw_pixels'), /Unsupported visual review disclosure mode/);
});

test('standalone image review reads a workspace image without launching a browser or embedding pixels', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-image-review-'));
  const png = minimalPngBuffer(120, 80);
  await writeFile(path.join(cwd, 'screen.png'), png);

  const parsed = parseCliArgs(['review', '--image', 'screen.png', '--report', '--json']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'review');
  assert.equal(parsed.options.image, 'screen.png');
  assert.equal(parseCliArgs(['review', '--image', 'https://example.test/a.png', '--json']).ok, false);
  assert.equal(parseCliArgs(['review', '--image', '../screen.png', '--json']).ok, false);
  assert.equal(parseCliArgs(['review', '--image', 'screen.png', '--provider', 'fake-agent', '--json']).ok, false);

  const result = await executeCli(['review', '--image', 'screen.png', '--report', '--json'], {
    cwd,
    now: fixedNow,
    createId: () => 'image-review-fixed'
  });
  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'review');
  assert.equal(body.data.review.mode, 'image_file');
  assert.equal(body.data.metrics.width, 120);
  assert.equal(body.data.metrics.height, 80);
  assert.equal(body.data.boundary.browser_launched, false);
  assert.equal(body.data.boundary.provider_call_performed, false);
  assert.equal(body.data.boundary.raw_pixels_in_json, false);
  assert.equal(body.data.boundary.workspace_confined_input, true);
  assert.equal(JSON.stringify(body.data).includes(png.toString('base64')), false);
  assert.equal(body.artifacts.some((artifact) => artifact.type === 'image_review'), true);
  assert.equal(body.artifacts.some((artifact) => artifact.type === 'visual_evidence'), true);
  assert.equal(body.artifacts.some((artifact) => artifact.type === 'review_artifact_index'), true);
  assert.equal(body.artifacts.some((artifact) => artifact.type === 'image_review_report'), true);

  const imageReviewFile = JSON.parse(await readFile(path.join(cwd, '.browser-debug', 'reviews', 'image-review-fixed.json'), 'utf8'));
  assert.equal(imageReviewFile.image_review.visual_evidence.boundary.provider_call_performed, false);
  assert.equal(imageReviewFile.evidence_summary.binary_content_included, false);
  assert.equal(imageReviewFile.artifact_index.evidence_classes.includes('visual evidence metadata'), true);
  const imageReviewIndex = JSON.parse(await readFile(path.join(cwd, '.browser-debug', 'review-artifacts', 'image-review-fixed.json'), 'utf8'));
  assert.equal(imageReviewIndex.mode, 'image_file');
  assert.equal(imageReviewIndex.boundaries.provider_call_performed, false);

  const direct = await runImageReview({ image: 'screen.png' }, {
    cwd,
    now: fixedNow,
    createId: () => 'image-review-direct'
  });
  assert.equal(direct.status, 'ok');
  assert.equal(direct.data.boundary.external_upload, false);
});

test('desktop image review preserves caller-declared desktop provenance through visual preparation', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-desktop-image-review-'));
  const png = minimalPngBuffer(240, 160);
  await writeFile(path.join(cwd, 'desktop.png'), png);

  const handoff = await executeCli(['capture', 'handoff', '--image', 'desktop.png', '--source', 'desktop-app', '--json'], {
    cwd,
    now: fixedNow
  });
  assert.equal(handoff.exitCode, 0);
  const handoffBody = JSON.parse(handoff.stdout);
  await writeFile(path.join(cwd, 'handoff.json'), JSON.stringify(handoffBody, null, 2));

  const parsed = parseCliArgs(['review', '--image', 'desktop.png', '--capture-handoff', 'handoff.json', '--json']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.options['capture-handoff'], 'handoff.json');
  assert.equal(parseCliArgs(['review', '--image', 'desktop.png', '--source', 'desktop-app', '--json']).ok, true);
  assert.equal(parseCliArgs(['review', '--image', 'desktop.png', '--source', 'all', '--json']).ok, false);
  assert.equal(parseCliArgs(['review', '--url', 'https://example.test', '--source', 'desktop-app', '--json']).ok, false);
  assert.equal(parseCliArgs(['review', '--url', 'https://example.test', '--capture-handoff', 'handoff.json', '--json']).ok, false);

  const review = await executeCli(['review', '--image', 'desktop.png', '--capture-handoff', 'handoff.json', '--json'], {
    cwd,
    now: fixedNow,
    createId: () => 'desktop-image-review-fixed'
  });
  assert.equal(review.exitCode, 0);
  const reviewBody = JSON.parse(review.stdout);
  assert.equal(reviewBody.data.review.mode, 'image_file');
  assert.equal(reviewBody.data.review.source_kind, 'desktop_app_capture');
  assert.equal(reviewBody.data.review.source_selection, 'desktop-app');
  assert.equal(reviewBody.data.review.source_verified_by_trace_cue, false);
  assert.equal(reviewBody.data.review.capture_handoff_id, handoffBody.data.capture_handoff.id);
  assert.equal(reviewBody.data.image_review.source.kind, 'desktop_app_capture');
  assert.equal(reviewBody.data.image_review.source.caller_declared_provenance, true);
  assert.equal(reviewBody.data.image_review.capture_handoff.input_path, 'handoff.json');
  assert.equal(reviewBody.data.image_review.capture_handoff.media_sha256_matched, true);
  assert.equal(reviewBody.data.evidence_summary.capture_handoff_path, 'handoff.json');
  assert.equal(typeof reviewBody.data.evidence_summary.capture_handoff_hash, 'string');
  assert.equal(reviewBody.data.boundary.capture_handoff_json_read, true);
  assert.equal(reviewBody.data.boundary.capture_handoff_media_sha256_matched, true);
  assert.equal(reviewBody.data.boundary.capture_performed_by_trace_cue, false);
  assert.equal(reviewBody.data.boundary.os_capture_api_used, false);
  assert.equal(JSON.stringify(reviewBody.data).includes(png.toString('base64')), false);

  const visualEvidence = JSON.parse(await readFile(path.join(cwd, '.browser-debug', 'visual-evidence', 'desktop-image-review-fixed.json'), 'utf8'));
  assert.equal(visualEvidence.source.kind, 'desktop_app_capture');
  assert.equal(visualEvidence.capture.handoff_id, handoffBody.data.capture_handoff.id);
  assert.equal(visualEvidence.capture.media_sha256_matched, true);
  assert.equal(visualEvidence.privacy.may_contain_desktop_content, true);
  assert.equal(visualEvidence.boundary.raw_pixels_in_json, false);

  const index = JSON.parse(await readFile(path.join(cwd, '.browser-debug', 'review-artifacts', 'desktop-image-review-fixed.json'), 'utf8'));
  assert.match(index.rerun.command, /--capture-handoff handoff\.json/);
  assert.equal(index.boundaries.source_verified_by_trace_cue, false);
  assert.equal(index.boundaries.capture_handoff_json_read, true);
  assert.equal(index.boundaries.capture_handoff_media_sha256_matched, true);
  assert.equal(index.boundaries.provider_call_performed, false);

  const preparation = await executeCli([
    'visual',
    'review',
    'prepare',
    '--review-index',
    '.browser-debug/review-artifacts/desktop-image-review-fixed.json',
    '--surface',
    'desktop-app',
    '--provider',
    'fake-agent',
    '--model',
    'fake-model',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: () => 'desktop-visual-preparation-fixed'
  });
  assert.equal(preparation.exitCode, 0);
  const preparationBody = JSON.parse(preparation.stdout);
  assert.equal(preparationBody.data.visual_review_result_preparation.visual_evidence.references[0].source.kind, 'desktop_app_capture');
  assert.equal(preparationBody.data.visual_review_result_preparation.visual_evidence.references[0].privacy.may_contain_desktop_content, true);
  assert.equal(preparationBody.data.visual_review_result_preparation.provider_policy.execution.provider_call_performed, false);
  assert.equal(preparationBody.data.visual_review_result_preparation.execution.mcp_execution_exposed, false);

  const pathMismatch = {
    ...handoffBody,
    data: {
      ...handoffBody.data,
      capture_handoff: {
        ...handoffBody.data.capture_handoff,
        source: {
          ...handoffBody.data.capture_handoff.source,
          path: 'other.png'
        }
      }
    }
  };
  await writeFile(path.join(cwd, 'path-mismatch.json'), JSON.stringify(pathMismatch, null, 2));
  const mismatch = await executeCli(['review', '--image', 'desktop.png', '--capture-handoff', 'path-mismatch.json', '--json'], {
    cwd,
    now: fixedNow
  });
  assert.equal(mismatch.exitCode, 1);
  assert.equal(JSON.parse(mismatch.stdout).errors[0].code, 'IMAGE_REVIEW_CAPTURE_HANDOFF_IMAGE_MISMATCH');

  const hashMismatch = {
    ...handoffBody,
    data: {
      ...handoffBody.data,
      capture_handoff: {
        ...handoffBody.data.capture_handoff,
        media: {
          ...handoffBody.data.capture_handoff.media,
          sha256: '0'.repeat(64)
        }
      }
    }
  };
  await writeFile(path.join(cwd, 'hash-mismatch.json'), JSON.stringify(hashMismatch, null, 2));
  const badHash = await executeCli(['review', '--image', 'desktop.png', '--capture-handoff', 'hash-mismatch.json', '--json'], {
    cwd,
    now: fixedNow
  });
  assert.equal(badHash.exitCode, 1);
  assert.equal(JSON.parse(badHash.stdout).errors[0].code, 'IMAGE_REVIEW_CAPTURE_HANDOFF_HASH_MISMATCH');
});

test('visual review prepare writes metadata-only result preparation without provider execution', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-visual-prepare-'));
  const png = minimalPngBuffer(120, 80);
  await writeFile(path.join(cwd, 'screen.png'), png);

  const imageReview = await executeCli(['review', '--image', 'screen.png', '--json'], {
    cwd,
    now: fixedNow,
    createId: () => 'image-review-fixed'
  });
  assert.equal(imageReview.exitCode, 0);

  const parsed = parseCliArgs([
    'visual',
    'review',
    'prepare',
    '--review-index',
    '.browser-debug/review-artifacts/image-review-fixed.json',
    '--surface',
    'local-subscription-agent',
    '--provider',
    'fake-agent',
    '--model',
    'fake-model',
    '--json'
  ]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'visual review prepare');
  assert.equal(parseCliArgs(['visual', 'review', 'prepare', '--review-index', '.browser-debug/review-artifacts/image-review-fixed.json', '--execute', '--json']).ok, false);

  const result = await executeCli([
    'visual',
    'review',
    'prepare',
    '--review-index',
    '.browser-debug/review-artifacts/image-review-fixed.json',
    '--surface',
    'local-subscription-agent',
    '--provider',
    'fake-agent',
    '--model',
    'fake-model',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: () => 'visual-review-preparation-fixed'
  });
  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'visual review prepare');
  const preparation = body.data.visual_review_result_preparation;
  assert.equal(preparation.status, 'prepared');
  assert.equal(preparation.visual_evidence.metadata_only, true);
  assert.equal(preparation.visual_evidence.readable_count, 1);
  assert.equal(preparation.visual_evidence.references[0].media.width, 120);
  assert.equal(preparation.disclosure_policy.raw_pixels_included, false);
  assert.equal(preparation.disclosure_policy.raw_artifact_content_included, false);
  assert.equal(preparation.provider_policy.execution.provider_call_performed, false);
  assert.equal(preparation.execution.enabled, false);
  assert.equal(preparation.execution.execute_supported, false);
  assert.equal(preparation.execution.mcp_execution_exposed, false);
  assert.equal(preparation.boundary.existing_review_mutated, false);
  assert.equal(preparation.result_contract.required_output_schema, 'visual_review_result');
  assert.equal(body.data.visual_review_result_template.status, 'not_run');
  assert.equal(JSON.stringify(body.data).includes(png.toString('base64')), false);
  assert.equal(body.artifacts.some((artifact) => artifact.type === 'visual_review_result_preparation'), true);
  assert.equal(body.artifacts.some((artifact) => artifact.type === 'visual_review_result_preparation_receipt'), true);

  const preparationFile = JSON.parse(await readFile(path.join(cwd, '.browser-debug', 'visual-review-results', 'visual-review-preparation-fixed', 'preparation.json'), 'utf8'));
  assert.equal(preparationFile.raw_pixels_included, false);
  assert.equal(preparationFile.provider_call_performed, false);
  const receiptFile = JSON.parse(await readFile(path.join(cwd, '.browser-debug', 'receipts', 'visual-review-preparation-fixed.json'), 'utf8'));
  assert.equal(receiptFile.raw_pixels_included, false);
  assert.equal(receiptFile.provider_call_performed, false);

  const direct = await runVisualReviewResultPreparation({
    'review-index': '.browser-debug/review-artifacts/image-review-fixed.json'
  }, {
    cwd,
    now: fixedNow,
    createId: () => 'visual-review-preparation-direct'
  });
  assert.equal(direct.status, 'ok');
  assert.equal(direct.data.boundary.external_evidence_transfer, false);
  assert.equal(visualReviewResultPreparationBoundary().mcp_execution_exposed, false);
});

test('visual review run executes metadata-only visual review providers and writes normalized results', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-visual-run-'));
  const png = minimalPngBuffer(120, 80);
  await writeFile(path.join(cwd, 'screen.png'), png);

  const imageReview = await executeCli(['review', '--image', 'screen.png', '--json'], {
    cwd,
    now: fixedNow,
    createId: () => 'image-review-visual-run'
  });
  assert.equal(imageReview.exitCode, 0);

  const preparation = await executeCli([
    'visual',
    'review',
    'prepare',
    '--review-index',
    '.browser-debug/review-artifacts/image-review-visual-run.json',
    '--surface',
    'local-subscription-agent',
    '--provider',
    'fake-agent',
    '--model',
    'fake-model',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: () => 'visual-review-preparation-run'
  });
  assert.equal(preparation.exitCode, 0);

  const parsed = parseCliArgs([
    'visual',
    'review',
    'run',
    '--preparation',
    '.browser-debug/visual-review-results/visual-review-preparation-run/preparation.json',
    '--surface',
    'local-subscription-agent',
    '--provider',
    'fake-agent',
    '--model',
    'fake-model',
    '--execute',
    '--json'
  ]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'visual review run');
  assert.equal(parseCliArgs([
    'visual',
    'review',
    'run',
    '--preparation',
    '.browser-debug/visual-review-results/visual-review-preparation-run/preparation.json',
    '--surface',
    'local-subscription-agent',
    '--provider',
    'fake-agent',
    '--model',
    'fake-model',
    '--json'
  ]).ok, false);

  const run = await executeCli([
    'visual',
    'review',
    'run',
    '--preparation',
    '.browser-debug/visual-review-results/visual-review-preparation-run/preparation.json',
    '--surface',
    'local-subscription-agent',
    '--provider',
    'fake-agent',
    '--model',
    'fake-model',
    '--execute',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: (prefix) => prefix === 'visual-review-execution' ? 'visual-review-execution-fixed' : 'visual-review-result-fixed'
  });
  assert.equal(run.exitCode, 0);
  const body = JSON.parse(run.stdout);
  assert.equal(body.command, 'visual review run');
  assert.equal(body.data.visual_review_execution.status, 'completed');
  assert.equal(body.data.visual_review_execution.result_path, '.browser-debug/visual-review-results/visual-review-execution-fixed/result.json');
  assert.equal(body.data.visual_review_execution.provider_call_performed, true);
  assert.equal(body.data.visual_review_execution.api_call_performed, false);
  assert.equal(body.data.visual_review_execution.external_evidence_transfer, false);
  assert.equal(body.data.visual_review_execution.raw_pixels_included, false);
  assert.equal(body.data.visual_review_execution.raw_pixels_read, false);
  assert.equal(body.data.visual_review_execution.raw_pixels_transferred, false);
  assert.equal(body.data.visual_review_execution.raw_provider_response_stored, false);
  assert.equal(body.data.visual_review_execution.existing_review_mutated, false);
  assert.equal(body.data.visual_review_execution.mcp_execution_exposed, false);
  assert.equal(body.data.visual_review_result.status, 'completed');
  assert.equal(body.artifacts.some((artifact) => artifact.type === 'visual_review_result'), true);
  assert.equal(body.artifacts.some((artifact) => artifact.type === 'visual_review_execution'), true);
  assert.equal(JSON.stringify(body.data).includes(png.toString('base64')), false);

  const resultFile = JSON.parse(await readFile(path.join(cwd, '.browser-debug', 'visual-review-results', 'visual-review-execution-fixed', 'result.json'), 'utf8'));
  assert.equal(resultFile.status, 'completed');
  assert.equal(resultFile.visual_review_result.untrusted_model_output, true);
  assert.equal(resultFile.boundary.raw_pixels_included, false);
  assert.equal(resultFile.boundary.raw_provider_response_stored, false);
  const executionFile = JSON.parse(await readFile(path.join(cwd, '.browser-debug', 'visual-review-results', 'visual-review-execution-fixed', 'execution.json'), 'utf8'));
  assert.equal(executionFile.dashboard_handoff.status_command, 'trace-cue visual review status --execution .browser-debug/visual-review-results/visual-review-execution-fixed/execution.json --json');
  const receiptFile = JSON.parse(await readFile(path.join(cwd, '.browser-debug', 'receipts', 'visual-review-execution-fixed-visual-review-run.json'), 'utf8'));
  assert.equal(receiptFile.raw_pixels_included, false);
  assert.equal(receiptFile.raw_provider_response_stored, false);

  const status = await executeCli([
    'visual',
    'review',
    'status',
    '--execution',
    '.browser-debug/visual-review-results/visual-review-execution-fixed/execution.json',
    '--json'
  ], {
    cwd,
    now: fixedNow
  });
  assert.equal(status.exitCode, 0);
  assert.equal(JSON.parse(status.stdout).data.visual_review_execution_status.status, 'completed');

  const list = await executeCli(['visual', 'review', 'list', '--json'], {
    cwd,
    now: fixedNow
  });
  assert.equal(list.exitCode, 0);
  const listBody = JSON.parse(list.stdout);
  assert.equal(listBody.data.summary.total, 1);
  assert.equal(listBody.data.summary.completed, 1);
  assert.equal(listBody.data.summary.raw_pixels_included, false);

  const direct = await runVisualReviewExecutionRun({
    preparation: '.browser-debug/visual-review-results/visual-review-preparation-run/preparation.json',
    surface: 'local-subscription-agent',
    provider: 'fake-agent',
    model: 'fake-model',
    execute: true
  }, {
    cwd,
    now: fixedNow,
    createId: (prefix) => prefix === 'visual-review-execution' ? 'visual-review-execution-direct' : 'visual-review-result-direct'
  });
  assert.equal(direct.status, 'ok');
  assert.equal(direct.data.boundary.raw_pixels_transferred, false);
  assert.equal(visualReviewExecutionBoundary().mcp_execution_exposed, false);
});

test('visual review aggregate combines local visual review results without provider calls or writes', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-visual-aggregate-'));
  await mkdir(path.join(cwd, '.browser-debug', 'visual-review-results', 'prep'), { recursive: true });
  await mkdir(path.join(cwd, '.browser-debug', 'visual-review-results', 'agent-a'), { recursive: true });
  await mkdir(path.join(cwd, '.browser-debug', 'visual-review-results', 'agent-b'), { recursive: true });
  await mkdir(path.join(cwd, '.browser-debug', 'visual-review-results', 'broken'), { recursive: true });

  const preparation = {
    schema_version: '0.1.0',
    id: 'prep-aggregate',
    status: 'prepared',
    visual_evidence: { references: [] }
  };
  await writeFile(path.join(cwd, '.browser-debug', 'visual-review-results', 'prep', 'preparation.json'), JSON.stringify(preparation, null, 2));

  const baseResult = {
    schema_version: '0.1.0',
    status: 'needs_owner_review',
    preparation_id: 'prep-aggregate',
    preparation_path: '.browser-debug/visual-review-results/prep/preparation.json',
    visual_review_result: {
      summary: 'Visual review advisory only.'
    },
    boundary: {
      provider_call_performed: true,
      api_call_performed: false,
      external_evidence_transfer: false,
      raw_pixels_included: false,
      raw_provider_response_stored: false
    }
  };
  await writeFile(path.join(cwd, '.browser-debug', 'visual-review-results', 'agent-a', 'result.json'), JSON.stringify({
    ...baseResult,
    id: 'result-a',
    execution_id: 'agent-a',
    provider: { id: 'fake-agent', kind: 'deterministic_fake' },
    model: { id: 'model-a' },
    advisory_findings: [{
      id: 'finding-a',
      category: 'layout_integrity',
      severity: 'medium',
      message: 'Primary action alignment needs owner review.',
      recommendation: 'Review the primary action placement with the owner.'
    }],
    owner_decision_requests: [{
      id: 'decision-a',
      question: 'Should the primary action stay in this position?'
    }]
  }, null, 2));
  await writeFile(path.join(cwd, '.browser-debug', 'visual-review-results', 'agent-a', 'execution.json'), JSON.stringify({
    id: 'agent-a',
    status: 'completed'
  }, null, 2));
  await writeFile(path.join(cwd, '.browser-debug', 'visual-review-results', 'agent-b', 'result.json'), JSON.stringify({
    ...baseResult,
    id: 'result-b',
    execution_id: 'agent-b',
    provider: { id: 'local-runner', kind: 'local_callback' },
    model: { id: 'model-b' },
    advisory_findings: [{
      id: 'finding-b',
      category: 'layout_integrity',
      severity: 'high',
      message: 'Primary action alignment needs owner review.',
      recommendation: 'Review the primary action placement with the owner.'
    }]
  }, null, 2));
  await writeFile(path.join(cwd, '.browser-debug', 'visual-review-results', 'broken', 'result.json'), '{');

  const parsed = parseCliArgs(['visual', 'review', 'aggregate', '--preparation', '.browser-debug/visual-review-results/prep/preparation.json', '--limit', '10', '--json']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'visual review aggregate');
  assert.equal(parseCliArgs(['visual', 'review', 'aggregate', '--preparation', '.browser-debug/visual-review-results/prep/preparation.json', '--execute', '--json']).ok, false);
  assert.equal(parseCliArgs(['visual', 'review', 'aggregate', '--preparation', '.browser-debug/visual-review-results/prep/preparation.json', '--provider', 'fake-agent', '--json']).ok, false);

  const result = await executeCli(['visual', 'review', 'aggregate', '--preparation', '.browser-debug/visual-review-results/prep/preparation.json', '--limit', '10', '--json'], {
    cwd,
    now: fixedNow
  });
  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'visual review aggregate');
  const aggregation = body.data.visual_review_aggregation;
  assert.equal(aggregation.status, 'completed');
  assert.equal(aggregation.summary.result_count, 2);
  assert.equal(aggregation.summary.review_agent_count, 2);
  assert.equal(aggregation.summary.corroborated_finding_count, 1);
  assert.equal(aggregation.summary.conflict_count, 1);
  assert.equal(aggregation.aggregation_findings[0].status, 'corroborated');
  assert.deepEqual(aggregation.aggregation_findings[0].source_severities, ['medium', 'high']);
  assert.equal(aggregation.owner_decision_requests.length, 1);
  assert.equal(aggregation.source_effects.provider_call_performed, true);
  assert.equal(aggregation.boundary.provider_call_performed, false);
  assert.equal(aggregation.boundary.writes_artifacts, false);
  assert.equal(aggregation.boundary.raw_pixels_read, false);
  assert.equal(aggregation.boundary.mcp_execution_exposed, false);
  assert.deepEqual(body.artifacts, []);
  assert.equal(JSON.stringify(body.data).includes('secret-provider-payload'), false);
  assert.ok(body.warnings.some((warning) => warning.code === 'VISUAL_REVIEW_AGGREGATION_ARTIFACT_INVALID_JSON'));

  const direct = await runVisualReviewAggregation({
    preparation: '.browser-debug/visual-review-results/prep/preparation.json',
    limit: 10
  }, { cwd, now: fixedNow });
  assert.equal(direct.status, 'ok');
  assert.equal(direct.data.visual_review_aggregation.summary.result_count, 2);
  assert.equal(visualReviewAggregationBoundary().mcp_execution_exposed, false);
});

test('visual review dashboard aggregates local visual review status without writes', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-visual-dashboard-'));
  const png = minimalPngBuffer(120, 80);
  await writeFile(path.join(cwd, 'screen.png'), png);

  const imageReview = await executeCli(['review', '--image', 'screen.png', '--json'], {
    cwd,
    now: fixedNow,
    createId: () => 'image-review-dashboard'
  });
  assert.equal(imageReview.exitCode, 0);

  const preparation = await executeCli([
    'visual',
    'review',
    'prepare',
    '--review-index',
    '.browser-debug/review-artifacts/image-review-dashboard.json',
    '--surface',
    'local-subscription-agent',
    '--provider',
    'fake-agent',
    '--model',
    'fake-model',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: () => 'visual-review-preparation-dashboard'
  });
  assert.equal(preparation.exitCode, 0);

  const run = await executeCli([
    'visual',
    'review',
    'run',
    '--preparation',
    '.browser-debug/visual-review-results/visual-review-preparation-dashboard/preparation.json',
    '--surface',
    'local-subscription-agent',
    '--provider',
    'fake-agent',
    '--model',
    'fake-model',
    '--execute',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: (prefix) => prefix === 'visual-review-execution' ? 'visual-review-execution-dashboard' : 'visual-review-result-dashboard'
  });
  assert.equal(run.exitCode, 0);

  const parsed = parseCliArgs(['visual', 'review', 'dashboard', '--limit', '10', '--json']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'visual review dashboard');

  const dashboard = await executeCli(['visual', 'review', 'dashboard', '--limit', '10', '--json'], {
    cwd,
    now: fixedNow
  });
  assert.equal(dashboard.exitCode, 0);
  const body = JSON.parse(dashboard.stdout);
  assert.equal(body.command, 'visual review dashboard');
  assert.equal(body.data.visual_review_dashboard.status, 'ready');
  assert.equal(body.data.visual_review_dashboard.summary.preparation_count, 1);
  assert.equal(body.data.visual_review_dashboard.summary.execution_count, 1);
  assert.equal(body.data.visual_review_dashboard.summary.result_count, 1);
  assert.equal(body.data.visual_review_dashboard.summary.provider_call_performed, true);
  assert.equal(body.data.visual_review_dashboard.boundary.read_only, true);
  assert.equal(body.data.visual_review_dashboard.boundary.writes_artifacts, false);
  assert.equal(body.data.visual_review_dashboard.boundary.provider_call_performed, false);
  assert.equal(body.data.visual_review_dashboard.boundary.raw_pixels_read, false);
  assert.equal(body.data.visual_review_dashboard.control_center_handoff.mcp_tool, 'browser_debug_visual_review_dashboard');
  assert.equal(body.data.visual_review_dashboard.gate_effect, 'none');
  assert.deepEqual(body.artifacts, []);
  assert.equal(JSON.stringify(body.data).includes(png.toString('base64')), false);

  const direct = await runVisualReviewDashboard({}, { cwd, now: fixedNow });
  assert.equal(direct.status, 'ok');
  assert.equal(direct.data.visual_review_dashboard.status, 'ready');
  assert.equal(direct.data.boundary.read_only, true);
  assert.equal(visualReviewDashboardBoundary().mcp_write_execute_exposed, false);

  const mcpDashboard = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 45,
    method: 'tools/call',
    params: {
      name: 'browser_debug_visual_review_dashboard',
      arguments: { limit: 10 }
    }
  }, { cwd, mcpProfile: 'safe', now: fixedNow });
  assert.equal(mcpDashboard.result.structuredContent.command, 'visual review dashboard');
  assert.equal(mcpDashboard.result.structuredContent.data.visual_review_dashboard.summary.execution_count, 1);
  assert.equal(mcpDashboard.result.structuredContent.data.boundary.read_only, true);
});

test('visual review run blocks unsafe preparation states', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-visual-run-blocked-'));
  await mkdir(path.join(cwd, '.browser-debug', 'visual-review-results', 'blocked'), { recursive: true });
  await writeFile(path.join(cwd, '.browser-debug', 'visual-review-results', 'blocked', 'preparation.json'), JSON.stringify({
    schema_version: '0.1.0',
    id: 'blocked-preparation',
    status: 'blocked_missing_visual_evidence',
    result_contract: { required_output_schema: 'visual_review_result' },
    visual_evidence: { readable_count: 0, references: [] },
    provider_policy: { surface: { id: 'local-subscription-agent' }, provider: { id: 'fake-agent' }, model: { id: 'fake-model' } },
    disclosure_policy: { raw_pixels_included: false, raw_artifact_content_included: false },
    boundary: {}
  }, null, 2), 'utf8');

  const blocked = await executeCli([
    'visual',
    'review',
    'run',
    '--preparation',
    '.browser-debug/visual-review-results/blocked/preparation.json',
    '--surface',
    'local-subscription-agent',
    '--provider',
    'fake-agent',
    '--model',
    'fake-model',
    '--execute',
    '--json'
  ], {
    cwd,
    now: fixedNow
  });
  assert.equal(blocked.exitCode, 1);
  assert.equal(JSON.parse(blocked.stdout).errors[0].code, 'VISUAL_REVIEW_PREPARATION_NOT_RUNNABLE');

  await writeFile(path.join(cwd, '.browser-debug', 'visual-review-results', 'blocked', 'preparation.json'), JSON.stringify({
    schema_version: '0.1.0',
    id: 'unsafe-preparation',
    status: 'prepared',
    result_contract: { required_output_schema: 'visual_review_result' },
    visual_evidence: { readable_count: 1, references: [{ path: '.browser-debug/visual-evidence/example.json' }] },
    provider_policy: { surface: { id: 'local-subscription-agent' }, provider: { id: 'fake-agent' }, model: { id: 'fake-model' } },
    disclosure_policy: { raw_pixels_included: true, raw_artifact_content_included: false },
    boundary: {}
  }, null, 2), 'utf8');

  const unsafe = await executeCli([
    'visual',
    'review',
    'run',
    '--preparation',
    '.browser-debug/visual-review-results/blocked/preparation.json',
    '--surface',
    'local-subscription-agent',
    '--provider',
    'fake-agent',
    '--model',
    'fake-model',
    '--execute',
    '--json'
  ], {
    cwd,
    now: fixedNow
  });
  assert.equal(unsafe.exitCode, 1);
  assert.equal(JSON.parse(unsafe.stdout).errors[0].code, 'VISUAL_REVIEW_PREPARATION_UNSUPPORTED_DISCLOSURE');
});

test('visual review run can use local and API providers without storing credentials or raw responses', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-visual-run-provider-'));
  await mkdir(path.join(cwd, '.browser-debug', 'visual-review-results', 'prepared'), { recursive: true });
  const preparation = {
    schema_version: '0.1.0',
    id: 'provider-preparation',
    status: 'prepared',
    result_contract: { required_output_schema: 'visual_review_result' },
    visual_evidence: {
      readable_count: 1,
      references: [{
        id: 'visual-evidence-1',
        path: '.browser-debug/visual-evidence/visual-evidence-1.json',
        media: { width: 100, height: 80, sha256: 'hash' }
      }]
    },
    provider_policy: {
      surface: { id: null },
      provider: { id: null },
      model: { id: null }
    },
    disclosure_policy: {
      raw_pixels_included: false,
      raw_artifact_content_included: false,
      binary_content_included: false,
      screenshot_binary_included: false,
      raw_dom_included: false,
      trace_content_included: false,
      raw_console_payloads_included: false,
      raw_network_payloads_included: false,
      raw_report_body_included: false,
      source_data_values_included: false
    },
    boundary: {}
  };
  await writeFile(path.join(cwd, '.browser-debug', 'visual-review-results', 'prepared', 'preparation.json'), JSON.stringify(preparation, null, 2), 'utf8');

  const localRun = await executeCli([
    'visual',
    'review',
    'run',
    '--preparation',
    '.browser-debug/visual-review-results/prepared/preparation.json',
    '--surface',
    'local-subscription-agent',
    '--provider',
    'local-runner',
    '--model',
    'local-agent',
    '--execute',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: (prefix) => prefix === 'visual-review-execution' ? 'visual-review-execution-local' : 'visual-review-result-local',
    visualReviewLocalRunner: async ({ preparation_path: preparationPath }) => ({
      summary: `Local visual review used ${preparationPath}.`,
      advisory_findings: [{
        id: 'visual-local-finding',
        category: 'layout_integrity',
        severity: 'medium',
        message: 'Local visual review advisory.',
        recommendation: 'Review the local visual advisory.'
      }],
      owner_decision_requests: []
    })
  });
  assert.equal(localRun.exitCode, 0);
  const localBody = JSON.parse(localRun.stdout);
  assert.equal(localBody.data.visual_review_execution.provider_call_performed, true);
  assert.equal(localBody.data.visual_review_execution.api_call_performed, false);
  const localResult = JSON.parse(await readFile(path.join(cwd, '.browser-debug', 'visual-review-results', 'visual-review-execution-local', 'result.json'), 'utf8'));
  assert.equal(localResult.advisory_findings.length, 1);
  assert.equal(localResult.status, 'needs_owner_review');

  const apiMissing = await executeCli([
    'visual',
    'review',
    'run',
    '--preparation',
    '.browser-debug/visual-review-results/prepared/preparation.json',
    '--surface',
    'generic-api-provider',
    '--provider',
    'generic-api-provider',
    '--model',
    'generic-model',
    '--execute',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: (prefix) => prefix === 'visual-review-execution' ? 'visual-review-execution-api-missing' : 'visual-review-result-api-missing',
    env: {}
  });
  assert.equal(apiMissing.exitCode, 1);
  assert.equal(JSON.parse(apiMissing.stdout).errors[0].code, 'VISUAL_REVIEW_API_CONFIGURATION_MISSING');

  const apiCalls = [];
  const apiRun = await executeCli([
    'visual',
    'review',
    'run',
    '--preparation',
    '.browser-debug/visual-review-results/prepared/preparation.json',
    '--surface',
    'generic-api-provider',
    '--provider',
    'generic-api-provider',
    '--model',
    'generic-model',
    '--execute',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: (prefix) => prefix === 'visual-review-execution' ? 'visual-review-execution-api' : 'visual-review-result-api',
    env: {
      [API_PROVIDER_ENDPOINT_ENV]: 'https://provider.example.test/visual-review',
      [API_PROVIDER_CREDENTIAL_ENV]: 'credential-value-for-test'
    },
    fetch: async (url, init) => {
      apiCalls.push({ url, init, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          visual_review_result: {
            summary: 'API visual review advisory.',
            advisory_findings: [{
              id: 'api-visual-finding',
              category: 'visual_hierarchy',
              severity: 'low',
              message: 'API visual review advisory.',
              recommendation: 'Review the API visual advisory.'
            }],
            owner_decision_requests: []
          }
        })
      };
    }
  });
  assert.equal(apiRun.exitCode, 0);
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].body.type, 'visual_review_request');
  assert.equal(apiCalls[0].body.disclosure_policy.raw_pixels_included, false);
  assert.equal(apiCalls[0].body.disclosure_policy.raw_artifact_content_included, false);
  assert.equal(apiCalls[0].body.visual_evidence.references[0].content_included, false);
  assert.match(apiCalls[0].init.headers.authorization, /^Bearer /);
  const apiBody = JSON.parse(apiRun.stdout);
  assert.equal(apiBody.data.visual_review_execution.api_call_performed, true);
  assert.equal(apiBody.data.visual_review_execution.external_evidence_transfer, true);
  assert.equal(apiBody.data.visual_review_execution.credential_values_recorded, false);
  assert.equal(apiBody.data.visual_review_execution.raw_provider_response_stored, false);
  const apiResultText = await readFile(path.join(cwd, '.browser-debug', 'visual-review-results', 'visual-review-execution-api', 'result.json'), 'utf8');
  assert.equal(apiResultText.includes('credential-value-for-test'), false);
});

test('visual review prepare blocks indexes without visual evidence metadata', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-visual-prepare-empty-'));
  await mkdir(path.join(cwd, '.browser-debug', 'review-artifacts'), { recursive: true });
  await writeFile(path.join(cwd, '.browser-debug', 'review-artifacts', 'empty.json'), JSON.stringify({
    schema_version: '0.1.0',
    id: 'empty',
    mode: 'image_file',
    local_only: true,
    artifact_root: '.browser-debug',
    evidence_classes: [],
    artifacts: [],
    boundaries: {}
  }, null, 2), 'utf8');

  const result = await executeCli([
    'visual',
    'review',
    'prepare',
    '--review-index',
    '.browser-debug/review-artifacts/empty.json',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: () => 'visual-review-preparation-empty'
  });
  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.data.visual_review_result_preparation.status, 'blocked_missing_visual_evidence');
  assert.equal(body.data.visual_review_result_preparation.visual_evidence.readable_count, 0);
  assert.equal(body.data.visual_review_result_preparation.execution.provider_call_performed, false);
});

test('schema commands expose machine-readable contracts', async () => {
  const listed = await executeCli(['schema', 'list', '--json'], { now: fixedNow });
  assert.equal(listed.exitCode, 0);
  const listedBody = JSON.parse(listed.stdout);
  assert.equal(listedBody.command, 'schema list');
  assert.ok(listedBody.data.schemas.some((schema) => schema.name === 'review'));

  const fetched = await executeCli(['schema', 'get', '--name', 'finding', '--json'], { now: fixedNow });
  assert.equal(fetched.exitCode, 0);
  const fetchedBody = JSON.parse(fetched.stdout);
  assert.equal(fetchedBody.command, 'schema get');
  assert.equal(fetchedBody.data.schema.title, 'TraceCue Review Finding');

  const visualEvidence = await executeCli(['schema', 'get', '--name', 'visual_evidence', '--json'], { now: fixedNow });
  assert.equal(visualEvidence.exitCode, 0);
  assert.equal(JSON.parse(visualEvidence.stdout).data.schema.title, 'TraceCue Visual Evidence');

  const reviewSchemaFile = JSON.parse(await readFile(new URL('../schemas/review.schema.json', import.meta.url), 'utf8'));
  const reviewSchema = await executeCli(['schema', 'get', '--name', 'review', '--json'], { now: fixedNow });
  const reviewSchemaBody = JSON.parse(reviewSchema.stdout);
  assert.deepEqual(
    Object.keys(reviewSchemaBody.data.schema.properties).sort(),
    Object.keys(reviewSchemaFile.properties).sort()
  );

  const targetManifestSchemaFile = JSON.parse(await readFile(new URL('../schemas/target-manifest.schema.json', import.meta.url), 'utf8'));
  const targetManifestSchema = await executeCli(['schema', 'get', '--name', 'target_manifest', '--json'], { now: fixedNow });
  const targetManifestSchemaBody = JSON.parse(targetManifestSchema.stdout);
  assert.deepEqual(
    Object.keys(targetManifestSchemaBody.data.schema.properties).sort(),
    Object.keys(targetManifestSchemaFile.properties).sort()
  );

  const agentSchemaPairs = [
    ['capture_handoff', '../schemas/capture-handoff.schema.json'],
    ['capture_plan', '../schemas/capture-plan.schema.json'],
    ['identity_audit', '../schemas/identity-audit.schema.json'],
    ['desktop_review_provider_preparation_plan', '../schemas/desktop-review-provider-preparation-plan.schema.json'],
    ['image_review', '../schemas/image-review.schema.json'],
    ['mcp_execution_gates', '../schemas/mcp-execution-gates.schema.json'],
    ['visual_review_provider_policy', '../schemas/visual-review-provider-policy.schema.json'],
    ['visual_review_result_preparation', '../schemas/visual-review-result-preparation.schema.json'],
    ['visual_review_dashboard', '../schemas/visual-review-dashboard.schema.json'],
    ['visual_review_execution', '../schemas/visual-review-execution.schema.json'],
    ['visual_review_result', '../schemas/visual-review-result.schema.json'],
    ['visual_review_aggregation', '../schemas/visual-review-aggregation.schema.json'],
    ['agent_surface', '../schemas/agent-surface.schema.json'],
    ['agent_task_package', '../schemas/agent-task-package.schema.json'],
    ['agent_request_status', '../schemas/agent-request-status.schema.json'],
    ['agent_request_detail', '../schemas/agent-request-detail.schema.json'],
    ['agent_workflow', '../schemas/agent-workflow.schema.json'],
    ['agent_execution', '../schemas/agent-execution.schema.json'],
    ['agent_advisory_result', '../schemas/agent-advisory-result.schema.json'],
    ['agent_disclosure_policy', '../schemas/agent-disclosure-policy.schema.json']
  ];
  for (const [name, file] of agentSchemaPairs) {
    const schemaFile = JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
    const schema = await executeCli(['schema', 'get', '--name', name, '--json'], { now: fixedNow });
    assert.equal(schema.exitCode, 0);
    const schemaBody = JSON.parse(schema.stdout);
    assert.deepEqual(
      Object.keys(schemaBody.data.schema.properties).sort(),
      Object.keys(schemaFile.properties).sort()
    );
  }
});

test('agent package, ingest, and report stay local and advisory-only', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'browser-debug-agent-'));
  await writeFile(path.join(cwd, '.gitignore'), '.browser-debug/\n', 'utf8');
  await mkdir(path.join(cwd, '.browser-debug', 'review-artifacts'), { recursive: true });
  const reviewIndex = {
    schema_version: '0.1.0',
    id: 'review-fixed',
    mode: 'target_manifest',
    local_only: true,
    external_upload: false,
    artifact_root: '.browser-debug',
    evidence_classes: ['layout', 'screenshot'],
    artifacts: [
      { type: 'review', path: '.browser-debug/reviews/review-fixed.json', description: 'Review JSON.' },
      { type: 'screenshot', path: '.browser-debug/screenshots/review-fixed.png', description: 'Screenshot.' }
    ],
    triage: {
      status: 'needs_attention',
      local_release_gate: 'needs_fixes',
      model_review_enabled: false
    },
    coverage_summary: {
      discovered_routes: 1,
      visited_routes: 1,
      expected_routes: 1,
      skipped_routes: 0,
      failed_page_expectations: 0,
      viewports: ['desktop']
    },
    rerun: {
      command: 'trace-cue review --target @target.json --json',
      guidance: ['Rerun after fixes.']
    },
    boundaries: {
      screenshots_may_contain_page_content: true,
      traces_may_contain_page_content: false,
      profile_reuse: false,
      credential_storage: false
    }
  };
  await writeFile(
    path.join(cwd, '.browser-debug', 'review-artifacts', 'review-fixed.json'),
    `${JSON.stringify(reviewIndex, null, 2)}\n`,
    'utf8'
  );

  const listed = await executeCli(['agent', 'surfaces', 'list', '--json'], { now: fixedNow });
  assert.equal(listed.exitCode, 0);
  const listedBody = JSON.parse(listed.stdout);
  assert.equal(listedBody.command, 'agent surfaces list');
  assert.ok(listedBody.data.agent_surfaces.some((surface) => surface.kind === 'subscription_surface' && surface.implemented === true));
  assert.ok(listedBody.data.agent_surfaces.some((surface) => surface.kind === 'api_provider' && surface.status === 'approval_required'));
  assert.equal(listedBody.data.boundary.api_call_performed, false);

  const packaged = await executeCli([
    'agent',
    'package',
    '--review-index',
    '.browser-debug/review-artifacts/review-fixed.json',
    '--surface',
    'local-subscription-agent',
    '--task',
    'experience_review',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: () => 'agent-package-fixed'
  });
  assert.equal(packaged.exitCode, 0);
  const packagedBody = JSON.parse(packaged.stdout);
  assert.equal(packagedBody.command, 'agent package');
  assert.equal(packagedBody.data.agent_task_package.path, '.browser-debug/agent-packages/agent-package-fixed/packet.json');
  assert.equal(packagedBody.data.agent_disclosure_policy.raw_artifact_content_included, false);
  assert.equal(packagedBody.data.agent_disclosure_policy.screenshot_binary_included, false);
  assert.equal(packagedBody.data.agent_disclosure_policy.external_evidence_transfer, false);
  assert.equal(packagedBody.data.boundary.api_call_performed, false);
  assert.equal(packagedBody.data.boundary.existing_review_mutated, false);
  assert.equal(packagedBody.artifacts.some((artifact) => artifact.type === 'agent_prompt'), true);
  assert.equal(packagedBody.warnings.some((warning) => warning.code === 'AGENT_PACKAGE_SENSITIVE_ARTIFACT_REFERENCES'), true);
  const packet = JSON.parse(await readFile(path.join(cwd, '.browser-debug', 'agent-packages', 'agent-package-fixed', 'packet.json'), 'utf8'));
  assert.equal(packet.evidence_packet.artifacts[1].content_included, false);
  assert.equal(packet.boundary.external_evidence_transfer, false);
  const prompt = await readFile(path.join(cwd, '.browser-debug', 'agent-packages', 'agent-package-fixed', 'prompt.md'), 'utf8');
  assert.match(prompt, /Required output shape/);

  const waitingRequests = await executeCli(['agent', 'requests', 'list', '--json'], {
    cwd,
    now: fixedNow
  });
  assert.equal(waitingRequests.exitCode, 0);
  const waitingRequestsBody = JSON.parse(waitingRequests.stdout);
  assert.equal(waitingRequestsBody.command, 'agent requests list');
  assert.equal(waitingRequestsBody.data.summary.total, 1);
  assert.equal(waitingRequestsBody.data.summary.waiting_for_agent, 1);
  assert.equal(waitingRequestsBody.data.summary.api_call_performed, false);
  assert.equal(waitingRequestsBody.data.summary.automatic_upload, false);
  assert.equal(waitingRequestsBody.data.agent_requests[0].status, 'waiting_for_agent');
  assert.equal(waitingRequestsBody.data.agent_requests[0].package_path, '.browser-debug/agent-packages/agent-package-fixed/packet.json');
  assert.equal(waitingRequestsBody.data.agent_requests[0].gate_effect, 'none');
  assert.equal(waitingRequestsBody.data.agent_requests[0].existing_review_mutated, false);

  const waitingDetail = await executeCli([
    'agent',
    'requests',
    'show',
    '--package',
    '.browser-debug/agent-packages/agent-package-fixed/packet.json',
    '--json'
  ], {
    cwd,
    now: fixedNow
  });
  assert.equal(waitingDetail.exitCode, 0);
  const waitingDetailBody = JSON.parse(waitingDetail.stdout);
  assert.equal(waitingDetailBody.command, 'agent requests show');
  assert.equal(waitingDetailBody.data.agent_request_detail.status, 'waiting_for_agent');
  assert.equal(waitingDetailBody.data.agent_request_detail.selected_result_path, null);
  assert.equal(waitingDetailBody.data.agent_request_detail.package_summary.artifact_reference_count, 2);
  assert.equal(waitingDetailBody.data.agent_request_detail.package_summary.artifact_references[1].content_included, false);
  assert.equal(waitingDetailBody.data.agent_request_detail.dashboard_handoff.ingest_expected_schema, 'agent_advisory_result');
  assert.equal(waitingDetailBody.data.agent_request_detail.api_call_performed, false);
  assert.equal(waitingDetailBody.data.agent_request_detail.automatic_upload, false);
  assert.equal(waitingDetailBody.data.agent_request_detail.existing_review_mutated, false);
  assert.deepEqual(waitingDetailBody.artifacts, []);

  const workflowCreated = await executeCli([
    'agent',
    'workflow',
    'create',
    '--package',
    '.browser-debug/agent-packages/agent-package-fixed/packet.json',
    '--name',
    'Dashboard handoff',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: () => 'agent-workflow-fixed'
  });
  assert.equal(workflowCreated.exitCode, 0);
  const workflowCreatedBody = JSON.parse(workflowCreated.stdout);
  assert.equal(workflowCreatedBody.command, 'agent workflow create');
  assert.equal(workflowCreatedBody.data.agent_workflow.status, 'waiting_for_agent');
  assert.equal(workflowCreatedBody.data.agent_workflow.workflow_path, '.browser-debug/agent-workflows/agent-workflow-fixed/workflow.json');
  assert.equal(workflowCreatedBody.data.agent_workflow.steps.agent_review.status, 'waiting');
  assert.equal(workflowCreatedBody.data.agent_workflow.provider_boundary.direct_provider_execution, false);
  assert.equal(workflowCreatedBody.data.agent_workflow.provider_boundary.provider_api_call_performed, false);
  assert.equal(workflowCreatedBody.data.agent_workflow.api_call_performed, false);
  assert.equal(workflowCreatedBody.data.agent_workflow.automatic_upload, false);
  assert.equal(workflowCreatedBody.data.agent_workflow.existing_review_mutated, false);
  assert.equal(workflowCreatedBody.artifacts.some((artifact) => artifact.type === 'agent_workflow'), true);
  const workflowFile = JSON.parse(await readFile(path.join(cwd, '.browser-debug', 'agent-workflows', 'agent-workflow-fixed', 'workflow.json'), 'utf8'));
  assert.equal(workflowFile.dashboard_handoff.status_command, 'trace-cue agent workflow status --workflow .browser-debug/agent-workflows/agent-workflow-fixed/workflow.json --json');

  const advisoryInput = JSON.stringify({
    agent_advisory_findings: [{
      id: 'visual-density',
      category: 'visual_design',
      severity: 'medium',
      confidence: { evidence: 'high', judgment: 'medium', implementation: 'low' },
      message: 'Primary controls compete with secondary metadata.',
      recommendation: 'Reduce secondary metadata weight before changing the primary action.',
      selector: '#primary-panel',
      evidence_refs: ['.browser-debug/screenshots/review-fixed.png'],
      owner_decision_required: true
    }],
    owner_decision_requests: [{
      id: 'brand-fit',
      question: 'Is the denser layout acceptable for the target audience?',
      reason: 'This is a subjective product judgment.'
    }]
  });
  const absoluteInput = await executeCli([
    'agent',
    'ingest',
    '--package',
    '.browser-debug/agent-packages/agent-package-fixed/packet.json',
    '--input',
    `@${path.join(cwd, 'agent-advisory-result.json')}`,
    '--json'
  ], {
    cwd,
    now: fixedNow
  });
  assert.equal(absoluteInput.exitCode, 1);
  const absoluteInputBody = JSON.parse(absoluteInput.stdout);
  assert.equal(absoluteInputBody.errors[0].code, 'AGENT_INPUT_PATH_OUTSIDE_WORKSPACE');

  const ingested = await executeCli([
    'agent',
    'ingest',
    '--package',
    '.browser-debug/agent-packages/agent-package-fixed/packet.json',
    '--input',
    '-',
    '--surface',
    'local-subscription-agent',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    stdinText: advisoryInput,
    createId: () => 'agent-result-fixed'
  });
  assert.equal(ingested.exitCode, 0);
  const ingestedBody = JSON.parse(ingested.stdout);
  assert.equal(ingestedBody.command, 'agent ingest');
  assert.equal(ingestedBody.data.agent_advisory.gate_effect, 'none');
  assert.equal(ingestedBody.data.agent_advisory.untrusted_model_output, true);
  assert.equal(ingestedBody.data.agent_advisory_findings.length, 1);
  assert.equal(ingestedBody.data.agent_advisory_findings[0].source, 'agent_advisory');
  assert.equal(ingestedBody.data.agent_advisory_findings[0].gate_effect, 'none');
  assert.equal(ingestedBody.data.agent_advisory_action_plan.legacy_action_plan_unchanged, true);
  assert.equal(ingestedBody.data.agent_advisory_readiness.legacy_release_readiness_unchanged, true);
  assert.equal(ingestedBody.data.boundary.existing_review_mutated, false);
  assert.equal(ingestedBody.artifacts.some((artifact) => artifact.type === 'agent_import_receipt'), true);
  const receipt = JSON.parse(await readFile(path.join(cwd, '.browser-debug', 'receipts', 'agent-result-fixed.json'), 'utf8'));
  assert.equal(receipt.raw_response_stored, false);
  assert.equal(receipt.api_call_performed, false);

  const importedRequests = await executeCli([
    'agent',
    'requests',
    'list',
    '--package',
    '.browser-debug/agent-packages/agent-package-fixed/packet.json',
    '--json'
  ], {
    cwd,
    now: fixedNow
  });
  assert.equal(importedRequests.exitCode, 0);
  const importedRequestsBody = JSON.parse(importedRequests.stdout);
  assert.equal(importedRequestsBody.data.summary.total, 1);
  assert.equal(importedRequestsBody.data.summary.advisory_imported, 1);
  assert.equal(importedRequestsBody.data.agent_requests[0].status, 'advisory_imported');
  assert.equal(importedRequestsBody.data.agent_requests[0].latest_result_path, '.browser-debug/agent-results/agent-result-fixed.json');
  assert.equal(importedRequestsBody.data.agent_requests[0].advisory_findings, 1);
  assert.equal(importedRequestsBody.data.agent_requests[0].api_call_performed, false);

  const importedDetail = await executeCli([
    'agent',
    'requests',
    'show',
    '--package',
    '.browser-debug/agent-packages/agent-package-fixed/packet.json',
    '--agent-result',
    '.browser-debug/agent-results/agent-result-fixed.json',
    '--json'
  ], {
    cwd,
    now: fixedNow
  });
  assert.equal(importedDetail.exitCode, 0);
  const importedDetailBody = JSON.parse(importedDetail.stdout);
  assert.equal(importedDetailBody.data.agent_request_detail.status, 'advisory_imported');
  assert.equal(importedDetailBody.data.agent_request_detail.selected_result_path, '.browser-debug/agent-results/agent-result-fixed.json');
  assert.equal(importedDetailBody.data.agent_request_detail.agent_advisory_summary.advisory_findings, 1);
  assert.equal(importedDetailBody.data.agent_request_detail.agent_advisory_summary.owner_decision_requests, 1);
  assert.equal(importedDetailBody.data.agent_request_detail.agent_advisory_summary.action_items, 1);
  assert.equal(importedDetailBody.data.agent_request_detail.agent_advisory_summary.gate_effect, 'none');
  assert.equal(importedDetailBody.data.agent_request_detail.dashboard_handoff.report_command.includes('agent report'), true);
  assert.equal(importedDetailBody.data.agent_request_detail.api_call_performed, false);
  assert.equal(importedDetailBody.data.agent_request_detail.automatic_upload, false);
  assert.equal(importedDetailBody.data.agent_request_detail.existing_review_mutated, false);

  const workflowStatus = await executeCli([
    'agent',
    'workflow',
    'status',
    '--workflow',
    '.browser-debug/agent-workflows/agent-workflow-fixed/workflow.json',
    '--json'
  ], {
    cwd,
    now: fixedNow
  });
  assert.equal(workflowStatus.exitCode, 0);
  const workflowStatusBody = JSON.parse(workflowStatus.stdout);
  assert.equal(workflowStatusBody.command, 'agent workflow status');
  assert.equal(workflowStatusBody.data.agent_workflow_status.status, 'advisory_imported');
  assert.equal(workflowStatusBody.data.agent_workflow_status.latest_result_path, '.browser-debug/agent-results/agent-result-fixed.json');
  assert.equal(workflowStatusBody.data.agent_workflow_status.steps.ingest.status, 'completed');
  assert.equal(workflowStatusBody.data.agent_workflow_status.steps.report.status, 'pending');
  assert.equal(workflowStatusBody.data.agent_workflow_status.request_detail.agent_advisory_summary.advisory_findings, 1);
  assert.equal(workflowStatusBody.data.agent_workflow_status.provider_boundary.direct_provider_execution, false);
  assert.equal(workflowStatusBody.data.agent_workflow_status.provider_boundary.provider_api_call_performed, false);
  assert.equal(workflowStatusBody.data.agent_workflow_status.api_call_performed, false);
  assert.equal(workflowStatusBody.data.agent_workflow_status.existing_review_mutated, false);
  assert.deepEqual(workflowStatusBody.artifacts, []);

  const workflowIndex = await executeCli([
    'agent',
    'workflow',
    'index',
    '--json'
  ], {
    cwd,
    now: fixedNow
  });
  assert.equal(workflowIndex.exitCode, 0);
  const workflowIndexBody = JSON.parse(workflowIndex.stdout);
  assert.equal(workflowIndexBody.command, 'agent workflow index');
  assert.equal(workflowIndexBody.data.summary.total, 1);
  assert.equal(workflowIndexBody.data.summary.advisory_imported, 1);
  assert.equal(workflowIndexBody.data.summary.report_pending, 1);
  assert.equal(workflowIndexBody.data.summary.api_call_performed, false);
  assert.equal(workflowIndexBody.data.summary.automatic_upload, false);
  assert.equal(workflowIndexBody.data.summary.existing_review_mutated, false);

  const workflowReport = await executeCli([
    'agent',
    'workflow',
    'report',
    '--workflow',
    '.browser-debug/agent-workflows/agent-workflow-fixed/workflow.json',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: () => 'agent-workflow-report-fixed'
  });
  assert.equal(workflowReport.exitCode, 0);
  const workflowReportBody = JSON.parse(workflowReport.stdout);
  assert.equal(workflowReportBody.command, 'agent workflow report');
  assert.equal(workflowReportBody.data.agent_workflow_report.path, '.browser-debug/reports/agent-workflow-report-fixed.md');
  assert.equal(workflowReportBody.data.agent_workflow_report.status, 'advisory_imported');
  assert.equal(workflowReportBody.data.agent_workflow_report.existing_review_mutated, false);
  assert.equal(workflowReportBody.data.provider_boundary.provider_api_call_performed, false);
  assert.equal(workflowReportBody.artifacts.some((artifact) => artifact.type === 'agent_workflow_report'), true);
  const workflowReportText = await readFile(path.join(cwd, '.browser-debug', 'reports', 'agent-workflow-report-fixed.md'), 'utf8');
  assert.match(workflowReportText, /Agent Workflow Report/);
  assert.match(workflowReportText, /Existing deterministic review findings/);

  const executionPlan = await executeCli([
    'agent',
    'execution',
    'plan',
    '--package',
    '.browser-debug/agent-packages/agent-package-fixed/packet.json',
    '--surface',
    'local-subscription-agent',
    '--provider',
    'fake-agent',
    '--model',
    'fake-model',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: () => 'agent-execution-fixed'
  });
  assert.equal(executionPlan.exitCode, 0);
  const executionPlanBody = JSON.parse(executionPlan.stdout);
  assert.equal(executionPlanBody.command, 'agent execution plan');
  assert.equal(executionPlanBody.data.agent_execution.status, 'planned');
  assert.equal(executionPlanBody.data.agent_execution.execution_path, '.browser-debug/agent-executions/agent-execution-fixed/execution.json');
  assert.equal(executionPlanBody.data.agent_execution.steps.plan.no_network, true);
  assert.equal(executionPlanBody.data.agent_execution.steps.execution.provider_adapter_required, false);
  assert.equal(executionPlanBody.data.agent_execution.provider.id, 'fake-agent');
  assert.equal(executionPlanBody.data.agent_execution.model.id, 'fake-model');
  assert.equal(executionPlanBody.data.agent_execution.provider_adapter.implemented, true);
  assert.equal(executionPlanBody.data.agent_execution.api_call_performed, false);
  assert.equal(executionPlanBody.data.agent_execution.external_evidence_transfer, false);
  assert.equal(executionPlanBody.data.agent_execution.credential_values_recorded, false);
  assert.equal(executionPlanBody.data.agent_execution.raw_provider_response_stored, false);
  assert.equal(executionPlanBody.data.agent_execution.mcp_execution_exposed, false);
  assert.equal(executionPlanBody.data.agent_execution.raw_pixels_included, false);
  assert.equal(executionPlanBody.data.agent_execution.visual_review_provider_execution_authorized, false);
  const visualReviewPolicy = executionPlanBody.data.agent_execution.visual_review_provider_policy;
  assert.equal(visualReviewPolicy.status, 'planned');
  assert.equal(visualReviewPolicy.disclosure.raw_pixels_included, false);
  assert.equal(visualReviewPolicy.disclosure.provider_execution_authorized, false);
  assert.equal(visualReviewPolicy.disclosure.external_evidence_transfer_authorized, false);
  assert.equal(visualReviewPolicy.execution.provider_call_performed, false);
  assert.equal(visualReviewPolicy.execution.mcp_execution_exposed, false);
  assert.equal(executionPlanBody.artifacts.some((artifact) => artifact.type === 'agent_execution'), true);
  const executionFile = JSON.parse(await readFile(path.join(cwd, '.browser-debug', 'agent-executions', 'agent-execution-fixed', 'execution.json'), 'utf8'));
  assert.equal(executionFile.visual_review_provider_policy.boundary.raw_pixels_included, false);
  assert.equal(executionFile.visual_review_provider_policy.boundary.provider_execution_authorized, false);
  assert.equal(executionFile.dashboard_handoff.status_command, 'trace-cue agent execution status --execution .browser-debug/agent-executions/agent-execution-fixed/execution.json --json');
  assert.equal(executionFile.dashboard_handoff.run_command, 'trace-cue agent execution run --execution .browser-debug/agent-executions/agent-execution-fixed/execution.json --package .browser-debug/agent-packages/agent-package-fixed/packet.json --surface local-subscription-agent --provider fake-agent --model fake-model --execute --json');

  const executionStatus = await executeCli([
    'agent',
    'execution',
    'status',
    '--execution',
    '.browser-debug/agent-executions/agent-execution-fixed/execution.json',
    '--json'
  ], {
    cwd,
    now: fixedNow
  });
  assert.equal(executionStatus.exitCode, 0);
  const executionStatusBody = JSON.parse(executionStatus.stdout);
  assert.equal(executionStatusBody.command, 'agent execution status');
  assert.equal(executionStatusBody.data.agent_execution_status.status, 'planned');
  assert.equal(executionStatusBody.data.agent_execution_status.existing_review_mutated, false);

  const executionIndex = await executeCli([
    'agent',
    'execution',
    'list',
    '--json'
  ], {
    cwd,
    now: fixedNow
  });
  assert.equal(executionIndex.exitCode, 0);
  const executionIndexBody = JSON.parse(executionIndex.stdout);
  assert.equal(executionIndexBody.command, 'agent execution list');
  assert.equal(executionIndexBody.data.summary.total, 1);
  assert.equal(executionIndexBody.data.summary.planned, 1);
  assert.equal(executionIndexBody.data.summary.api_call_performed, false);
  assert.equal(executionIndexBody.data.summary.mcp_execution_exposed, false);

  const mcpSurfaces = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 30,
    method: 'tools/call',
    params: {
      name: 'browser_debug_agent_surfaces_list',
      arguments: {}
    }
  }, { cwd, mcpProfile: 'safe', now: fixedNow });
  assert.equal(mcpSurfaces.result.structuredContent.command, 'agent surfaces list');
  assert.equal(mcpSurfaces.result.structuredContent.data.boundary.api_call_performed, false);

  const mcpRequestsList = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 31,
    method: 'tools/call',
    params: {
      name: 'browser_debug_agent_requests_list',
      arguments: { package: '.browser-debug/agent-packages/agent-package-fixed/packet.json' }
    }
  }, { cwd, mcpProfile: 'safe', now: fixedNow });
  assert.equal(mcpRequestsList.result.structuredContent.command, 'agent requests list');
  assert.equal(mcpRequestsList.result.structuredContent.data.summary.total, 1);

  const mcpRequestShow = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 32,
    method: 'tools/call',
    params: {
      name: 'browser_debug_agent_requests_show',
      arguments: {
        package: '.browser-debug/agent-packages/agent-package-fixed/packet.json',
        agentResult: '.browser-debug/agent-results/agent-result-fixed.json'
      }
    }
  }, { cwd, mcpProfile: 'safe', now: fixedNow });
  assert.equal(mcpRequestShow.result.structuredContent.command, 'agent requests show');
  assert.equal(mcpRequestShow.result.structuredContent.data.agent_request_detail.status, 'advisory_imported');
  assert.deepEqual(mcpRequestShow.result.structuredContent.artifacts, []);

  const mcpWorkflowStatus = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 33,
    method: 'tools/call',
    params: {
      name: 'browser_debug_agent_workflow_status',
      arguments: { workflow: '.browser-debug/agent-workflows/agent-workflow-fixed/workflow.json' }
    }
  }, { cwd, mcpProfile: 'safe', now: fixedNow });
  assert.equal(mcpWorkflowStatus.result.structuredContent.command, 'agent workflow status');
  assert.equal(mcpWorkflowStatus.result.structuredContent.data.agent_workflow_status.status, 'advisory_imported');

  const mcpWorkflowIndex = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 34,
    method: 'tools/call',
    params: {
      name: 'browser_debug_agent_workflow_index',
      arguments: {}
    }
  }, { cwd, mcpProfile: 'safe', now: fixedNow });
  assert.equal(mcpWorkflowIndex.result.structuredContent.command, 'agent workflow index');
  assert.equal(mcpWorkflowIndex.result.structuredContent.data.summary.report_pending, 1);

  const mcpExecutionStatus = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 35,
    method: 'tools/call',
    params: {
      name: 'browser_debug_agent_execution_status',
      arguments: { execution: '.browser-debug/agent-executions/agent-execution-fixed/execution.json' }
    }
  }, { cwd, mcpProfile: 'safe', now: fixedNow });
  assert.equal(mcpExecutionStatus.result.structuredContent.command, 'agent execution status');
  assert.equal(mcpExecutionStatus.result.structuredContent.data.agent_execution_status.status, 'planned');

  const mcpExecutionList = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 36,
    method: 'tools/call',
    params: {
      name: 'browser_debug_agent_execution_list',
      arguments: {}
    }
  }, { cwd, mcpProfile: 'safe', now: fixedNow });
  assert.equal(mcpExecutionList.result.structuredContent.command, 'agent execution list');
  assert.equal(mcpExecutionList.result.structuredContent.data.summary.planned, 1);

  const executionRunWithoutFlag = await executeCli([
    'agent',
    'execution',
    'run',
    '--execution',
    '.browser-debug/agent-executions/agent-execution-fixed/execution.json',
    '--package',
    '.browser-debug/agent-packages/agent-package-fixed/packet.json',
    '--surface',
    'local-subscription-agent',
    '--provider',
    'fake-agent',
    '--model',
    'fake-model',
    '--json'
  ], {
    cwd,
    now: fixedNow
  });
  assert.equal(executionRunWithoutFlag.exitCode, 2);
  const executionRunWithoutFlagBody = JSON.parse(executionRunWithoutFlag.stdout);
  assert.equal(executionRunWithoutFlagBody.errors[0].code, 'MISSING_REQUIRED_OPTION');
  assert.equal(executionRunWithoutFlagBody.errors[0].details.option, 'execute');

  const executionRunWithoutPlan = await executeCli([
    'agent',
    'execution',
    'run',
    '--package',
    '.browser-debug/agent-packages/agent-package-fixed/packet.json',
    '--surface',
    'local-subscription-agent',
    '--provider',
    'fake-agent',
    '--model',
    'fake-model',
    '--execute',
    '--json'
  ], {
    cwd,
    now: fixedNow
  });
  assert.equal(executionRunWithoutPlan.exitCode, 2);
  const executionRunWithoutPlanBody = JSON.parse(executionRunWithoutPlan.stdout);
  assert.equal(executionRunWithoutPlanBody.errors[0].code, 'MISSING_REQUIRED_OPTION');
  assert.equal(executionRunWithoutPlanBody.errors[0].details.option, 'execution');

  const executionRun = await executeCli([
    'agent',
    'execution',
    'run',
    '--execution',
    '.browser-debug/agent-executions/agent-execution-fixed/execution.json',
    '--package',
    '.browser-debug/agent-packages/agent-package-fixed/packet.json',
    '--surface',
    'local-subscription-agent',
    '--provider',
    'fake-agent',
    '--model',
    'fake-model',
    '--execute',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: (prefix) => prefix === 'agent-result' ? 'agent-result-from-fake' : 'unexpected-id'
  });
  assert.equal(executionRun.exitCode, 0);
  const executionRunBody = JSON.parse(executionRun.stdout);
  assert.equal(executionRunBody.command, 'agent execution run');
  assert.equal(executionRunBody.data.agent_execution.status, 'completed');
  assert.equal(executionRunBody.data.agent_execution.normalized_agent_result_path, '.browser-debug/agent-results/agent-result-from-fake.json');
  assert.equal(executionRunBody.data.agent_execution.api_call_performed, false);
  assert.equal(executionRunBody.data.agent_execution.external_evidence_transfer, false);
  assert.equal(executionRunBody.data.agent_execution.credential_values_recorded, false);
  assert.equal(executionRunBody.data.agent_execution.raw_provider_response_stored, false);
  assert.equal(executionRunBody.data.agent_execution.mcp_execution_exposed, false);
  assert.equal(Object.hasOwn(executionRunBody.data.agent_execution, 'visual_review_provider_policy'), false);
  assert.equal(executionRunBody.artifacts.some((artifact) => artifact.type === 'agent_advisory_result'), true);
  const fakeResult = JSON.parse(await readFile(path.join(cwd, '.browser-debug', 'agent-results', 'agent-result-from-fake.json'), 'utf8'));
  assert.equal(fakeResult.agent_advisory.source, 'agent_execution');
  assert.equal(fakeResult.agent_advisory.api_call_performed_by_cli, false);
  assert.equal(fakeResult.boundary.raw_provider_response_stored, false);

  const completedExecutionStatus = await executeCli([
    'agent',
    'execution',
    'status',
    '--execution',
    '.browser-debug/agent-executions/agent-execution-fixed/execution.json',
    '--json'
  ], {
    cwd,
    now: fixedNow
  });
  assert.equal(completedExecutionStatus.exitCode, 0);
  const completedExecutionStatusBody = JSON.parse(completedExecutionStatus.stdout);
  assert.equal(completedExecutionStatusBody.data.agent_execution_status.status, 'completed');
  assert.equal(completedExecutionStatusBody.data.agent_execution_status.dashboard_status.report_pending, true);

  const localExecutionPlan = await executeCli([
    'agent',
    'execution',
    'plan',
    '--package',
    '.browser-debug/agent-packages/agent-package-fixed/packet.json',
    '--surface',
    'local-subscription-agent',
    '--provider',
    'local-runner',
    '--model',
    'local-agent',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: () => 'agent-execution-local'
  });
  assert.equal(localExecutionPlan.exitCode, 0);

  const localExecutionRun = await executeCli([
    'agent',
    'execution',
    'run',
    '--execution',
    '.browser-debug/agent-executions/agent-execution-local/execution.json',
    '--package',
    '.browser-debug/agent-packages/agent-package-fixed/packet.json',
    '--surface',
    'local-subscription-agent',
    '--provider',
    'local-runner',
    '--model',
    'local-agent',
    '--execute',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: (prefix) => prefix === 'agent-result' ? 'agent-result-from-local-runner' : 'unexpected-id',
    agentExecutionLocalRunner: async ({ package_path: packagePath }) => ({
      agent_advisory_findings: [{
        id: 'local-runner-finding',
        category: 'implementation_diagnosis',
        severity: 'medium',
        message: `Local runner reviewed ${packagePath}.`,
        recommendation: 'Review the local runner advisory item.'
      }],
      agent_advisory_action_plan: { next_actions: [] },
      owner_decision_requests: []
    })
  });
  assert.equal(localExecutionRun.exitCode, 0);
  const localExecutionRunBody = JSON.parse(localExecutionRun.stdout);
  assert.equal(localExecutionRunBody.data.agent_execution.status, 'completed');
  assert.equal(localExecutionRunBody.data.agent_execution.boundary.shell_used, false);
  assert.equal(localExecutionRunBody.data.agent_execution.boundary.free_form_shell_input_accepted, false);
  const localRunnerResult = JSON.parse(await readFile(path.join(cwd, '.browser-debug', 'agent-results', 'agent-result-from-local-runner.json'), 'utf8'));
  assert.equal(localRunnerResult.agent_advisory_findings.length, 1);
  assert.equal(localRunnerResult.agent_advisory_findings[0].source, 'agent_advisory');

  const apiPackage = await executeCli([
    'agent',
    'package',
    '--review-index',
    '.browser-debug/review-artifacts/review-fixed.json',
    '--surface',
    'generic-api-provider',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: () => 'agent-package-api'
  });
  assert.equal(apiPackage.exitCode, 0);

  const apiExecutionPlan = await executeCli([
    'agent',
    'execution',
    'plan',
    '--package',
    '.browser-debug/agent-packages/agent-package-api/packet.json',
    '--surface',
    'generic-api-provider',
    '--provider',
    'generic-api-provider',
    '--model',
    'generic-model',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: () => 'agent-execution-api-missing-config'
  });
  assert.equal(apiExecutionPlan.exitCode, 0);

  const apiExecutionMissingConfig = await executeCli([
    'agent',
    'execution',
    'run',
    '--execution',
    '.browser-debug/agent-executions/agent-execution-api-missing-config/execution.json',
    '--package',
    '.browser-debug/agent-packages/agent-package-api/packet.json',
    '--surface',
    'generic-api-provider',
    '--provider',
    'generic-api-provider',
    '--model',
    'generic-model',
    '--execute',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    env: {}
  });
  assert.equal(apiExecutionMissingConfig.exitCode, 1);
  const apiExecutionMissingConfigBody = JSON.parse(apiExecutionMissingConfig.stdout);
  assert.equal(apiExecutionMissingConfigBody.errors[0].code, 'AGENT_EXECUTION_API_CONFIGURATION_MISSING');
  assert.equal(apiExecutionMissingConfigBody.data.agent_execution.api_call_performed, false);
  assert.equal(apiExecutionMissingConfigBody.data.agent_execution.credential_values_recorded, false);

  const apiExecutionPlanSuccess = await executeCli([
    'agent',
    'execution',
    'plan',
    '--package',
    '.browser-debug/agent-packages/agent-package-api/packet.json',
    '--surface',
    'generic-api-provider',
    '--provider',
    'generic-api-provider',
    '--model',
    'generic-model',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: () => 'agent-execution-api'
  });
  assert.equal(apiExecutionPlanSuccess.exitCode, 0);

  const apiCalls = [];
  const apiExecutionRun = await executeCli([
    'agent',
    'execution',
    'run',
    '--execution',
    '.browser-debug/agent-executions/agent-execution-api/execution.json',
    '--package',
    '.browser-debug/agent-packages/agent-package-api/packet.json',
    '--surface',
    'generic-api-provider',
    '--provider',
    'generic-api-provider',
    '--model',
    'generic-model',
    '--execute',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: (prefix) => prefix === 'agent-result' ? 'agent-result-from-api' : 'unexpected-id',
    env: {
      [API_PROVIDER_ENDPOINT_ENV]: 'https://provider.example.test/agent-advisory',
      [API_PROVIDER_CREDENTIAL_ENV]: 'credential-value-for-test'
    },
    fetch: async (url, init) => {
      apiCalls.push({ url, init, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          agent_advisory_findings: [{
            id: 'api-finding',
            category: 'visual_design',
            severity: 'low',
            message: 'API provider advisory.',
            recommendation: 'Review the API advisory item.'
          }],
          agent_advisory_action_plan: { next_actions: [] },
          owner_decision_requests: []
        })
      };
    }
  });
  assert.equal(apiExecutionRun.exitCode, 0);
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].url, 'https://provider.example.test/agent-advisory');
  assert.equal(apiCalls[0].body.disclosure_policy.raw_artifact_content_included, false);
  assert.equal(apiCalls[0].body.disclosure_policy.prompt_content_included, true);
  assert.match(apiCalls[0].init.headers.authorization, /^Bearer /);
  const apiExecutionRunBody = JSON.parse(apiExecutionRun.stdout);
  assert.equal(apiExecutionRunBody.data.agent_execution.api_call_performed, true);
  assert.equal(apiExecutionRunBody.data.agent_execution.external_evidence_transfer, true);
  assert.equal(apiExecutionRunBody.data.agent_execution.credential_values_recorded, false);
  assert.equal(apiExecutionRunBody.data.agent_execution.raw_provider_response_stored, false);
  const apiResultText = await readFile(path.join(cwd, '.browser-debug', 'agent-results', 'agent-result-from-api.json'), 'utf8');
  assert.doesNotMatch(apiResultText, /credential-value-for-test/);
  const apiResult = JSON.parse(apiResultText);
  assert.equal(apiResult.agent_advisory.api_call_performed_by_cli, true);
  assert.equal(apiResult.agent_advisory_findings.length, 1);

  const completedExecutionIndex = await executeCli([
    'agent',
    'execution',
    'list',
    '--json'
  ], {
    cwd,
    now: fixedNow
  });
  assert.equal(completedExecutionIndex.exitCode, 0);
  const completedExecutionIndexBody = JSON.parse(completedExecutionIndex.stdout);
  assert.equal(completedExecutionIndexBody.data.summary.completed, 3);
  assert.equal(completedExecutionIndexBody.data.summary.blocked, 1);
  assert.equal(completedExecutionIndexBody.data.summary.advisory_results, 3);
  assert.equal(completedExecutionIndexBody.data.summary.credential_values_recorded, false);
  assert.equal(completedExecutionIndexBody.data.summary.raw_provider_response_stored, false);

  await writeFile(
    path.join(cwd, '.browser-debug', 'agent-results', 'agent-result-other.json'),
    `${JSON.stringify({ package_id: 'other-package', package_path: '.browser-debug/agent-packages/other/packet.json' })}\n`,
    'utf8'
  );
  const mismatchedDetail = await executeCli([
    'agent',
    'requests',
    'show',
    '--package',
    '.browser-debug/agent-packages/agent-package-fixed/packet.json',
    '--agent-result',
    '.browser-debug/agent-results/agent-result-other.json',
    '--json'
  ], {
    cwd,
    now: fixedNow
  });
  assert.equal(mismatchedDetail.exitCode, 1);
  const mismatchedDetailBody = JSON.parse(mismatchedDetail.stdout);
  assert.equal(mismatchedDetailBody.errors[0].code, 'AGENT_RESULT_PACKAGE_MISMATCH');

  const reported = await executeCli([
    'agent',
    'report',
    '--review-index',
    '.browser-debug/review-artifacts/review-fixed.json',
    '--agent-result',
    '.browser-debug/agent-results/agent-result-fixed.json',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: () => 'agent-report-fixed'
  });
  assert.equal(reported.exitCode, 0);
  const reportedBody = JSON.parse(reported.stdout);
  assert.equal(reportedBody.command, 'agent report');
  assert.equal(reportedBody.data.agent_report.existing_review_mutated, false);
  const report = await readFile(path.join(cwd, '.browser-debug', 'reports', 'agent-report-fixed.md'), 'utf8');
  assert.match(report, /Agent Advisory Report/);
  assert.match(report, /Existing deterministic review findings/);
});

test('target manifests and action candidates use generic review abstractions', () => {
  const template = createTargetManifest({
    url: 'https://example.test/app',
    name: 'Example App',
    'max-routes': '12'
  });
  assert.equal(template.name, 'Example App');
  assert.equal(template.budgets.maxRoutes, 12);
  assert.deepEqual(template.viewportMatrix, ['desktop', 'mobile']);

  const normalized = normalizeTargetManifest({
    baseUrl: 'https://example.test/app',
    seeds: ['/app#overview'],
    pages: [{
      name: 'Overview',
      path: '/app#overview',
      role: 'status_overview',
      priority: 'P1',
      viewports: ['mobile', { name: 'tablet', width: 768, height: 1024 }],
      expectations: {
        text: ['Overview'],
        selectors: ['#primary'],
        dataBindings: [{
          id: 'service-status',
          sourceId: 'service',
          pointer: '/service/status',
          selector: '#service-state',
          target: 'data-state'
        }],
        userQuestions: [{
          id: 'attention-state',
          question: 'Can the user tell whether the service needs attention?',
          expectedEvidence: ['ready'],
          selector: '#risk'
        }]
      },
      mock: 'mocks/overview.png'
    }],
    sourceData: [{
      id: 'service',
      data: { service: { status: 'ready' } }
    }],
    localContentUxAdvisory: {
      enabled: true,
      audience: ['non-engineer', 'early-career engineer'],
      goal: 'Help users understand the current service status.',
      requiredUserQuestions: [{
        id: 'status-state',
        pageId: 'overview',
        question: 'Can the user identify the current service status?',
        expectedEvidence: ['ready']
      }],
      reviewBrief: {
        summary: 'The overview page should explain current service status and next decisions.',
        userRoles: ['operator'],
        decisionNeeds: [{
          id: 'intervention-decision',
          pageId: 'overview',
          question: 'Can the user decide whether intervention is needed?',
          expectedEvidence: ['ready']
        }]
      },
      rubric: [{
        id: 'status-state-criterion',
        category: 'status_clarity',
        pageId: 'overview',
        criterion: 'The page communicates status clearly.',
        expectedEvidence: ['ready']
      }]
    },
    viewportMatrix: ['desktop', { name: 'phone', width: 390, height: 844 }],
    budgets: { maxRoutes: 5 }
  });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.target.seeds[0], 'https://example.test/app#overview');
  assert.equal(normalized.target.viewportMatrix[0].name, 'desktop');
  assert.equal(normalized.target.viewportMatrix[1].name, 'phone');
  assert.equal(normalized.target.viewportMatrix.some((viewport) => viewport.name === 'mobile'), true);
  assert.equal(normalized.target.viewportMatrix.some((viewport) => viewport.name === 'tablet'), true);
  assert.equal(normalized.target.budgets.maxRoutes, 5);
  assert.equal(normalized.target.pages[0].id, 'overview');
  assert.equal(normalized.target.pages[0].role, 'status_overview');
  assert.equal(normalized.target.pages[0].priority, 'high');
  assert.equal(normalized.target.pages[0].expectations.text[0].value, 'Overview');
  assert.equal(normalized.target.pages[0].expectations.selectors[0].value, '#primary');
  assert.equal(normalized.target.pages[0].expectations.dataBindings[0].sourceId, 'service');
  assert.equal(normalized.target.pages[0].expectations.dataBindings[0].target, 'data-state');
  assert.equal(normalized.target.pages[0].expectations.userQuestions[0].id, 'attention-state');
  assert.equal(normalized.target.localContentUxAdvisory.enabled, true);
  assert.equal(normalized.target.localContentUxAdvisory.requiredUserQuestions[0].id, 'status-state');
  assert.equal(normalized.target.localContentUxAdvisory.reviewBrief.decisionNeeds[0].id, 'intervention-decision');
  assert.equal(normalized.target.localContentUxAdvisory.rubric[0].category, 'status_clarity');
  assert.equal(normalized.target.localContentUxAdvisory.sourceData[0].available, true);

  assert.equal(classifyActionCandidate({ tag: 'a', href: 'https://example.test/app#next' }, 'https://example.test/app'), 'navigation');
  assert.equal(classifyActionCandidate({ tag: 'input' }, 'https://example.test/app'), 'input_required');
  assert.equal(classifyActionCandidate({ tag: 'button', text: 'Delete project' }, 'https://example.test/app'), 'destructive');
  assert.equal(classifyActionCandidate({ tag: 'button', text: 'Open settings' }, 'https://example.test/app'), 'state_revealing');
});

test('local content UX advisory is manifest opt-in and does not expose source values', () => {
  const normalized = normalizeTargetManifest({
    baseUrl: 'https://example.test/app',
    pages: [{
      name: 'Overview',
      path: '/app',
      role: 'status_overview',
      expectations: {
        dataBindings: [{
          id: 'run-summary',
          sourceId: 'service',
          pointer: '/status/summary',
          target: 'text',
          severity: 'medium'
        }]
      }
    }],
    sourceData: [{
      id: 'service',
      data: { status: { summary: 'Current local run is healthy' } }
    }],
    localContentUxAdvisory: {
      enabled: true,
      audience: ['operators'],
      goal: 'Expose service status in a way users can understand.',
      reviewBrief: {
        summary: 'The overview page should let operators decide whether intervention is needed.',
        userRoles: ['operator'],
        decisionNeeds: [{
          id: 'operator-decision',
          pageId: 'overview',
          question: 'Can operators decide whether intervention is needed?',
          expectedEvidence: ['healthy']
        }]
      },
      rubric: [{
        id: 'state-summary-rubric',
        category: 'status_clarity',
        pageId: 'overview',
        criterion: 'The page communicates service health clearly.',
        expectedEvidence: ['healthy'],
        severity: 'medium'
      }]
    }
  });
  assert.equal(normalized.ok, true);
  const target = normalized.target;
  const matched = buildLocalContentUxAdvisory({
    target,
    routeReviews: [{
      route: { url: target.pages[0].url },
      viewport: { name: 'desktop' },
      evidenceSummary: {
        visible_text: 'Dashboard overview. Current local run is healthy.',
        visible_text_length: 53
      }
    }]
  });
  assert.equal(matched.status, 'passed');
  assert.equal(matched.counts.data_binding_matches, 1);
  assert.deepEqual(matched.findings, []);
  assert.equal(matched.action_plan.status, 'passed');
  assert.equal(matched.action_plan.gate_effect, 'none');
  assert.equal(matched.readiness.status, 'passed');
  assert.equal(matched.readiness.legacy_release_readiness_unchanged, true);
  assert.equal(matched.page_handoff.summary.pages, 1);
  assert.equal(matched.page_handoff.summary.pages_with_findings, 0);
  assert.equal(matched.manifest_authoring.status, 'advisory_notes');
  assert.equal(matched.review_brief.status, 'passed');
  assert.equal(matched.review_brief.summary.decision_needs_met, 1);
  assert.equal(matched.rubric_evaluation.status, 'passed');
  assert.equal(matched.rubric_evaluation.summary.criteria_passed, 1);
  assert.equal(matched.quality_signal.rubric_criteria, 1);
  assert.doesNotMatch(JSON.stringify(matched), /Current local run is healthy/);

  const mismatched = buildLocalContentUxAdvisory({
    target,
    routeReviews: [{
      route: { url: target.pages[0].url },
      viewport: { name: 'desktop' },
      evidenceSummary: {
        visible_text: 'Dashboard overview is unavailable.',
        visible_text_length: 34
      }
    }]
  });
  assert.equal(mismatched.status, 'needs_owner_review');
  assert.equal(mismatched.counts.data_binding_mismatches, 1);
  assert.ok(mismatched.signals.some((signal) => signal.id === 'content_ux_source_text_not_visible'));
  assert.equal(mismatched.findings.length, 1);
  assert.equal(mismatched.findings[0].category, 'content_contract');
  assert.equal(mismatched.findings[0].source, 'local_content_ux_advisory');
  assert.equal(mismatched.findings[0].gate_effect, 'none');
  assert.equal(mismatched.action_plan.status, 'needs_content_owner_review');
  assert.equal(mismatched.action_plan.legacy_action_plan_unchanged, true);
  assert.equal(mismatched.action_plan.total_action_items, 1);
  assert.equal(mismatched.action_plan.page_focus[0].page_id, 'overview');
  assert.equal(mismatched.readiness.status, 'needs_content_owner_review');
  assert.equal(mismatched.readiness.gate_effect, 'none');
  assert.equal(mismatched.readiness.blocking_release_gate, false);
  assert.equal(mismatched.page_handoff.summary.pages_with_findings, 1);
  assert.equal(mismatched.page_handoff.pages[0].status, 'needs_content_owner_review');
  assert.ok(mismatched.manifest_authoring.suggestions.some((suggestion) => suggestion.type === 'add_user_questions'));
  assert.equal(mismatched.review_brief.status, 'needs_content_owner_review');
  assert.equal(mismatched.review_brief.summary.decision_needs_needing_owner_review, 1);
  assert.equal(mismatched.rubric_evaluation.status, 'needs_content_owner_review');
  assert.equal(mismatched.rubric_evaluation.summary.criteria_needing_owner_review, 1);
  assert.doesNotMatch(JSON.stringify(mismatched), /Current local run is healthy/);
});

test('local content UX advisory supports selector-scoped state contracts and user questions', () => {
  const normalized = normalizeTargetManifest({
    baseUrl: 'https://example.test/app',
    pages: [{
      name: 'Status',
      path: '/app',
      expectations: {
        dataBindings: [
          {
            id: 'service-state',
            sourceId: 'service',
            pointer: '/service/state',
            selector: '#service',
            target: 'data-state',
            match: 'exact'
          },
          {
            id: 'health-status',
            sourceId: 'service',
            pointer: '/health/status',
            selector: '#check',
            target: 'attribute',
            attribute: 'data-status',
            match: 'exact'
          },
          {
            id: 'risk-level',
            sourceId: 'service',
            pointer: '/risk/level',
            selector: '#risk',
            target: 'data-risk',
            match: 'exact'
          }
        ],
        userQuestions: [{
          id: 'risk-awareness',
          question: 'Can users identify current risk?',
          expectedEvidence: ['Low risk'],
          selector: '#risk'
        }]
      }
    }],
    sourceData: [{
      id: 'service',
      data: {
        service: { state: 'ready' },
        health: { status: 'complete' },
        risk: { level: 'minor' }
      }
    }],
    localContentUxAdvisory: {
      enabled: true,
      audience: ['operators'],
      goal: 'Explain service status and risk.',
      requiredUserQuestions: [{
        id: 'environment-awareness',
        pageId: 'status',
        question: 'Can users identify the active environment?',
        expectedEvidence: ['Production']
      }]
    }
  });
  assert.equal(normalized.ok, true);
  const target = normalized.target;
  const advisory = buildLocalContentUxAdvisory({
    target,
    routeReviews: [{
      route: { url: target.pages[0].url },
      manifest_page_id: 'status',
      viewport: { name: 'desktop' },
      evidenceSummary: {
        visible_text: 'Production environment. Low risk.',
        visible_text_length: 25,
        elements: [
          { selector: '#service', text: 'Service state', accessible_name: 'Service state', attributes: { 'data-state': 'ready' } },
          { selector: '#check', text: 'Health check', accessible_name: 'Health check', attributes: { 'data-status': 'complete' } },
          { selector: '#risk', text: 'Low risk', accessible_name: 'Low risk', attributes: { 'data-risk': 'minor' } }
        ]
      }
    }]
  });

  assert.equal(advisory.status, 'passed');
  assert.equal(advisory.counts.data_binding_checks, 3);
  assert.equal(advisory.counts.selector_scoped_binding_checks, 3);
  assert.equal(advisory.counts.attribute_binding_checks, 1);
  assert.equal(advisory.counts.state_binding_checks, 1);
  assert.equal(advisory.counts.risk_binding_checks, 1);
  assert.equal(advisory.counts.data_binding_matches, 3);
  assert.equal(advisory.counts.required_user_questions, 2);
  assert.equal(advisory.counts.user_questions_answered, 2);
  assert.equal(advisory.quality_signal.required_user_questions, 2);
  assert.deepEqual(advisory.findings, []);
  assert.equal(advisory.action_plan.status, 'passed');
  assert.equal(advisory.readiness.status, 'passed');
  assert.doesNotMatch(JSON.stringify(advisory), /"ready"|"complete"|"minor"/);

  const mismatch = buildLocalContentUxAdvisory({
    target,
    routeReviews: [{
      route: { url: target.pages[0].url },
      manifest_page_id: 'status',
      viewport: { name: 'desktop' },
      evidenceSummary: {
        visible_text: 'Environment unknown.',
        visible_text_length: 12,
        elements: [
          { selector: '#service', text: 'Service state', attributes: { 'data-state': 'offline' } },
          { selector: '#check', text: 'Health check', attributes: { 'data-status': 'failed' } },
          { selector: '#risk', text: 'Unknown', attributes: { 'data-risk': 'high' } }
        ]
      }
    }]
  });
  assert.equal(mismatch.status, 'needs_owner_review');
  assert.equal(mismatch.counts.data_binding_mismatches, 3);
  assert.equal(mismatch.counts.user_questions_unanswered, 2);
  assert.ok(mismatch.signals.some((signal) => signal.id === 'content_ux_source_state_not_matched'));
  assert.ok(mismatch.signals.some((signal) => signal.id === 'content_ux_user_question_not_answered'));
  assert.equal(mismatch.findings.length, 5);
  assert.ok(mismatch.findings.some((finding) => finding.category === 'content_contract'));
  assert.ok(mismatch.findings.some((finding) => finding.category === 'status_clarity'));
  assert.ok(mismatch.findings.some((finding) => finding.category === 'information_architecture'));
  assert.equal(mismatch.action_plan.total_action_items, mismatch.findings.length);
  assert.equal(mismatch.action_plan.status, 'needs_content_owner_review');
  assert.equal(mismatch.action_plan.gate_effect, 'none');
  assert.equal(mismatch.action_plan.page_focus[0].page_id, 'status');
  assert.equal(mismatch.readiness.status, 'needs_content_owner_review');
  assert.equal(mismatch.readiness.content_owner_review_required, true);
  assert.equal(mismatch.readiness.page_handoff.pages_with_findings, 1);
  assert.equal(mismatch.page_handoff.pages.find((page) => page.page_id === 'status').top_categories.includes('status_clarity'), true);
  assert.doesNotMatch(JSON.stringify(mismatch), /"ready"|"complete"|"minor"/);

  const questionOnly = normalizeTargetManifest({
    baseUrl: 'https://example.test/app',
    pages: [{
      name: 'Question Only',
      path: '/app',
      expectations: {
        userQuestions: [{
          id: 'next-action',
          question: 'Can users identify the next action?',
          expectedEvidence: ['Run checks']
        }]
      }
    }],
    localContentUxAdvisory: {
      enabled: true,
      audience: ['operators'],
      goal: 'Explain next actions.'
    }
  });
  const questionOnlyAdvisory = buildLocalContentUxAdvisory({
    target: questionOnly.target,
    routeReviews: [{
      route: { url: questionOnly.target.pages[0].url },
      manifest_page_id: 'question-only',
      viewport: { name: 'desktop' },
      evidenceSummary: {
        visible_text: 'Run checks before release.',
        visible_text_length: 26,
        elements: []
      }
    }]
  });
  assert.equal(questionOnlyAdvisory.counts.pages_without_content_contract, 1);
  assert.equal(questionOnlyAdvisory.counts.required_user_questions, 1);
  assert.equal(questionOnlyAdvisory.counts.user_questions_answered, 1);
  assert.equal(questionOnlyAdvisory.action_plan.status, 'advisory_notes');
  assert.ok(questionOnlyAdvisory.findings.some((finding) => finding.category === 'coverage_contract'));

  const userJourneyGap = normalizeTargetManifest({
    baseUrl: 'https://example.test/app',
    pages: [{
      name: 'Next Action',
      path: '/next',
      expectations: {
        userQuestions: [{
          id: 'next-action',
          question: 'Can users identify the next action?',
          expectedEvidence: ['Run checks'],
          severity: 'medium'
        }, {
          id: 'details-navigation',
          question: 'Can users find the details page?',
          expectedEvidence: ['Open details'],
          severity: 'medium'
        }]
      }
    }],
    localContentUxAdvisory: {
      enabled: true,
      audience: ['operators'],
      goal: 'Explain next actions and navigation.'
    }
  });
  const userJourneyGapAdvisory = buildLocalContentUxAdvisory({
    target: userJourneyGap.target,
    routeReviews: [{
      route: { url: userJourneyGap.target.pages[0].url },
      manifest_page_id: 'next-action',
      viewport: { name: 'desktop' },
      evidenceSummary: {
        visible_text: 'Overview only.',
        visible_text_length: 14,
        elements: []
      }
    }]
  });
  assert.ok(userJourneyGapAdvisory.findings.some((finding) => finding.category === 'action_clarity'));
  assert.ok(userJourneyGapAdvisory.findings.some((finding) => finding.category === 'navigation_clarity'));
  assert.equal(userJourneyGapAdvisory.page_handoff.summary.pages_with_findings, 1);
  assert.ok(userJourneyGapAdvisory.manifest_authoring.suggestions.some((suggestion) => suggestion.type === 'strengthen_next_action_contracts'));
  assert.ok(userJourneyGapAdvisory.manifest_authoring.suggestions.some((suggestion) => suggestion.type === 'strengthen_navigation_contracts'));
});

test('target init writes a reusable local target manifest artifact', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'browser-debug-target-init-'));
  await writeFile(path.join(cwd, '.gitignore'), '.browser-debug/\n', 'utf8');

  const parsed = parseCliArgs([
    'target',
    'init',
    '--url',
    'https://example.test/app',
    '--name',
    'Example App',
    '--max-routes',
    '8',
    '--json'
  ]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'target init');
  assert.equal(parsed.options['max-routes'], '8');

  const result = await executeCli([
    'target',
    'init',
    '--url',
    'https://example.test/app',
    '--name',
    'Example App',
    '--max-routes',
    '8',
    '--json'
  ], {
    cwd,
    now: fixedNow,
    createId: () => 'target-fixed'
  });

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'target init');
  assert.equal(body.data.target_manifest.name, 'Example App');
  assert.equal(body.data.target_manifest.budgets.maxRoutes, 8);
  assert.deepEqual(body.data.target_manifest.pages, []);
  assert.equal(body.data.boundary.external_upload, false);
  const artifact = body.artifacts.find((candidate) => candidate.type === 'target_manifest');
  assert.ok(artifact);
  const manifest = JSON.parse(await readFile(path.join(cwd, artifact.path), 'utf8'));
  assert.equal(manifest.baseUrl, 'https://example.test/app');
});

test('target validate checks edited manifests without launching a browser', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'browser-debug-target-validate-'));
  const manifestPath = path.join(cwd, 'target.json');
  await writeFile(manifestPath, JSON.stringify({
    baseUrl: 'https://example.test/app',
    expectedRoutes: ['/app/status'],
    pages: [{
      name: 'Status',
      path: '/app/status',
      role: 'status_overview',
      expectations: {
        text: ['Status'],
        selectors: ['#status'],
        dataBindings: [{
          id: 'status-summary',
          sourceId: 'status-source',
          pointer: '/status/summary',
          selector: '#status',
          target: 'text'
        }],
        userQuestions: [{
          id: 'status-understanding',
          question: 'Can users understand the current status?',
          expectedEvidence: ['healthy']
        }]
      }
    }],
    sourceData: [{
      id: 'status-source',
      data: { status: { summary: 'Current local run is healthy' } }
    }],
    localContentUxAdvisory: {
      enabled: true,
      audience: ['operators'],
      goal: 'Explain status clearly.',
      requiredUserQuestions: [{
        id: 'next-decision',
        pageId: 'status',
        question: 'Can users decide the next step?',
        expectedEvidence: ['healthy']
      }],
      reviewBrief: {
        summary: 'The status page should explain whether action is needed.',
        userRoles: ['operator'],
        decisionNeeds: [{
          id: 'action-decision',
          pageId: 'status',
          question: 'Can users decide whether action is needed?',
          expectedEvidence: ['healthy']
        }]
      },
      rubric: [{
        id: 'status-clarity',
        pageId: 'status',
        category: 'status_clarity',
        criterion: 'Status is clear.',
        expectedEvidence: ['healthy']
      }]
    }
  }), 'utf8');

  const parsed = parseCliArgs(['target', 'validate', '--target', manifestPath, '--json']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'target validate');

  const result = await executeCli(['target', 'validate', '--target', manifestPath, '--json'], {
    cwd,
    now: fixedNow
  });
  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'target validate');
  assert.equal(body.data.target_manifest.status, 'valid');
  assert.equal(body.data.target_manifest.counts.expected_routes, 1);
  assert.equal(body.data.target_manifest.counts.pages, 1);
  assert.equal(body.data.target_manifest.counts.source_data_available, 1);
  assert.equal(body.data.target_manifest.counts.data_bindings, 1);
  assert.equal(body.data.target_manifest.counts.required_user_questions, 1);
  assert.equal(body.data.target_manifest.counts.review_brief_decision_needs, 1);
  assert.equal(body.data.target_manifest.counts.rubric_criteria, 1);
  assert.equal(body.data.boundary.browser_launched, false);
  assert.equal(body.data.boundary.external_upload, false);
  assert.equal(body.data.boundary.profile_reuse, false);
  assert.equal(body.data.boundary.source_data_values_exposed, false);
  assert.equal(body.data.boundary.manifest_mutated, false);
  assert.match(body.data.next_commands.review_json, /trace-cue review --target @/);
  assert.doesNotMatch(result.stdout, /Current local run is healthy/);

  const invalid = await executeCli(['target', 'validate', '--target', '{"name":"missing base"}', '--json'], {
    now: fixedNow
  });
  assert.equal(invalid.exitCode, 1);
  const invalidBody = JSON.parse(invalid.stdout);
  assert.equal(invalidBody.command, 'target validate');
  assert.equal(invalidBody.errors[0].code, 'TARGET_BASE_URL_REQUIRED');
});

test('capture handoff summarizes existing workspace images without writing artifacts', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-capture-handoff-'));
  const png = minimalPngBuffer(320, 180);
  await writeFile(path.join(cwd, 'desktop.png'), png);

  const parsed = parseCliArgs(['capture', 'handoff', '--image', 'desktop.png', '--source', 'desktop-app', '--json']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'capture handoff');
  assert.equal(parsed.options.image, 'desktop.png');
  assert.equal(parsed.options.source, 'desktop-app');

  const result = await executeCli(['capture', 'handoff', '--image', 'desktop.png', '--source', 'desktop-app', '--json'], {
    cwd,
    now: fixedNow
  });
  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'capture handoff');
  assert.equal(body.data.capture_handoff.status, 'metadata_only');
  assert.equal(body.data.capture_handoff.source.kind, 'desktop_app_capture');
  assert.equal(body.data.capture_handoff.source.capture_performed_by_trace_cue, false);
  assert.equal(body.data.capture_handoff.source.source_verified_by_trace_cue, false);
  assert.equal(body.data.capture_handoff.source.surface_identity_collected, false);
  assert.equal(body.data.capture_handoff.media.width, 320);
  assert.equal(body.data.capture_handoff.media.height, 180);
  assert.equal(body.data.capture_handoff.boundary.existing_workspace_image_read, true);
  assert.equal(body.data.capture_handoff.boundary.image_bytes_read_for_metadata, true);
  assert.equal(body.data.capture_handoff.boundary.capture_performed, false);
  assert.equal(body.data.capture_handoff.boundary.raw_pixels_in_json, false);
  assert.equal(body.data.capture_handoff.boundary.writes_artifacts, false);
  assert.equal(body.data.capture_handoff.boundary.mcp_permissions_changed, false);
  assert.equal(body.data.capture_handoff.boundary.mcp_execution_exposed, false);
  assert.deepEqual(body.artifacts, []);
  assert.equal(JSON.stringify(body.data).includes(png.toString('base64')), false);
  await assert.rejects(() => access(path.join(cwd, '.browser-debug')));

  const direct = await runCaptureHandoff({ image: 'desktop.png', source: 'screen' }, { cwd, now: fixedNow });
  assert.equal(direct.status, 'ok');
  assert.equal(direct.data.capture_handoff.source.kind, 'screen_capture');
  assert.equal(captureHandoffBoundary().artifact_created, false);

  const invalidSource = await executeCli(['capture', 'handoff', '--image', 'desktop.png', '--source', 'camera', '--json'], {
    cwd,
    now: fixedNow
  });
  assert.equal(invalidSource.exitCode, 1);
  assert.equal(JSON.parse(invalidSource.stdout).errors[0].code, 'INVALID_CAPTURE_HANDOFF_SOURCE');

  const oversize = await executeCli(['capture', 'handoff', '--image', 'desktop.png', '--source', 'screen', '--max-bytes', '1', '--json'], {
    cwd,
    now: fixedNow
  });
  assert.equal(oversize.exitCode, 1);
  assert.equal(JSON.parse(oversize.stdout).errors[0].code, 'VISUAL_EVIDENCE_INPUT_TOO_LARGE');

  const allSource = parseCliArgs(['capture', 'handoff', '--image', 'desktop.png', '--source', 'all', '--json']);
  assert.equal(allSource.ok, false);
  assert.equal(allSource.error.code, 'INVALID_CAPTURE_HANDOFF_SOURCE');

  for (const badImage of ['https://example.test/desktop.png', '../desktop.png', '@desktop.png', '-']) {
    const parsedBadImage = parseCliArgs(['capture', 'handoff', '--image', badImage, '--source', 'screen', '--json']);
    assert.equal(parsedBadImage.ok, false);
    assert.equal(parsedBadImage.error.code, 'INVALID_CAPTURE_HANDOFF_IMAGE');
  }

  const provider = parseCliArgs(['capture', 'handoff', '--image', 'desktop.png', '--source', 'screen', '--provider', 'generic-api', '--json']);
  assert.equal(provider.ok, false);
  assert.equal(provider.error.code, 'UNSUPPORTED_CAPTURE_HANDOFF_OPTION');

  const artifactRoot = parseCliArgs(['capture', 'handoff', '--image', 'desktop.png', '--source', 'screen', '--artifact-root', '.trace-cue', '--json']);
  assert.equal(artifactRoot.ok, false);
  assert.equal(artifactRoot.error.code, 'UNSUPPORTED_CAPTURE_HANDOFF_OPTION');
});

test('visual review plan prepares desktop review provider planning from capture handoff metadata only', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trace-cue-desktop-review-plan-'));
  const png = minimalPngBuffer(320, 180);
  await writeFile(path.join(cwd, 'desktop.png'), png);

  const handoffResult = await executeCli(['capture', 'handoff', '--image', 'desktop.png', '--source', 'desktop-app', '--json'], {
    cwd,
    now: fixedNow
  });
  assert.equal(handoffResult.exitCode, 0);
  const handoffBody = JSON.parse(handoffResult.stdout);
  assert.equal(handoffBody.data.capture_handoff.source.kind, 'desktop_app_capture');
  await writeFile(path.join(cwd, 'handoff.json'), JSON.stringify(handoffBody, null, 2));

  const parsed = parseCliArgs(['visual', 'review', 'plan', '--capture-handoff', 'handoff.json', '--surface', 'desktop-app', '--provider', 'manual', '--model', 'reviewer', '--json']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'visual review plan');
  assert.equal(parsed.options['capture-handoff'], 'handoff.json');

  const result = await executeCli(['visual', 'review', 'plan', '--capture-handoff', 'handoff.json', '--surface', 'desktop-app', '--provider', 'manual', '--model', 'reviewer', '--json'], {
    cwd,
    now: fixedNow
  });
  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'visual review plan');
  assert.equal(body.data.desktop_review_provider_preparation_plan.status, 'planned');
  assert.equal(body.data.desktop_review_provider_preparation_plan.source.source_kind, 'desktop_app_capture');
  assert.equal(body.data.desktop_review_provider_preparation_plan.source.workspace_image_path, 'desktop.png');
  assert.equal(body.data.desktop_review_provider_preparation_plan.source.source_verified_by_trace_cue, false);
  assert.equal(body.data.desktop_review_provider_preparation_plan.media.width, 320);
  assert.equal(body.data.desktop_review_provider_preparation_plan.readiness.provider_preparation_artifact_created, false);
  assert.equal(body.data.desktop_review_provider_preparation_plan.provider_preparation.planning_only, true);
  assert.equal(body.data.desktop_review_provider_preparation_plan.provider_preparation.provider_call_performed, false);
  assert.equal(body.data.desktop_review_provider_preparation_plan.disclosure_policy.image_bytes_read, false);
  assert.equal(body.data.desktop_review_provider_preparation_plan.disclosure_policy.raw_pixels_in_json, false);
  assert.equal(body.data.desktop_review_provider_preparation_plan.boundary.capture_handoff_json_read, true);
  assert.equal(body.data.desktop_review_provider_preparation_plan.boundary.image_bytes_read, false);
  assert.equal(body.data.desktop_review_provider_preparation_plan.boundary.writes_artifacts, false);
  assert.equal(body.data.desktop_review_provider_preparation_plan.boundary.provider_call_performed, false);
  assert.equal(body.data.desktop_review_provider_preparation_plan.boundary.mcp_execution_exposed, false);
  assert.deepEqual(body.artifacts, []);
  assert.equal(JSON.stringify(body.data).includes(png.toString('base64')), false);
  await assert.rejects(() => access(path.join(cwd, '.browser-debug')));

  const direct = await buildDesktopReviewProviderPreparationPlan({
    'capture-handoff': JSON.stringify(handoffBody.data.capture_handoff),
    surface: 'screen'
  }, { cwd, now: fixedNow });
  assert.equal(direct.status, 'ok');
  assert.equal(direct.data.desktop_review_provider_preparation_plan.source.source_kind, 'desktop_app_capture');
  assert.equal(desktopReviewProviderPreparationPlanBoundary().artifact_created, false);

  const execute = parseCliArgs(['visual', 'review', 'plan', '--capture-handoff', 'handoff.json', '--execute', '--json']);
  assert.equal(execute.ok, false);
  assert.equal(execute.error.code, 'CONFLICTING_OPTIONS');

  const image = parseCliArgs(['visual', 'review', 'plan', '--capture-handoff', 'handoff.json', '--image', 'desktop.png', '--json']);
  assert.equal(image.ok, false);
  assert.equal(image.error.code, 'UNSUPPORTED_VISUAL_REVIEW_PLAN_OPTION');

  const unsafe = {
    ...handoffBody.data.capture_handoff,
    source: {
      ...handoffBody.data.capture_handoff.source,
      path: '../desktop.png'
    }
  };
  await writeFile(path.join(cwd, 'unsafe-handoff.json'), JSON.stringify(unsafe, null, 2));
  const unsafeResult = await executeCli(['visual', 'review', 'plan', '--capture-handoff', 'unsafe-handoff.json', '--json'], {
    cwd,
    now: fixedNow
  });
  assert.equal(unsafeResult.exitCode, 1);
  assert.equal(JSON.parse(unsafeResult.stdout).errors[0].code, 'DESKTOP_REVIEW_PLAN_CAPTURE_HANDOFF_IMAGE_PATH_INVALID');
});

test('capture plan reports screen and window capture boundaries without capturing pixels', async () => {
  const parsed = parseCliArgs(['capture', 'plan', '--source', 'window', '--json']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'capture plan');
  assert.equal(parsed.options.source, 'window');

  const result = await executeCli(['capture', 'plan', '--source', 'window', '--json'], { now: fixedNow });
  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'capture plan');
  assert.equal(body.data.capture_plan.source_selection, 'window');
  assert.equal(body.data.capture_plan.summary.capture_performed, false);
  assert.equal(body.data.capture_plan.summary.raw_pixels_read, false);
  assert.equal(body.data.capture_plan.summary.raw_pixels_written, false);
  assert.equal(body.data.capture_plan.summary.raw_pixels_in_json, false);
  assert.equal(body.data.capture_plan.summary.native_capture_dependency_loaded, false);
  assert.equal(body.data.capture_plan.summary.mcp_execution_exposed, false);
  assert.equal(body.data.capture_plan.sources.length, 1);
  assert.equal(body.data.capture_plan.sources[0].source_kind, 'window_capture');
  assert.equal(body.data.capture_plan.sources[0].mcp_capture_available, false);
  assert.equal(body.data.capture_plan.sources[0].required_gates.some((gate) => gate.id === 'explicit_window_selection'), true);
  assert.equal(body.data.boundary.read_only, true);
  assert.equal(body.data.boundary.os_capture_api_used, false);
  assert.equal(body.data.boundary.window_enumeration_performed, false);
  assert.equal(body.data.boundary.native_capture_dependency_loaded, false);
  assert.equal(body.data.boundary.requires_owner_review_before_capture, true);
  assert.deepEqual(body.artifacts, []);

  const direct = buildCapturePlan({ source: 'desktop-app' }, { now: fixedNow });
  assert.equal(direct.ok, true);
  assert.equal(direct.report.sources[0].source_kind, 'desktop_app_capture');
  assert.equal(capturePlanBoundary().process_enumeration_performed, false);

  const invalid = await executeCli(['capture', 'plan', '--source', 'camera', '--json'], { now: fixedNow });
  assert.equal(invalid.exitCode, 1);
  assert.equal(JSON.parse(invalid.stdout).errors[0].code, 'INVALID_CAPTURE_PLAN_SOURCE');

  const execute = await executeCli(['capture', 'plan', '--execute', '--json'], { now: fixedNow });
  assert.equal(execute.exitCode, 2);
  assert.equal(JSON.parse(execute.stdout).errors[0].code, 'CONFLICTING_OPTIONS');

  const provider = await executeCli(['capture', 'plan', '--provider', 'generic-api', '--json'], { now: fixedNow });
  assert.equal(provider.exitCode, 2);
  assert.equal(JSON.parse(provider.stdout).errors[0].code, 'UNSUPPORTED_CAPTURE_PLAN_OPTION');

  const mcpPlan = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 48,
    method: 'tools/call',
    params: {
      name: 'browser_debug_capture_plan',
      arguments: { source: 'screen' }
    }
  }, { mcpProfile: 'safe', now: fixedNow });
  assert.equal(mcpPlan.result.structuredContent.command, 'capture plan');
  assert.equal(mcpPlan.result.structuredContent.data.capture_plan.source_selection, 'screen');
  assert.equal(mcpPlan.result.structuredContent.data.boundary.mcp_execution_exposed, false);
});

test('MCP execution gates report required approval boundaries without exposing execution', async () => {
  const parsed = parseCliArgs(['mcp', 'execution', 'gates', '--operation', 'visual_review_run', '--profile', 'admin', '--json']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'mcp execution gates');
  assert.equal(parsed.options.operation, 'visual_review_run');

  const result = await executeCli(['mcp', 'execution', 'gates', '--operation', 'visual_review_run', '--profile', 'admin', '--json'], { now: fixedNow });
  assert.equal(result.exitCode, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.command, 'mcp execution gates');
  assert.equal(body.data.execution_gates.operation_selection, 'visual_review_run');
  assert.equal(body.data.execution_gates.summary.write_execute_tools_exposed, false);
  assert.equal(body.data.execution_gates.summary.execution_ready_for_mcp, false);
  assert.equal(body.data.execution_gates.operations.length, 1);
  assert.equal(body.data.execution_gates.operations[0].current_mcp_exposure.admin, false);
  assert.equal(body.data.execution_gates.operations[0].required_gates.some((gate) => gate.id === 'credential_boundary'), true);
  assert.equal(body.data.boundary.read_only, true);
  assert.equal(body.data.boundary.mcp_permissions_changed, false);
  assert.deepEqual(body.artifacts, []);

  const desktopPlanGate = await executeCli(['mcp', 'execution', 'gates', '--operation', 'desktop_review_provider_preparation_plan', '--json'], { now: fixedNow });
  assert.equal(desktopPlanGate.exitCode, 0);
  const desktopPlanGateBody = JSON.parse(desktopPlanGate.stdout);
  assert.equal(desktopPlanGateBody.data.execution_gates.operations[0].current_mcp_exposure.safe, false);
  assert.equal(desktopPlanGateBody.data.execution_gates.operations[0].required_gates.some((gate) => gate.id === 'no_raw_pixels'), true);

  const aggregationGate = await executeCli(['mcp', 'execution', 'gates', '--operation', 'visual_review_aggregation', '--json'], { now: fixedNow });
  assert.equal(aggregationGate.exitCode, 0);
  const aggregationGateBody = JSON.parse(aggregationGate.stdout);
  assert.equal(aggregationGateBody.data.execution_gates.operations[0].proposed_stage, 'read_exposure_gate_required');
  assert.equal(aggregationGateBody.data.execution_gates.operations[0].current_mcp_exposure.admin, false);
  assert.equal(aggregationGateBody.data.execution_gates.operations[0].required_gates.some((gate) => gate.id === 'source_attribution_required'), true);

  const invalid = await executeCli(['mcp', 'execution', 'gates', '--operation', 'wide_open', '--json'], { now: fixedNow });
  assert.equal(invalid.exitCode, 1);
  assert.equal(JSON.parse(invalid.stdout).errors[0].code, 'INVALID_MCP_EXECUTION_GATE_OPERATION');

  const mcpGate = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 46,
    method: 'tools/call',
    params: {
      name: 'browser_debug_mcp_execution_gates',
      arguments: { operation: 'agent_execution_run', profile: 'admin' }
    }
  }, { mcpProfile: 'safe', now: fixedNow });
  assert.equal(mcpGate.result.structuredContent.command, 'mcp execution gates');
  assert.equal(mcpGate.result.structuredContent.data.execution_gates.operation_selection, 'agent_execution_run');
  assert.equal(mcpGate.result.structuredContent.data.boundary.mcp_write_execute_exposed, false);
});

test('MCP adapter exposes a local allowlisted tool surface', async () => {
  const initialized = await handleMcpRequest({ jsonrpc: '2.0', id: 0, method: 'initialize' });
  assert.equal(initialized.result.serverInfo.name, PRODUCT_IDENTITY.mcpServerName);
  assert.equal(initialized.result.metadata.name, 'full');
  assert.equal(initialized.result.metadata.identity.package_name, PRODUCT_IDENTITY.packageName);
  assert.equal(initialized.result.metadata.identity.package_version, PRODUCT_IDENTITY.packageVersion);
  assert.equal(initialized.result.metadata.identity.mcp_bin_name, PRODUCT_IDENTITY.mcpBinName);
  assert.equal(initialized.result.metadata.profile.name, 'full');

  const listed = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(listed.result.profile.name, 'full');
  assert.equal(listed.result.tools.some((tool) => tool.name === 'browser_debug_review'), true);
  assert.equal(listed.result.tools.some((tool) => tool.name === 'browser_debug_target_init'), true);
  assert.equal(listed.result.tools.some((tool) => tool.name === 'browser_debug_target_validate'), true);
  assert.equal(listed.result.tools.some((tool) => tool.name === 'browser_debug_resource_status'), true);
  assert.equal(listed.result.tools.some((tool) => tool.name === 'browser_debug_resource_artifacts_plan'), true);
  assert.equal(listed.result.tools.some((tool) => tool.name === 'browser_debug_agent_surfaces_list'), true);
  assert.equal(listed.result.tools.some((tool) => tool.name === 'browser_debug_agent_requests_list'), true);
  assert.equal(listed.result.tools.some((tool) => tool.name === 'browser_debug_agent_workflow_status'), true);
  assert.equal(listed.result.tools.some((tool) => tool.name === 'browser_debug_agent_execution_status'), true);
  assert.equal(listed.result.tools.some((tool) => tool.name === 'browser_debug_visual_review_dashboard'), true);
  assert.equal(listed.result.tools.some((tool) => tool.name === 'browser_debug_mcp_execution_gates'), true);
  assert.equal(listed.result.tools.some((tool) => tool.name === 'browser_debug_mcp_capabilities'), true);
  assert.equal(listed.result.tools.some((tool) => tool.name === 'browser_debug_review_target'), true);
  assert.equal(listed.result.tools.some((tool) => /agent_execution_run|cleanup_execute|provider_execute|visual_review_prepare|visual_review_plan|visual_review_aggregate|desktop_review_provider|capture_handoff/i.test(tool.name)), false);
  assert.equal(listed.result.tools.some((tool) => /shell|cleanup/i.test(tool.name)), false);
  assert.equal(listed.result.tools.every((tool) => tool.effects.shellUsed === false), true);

  const safeListed = await handleMcpRequest({ jsonrpc: '2.0', id: 11, method: 'tools/list' }, { mcpProfile: 'safe' });
  const safeToolNames = safeListed.result.tools.map((tool) => tool.name);
  assert.equal(safeListed.result.profile.name, 'safe');
  assert.equal(safeToolNames.includes('browser_debug_target_validate'), true);
  assert.equal(safeToolNames.includes('browser_debug_resource_status'), true);
  assert.equal(safeToolNames.includes('browser_debug_resource_artifacts_plan'), true);
  assert.equal(safeToolNames.includes('browser_debug_agent_surfaces_list'), true);
  assert.equal(safeToolNames.includes('browser_debug_agent_requests_show'), true);
  assert.equal(safeToolNames.includes('browser_debug_agent_workflow_index'), true);
  assert.equal(safeToolNames.includes('browser_debug_agent_execution_list'), true);
  assert.equal(safeToolNames.includes('browser_debug_visual_review_dashboard'), true);
  assert.equal(safeToolNames.includes('browser_debug_mcp_execution_gates'), true);
  assert.equal(safeToolNames.includes('browser_debug_mcp_capabilities'), true);
  assert.equal(safeToolNames.includes('browser_debug_review'), false);
  assert.equal(safeToolNames.includes('browser_debug_observe'), false);
  assert.equal(safeToolNames.includes('browser_debug_target_init'), false);
  assert.equal(safeToolNames.includes('browser_debug_review_target'), false);
  assert.equal(safeToolNames.some((name) => /agent_execution_run|cleanup_execute|provider_execute|visual_review_prepare|visual_review_plan|visual_review_run|visual_review_aggregate|desktop_review_provider|capture_handoff/i.test(name)), false);
  assert.equal(safeListed.result.tools.every((tool) => tool.effects.browserLaunched === false), true);
  assert.equal(safeListed.result.tools.every((tool) => tool.effects.deletesFiles === false), true);
  assert.equal(safeListed.result.tools.every((tool) => tool.effects.providerCall === false), true);

  const adminListed = await handleMcpRequest({ jsonrpc: '2.0', id: 12, method: 'tools/list' }, { mcpProfile: 'admin' });
  assert.equal(adminListed.result.profile.name, 'admin');
  assert.deepEqual(
    adminListed.result.tools.map((tool) => tool.name),
    listed.result.tools.map((tool) => tool.name)
  );

  const invalidProfile = await handleMcpRequest({ jsonrpc: '2.0', id: 13, method: 'tools/list' }, { mcpProfile: 'wide-open' });
  assert.equal(invalidProfile.error.code, -32602);
  assert.match(invalidProfile.error.message, /Unsupported MCP profile/);

  const blockedByProfile = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 14,
    method: 'tools/call',
    params: {
      name: 'browser_debug_review',
      arguments: { url: 'https://example.test/' }
    }
  }, { mcpProfile: 'safe', now: fixedNow });
  assert.equal(blockedByProfile.error.code, -32602);
  assert.match(blockedByProfile.error.message, /not available for MCP profile safe/);

  const mcpInfoParsed = parseCliArgs(['mcp', 'serve', '--profile', 'safe', '--json']);
  assert.equal(mcpInfoParsed.ok, true);
  assert.equal(mcpInfoParsed.options.profile, 'safe');

  const mcpInfo = await executeCli(['mcp', 'serve', '--profile', 'safe', '--json'], { now: fixedNow });
  assert.equal(mcpInfo.exitCode, 0);
  const mcpInfoBody = JSON.parse(mcpInfo.stdout);
  assert.equal(mcpInfoBody.data.adapter.profile.name, 'safe');

  const mcpConfigParsed = parseCliArgs(['mcp', 'config', '--client', 'codex', '--profile', 'safe', '--json']);
  assert.equal(mcpConfigParsed.ok, true);
  assert.equal(mcpConfigParsed.command, 'mcp config');
  assert.equal(mcpConfigParsed.options.client, 'codex');

  const stdioConfig = await executeCli(['mcp', 'config', '--client', 'codex', '--json'], { now: fixedNow });
  assert.equal(stdioConfig.exitCode, 0);
  const stdioConfigBody = JSON.parse(stdioConfig.stdout);
  assert.equal(stdioConfigBody.command, 'mcp config');
  assert.equal(stdioConfigBody.data.config.transport, 'stdio');
  assert.equal(stdioConfigBody.data.config.client, 'codex');
  assert.equal(stdioConfigBody.data.config.profile.name, 'safe');
  assert.equal(stdioConfigBody.data.config.launch.command, PRODUCT_IDENTITY.mcpBinName);
  assert.deepEqual(stdioConfigBody.data.config.launch.args, ['--profile', 'safe']);
  assert.equal(stdioConfigBody.data.config.mcpServers[PRODUCT_IDENTITY.mcpServerName].command, PRODUCT_IDENTITY.mcpBinName);
  const legacyMcpServerName = PRODUCT_IDENTITY.legacyMcpServerNames[0];
  const legacyMcpBin = PRODUCT_IDENTITY.legacyMcpBins[0];
  assert.equal(stdioConfigBody.data.config.legacy_mcpServers[legacyMcpServerName].command, legacyMcpBin.name);
  assert.deepEqual(stdioConfigBody.data.config.legacy_mcpServers[legacyMcpServerName].args, ['--profile', 'safe']);
  assert.equal(stdioConfigBody.data.config.compatibility.legacy.mcp_bin_names[0], legacyMcpBin.name);
  const expectedLocalMcpBinPath = path.resolve(process.cwd(), PRODUCT_IDENTITY.mcpBinPath);
  assert.equal(stdioConfigBody.data.config.local_checkout.launch.command, process.execPath);
  assert.deepEqual(stdioConfigBody.data.config.local_checkout.launch.args, [expectedLocalMcpBinPath, '--profile', 'safe']);
  assert.equal(stdioConfigBody.data.config.local_checkout.mcpServers[PRODUCT_IDENTITY.mcpServerName].command, process.execPath);
  assert.deepEqual(
    stdioConfigBody.data.config.local_checkout.mcpServers[PRODUCT_IDENTITY.mcpServerName].args,
    [expectedLocalMcpBinPath, '--profile', 'safe']
  );
  const expectedLegacyLocalMcpBinPath = path.resolve(process.cwd(), legacyMcpBin.path);
  assert.equal(stdioConfigBody.data.config.local_checkout.legacy_mcpServers[legacyMcpServerName].command, process.execPath);
  assert.deepEqual(
    stdioConfigBody.data.config.local_checkout.legacy_mcpServers[legacyMcpServerName].args,
    [expectedLegacyLocalMcpBinPath, '--profile', 'safe']
  );
  assert.equal(stdioConfigBody.data.config.local_checkout.boundary.config_file_written, false);
  assert.equal(stdioConfigBody.data.config.boundary.server_started, false);
  assert.equal(stdioConfigBody.data.config.boundary.token_values_emitted, false);
  assert.equal(stdioConfigBody.data.config.boundary.cleanup_execution, false);
  assert.equal(stdioConfigBody.data.config.boundary.provider_api_execution, false);

  const mcpCapabilitiesParsed = parseCliArgs(['mcp', 'capabilities', '--profile', 'admin', '--scope', 'excluded', '--json']);
  assert.equal(mcpCapabilitiesParsed.ok, true);
  assert.equal(mcpCapabilitiesParsed.command, 'mcp capabilities');
  assert.equal(mcpCapabilitiesParsed.options.profile, 'admin');
  assert.equal(mcpCapabilitiesParsed.options.scope, 'excluded');

  const mcpCapabilities = await executeCli(['mcp', 'capabilities', '--profile', 'admin', '--scope', 'excluded', '--json'], { now: fixedNow });
  assert.equal(mcpCapabilities.exitCode, 0);
  const mcpCapabilitiesBody = JSON.parse(mcpCapabilities.stdout);
  const excludedOperationIds = mcpCapabilitiesBody.data.capabilities.excluded_operations.map((operation) => operation.id);
  assert.equal(mcpCapabilitiesBody.command, 'mcp capabilities');
  assert.equal(mcpCapabilitiesBody.data.capabilities.scope, 'excluded');
  assert.equal(mcpCapabilitiesBody.data.capabilities.profiles.length, 0);
  assert.equal(mcpCapabilitiesBody.data.capabilities.transports.length, 0);
  assert.equal(mcpCapabilitiesBody.data.capabilities.admin_policy.currently_equivalent_to_full, true);
  assert.equal(mcpCapabilitiesBody.data.capabilities.admin_policy.write_execute_tools_exposed, false);
  assert.equal(mcpCapabilitiesBody.data.capabilities.admin_policy.cleanup_execution_exposed, false);
  assert.equal(mcpCapabilitiesBody.data.capabilities.admin_policy.agent_execution_run_exposed, false);
  assert.equal(mcpCapabilitiesBody.data.capabilities.admin_policy.provider_api_execution_exposed, false);
  assert.equal(mcpCapabilitiesBody.data.capabilities.admin_policy.shell_tools_exposed, false);
  assert.equal(mcpCapabilitiesBody.data.capabilities.boundaries.cleanup_execution, false);
  assert.equal(mcpCapabilitiesBody.data.capabilities.boundaries.agent_execution_run, false);
  assert.equal(mcpCapabilitiesBody.data.capabilities.boundaries.provider_api_execution, false);
  assert.equal(mcpCapabilitiesBody.data.capabilities.boundaries.arbitrary_shell, false);
  assert.equal(mcpCapabilitiesBody.data.capabilities.boundaries.http_full_or_admin, false);
  assert.deepEqual(mcpCapabilitiesBody.data.capabilities.excluded_operations.map((operation) => operation.mcp_admin), excludedOperationIds.map(() => false));
  assert.ok(excludedOperationIds.includes('agent_execution_run'));
  assert.ok(excludedOperationIds.includes('visual_provider_execution'));
  assert.ok(excludedOperationIds.includes('visual_review_run'));
  assert.ok(excludedOperationIds.includes('visual_review_result_preparation'));
  assert.ok(excludedOperationIds.includes('visual_review_aggregation'));
  assert.equal(mcpCapabilitiesBody.data.capabilities.admin_policy.visual_review_run_exposed, false);
  assert.equal(mcpCapabilitiesBody.data.capabilities.admin_policy.visual_review_result_preparation_exposed, false);
  assert.equal(mcpCapabilitiesBody.data.capabilities.admin_policy.visual_review_aggregation_exposed, false);
  assert.equal(mcpCapabilitiesBody.data.capabilities.boundaries.visual_review_run, false);
  assert.equal(mcpCapabilitiesBody.data.capabilities.boundaries.visual_review_result_preparation, false);
  assert.equal(mcpCapabilitiesBody.data.capabilities.boundaries.visual_review_aggregation, false);
  assert.equal(mcpCapabilitiesBody.data.capabilities.boundaries.raw_image_transfer, false);
  assert.ok(excludedOperationIds.includes('resource_artifacts_cleanup_execute'));
  assert.ok(excludedOperationIds.includes('provider_api_execution'));
  assert.ok(excludedOperationIds.includes('arbitrary_shell'));
  assert.ok(excludedOperationIds.includes('http_full_admin_socket_remote'));

  const safeProfileCapabilities = await executeCli(['mcp', 'capabilities', '--profile', 'safe', '--scope', 'profiles', '--json'], { now: fixedNow });
  assert.equal(safeProfileCapabilities.exitCode, 0);
  const safeProfileCapabilitiesBody = JSON.parse(safeProfileCapabilities.stdout);
  assert.deepEqual(safeProfileCapabilitiesBody.data.capabilities.profiles.map((profile) => profile.name), ['safe']);
  assert.equal(safeProfileCapabilitiesBody.data.capabilities.excluded_operations.length, 0);
  assert.equal(safeProfileCapabilitiesBody.data.capabilities.profiles[0].tools.some((tool) => tool.name === 'browser_debug_mcp_capabilities'), true);
  assert.equal(safeProfileCapabilitiesBody.data.capabilities.profiles[0].tools.some((tool) => tool.name === 'browser_debug_review'), false);

  const invalidCapabilities = await executeCli(['mcp', 'capabilities', '--scope', 'wide-open', '--json'], { now: fixedNow });
  assert.equal(invalidCapabilities.exitCode, 1);
  assert.equal(JSON.parse(invalidCapabilities.stdout).errors[0].code, 'INVALID_MCP_CAPABILITY_SCOPE');

  const httpInfoParsed = parseCliArgs([
    'mcp',
    'serve',
    '--transport',
    'http',
    '--profile',
    'safe',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--token-env',
    'TRACE_CUE_MCP_HTTP_TOKEN',
    '--json'
  ]);
  assert.equal(httpInfoParsed.ok, true);
  assert.equal(httpInfoParsed.options.transport, 'http');
  assert.equal(httpInfoParsed.options.profile, 'safe');

  const httpInfo = await executeCli([
    'mcp',
    'serve',
    '--transport',
    'http',
    '--profile',
    'safe',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--json'
  ], { now: fixedNow });
  assert.equal(httpInfo.exitCode, 0);
  const httpInfoBody = JSON.parse(httpInfo.stdout);
  assert.equal(httpInfoBody.data.adapter.transport, 'http');
  assert.equal(httpInfoBody.data.adapter.profile.name, 'safe');
  assert.equal(httpInfoBody.data.adapter.auth_required, true);
  assert.equal(httpInfoBody.data.adapter.token_env, 'TRACE_CUE_MCP_HTTP_TOKEN');
  assert.equal(httpInfoBody.data.adapter.external_channel, false);

  const mcpHttpTokenEnv = 'TRACE_CUE_MCP_HTTP_TOKEN';
  const httpConfig = await executeCli([
    'mcp',
    'config',
    '--transport',
    'http',
    '--profile',
    'safe',
    '--host',
    '127.0.0.1',
    '--port',
    '8765',
    '--token-env',
    'TRACE_CUE_MCP_HTTP_TOKEN',
    '--json'
  ], { now: fixedNow, env: { [mcpHttpTokenEnv]: 'redaction-sentinel-value' } });
  assert.equal(httpConfig.exitCode, 0);
  const httpConfigBody = JSON.parse(httpConfig.stdout);
  assert.equal(httpConfigBody.data.config.transport, 'http');
  assert.equal(httpConfigBody.data.config.profile.name, 'safe');
  assert.equal(httpConfigBody.data.config.client_connection.url, 'http://127.0.0.1:8765/mcp');
  assert.equal(httpConfigBody.data.config.client_connection.protocol_version, '2025-06-18');
  assert.equal(httpConfigBody.data.config.launch.env[mcpHttpTokenEnv], '<set-16-or-more-character-token>');
  assert.equal(httpConfigBody.data.config.local_checkout.launch.command, process.execPath);
  assert.deepEqual(httpConfigBody.data.config.local_checkout.launch.args, [
    expectedLocalMcpBinPath,
    '--transport',
    'http',
    '--profile',
    'safe',
    '--host',
    '127.0.0.1',
    '--port',
    '8765',
    '--endpoint',
    '/mcp',
    '--token-env',
    'TRACE_CUE_MCP_HTTP_TOKEN'
  ]);
  assert.equal(httpConfigBody.data.config.local_checkout.launch.env[mcpHttpTokenEnv], '<set-16-or-more-character-token>');
  assert.equal(httpConfigBody.data.config.local_checkout.client_connection.url, 'http://127.0.0.1:8765/mcp');
  assert.equal(httpConfigBody.data.config.local_checkout.boundary.server_started, false);
  assert.equal(httpConfigBody.data.config.metadata.token_env, 'TRACE_CUE_MCP_HTTP_TOKEN');
  assert.deepEqual(httpConfigBody.data.config.metadata.legacy_token_envs, ['BROWSER_DEBUG_MCP_HTTP_TOKEN']);
  assert.equal(httpConfigBody.data.config.legacy_launches[0].command, legacyMcpBin.name);
  assert.equal(httpConfigBody.data.config.local_checkout.legacy_launches[0].bin_path, expectedLegacyLocalMcpBinPath);
  assert.equal(httpConfigBody.data.config.boundary.token_values_emitted, false);
  assert.equal(httpConfigBody.data.config.boundary.server_started, false);
  assert.equal(httpConfigBody.data.config.boundary.http_full_or_admin, false);
  assert.equal(JSON.stringify(httpConfigBody).includes('redaction-sentinel-value'), false);

  const httpConfigDefaultPort = await executeCli(['mcp', 'config', '--transport', 'http', '--json'], { now: fixedNow });
  assert.equal(httpConfigDefaultPort.exitCode, 0);
  assert.equal(JSON.parse(httpConfigDefaultPort.stdout).data.config.client_connection.url, 'http://127.0.0.1:8765/mcp');

  const httpFullConfig = await executeCli(['mcp', 'config', '--transport', 'http', '--profile', 'full', '--json'], { now: fixedNow });
  assert.equal(httpFullConfig.exitCode, 1);
  assert.equal(JSON.parse(httpFullConfig.stdout).errors[0].code, 'HTTP_MCP_PROFILE_REJECTED');

  const httpFullInfo = await executeCli(['mcp', 'serve', '--transport', 'http', '--profile', 'full', '--json'], { now: fixedNow });
  assert.equal(httpFullInfo.exitCode, 1);
  assert.equal(JSON.parse(httpFullInfo.stdout).errors[0].code, 'HTTP_MCP_PROFILE_REJECTED');

  const invalidMcpInfo = await executeCli(['mcp', 'serve', '--profile', 'wide-open', '--json'], { now: fixedNow });
  assert.equal(invalidMcpInfo.exitCode, 1);
  assert.equal(JSON.parse(invalidMcpInfo.stdout).errors[0].code, 'INVALID_MCP_PROFILE');

  const schema = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'browser_debug_schema_get',
      arguments: { name: 'envelope' }
    }
  }, { now: fixedNow });
  assert.equal(schema.result.structuredContent.command, 'schema get');
  assert.equal(schema.result.structuredContent.status, 'ok');

  const resource = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'browser_debug_resource_status',
      arguments: {}
    }
  }, { now: fixedNow, ...createResourceStatusContext() });
  assert.equal(resource.result.structuredContent.command, 'resource status');
  assert.equal(resource.result.structuredContent.status, 'ok');
  assert.equal(resource.result.structuredContent.data.boundary.browser_launched, false);
  assert.equal(resource.result.structuredContent.data.boundary.system_cache_mutated, false);

  const artifactCwd = await mkdtemp(path.join(tmpdir(), 'browser-debug-mcp-artifacts-'));
  const artifactPlan = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'browser_debug_resource_artifacts_plan',
      arguments: { maxBytes: '1mib' }
    }
  }, { cwd: artifactCwd, now: fixedNow });
  assert.equal(artifactPlan.result.structuredContent.command, 'resource artifacts plan');
  assert.equal(artifactPlan.result.structuredContent.data.boundary.cache_deleted, false);

  const capabilityPolicy = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'browser_debug_mcp_capabilities',
      arguments: { profile: 'admin', scope: 'excluded' }
    }
  }, { mcpProfile: 'safe', now: fixedNow });
  assert.equal(capabilityPolicy.result.structuredContent.command, 'mcp capabilities');
  assert.equal(capabilityPolicy.result.structuredContent.status, 'ok');
  assert.equal(capabilityPolicy.result.structuredContent.data.capabilities.admin_policy.write_execute_tools_exposed, false);
  assert.equal(capabilityPolicy.result.structuredContent.data.capabilities.excluded_operations.some((operation) => operation.id === 'agent_execution_run'), true);
  assert.equal(capabilityPolicy.result.structuredContent.data.capabilities.excluded_operations.every((operation) => operation.mcp_admin === false), true);

  const cwd = await mkdtemp(path.join(tmpdir(), 'browser-debug-mcp-target-'));
  await writeFile(path.join(cwd, '.gitignore'), '.browser-debug/\n', 'utf8');
  const target = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'browser_debug_target_init',
      arguments: { url: 'https://example.test/app', maxRoutes: 4 }
    }
  }, { cwd, now: fixedNow, createId: () => 'target-mcp' });
  assert.equal(target.result.structuredContent.command, 'target init');
  assert.equal(target.result.structuredContent.data.target_manifest.budgets.maxRoutes, 4);

  const targetArtifact = target.result.structuredContent.artifacts.find((artifact) => artifact.type === 'target_manifest');
  const validated = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'browser_debug_target_validate',
      arguments: { target: targetArtifact.path }
    }
  }, { cwd, now: fixedNow });
  assert.equal(validated.result.structuredContent.command, 'target validate');
  assert.equal(validated.result.structuredContent.data.target_manifest.status, 'valid');
  assert.equal(validated.result.structuredContent.data.boundary.browser_launched, false);

  const confinedRoot = await mkdtemp(path.join(tmpdir(), 'browser-debug-mcp-confine-'));
  const workspace = path.join(confinedRoot, 'workspace');
  await mkdir(workspace);
  await writeFile(path.join(workspace, '.gitignore'), '.browser-debug/\n', 'utf8');
  const manifest = {
    schema_version: '0.1.0',
    name: 'MCP confinement fixture',
    baseUrl: 'https://example.test/',
    scope: { sameOrigin: true, allowedHosts: ['example.test'] },
    seeds: ['/'],
    expectedRoutes: ['/'],
    viewportMatrix: [{ name: 'desktop', width: 1280, height: 720 }],
    actionPolicy: { click: 'navigation_only', forms: 'skip', destructive: 'skip', external: 'skip' },
    budgets: { maxRoutes: 1, maxActionsPerRoute: 0 },
    artifacts: { screenshot: false, trace: false, report: false },
    masks: [],
    regions: [],
    pages: [],
    localContentUxAdvisory: { enabled: false }
  };
  await writeFile(path.join(workspace, 'target.json'), JSON.stringify(manifest), 'utf8');
  const outsideManifest = path.join(confinedRoot, 'outside-target.json');
  await writeFile(outsideManifest, JSON.stringify(manifest), 'utf8');
  await symlink(outsideManifest, path.join(workspace, 'linked-target.json'));

  const safeValidated = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 15,
    method: 'tools/call',
    params: {
      name: 'browser_debug_target_validate',
      arguments: { target: 'target.json' }
    }
  }, { cwd: workspace, mcpProfile: 'safe', now: fixedNow });
  assert.equal(safeValidated.result.structuredContent.status, 'ok');

  const traversalBlocked = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 16,
    method: 'tools/call',
    params: {
      name: 'browser_debug_target_validate',
      arguments: { target: '../outside-target.json' }
    }
  }, { cwd: workspace, mcpProfile: 'safe', now: fixedNow });
  assert.equal(traversalBlocked.result.isError, true);
  assert.equal(traversalBlocked.result.structuredContent.errors[0].code, 'INPUT_FILE_OUTSIDE_WORKSPACE');

  const symlinkBlocked = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 17,
    method: 'tools/call',
    params: {
      name: 'browser_debug_target_validate',
      arguments: { target: 'linked-target.json' }
    }
  }, { cwd: workspace, mcpProfile: 'safe', now: fixedNow });
  assert.equal(symlinkBlocked.result.isError, true);
  assert.equal(symlinkBlocked.result.structuredContent.errors[0].code, 'INPUT_FILE_OUTSIDE_WORKSPACE');
});

test('HTTP MCP transport is loopback, token-gated, and safe-profile only', async () => {
  const token = '0123456789abcdef';
  const mcpHttpTokenEnv = 'TRACE_CUE_MCP_HTTP_TOKEN';
  const cwd = await mkdtemp(path.join(tmpdir(), 'browser-debug-http-mcp-'));
  await writeFile(path.join(cwd, '.gitignore'), '.browser-debug/\n', 'utf8');

  const started = await startMcpHttpServer({ port: 0 }, {
    cwd,
    now: fixedNow,
    env: { [mcpHttpTokenEnv]: token }
  });
  try {
    assert.equal(started.metadata.profile, 'safe');
    assert.equal(started.metadata.auth_required, true);
    assert.equal(started.metadata.external_channel, false);

    const listed = await fetch(started.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Origin: 'http://127.0.0.1'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    const toolNames = listedBody.result.tools.map((tool) => tool.name);
    assert.equal(listedBody.result.profile.name, 'safe');
    assert.equal(toolNames.includes('browser_debug_resource_status'), true);
    assert.equal(toolNames.includes('browser_debug_agent_execution_list'), true);
    assert.equal(toolNames.includes('browser_debug_review'), false);
    assert.equal(toolNames.includes('browser_debug_observe'), false);

    const missingAuth = await fetch(started.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    });
    assert.equal(missingAuth.status, 401);
    assert.doesNotMatch(await missingAuth.text(), new RegExp(token));

    const invalidOrigin = await fetch(started.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Origin: 'https://example.invalid'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    });
    assert.equal(invalidOrigin.status, 403);

    const getResponse = await fetch(started.url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(getResponse.status, 405);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }

  await assert.rejects(
    startMcpHttpServer({ profile: 'full', port: 0 }, {
      env: { [mcpHttpTokenEnv]: token }
    }),
    /safe profile/
  );
  await assert.rejects(
    startMcpHttpServer({ host: '0.0.0.0', port: 0 }, {
      env: { [mcpHttpTokenEnv]: token }
    }),
    /loopback host/
  );

  const limited = await startMcpHttpServer({ port: 0, bodyLimit: 32 }, {
    env: { [mcpHttpTokenEnv]: token }
  });
  try {
    const oversized = await fetch(limited.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', padding: 'x'.repeat(64) })
    });
    assert.equal(oversized.status, 413);
  } finally {
    await new Promise((resolve) => limited.server.close(resolve));
  }
});

test('daemon commands parse and return deterministic JSON envelopes', async () => {
  const started = await executeCli(
    ['daemon', 'start', '--url', 'https://example.test/', '--idle-timeout', '30s', '--max-lifetime', '2h', '--json'],
    {
      now: fixedNow,
      daemonStartRunner: async (options) => ({
        status: 'ok',
        data: {
          daemon: {
            id: 'daemon-fixed',
            status: 'running',
            current_url: options.url,
            browser: {
              ephemeral_context: true,
              existing_profile_reused: false,
              persistent_storage: false
            },
            lifecycle: {
              idle_timeout_ms: options['idle-timeout'],
              max_lifetime_ms: options['max-lifetime']
            }
          }
        },
        warnings: [],
        errors: [],
        artifacts: [{ type: 'daemon', path: '.browser-debug/daemons/daemon-fixed.json' }]
      })
    }
  );
  assert.equal(started.exitCode, 0);
  const startedBody = JSON.parse(started.stdout);
  assert.equal(startedBody.command, 'daemon start');
  assert.equal(startedBody.data.daemon.id, 'daemon-fixed');
  assert.equal(startedBody.data.daemon.browser.existing_profile_reused, false);
  assert.equal(startedBody.data.daemon.lifecycle.idle_timeout_ms, '30s');

  const statusParsed = parseCliArgs(['daemon', 'status', '--daemon', 'daemon-fixed', '--json']);
  assert.equal(statusParsed.ok, true);
  assert.equal(statusParsed.command, 'daemon status');
  assert.equal(statusParsed.options.daemon, 'daemon-fixed');

  const stopped = await executeCli(
    ['daemon', 'stop', '--daemon', 'daemon-fixed', '--json'],
    {
      now: fixedNow,
      daemonStopRunner: async (options) => ({
        status: 'ok',
        data: {
          daemon: {
            id: options.daemon,
            status: 'stopped',
            process_status: 'not_alive'
          }
        },
        warnings: [],
        errors: [],
        artifacts: [{ type: 'daemon', path: `.browser-debug/daemons/${options.daemon}.json` }]
      })
    }
  );
  assert.equal(stopped.exitCode, 0);
  assert.equal(JSON.parse(stopped.stdout).data.daemon.status, 'stopped');
});

test('session start, act, report, and spec export use local artifacts', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), `${filesystemSafeName(PRODUCT_IDENTITY.packageName)}-session-`));
  await writeFile(path.join(cwd, '.gitignore'), '.browser-debug/\n', 'utf8');

  const context = {
    cwd,
    now: fixedNow,
    createId: (prefix) => `${prefix}-fixed`,
    observeRunner: async (options) => ({
      status: 'ok',
      data: {
        id: 'observation-fixed',
        input_url: options.url,
        final_url: options.url,
        title: 'Session Fixture',
        page: { action_candidates: [] }
      },
      warnings: [],
      errors: [],
      artifacts: [{ type: 'observation', path: '.browser-debug/observations/observation-fixed.json' }]
    })
  };

  const started = await executeCli(
    ['session', 'start', '--url', 'https://example.test/', '--json'],
    context
  );
  assert.equal(started.exitCode, 0);
  const startedBody = JSON.parse(started.stdout);
  assert.equal(startedBody.data.session.id, 'session-fixed');
  assert.equal(startedBody.data.session.current_url, 'https://example.test/');

  const acted = await executeCli(
    ['act', '--session', 'session-fixed', '--action', '{"type":"navigate","url":"https://example.test/next"}', '--json'],
    context
  );
  assert.equal(acted.exitCode, 0);
  const actedBody = JSON.parse(acted.stdout);
  assert.equal(actedBody.data.action_result.type, 'navigate');
  assert.equal(actedBody.data.session.current_url, 'https://example.test/next');

  const actedFromInput = await executeCli(
    ['act', '--session', 'session-fixed', '--input', '-', '--json'],
    { ...context, stdinText: '{"type":"observe"}' }
  );
  assert.equal(actedFromInput.exitCode, 0);
  assert.equal(JSON.parse(actedFromInput.stdout).data.action_result.type, 'observe');

  const reported = await executeCli(['report', '--session', 'session-fixed', '--json'], context);
  assert.equal(reported.exitCode, 0);
  assert.equal(JSON.parse(reported.stdout).artifacts[0].type, 'report');

  const exported = await executeCli(['spec', 'export', '--session', 'session-fixed', '--json'], context);
  assert.equal(exported.exitCode, 0);
  assert.equal(JSON.parse(exported.stdout).artifacts[0].type, 'spec');

  const report = await readFile(path.join(cwd, '.browser-debug', 'reports', 'session-fixed.md'), 'utf8');
  assert.match(report, /TraceCue Report: session-fixed/);
});

test('redaction removes common secrets and sensitive query params', () => {
  assert.equal(
    redactUrl('https://example.test/path?token=abc123456789&ok=1'),
    'https://example.test/path?token=[REDACTED]&ok=1'
  );
  assert.deepEqual(redact({ password: 'secret-value', nested: 'Bearer abcdefghijklmnop' }), {
    password: '[REDACTED]',
    nested: 'Bearer [REDACTED]'
  });
});

test('headed and devtools observe modes set Playwright launch options', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'browser-debug-modes-'));
  await writeFile(path.join(cwd, '.gitignore'), '.browser-debug/\n', 'utf8');
  const launches = [];
  const browserType = createFakeBrowserType(launches);

  const headed = await runObserve(
    { url: 'file:///tmp/browser-debug-headed.html', headed: true },
    { cwd, now: fixedNow, createId: () => 'observation-headed', browserType }
  );
  assert.equal(headed.status, 'ok');
  assert.deepEqual(launches[0], { headless: false, devtools: false });
  assert.equal(headed.data.browser.headless, false);
  assert.equal(headed.data.browser.devtools, false);
  assert.equal(headed.data.browser.ephemeral_context, true);

  const devtools = await runObserve(
    { url: 'file:///tmp/browser-debug-devtools.html', devtools: true },
    { cwd, now: fixedNow, createId: () => 'observation-devtools', browserType }
  );
  assert.equal(devtools.status, 'ok');
  assert.deepEqual(launches[1], { headless: false, devtools: true });
  assert.equal(devtools.data.browser.headless, false);
  assert.equal(devtools.data.browser.devtools, true);

  const observation = JSON.parse(
    await readFile(path.join(cwd, '.browser-debug', 'observations', 'observation-devtools.json'), 'utf8')
  );
  assert.equal(observation.browser.devtools, true);
});

function createFakeBrowserType(launches) {
  return {
    async launch(options) {
      launches.push(options);
      return createFakeBrowser();
    }
  };
}

function criticalResourceStatus() {
  return {
    status: 'critical',
    source: 'fixture',
    recommended_action: 'pause_browser_work_and_replan',
    memory: {
      available_bytes: 16 * 1024 * 1024,
      available_ratio: 0.01,
      swap_used_bytes: 900 * 1024 * 1024,
      swap_used_ratio: 0.95
    },
    cgroup: {
      available: true,
      current_bytes: 950 * 1024 * 1024,
      limit_bytes: 1024 * 1024 * 1024,
      usage_ratio: 0.95
    },
    pressure: {
      available: false,
      some: null,
      full: null
    },
    boundary: {
      local_only: true,
      browser_launched: false,
      system_cache_mutated: false,
      swap_mutated: false,
      cache_deleted: false
    }
  };
}

function createResourceStatusContext() {
  const files = new Map([
    ['/proc/meminfo', [
      'MemTotal:       1048576 kB',
      'MemFree:         131072 kB',
      'MemAvailable:    262144 kB',
      'Buffers:          16384 kB',
      'Cached:           65536 kB',
      'SwapCached:           0 kB',
      'Active(file):      4096 kB',
      'Inactive(file):    8192 kB',
      'Dirty:                0 kB',
      'Writeback:            0 kB',
      'KReclaimable:      8192 kB',
      'SReclaimable:      8192 kB',
      'SUnreclaim:        4096 kB',
      'SwapTotal:       524288 kB',
      'SwapFree:        393216 kB'
    ].join('\n')],
    ['/sys/fs/cgroup/memory.max', `${1024 * 1024 * 1024}\n`],
    ['/sys/fs/cgroup/memory.current', `${512 * 1024 * 1024}\n`],
    ['/sys/fs/cgroup/memory.swap.max', `${512 * 1024 * 1024}\n`],
    ['/sys/fs/cgroup/memory.swap.current', `${128 * 1024 * 1024}\n`],
    ['/proc/pressure/memory', [
      'some avg10=0.00 avg60=0.00 avg300=0.00 total=0',
      'full avg10=0.00 avg60=0.00 avg300=0.00 total=0'
    ].join('\n')]
  ]);
  return {
    readTextFile: async (filePath) => {
      if (files.has(filePath)) {
        return files.get(filePath);
      }
      const error = new Error(`missing fixture: ${filePath}`);
      error.code = 'ENOENT';
      throw error;
    },
    os: {
      totalmem: () => 2 * 1024 * 1024 * 1024,
      freemem: () => 1024 * 1024 * 1024
    },
    memoryUsage: () => ({
      rss: 64 * 1024 * 1024,
      heapTotal: 16 * 1024 * 1024,
      heapUsed: 8 * 1024 * 1024,
      external: 2 * 1024 * 1024,
      arrayBuffers: 1024 * 1024
    })
  };
}

function createFakeBrowser() {
  return {
    async newContext() {
      return {
        tracing: {
          async start() {},
          async stop() {}
        },
        async newPage() {
          return createFakePage();
        },
        async close() {}
      };
    },
    async close() {}
  };
}

function minimalPngBuffer(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function createFakePage() {
  let currentUrl = 'about:blank';
  return {
    on() {},
    async goto(url) {
      currentUrl = url;
      return {
        status: () => 200,
        ok: () => true,
        url: () => url
      };
    },
    async waitForLoadState() {},
    async evaluate() {
      return {
        url: currentUrl,
        title: 'Mode Fixture',
        ready_state: 'complete',
        language: 'en',
        viewport: { width: 1280, height: 720 },
        visible_text: 'Mode Fixture',
        headings: [],
        action_candidates: [],
        forms: []
      };
    },
    url() {
      return currentUrl;
    },
    async screenshot() {
      return minimalPngBuffer(1280, 720);
    }
  };
}
