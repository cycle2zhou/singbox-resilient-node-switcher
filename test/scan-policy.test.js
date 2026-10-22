import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createScanPolicy } from '../src/scan-policy.js';

test('默认扫描策略保留20个主池并轮转5个探索节点', () => {
  const policy = createScanPolicy({ config: DEFAULT_CONFIG, clock: { now: () => 1000 } });
  const tags = Array.from({ length: 30 }, (_, index) => `n${index}`);
  const first = policy.selectTargets({ tags, currentNow: null, candidateTags: [], now: 1000 });
  assert.equal(first.length, 25);
  assert.equal(new Set(first).size, 25);
  const second = policy.selectTargets({ tags, currentNow: null, candidateTags: [], now: 11000 });
  assert.equal(second.length, 25);
  assert.notDeepEqual(second.slice(-5), first.slice(-5));
});

test('低分节点按分段轮次降频但不会永久排除', () => {
  const policy = createScanPolicy({ config: { ...DEFAULT_CONFIG, scanMainPoolSize: 1, scanExplorePoolSize: 1 }, clock: { now: () => 0 } });
  const tags = ['good', 'bad'];
  policy.recordProbe({ tag: 'bad', ok: false, reason: 'request timeout', now: 0 });
  const first = policy.selectTargets({ tags, currentNow: 'good', candidateTags: [], now: 10000 });
  assert.deepEqual(first, ['good']);
  policy.recordProbe({ tag: 'bad', ok: false, reason: 'request timeout', now: 10000 });
  const immediate = policy.selectTargets({ tags, currentNow: 'good', candidateTags: [], now: 20000 });
  assert.deepEqual(immediate, ['good']);
  let recovery = [];
  for (let index = 0; index < 5; index += 1) {
    recovery = policy.selectTargets({ tags, currentNow: 'good', candidateTags: [], now: 30000 + index * 10000 });
  }
  assert.ok(recovery.includes('bad'), '退避到期后应保留恢复机会');
});

test('评分退避使用独立的扫描调度间隔', () => {
  const policy = createScanPolicy({
    config: { ...DEFAULT_CONFIG, watchIntervalMs: 1000, scanIntervalMs: 10000 },
    clock: { now: () => 0 },
  });
  policy.recordProbe({ tag: 'n1', ok: false, reason: 'request timeout', now: 0 });
  const state = policy.getState('n1');
  assert.equal(state.nextProbeAt, 10000 * 6);
});

test('HTTP错误按状态码使用对应扣分，普通失败不冒充超时', () => {
  const policy = createScanPolicy({ config: DEFAULT_CONFIG, clock: { now: () => 0 } });
  policy.recordProbe({ tag: '503', ok: false, reason: 'request failed with HTTP 503', now: 0 });
  policy.recordProbe({ tag: '504', ok: false, reason: 'request failed with HTTP 504', now: 0 });
  policy.recordProbe({ tag: 'timeout', ok: false, reason: 'request timeout', now: 0 });
  policy.recordProbe({ tag: 'ordinary', ok: false, reason: 'connection reset by peer', now: 0 });
  assert.equal(policy.getState('503').score, DEFAULT_CONFIG.scanScoreInitial - DEFAULT_CONFIG.scanHttp503Step);
  assert.equal(policy.getState('504').score, DEFAULT_CONFIG.scanScoreInitial - DEFAULT_CONFIG.scanHttp504Step);
  assert.equal(policy.getState('timeout').score, DEFAULT_CONFIG.scanScoreInitial - DEFAULT_CONFIG.scanTimeoutStep);
  assert.equal(policy.getState('ordinary').score, DEFAULT_CONFIG.scanScoreInitial - DEFAULT_CONFIG.scanFailureStep);
});

