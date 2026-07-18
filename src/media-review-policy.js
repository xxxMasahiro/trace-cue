import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MEDIA_REVIEW_POLICY_SCHEMA_VERSION = '1.0.0';
export const MEDIA_REVIEW_POLICY_RELATIVE = 'ops/MEDIA_REVIEW_POLICY.json';
export const MEDIA_REVIEW_ADAPTER_CATALOG_RELATIVE = 'ops/MEDIA_REVIEW_PROVIDER_ADAPTERS.json';

const moduleRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
let cachedPolicy;
let cachedCatalog;

export async function loadMediaReviewPolicy(context = {}) {
  if (context.mediaReviewPolicy) return validatePolicy(normalizePolicyDefaults(structuredClone(context.mediaReviewPolicy)));
  if (!cachedPolicy || context.disableMediaReviewPolicyCache) {
    const root = path.resolve(context.packageRoot ?? moduleRoot);
    cachedPolicy = validatePolicy(normalizePolicyDefaults(await readJson(path.join(root, MEDIA_REVIEW_POLICY_RELATIVE), 'MEDIA_REVIEW_POLICY_INVALID')));
  }
  return structuredClone(cachedPolicy);
}

export async function loadMediaReviewAdapterCatalog(policy, context = {}) {
  if (context.mediaReviewAdapterCatalog) return validateCatalog(normalizeCatalogDefaults(structuredClone(context.mediaReviewAdapterCatalog)));
  if (!cachedCatalog || context.disableMediaReviewPolicyCache) {
    const root = path.resolve(context.packageRoot ?? moduleRoot);
    const relative = policy?.transcript_provider?.adapter_catalog_relative ?? MEDIA_REVIEW_ADAPTER_CATALOG_RELATIVE;
    if (!isSafeRelativePolicyPath(relative)) throw mediaPolicyError('MEDIA_REVIEW_ADAPTER_CATALOG_PATH_INVALID', 'The adapter catalog path is invalid.');
    cachedCatalog = validateCatalog(normalizeCatalogDefaults(await readJson(path.join(root, relative), 'MEDIA_REVIEW_ADAPTER_CATALOG_INVALID')));
  }
  return structuredClone(cachedCatalog);
}

export function resolveMediaReviewAdapter(catalog, contract) {
  const matches = catalog.adapters.filter((entry) => entry.adapter_contract === contract);
  if (matches.length !== 1) throw mediaPolicyError('MEDIA_REVIEW_ADAPTER_CONTRACT_UNAVAILABLE', 'The configured transcript adapter is not available.');
  return structuredClone(matches[0]);
}

export function mediaReviewBoundary(policy) {
  return structuredClone(policy.public_boundary);
}

