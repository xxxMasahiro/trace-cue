import assert from 'node:assert/strict';
import test from 'node:test';

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
