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

test('通道 B 同步成员、跳过 URLTest 与当前 now、按成员顺序产出 candidates', async () => {
  const proxies = selectorProxy('node-a', ['node-a', 'node-b', '🎈 自动选择'], {
    'node-a': { type: 'Shadowsocks' },
    'node-b': { type: 'Shadowsocks' },
    '🎈 自动选择': { type: 'URLTest', now: 'inner-1', all: ['inner-1', 'inner-2'] },
    'inner-1': { type: 'Shadowsocks' },
    'inner-2': { type: 'Shadowsocks' },
  });

  const probed = [];
  const api = makeApi({
    getProxies: async () => ({ proxies }),
    probe: async (node) => {
      probed.push(node);
      return node === 'node-b' ? { ok: true, delay: 10 } : { ok: false, reason: 'timeout' };
    },
  });

  const monitor = createMonitor({ api, config: fastConfig, clock: makeClock(0), logger: makeLogger() });
  await monitor.poolCycle();

  const snap = monitor.getSnapshot();
  assert.equal(snap.currentNow, 'node-a');
  assert.deepEqual([...snap.members].sort(), ['node-a', 'node-b', '🎈 自动选择']);
  assert.equal(snap.memberTypes['🎈 自动选择'], 'URLTest');
  assert.equal(snap.memberTypes['inner-1'], undefined);
  // 只探测 node-b（跳过当前 now node-a 与 URLTest），candidates 按成员顺序
  assert.deepEqual(probed, ['node-b']);
  assert.deepEqual(snap.candidates, ['node-b']);
});

test('通道 B 并发峰值不超过 poolConcurrency 且跳过当前 now', async () => {
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
  await monitor.poolCycle();

  assert.ok(maxActive <= fastConfig.poolConcurrency, `并发峰值 ${maxActive} 应不超过 ${fastConfig.poolConcurrency}`);
  assert.equal(probeCount, tags.length - 1);
});

test('主 Selector 缺失、类型非 Selector 或空成员时停止并报告原因', async () => {
  const missing = makeApi({ getProxies: async () => ({ proxies: {} }) });
  const m1 = createMonitor({ api: missing, config: fastConfig, clock: makeClock(0), logger: makeLogger() });
  await m1.poolCycle();
  assert.match(m1.getSnapshot().lastError, /不存在|not found/i);

  const urlTestGroup = makeApi({
    getProxies: async () => ({ proxies: { [SELECTOR]: { type: 'URLTest', now: 'x', all: ['x'] } } }),
  });
  const m2 = createMonitor({ api: urlTestGroup, config: fastConfig, clock: makeClock(0), logger: makeLogger() });
  await m2.poolCycle();
  assert.match(m2.getSnapshot().lastError, /非 Selector|Selector/i);
});

test('通道 A 只探当前 now，连续失败达到 failureThreshold 后从 candidates 切换', async () => {
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

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1']);

  for (let i = 0; i < 3; i += 1) {
    await monitor.watchCycle();
    clock.advance(1000);
  }

  assert.deepEqual(selected, ['n1']);
  const snap = monitor.getSnapshot();
  assert.equal(snap.currentNow, 'n1');
  assert.equal(snap.nodeStates['n0'].status, 'cooldown');
});

test('通道 A 延迟劣化：基线满后实时延迟>中位数×ratio 连续 2 次触发切换', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1'], leafTypes(['n0', 'n1']));

  const delays = [10, 10, 10, 10, 10, 100, 100];
  let probeIdx = 0;
  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => {
      if (node === 'n0') {
        const d = delays[probeIdx] ?? delays[delays.length - 1];
        probeIdx += 1;
        return { ok: true, delay: d };
      }
      return { ok: true, delay: 10 };
    },
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });

  const clock = makeClock(0);
  const monitor = createMonitor({ api, config: fastConfig, clock, logger: makeLogger() });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1']);

  for (let i = 0; i < 7; i += 1) {
    await monitor.watchCycle();
    clock.advance(1000);
  }

  assert.deepEqual(selected, ['n1']);
});

test('延迟基线不足时禁用劣化判定，只走故障判定', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1'], leafTypes(['n0', 'n1']));

  let n0probe = 0;
  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => {
      if (node === 'n0') {
        n0probe += 1;
        return n0probe <= 2 ? { ok: true, delay: 100 } : { ok: false, reason: 'timeout' };
      }
      return { ok: true, delay: 10 };
    },
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });

  const clock = makeClock(0);
  const monitor = createMonitor({ api, config: fastConfig, clock, logger: makeLogger() });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1']);

  // 前 2 次成功 delay=100（基线 < baselineWindow=5），不触发劣化切换
  for (let i = 0; i < 2; i += 1) {
    await monitor.watchCycle();
    clock.advance(1000);
  }
  assert.equal(selected.length, 0, '基线不足时延迟劣化不触发切换');

  // 之后连续失败 3 次才切换
  for (let i = 0; i < 3; i += 1) {
    await monitor.watchCycle();
    clock.advance(1000);
  }
  assert.deepEqual(selected, ['n1']);
});

