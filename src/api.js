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
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
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

function errorResult(error, timedOut = false) {
  const reason = timedOut || error?.name === 'TimeoutError' || error?.code === 'UND_ERR_CONNECT_TIMEOUT'
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
      return errorResult(error, combined.timedOut);
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
      // 探测超时交给 sing-box 的 timeout 参数（超时返回 504）；fetch 端仅保留兜底超时，
      // 避免 WebView 连接池排队期间被短超时误 abort（timeoutMs 只作 sing-box 端超时，不作 fetch abort）
      const result = await request(`/proxies/${encodedNode}/delay?${query}`, {}, signal, timeoutMs * 10);
      if (!result.ok) return result;
      return parseDelayResponse(result.status, result.body);
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

// 真实延迟探测：用 fetch 走系统代理（WebView 默认走系统代理，指向 sing-box 混合入站
// 127.0.0.1:20122）发起真实 GET 并读取响应体，测到的是「用户实际访问延迟」。
// 与 sing-box 的 /delay（HEAD + 不读 body，系统性低估 3~6 倍）互补，用于慢判定。
// 返回 { ok, delay, status, reason }；ok=false 表示真实访问失败或超时。
export async function realProbe(url, timeoutMs, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
  }, timeoutMs);
  const start = Date.now();
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
    });
    // 读完整响应体：真实访问会下载 body，这才能真正反映用户感知的延迟
    await response.text();
    const delay = Date.now() - start;
    if (!response.ok) {
      return { ok: false, status: response.status, reason: `request failed with HTTP ${response.status}` };
    }
    return { ok: true, delay };
  } catch (error) {
    const reason = error?.name === 'AbortError' || error?.name === 'TimeoutError'
      ? 'request timeout'
      : (error?.message || String(error));
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}
