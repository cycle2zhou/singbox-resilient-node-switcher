import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createNodeState } from '../src/model.js';
import {
  getProbePlan,
  recordProbeSuccess,
  recordProbeFailure,
  isEligibleCandidate,
  markCooldown,
} from '../src/health-state.js';

const config = DEFAULT_CONFIG;
const t0 = 1_000_000;

test('单次失败保持当前节点并累计失败次数，不进入冷却', () => {
  let state = createNodeState('node-a');
  state = recordProbeFailure(state, t0, 'request timeout', config);

  assert.equal(state.status, 'suspect');
  assert.equal(state.failureCount, 1);
  assert.equal(state.cooldownUntil, null);
  assert.equal(state.cooldownMs, 0);
  assert.equal(state.lastError, 'request timeout');
  assert.equal(state.lastProbeAt, t0);
});

test('连续失败达到阈值后进入 cooldown 并记录截止时间', () => {
  let state = createNodeState('node-a');
  state = recordProbeFailure(state, t0, 'timeout', config);
  state = recordProbeFailure(state, t0 + 1, 'timeout', config);
  state = recordProbeFailure(state, t0 + 2, 'timeout', config);

  assert.equal(state.status, 'cooldown');
  assert.equal(state.failureCount, 3);
  assert.equal(state.cooldownMs, config.initialCooldownMs);
  assert.equal(state.cooldownUntil, t0 + 2 + config.initialCooldownMs);
  assert.equal(state.recoverySuccessCount, 0);
});

test('冷却到期返回 half-open 探测计划，未到期跳过', () => {
  let state = createNodeState('node-a');
  state = recordProbeFailure(state, t0, 'x', config);
  state = recordProbeFailure(state, t0 + 1, 'x', config);
  state = recordProbeFailure(state, t0 + 2, 'x', config);
  const until = state.cooldownUntil;

  const early = getProbePlan(state, until - 1, config);
  assert.equal(early.shouldProbe, false);
  assert.equal(early.state.status, 'cooldown');
  assert.match(early.reason, /cooldown/i);

  const due = getProbePlan(state, until, config);
  assert.equal(due.shouldProbe, true);
  assert.equal(due.state.status, 'half-open');
});

test('冷却到期后连续恢复成功达到阈值回到 healthy 并重置退避', () => {
  let state = createNodeState('node-a');
  state = recordProbeFailure(state, t0, 'x', config);
  state = recordProbeFailure(state, t0 + 1, 'x', config);
  state = recordProbeFailure(state, t0 + 2, 'x', config);
  const until = state.cooldownUntil;

  state = getProbePlan(state, until, config).state;

  state = recordProbeSuccess(state, until + 1, 123, config);
  assert.equal(state.status, 'half-open');
  assert.equal(state.recoverySuccessCount, 1);

  state = recordProbeSuccess(state, until + 2, 100, config);
  assert.equal(state.status, 'healthy');
  assert.equal(state.recoverySuccessCount, 0);
  assert.equal(state.failureCount, 0);
  assert.equal(state.cooldownMs, 0);
  assert.equal(state.cooldownUntil, null);
  assert.equal(state.lastDelay, 100);
});

test('半开探测失败按 2 倍退避且不超过最大值', () => {
  let state = createNodeState('node-a');
  state = recordProbeFailure(state, t0, 'x', config);
  state = recordProbeFailure(state, t0 + 1, 'x', config);
  state = recordProbeFailure(state, t0 + 2, 'x', config);
  const firstUntil = state.cooldownUntil;

  state = getProbePlan(state, firstUntil, config).state;
  state = recordProbeFailure(state, firstUntil + 1, 'still down', config);
  assert.equal(state.status, 'cooldown');
  assert.equal(state.cooldownMs, config.initialCooldownMs * 2);

  while (state.cooldownMs < config.maxCooldownMs) {
    const until = state.cooldownUntil;
    state = getProbePlan(state, until, config).state;
    state = recordProbeFailure(state, until + 1, 'still down', config);
  }
  assert.equal(state.cooldownMs, config.maxCooldownMs);
});

test('冷却和半开节点不能作为候选，健康与观察节点可以', () => {
  const healthy = createNodeState('healthy');
  assert.equal(isEligibleCandidate(healthy, t0), true);

  const suspect = recordProbeFailure(createNodeState('suspect'), t0, 'x', config);
  assert.equal(isEligibleCandidate(suspect, t0), true);

  let cooldown = createNodeState('cooldown');
  cooldown = recordProbeFailure(cooldown, t0, 'x', config);
  cooldown = recordProbeFailure(cooldown, t0 + 1, 'x', config);
  cooldown = recordProbeFailure(cooldown, t0 + 2, 'x', config);
  assert.equal(isEligibleCandidate(cooldown, t0 + 3), false);

  const halfOpen = getProbePlan(cooldown, cooldown.cooldownUntil, config).state;
  assert.equal(halfOpen.status, 'half-open');
  assert.equal(isEligibleCandidate(halfOpen, t0 + 4), false);
});

test('状态机为纯函数，不修改传入状态', () => {
  let state = createNodeState('node-a');
  state = recordProbeFailure(state, t0, 'x', config);
  state = recordProbeFailure(state, t0 + 1, 'x', config);
  const snapshot = { ...state };

  const next = recordProbeFailure(state, t0 + 2, 'x', config);

  assert.deepEqual(state, snapshot);
  assert.notEqual(next, state);
});

test('markCooldown 把节点显式置为 cooldown 并设冷却截止', () => {
  const state = createNodeState('n0');
  const next = markCooldown(state, 1000, { initialCooldownMs: 120000 });

  assert.equal(next.status, 'cooldown');
  assert.equal(next.cooldownMs, 120000);
  assert.equal(next.cooldownUntil, 121000);
  assert.equal(next.recoverySuccessCount, 0);
  assert.notEqual(next, state);
});
