import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js';

test('normalizeConfig({}) 返回规格中的 31 项默认配置', () => {
  const config = normalizeConfig({});

  assert.equal(config.selectorName, '🚀 节点选择');
  assert.deepEqual(config.probeUrls, [
    'https://www.gstatic.com/generate_204',
    'https://www.google.com/generate_204',
    'https://github.com',
  ]);
  assert.equal(config.watchIntervalMs, 5000);
  assert.equal(config.watchTimeoutMs, 4000);
  assert.equal(config.maxDelayMs, 2000);
  assert.equal(config.poolRefreshIntervalMs, 180000);
  assert.equal(config.poolTimeoutMs, 2000);
  assert.equal(config.poolConcurrency, 20);
  assert.equal(config.poolFailureRateThreshold, 0.9);
  assert.equal(config.failureThreshold, 3);
  assert.equal(config.recoveryThreshold, 2);
  assert.equal(config.initialCooldownMs, 120000);
  assert.equal(config.maxCooldownMs, 1800000);
  assert.equal(config.minDwellMs, 60000);
  assert.equal(config.degradationRatio, 3);
  assert.equal(config.degradationThreshold, 2);
  assert.equal(config.slowThreshold, 2);
  assert.equal(config.baselineWindow, 5);
  assert.equal(config.optimizeRatio, 2);
  assert.equal(config.optimizeThreshold, 3);
  assert.equal(config.stalkProbeDelayMs, 2000);
  assert.equal(config.stalkSuccessThreshold, 2);
  assert.equal(config.preSwitchMaxProbe, 3);
  assert.equal(config.realProbeEnabled, true);
  assert.deepEqual(config.realProbeUrls, [
    'https://github.com',
    'https://www.google.com',
  ]);
  assert.equal(config.realDelayMs, 3000);
  assert.equal(config.realProbeMinSuccesses, 2);
  assert.equal(config.realProbeTimeoutMs, 8000);
  assert.equal(config.realStalkTimeoutMs, 3000);
  assert.equal(config.realSlowThreshold, 2);
  assert.equal(config.realProbeIntervalMs, 15000);
  assert.equal(config.realStalkSuccessThreshold, 2);
  assert.equal(config.eventLogLimit, 50);
  assert.equal(config.scanIntervalMs, 10000);
  assert.equal(config.scanMainPoolSize, 20);
  assert.equal(config.scanExplorePoolSize, 5);
  assert.equal(config.scanScoreInitial, 80);
  assert.deepEqual(config, DEFAULT_CONFIG);
});

test('前后台调度参数提供默认值并接受正数配置', () => {
  const defaults = normalizeConfig({});
  assert.equal(defaults.foregroundReserved, 2);
  assert.equal(defaults.backgroundConcurrency, 3);
  assert.equal(defaults.backgroundBatchSize, 3);
  assert.equal(defaults.backgroundRoundDeadlineMs, 300000);
  assert.equal(defaults.backgroundBackoffMs, 30000);

  const configured = normalizeConfig({
    foregroundReserved: 1,
    backgroundConcurrency: 4,
    backgroundBatchSize: 5,
    backgroundRoundDeadlineMs: 120000,
    backgroundBackoffMs: 45000,
  });
  assert.equal(configured.foregroundReserved, 1);
  assert.equal(configured.backgroundConcurrency, 4);
  assert.equal(configured.backgroundBatchSize, 5);
  assert.equal(configured.backgroundRoundDeadlineMs, 120000);
  assert.equal(configured.backgroundBackoffMs, 45000);
});

test('normalizeConfig 安全归一化非法负数和零值', () => {
  const config = normalizeConfig({
    watchIntervalMs: 0,
    watchTimeoutMs: -1,
    maxDelayMs: -1,
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
    slowThreshold: 0,
    baselineWindow: 0,
    optimizeRatio: 0,
    optimizeThreshold: -1,
    poolFailureRateThreshold: -1,
    stalkProbeDelayMs: 0,
    stalkSuccessThreshold: -1,
    preSwitchMaxProbe: 0,
    realDelayMs: -1,
    realProbeTimeoutMs: 0,
    realStalkTimeoutMs: 0,
    realSlowThreshold: 0,
  });

  for (const key of [
    'watchIntervalMs',
    'watchTimeoutMs',
    'maxDelayMs',
    'poolRefreshIntervalMs',
    'poolTimeoutMs',
    'initialCooldownMs',
    'minDwellMs',
    'degradationRatio',
    'optimizeRatio',
    'stalkProbeDelayMs',
    'realDelayMs',
    'realProbeTimeoutMs',
    'realStalkTimeoutMs',
    'realProbeIntervalMs',
  ]) {
    assert.ok(config[key] > 0, `${key} 应为正数`);
  }

  for (const key of [
    'poolConcurrency',
    'failureThreshold',
    'recoveryThreshold',
    'degradationThreshold',
    'slowThreshold',
    'baselineWindow',
    'optimizeThreshold',
    'stalkSuccessThreshold',
    'preSwitchMaxProbe',
    'realSlowThreshold',
    'realStalkSuccessThreshold',
    'eventLogLimit',
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
    'slowThreshold',
    'baselineWindow',
    'optimizeThreshold',
    'stalkSuccessThreshold',
    'preSwitchMaxProbe',
    'realSlowThreshold',
    'realStalkSuccessThreshold',
    'eventLogLimit',
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
    slowThreshold: 1,
    baselineWindow: 3,
    optimizeThreshold: 5,
    stalkSuccessThreshold: 1,
    preSwitchMaxProbe: 6,
    realSlowThreshold: 2,
    realStalkSuccessThreshold: 1,
    eventLogLimit: 10,
  });
  assert.equal(valid.poolConcurrency, 1);
  assert.equal(valid.failureThreshold, 2);
  assert.equal(valid.recoveryThreshold, 7);
  assert.equal(valid.degradationThreshold, 1);
  assert.equal(valid.slowThreshold, 1);
  assert.equal(valid.baselineWindow, 3);
  assert.equal(valid.optimizeThreshold, 5);
  assert.equal(valid.stalkSuccessThreshold, 1);
  assert.equal(valid.preSwitchMaxProbe, 6);
  assert.equal(valid.realSlowThreshold, 2);
  assert.equal(valid.realStalkSuccessThreshold, 1);
  assert.equal(valid.eventLogLimit, 10);
});

