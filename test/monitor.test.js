import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createMonitor } from '../src/monitor.js';

const SELECTOR = '🚀 节点选择';

function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance(ms) { t += ms; },
    set(value) { t = value; },
  };
}

function makeLogger() {
  const logs = [];
  return {
    logs,
    info(...args) { logs.push(['info', ...args]); },
    warn(...args) { logs.push(['warn', ...args]); },
    error(...args) { logs.push(['error', ...args]); },
  };
}

function selectorProxy(now, all, extra = {}) {
  const proxies = {
    [SELECTOR]: { type: 'Selector', now, all },
    ...extra,
  };
  return proxies;
}

function leafTypes(tags) {
  const out = {};
  for (const tag of tags) out[tag] = { type: 'Shadowsocks' };
  return out;
}

function makeApi(overrides = {}) {
  return {
    getProxies: async () => ({ proxies: {} }),
    probe: async () => ({ ok: true, delay: 1 }),
    select: async () => ({ ok: true }),
    ...overrides,
  };
}

const fastConfig = { ...DEFAULT_CONFIG, minDwellMs: 1 };

test('同步主 Selector 的 all/now，嵌套 URLTest 不展开内部节点', async () => {
  const proxies = selectorProxy('node-a', ['node-a', 'node-b', '🎈 自动选择'], {
    'node-a': { type: 'Shadowsocks' },
    'node-b': { type: 'Shadowsocks' },
    '🎈 自动选择': { type: 'URLTest', now: 'inner-1', all: ['inner-1', 'inner-2'] },
    'inner-1': { type: 'Shadowsocks' },
    'inner-2': { type: 'Shadowsocks' },
  });

  const api = makeApi({ getProxies: async () => ({ proxies }) });
  const monitor = createMonitor({ api, config: fastConfig, clock: makeClock(0), logger: makeLogger() });

  await monitor.runCycle();

  const snap = monitor.getSnapshot();
  assert.equal(snap.currentNow, 'node-a');
  assert.deepEqual([...snap.members].sort(), ['node-a', 'node-b', '🎈 自动选择']);
  assert.equal(snap.memberTypes['🎈 自动选择'], 'URLTest');
  assert.equal(snap.memberTypes['inner-1'], undefined);
});

test('主 Selector 缺失、类型非 Selector 或空成员时停止切换并报告原因', async () => {
  const missing = makeApi({ getProxies: async () => ({ proxies: {} }) });
  const m1 = createMonitor({ api: missing, config: fastConfig, clock: makeClock(0), logger: makeLogger() });
  await m1.runCycle();
  assert.match(m1.getSnapshot().lastError, /不存在|not found|不存在/i);

  const urlTestGroup = makeApi({
    getProxies: async () => ({ proxies: { [SELECTOR]: { type: 'URLTest', now: 'x', all: ['x'] } } }),
  });
  const m2 = createMonitor({ api: urlTestGroup, config: fastConfig, clock: makeClock(0), logger: makeLogger() });
  await m2.runCycle();
  assert.match(m2.getSnapshot().lastError, /非 Selector|Selector|not a Selector/i);
});

test('轮次探测并发不超过上限', async () => {
  const tags = Array.from({ length: 9 }, (_, i) => `n${i}`);
  const proxies = selectorProxy('n0', tags, leafTypes(tags));

  let active = 0;
  let maxActive = 0;
  let probeCount = 0;
  const api = makeApi({
    getProxies: async () => ({ proxies }),
    probe: async () => {
      probeCount += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 1));
      active -= 1;
      return { ok: true, delay: 1 };
    },
  });

  const monitor = createMonitor({ api, config: fastConfig, clock: makeClock(0), logger: makeLogger() });
  await monitor.runCycle();

  assert.ok(maxActive <= fastConfig.concurrency, `并发峰值 ${maxActive} 应不超过 ${fastConfig.concurrency}`);
  assert.equal(probeCount, tags.length);
});

test('上一轮未完成时第二次 runCycle 被跳过', async () => {
  const tags = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'];
  const proxies = selectorProxy('n0', tags, leafTypes(tags));

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const api = makeApi({
    getProxies: async () => ({ proxies }),
    probe: async () => { await gate; return { ok: true, delay: 1 }; },
  });

  const monitor = createMonitor({ api, config: fastConfig, clock: makeClock(0), logger: makeLogger() });

  const first = monitor.runCycle();
  await new Promise((r) => setTimeout(r, 5));
  const second = await monitor.runCycle(); // 应立即跳过

  assert.equal(second.skipped, true);

  release();
  await first;
});

test('当前节点达到失败阈值后仅切换到已探测成功且非冷却的候选', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1', 'n2'], leafTypes(['n0', 'n1', 'n2']));

  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => (node === 'n1' ? { ok: true, delay: 10 } : { ok: false, reason: 'timeout' }),
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });

  const clock = makeClock(0);
  const monitor = createMonitor({ api, config: fastConfig, clock, logger: makeLogger() });

  // 三轮让 n0 与 n2 累积到失败阈值
  for (let i = 0; i < 3; i += 1) {
    await monitor.runCycle();
    clock.advance(1000);
  }

  assert.deepEqual(selected, ['n1']);
  const snap = monitor.getSnapshot();
  assert.equal(snap.currentNow, 'n1');
});

test('发现外部 now 变化时接受新选择并重置失败窗口，不切回旧节点', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1'], leafTypes(['n0', 'n1']));

  let selects = 0;
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async () => ({ ok: false, reason: 'timeout' }),
    select: async () => { selects += 1; return { ok: true }; },
  });

  const clock = makeClock(0);
  const monitor = createMonitor({ api, config: fastConfig, clock, logger: makeLogger() });

  await monitor.runCycle(); // n0 与 n1 均失败一次，各自 suspect fc=1
  clock.advance(1000);

  // 用户手动切换到 n1
  currentNow = 'n1';
  await monitor.runCycle();

  assert.equal(selects, 0, '外部变化后不应切回旧节点');
  const snap = monitor.getSnapshot();
  assert.equal(snap.currentNow, 'n1');
  // 重置后 n1 从 0 开始重新累积，本应累加到 2 却只到 1
  assert.equal(snap.nodeStates['n1'].failureCount, 1, '新选择节点失败窗口应从零重新累积');
});

test('PUT 成功但刷新后的 now 不等于目标时不报告切换成功', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1'], leafTypes(['n0', 'n1']));

  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => (node === 'n1' ? { ok: true, delay: 5 } : { ok: false, reason: 'timeout' }),
    select: async () => ({ ok: true }), // PUT 成功但不改变 now
  });

  const clock = makeClock(0);
  const logger = makeLogger();
  const monitor = createMonitor({ api, config: fastConfig, clock, logger });

  for (let i = 0; i < 3; i += 1) {
    await monitor.runCycle();
    clock.advance(1000);
  }

  assert.equal(monitor.getSnapshot().lastSwitch, null);
  assert.ok(
    logger.logs.some(([level, msg]) => level === 'warn' && /确认|now|confirm/i.test(String(msg))),
    '应记录切换确认失败',
  );
});
