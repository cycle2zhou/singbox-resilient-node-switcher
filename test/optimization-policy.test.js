import test from 'node:test';
import assert from 'node:assert/strict';
import { createOptimizationPolicy } from '../src/optimization-policy.js';

const config = {
  stabilityMode: 'stable-first',
  stableSwitchRounds: 3,
  stabilitySwitchMargin: 8,
  latencySwitchMargin: 0.35,
  optimizeDwellMs: 300000,
  optimizeCooldownMs: 600000,
};

function candidate(tag, score, delay, eligibility = 'eligible') {
  return { tag, stableKey: tag, score, delay, eligibility };
}

function evaluate(policy, now, generation = 1, topologyFingerprint = 'topology-a', mode = 'stable-first', extra = {}) {
  return policy.evaluate({
    current: candidate('current', 70, 1000),
    candidates: [candidate('fast', 85, 500)],
    generation,
    topologyFingerprint,
    now,
    mode,
    ...extra,
  });
}

test('故障保护期内不触发择优，保护期外恢复正常', () => {
  const policy = createOptimizationPolicy({ config });
  const protectedResult = evaluate(policy, 1000, 1, 'topology-a', 'stable-first', { failureProtectionUntil: 2000 });
  assert.equal(protectedResult.kind, 'none');
  assert.equal(protectedResult.reason, 'failure-protection');
  assert.equal(evaluate(policy, 2000).kind, 'none');
});

test('stable-first 单轮低延迟不触发择优', () => {
  const policy = createOptimizationPolicy({ config });
  const result = evaluate(policy, 0);
  assert.equal(result.kind, 'none');
  assert.match(result.reason, /round|stable|threshold/i);
});

test('stable-first 连续三轮且稳定分高于8分后生成择优请求', () => {
  const policy = createOptimizationPolicy({ config });
  assert.equal(evaluate(policy, 0).kind, 'none');
  assert.equal(evaluate(policy, 1000).kind, 'none');
  const result = evaluate(policy, 2000);
  assert.equal(result.kind, 'optimize');
  assert.equal(result.candidate.tag, 'fast');
});

test('样本不足不能触发稳定优先择优', () => {
  const policy = createOptimizationPolicy({ config });
  const result = policy.evaluate({
    current: candidate('current', 70, 1000),
    candidates: [candidate('fast', 95, 500, 'insufficient-real-samples')],
    generation: 1,
    topologyFingerprint: 'topology-a',
    now: 0,
  });
  assert.equal(result.kind, 'none');
  assert.equal(result.reason, 'insufficient-stability-samples');
});

test('generation或拓扑变化重置连续轮次', () => {
  const policy = createOptimizationPolicy({ config });
  assert.equal(evaluate(policy, 0).kind, 'none');
  assert.equal(evaluate(policy, 1000).kind, 'none');
  assert.equal(evaluate(policy, 2000, 2).kind, 'none');
  assert.equal(evaluate(policy, 3000, 2, 'topology-b').kind, 'none');
  assert.equal(evaluate(policy, 4000, 2, 'topology-b').kind, 'none');
  assert.equal(evaluate(policy, 5000, 2, 'topology-b').kind, 'optimize');
});

test('择优成功驻留期内不重复请求，故障请求不受限制', () => {
  const policy = createOptimizationPolicy({ config });
  assert.equal(evaluate(policy, 0).kind, 'none');
  assert.equal(evaluate(policy, 1000).kind, 'none');
  const result = evaluate(policy, 2000);
  assert.equal(result.kind, 'optimize');
  policy.recordResult({ kind: 'optimize', candidate: result.candidate, ok: true, at: 2000 });
  assert.equal(evaluate(policy, 3000).kind, 'none');
  const failure = policy.evaluate({
    current: candidate('current', 70, 1000),
    candidates: [candidate('fast', 85, 500)],
    generation: 1,
    topologyFingerprint: 'topology-a',
    now: 3000,
    reason: 'failure',
  });
  assert.equal(failure.kind, 'none');
  assert.equal(failure.reason, 'fault-priority');
});

test('择优失败候选进入失败冷却', () => {
  const policy = createOptimizationPolicy({ config });
  assert.equal(evaluate(policy, 0).kind, 'none');
  assert.equal(evaluate(policy, 1000).kind, 'none');
  const result = evaluate(policy, 2000);
  policy.recordResult({ kind: 'optimize', candidate: result.candidate, ok: false, at: 2000 });
  assert.equal(evaluate(policy, 3000).kind, 'none');
  assert.equal(evaluate(policy, 600001).kind, 'none');
});