function validatePolicy(policy) {
  if (!isRecord(policy)
    || policy.schema_version !== MEDIA_REVIEW_POLICY_SCHEMA_VERSION
    || !/^1\.[0-9]+\.[0-9]+$/u.test(policy.policy_version ?? '')
    || policy.mode !== 'local_first'
    || !isRecord(policy.source)
    || !isRecord(policy.retention)
    || !isRecord(policy.operation)
    || !isRecord(policy.transcript_provider)
    || !isRecord(policy.prepared_audio)
    || !isRecord(policy.technical_analyzer)
    || !isRecord(policy.reviewer)
    || !isRecord(policy.public_boundary)) {
    throw mediaPolicyError('MEDIA_REVIEW_POLICY_INVALID', 'The media review policy is invalid.');
  }
  const retentionModes = policy.retention.allowed_modes;
  if (!Array.isArray(retentionModes)
    || retentionModes.length !== 2
    || !retentionModes.includes('ephemeral')
    || !retentionModes.includes('project-retained')
    || policy.retention.default_mode !== 'ephemeral') {
    throw mediaPolicyError('MEDIA_REVIEW_RETENTION_POLICY_INVALID', 'The media retention policy is invalid.');
  }
  if (policy.source.url_classification_network_enabled !== false
    || policy.source.url_acquisition_enabled !== false
    || policy.source.reject_ip_literal_urls !== true
    || !Array.isArray(policy.source.blocked_hostname_suffixes)
    || policy.source.blocked_hostname_suffixes.length === 0
    || !validOfficialPlayerRules(policy.source.official_player_rules)
    || policy.source.blocked_hostname_suffixes.some((value) => typeof value !== 'string' || !/^\.[a-z0-9.-]+$/u.test(value))
    || policy.public_boundary.external_send_enabled !== false
    || policy.public_boundary.cloud_asr_enabled !== false
    || policy.public_boundary.mcp_execution_enabled !== false
    || policy.public_boundary.full_transcript_included !== false
    || policy.public_boundary.raw_media_included !== false
    || policy.public_boundary.raw_audio_included !== false
    || policy.public_boundary.raw_frames_included !== false
    || policy.public_boundary.raw_process_output_included !== false
    || policy.public_boundary.absolute_paths_included !== false
    || policy.public_boundary.url_query_or_fragment_included !== false) {
    throw mediaPolicyError('MEDIA_REVIEW_SAFETY_POLICY_INVALID', 'The media review policy weakens a required safety boundary.');
  }
  if (!uniqueStringArray(policy.source.allowed_url_schemes, /^https:$/u)
    || policy.source.allowed_url_schemes.length !== 1
    || !uniqueStringArray(policy.source.blocked_hostname_suffixes, /^\.[a-z0-9.-]+$/u)
    || !uniqueStringArray(policy.source.allowed_local_extensions, /^\.[a-z0-9]{1,8}$/u)
    || policy.source.allowed_local_extensions.length === 0
    || !isSafeRelativePolicyPath(policy.transcript_provider.adapter_catalog_relative)
    || !isSafeRelativePolicyPath(policy.transcript_provider.local_profile_relative)
    || !/^[A-Z_][A-Z0-9_]{2,100}$/u.test(policy.transcript_provider.local_profile_environment ?? '')
    || !/^[a-z0-9][a-z0-9._-]{2,159}$/u.test(policy.prepared_audio.preparation_method ?? '')
    || !trustedToolCandidates(policy.technical_analyzer.probe_candidates, 'ffprobe')
    || !trustedToolCandidates(policy.technical_analyzer.analyzer_candidates, 'ffmpeg')
    || !/^[A-Z_][A-Z0-9_]{2,100}$/u.test(policy.technical_analyzer.probe_executable_environment ?? '')
    || !/^[A-Z_][A-Z0-9_]{2,100}$/u.test(policy.technical_analyzer.analyzer_executable_environment ?? '')) {
    throw mediaPolicyError('MEDIA_REVIEW_POLICY_VALUE_INVALID', 'The media review policy contains an invalid allowlist or trusted path setting.');
  }
  if (policy.retention.private_directory_mode !== '0700'
    || policy.retention.private_file_mode !== '0600'
    || policy.retention.full_transcript_outside_private_root_allowed !== false
    || policy.retention.raw_media_outside_private_root_allowed !== false) {
    throw mediaPolicyError('MEDIA_REVIEW_RETENTION_POLICY_INVALID', 'The media retention policy weakens private storage.');
  }
  for (const [name, value] of Object.entries({
    maximum_url_characters: policy.source.maximum_url_characters,
    maximum_local_media_bytes: policy.source.maximum_local_media_bytes,
    maximum_media_duration_us: policy.source.maximum_media_duration_us,
    upload_timeout_ms: policy.source.upload_timeout_ms,
    ephemeral_ttl_ms: policy.retention.ephemeral_ttl_ms,
    project_retained_ttl_ms: policy.retention.project_retained_ttl_ms,
    maximum_active_operations: policy.operation.maximum_active_operations,
    maximum_history_operations: policy.operation.maximum_history_operations,
    maximum_private_tree_entries: policy.operation.maximum_private_tree_entries,
    maximum_private_tree_bytes: policy.operation.maximum_private_tree_bytes,
    maximum_private_tree_depth: policy.operation.maximum_private_tree_depth,
    maximum_findings: policy.operation.maximum_findings,
    maximum_timeline_items: policy.operation.maximum_timeline_items,
    maximum_public_excerpt_characters: policy.operation.maximum_public_excerpt_characters,
    maximum_public_result_bytes: policy.operation.maximum_public_result_bytes,
    cleanup_retry_delay_ms: policy.operation.cleanup_retry_delay_ms,
    maximum_transcript_bytes: policy.transcript_provider.maximum_transcript_bytes,
    maximum_segments: policy.transcript_provider.maximum_segments,
    maximum_line_bytes: policy.transcript_provider.maximum_line_bytes,
    maximum_timeline_overrun_us: policy.transcript_provider.maximum_timeline_overrun_us,
    readiness_timeout_ms: policy.transcript_provider.readiness_timeout_ms,
    stage_timeout_ms: policy.transcript_provider.stage_timeout_ms,
    execution_timeout_ms: policy.transcript_provider.execution_timeout_ms,
    provider_maximum_stdout_bytes: policy.transcript_provider.maximum_stdout_bytes,
    provider_maximum_stderr_bytes: policy.transcript_provider.maximum_stderr_bytes,
    maximum_prepared_audio_bytes: policy.prepared_audio.maximum_prepared_audio_bytes,
    maximum_preparation_manifest_bytes: policy.prepared_audio.maximum_manifest_bytes,
    prepared_audio_copy_chunk_bytes: policy.prepared_audio.copy_chunk_bytes,
    maximum_frames: policy.technical_analyzer.maximum_frames,
    maximum_subtitle_events: policy.technical_analyzer.maximum_subtitle_events,
    maximum_total_streams: policy.technical_analyzer.maximum_total_streams,
    maximum_video_streams: policy.technical_analyzer.maximum_video_streams,
    maximum_audio_streams: policy.technical_analyzer.maximum_audio_streams,
    maximum_subtitle_streams: policy.technical_analyzer.maximum_subtitle_streams,
    maximum_video_width: policy.technical_analyzer.maximum_video_width,
    maximum_video_height: policy.technical_analyzer.maximum_video_height,
    maximum_video_pixels: policy.technical_analyzer.maximum_video_pixels,
    maximum_audio_sample_rate: policy.technical_analyzer.maximum_audio_sample_rate,
    maximum_audio_channels: policy.technical_analyzer.maximum_audio_channels,
    decoded_timeline_probe_packets: policy.technical_analyzer.decoded_timeline_probe_packets,
    decoder_threads: policy.technical_analyzer.decoder_threads,
    maximum_single_allocation_bytes: policy.technical_analyzer.maximum_single_allocation_bytes,
    analyzer_timeout_ms: policy.technical_analyzer.timeout_ms,
    analyzer_maximum_stdout_bytes: policy.technical_analyzer.maximum_stdout_bytes,
    analyzer_maximum_stderr_bytes: policy.technical_analyzer.maximum_stderr_bytes,
    duplicate_hash_window: policy.technical_analyzer.duplicate_hash_window,
    av_sync_warning_us: policy.technical_analyzer.av_sync_warning_us,
    subtitle_minimum_us: policy.technical_analyzer.subtitle_minimum_us,
    speech_cut_edge_margin_us: policy.reviewer.speech_cut_edge_margin_us,
    topic_change_visual_window_us: policy.reviewer.topic_change_visual_window_us,
    long_pause_warning_us: policy.reviewer.long_pause_warning_us,
    long_pause_high_us: policy.reviewer.long_pause_high_us,
    event_aggregation_gap_us: policy.reviewer.event_aggregation_gap_us,
    maximum_content_units: policy.reviewer.maximum_content_units,
    maximum_content_excerpt_characters: policy.reviewer.maximum_content_excerpt_characters,
    maximum_single_excerpt_characters: policy.reviewer.maximum_single_excerpt_characters,
    minimum_excerpt_characters: policy.reviewer.minimum_excerpt_characters,
    maximum_semantic_text_characters: policy.reviewer.maximum_semantic_text_characters
  })) assertPositiveInteger(value, name);
  for (const [name, value, minimum, maximum] of [
    ['cut_scene_threshold', policy.technical_analyzer.cut_scene_threshold, 0, 1],
    ['interval_jitter_warning_ratio', policy.technical_analyzer.interval_jitter_warning_ratio, 0, 10],
    ['topic_change_similarity_threshold', policy.reviewer.topic_change_similarity_threshold, 0, 1],
    ['repetition_similarity_threshold', policy.reviewer.repetition_similarity_threshold, 0, 1],
    ['speech_density_warning_words_per_second', policy.reviewer.speech_density_warning_words_per_second, Number.MIN_VALUE, 100],
    ['speech_density_high_words_per_second', policy.reviewer.speech_density_high_words_per_second, Number.MIN_VALUE, 100],
    ['excerpt_fraction_limit', policy.reviewer.excerpt_fraction_limit, Number.MIN_VALUE, 1],
    ['dropped_interval_multiplier', policy.technical_analyzer.dropped_interval_multiplier, 1, 100]
  ]) assertFiniteRange(value, minimum, maximum, name);
  if (policy.transcript_provider.maximum_line_bytes > policy.transcript_provider.maximum_transcript_bytes
    || policy.prepared_audio.maximum_manifest_bytes > policy.transcript_provider.maximum_transcript_bytes
    || policy.prepared_audio.maximum_prepared_audio_bytes > policy.operation.maximum_private_tree_bytes
    || policy.prepared_audio.copy_chunk_bytes > policy.prepared_audio.maximum_prepared_audio_bytes
    || policy.operation.maximum_public_excerpt_characters > policy.operation.maximum_public_result_bytes
    || policy.operation.maximum_active_operations > policy.operation.maximum_history_operations
    || policy.reviewer.long_pause_high_us < policy.reviewer.long_pause_warning_us
    || policy.reviewer.speech_density_high_words_per_second < policy.reviewer.speech_density_warning_words_per_second
    || policy.reviewer.maximum_single_excerpt_characters > policy.reviewer.maximum_content_excerpt_characters
    || policy.reviewer.minimum_excerpt_characters > policy.reviewer.maximum_single_excerpt_characters
    || policy.reviewer.maximum_single_excerpt_characters > policy.operation.maximum_public_excerpt_characters
    || policy.technical_analyzer.maximum_video_streams > policy.technical_analyzer.maximum_total_streams
    || policy.technical_analyzer.maximum_audio_streams > policy.technical_analyzer.maximum_total_streams
    || policy.technical_analyzer.maximum_subtitle_streams > policy.technical_analyzer.maximum_total_streams
    || policy.technical_analyzer.maximum_video_pixels > policy.technical_analyzer.maximum_video_width * policy.technical_analyzer.maximum_video_height
    || policy.technical_analyzer.dropped_interval_multiplier <= 1) {
    throw mediaPolicyError('MEDIA_REVIEW_POLICY_LIMIT_INVALID', 'Related media review limits are inconsistent.');
  }
  if (policy.technical_analyzer.maximum_total_streams > 256
    || policy.technical_analyzer.maximum_video_width > 16384
    || policy.technical_analyzer.maximum_video_height > 16384
    || policy.technical_analyzer.maximum_video_pixels > 134217728
    || policy.technical_analyzer.maximum_audio_sample_rate > 768000
    || policy.technical_analyzer.maximum_audio_channels > 64
    || policy.technical_analyzer.decoded_timeline_probe_packets > 4096
    || policy.technical_analyzer.decoder_threads > 16
    || policy.technical_analyzer.maximum_single_allocation_bytes > 1073741824) {
    throw mediaPolicyError('MEDIA_REVIEW_POLICY_LIMIT_INVALID', 'Technical media limits exceed supported safety ceilings.');
  }
  return Object.freeze(policy);
}

