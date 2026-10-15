import test from 'node:test';
import assert from 'node:assert/strict';
import { createStabilityScore } from '../src/stability-score.js';

const config = {
  stabilityWindowMs: 1000,
  stabilityMaxSamples: 20,
  headMinSamples: 5,
  realMinSamples: 3,
  realLatencyMinSamples: 5,
};

function makeClock(now = 0) {
  return { now: () => now };
}

test('动态测速后缀使用同一 stableKey 累计样本', () => {
  const score = createStabilityScore({ config, clock: makeClock(0) });
  score.recordHead({ tag: '香港 01 | 120ms', stableKey: '香港 01', delay: 120, ok: true, at: 0 });
  score.recordHead({ tag: '香港 01 | 180ms', stableKey: '香港 01', delay: 180, ok: true, at: 100 });
  const summary = score.getSummary('香港 01');
  assert.equal(summary.headSamples, 2);
  assert.equal(summary.stableKey, '香港 01');
});

test('样本按时间窗口和数量上限淘汰', () => {
  const score = createStabilityScore({ config, clock: makeClock(0) });
  for (let index = 0; index < 25; index += 1) {
    score.recordHead({ tag: `n${index}`, stableKey: 'n1', delay: 100 + index, ok: true, at: index * 100 });
  }
  const summary = score.getSummary('n1', 2400);
  assert.equal(summary.headSamples, 11);
  score.recordHead({ tag: 'n1 | latest', stableKey: 'n1', delay: 100, ok: true, at: 2500 });
  assert.equal(score.getSummary('n1', 2500).headSamples, 11);
});

test('HEAD与真实GET分别统计成功与失败', () => {
  const score = createStabilityScore({ config, clock: makeClock(0) });
  score.recordHead({ tag: 'n1', stableKey: 'n1', delay: 100, ok: true, at: 0 });
  score.recordHead({ tag: 'n1', stableKey: 'n1', delay: null, ok: false, error: '504', at: 1 });
  score.recordReal({ tag: 'n1', stableKey: 'n1', delay: 900, ok: true, at: 2 });
  score.recordReal({ tag: 'n1', stableKey: 'n1', delay: null, ok: false, error: 'reset', at: 3 });
  const summary = score.getSummary('n1', 3);
  assert.equal(summary.headSamples, 2);
  assert.equal(summary.realSamples, 2);
  assert.equal(summary.realSuccesses, 1);
  assert.deepEqual(summary.successfulLatencies, [900]);
});

test('损坏快照恢复为空状态', () => {
  const score = createStabilityScore({ config, clock: makeClock(0) });
  score.recordHead({ tag: 'n1', stableKey: 'n1', delay: 100, ok: true, at: 0 });
  assert.equal(score.restore({ invalid: true }), false);
  assert.equal(score.getSummary('n1', 0), null);
});

test('稳定性快照是深拷贝且有效恢复保留样本', () => {
  const score = createStabilityScore({ config, clock: makeClock(0) });
  score.recordHead({ tag: 'n1', stableKey: 'n1', delay: 100, ok: true, at: 0 });
  const snapshot = score.snapshot();
  snapshot[0].head[0].delay = 9999;
  assert.equal(score.getSummary('n1', 0).successfulLatencies.length, 0);
  assert.equal(score.restore([{ stableKey: 'n1', head: [{ tag: 'n1', stableKey: 'n1', delay: 120, ok: true, at: 0, error: null }], real: [], consecutiveFailures: 0 }]), true);
  assert.deepEqual(score.getSummary('n1', 0).headSamples, 1);
});

test('真实样本不足时不具备稳定优先资格且异常延迟降低波动分', () => {
  const score = createStabilityScore({ config: { ...config, headMinSamples: 1, realMinSamples: 1, realLatencyMinSamples: 1 }, clock: makeClock(0) });
  score.recordHead({ tag: 'n1', stableKey: 'n1', delay: 100, ok: true, at: 0 });
  score.recordReal({ tag: 'n1', stableKey: 'n1', delay: 100, ok: true, at: 1 });
  const stable = score.getSummary('n1', 1);
  score.recordReal({ tag: 'n1', stableKey: 'n1', delay: 1000, ok: true, at: 2 });
  const volatile = score.getSummary('n1', 2);
  assert.equal(stable.eligibility, 'eligible');
  assert.ok(volatile.score < stable.score);
});