test('候选池为空时不切换并记 lastError', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1'], leafTypes(['n0', 'n1']));

  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async () => ({ ok: false, reason: 'timeout' }),
    select: async () => ({ ok: true }),
  });

  const clock = makeClock(0);
  const monitor = createMonitor({ api, config: fastConfig, clock, logger: makeLogger() });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, []);

  for (let i = 0; i < 3; i += 1) {
    await monitor.watchCycle();
    clock.advance(1000);
  }

  const snap = monitor.getSnapshot();
  assert.equal(snap.currentNow, 'n0');
  assert.match(snap.lastError, /候选池为空/);
});

test('通道 B 全池失败率超过阈值时本轮作废、不推进状态', async () => {
  const tags = ['n0', 'n1', 'n2', 'n3'];
  const proxies = () => selectorProxy('n0', tags, leafTypes(tags));

  let failAll = false;
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async () => (failAll ? { ok: false, reason: 'timeout' } : { ok: true, delay: 10 }),
  });

  const monitor = createMonitor({ api, config: fastConfig, clock: makeClock(0), logger: makeLogger() });

  await monitor.poolCycle();
  const snap1 = monitor.getSnapshot();
  assert.deepEqual(snap1.candidates, ['n1', 'n2', 'n3']);
  assert.equal(snap1.nodeStates['n1'].status, 'healthy');

  failAll = true;
  await monitor.poolCycle();

  const snap2 = monitor.getSnapshot();
  assert.equal(snap2.nodeStates['n1'].status, 'healthy');
  assert.equal(snap2.nodeStates['n1'].lastError, null);
  assert.deepEqual(snap2.candidates, ['n1', 'n2', 'n3']);
  assert.match(snap2.lastError, /熔断|全池|失败率/);
});

test('通道 A 快探按轮次轮换起始探测 URL（短路多 URL）', async () => {
  const proxies = () => selectorProxy('n0', ['n0', 'n1'], leafTypes(['n0', 'n1']));

  const probedUrls = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node, url) => {
      if (node === 'n0') probedUrls.push(url);
      return { ok: true, delay: 1 };
    },
  });

  const monitor = createMonitor({ api, config: fastConfig, clock: makeClock(0), logger: makeLogger() });

  for (let i = 0; i < 3; i += 1) {
    await monitor.watchCycle();
  }

  // mock 全部成功，短路探测每轮只探序列首个 URL，验证起始位轮换
  assert.deepEqual(probedUrls, [
    DEFAULT_CONFIG.probeUrls[0],
    DEFAULT_CONFIG.probeUrls[1],
    DEFAULT_CONFIG.probeUrls[2],
  ]);
});

test('通道 B 短路多 URL：对 gstatic/google 不可达但 github 可达的节点进入候选池', async () => {
  const proxies = selectorProxy('n0', ['n0', 'n1'], leafTypes(['n0', 'n1']));

  const api = makeApi({
    getProxies: async () => ({ proxies }),
    probe: async (node, url) => {
      if (node === 'n1' && (url.includes('gstatic') || url.includes('google'))) {
        return { ok: false, reason: 'HTTP 503' };
      }
      return { ok: true, delay: 20 };
    },
  });

  const monitor = createMonitor({ api, config: fastConfig, clock: makeClock(0), logger: makeLogger() });
  await monitor.poolCycle();

  const snap = monitor.getSnapshot();
  assert.ok(snap.candidates.includes('n1'), '对 gstatic/google 不可达但 github 可达的节点应进入候选池');
  assert.equal(snap.nodeStates['n1'].status, 'healthy');
  assert.equal(snap.nodeStates['n1'].lastDelay, 20);
});

test('切换后驻留期 minDwellMs 内不二次切换', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1'], leafTypes(['n0', 'n1']));

  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => (node === currentNow ? { ok: false, reason: 'timeout' } : { ok: true, delay: 10 }),
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });

  const clock = makeClock(0);
  const monitor = createMonitor({ api, config: { ...fastConfig, minDwellMs: 5000 }, clock, logger: makeLogger() });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1']);

  // 每次 advance 3000，第 3 次 now=6000 >= 0+5000 触发首次切换（currentStartAt=6000）
  for (let i = 0; i < 3; i += 1) {
    await monitor.watchCycle();
    clock.advance(3000);
  }
  assert.deepEqual(selected, ['n1']);

  // 切换后 clock 不前进（now 停在 9000 < 6000+5000=11000），即使当前节点失败也不二次切换
  for (let i = 0; i < 3; i += 1) {
    await monitor.watchCycle();
  }

  assert.deepEqual(selected, ['n1'], '驻留期内不应二次切换');
});

