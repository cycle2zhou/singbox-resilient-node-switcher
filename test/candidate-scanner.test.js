import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createCandidateStore } from '../src/candidate-store.js';
import { createCandidateScanner } from '../src/candidate-scanner.js';

function selectorProxy(now, members) {
  return { proxies: { '🚀 节点选择': { type: 'Selector', all: members, now } } };
}

function makeClock(value = 0) {
  return { now: () => value };
}

test('扫描器完成后才原子发布候选，扫描期间保留旧快照', async () => {
  let release;
  const api = {
    getProxies: async () => selectorProxy('n0', ['n0', 'n1', 'n2']),
    probe: async (tag) => {
      if (tag === 'n2') await new Promise((resolve) => { release = resolve; });
      return { ok: true, delay: tag === 'n1' ? 10 : 20 };
    },
  };
  const store = createCandidateStore({ clock: makeClock(0) });
  const scanner = createCandidateScanner({
    api,
    config: { ...DEFAULT_CONFIG, selectorName: '🚀 节点选择', poolConcurrency: 1, poolTimeoutMs: 100 },
    clock: makeClock(0),
    logger: { info() {}, warn() {}, error() {} },
    store,
  });

  const first = scanner.scan();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.getSnapshot(), null);
  release();
  const result = await first;
  assert.equal(result.published, true);
  assert.deepEqual(store.getSnapshot().candidates.map(({ tag }) => tag), ['n1', 'n2']);
});

test('扫描 deadline 到期时丢弃局部结果并保留旧快照', async () => {
  const oldSnapshot = {
    generation: 1,
    createdAt: 0,
    expiresAt: 10000,
    topologyFingerprint: JSON.stringify([['n0', 'Leaf'], ['n1', 'Leaf']]),
    candidates: [{ tag: 'n1', stableKey: 'n1', delay: 10, checkedAt: 0 }],
  };
  let release;
  const api = {
    getProxies: async () => selectorProxy('n0', ['n0', 'n1']),
    probe: async () => new Promise((resolve) => { release = resolve; }),
  };
  const store = createCandidateStore({ clock: makeClock(0) });
  store.setTopology(oldSnapshot.topologyFingerprint);
  store.publish(oldSnapshot);
  const scanner = createCandidateScanner({
    api,
    config: { ...DEFAULT_CONFIG, poolConcurrency: 1, poolTimeoutMs: 10 },
    clock: makeClock(0),
    logger: { info() {}, warn() {}, error() {} },
    store,
  });

  const result = await scanner.scan();
  release?.();
  assert.equal(result.published, false);
  assert.equal(result.reason, 'deadline');
  assert.equal(store.getSnapshot().generation, 1);
});

test('Selector 不可管理时不发布候选快照', async () => {
  const store = createCandidateStore({ clock: makeClock(0) });
  const scanner = createCandidateScanner({
    api: { getProxies: async () => ({ proxies: {} }) },
    config: DEFAULT_CONFIG,
    clock: makeClock(0),
    logger: { info() {}, warn() {}, error() {} },
    store,
  });
  const result = await scanner.scan();
  assert.equal(result.published, false);
  assert.match(result.reason, /selector/);
});
