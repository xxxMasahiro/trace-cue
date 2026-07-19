import assert from 'node:assert/strict';
import test from 'node:test';

test('Control Center classifies an outer pairing deadline as reopen-required', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalWindow = globalThis.window;
  const callbacks = [];
  let requestSignal = null;
  try {
    globalThis.window = {
      location: {
        hash: `#pair=${'p'.repeat(43)}`,
        pathname: '/',
        search: ''
      },
      history: {
        state: null,
        replaceState() {}
      }
    };
    globalThis.fetch = async (_url, options = {}) => {
      requestSignal = options.signal;
      return new Promise(() => {});
    };
    globalThis.setTimeout = (callback) => {
      callbacks.push(callback);
      if (callbacks.length === 2) queueMicrotask(callback);
      return callbacks.length;
    };
    globalThis.clearTimeout = () => {};

    const client = await import(`../control-center/src/apiClient.js?pairing-deadline=${Date.now()}`);
    await assert.rejects(
      client.fetchDashboard(),
      (error) => error?.name === 'TimeoutError'
        && error?.controlCenterReopenRequired === true
        && error?.envelope === undefined
    );
    assert.equal(callbacks.length, 2);
    callbacks[0]();
    await Promise.resolve();
    assert.equal(requestSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('Control Center API setup bounds an unreadable local response and clears transport authority', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const OriginalTextEncoder = globalThis.TextEncoder;
  const observedTimeouts = [];
  let encodedBytes = null;
  let requestSignal = null;
  let fetchCalls = 0;
  try {
    globalThis.fetch = async (_url, options = {}) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response(JSON.stringify({
          data: {
            control_center: {
              action_security: { token: 'a'.repeat(43) }
            }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      requestSignal = options.signal;
      return new Promise(() => {});
    };
    globalThis.setTimeout = (callback, delay) => {
      observedTimeouts.push(delay);
      if (fetchCalls >= 2) queueMicrotask(callback);
      return 1;
    };
    globalThis.clearTimeout = () => {};
    globalThis.TextEncoder = class extends OriginalTextEncoder {
      encode(value) {
        const bytes = super.encode(value);
        if (value === 'fixture-secret-value') encodedBytes = bytes;
        return bytes;
      }
    };

    const client = await import(`../control-center/src/apiClient.js?timeout=${Date.now()}`);
    await assert.rejects(
      client.submitAiApiKey('submission-fixture', 'fixture-secret-value'),
      (error) => error?.name === 'TimeoutError' && error?.envelope === undefined
    );
    assert.equal(observedTimeouts.at(-1) <= client.CONTROL_CENTER_RESPONSE_TIMEOUTS.aiConnectionMs, true);
    assert.equal(observedTimeouts.at(-1) > client.CONTROL_CENTER_RESPONSE_TIMEOUTS.aiConnectionMs - 1_000, true);
    assert.equal(client.CONTROL_CENTER_RESPONSE_TIMEOUTS.aiConnectionMs > 15_000, true);
    assert.equal(requestSignal?.aborted, true);
    assert.equal(fetchCalls, 2);
    assert.equal(encodedBytes?.every((value) => value === 0), true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.TextEncoder = OriginalTextEncoder;
  }
});

test('Control Center rejects a malformed successful mutation response as transport uncertainty', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    globalThis.fetch = async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response(JSON.stringify({
          data: {
            control_center: {
              action_security: { token: 'b'.repeat(43) }
            }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{"status":', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };

    const client = await import(`../control-center/src/apiClient.js?parse=${Date.now()}`);
    await assert.rejects(
      client.repeatAgenticReview({
        review_id: 'review-fixture',
        repeat_kind: 'recheck',
        idempotency_key: 'c'.repeat(43)
      }),
      (error) => error?.name === 'ResponseParseError' && error?.envelope === undefined
    );
    assert.equal(fetchCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Control Center rejects semantically empty successful mutation envelopes', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const body of ['{}', '{"status":"ok"}', '{"status":"ok","data":{}}']) {
      let fetchCalls = 0;
      globalThis.fetch = async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return new Response(JSON.stringify({
            data: {
              control_center: {
                action_security: { token: 'd'.repeat(43) }
              }
            }
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      };
      const client = await import(`../control-center/src/apiClient.js?semantic=${Date.now()}-${fetchCalls}-${body.length}`);
      await assert.rejects(
        client.repeatAgenticReview({
          review_id: 'review-fixture',
          repeat_kind: 'recheck',
          idempotency_key: 'e'.repeat(43)
        }),
        (error) => error?.name === 'ResponseContractError' && error?.envelope === undefined
      );
      assert.equal(fetchCalls, 2);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Control Center rejects malformed media projections before rendering them', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const malformedReadiness = {
      status: 'ok',
      data: {
        readiness: {
          schema_version: '1.0.0', type: 'media_review_readiness', status: 'ready',
          transcript_provider: { status: 'ready', limitations: [] },
          technical_analyzer: { status: 'ready', limitations: [] },
          local_input: { accepted_extensions: ['.mp4'], maximum_bytes: 1024 },
          boundary: {
            read_only: true, provider_transcription_performed: false, media_analysis_performed: false,
            network_performed: false, setup_performed: false, mcp_execution_performed: false,
            secrets_included: false, executable_paths_included: true,
            provider_revision_included: false, configuration_hashes_included: false
          }
        }
      }
    };
    globalThis.fetch = async () => new Response(JSON.stringify(malformedReadiness), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
    let client = await import(`../control-center/src/apiClient.js?media-readiness=${Date.now()}`);
    await assert.rejects(client.fetchMediaReviewReadiness(), (error) => error?.name === 'ResponseContractError');

    const malformedOperation = {
      status: 'ok',
      data: {
        media_review: {
          schema_version: '1.0.0', type: 'media_review_operation', operation_id: 'a'.repeat(32),
          state: 'completed', retention: 'ephemeral', capabilities: { status: true, cancel: false, cleanup: true, result: true },
          result_available: true, cleanup_available: true, private_payload_retained: false, errors: [],
          boundary: { absolute_path_included: false, private_locator_included: false, source_name_included: false, raw_media_included: false, full_transcript_included: false }
        }
      }
    };
    globalThis.fetch = async () => new Response(JSON.stringify(malformedOperation), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
    client = await import(`../control-center/src/apiClient.js?media-operation=${Date.now()}`);
    await assert.rejects(client.fetchMediaReviewStatus('a'.repeat(32)), (error) => error?.name === 'ResponseContractError');

    globalThis.fetch = async () => new Response(JSON.stringify({
      data: {
        control_center: {
          action_security: { token: 'b'.repeat(43) },
          media_reviews: [malformedOperation.data.media_review]
        }
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    client = await import(`../control-center/src/apiClient.js?media-dashboard=${Date.now()}`);
    await assert.rejects(client.fetchDashboard(), (error) => error?.name === 'ResponseContractError');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Control Center accepts bounded comparison reads and rejects a weakened comparison boundary', async () => {
  const originalFetch = globalThis.fetch;
  const baseline = '1'.repeat(32);
  const candidate = '2'.repeat(32);
  const options = {
    schema_version: '1.0.0', type: 'media_review_comparison_options',
    options: [
      { operation_id: baseline, created_at: '2026-07-18T00:00:00.000Z', duration_us: 1_000_000, finding_counts: { deterministic: 1, advisory: 2 } },
      { operation_id: candidate, created_at: '2026-07-19T00:00:00.000Z', duration_us: 1_100_000, finding_counts: { deterministic: 1, advisory: 1 } }
    ],
    boundary: {
      public_results_only: true, absolute_paths_included: false, source_names_included: false,
      raw_media_included: false, full_transcript_included: false, network_performed: false
    }
  };
  try {
    globalThis.fetch = async (url, request = {}) => {
      assert.equal(request.method, 'GET');
      const data = String(url).includes('comparison-options')
        ? { media_review_comparison_options: options }
        : { media_review_comparison: apiComparisonFixture(baseline, candidate) };
      return new Response(JSON.stringify({ status: 'ok', data }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    let client = await import(`../control-center/src/apiClient.js?media-comparison=${Date.now()}`);
    assert.equal((await client.listMediaReviewComparisonOptions()).options.length, 2);
    const comparison = await client.compareMediaReviews(baseline, candidate);
    assert.equal(comparison.boundary.media_reprocessed, false);
    assert.equal(comparison.summary.combined_quality_score_included, false);

    const weakenedBoundaries = [
      ['privacy.raw_media_read', (value) => { value.privacy.raw_media_read = true; }],
      ['privacy.private_payload_read', (value) => { value.privacy.private_payload_read = true; }],
      ['privacy.external_send_performed', (value) => { value.privacy.external_send_performed = true; }],
      ['boundary.browser_launched', (value) => { value.boundary.browser_launched = true; }],
      ['boundary.gate_effect', (value) => { value.boundary.gate_effect = 'release'; }],
      ['baseline.status', (value) => { value.baseline.status = 'insufficient'; }],
      ['transcript.classification', (value) => { value.metric_diffs.push({ domain: 'transcript', classification: 'deterministic_measurement' }); }]
    ];
    for (const [label, weaken] of weakenedBoundaries) {
      const unsafe = apiComparisonFixture(baseline, candidate);
      weaken(unsafe);
      globalThis.fetch = async () => new Response(JSON.stringify({ status: 'ok', data: { media_review_comparison: unsafe } }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
      await assert.rejects(client.compareMediaReviews(baseline, candidate), (error) => error?.name === 'ResponseContractError', label);
    }

    const mismatched = apiComparisonFixture(candidate, baseline);
    globalThis.fetch = async () => new Response(JSON.stringify({ status: 'ok', data: { media_review_comparison: mismatched } }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
    await assert.rejects(client.compareMediaReviews(baseline, candidate), (error) => error?.name === 'ResponseContractError');

    for (const invalidOptions of [
      { ...options, options: Array.from({ length: 101 }, (_, index) => ({ ...options.options[0], operation_id: index.toString(16).padStart(32, '0') })) },
      { ...options, options: [options.options[0], structuredClone(options.options[0])] },
      { ...options, options: [{ ...options.options[0], finding_counts: { deterministic: -1, advisory: 0 } }] }
    ]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ status: 'ok', data: { media_review_comparison_options: invalidOptions } }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
      await assert.rejects(client.listMediaReviewComparisonOptions(), (error) => error?.name === 'ResponseContractError');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function apiComparisonFixture(baseline, candidate) {
  return {
    schema_version: '1.0.0', type: 'media_review_comparison', status: 'comparable',
    baseline: { operation_id: baseline, status: 'completed' }, candidate: { operation_id: candidate, status: 'completed_with_limitations' },
    compatibility: { technical: { status: 'comparable' }, transcript: { status: 'comparable' }, advisory: { status: 'comparable' } },
    metric_diffs: [], deterministic_finding_changes: [], advisory_finding_changes: [],
    summary: {
      deterministic: { status: 'unchanged', inconclusive: 0 }, advisory: { status: 'unchanged', inconclusive: 0 },
      deterministic_metric_assessments: { improved: 0, regressed: 0, unchanged: 0, changed: 0, inconclusive: 0, unavailable: 0 },
      provider_metric_assessments: { improved: 0, regressed: 0, unchanged: 0, changed: 0, inconclusive: 0, unavailable: 0 },
      advisory_metric_assessments: { improved: 0, regressed: 0, unchanged: 0, changed: 0, inconclusive: 0, unavailable: 0 },
      combined_quality_score_included: false
    },
    limitations: ['comparison_reads_bounded_public_results_only'],
    privacy: {
      public_results_only: true, raw_media_read: false, raw_audio_read: false, raw_frames_read: false,
      full_transcript_read: false, private_payload_read: false, absolute_paths_included: false, external_send_performed: false
    },
    boundary: {
      read_only: true, media_reprocessed: false, provider_called: false, technical_analyzer_called: false,
      browser_launched: false, network_performed: false, artifact_written: false, mcp_execution_exposed: false,
      deterministic_and_advisory_separated: true, combined_quality_score_included: false, gate_effect: 'none'
    }
  };
}
