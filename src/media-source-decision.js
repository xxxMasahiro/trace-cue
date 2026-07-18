import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { loadMediaReviewPolicy } from './media-review-policy.js';

export async function decideMediaSource(input = {}, context = {}) {
  const policy = await loadMediaReviewPolicy(context);
  if (typeof input.url === 'string' && input.url.trim()) return decideUrl(input, policy);
  if (input.local_file === true || typeof input.local_extension === 'string') return decideLocal(input, policy);
  return invalidDecision('local_file', 'source_not_supplied');
}

function decideLocal(input, policy) {
  const extension = String(input.local_extension ?? '').trim().toLowerCase();
  const supported = policy.source.allowed_local_extensions.includes(extension);
  const rightsDeclared = input.rights_declared === true;
  return {
    schema_version: '1.0.0',
    type: 'media_source_decision',
    source_kind: 'local_file',
    status: supported ? (rightsDeclared ? 'ready' : 'rights_confirmation_required') : 'unsupported',
    capabilities: supported ? ['full_media_analysis'] : ['unsupported'],
    rights: {
      declaration_required: true,
      declared: rightsDeclared,
      platform_policy_separate: true
    },
    source: {
      display_label: supported ? 'Selected local video' : 'Unsupported local media',
      service_kind: null,
      opaque_media_id: null,
      identity_available: input.identity_available === true,
      query_or_fragment_included: false
    },
    limitations: supported
      ? ['local_file_only', rightsDeclared ? 'rights_declared_not_legal_proof' : 'rights_declaration_required']
      : ['local_media_type_unsupported'],
    boundary: decisionBoundary()
  };
}

function decideUrl(input, policy) {
  const raw = input.url.trim();
  if (raw.length > policy.source.maximum_url_characters || /[\u0000-\u001f\u007f]/u.test(raw)) return invalidDecision('url', 'url_invalid');
  let parsed;
  try { parsed = new URL(raw); } catch { return invalidDecision('url', 'url_invalid'); }
  if (!policy.source.allowed_url_schemes.includes(parsed.protocol)
    || parsed.username || parsed.password || !parsed.hostname || parsed.port) {
    return invalidDecision('url', 'url_not_allowed');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  if (isDisallowedNetworkTarget(host, policy)) return invalidDecision('url', 'url_network_target_not_allowed');
  const rule = policy.source.official_player_rules.find((entry) => entry.hosts.includes(host));
  if (rule) {
    const opaqueId = parseOfficialIdentifier(parsed, host, rule);
    if (!opaqueId) return invalidDecision('url', 'official_player_identifier_invalid');
    return {
      schema_version: '1.0.0',
      type: 'media_source_decision',
      source_kind: 'url',
      status: 'ready',
      capabilities: ['playback_inspection'],
      rights: {
        declaration_required: false,
        declared: false,
        platform_policy_separate: true
      },
      source: {
        display_label: `${host}${rule.display_path}`,
        service_kind: rule.service_kind,
        opaque_media_id: createHash('sha256').update(`${rule.rule_id}\n${opaqueId}`).digest('hex'),
        identity_available: true,
        query_or_fragment_included: false
      },
      limitations: ['official_player_state_only', 'media_acquisition_not_authorized', 'full_media_analysis_unavailable'],
      boundary: decisionBoundary()
    };
  }
  return {
    schema_version: '1.0.0',
    type: 'media_source_decision',
    source_kind: 'url',
    status: 'ready',
    capabilities: ['metadata_only'],
    rights: {
      declaration_required: false,
      declared: false,
      platform_policy_separate: true
    },
    source: {
      display_label: host,
      service_kind: 'generic_https',
      opaque_media_id: null,
      identity_available: false,
      query_or_fragment_included: false
    },
    limitations: ['network_probe_not_performed', 'media_acquisition_not_authorized', 'playback_support_unverified'],
    boundary: decisionBoundary()
  };
}

function parseOfficialIdentifier(url, host, rule) {
  const pattern = new RegExp(rule.identifier_pattern, 'u');
  const parts = url.pathname.split('/').filter(Boolean);
  for (const source of rule.identifier_sources) {
    let candidate = null;
    if (source.kind === 'query' && url.pathname === source.exact_path) {
      candidate = url.searchParams.get(source.key);
    } else if (source.kind === 'path_segment' && Array.isArray(source.hosts) && source.hosts.includes(host)) {
      candidate = parts[source.index];
    } else if (source.kind === 'path_segment' && Array.isArray(source.prefixes) && source.prefixes.includes(parts[0])) {
      candidate = parts[source.index];
    } else if (source.kind === 'last_matching_path_segment') {
      candidate = parts.findLast((part) => pattern.test(part)) ?? null;
    }
    if (typeof candidate === 'string' && pattern.test(candidate)) return candidate;
  }
  return null;
}

function isDisallowedNetworkTarget(hostname, policy) {
  const unbracketed = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (policy.source.reject_ip_literal_urls && isIP(unbracketed) !== 0) return true;
  return policy.source.blocked_hostname_suffixes.some((suffix) => {
    const bare = suffix.slice(1);
    return unbracketed === bare || unbracketed.endsWith(suffix);
  });
}

function invalidDecision(sourceKind, limitation) {
  return {
    schema_version: '1.0.0',
    type: 'media_source_decision',
    source_kind: sourceKind,
    status: 'invalid',
    capabilities: ['unsupported'],
    rights: { declaration_required: sourceKind === 'local_file', declared: false, platform_policy_separate: true },
    source: { display_label: 'Unsupported media source', service_kind: null, opaque_media_id: null, identity_available: false, query_or_fragment_included: false },
    limitations: [limitation],
    boundary: decisionBoundary()
  };
}

function decisionBoundary() {
  return {
    network_performed: false,
    media_acquired: false,
    download_performed: false,
    redirect_followed: false,
    dns_resolution_performed: false,
    url_query_or_fragment_included: false,
    credentials_included: false,
    absolute_path_included: false,
    rights_declaration_treated_as_legal_proof: false
  };
}
