import test from 'node:test';
import assert from 'node:assert/strict';
import { createCandidateStore } from '../src/candidate-store.js';
import { createSwitchCoordinator } from '../src/switch-coordinator.js';

function makeStore(candidates, { now = 0, expiresAt = 1000, topologyFingerprint = 'topology-1' } = {}) {
  const store = createCandidateStore({ clock: { now: () => now } });
  store.setTopology(topologyFingerprint);
  store.publish({ generation: 1, createdAt: 0, expiresAt, topologyFingerprint, candidates });
  return store;
}

function candidate(tag, delay = 10) {
  return { tag, stableKey: tag, delay, checkedAt: 0 };
}

function baseOptions(overrides = {}) {
  const calls = [];
  let current = 'bad';
  const api = {
    async select(group, tag) { calls.push({ group, tag }); current = tag; return { ok: true }; },
    async getProxies() { return { proxies: { selector: { now: current } } }; },
    ...overrides.api,
  };
  return {
    api,
    config: { selectorName: 'selector', preSwitchMaxProbe: 3, poolRefreshIntervalMs: 100 },
    clock: { now: () => 0 },
    logger: { info() {}, warn() {}, error() {} },
    observeCurrent: () => ({ now: current, stableKey: current, generation: 1 }),
    realProbe: async () => ({ ok: true, delay: 10 }),
    calls,
    setCurrent(value) { current = value; },
    ...overrides,
  };
}