test('评分阈值关系非法时回退默认值', () => {
  const config = normalizeConfig({
    scanScoreMax: 50,
    scanScoreInitial: 90,
    scanScoreHighThreshold: 70,
    scanScoreMediumThreshold: 80,
    scanScoreLowThreshold: 85,
  });
  assert.equal(config.scanScoreMax, DEFAULT_CONFIG.scanScoreMax);
  assert.equal(config.scanScoreInitial, DEFAULT_CONFIG.scanScoreInitial);
  assert.equal(config.scanScoreHighThreshold, DEFAULT_CONFIG.scanScoreHighThreshold);
  assert.equal(config.scanScoreMediumThreshold, DEFAULT_CONFIG.scanScoreMediumThreshold);
  assert.equal(config.scanScoreLowThreshold, DEFAULT_CONFIG.scanScoreLowThreshold);
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

test('realProbeUrls 只接受非空字符串数组并保留用户值', () => {
  assert.deepEqual(normalizeConfig({}).realProbeUrls, DEFAULT_CONFIG.realProbeUrls);
  assert.deepEqual(
    normalizeConfig({ realProbeUrls: ['https://example.com'] }).realProbeUrls,
    ['https://example.com'],
  );
  assert.deepEqual(
    normalizeConfig({ realProbeUrls: ['https://a.com', '  ', 'https://b.com'] }).realProbeUrls,
    ['https://a.com', 'https://b.com'],
  );

  for (const value of [[], ['', '  '], 'not-array', 42, null, undefined, {}]) {
    const config = normalizeConfig({ realProbeUrls: value });
    assert.deepEqual(config.realProbeUrls, DEFAULT_CONFIG.realProbeUrls, `realProbeUrls 应拒绝 ${JSON.stringify(value)}`);
  }
});

test('稳定性择优返回完整默认配置并安全归一化', () => {
  const config = normalizeConfig({});
  assert.equal(config.stabilityMode, 'stable-first');
  assert.equal(config.stabilityWindowMs, 600000);
  assert.equal(config.stabilityMaxSamples, 20);
  assert.equal(config.stabilityHeadMinSamples, 5);
  assert.equal(config.stabilityRealMinSamples, 3);
  assert.equal(config.stabilityRealLatencyMinSamples, 5);
  assert.equal(config.realStabilityProbeBudget, 3);
  assert.equal(config.stableSwitchRounds, 3);
  assert.equal(config.stabilitySwitchMargin, 8);
  assert.equal(config.latencySwitchMargin, 0.35);
  assert.equal(config.optimizeDwellMs, 300000);
  assert.equal(config.optimizeCooldownMs, 600000);
  const invalid = normalizeConfig({ stabilityWindowMs: 0, stabilityMaxSamples: 0, realStabilityProbeBudget: -1, stabilityMode: 'bad' });
  assert.equal(invalid.stabilityWindowMs, 600000);
  assert.equal(invalid.stabilityMaxSamples, 20);
  assert.equal(invalid.realStabilityProbeBudget, 3);
  assert.equal(invalid.stabilityMode, 'stable-first');
});

test('realProbeEnabled 只接受布尔值', () => {
  assert.equal(normalizeConfig({}).realProbeEnabled, true);
  assert.equal(normalizeConfig({ realProbeEnabled: false }).realProbeEnabled, false);
  assert.equal(normalizeConfig({ realProbeEnabled: true }).realProbeEnabled, true);
  for (const value of [0, 1, 'true', null, undefined, {}]) {
    assert.equal(normalizeConfig({ realProbeEnabled: value }).realProbeEnabled, true, `realProbeEnabled 应回退默认 ${String(value)}`);
  }
});
