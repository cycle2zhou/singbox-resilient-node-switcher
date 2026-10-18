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

// 软超时包装：给一个 Promise 加上超时上限，超时后返回 TimeoutError。
// 底层 promise 在超时后仍会继续（无法取消 native 请求），但其结果会被忽略，
// 避免 unhandledRejection。用于 HttpGet 等无显式超时参数的 native 请求。
function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new DOMException('The operation timed out', 'TimeoutError'));
      }
    }, timeoutMs);
    promise.then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } },
    );
  });
}

function isTimeoutError(error) {
  if (!error) return false;
  return error?.name === 'TimeoutError' || error?.name === 'AbortError'
    || /timed?\s*out|timeout/i.test(error?.message || '');
}

// 真实延迟探测：通过注入的 httpGetImpl（GFS 插件传 Plugins.HttpGet，native 层无 CORS，
// 默认走系统代理指向 sing-box 混合入站 127.0.0.1:20122）发起真实 GET 并完整下载响应体，
// 测到的是「用户实际访问延迟」。与 sing-box 的 /delay（HEAD + 不读 body，系统性低估 3~6 倍）
// 互补，用于慢判定。
// httpGetImpl 签名：async (url) => ({ body })，body 为解析后的 JSON 对象或文本字符串；
// 失败时抛异常（网络错误/超时/非 2xx），或返回 { body: { message, ... } }（GitHub API 风格错误）。
// 返回 { ok, delay, reason }；ok=false 表示真实访问失败或超时。
export async function realProbe(url, timeoutMs, httpGetImpl) {
  if (typeof httpGetImpl !== 'function') throw new TypeError('httpGetImpl must be a function');
  const start = Date.now();
  try {
    const result = await withTimeout(httpGetImpl(url), timeoutMs);
    const delay = Date.now() - start;
    const body = result && result.body;
    // GitHub API 风格错误：body 是对象且含 message（如 rate limit/404）
    if (body && typeof body === 'object' && !Array.isArray(body) && body.message) {
      return { ok: false, reason: String(body.message) };
    }
    return { ok: true, delay };
  } catch (error) {
    const reason = isTimeoutError(error)
      ? 'request timeout'
      : (error?.message || String(error));
    return { ok: false, reason };
  }
}
