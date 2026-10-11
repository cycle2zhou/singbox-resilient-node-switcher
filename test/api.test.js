import test from 'node:test';
import assert from 'node:assert/strict';
import { createClashApi, realProbe } from '../src/api.js';

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

test('getProxies sends Bearer authorization and parses JSON', async () => {
  const calls = [];
  const api = createClashApi({
    baseUrl: 'http://127.0.0.1:9090/',
    secret: 'secret-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, { proxies: {} });
    },
  });

  assert.deepEqual(await api.getProxies(), { proxies: {} });
  assert.equal(calls[0].url, 'http://127.0.0.1:9090/proxies');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-token');
});

test('probe URL-encodes node, passes query, and validates delay', async () => {
  const calls = [];
  const api = createClashApi({
    baseUrl: 'http://localhost:9090',
    secret: 's',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, { delay: 88 });
    },
  });

  assert.deepEqual(await api.probe('node /?&', 'https://example.test/ping', 2500), {
    ok: true,
    delay: 88,
  });
  assert.match(calls[0].url, /\/proxies\/node%20%2F%3F%26\/delay\?/);
  assert.match(calls[0].url, /url=https%3A%2F%2Fexample\.test%2Fping/);
  assert.match(calls[0].url, /timeout=2500/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer s');
});

test('getProxies uses default timeout and throws request errors with status/reason', async () => {
  const api = createClashApi({
    baseUrl: 'http://localhost:9090',
    timeoutMs: 1,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    }),
  });

  await assert.rejects(api.getProxies(), (error) => {
    assert.equal(error.ok, false);
    assert.equal(error.status, undefined);
    assert.match(error.reason, /timeout/i);
    return true;
  });
});

test('select uses default timeout and throws request errors', async () => {
  const api = createClashApi({
    baseUrl: 'http://localhost:9090',
    timeoutMs: 1,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    }),
  });

  await assert.rejects(api.select('group', 'node'), (error) => {
    assert.equal(error.ok, false);
    assert.match(error.reason, /timeout/i);
    return true;
  });
});

test('getProxies reports invalid JSON with an explicit reason', async () => {
  const api = createClashApi({
    baseUrl: 'http://localhost:9090',
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      async json() { throw new SyntaxError('Unexpected token'); },
    }),
  });

  await assert.rejects(api.getProxies(), (error) => {
    assert.equal(error.status, 200);
    assert.match(error.reason, /not valid JSON/i);
    return true;
  });
});

test('probe rejects non-2xx and timeout errors', async () => { 
  const api = createClashApi({
    baseUrl: 'http://localhost:9090',
    fetchImpl: async () => response(503, { error: 'unavailable' }),
  });
  const failed = await api.probe('node', 'https://example.test', 100);
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /503/);

  const timedOut = createClashApi({
    baseUrl: 'http://localhost:9090',
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    }),
  });
  const result = await timedOut.probe('node', 'https://example.test', 1);
  assert.equal(result.ok, false);
  assert.match(result.reason, /timeout|abort/i);
});

test('select uses PUT with encoded group and {name: node} payload', async () => {
  const calls = [];
  const api = createClashApi({
    baseUrl: 'http://localhost:9090',
    secret: 'token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(204, null);
    },
  });

  assert.equal((await api.select('main group', 'node /a')).ok, true);
  assert.equal(calls[0].options.method, 'PUT');
  assert.equal(calls[0].options.body, JSON.stringify({ name: 'node /a' }));
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.match(calls[0].url, /\/proxies\/main%20group$/);
});

test('probe 超时归类为 request timeout，非 request aborted', async () => {
  const api = createClashApi({
    baseUrl: 'http://localhost:9090',
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    }),
  });
  const result = await api.probe('node', 'https://example.test', 1);
  assert.equal(result.ok, false);
  assert.match(result.reason, /timeout/i);
  assert.doesNotMatch(result.reason, /abort/i);
});

test('真实 fetch 超时抛 AbortError 时仍归类为 request timeout', async () => {
  // 真实 fetch（如 GFS 运行环境）在 abort 后抛 name='AbortError' 的错误，
  // 而非 signal.reason。依赖 timedOut 标志才能正确区分超时与外部中断。
  const api = createClashApi({
    baseUrl: 'http://localhost:9090',
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted', 'AbortError'));
      });
    }),
  });
  const result = await api.probe('node', 'https://example.test', 1);
  assert.equal(result.ok, false);
  assert.match(result.reason, /timeout/i);
  assert.doesNotMatch(result.reason, /abort/i);
});

test('探测超时交给 sing-box timeout 参数，fetch 端兜底超时不提前 abort', async () => {
  // 回归保护：死节点由 sing-box 的 timeout 参数在 timeoutMs 后返回 504 判定，
  // 而非 fetch 端在 timeoutMs 时 abort。fetch 端只保留 timeoutMs*10 的兜底超时，
  // 避免 WKWebView 连接池排队期间活节点被短超时误 abort。
  const api = createClashApi({
    baseUrl: 'http://localhost:9090',
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
      // 模拟 sing-box 在 timeoutMs(50ms) 之后才返回 504（而非立即挂起）
      setTimeout(() => resolve(response(504, { error: 'unavailable' })), 120);
    }),
  });
  const result = await api.probe('node', 'https://example.test', 50);
  assert.equal(result.ok, false);
  assert.match(result.reason, /504/);
  assert.doesNotMatch(result.reason, /timeout|abort/i);
});

test('realProbe 用 httpGetImpl 真实下载 body 并返回完整延迟', async () => {
  // httpGetImpl（HttpGet 风格）真实下载响应体，延迟应反映完整下载时间
  const httpGetImpl = async (url) => {
    assert.equal(url, 'https://github.com');
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { body: '<html>ok</html>' };
  };
  const result = await realProbe('https://github.com', 1000, httpGetImpl);
  assert.equal(result.ok, true);
  assert.ok(result.delay >= 25 && result.delay < 200, `delay 应反映下载耗时，实际 ${result.delay}`);
});

test('realProbe body 含 message（GitHub API 错误）返回失败', async () => {
  const httpGetImpl = async () => ({ body: { message: 'API rate limit exceeded' } });
  const result = await realProbe('https://github.com', 1000, httpGetImpl);
  assert.equal(result.ok, false);
  assert.match(result.reason, /rate limit/);
});

test('realProbe 网络错误抛异常返回失败', async () => {
  const httpGetImpl = async () => { throw new Error('network unreachable'); };
  const result = await realProbe('https://github.com', 1000, httpGetImpl);
  assert.equal(result.ok, false);
  assert.match(result.reason, /network unreachable/);
});

test('realProbe 超时归类为 request timeout', async () => {
  // httpGetImpl 无超时参数，realProbe 用软超时兜底
  const httpGetImpl = async () => new Promise((resolve) => setTimeout(() => resolve({ body: 'ok' }), 100));
  const result = await realProbe('https://github.com', 20, httpGetImpl);
  assert.equal(result.ok, false);
  assert.match(result.reason, /timeout/i);
  assert.doesNotMatch(result.reason, /abort/i);
});