function normalizePolicyDefaults(policy) {
  if (!isRecord(policy)) return policy;
  const legacy = /^1\.0\.[0-9]+$/u.test(policy.policy_version ?? '');
  if (legacy && policy.prepared_audio === undefined) {
    policy.prepared_audio = {
      preparation_method: 'ffmpeg-pcm-s16le',
      maximum_prepared_audio_bytes: 33_554_432,
      maximum_manifest_bytes: 65_536,
      copy_chunk_bytes: 1_048_576
    };
  }
  if (legacy && isRecord(policy.technical_analyzer) && policy.technical_analyzer.decoded_timeline_probe_packets === undefined) {
    policy.technical_analyzer.decoded_timeline_probe_packets = 64;
  }
  return policy;
}

function normalizeCatalogDefaults(catalog) {
  if (!isRecord(catalog) || !Array.isArray(catalog.adapters)) return catalog;
  if (!/^1\.0\.[0-9]+$/u.test(catalog.catalog_version ?? '')) return catalog;
  for (const adapter of catalog.adapters) {
    if (isRecord(adapter) && adapter.input_mode === undefined) adapter.input_mode = 'source_media';
  }
  return catalog;
}

function validateCatalog(catalog) {
  if (!isRecord(catalog)
    || catalog.schema_version !== '1.0.0'
    || !/^1\.[0-9]+\.[0-9]+$/u.test(catalog.catalog_version ?? '')
    || !Array.isArray(catalog.adapters)
    || catalog.adapters.length === 0) {
    throw mediaPolicyError('MEDIA_REVIEW_ADAPTER_CATALOG_INVALID', 'The media review adapter catalog is invalid.');
  }
  const contracts = new Set();
  for (const adapter of catalog.adapters) {
    if (!isRecord(adapter)
      || typeof adapter.adapter_contract !== 'string'
      || !/^[a-z0-9][a-z0-9-]{2,80}$/u.test(adapter.adapter_contract)
      || adapter.runtime_kind !== 'node_git_checkout_cli'
      || contracts.has(adapter.adapter_contract)
      || !uniqueStringArray(adapter.allowed_environment_keys, /^[A-Z_][A-Z0-9_]{1,100}$/u)
      || !versionMajorArray(adapter.supported_result_schema_majors)
      || !versionMajorArray(adapter.supported_normalized_schema_majors)
      || !uniqueStringArray(adapter.production_mock_engines, /^[a-z0-9][a-z0-9-]{0,79}$/u)
      || !validAdapterWorkflow(adapter)
      || adapter.boundary?.shell_used !== false
      || adapter.boundary?.url_input_supported !== false
      || adapter.boundary?.runtime_setup_supported !== false
      || adapter.boundary?.model_download_supported !== false
      || adapter.boundary?.external_send_supported !== false
      || adapter.boundary?.mcp_execution_supported !== false) {
      throw mediaPolicyError('MEDIA_REVIEW_ADAPTER_CATALOG_INVALID', 'A media review adapter contract is invalid.');
    }
    contracts.add(adapter.adapter_contract);
  }
  return Object.freeze(catalog);
}

