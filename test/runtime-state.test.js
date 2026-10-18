import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeState, applyRuntimeEvent } from '../src/runtime-state.js';

test('成功切换事件同时更新 currentNow 和 lastSwitch，并递增 revision', () => {
  const initial = createRuntimeState({ currentNow: 'old' });
  const next = applyRuntimeEvent(initial, {
    type: 'switch.succeeded',
    at: 100,
    switchId: 'switch-1',
    requestId: 'request-1',
    from: 'old',
    to: 'new',
  });
  assert.equal(next.revision, 1);
  assert.equal(next.currentNow, 'new');
  assert.deepEqual(next.lastSwitch, {
    at: 100,
    from: 'old',
    to: 'new',
    switchId: 'switch-1',
    requestId: 'request-1',
    reason: 'unknown',
    priority: null,
    candidateGeneration: null,
    candidateDelay: null,
    candidateRecheck: false,
  });
  assert.equal(initial.currentNow, 'old');
});

test('失败切换事件不制造伪成功状态', () => {
  const initial = createRuntimeState({ currentNow: 'old' });
  const next = applyRuntimeEvent(initial, { type: 'switch.failed', at: 100, reason: 'timeout', switchId: 'switch-1' });
  assert.equal(next.revision, 1);
  assert.equal(next.currentNow, 'old');
  assert.equal(next.lastSwitch, null);
  assert.equal(next.lastError.reason, 'timeout');
});

test('无效事件不递增 revision，诊断事件保留关联标识', () => {
  const initial = createRuntimeState();
  const same = applyRuntimeEvent(initial, null);
  assert.equal(same, initial);
  const next = applyRuntimeEvent(initial, { type: 'scan.completed', at: 10, scanId: 'scan-1', durationMs: 42, published: true });
  assert.equal(next.revision, 1);
  assert.deepEqual(next.diagnostics.lastScan, { scanId: 'scan-1', at: 10, durationMs: 42, published: true });
});
