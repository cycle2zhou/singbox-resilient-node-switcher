import test from 'node:test';
import assert from 'node:assert/strict';
import { createStateStore } from '../src/state-store.js';

test('load 拒绝损坏 JSON，commit 内存状态继续有效', async () => {
  const errors = [];
  const store = createStateStore({
    readFile: async () => '{broken',
    writeFile: async () => { throw new Error('disk full'); },
    clock: { now: () => 10 },
    logger: { warn: (message) => errors.push(message) },
  });
  const loaded = await store.load();
  assert.equal(loaded.revision, 0);
  const committed = await store.commit({ type: 'switch.succeeded', at: 10, from: 'a', to: 'b', switchId: 's1', requestId: 'r1' });
  assert.equal(committed.currentNow, 'b');
  await store.flush();
  assert.equal(errors.length > 0, true);
});

test('乱序写盘不会让旧 revision 覆盖新状态', async () => {
  const writes = [];
  const store = createStateStore({
    readFile: async () => null,
    writeFile: async (path, body) => {
      await new Promise((resolve) => setTimeout(resolve, body.includes('"revision":1') ? 20 : 1));
      writes.push(JSON.parse(body));
    },
    clock: { now: () => 10 },
    logger: { warn() {} },
  });
  await store.load();
  await Promise.all([
    store.commit({ type: 'switch.succeeded', at: 10, from: 'a', to: 'b', switchId: 's1', requestId: 'r1' }),
    store.commit({ type: 'switch.succeeded', at: 11, from: 'b', to: 'c', switchId: 's2', requestId: 'r2' }),
  ]);
  await store.flush();
  assert.equal(store.getState().revision, 2);
  assert.equal(writes.at(-1).revision, 2);
});

test('load 时外部 API currentNow 可覆盖旧持久化选择', async () => {
  const store = createStateStore({
    readFile: async () => JSON.stringify({ revision: 3, currentNow: 'stale', lastSwitch: null, lastError: null, diagnostics: {} }),
    writeFile: async () => {},
    clock: { now: () => 10 },
    logger: { warn() {} },
  });
  const loaded = await store.load({ currentNow: 'actual' });
  assert.equal(loaded.currentNow, 'actual');
  assert.equal(loaded.revision, 3);
});