function validAdapterWorkflow(adapter) {
  if (adapter.input_mode === 'source_media') {
    return isRecord(adapter.commands)
      && exactKeys(adapter.commands, ['readiness', 'initialize', 'import_media', 'transcribe'])
      && isFixedTemplate(adapter.commands.readiness, [])
      && isFixedTemplate(adapter.commands.initialize, ['operation_name', 'operation_root'])
      && isFixedTemplate(adapter.commands.import_media, ['run', 'input', 'operation_root'])
      && isFixedTemplate(adapter.commands.transcribe, ['run', 'engine', 'operation_root'])
      && validLegacyReadiness(adapter.required_readiness)
      && adapter.prepared_audio_contract === undefined
      && adapter.result_resolution === undefined;
  }
  return adapter.input_mode === 'caller_prepared_audio'
    && isRecord(adapter.commands)
    && exactKeys(adapter.commands, ['readiness', 'initialize', 'register_prepared', 'transcribe'])
    && exactTemplate(adapter.commands.readiness, ['local-asr', 'readiness', '--input-kind', 'prepared', '--engine', '{engine}', '--json'])
    && exactTemplate(adapter.commands.initialize, ['init', '--name', '{operation_name}', '--external-artifact-root', '{operation_root}', '--external-artifact-root-confirm', 'use-external-artifact-root'])
    && exactTemplate(adapter.commands.register_prepared, ['audio', 'import-prepared', '--run', '{run}', '--input', '{prepared_audio}', '--preparation-manifest', '{preparation_manifest}', '--external-artifact-root', '{operation_root}', '--external-artifact-root-confirm', 'use-external-artifact-root', '--json'])
    && exactTemplate(adapter.commands.transcribe, ['local-asr', 'run', '--run', '{run}', '--input-kind', 'prepared', '--prepared-registration-id', '{registration_id}', '--engine', '{engine}', '--execute', '--execute-confirm', 'execute-local-asr', '--external-artifact-root', '{operation_root}', '--external-artifact-root-confirm', 'use-external-artifact-root', '--json'])
    && validPreparedReadiness(adapter.required_readiness)
    && validPreparedAudioContract(adapter.prepared_audio_contract)
    && validPreparedResultResolution(adapter.result_resolution);
}

