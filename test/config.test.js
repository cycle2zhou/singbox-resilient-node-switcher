import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js';

test('normalizeConfig({}) 返回规格中的 18 项默认配置', () => {
  const config = normalizeConfig({});

  assert.equal(config.selectorName, '🚀 节点选择');
  assert.deepEqual(config.probeUrls, [
    'https://www.gstatic.com/generate_204',
    'https://cp.cloudflare.com/generate_204',
    'https://www.google.com/generate_204',
  ]);
  assert.equal(config.watchIntervalMs, 10000);
  assert.equal(config.watchTimeoutMs, 4000);
  assert.equal(config.poolRefreshIntervalMs, 180000);
  assert.equal(config.poolTimeoutMs, 2000);
  assert.equal(config.poolConcurrency, 30);
  assert.equal(config.poolFailureRateThreshold, 0.9);
  assert.equal(config.failureThreshold, 3);
  assert.equal(config.recoveryThreshold, 2);
  assert.equal(config.initialCooldownMs, 120000);
  assert.equal(config.maxCooldownMs, 1800000);
  assert.equal(config.minDwellMs, 60000);
  assert.equal(config.degradationRatio, 3);
  assert.equal(config.degradationThreshold, 2);
  assert.equal(config.baselineWindow, 5);
  assert.equal(config.optimizeRatio, 2);
  assert.equal(config.optimizeThreshold, 3);
  assert.deepEqual(config, DEFAULT_CONFIG);
});

test('normalizeConfig 安全归一化非法负数和零值', () => {
  const config = normalizeConfig({
    watchIntervalMs: 0,
    watchTimeoutMs: -1,
    poolRefreshIntervalMs: 0,
    poolTimeoutMs: -1,
    poolConcurrency: 0,
    failureThreshold: 0,
    recoveryThreshold: -2,
    initialCooldownMs: 0,
    maxCooldownMs: -1,
    minDwellMs: 0,
    degradationRatio: 0,
    degradationThreshold: -1,
    baselineWindow: 0,
    optimizeRatio: 0,
    optimizeThreshold: -1,
    poolFailureRateThreshold: -1,
  });

  for (const key of [
    'watchIntervalMs',
    'watchTimeoutMs',
    'poolRefreshIntervalMs',
    'poolTimeoutMs',
    'initialCooldownMs',
    'minDwellMs',
    'degradationRatio',
    'optimizeRatio',
  ]) {
    assert.ok(config[key] > 0, `${key} 应为正数`);
  }

  for (const key of [
    'poolConcurrency',
    'failureThreshold',
    'recoveryThreshold',
    'degradationThreshold',
    'baselineWindow',
    'optimizeThreshold',
  ]) {
    assert.ok(Number.isInteger(config[key]) && config[key] > 0, `${key} 应为正整数`);
  }

  assert.ok(config.maxCooldownMs >= config.initialCooldownMs);
  assert.equal(config.poolFailureRateThreshold, DEFAULT_CONFIG.poolFailureRateThreshold);

  const capped = normalizeConfig({ maxCooldownMs: 1, initialCooldownMs: 5000 });
  assert.ok(capped.maxCooldownMs >= capped.initialCooldownMs);
});

test('并发、阈值和窗口配置只接受正整数', () => {
  const integerKeys = [
    'poolConcurrency',
    'failureThreshold',
    'recoveryThreshold',
    'degradationThreshold',
    'baselineWindow',
    'optimizeThreshold',
  ];
  const invalidValues = [0, -1, 1.5, 0.999, NaN, Infinity, '3'];

  for (const key of integerKeys) {
    for (const value of invalidValues) {
      const config = normalizeConfig({ [key]: value });
      assert.equal(config[key], DEFAULT_CONFIG[key], `${key} 应拒绝 ${String(value)}`);
      assert.ok(Number.isInteger(config[key]));
      assert.ok(config[key] > 0);
    }
  }

  const valid = normalizeConfig({
    poolConcurrency: 1,
    failureThreshold: 2,
    recoveryThreshold: 7,
    degradationThreshold: 1,
    baselineWindow: 3,
    optimizeThreshold: 5,
  });
  assert.equal(valid.poolConcurrency, 1);
  assert.equal(valid.failureThreshold, 2);
  assert.equal(valid.recoveryThreshold, 7);
  assert.equal(valid.degradationThreshold, 1);
  assert.equal(valid.baselineWindow, 3);
  assert.equal(valid.optimizeThreshold, 5);
});

test('poolFailureRateThreshold 只接受 (0,1] 区间内的有限数字', () => {
  assert.equal(normalizeConfig({}).poolFailureRateThreshold, DEFAULT_CONFIG.poolFailureRateThreshold);
  assert.equal(normalizeConfig({ poolFailureRateThreshold: 0.5 }).poolFailureRateThreshold, 0.5);
  assert.equal(normalizeConfig({ poolFailureRateThreshold: 1 }).poolFailureRateThreshold, 1);

  for (const value of [0, -1, 1.5, NaN, Infinity, '0.9', null, undefined, {}]) {
    const config = normalizeConfig({ poolFailureRateThreshold: value });
    assert.equal(
      config.poolFailureRateThreshold,
      DEFAULT_CONFIG.poolFailureRateThreshold,
      `poolFailureRateThreshold 应拒绝 ${String(value)}`,
    );
  }
});

test('probeUrls 只接受非空字符串数组并保留用户值', () => {
  assert.deepEqual(normalizeConfig({}).probeUrls, DEFAULT_CONFIG.probeUrls);
  assert.deepEqual(
    normalizeConfig({ probeUrls: ['https://example.com/204'] }).probeUrls,
    ['https://example.com/204'],
  );
  assert.deepEqual(
    normalizeConfig({ probeUrls: ['https://a.com/204', '  ', 'https://b.com/204'] }).probeUrls,
    ['https://a.com/204', 'https://b.com/204'],
  );

  for (const value of [[], ['', '  '], 'not-array', 42, null, undefined, {}]) {
    const config = normalizeConfig({ probeUrls: value });
    assert.deepEqual(config.probeUrls, DEFAULT_CONFIG.probeUrls, `probeUrls 应拒绝 ${JSON.stringify(value)}`);
  }
});

test('selectorName 只接受非空字符串', () => {
  assert.equal(normalizeConfig({ selectorName: ' 我的节点 ' }).selectorName, ' 我的节点 ');
  for (const value of ['', '  ', 42, null, undefined]) {
    const config = normalizeConfig({ selectorName: value });
    assert.equal(config.selectorName, DEFAULT_CONFIG.selectorName, `selectorName 应拒绝 ${String(value)}`);
  }
});
