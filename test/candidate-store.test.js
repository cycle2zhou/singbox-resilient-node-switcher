import test from 'node:test';
import assert from 'node:assert/strict';
import { createCandidateSnapshot } from '../src/runtime-model.js';
import { createCandidateStore } from '../src/candidate-store.js';

function snapshot(generation, fingerprint, expiresAt = 1000) {
  return createCandidateSnapshot({
    generation,
    createdAt: 0,
    expiresAt,
    topologyFingerprint: fingerprint,
    candidates: [{ tag: `n${generation}`, stableKey: `n${generation}`, delay: generation, checkedAt: 0 }],
  });
}

test('CandidateStore 拒绝旧代次和拓扑不匹配的发布', () => {
  const store = createCandidateStore({ clock: { now: () => 10 } });
  store.setTopology('topology-1');
  assert.equal(store.publish(snapshot(2, 'topology-1')), true);
  assert.equal(store.publish(snapshot(1, 'topology-1')), false);
  assert.equal(store.publish(snapshot(3, 'topology-2')), false);
  assert.equal(store.getSnapshot().generation, 2);
});

test('新鲜快照可用于择优，过期快照只能作为故障复核线索', () => {
  const store = createCandidateStore({ clock: { now: () => 1001 } });
  store.setTopology('topology-1');
  store.publish(snapshot(1, 'topology-1', 1000));

  assert.deepEqual(store.getUsableCandidates({ now: 1001, topologyFingerprint: 'topology-1', allowExpired: false }).candidates, []);
  const stale = store.getUsableCandidates({ now: 1001, topologyFingerprint: 'topology-1', allowExpired: true });
  assert.equal(stale.requiresRecheck, true);
  assert.equal(stale.candidates.length, 1);
});