test('同一当前节点的并发故障请求只产生一个切换事务', async () => {
  let release;
  const options = baseOptions({
    realProbe: () => new Promise((resolve) => { release = resolve; }),
  });
  const coordinator = createSwitchCoordinator({ ...options, candidateStore: makeStore([candidate('good')]) });
  const first = coordinator.requestSwitch({ reason: 'failure', priority: 10 });
  const second = coordinator.requestSwitch({ reason: 'failure', priority: 10 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(options.calls.length, 1);
  release({ ok: true, delay: 10 });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.switchId, b.switchId);
  assert.equal(options.calls.length, 1);
});

test('真实探测关闭时协调器仍完成候选切换且不调用真实探测', async () => {
  let realProbeCalls = 0;
  const options = baseOptions({
    config: { selectorName: 'selector', preSwitchMaxProbe: 1, realProbeEnabled: false },
    realProbe: async () => { realProbeCalls += 1; return { ok: false, reason: 'should not run' }; },
  });
  const coordinator = createSwitchCoordinator({ ...options, candidateStore: makeStore([candidate('good')]) });
  const result = await coordinator.requestSwitch({ reason: 'failure', priority: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.node, 'good');
  assert.equal(realProbeCalls, 0);
});

test('候选即时复核失败后跳过首候选并切换下一个', async () => {
  const options = baseOptions({
    probeCandidate: async (tag) => tag === 'bad-good' ? { ok: false } : { ok: true },
  });
  const coordinator = createSwitchCoordinator({ ...options, candidateStore: makeStore([candidate('bad-good', 1), candidate('good', 2)]) });
  const result = await coordinator.requestSwitch({ reason: 'failure', priority: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.node, 'good');
  assert.deepEqual(options.calls.map(({ tag }) => tag), ['good']);
});

test('成功切换后提交统一确认事件', async () => {
  const events = [];
  const options = baseOptions();
  const coordinator = createSwitchCoordinator({
    ...options,
    candidateStore: makeStore([candidate('good')]),
    onConfirmed: async (event) => events.push(event),
  });
  const result = await coordinator.requestSwitch({ reason: 'failure', priority: 10 });
  assert.equal(result.ok, true);
  assert.deepEqual(events.map(({ from, to, fallback }) => ({ from, to, fallback })), [{ from: 'bad', to: 'good', fallback: false }]);
  assert.equal(events[0].reason, 'failure');
  assert.equal(events[0].requestId, result.requestId);
  assert.equal(events[0].switchId, result.switchId);
});

test('候选真实复核失败后回退到下一个候选', async () => {
  const options = baseOptions({
    realProbe: async (tag) => tag === 'bad-good' ? { ok: false, reason: 'unreachable' } : { ok: true, delay: 10 },
  });
  options.setCurrent('bad');
  const coordinator = createSwitchCoordinator({ ...options, candidateStore: makeStore([candidate('bad-good', 1), candidate('good', 2)]) });
  const result = await coordinator.requestSwitch({ reason: 'failure', priority: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.node, 'good');
  assert.deepEqual(options.calls.map(({ tag }) => tag), ['bad-good', 'good']);
});

test('同一故障事务不会重复尝试已失败的候选', async () => {
  const options = baseOptions({
    realProbe: async (tag) => tag === 'bad-good' ? { ok: false, reason: 'unreachable' } : { ok: true, delay: 10 },
    fallback: async () => 'urltest',
  });
  const coordinator = createSwitchCoordinator({
    ...options,
    candidateStore: makeStore([candidate('bad-good', 1), candidate('bad-good', 1)]),
  });
  const result = await coordinator.requestSwitch({ reason: 'failure', priority: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.node, 'urltest');
  assert.deepEqual(options.calls.map(({ tag }) => tag), ['bad-good', 'urltest']);
});

test('择优请求拒绝过期快照，故障请求允许过期候选但仍需实时复核', async () => {
  const options = baseOptions({ clock: { now: () => 2000 } });
  const store = makeStore([candidate('good')], { now: 0, expiresAt: 1000 });
  const coordinator = createSwitchCoordinator({ ...options, candidateStore: store });
  const optimize = await coordinator.requestSwitch({ reason: 'optimize', priority: 1 });
  assert.equal(optimize.ok, false);
  assert.equal(optimize.reason, 'candidate snapshot unavailable');
  const failure = await coordinator.requestSwitch({ reason: 'failure', priority: 10 });
  assert.equal(failure.ok, true);
});

test('故障事务诊断记录过期快照与候选实时复核结果', async () => {
  const diagnostics = [];
  const options = baseOptions({
    clock: { now: () => 2000 },
    probeCandidate: async () => ({ ok: false, reason: 'unreachable' }),
    onDiagnostic: async (event) => diagnostics.push(event),
  });
  const coordinator = createSwitchCoordinator({
    ...options,
    candidateStore: makeStore([candidate('bad-good')], { now: 0, expiresAt: 1000 }),
  });
  const result = await coordinator.requestSwitch({ reason: 'failure', priority: 10 });
  assert.equal(result.ok, false);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0], {
    type: 'switch-diagnostic',
    requestId: result.requestId,
    switchId: result.switchId,
    reason: 'failure',
    priority: 10,
    candidateGeneration: 1,
    allowExpired: true,
    requiresRecheck: true,
    candidateCount: 1,
    recheckedCount: 1,
    successfulCount: 0,
    failedCount: 1,
    fallbackAttempted: false,
    result: 'all-candidates-failed',
  });
});

test('PUT 后 now 不一致时不报告伪成功', async () => {
  const base = baseOptions();
  const options = {
    ...base,
    api: {
      ...base.api,
      async getProxies() { return { proxies: { selector: { now: 'other' } } }; },
    },
  };
  const coordinator = createSwitchCoordinator({ ...options, candidateStore: makeStore([candidate('good')]) });
  const result = await coordinator.requestSwitch({ reason: 'failure', priority: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'switch confirmation failed');
});

test('URLTest 兜底确认事件保留故障优先级并标记无候选复核', async () => {
  const events = [];
  const options = baseOptions();
  const coordinator = createSwitchCoordinator({
    ...options,
    candidateStore: makeStore([]),
    fallback: async ({ current }) => current === 'bad' ? 'urltest' : null,
    onConfirmed: async (event) => events.push(event),
  });
  const result = await coordinator.requestSwitch({ reason: 'failure', priority: 10 });
  assert.equal(result.ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'failure');
  assert.equal(events[0].priority, 10);
  assert.equal(events[0].candidateGeneration, null);
  assert.equal(events[0].candidateDelay, null);
  assert.equal(events[0].candidateRecheck, false);
});

test('候选快照为空时协调器使用 URLTest 兜底且返回成功节点', async () => {
  const options = baseOptions();
  const store = makeStore([], { topologyFingerprint: 'topology-1' });
  const coordinator = createSwitchCoordinator({
    ...options,
    candidateStore: store,
    fallback: async ({ current }) => current === 'bad' ? 'urltest' : null,
  });
  const result = await coordinator.requestSwitch({ reason: 'failure', priority: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.node, 'urltest');
  assert.deepEqual(options.calls.map(({ tag }) => tag), ['urltest']);
});

test('候选快照存在但全部候选失败时仍使用 URLTest 兜底', async () => {
  const options = baseOptions({
    probeCandidate: async () => ({ ok: false, reason: 'unreachable' }),
  });
  const coordinator = createSwitchCoordinator({
    ...options,
    candidateStore: makeStore([candidate('stale-good')]),
    fallback: async ({ current }) => current === 'bad' ? 'urltest' : null,
  });
  const result = await coordinator.requestSwitch({ reason: 'failure', priority: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.node, 'urltest');
  assert.deepEqual(options.calls.map(({ tag }) => tag), ['urltest']);
});

test('当前已在 URLTest 且无可用候选时保持不动并进入等待态', async () => {
  const options = baseOptions();
  options.setCurrent('urltest');
  const coordinator = createSwitchCoordinator({
    ...options,
    candidateStore: makeStore([candidate('dead')]),
    probeCandidate: async () => ({ ok: false, reason: 'unreachable' }),
    fallback: async () => 'urltest',
  });
  const result = await coordinator.requestSwitch({ reason: 'failure', priority: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-available-node');
  assert.deepEqual(options.calls, []);
  const repeated = await coordinator.requestSwitch({ reason: 'failure', priority: 10 });
  assert.equal(repeated.reason, 'no-available-node');
  assert.deepEqual(options.calls, []);
});

test('外部 now 变化使事务失效，不继续提交切换成功', async () => {
  let observed = 'bad';
  const options = baseOptions({
    observeCurrent: () => ({ now: observed, stableKey: observed, generation: 1 }),
    realProbe: async () => { observed = 'external'; return { ok: true, delay: 10 }; },
  });
  const coordinator = createSwitchCoordinator({ ...options, candidateStore: makeStore([candidate('good')]) });
  const result = await coordinator.requestSwitch({ reason: 'failure', priority: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'current node changed');
});
