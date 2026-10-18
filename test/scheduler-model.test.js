import test from 'node:test';
import assert from 'node:assert/strict';
import { createSchedulerState, reserveForeground, startBackgroundBatch, finishBackgroundBatch, expireBackgroundRound } from '../src/scheduler-model.js';

test('调度状态默认提供前台保留预算和后台批次上限', () => {
  const state = createSchedulerState({});
  assert.equal(state.foregroundReserved, 2);
  assert.equal(state.backgroundConcurrency, 3);
  assert.equal(state.backgroundBatchSize, 3);
  assert.equal(state.backgroundRoundDeadlineMs, 300000);
  assert.equal(state.backgroundRound, 0);
  assert.equal(state.backgroundInProgress, false);
});

test('前台保留预算不会被后台占用', () => {
  const state = createSchedulerState({ totalConcurrency: 5, foregroundReserved: 2, backgroundConcurrency: 3 });
  const first = reserveForeground(state, 2);
  assert.equal(first.accepted, true);
  assert.equal(first.state.foregroundInFlight, 2);
  const second = reserveForeground(first.state, 1);
  assert.equal(second.accepted, false);
  assert.equal(second.state.foregroundInFlight, 2);
});

test('前台占用保留额度时后台先登记轮次并等待让路', () => {
  const state = reserveForeground(createSchedulerState({}), 1).state;
  const started = startBackgroundBatch(state, { targets: ['a'], topologyFingerprint: 'topo-1', now: 100 });
  assert.equal(started.accepted, true);
  assert.equal(started.state.backgroundInProgress, true);
  assert.deepEqual(started.batch.targets, ['a']);
});

test('后台同一时间只能启动一个逻辑轮次并限制批次大小', () => {
  const state = createSchedulerState({ backgroundBatchSize: 3 });
  const started = startBackgroundBatch(state, { targets: ['a', 'b', 'c', 'd'], topologyFingerprint: 'topo-1', now: 100 });
  assert.equal(started.accepted, true);
  assert.deepEqual(started.batch.targets, ['a', 'b', 'c']);
  const duplicate = startBackgroundBatch(started.state, { targets: ['x'], topologyFingerprint: 'topo-1', now: 200 });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, 'in-progress');
});

test('后台轮次超时保留游标并进入退避，不产生可发布结果', () => {
  const state = createSchedulerState({ backgroundBackoffMs: 30000 });
  const started = startBackgroundBatch(state, { targets: ['a', 'b', 'c'], topologyFingerprint: 'topo-1', now: 100 });
  const expired = expireBackgroundRound(started.state, { now: 300100, cursor: 1 });
  assert.equal(expired.state.backgroundInProgress, false);
  assert.equal(expired.state.backgroundCursor, 1);
  assert.equal(expired.state.backgroundTimeouts, 1);
  assert.equal(expired.state.backgroundNextStartAt, 330100);
  assert.equal(expired.published, false);
});

test('完整批次结束才允许原子发布并推进轮次', () => {
  const state = createSchedulerState({});
  const started = startBackgroundBatch(state, { targets: ['a'], topologyFingerprint: 'topo-1', now: 100 });
  const finished = finishBackgroundBatch(started.state, { now: 200, completed: true, topologyFingerprint: 'topo-1' });
  assert.equal(finished.published, true);
  assert.equal(finished.state.backgroundInProgress, false);
  assert.equal(finished.state.backgroundRound, 1);
  assert.equal(finished.state.backgroundCursor, 0);
});