function isFixedTemplate(value, allowedPlaceholders) {
  if (!(Array.isArray(value)
    && value.length > 0
    && value.length <= 64
    && value.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 512 && !entry.includes('\u0000')))) return false;
  const placeholders = value.flatMap((entry) => [...entry.matchAll(/\{([a-z_]+)\}/gu)].map((match) => match[1]));
  if (value.some((entry) => entry.replace(/\{[a-z_]+\}/gu, '').includes('{') || entry.replace(/\{[a-z_]+\}/gu, '').includes('}'))) return false;
  return placeholders.every((placeholder) => allowedPlaceholders.includes(placeholder));
}

function exactTemplate(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function versionMajorArray(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 16
    && new Set(value).size === value.length
    && value.every((entry) => Number.isSafeInteger(entry) && entry >= 1 && entry <= 1000);
}

function validLegacyReadiness(value) {
  return isRecord(value)
    && exactKeys(value, ['status', 'runtime_ready', 'model_resolvable_offline', 'external_network_calls_during_asr_enabled', 'cloud_asr_enabled', 'external_sending_enabled'])
    && value.status === 'ready'
    && value.runtime_ready === true
    && value.model_resolvable_offline === true
    && value.external_network_calls_during_asr_enabled === false
    && value.cloud_asr_enabled === false
    && value.external_sending_enabled === false;
}

function validPreparedReadiness(value) {
  return isRecord(value)
    && exactKeys(value, [
      'kind', 'status', 'input_kind', 'capability_supported', 'external_artifact_root_supported',
      'source_media_read_required', 'source_media_reprocessing_enabled', 'ffmpeg_conversion_required',
      'url_acquisition_enabled', 'yt_dlp_enabled', 'cloud_asr_enabled',
      'external_sending_enabled', 'model_auto_download_enabled', 'runtime_setup_execution_enabled',
      'provider_fallback_enabled', 'shell_execution_enabled', 'body_included', 'absolute_paths_included'
    ])
    && value.kind === 'framecue-prepared-audio-readiness'
    && value.status === 'ready'
    && value.input_kind === 'prepared'
    && value.capability_supported === true
    && value.external_artifact_root_supported === true
    && Object.entries(value).every(([key, entry]) => [
      'kind', 'status', 'input_kind', 'capability_supported', 'external_artifact_root_supported'
    ].includes(key) || entry === false);
}

function validPreparedAudioContract(value) {
  return isRecord(value)
    && exactKeys(value, ['schema_version', 'manifest_kind', 'registration_result_kind', 'provider_result_kind', 'format', 'rounding_rule'])
    && /^1\.[0-9]+\.[0-9]+$/u.test(value.schema_version ?? '')
    && /^[a-z0-9][a-z0-9-]{2,100}$/u.test(value.manifest_kind ?? '')
    && /^[a-z0-9][a-z0-9-]{2,100}$/u.test(value.registration_result_kind ?? '')
    && /^[a-z0-9][a-z0-9-]{2,100}$/u.test(value.provider_result_kind ?? '')
    && value.rounding_rule === 'nearest-half-away-from-zero'
    && isRecord(value.format)
    && exactKeys(value.format, ['container', 'codec', 'sample_rate_hz', 'channel_count', 'bits_per_sample', 'header_bytes'])
    && value.format.container === 'wav'
    && value.format.codec === 'pcm_s16le'
    && value.format.sample_rate_hz === 16_000
    && value.format.channel_count === 1
    && value.format.bits_per_sample === 16
    && value.format.header_bytes === 44;
}

function validPreparedResultResolution(value) {
  return isRecord(value)
    && exactKeys(value, [
      'contract_version', 'provider_receipt_kind', 'provider_receipt_directory', 'provider_receipt_file_name',
      'payload_directory', 'payload_file_name', 'payload_namespace', 'payload_media_type', 'receipt_identity'
    ])
    && /^1\.[0-9]+\.[0-9]+$/u.test(value.contract_version ?? '')
    && /^[a-z0-9][a-z0-9-]{2,100}$/u.test(value.provider_receipt_kind ?? '')
    && isSafeRelativePolicyPath(value.provider_receipt_directory)
    && /^[A-Za-z0-9._-]{1,80}$/u.test(value.provider_receipt_file_name ?? '')
    && isSafeRelativePolicyPath(value.payload_directory)
    && /^[A-Za-z0-9._-]{1,80}$/u.test(value.payload_file_name ?? '')
    && /^[a-z0-9][a-z0-9-]{2,80}$/u.test(value.payload_namespace ?? '')
    && value.payload_media_type === 'application/x-ndjson'
    && value.receipt_identity === 'stable-json-sha256';
}

function validOfficialPlayerRules(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return false;
  const ids = new Set();
  const hosts = new Set();
  for (const rule of value) {
    if (!isRecord(rule)
      || !/^[a-z0-9][a-z0-9-]{2,80}$/u.test(rule.rule_id ?? '')
      || ids.has(rule.rule_id)
      || !uniqueStringArray(rule.hosts, /^[a-z0-9.-]+$/u)
      || rule.hosts.length === 0
      || rule.hosts.some((host) => hosts.has(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..'))
      || !/^[a-z0-9][a-z0-9_]{1,79}$/u.test(rule.service_kind ?? '')
      || !/^\/[A-Za-z0-9._~/-]{0,79}$/u.test(rule.display_path ?? '')
      || !validIdentifierPattern(rule.identifier_pattern)
      || !Array.isArray(rule.identifier_sources)
      || rule.identifier_sources.length === 0
      || rule.identifier_sources.length > 16
      || rule.identifier_sources.some((source) => !validIdentifierSource(source, rule.hosts))) return false;
    ids.add(rule.rule_id);
    rule.hosts.forEach((host) => hosts.add(host));
  }
  return true;
}

function validIdentifierPattern(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 160 || !value.startsWith('^') || !value.endsWith('$')) return false;
  try { new RegExp(value, 'u'); return true; } catch { return false; }
}

function validIdentifierSource(source, ruleHosts) {
  if (!isRecord(source)) return false;
  if (source.kind === 'query') {
    return exactKeys(source, ['kind', 'key', 'exact_path'])
      && /^[A-Za-z0-9._~-]{1,40}$/u.test(source.key ?? '')
      && /^\/[A-Za-z0-9._~/-]{0,79}$/u.test(source.exact_path ?? '');
  }
  if (source.kind === 'path_segment') {
    if (!exactKeys(source, ['kind', 'index', 'hosts', 'prefixes'])
      || !Number.isSafeInteger(source.index) || source.index < 0 || source.index > 16) return false;
    const hasHosts = source.hosts !== undefined;
    const hasPrefixes = source.prefixes !== undefined;
    if (hasHosts === hasPrefixes) return false;
    if (hasHosts) return uniqueStringArray(source.hosts, /^[a-z0-9.-]+$/u)
      && source.hosts.length > 0
      && source.hosts.every((host) => ruleHosts.includes(host));
    return uniqueStringArray(source.prefixes, /^[A-Za-z0-9._~-]{1,40}$/u) && source.prefixes.length > 0;
  }
  return source.kind === 'last_matching_path_segment' && exactKeys(source, ['kind']);
}

function exactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

async function readJson(file, code) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw mediaPolicyError(code, 'A required media review configuration file is unavailable.', error?.code);
  }
}

function isSafeRelativePolicyPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !path.isAbsolute(value)
    && !value.split(/[\\/]/u).includes('..');
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw mediaPolicyError('MEDIA_REVIEW_POLICY_LIMIT_INVALID', `The ${name} limit is invalid.`);
}

function assertFiniteRange(value, minimum, maximum, name) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw mediaPolicyError('MEDIA_REVIEW_POLICY_LIMIT_INVALID', `The ${name} limit is invalid.`);
  }
}

function uniqueStringArray(value, pattern) {
  return Array.isArray(value)
    && value.length <= 64
    && new Set(value).size === value.length
    && value.every((entry) => typeof entry === 'string' && pattern.test(entry));
}

function trustedToolCandidates(value, basename) {
  return uniqueStringArray(value, /^\/[A-Za-z0-9._/+:-]+$/u)
    && value.length > 0
    && value.every((candidate) => path.basename(candidate) === basename && path.normalize(candidate) === candidate);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function mediaPolicyError(code, message, reason = null) {
  const error = new Error(message);
  error.code = code;
  error.details = reason ? { reason } : {};
  return error;
}
