import test from 'node:test';
import assert from 'node:assert/strict';
import { createClashApi } from '../src/api.js';

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
