import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js';

test('normalizeConfig({}) 返回规格中的默认配置', () => {
  const config = normalizeConfig({});

  assert.equal(config.intervalMs, 30000);
  assert.equal(config.timeoutMs, 5000);
  assert.equal(config.concurrency, 3);
  assert.equal(config.failureThreshold, 3);
  assert.equal(config.recoveryThreshold, 2);
  assert.equal(config.initialCooldownMs, 120000);
  assert.equal(config.maxCooldownMs, 1800000);
  assert.equal(config.minDwellMs, 60000);
  assert.equal(config.selectorName, '🚀 节点选择');
  assert.deepEqual(config, DEFAULT_CONFIG);
});

test('normalizeConfig 安全归一化非法负数和零值', () => {
  const config = normalizeConfig({
    intervalMs: 0,
    timeoutMs: -1,
    concurrency: 0,
    failureThreshold: 0,
    recoveryThreshold: -2,
    initialCooldownMs: 0,
    maxCooldownMs: -1,
    minDwellMs: 0,
  });

  assert.ok(config.intervalMs > 0);
  assert.ok(config.timeoutMs > 0);
  assert.ok(config.concurrency > 0);
  assert.ok(config.failureThreshold > 0);
  assert.ok(config.recoveryThreshold > 0);
  assert.ok(config.initialCooldownMs > 0);
  assert.ok(config.maxCooldownMs >= config.initialCooldownMs);
  assert.ok(config.minDwellMs > 0);

  const capped = normalizeConfig({ maxCooldownMs: 1, initialCooldownMs: 5000 });
  assert.ok(capped.maxCooldownMs >= capped.initialCooldownMs);
});
