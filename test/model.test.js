import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeState, serializeNodeState } from '../src/model.js';

test('createNodeState 创建健康且计数为零的节点状态', () => {
  assert.deepEqual(createNodeState('node-a'), {
    tag: 'node-a',
    status: 'healthy',
    failureCount: 0,
    recoverySuccessCount: 0,
    cooldownMs: 0,
    cooldownUntil: null,
    lastDelay: null,
    lastError: null,
    lastProbeAt: null,
  });
});

test('serializeNodeState 返回可持久化的状态副本', () => {
  const state = createNodeState('node-a');
  const serialized = serializeNodeState(state);

  assert.deepEqual(serialized, state);
  assert.notEqual(serialized, state);
  serialized.failureCount = 2;
  assert.equal(state.failureCount, 0);
});
