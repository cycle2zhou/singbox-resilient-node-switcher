import { parseDelayResponse } from './response.js';

function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function headers(secret, contentType = false) {
  const result = {};
  if (secret) result.Authorization = `Bearer ${secret}`;
  if (contentType) result['Content-Type'] = 'application/json';
  return result;
}

function combineSignal(signal, timeoutMs) {
  const controller = new AbortController();
  let timeout;
  const abort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeout = setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), timeoutMs);
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    },
  };
}

async function readBody(response) {
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (contentType.includes('json') && typeof response.json === 'function') {
    try {
      return await response.json();
    } catch {
      throw new Error('response body is not valid JSON');
    }
  }
  if (typeof response.text === 'function') {
    const text = await response.text();
    try { return JSON.parse(text); } catch { return text; }
  }
  return undefined;
}

function errorResult(error) {
  const reason = error?.name === 'TimeoutError' || error?.code === 'UND_ERR_CONNECT_TIMEOUT'
    ? 'request timeout'
    : (error?.name === 'AbortError' || error?.name === 'CanceledError' ? 'request aborted' : (error?.message || String(error)));
  return { ok: false, status: error?.status, reason };
}

export function createClashApi({ baseUrl, secret, timeoutMs = 5000, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const request = async (path, options = {}, signal, requestTimeoutMs = timeoutMs) => {
    const combined = combineSignal(signal, requestTimeoutMs);
    try {
      const response = await fetchImpl(joinUrl(baseUrl, path), { ...options, signal: combined.signal, headers: { ...headers(secret), ...options.headers } });
      let body;
      try {
        body = await readBody(response);
      } catch (error) {
        return { ok: false, status: response.status, reason: error.message };
      }
      if (!response.ok && (response.status < 200 || response.status >= 300)) {
        return { ok: false, status: response.status, reason: `request failed with HTTP ${response.status}`, body };
      }
      return { ok: true, status: response.status, body };
    } catch (error) {
      return errorResult(error);
    } finally {
      combined.cleanup();
    }
  };

  return {
    async getProxies(signal) {
      const result = await request('/proxies', {}, signal);
      if (!result.ok) throw Object.assign(new Error(result.reason), result);
      return result.body;
    },

    async probe(node, url, timeoutMs, signal) {
      const encodedNode = encodeURIComponent(node);
      const query = new URLSearchParams({ url, timeout: String(timeoutMs) });
      const combined = combineSignal(signal, timeoutMs);
      try {
        const result = await request(`/proxies/${encodedNode}/delay?${query}`, {}, combined.signal);
        if (!result.ok) return result;
        return parseDelayResponse(result.status, result.body);
      } finally {
        combined.cleanup();
      }
    },

    async select(group, node, signal) {
      const combined = combineSignal(signal);
      try {
        const result = await request(`/proxies/${encodeURIComponent(group)}`, {
          method: 'PUT',
          headers: headers(secret, true),
          body: JSON.stringify({ name: node }),
        }, combined.signal);
        if (!result.ok) throw Object.assign(new Error(result.reason), result);
        return { ok: true, status: result.status, body: result.body };
      } finally {
        combined.cleanup();
      }
    },
  };
}