test('外部 now 变化接受新选择、重置快探窗口、不切回', async () => {
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

  await monitor.watchCycle();
  clock.advance(1000);
  await monitor.watchCycle();
  clock.advance(1000);

  let snap = monitor.getSnapshot();
  assert.equal(snap.channelA.failureCount, 2);

  currentNow = 'n1';
  await monitor.watchCycle();

  snap = monitor.getSnapshot();
  assert.equal(selects, 0, '外部变化后不应切回旧节点');
  assert.equal(snap.currentNow, 'n1');
  assert.equal(snap.channelA.failureCount, 1, '新选择节点失败窗口应从零重新累积');
});

test('动态节点名漂移时 watchCycle 同步 members 使 currentNow 可被精确匹配', async () => {
  // 模拟 GFS 实时测速改写节点名（追加 IP 后缀），两次响应间节点名漂移
  let version = 1;
  const proxies = () => selectorProxy(
    `node-a | ip${version}`,
    [`node-a | ip${version}`, `node-b | ip${version}`],
    leafTypes([`node-a | ip${version}`, `node-b | ip${version}`]),
  );

  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async () => ({ ok: true, delay: 1 }),
  });

  const monitor = createMonitor({ api, config: fastConfig, clock: makeClock(0), logger: makeLogger() });

  await monitor.watchCycle();
  let snap = monitor.getSnapshot();
  assert.equal(snap.currentNow, 'node-a | ip1');
  assert.ok(snap.members.includes(snap.currentNow), 'currentNow 应在 members 中');

  version = 2;
  await monitor.watchCycle();

  snap = monitor.getSnapshot();
  assert.equal(snap.currentNow, 'node-a | ip2');
  assert.ok(snap.members.includes(snap.currentNow), '漂移后 currentNow 仍应在 members 中');
  assert.deepEqual([...snap.members].sort(), ['node-a | ip2', 'node-b | ip2']);
});

test('PUT 成功但刷新后的 now 不等于目标时不报告切换成功', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1'], leafTypes(['n0', 'n1']));

  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => (node === 'n1' ? { ok: true, delay: 5 } : { ok: false, reason: 'timeout' }),
    select: async () => ({ ok: true }),
  });

  const clock = makeClock(0);
  const logger = makeLogger();
  const monitor = createMonitor({ api, config: fastConfig, clock, logger });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1']);

  for (let i = 0; i < 3; i += 1) {
    await monitor.watchCycle();
    clock.advance(1000);
  }

  assert.equal(monitor.getSnapshot().lastSwitch, null);
  assert.ok(
    logger.logs.some(([level, msg]) => level === 'warn' && /确认|now|confirm/i.test(String(msg))),
    '应记录切换确认失败',
  );
});

test('stop 时进行中的 poolCycle 不抛 null 异常', async () => {
  const tags = ['n0', 'n1', 'n2'];
  const proxies = selectorProxy('n0', tags, leafTypes(tags));

  let release;
  const api = makeApi({
    getProxies: async () => ({ proxies }),
    probe: async (tag) => {
      if (tag === 'n1') {
        return new Promise((resolve) => { release = resolve; });
      }
      return { ok: false, reason: 'timeout' };
    },
  });

  const monitor = createMonitor({ api, config: fastConfig, clock: makeClock(0), logger: makeLogger() });

  const cycle = monitor.poolCycle();
  await new Promise((r) => setTimeout(r, 10));
  monitor.stop();
  release({ ok: true, delay: 50 });

  await cycle;
  assert.equal(monitor.getSnapshot().poolInProgress, false);
});

test('通道 A 性能择优：当前节点延迟明显高于候选池最优时连续达标后切换', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1'], leafTypes(['n0', 'n1']));

  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => (node === 'n0' ? { ok: true, delay: 100 } : { ok: true, delay: 10 }),
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });

  const clock = makeClock(0);
  const monitor = createMonitor({ api, config: fastConfig, clock, logger: makeLogger() });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1']);

  // optimizeRatio=2、optimizeThreshold=3：100 > 10*2，连续 3 次达标触发切换
  for (let i = 0; i < 3; i += 1) {
    await monitor.watchCycle();
    clock.advance(1000);
  }

  assert.deepEqual(selected, ['n1']);
  assert.equal(monitor.getSnapshot().currentNow, 'n1');
  assert.equal(monitor.getSnapshot().channelA.optimizeCount, 0, '切换后择优计数应重置');
});

test('通道 A 性能择优：当前节点延迟未超阈值时不触发切换', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1'], leafTypes(['n0', 'n1']));

  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => (node === 'n0' ? { ok: true, delay: 15 } : { ok: true, delay: 10 }),
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });

  const clock = makeClock(0);
  const monitor = createMonitor({ api, config: fastConfig, clock, logger: makeLogger() });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1']);

  // 15 <= 10*2=20，不触发择优，多次探测仍不切换
  for (let i = 0; i < 5; i += 1) {
    await monitor.watchCycle();
    clock.advance(1000);
  }

  assert.deepEqual(selected, [], '延迟未超阈值不应触发择优切换');
  assert.equal(monitor.getSnapshot().currentNow, 'n0');
  assert.equal(monitor.getSnapshot().channelA.optimizeCount, 0);
});
