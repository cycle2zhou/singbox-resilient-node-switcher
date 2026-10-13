import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTopologySnapshot,
  createCandidateSnapshot,
  isCandidateSnapshotFresh,
  isTopologyMatch,
  createCorrelationId,
} from '../src/runtime-model.js';

test('拓扑快照按稳定成员与类型生成确定性指纹', () => {
  const first = createTopologySnapshot(['n2', 'n1'], { n1: 'VLESS', n2: 'HTTP' }, 'n1', 1000);
  const second = createTopologySnapshot(['n1', 'n2'], { n2: 'HTTP', n1: 'VLESS' }, 'n1', 2000);

  assert.equal(first.now, 'n1');
  assert.equal(first.checkedAt, 1000);
  assert.equal(first.topologyFingerprint, second.topologyFingerprint);
  assert.deepEqual(first.members, ['n2', 'n1']);
});

test('候选快照保存完整结构并在输入变化后保持不可变', () => {
  const candidates = [{ tag: 'n1', stableKey: 'n1', delay: 120, checkedAt: 1000 }];
  const snapshot = createCandidateSnapshot({
    generation: 3,
    createdAt: 1000,
    expiresAt: 5000,
    topologyFingerprint: 'topology-1',
    candidates,
  });

  candidates[0].delay = 999;
  assert.deepEqual(snapshot, {
    generation: 3,
    createdAt: 1000,
    expiresAt: 5000,
    topologyFingerprint: 'topology-1',
    candidates: [{ tag: 'n1', stableKey: 'n1', delay: 120, checkedAt: 1000 }],
  });
});

test('候选快照按时间和拓扑指纹判断可用性', () => {
  const snapshot = createCandidateSnapshot({
    generation: 1,
    createdAt: 1000,
    expiresAt: 5000,
    topologyFingerprint: 'topology-1',
    candidates: [],
  });

  assert.equal(isCandidateSnapshotFresh(snapshot, 4999), true);
  assert.equal(isCandidateSnapshotFresh(snapshot, 5000), false);
  assert.equal(isTopologyMatch(snapshot, 'topology-1'), true);
  assert.equal(isTopologyMatch(snapshot, 'topology-2'), false);
});

test('快照模型拒绝无效时间和候选', () => {
  assert.throws(
    () => createCandidateSnapshot({ generation: 1, createdAt: 1000, expiresAt: 500, topologyFingerprint: 'x', candidates: [] }),
    /expiresAt/,
  );
  assert.throws(
    () => createCandidateSnapshot({ generation: 1, createdAt: 1000, expiresAt: 2000, topologyFingerprint: 'x', candidates: [{ tag: 'n1' }] }),
    /candidate/,
  );
});

test('关联标识包含前缀并按计数区分', () => {
  assert.equal(createCorrelationId('scan', 7), 'scan-7');
  assert.notEqual(createCorrelationId('switch', 7), createCorrelationId('scan', 7));
});
