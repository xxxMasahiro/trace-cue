import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

export function nodeHttpFetch(input, init = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(input);
    } catch {
      const error = new TypeError('Invalid URL');
      error.code = 'ERR_INVALID_URL';
      reject(error);
      return;
    }
    const requestImpl = url.protocol === 'http:' ? httpRequest : url.protocol === 'https:' ? httpsRequest : null;
    if (!requestImpl) {
      const error = new TypeError('Unsupported protocol');
      error.code = 'ERR_UNSUPPORTED_PROTOCOL';
      reject(error);
      return;
    }

    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = normalizeHeaders(init.headers);
    const body = init.body ?? null;
    const maxResponseBytes = positiveInteger(init.maxResponseBytes) ?? DEFAULT_MAX_RESPONSE_BYTES;
    const timeoutMs = positiveInteger(init.timeoutMs);
    const signal = init.signal;
    let settled = false;
    let request;

    const settleReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const settleResolve = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const abortError = () => {
      const error = new Error('The HTTP request was aborted.');
      error.name = 'AbortError';
      error.code = 'ABORT_ERR';
      return error;
    };
    const onAbort = () => {
      request?.destroy(abortError());
    };
    const cleanup = () => {
      signal?.removeEventListener?.('abort', onAbort);
    };

    if (signal?.aborted) {
      settleReject(abortError());
      return;
    }

    request = requestImpl(url, {
      method,
      headers
    }, (response) => {
      const chunks = [];
      let responseBytes = 0;
      let tooLarge = false;
      response.on('data', (chunkValue) => {
        if (settled) {
          return;
        }
        const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
        responseBytes += chunk.length;
        chunks.push(chunk);
        if (responseBytes > maxResponseBytes && !tooLarge) {
          tooLarge = true;
          response.destroy();
          settleResolve(responseLike(response, chunks, responseBytes));
        }
      });
      response.on('end', () => {
        settleResolve(responseLike(response, chunks, responseBytes));
      });
      response.on('error', (error) => {
        if (tooLarge) {
          settleResolve(responseLike(response, chunks, responseBytes));
          return;
        }
        settleReject(error);
      });
    });

    request.on('error', settleReject);
    if (timeoutMs) {
      request.setTimeout(timeoutMs, () => {
        const error = abortError();
        error.code = 'TRACE_CUE_HTTP_TIMEOUT';
        request.destroy(error);
      });
    } else {
      request.setTimeout(0);
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });

    if (body != null) {
      request.write(body);
    }
    request.end();
  });
}

function normalizeHeaders(headers) {
  if (!headers) {
    return {};
  }
  if (typeof headers.entries === 'function') {
    return Object.fromEntries(Array.from(headers.entries()).map(([key, value]) => [key, value]));
  }
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)]));
}

function responseLike(response, chunks, responseBytes) {
  const bodyText = Buffer.concat(chunks).toString('utf8');
  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    statusText: response.statusMessage ?? '',
    headers: {
      get(name) {
        const value = response.headers[String(name ?? '').toLowerCase()];
        if (Array.isArray(value)) {
          return value.join(', ');
        }
        return value == null ? null : String(value);
      }
    },
    body: null,
    responseBytes,
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText || '{}')
  };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