test('成功探测逐步恢复分数，真实失败扣分更重', () => {
  const policy = createScanPolicy({ config: DEFAULT_CONFIG, clock: { now: () => 0 } });
  policy.recordProbe({ tag: 'n1', ok: false, reason: 'request timeout', now: 0 });
  const failed = policy.getState('n1');
  policy.recordProbe({ tag: 'n1', ok: true, delay: 120, now: 1000 });
  const recovered = policy.getState('n1');
  assert.equal(recovered.score - failed.score, 5);
  policy.recordProbe({ tag: 'n1', ok: false, real: true, reason: 'real probe failed', now: 2000 });
  assert.equal(policy.getState('n1').score, recovered.score - DEFAULT_CONFIG.scanRealFailureStep);
});

test('强制节点不受普通扫描频率限制', () => {
  const policy = createScanPolicy({ config: { ...DEFAULT_CONFIG, scanMainPoolSize: 0 }, clock: { now: () => 0 } });
  policy.recordProbe({ tag: 'current', ok: false, reason: 'request timeout', now: 0 });
  const targets = policy.selectTargets({ tags: ['current', 'other'], currentNow: 'current', candidateTags: ['other'], now: 10000 });
  assert.deepEqual(targets, ['current', 'other']);
});

test('扫描策略快照恢复后可撤销全池异常造成的扣分', () => {
  const policy = createScanPolicy({ config: DEFAULT_CONFIG, clock: { now: () => 0 } });
  policy.recordProbe({ tag: 'n1', ok: true, delay: 100, now: 0 });
  const before = policy.getState('n1');
  const snapshot = policy.snapshot();
  policy.recordProbe({ tag: 'n1', ok: false, reason: 'request timeout', now: 1000 });
  policy.restore(snapshot);
  assert.deepEqual(policy.getState('n1'), before);
});

test('快扫模式返回全量 tags（不切片）', () => {
  const policy = createScanPolicy({ config: { ...DEFAULT_CONFIG, scanMainPoolSize: 20, scanExplorePoolSize: 5 }, clock: { now: () => 0 } });
  const tags = Array.from({ length: 30 }, (_, index) => `n${index}`);
  const targets = policy.selectTargets({ tags, currentNow: null, candidateTags: [], now: 0, fastScan: true });
  assert.equal(targets.length, 30);
  assert.equal(new Set(targets).size, 30);
});

test('快扫反转顺序（先探测列表末尾，机场专线通常在末尾）', () => {
  const policy = createScanPolicy({ config: DEFAULT_CONFIG, clock: { now: () => 0 } });
  const tags = ['n0', 'n1', 'n2', 'n3', 'n4'];
  const targets = policy.selectTargets({ tags, currentNow: null, candidateTags: [], now: 0, fastScan: true });
  assert.deepEqual(targets, ['n4', 'n3', 'n2', 'n1', 'n0']);
});

test('连续失败 3 次后指数退避（死节点降低探测频率），成功探测重置', () => {
  const policy = createScanPolicy({ config: DEFAULT_CONFIG, clock: { now: () => 0 } });
  policy.recordProbe({ tag: 'n1', ok: false, reason: 'request timeout', now: 0 });
  assert.equal(policy.getState('n1').nextProbeAt, 6 * 10000);
  policy.recordProbe({ tag: 'n1', ok: false, reason: 'request timeout', now: 60000 });
  assert.equal(policy.getState('n1').nextProbeAt, 60000 + 6 * 10000);
  policy.recordProbe({ tag: 'n1', ok: false, reason: 'request timeout', now: 120000 });
  assert.equal(policy.getState('n1').nextProbeAt, 120000 + 12 * 10000);
  policy.recordProbe({ tag: 'n1', ok: false, reason: 'request timeout', now: 240000 });
  assert.equal(policy.getState('n1').nextProbeAt, 240000 + 24 * 10000);
  policy.recordProbe({ tag: 'n1', ok: false, reason: 'request timeout', now: 480000 });
  assert.equal(policy.getState('n1').nextProbeAt, 480000 + 48 * 10000);
  policy.recordProbe({ tag: 'n1', ok: false, reason: 'request timeout', now: 960000 });
  assert.equal(policy.getState('n1').nextProbeAt, 960000 + 64 * 10000);
  policy.recordProbe({ tag: 'n1', ok: true, delay: 100, now: 1600000 });
  assert.equal(policy.getState('n1').consecutiveFailures, 0);
});
