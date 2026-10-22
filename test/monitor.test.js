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

const fastConfig = { ...DEFAULT_CONFIG, minDwellMs: 1, realProbeEnabled: false };

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
  // 只探测 node-b（跳过当前 now node-a 与 URLTest）；冷启动快扫单 URL 探测
  assert.deepEqual(probed, ['node-b']);
  assert.deepEqual(snap.candidates, ['node-b']);
});

test('冷启动 poolCycle 全量快扫（candidateGeneration=0 时探测全部非当前节点）', async () => {
  const tags = Array.from({ length: 30 }, (_, i) => `n${i}`);
  const proxies = selectorProxy('n0', tags, leafTypes(tags));
  const probed = new Set();
  const api = makeApi({
    getProxies: async () => ({ proxies }),
    probe: async (node) => {
      probed.add(node);
      return { ok: true, delay: 1 };
    },
  });
  const monitor = createMonitor({ api, config: fastConfig, clock: makeClock(0), logger: makeLogger() });
  await monitor.poolCycle();
  const snap = monitor.getSnapshot();
  assert.equal(snap.diagnostics.scan.targetCount, 29);
  assert.equal(probed.size, 29);
});

test('冷启动快扫用更短超时（coldStartTimeoutMs）快速分辨死活', async () => {
  const tags = Array.from({ length: 5 }, (_, i) => `n${i}`);
  const proxies = selectorProxy('n0', tags, leafTypes(tags));
  const timeouts = [];
  const api = makeApi({
    getProxies: async () => ({ proxies }),
    probe: async (_node, _url, timeoutMs) => {
      timeouts.push(timeoutMs);
      return { ok: true, delay: 1 };
    },
  });
  const monitor = createMonitor({ api, config: fastConfig, clock: makeClock(0), logger: makeLogger() });
  await monitor.poolCycle(); // 冷启动快扫
  assert.ok(timeouts.length > 0, '快扫应发起探测');
  assert.ok(
    timeouts.every((t) => t === DEFAULT_CONFIG.coldStartTimeoutMs),
    `快扫探测超时应统一为 coldStartTimeoutMs ${DEFAULT_CONFIG.coldStartTimeoutMs}，而非 poolTimeoutMs`,
  );
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

  // 冷启动快扫单 URL 探测：并发上界与探测次数都等于节点数（不再乘以 URL 数）
  assert.ok(
    maxActive <= fastConfig.poolConcurrency,
    `并发峰值 ${maxActive} 应不超过 poolConcurrency ${fastConfig.poolConcurrency}`,
  );
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
  assert.equal(snap.lastSwitch.reason, 'failure');
  assert.match(snap.lastSwitch.requestId, /^request-/);
  assert.match(snap.lastSwitch.switchId, /^switch-/);
  assert.equal(snap.lastSwitch.priority, 10);
  assert.equal(snap.lastSwitch.candidateGeneration, 1);
  assert.equal(snap.lastSwitch.candidateDelay, 10);
  assert.equal(snap.lastSwitch.candidateRecheck, true);
});

test('当前节点 503 连接失败一次即触发切换（不累积 failureThreshold 次）', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1'], leafTypes(['n0', 'n1']));

  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => (node === 'n1' ? { ok: true, delay: 10 } : { ok: false, reason: 'request failed with HTTP 503' }),
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });

  const clock = makeClock(0);
  const monitor = createMonitor({ api, config: fastConfig, clock, logger: makeLogger() });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1']);

  // 第一次 watchCycle：n0 探测 503 → 硬断网即时判定（watchFailureCount 直接到阈值），被 minDwellMs 挡住
  await monitor.watchCycle();
  clock.advance(1000);
  // 第二次 watchCycle：dwell 满足，立即切换（无需累积 3 次）
  await monitor.watchCycle();

  assert.deepEqual(selected, ['n1']);
  assert.equal(monitor.getSnapshot().currentNow, 'n1');
  assert.equal(monitor.getSnapshot().lastSwitch.reason, 'failure');
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

test('节点真实死亡(503)不触发熔断：混合 503/504 失败仍正常记录健康节点', async () => {
  const tags = ['n0', 'n1', 'n2', 'n3'];
  const proxies = () => selectorProxy('n0', tags, leafTypes(tags));

  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => {
      if (node === 'n1') return { ok: true, delay: 10 };
      if (node === 'n2') return { ok: false, reason: 'request failed with HTTP 503' };
      return { ok: false, reason: 'request failed with HTTP 504' };
    },
  });

  const monitor = createMonitor({ api, config: fastConfig, clock: makeClock(0), logger: makeLogger() });
  await monitor.poolCycle(); // 冷启动快扫

  const snap = monitor.getSnapshot();
  // 有 503 硬死亡说明节点真实死亡而非探测 URL 被墙，应正常记录淘汰，健康节点进候选池
  assert.ok(snap.candidates.includes('n1'), '健康节点应进候选池');
  assert.ok(!/熔断|全池|失败率/.test(snap.lastError || ''), '有 503 硬死亡不应触发熔断');
});

test('大量节点 504 超时但仍有健康节点成功时不熔断（冷启动快扫场景）', async () => {
  const tags = Array.from({ length: 20 }, (_, i) => `n${i}`);
  const proxies = () => selectorProxy('n0', tags, leafTypes(tags));

  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    // n1 健康，其余 18 个全 504（模拟 CF-自建死节点超时被短超时误判为全局故障）
    probe: async (node) => {
      if (node === 'n1') return { ok: true, delay: 10 };
      return { ok: false, reason: 'request failed with HTTP 504' };
    },
  });

  const monitor = createMonitor({ api, config: fastConfig, clock: makeClock(0), logger: makeLogger() });
  await monitor.poolCycle(); // 冷启动快扫

  const snap = monitor.getSnapshot();
  assert.ok(snap.candidates.includes('n1'), '唯一健康节点应进候选池');
  assert.ok(!/熔断|全池|失败率/.test(snap.lastError || ''), '有健康节点探测成功即说明探测目标可达，不应熔断');
});

test('通道 A 并行短路多 URL：一轮同时探测全部 URL，任一成功即返回', async () => {
  const proxies = () => selectorProxy('n0', ['n0', 'n1'], leafTypes(['n0', 'n1']));

  const probedUrls = new Set();
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node, url) => {
      if (node === 'n0') probedUrls.add(url);
      return { ok: true, delay: 1 };
    },
  });

  const monitor = createMonitor({ api, config: fastConfig, clock: makeClock(0), logger: makeLogger() });

  await monitor.watchCycle();

  // 并行短路：一轮即探测全部 URL（而非串行只探首个），任一成功即返回
  assert.deepEqual([...probedUrls].sort(), [...DEFAULT_CONFIG.probeUrls].sort());
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

test('冷启动快扫只探测 1 个 URL（最稳定的最后一项）以提速，避免 3 URL 耗尽低并发连接池', async () => {
  const tags = ['n0', 'n1', 'n2'];
  const proxies = () => selectorProxy('n0', tags, leafTypes(tags));

  const probedUrls = new Set();
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (_node, url) => {
      probedUrls.add(url);
      return { ok: true, delay: 10 };
    },
  });

  const monitor = createMonitor({ api, config: fastConfig, clock: makeClock(0), logger: makeLogger() });
  await monitor.poolCycle(); // 冷启动快扫

  // 快扫只用 probeUrls 最后一项（github，最稳定），而不是 3 URL 并行
  const expected = DEFAULT_CONFIG.probeUrls[DEFAULT_CONFIG.probeUrls.length - 1];
  assert.deepEqual([...probedUrls], [expected]);
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

test('手动切换到不可用节点后立即进入盯梢并切换到下一个可用节点', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1', 'n2'], leafTypes(['n0', 'n1', 'n2']));
  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => (node === 'n1' ? { ok: false, reason: 'timeout' } : { ok: true, delay: 10 }),
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });

  const clock = makeClock(0);
  const monitor = createMonitor({ api, config: { ...fastConfig, minDwellMs: 60000 }, clock, logger: makeLogger() });

  await monitor.poolCycle();
  await monitor.watchCycle();
  currentNow = 'n1';
  await monitor.watchCycle();

  assert.deepEqual(selected, ['n2'], '手动切到不可用节点后下一轮应立即切换到可用候选');
  assert.equal(monitor.getSnapshot().currentNow, 'n2');
});

test('同一稳定节点的测速后缀变化不应重置盯梢失败计数', async () => {
  let currentNow = 'n0 | 10ms';
  const proxies = () => selectorProxy(currentNow, ['n0 | 10ms', 'n1 | 10ms'], leafTypes(['n0 | 10ms', 'n1 | 10ms']));
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async () => ({ ok: false, reason: 'timeout' }),
    select: async () => ({ ok: true }),
  });

  const monitor = createMonitor({ api, config: { ...fastConfig, minDwellMs: 60000 }, clock: makeClock(0), logger: makeLogger() });

  await monitor.watchCycle();
  currentNow = 'n0 | 20ms';
  await monitor.watchCycle();

  assert.equal(monitor.getSnapshot().channelA.failureCount, 2, '同一稳定节点后缀变化不应清空失败计数');
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

test('运行快照包含单调 revision 与候选扫描诊断字段', async () => {
  const api = makeApi({
    getProxies: async () => ({ proxies: { ...selectorProxy('n0', ['n0', 'n1']), n0: { type: 'VLESS' }, n1: { type: 'VLESS' } } }),
  });
  const monitor = createMonitor({ api, config: fastConfig, clock: makeClock(), logger: makeLogger() });
  const before = monitor.getSnapshot();
  assert.equal(Number.isInteger(before.revision), true);
  assert.equal(typeof before.diagnostics, 'object');
  await monitor.poolCycle();
  const after = monitor.getSnapshot();
  assert.equal(after.revision > before.revision, true);
  assert.equal(typeof after.diagnostics.lastScan, 'object');
  assert.equal(typeof after.diagnostics.scan, 'object');
  assert.equal(after.diagnostics.scan.targetCount, 1);
  assert.equal(after.diagnostics.scan.round, 1);
  assert.equal(after.diagnostics.scan.durationMs >= 0, true);
});

test('运行快照暴露候选快照代次、有效期、拓扑与协调器可用数', async () => {
  const api = makeApi({
    getProxies: async () => ({ proxies: { ...selectorProxy('n0', ['n0', 'n1']), n0: { type: 'VLESS' }, n1: { type: 'VLESS' } } }),
  });
  const monitor = createMonitor({ api, config: fastConfig, clock: makeClock(), logger: makeLogger() });
  await monitor.poolCycle();
  const snapshot = monitor.getSnapshot();
  const candidateDiagnostics = snapshot.diagnostics.candidateSnapshot;
  assert.equal(Number.isInteger(candidateDiagnostics.generation), true);
  assert.equal(typeof candidateDiagnostics.expiresAt, 'number');
  assert.equal(typeof candidateDiagnostics.topologyFingerprint, 'string');
  assert.equal(candidateDiagnostics.usableCandidateCount, 1);
  assert.equal(candidateDiagnostics.requiresRecheck, false);
  assert.equal(candidateDiagnostics.rejectionReason, null);
});

test('当前节点的 HEAD 与真实 GET 结果进入稳定性摘要', async () => {
  let realCalls = 0;
  const api = makeApi({
    getProxies: async () => ({ proxies: selectorProxy('n0', ['n0', 'n1'], leafTypes(['n0', 'n1'])) }),
    probe: async () => ({ ok: true, delay: 120 }),
  });
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, realProbeEnabled: true, realProbeUrls: ['https://probe.test'], realProbeIntervalMs: 1 },
    clock: makeClock(0),
    logger: makeLogger(),
    httpGetImpl: async () => { realCalls += 1; return { body: 'ok' }; },
  });
  await monitor.watchCycle();
  await monitor.runRealProbe();
  const stability = monitor.getSnapshot().diagnostics.stability;
  assert.equal(realCalls, 1);
  assert.equal(stability.current.headSamples, 1);
  assert.equal(stability.current.realSamples, 1);
  assert.equal(stability.current.eligibility, 'insufficient-real-samples');
});

test('未成为当前节点的候选不执行临时切换真实探测并保持样本不足', async () => {
  const tags = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'];
  let realCalls = 0;
  const api = makeApi({
    getProxies: async () => ({ proxies: selectorProxy('n0', tags, leafTypes(tags)) }),
    probe: async (tag) => ({ ok: true, delay: tag === 'n0' ? 1000 : 100 + Number(tag.slice(1)) }),
  });
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, realProbeEnabled: true, realStabilityProbeBudget: 3, realProbeUrls: ['https://probe.test'] },
    clock: makeClock(0),
    logger: makeLogger(),
    httpGetImpl: async () => { realCalls += 1; return { body: 'ok' }; },
  });
  await monitor.poolCycle();
  const stability = monitor.getSnapshot().diagnostics.stability;
  assert.equal(realCalls, 0);
  assert.equal(stability.candidateProbes, 0);
  assert.ok(stability.candidates.every((summary) => summary.eligibility === 'insufficient-real-samples'));
});

test('watchCycle 不被池刷新阻塞且刷新完成前保留上一轮候选池', async () => {
  const tags = ['n0', 'n1', 'n2'];
  let currentNow = 'n0';
  let poolProbeCount = 0;
  let poolProbeStarted;
  const poolProbeReady = new Promise((resolve) => { poolProbeStarted = resolve; });
  let releaseProbe;
  const api = makeApi({
    getProxies: async () => ({ proxies: selectorProxy(currentNow, tags, leafTypes(tags)) }),
    probe: async (tag) => {
      if (tag === 'n1' && ++poolProbeCount === 2) {
        poolProbeStarted();
        return new Promise((resolve) => { releaseProbe = () => resolve({ ok: true, delay: 20 }); });
      }
      return { ok: true, delay: tag === 'n1' ? 20 : 30 };
    },
  });
  const monitor = createMonitor({ api, config: { ...fastConfig, poolConcurrency: 1 }, clock: makeClock(0), logger: makeLogger() });
  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2']);

  const refresh = monitor.poolCycle();
  await poolProbeReady;
  await monitor.watchCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2'], '刷新未完成前不得清空上一轮候选池');
  releaseProbe();
  await refresh;
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2'], '刷新完成后应原子替换候选池');
  assert.equal(monitor.getSnapshot().poolInProgress, false);
});

test('后台扫描尚未发布新快照时，故障切换仍可使用上一轮候选', async () => {
  const tags = ['n0', 'n1', 'n2'];
  let currentNow = 'n0';
  let releaseProbe;
  let probeStarted;
  let blockRefresh = false;
  const blockedProbe = new Promise((resolve) => { releaseProbe = resolve; });
  const started = new Promise((resolve) => { probeStarted = resolve; });
  const api = makeApi({
    getProxies: async () => ({ proxies: selectorProxy(currentNow, tags, leafTypes(tags)) }),
    probe: async (tag) => {
      if (tag === 'n1' && blockRefresh) {
        probeStarted();
        return blockedProbe;
      }
      return { ok: true, delay: tag === 'n2' ? 20 : 10 };
    },
    select: async (_group, tag) => { currentNow = tag; return { ok: true }; },
  });
  const monitor = createMonitor({ api, config: { ...fastConfig, poolConcurrency: 1 }, clock: makeClock(), logger: makeLogger() });
  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2']);

  blockRefresh = true;
  const refresh = monitor.poolCycle();
  await started;
  const result = await monitor.watchCycle();
  assert.equal(result.error, null);
  assert.equal(result.switchedTo, null);
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2']);
  releaseProbe({ ok: true, delay: 10 });
  await refresh;
});

test('后台扫描可能超过刷新间隔时，候选快照保持到轮次截止后再过期', async () => {
  const tags = ['n0', 'n1'];
  let currentNow = 'n0';
  const api = makeApi({
    getProxies: async () => ({ proxies: selectorProxy(currentNow, tags, leafTypes(tags)) }),
    probe: async (tag) => tag === 'n0' ? { ok: false, reason: 'timeout' } : { ok: true, delay: 10 },
    select: async (_group, tag) => { currentNow = tag; return { ok: true }; },
  });
  const clock = makeClock();
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, poolRefreshIntervalMs: 100, backgroundRoundDeadlineMs: 500 },
    clock,
    logger: makeLogger(),
  });
  await monitor.poolCycle();
  clock.advance(150);
  const snapshot = monitor.getSnapshot().diagnostics.candidateSnapshot;
  assert.equal(snapshot.rejectionReason, null, JSON.stringify(snapshot));
});

test('旧候选快照已过期且后台扫描未完成时，故障切换仍实时复核旧候选', async () => {
  const tags = ['n0', 'n1', 'n2'];
  let currentNow = 'n0';
  let reads = 0;
  let blockRefresh = false;
  let releaseProbe;
  let probeStarted;
  const blockedProbe = new Promise((resolve) => { releaseProbe = resolve; });
  const started = new Promise((resolve) => { probeStarted = resolve; });
  const api = makeApi({
    getProxies: async () => ({ proxies: selectorProxy(currentNow, tags, leafTypes(tags)) }),
    probe: async (tag) => {
      if (tag === 'n2' && blockRefresh) {
        probeStarted();
        return blockedProbe;
      }
      if (tag === 'n0') return { ok: false, reason: 'timeout' };
      return { ok: true, delay: tag === 'n1' ? 10 : 20 };
    },
    select: async (_group, tag) => { currentNow = tag; return { ok: true }; },
  });
  const clock = makeClock();
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, poolConcurrency: 1, failureThreshold: 2, minDwellMs: 1, poolRefreshIntervalMs: 100 },
    clock,
    logger: makeLogger(),
  });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2']);
  await monitor.watchCycle();
  clock.advance(101);
  blockRefresh = true;
  const refresh = monitor.poolCycle();
  await started;
  const result = await monitor.watchCycle();
  const snapshot = monitor.getSnapshot();
  releaseProbe({ ok: true, delay: 10 });
  await refresh;
  assert.equal(result.switchedTo, 'n1', JSON.stringify({ result, snapshot }));
});

test('后台扫描拓扑变化但尚未发布新快照时，故障切换仍使用旧候选', async () => {
  const oldTags = ['n0', 'n1', 'n2'];
  const newTags = ['n0', 'n1', 'n2', 'n3'];
  let currentNow = 'n0';
  let reads = 0;
  let releaseProbe;
  let probeStarted;
  const blockedProbe = new Promise((resolve) => { releaseProbe = resolve; });
  const started = new Promise((resolve) => { probeStarted = resolve; });
  const api = makeApi({
    getProxies: async () => ({
      proxies: selectorProxy(currentNow, reads++ === 0 ? oldTags : newTags, leafTypes(reads === 1 ? oldTags : newTags)),
    }),
    probe: async (tag) => {
      if (tag === 'n2' && reads > 1) {
        probeStarted();
        return blockedProbe;
      }
      if (tag === 'n0') return { ok: false, reason: 'timeout' };
      return { ok: true, delay: 20 };
    },
    select: async (_group, tag) => { currentNow = tag; return { ok: true }; },
  });
  const clock = makeClock();
  const monitor = createMonitor({ api, config: { ...fastConfig, poolConcurrency: 1, failureThreshold: 1, minDwellMs: 1 }, clock, logger: makeLogger() });
  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2']);

  const refresh = monitor.poolCycle();
  await probeStarted;
  await monitor.watchCycle();
  clock.advance(2);
  const result = await monitor.watchCycle();
  assert.equal(result.error, null);
  assert.equal(result.switchedTo, 'n1', JSON.stringify({ result, snapshot: monitor.getSnapshot() }));
  releaseProbe({ ok: true, delay: 20 });
  await refresh;
});

test('前台 Selector 读取长期挂起时按 watch 超时释放额度', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const api = makeApi({
    getProxies: async () => blocked,
    probe: async () => ({ ok: true, delay: 10 }),
  });
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, watchTimeoutMs: 20 },
    clock: makeClock(),
    logger: makeLogger(),
  });
  const startedAt = Date.now();
  const result = await monitor.watchCycle();
  const elapsed = Date.now() - startedAt;
  assert.match(result.error, /watch|Selector|timeout/i);
  assert.ok(elapsed < 200, `前台 Selector 读取未按超时退出：${elapsed}ms`);
  assert.equal(monitor.getSnapshot().diagnostics.scheduler.foregroundInFlight, 0);
  release({ proxies: {} });
});

test('前台节点探测长期挂起时按 watch 超时释放额度', async () => {
  const proxies = selectorProxy('n0', ['n0', 'n1'], leafTypes(['n0', 'n1']));
  const api = makeApi({
    getProxies: async () => ({ proxies }),
    probe: async () => new Promise(() => {}),
  });
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, watchTimeoutMs: 20 },
    clock: makeClock(),
    logger: makeLogger(),
  });
  const startedAt = Date.now();
  const result = await monitor.watchCycle();
  const elapsed = Date.now() - startedAt;
  assert.equal(result.error, null);
  assert.ok(elapsed < 200, `前台节点探测未按超时退出：${elapsed}ms`);
  assert.equal(monitor.getSnapshot().diagnostics.scheduler.foregroundInFlight, 0);
  assert.equal(monitor.getSnapshot().watchInProgress, false);
});

test('后台扫描读取 Selector 前就占用后台轮次预算', async () => {
  let releaseSelector;
  let selectorStarted;
  const selectorBlocked = new Promise((resolve) => {
    selectorStarted = () => resolve();
  });
  const selectorResponse = selectorProxy('n0', ['n0', 'n1'], leafTypes(['n0', 'n1']));
  const monitor = createMonitor({
    api: makeApi({
      getProxies: async () => {
        selectorStarted();
        return new Promise((resolve) => { releaseSelector = () => resolve({ proxies: selectorResponse }); });
      },
    }),
    config: { ...fastConfig, backgroundRoundDeadlineMs: 1000 },
    clock: makeClock(),
    logger: makeLogger(),
  });

  const cycle = monitor.poolCycle();
  await selectorBlocked;
  assert.equal(monitor.getSnapshot().poolInProgress, true);
  assert.equal(monitor.getSnapshot().diagnostics.scheduler.backgroundInProgress, true);
  releaseSelector();
  await cycle;
});

test('后台扫描的 Selector 读取也受整轮截止时间约束', async () => {
  const monitor = createMonitor({
    api: makeApi({
      getProxies: async () => new Promise(() => {}),
    }),
    config: { ...fastConfig, backgroundRoundDeadlineMs: 20 },
    clock: makeClock(),
    logger: makeLogger(),
  });

  const cycle = monitor.poolCycle();
  await Promise.race([
    cycle,
    new Promise((_, reject) => setTimeout(() => reject(new Error('pool cycle exceeded deadline')), 200)),
  ]);
  const snapshot = monitor.getSnapshot();
  assert.equal(snapshot.poolInProgress, false);
  assert.equal(snapshot.diagnostics.scheduler.backgroundInProgress, false);
});

test('后台扫描等待前台额度时，轮次截止仍能退出', async () => {
  const tags = ['n0', 'n1', 'n2'];
  const proxies = selectorProxy('n0', tags, leafTypes(tags));
  let probeCalls = 0;
  let firstBatchDone;
  const firstBatch = new Promise((resolve) => { firstBatchDone = resolve; });
  let releaseWatch;
  const watchBlocked = new Promise((resolve) => { releaseWatch = resolve; });
  let getProxiesCalls = 0;
  const api = makeApi({
    getProxies: async () => {
      getProxiesCalls += 1;
      if (getProxiesCalls > 1) return watchBlocked;
      return { proxies };
    },
    probe: async () => {
      probeCalls += 1;
      if (probeCalls === 1) firstBatchDone();
      return { ok: true, delay: 10 };
    },
  });
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, backgroundBatchSize: 1, backgroundRoundDeadlineMs: 20 },
    clock: makeClock(),
    logger: makeLogger(),
  });

  const pool = monitor.poolCycle();
  await firstBatch;
  const watch = monitor.watchCycle();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.race([
    pool,
    new Promise((_, reject) => setTimeout(() => reject(new Error('后台等待前台额度时未按截止时间退出')), 200)),
  ]);
  releaseWatch({ proxies });
  await watch;
  assert.equal(monitor.getSnapshot().poolInProgress, false);
  assert.equal(monitor.getSnapshot().diagnostics.scheduler.backgroundInProgress, false);
});

test('后台扫描诊断记录批次耗时、游标和超时阶段', async () => {
  const tags = ['n0', 'n1', 'n2'];
  let releaseProbe;
  const api = makeApi({
    getProxies: async () => ({ proxies: selectorProxy('n0', tags, leafTypes(tags)) }),
    probe: async (tag) => {
      if (tag === 'n1') return new Promise((resolve) => { releaseProbe = resolve; });
      return { ok: true, delay: 10 };
    },
  });
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, backgroundBatchSize: 1, backgroundRoundDeadlineMs: 20 },
    clock: makeClock(),
    logger: makeLogger(),
  });
  const cycle = monitor.poolCycle();
  await new Promise((resolve) => setTimeout(resolve, 5));
  releaseProbe({ ok: true, delay: 10 });
  await cycle;
  const scheduler = monitor.getSnapshot().diagnostics.scheduler;
  assert.equal(typeof scheduler.lastBatch.startedAt, 'number');
  assert.equal(typeof scheduler.lastBatch.durationMs, 'number');
  assert.equal(typeof scheduler.lastBatch.cursor, 'number');
  assert.equal(typeof scheduler.lastBatch.foregroundWaitMs, 'number');
  assert.equal(typeof scheduler.lastTimeoutReason, 'string');
});

test('后台扫描失败时不泄漏未发布的拓扑状态', async () => {
  let cycle = 0;
  const oldProxies = selectorProxy('n0', ['n0', 'n1'], leafTypes(['n0', 'n1']));
  const newProxies = selectorProxy('n1', ['n1', 'n2'], leafTypes(['n1', 'n2']));
  const api = makeApi({
    getProxies: async () => {
      cycle += 1;
      return { proxies: cycle === 1 ? oldProxies : newProxies };
    },
    probe: async (node, _url, _timeout, signal) => {
      if (cycle > 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (signal?.aborted) return { ok: false, reason: 'aborted' };
      return { ok: true, delay: node === 'n1' ? 10 : 20 };
    },
  });
  const config = {
    ...fastConfig,
    backgroundRoundDeadlineMs: 20,
    poolConcurrency: 1,
    poolBatchSize: 1,
  };
  const monitor = createMonitor({ api, config, clock: makeClock(0), logger: makeLogger() });
  await monitor.poolCycle();
  const before = monitor.getSnapshot();
  assert.deepEqual(before.members, ['n0', 'n1']);
  assert.equal(before.currentNow, 'n0');
  const refresh = await monitor.poolCycle();
  const after = monitor.getSnapshot();
  assert.equal(refresh.skipped, true);
  assert.deepEqual(after.members, before.members);
  assert.equal(after.currentNow, before.currentNow);
  assert.equal(after.diagnostics.candidateSnapshot.topologyFingerprint, before.diagnostics.candidateSnapshot.topologyFingerprint);
});

test('后台扫描批次异常时恢复未发布拓扑状态', async () => {
  let cycle = 0;
  const oldProxies = selectorProxy('n0', ['n0', 'n1'], leafTypes(['n0', 'n1']));
  const newProxies = selectorProxy('n1', ['n1', 'n2'], leafTypes(['n1', 'n2']));
  const brokenResult = { ok: true };
  Object.defineProperty(brokenResult, 'delay', {
    get() { throw new Error('unexpected probe failure'); },
  });
  const api = makeApi({
    getProxies: async () => ({ proxies: cycle++ === 0 ? oldProxies : newProxies }),
    probe: async () => cycle === 1 ? { ok: true, delay: 10 } : brokenResult,
  });
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, poolConcurrency: 1 },
    clock: makeClock(),
    logger: makeLogger(),
  });
  await monitor.poolCycle();
  const before = monitor.getSnapshot();
  await assert.rejects(() => monitor.poolCycle(), /unexpected probe failure/);
  const after = monitor.getSnapshot();
  assert.deepEqual(after.members, before.members);
  assert.deepEqual(after.memberTypes, before.memberTypes);
  assert.equal(after.currentNow, before.currentNow);
  assert.equal(after.diagnostics.candidateSnapshot.topologyFingerprint, before.diagnostics.candidateSnapshot.topologyFingerprint);
  assert.equal(after.poolInProgress, false);
  assert.equal(after.diagnostics.scheduler.backgroundInProgress, false);
});

test('后台扫描读取或探测异常后释放轮次占用', async () => {
  let calls = 0;
  const api = makeApi({
    getProxies: async () => ({ proxies: selectorProxy('n0', ['n0', 'n1'], leafTypes(['n0', 'n1'])) }),
    probe: async () => {
      calls += 1;
      throw new Error('temporary probe failure');
    },
  });
  const monitor = createMonitor({ api, config: { ...fastConfig, backgroundBatchSize: 1 }, clock: makeClock(), logger: makeLogger() });
  await monitor.poolCycle();
  assert.equal(monitor.getSnapshot().diagnostics.scheduler.backgroundInProgress, false);
  assert.equal(calls > 0, true);
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

test('切换前候选复核：首个候选不可达时跳过并切到下一个可达候选', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1', 'n2'], leafTypes(['n0', 'n1', 'n2']));

  const selected = [];
  let n1up = true; // poolCycle 时可达进入候选池，切换前复核时挂掉
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => {
      if (node === 'n0') return { ok: false, reason: 'timeout' };
      if (node === 'n1') return n1up ? { ok: true, delay: 10 } : { ok: false, reason: 'timeout' };
      return { ok: true, delay: 10 };
    },
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });

  const clock = makeClock(0);
  const monitor = createMonitor({ api, config: fastConfig, clock, logger: makeLogger() });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2']);

  // 切换前 n1 挂掉，复核应跳过它
  n1up = false;

  for (let i = 0; i < 3; i += 1) {
    await monitor.watchCycle();
    clock.advance(1000);
  }

  assert.deepEqual(selected, ['n2'], '应跳过不可达的 n1 直接切到 n2');
  assert.equal(monitor.getSnapshot().currentNow, 'n2');
});

test('盯梢期：切换后新节点失败 1 次即快速切走（免驻留）', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1', 'n2'], leafTypes(['n0', 'n1', 'n2']));

  const selected = [];
  let n1down = false; // 切到 n1 后它才挂掉
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => {
      if (node === 'n0') return { ok: false, reason: 'timeout' };
      if (node === 'n1') return n1down ? { ok: false, reason: 'timeout' } : { ok: true, delay: 10 };
      return { ok: true, delay: 10 };
    },
    select: async (_group, node) => {
      selected.push(node);
      currentNow = node;
      if (node === 'n1') n1down = true;
      return { ok: true };
    },
  });

  const clock = makeClock(0);
  const monitor = createMonitor({ api, config: fastConfig, clock, logger: makeLogger() });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2']);

  for (let i = 0; i < 3; i += 1) {
    await monitor.watchCycle();
    clock.advance(1000);
  }
  assert.deepEqual(selected, ['n1']);
  assert.equal(monitor.getSnapshot().channelA.stalking, true);

  // 盯梢期 n1 失败 1 次即切（免驻留）
  await monitor.watchCycle();

  assert.deepEqual(selected, ['n1', 'n2'], '盯梢期新节点失败 1 次应快速切走');
  assert.equal(monitor.getSnapshot().currentNow, 'n2');
});

test('盯梢期：新节点连续成功 stalkSuccessThreshold 次后退出，恢复正常失败阈值', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1', 'n2'], leafTypes(['n0', 'n1', 'n2']));

  const selected = [];
  let n1down = false;
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => {
      if (node === 'n0') return { ok: false, reason: 'timeout' };
      if (node === 'n1') return n1down ? { ok: false, reason: 'timeout' } : { ok: true, delay: 10 };
      return { ok: true, delay: 10 };
    },
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });

  // 新节点真实 GET 快速达标（10ms < realDelayMs），用于盯梢期退出判定
  const httpGetImpl = async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { body: 'ok' };
  };

  const clock = makeClock(0);
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, realProbeEnabled: true, realProbeUrls: ['https://github.com'], realDelayMs: 100, realProbeTimeoutMs: 500, realStalkSuccessThreshold: 2 },
    clock,
    logger: makeLogger(),
    httpGetImpl,
  });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2']);

  for (let i = 0; i < 3; i += 1) {
    await monitor.watchCycle();
    clock.advance(1000);
  }
  assert.deepEqual(selected, ['n1']);
  assert.equal(monitor.getSnapshot().channelA.stalking, true);

  // 盯梢期真实 GET 连续达标 2 次 → 退出盯梢（HEAD 成功不单独累计）
  for (let i = 0; i < 2; i += 1) {
    await monitor.runRealProbe();
  }
  assert.equal(monitor.getSnapshot().channelA.stalking, false, '真实 GET 连续达标 2 次应退出盯梢');

  // 退出盯梢后 n1 失败 1 次：failureThreshold=3，不立即切（candidates 仍有 n2）
  n1down = true;
  await monitor.watchCycle();
  clock.advance(1000);
  assert.deepEqual(selected, ['n1'], '退出盯梢后失败 1 次不应切换');
});

test('通道 A 绝对慢判定：延迟超过 maxDelayMs 连续 slowThreshold 次触发切换', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1', 'n2'], leafTypes(['n0', 'n1', 'n2']));

  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => (node === 'n0' ? { ok: true, delay: 2500 } : { ok: true, delay: 10 }),
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });

  const clock = makeClock(0);
  const monitor = createMonitor({ api, config: fastConfig, clock, logger: makeLogger() });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2']);

  for (let i = 0; i < 2; i += 1) {
    await monitor.watchCycle();
    clock.advance(1000);
  }

  assert.deepEqual(selected, ['n1']);
  assert.equal(monitor.getSnapshot().currentNow, 'n1');
});

test('tag 漂移：切换前后按 stableKey 剔除新旧节点，确认用 stableKey 比较', async () => {
  // 当前节点带后缀，候选池里残留旧节点 n0 的旧后缀快照（tag 漂移）
  let currentNow = 'n0 | 3ms';
  const proxies = () => selectorProxy(
    currentNow,
    ['n0 | 3ms', 'n0 | 5ms', 'n1', 'n2'],
    leafTypes(['n0 | 3ms', 'n0 | 5ms', 'n1', 'n2']),
  );

  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => (node === 'n0 | 3ms' ? { ok: false, reason: 'timeout' } : { ok: true, delay: 10 }),
    select: async (_group, node) => {
      selected.push(node);
      currentNow = `${node} | 8ms`; // 切换后 GFS 又改后缀
      return { ok: true };
    },
  });

  const clock = makeClock(0);
  const monitor = createMonitor({ api, config: fastConfig, clock, logger: makeLogger() });

  await monitor.poolCycle();
  // poolCycle 精确匹配只排除 'n0 | 3ms'，'n0 | 5ms'（旧后缀快照）仍被探测并进入候选
  assert.deepEqual(monitor.getSnapshot().candidates, ['n0 | 5ms', 'n1', 'n2']);

  for (let i = 0; i < 3; i += 1) {
    await monitor.watchCycle();
    clock.advance(1000);
  }

  // 候选复核前应排除 stableKey 等于当前节点的 'n0 | 5ms'，切到 n1
  assert.deepEqual(selected, ['n1']);
  assert.equal(monitor.getSnapshot().currentNow, 'n1');
  // 方案 B：切换流程只消耗局部 candidatePool，不持久缩小模块级 candidates
  assert.deepEqual(monitor.getSnapshot().candidates, ['n0 | 5ms', 'n1', 'n2']);
});

test('候选池为空时兜底切换到 URLTest 组', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(
    currentNow,
    ['🎈 自动选择', 'n0', 'n1'],
    {
      '🎈 自动选择': { type: 'URLTest', now: 'inner-1', all: ['inner-1'] },
      'n0': { type: 'Shadowsocks' },
      'n1': { type: 'Shadowsocks' },
      'inner-1': { type: 'Shadowsocks' },
    },
  );

  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async () => ({ ok: false, reason: 'timeout' }),
    select: async (_group, node) => {
      selected.push(node);
      currentNow = node;
      return { ok: true };
    },
  });

  const clock = makeClock(0);
  const monitor = createMonitor({ api, config: fastConfig, clock, logger: makeLogger() });

  // 不跑 poolCycle，candidates 保持为空；当前节点连续失败 3 次触发切换
  for (let i = 0; i < 3; i += 1) {
    await monitor.watchCycle();
    clock.advance(1000);
  }

  // 候选池空 + 当前节点失败达阈值 → 兜底切到 URLTest 组
  assert.deepEqual(selected, ['🎈 自动选择']);
  assert.equal(monitor.getSnapshot().currentNow, '🎈 自动选择');
});

test('切入 URLTest 后其内部叶子故障不重复触发 URLTest fallback', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(
    currentNow,
    ['🎈 自动选择', 'n0', 'n1'],
    {
      '🎈 自动选择': { type: 'URLTest', now: 'inner-1', all: ['inner-1'] },
      n0: { type: 'Shadowsocks' },
      n1: { type: 'Shadowsocks' },
      'inner-1': { type: 'Shadowsocks' },
    },
  );
  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async () => ({ ok: false, reason: 'timeout' }),
    select: async (_group, node) => {
      selected.push(node);
      currentNow = node === '🎈 自动选择' ? 'inner-1' : node;
      return { ok: true };
    },
  });
  const clock = makeClock(0);
  const monitor = createMonitor({ api, config: fastConfig, clock, logger: makeLogger() });

  for (let i = 0; i < 6; i += 1) {
    await monitor.watchCycle();
    clock.advance(1000);
  }

  assert.deepEqual(selected, ['🎈 自动选择']);
  assert.equal(monitor.getSnapshot().currentNow, 'inner-1');
  assert.equal(monitor.getSnapshot().lastError, 'no-available-node');
});

test('方案 B：候选复核不可达不持久消耗候选池', async () => {
  let currentNow = 'n0';
  let poolDone = false;
  const proxies = () => selectorProxy(
    currentNow,
    ['n0', 'n1', 'n2', 'n3'],
    leafTypes(['n0', 'n1', 'n2', 'n3']),
  );

  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => {
      if (node === 'n0') return { ok: false, reason: 'timeout' };
      if (node === 'n1' && poolDone) return { ok: false, reason: 'timeout' }; // 复核阶段 n1 瞬时不可达
      return { ok: true, delay: node === 'n1' ? 5 : 10 };
    },
    select: async (_group, node) => {
      selected.push(node);
      currentNow = node;
      return { ok: true };
    },
  });

  const clock = makeClock(0);
  const monitor = createMonitor({ api, config: fastConfig, clock, logger: makeLogger() });

  await monitor.poolCycle();
  poolDone = true;
  // poolCycle 后 candidates 按 delay 升序：n1(5) < n2(10) = n3(10)
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2', 'n3']);

  for (let i = 0; i < 3; i += 1) {
    await monitor.watchCycle();
    clock.advance(1000);
  }

  // n1 复核不可达被跳过，切到 n2
  assert.deepEqual(selected, ['n2']);
  assert.equal(monitor.getSnapshot().currentNow, 'n2');
  // 方案 B：复核不可达的 n1 未被持久剔除，候选池仍完整
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2', 'n3']);
});

test('切换 API 失败时记 lastError 并重置 failureCount，避免累积卡死', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1', 'n2'], leafTypes(['n0', 'n1', 'n2']));

  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => (node === 'n0' ? { ok: false, reason: 'timeout' } : { ok: true, delay: 10 }),
    select: async () => { throw new Error('API 不可用'); },
  });

  const clock = makeClock(0);
  const monitor = createMonitor({ api, config: fastConfig, clock, logger: makeLogger() });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2']);

  for (let i = 0; i < 3; i += 1) {
    await monitor.watchCycle();
    clock.advance(1000);
  }

  const snap = monitor.getSnapshot();
  assert.match(snap.lastError, /switch failed/);
  assert.equal(snap.channelA.failureCount, 0, '切换失败后 failureCount 应重置');
});

test('切换确认失败时记 lastError 并重置 failureCount', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1', 'n2'], leafTypes(['n0', 'n1', 'n2']));

  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => (node === 'n0' ? { ok: false, reason: 'timeout' } : { ok: true, delay: 10 }),
    select: async () => ({ ok: true }), // 控制面未生效，now 仍为 n0
  });

  const clock = makeClock(0);
  const monitor = createMonitor({ api, config: fastConfig, clock, logger: makeLogger() });

  await monitor.poolCycle();

  for (let i = 0; i < 3; i += 1) {
    await monitor.watchCycle();
    clock.advance(1000);
  }

  const snap = monitor.getSnapshot();
  assert.match(snap.lastError, /switch confirm failed/);
  assert.equal(snap.channelA.failureCount, 0, '切换确认失败后 failureCount 应重置');
});

test('真实延迟探测：真实 GET 延迟超过 realDelayMs 触发切换（sing-box 探测不慢）', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1', 'n2'], leafTypes(['n0', 'n1', 'n2']));

  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async () => ({ ok: true, delay: 10 }), // sing-box 探测快，不慢不失败不择优
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });

  // 真实延迟探测：mock httpGetImpl 真等 50ms（> realDelayMs=30），模拟真实 GET 慢。
  // 切换后 currentNow 变为新节点，httpGetImpl 应模拟「新节点真实快」，避免切换后验证误判
  const httpGetImpl = async () => {
    const delay = currentNow === 'n0' ? 50 : 10;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return { body: 'ok' };
  };

  const clock = makeClock(0);
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, realProbeEnabled: true, realDelayMs: 30, realProbeTimeoutMs: 500, realSlowThreshold: 1 },
    clock,
    logger: makeLogger(),
    httpGetImpl,
  });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2']);

  // 先 watchCycle 建立 currentNow，再 runRealProbe 累积 realSlowCount，最后 dwell 满足后触发切换
  await monitor.watchCycle();
  await monitor.runRealProbe();
  clock.advance(1000);
  await monitor.watchCycle();

  assert.deepEqual(selected, ['n1'], '真实 GET 延迟超阈值应触发切换');
  assert.equal(monitor.getSnapshot().currentNow, 'n1');
});

test('真实延迟探测：sing-box 探测不慢（608ms）但真实访问超阈值触发切换', async () => {
  // 典型盲区：sing-box 探测 608ms（< maxDelayMs=2000，不触发绝对慢，也不触发择优），
  // 但真实访问 150ms 超过 realDelayMs=100（相对探测阈值而言「真实慢」），应由真实延迟探测兜底触发切换
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1', 'n2'], leafTypes(['n0', 'n1', 'n2']));

  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async () => ({ ok: true, delay: 608 }), // 所有节点同 608ms，不触发绝对慢/择优/劣化
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });

  // 真实访问 150ms > realDelayMs=100；切换后新节点真实快，避免切换后验证误判
  const httpGetImpl = async () => {
    const delay = currentNow === 'n0' ? 150 : 10;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return { body: 'ok' };
  };

  const clock = makeClock(0);
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, realProbeEnabled: true, realDelayMs: 100, realProbeTimeoutMs: 500, realSlowThreshold: 1 },
    clock,
    logger: makeLogger(),
    httpGetImpl,
  });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2']);

  await monitor.watchCycle();
  await monitor.runRealProbe();
  clock.advance(1000);
  await monitor.watchCycle();

  assert.deepEqual(selected, ['n1'], 'sing-box 探测不慢但真实访问慢应触发切换');
  assert.equal(monitor.getSnapshot().currentNow, 'n1');
});

test('真实延迟探测：真实 GET 延迟未超过 realDelayMs 不触发切换', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1'], leafTypes(['n0', 'n1']));

  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async () => ({ ok: true, delay: 10 }),
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });

  // 真实延迟 20ms < realDelayMs=100，不触发慢判定
  const httpGetImpl = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { body: 'ok' };
  };

  const clock = makeClock(0);
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, realProbeEnabled: true, realDelayMs: 100, realProbeTimeoutMs: 500, realSlowThreshold: 1 },
    clock,
    logger: makeLogger(),
    httpGetImpl,
  });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1']);

  await monitor.watchCycle();
  await monitor.runRealProbe();
  clock.advance(1000);
  await monitor.watchCycle();

  assert.deepEqual(selected, [], '真实延迟未超阈值不应触发切换');
  assert.equal(monitor.getSnapshot().currentNow, 'n0');
  assert.equal(monitor.getSnapshot().channelA.realSlowCount, 0, '真实快时 realSlowCount 应为 0');
});

test('真实探测失败在驻留期内也能触发主动切换', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1'], leafTypes(['n0', 'n1']));
  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async () => ({ ok: true, delay: 10 }),
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });
  const monitor = createMonitor({
    api,
    config: { ...DEFAULT_CONFIG, minDwellMs: 60000, realProbeEnabled: true, realProbeUrls: ['https://github.com'], realSlowThreshold: 1 },
    clock: makeClock(0),
    logger: makeLogger(),
    httpGetImpl: async () => {
      if (currentNow === 'n0') throw new Error('network unreachable');
      return { body: 'ok' };
    },
  });

  await monitor.poolCycle();
  await monitor.watchCycle();
  await monitor.runRealProbe();
  await monitor.watchCycle();

  assert.deepEqual(selected, ['n1'], '真实访问失败应绕过驻留期立即触发切换');
  assert.equal(monitor.getSnapshot().currentNow, 'n1');
});

test('真实探测触发切换时，正在执行的快探结束后仍会补跑切换', async () => {
  let currentNow = 'n0';
  const selected = [];
  let releaseWatch;
  let watchBlocked = true;
  const watchReleased = new Promise((resolve) => { releaseWatch = resolve; });
  const api = makeApi({
    getProxies: async () => {
      if (watchBlocked) await watchReleased;
      return { proxies: selectorProxy(currentNow, ['n0', 'n1'], leafTypes(['n0', 'n1'])) };
    },
    probe: async () => ({ ok: true, delay: 10 }),
    select: async (_group, node) => { selected.push(node); currentNow = node; },
  });
  const monitor = createMonitor({
    api,
    config: { ...DEFAULT_CONFIG, minDwellMs: 60000, realProbeEnabled: true, realProbeUrls: ['https://github.com'], realSlowThreshold: 1, stalkProbeDelayMs: 1 },
    clock: makeClock(0),
    logger: makeLogger(),
    httpGetImpl: async () => { throw new Error('network unreachable'); },
  });

  watchBlocked = false;
  await monitor.poolCycle();
  watchBlocked = true;
  const activeWatch = monitor.watchCycle();
  await new Promise((resolve) => setImmediate(resolve));
  await monitor.runRealProbe();
  const queuedWatch = monitor.watchCycle();
  assert.deepEqual(await queuedWatch, { skipped: true, switchedTo: null, error: null });
  assert.deepEqual(selected, [], '进行中的快探不能被重复切换');
  releaseWatch();
  watchBlocked = false;
  await activeWatch;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(selected, ['n1'], '快探结束后应补跑主动切换');
});

test('停止监控后不再执行排队中的快探', async () => {
  let releaseWatch;
  const gate = new Promise((resolve) => { releaseWatch = resolve; });
  let reads = 0;
  const api = makeApi({
    getProxies: async () => {
      reads += 1;
      if (reads === 1) await gate;
      return { proxies: selectorProxy('n0', ['n0', 'n1'], leafTypes(['n0', 'n1'])) };
    },
  });
  const monitor = createMonitor({ api, config: { ...fastConfig, realProbeEnabled: false }, clock: makeClock(0), logger: makeLogger() });
  const activeWatch = monitor.watchCycle();
  await monitor.watchCycle();
  monitor.stop();
  releaseWatch();
  await activeWatch;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1, '停止后不应再次读取 Selector');
});

test('真实延迟探测：真实 GET 全部失败触发切换（sing-box 探测通但真实不通）', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1', 'n2'], leafTypes(['n0', 'n1', 'n2']));

  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async () => ({ ok: true, delay: 10 }), // sing-box 探测通
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });

  // 真实访问全部失败：抛网络错误；切换后新节点真实可达
  const httpGetImpl = async () => {
    if (currentNow === 'n0') throw new Error('network unreachable');
    return { body: 'ok' };
  };

  const clock = makeClock(0);
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, realProbeEnabled: true, realDelayMs: 30, realProbeTimeoutMs: 500, realSlowThreshold: 1 },
    clock,
    logger: makeLogger(),
    httpGetImpl,
  });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2']);

  // sing-box 探测通但真实 GET 全失败：runRealProbe 累积 realSlowCount，再 watchCycle 触发切换
  await monitor.watchCycle();
  await monitor.runRealProbe();
  clock.advance(1000);
  await monitor.watchCycle();

  assert.deepEqual(selected, ['n1'], '真实访问全失败应触发切换');
  assert.equal(monitor.getSnapshot().currentNow, 'n1');
});

test('真实延迟探测：默认至少两个 URL 成功才算通过', async () => {
  let currentNow = 'n0';
  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: selectorProxy(currentNow, ['n0', 'n1'], leafTypes(['n0', 'n1'])) }),
    probe: async () => ({ ok: true, delay: 10 }),
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });
  const httpGetImpl = async (url) => {
    if (currentNow !== 'n0') return { body: 'ok' };
    if (!url.includes('gstatic')) throw new Error('probe target unavailable');
    return { body: 'ok' };
  };
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, realProbeEnabled: true, realProbeUrls: ['https://github', 'https://google', 'https://gstatic'], realProbeMinSuccesses: 2, realDelayMs: 100 },
    clock: makeClock(0),
    logger: makeLogger(),
    httpGetImpl,
  });
  await monitor.poolCycle();
  await monitor.watchCycle();
  await monitor.runRealProbe();
  assert.equal(monitor.getSnapshot().channelA.realSlowCount, 1, '一个 URL 成功不足门槛时应视为失败');
  assert.deepEqual(selected, []);
});

test('真实延迟探测：多 URL 取最慢延迟，快 URL 不掩盖慢 URL', async () => {
  // 真实探测多个 URL 取最慢，避免「快 URL 掩盖慢 URL」漏判
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1', 'n2'], leafTypes(['n0', 'n1', 'n2']));

  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async () => ({ ok: true, delay: 10 }), // sing-box 探测快
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });

  // github 慢 150ms（> realDelayMs=100），google 快 20ms；应取最慢的 github 150ms。
  // 切换后新节点真实快，避免切换后验证误判
  const httpGetImpl = async (url) => {
    if (currentNow !== 'n0') return { body: 'ok' };
    const delay = url.includes('github') ? 150 : 20;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return { body: 'ok' };
  };

  const clock = makeClock(0);
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, realProbeEnabled: true, realDelayMs: 100, realProbeTimeoutMs: 500, realSlowThreshold: 1 },
    clock,
    logger: makeLogger(),
    httpGetImpl,
  });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2']);

  await monitor.watchCycle();
  await monitor.runRealProbe();
  clock.advance(1000);
  await monitor.watchCycle();

  assert.deepEqual(selected, ['n1'], '多 URL 应取最慢延迟，慢 URL 触发切换');
  assert.equal(monitor.getSnapshot().currentNow, 'n1');
});

test('真实延迟探测：慢→快重置 realSlowCount，偶发慢不误触发切换', async () => {
  // 真实延迟从慢恢复到快，realSlowCount 应重置；realSlowThreshold=2 需连续 2 次慢才切换
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1', 'n2'], leafTypes(['n0', 'n1', 'n2']));

  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async () => ({ ok: true, delay: 10 }),
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });

  // 单 URL：第 1 次慢（150ms > realDelayMs=100），之后快（20ms）
  let calls = 0;
  const httpGetImpl = async () => {
    calls += 1;
    const delay = calls === 1 ? 150 : 20;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return { body: 'ok' };
  };

  const clock = makeClock(0);
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, realProbeEnabled: true, realDelayMs: 100, realProbeTimeoutMs: 500, realSlowThreshold: 2, realProbeUrls: ['https://github.com'] },
    clock,
    logger: makeLogger(),
    httpGetImpl,
  });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2']);

  await monitor.watchCycle();

  // 第 1 次真实探测慢（150ms > realDelayMs=100）→ realSlowCount=1
  await monitor.runRealProbe();
  assert.equal(monitor.getSnapshot().channelA.realSlowCount, 1, '第 1 次真实慢应累积 realSlowCount');

  // 第 2 次真实探测快（20ms）→ realSlowCount 重置 0
  await monitor.runRealProbe();
  assert.equal(monitor.getSnapshot().channelA.realSlowCount, 0, '恢复快后 realSlowCount 应重置为 0');

  clock.advance(1000);
  await monitor.watchCycle();

  assert.deepEqual(selected, [], '偶发慢后恢复快不应触发切换');
  assert.equal(monitor.getSnapshot().channelA.realSlowCount, 0, '恢复快后 realSlowCount 应重置为 0');
});

test('切换后真实验证失败 → 立即回退切下一个候选', async () => {
  // 核心场景：切到候选后立即真实验证，真实失效则排除该候选继续切下一个，
  // 避免「切到失效节点」陷入长判定等待
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1', 'n2'], leafTypes(['n0', 'n1', 'n2']));

  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async () => ({ ok: true, delay: 10 }),
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });

  // n0 真实慢触发切换；n1 也真实慢（切换后验证失败回退）；n2 真实快（验证成功）
  const httpGetImpl = async () => {
    const delay = currentNow === 'n2' ? 10 : 50;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return { body: 'ok' };
  };

  const clock = makeClock(0);
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, realProbeEnabled: true, realDelayMs: 30, realProbeTimeoutMs: 500, realSlowThreshold: 1 },
    clock,
    logger: makeLogger(),
    httpGetImpl,
  });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2']);

  await monitor.watchCycle();
  await monitor.runRealProbe();
  clock.advance(1000);
  await monitor.watchCycle();

  // n1 切换后真实验证失败被回退，继续切 n2 并成功
  assert.deepEqual(selected, ['n1', 'n2'], 'n1 切换后真实验证失效应回退切 n2');
  assert.equal(monitor.getSnapshot().currentNow, 'n2');
});

test('候选切换后的真实验证使用盯梢短超时，缩短失效候选等待', async () => {
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1', 'n2'], leafTypes(['n0', 'n1', 'n2']));
  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => node === 'n0' ? { ok: false, reason: 'timeout' } : { ok: true, delay: node === 'n1' ? 10 : 20 },
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });
  const httpGetImpl = async () => {
    await new Promise((resolve) => setTimeout(resolve, currentNow === 'n1' ? 100 : 1));
    return { body: 'ok' };
  };
  const clock = makeClock(0);
  const monitor = createMonitor({
    api,
    config: {
      ...fastConfig,
      failureThreshold: 1,
      realProbeEnabled: true,
      realProbeUrls: ['https://github.com'],
      realDelayMs: 30,
      realProbeTimeoutMs: 200,
      realStalkTimeoutMs: 20,
    },
    clock,
    logger: makeLogger(),
    httpGetImpl,
  });

  await monitor.poolCycle();
  await monitor.watchCycle();
  clock.advance(1000);
  const startedAt = Date.now();
  await monitor.watchCycle();
  const elapsed = Date.now() - startedAt;

  assert.deepEqual(selected, ['n1', 'n2'], '首个候选真实验证超时后应快速回退到下一个候选');
  assert.ok(elapsed < 90, `候选回退不应等待长真实探测超时，实际耗时 ${elapsed}ms`);
  assert.equal(monitor.getSnapshot().currentNow, 'n2');
});

test('候选复核并行：排序后第一个候选不可达，跳过切第二个', async () => {
  // 复核前 preSwitchMaxProbe 个候选并行探测，不可达者排除，取第一个可达（已按延迟升序）
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1', 'n2'], leafTypes(['n0', 'n1', 'n2']));

  const selected = [];
  let n1Reachable = true;
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => {
      if (node === 'n0') return { ok: false, reason: 'timeout' }; // 当前节点失效，触发切换
      if (node === 'n1') return n1Reachable ? { ok: true, delay: 10 } : { ok: false, reason: 'timeout' };
      return { ok: true, delay: 20 };
    },
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });

  const clock = makeClock(0);
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, failureThreshold: 1 },
    clock,
    logger: makeLogger(),
  });

  await monitor.poolCycle();
  // poolCycle 时 n1 可达，候选池按延迟升序 = ['n1'(10ms), 'n2'(20ms)]
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2']);

  // 触发切换前 n1 变不可达：复核时 n1 被排除，切 n2
  n1Reachable = false;

  for (let i = 0; i < 2; i += 1) {
    await monitor.watchCycle();
    clock.advance(1000);
  }

  assert.deepEqual(selected, ['n2'], 'n1 复核不可达应被跳过，切 n2');
  assert.equal(monitor.getSnapshot().currentNow, 'n2');
});

test('真实探测长期不返回时按配置超时释放前台额度', async () => {
  const proxies = selectorProxy('n0', ['n0'], leafTypes(['n0']));
  const api = makeApi({
    getProxies: async () => ({ proxies }),
    probe: async () => ({ ok: true, delay: 1 }),
  });
  const monitor = createMonitor({
    api,
    config: {
      ...fastConfig,
      realProbeEnabled: true,
      realProbeUrls: ['https://hang.test'],
      realProbeTimeoutMs: 20,
    },
    clock: makeClock(0),
    logger: makeLogger(),
    httpGetImpl: async () => new Promise(() => {}),
  });

  await monitor.poolCycle();
  const result = await Promise.race([
    monitor.runRealProbe(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('真实探测未按超时退出')), 200)),
  ]);
  assert.equal(result.skipped, false);
  assert.equal(monitor.getSnapshot().diagnostics.scheduler.foregroundInFlight, 0);
  assert.equal(monitor.getSnapshot().channelA.realDelay, null);
});

test('真实探测多 URL 首个挂起时不死等底层请求（serializeNative 软超时）', async () => {
  // 修复：realProbeAny 的 serializeNative 模式在「等前一个 native 请求结束」时加软超时，
  // 否则当前节点不可用时 native HttpGet 永久挂起，line 271 await nativeHttpGetTail 死等，
  // runRealProbe 卡住、foregroundInFlight 泄漏、后台快扫被 foreground-wait 阻塞。
  const proxies = selectorProxy('n0', ['n0'], leafTypes(['n0']));
  const api = makeApi({
    getProxies: async () => ({ proxies }),
    probe: async () => ({ ok: true, delay: 1 }),
  });
  const monitor = createMonitor({
    api,
    config: {
      ...fastConfig,
      realProbeEnabled: true,
      realProbeUrls: ['https://hang1.test', 'https://hang2.test'],
      realProbeTimeoutMs: 20,
    },
    clock: makeClock(0),
    logger: makeLogger(),
    httpGetImpl: async () => new Promise(() => {}),
  });

  await monitor.poolCycle();
  const result = await Promise.race([
    monitor.runRealProbe(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('多 URL 挂起未按超时退出')), 200)),
  ]);
  assert.equal(result.skipped, false);
  assert.equal(monitor.getSnapshot().diagnostics.scheduler.foregroundInFlight, 0);
});

test('冷启动快扫不被前台真实探测占用 foreground 预算而阻塞', async () => {
  // 修复：快扫（fastScan）是建立候选池的关键路径，跳过 foreground-wait，避免被
  // 前台探测（runRealProbe/watchCycle）占用 foreground 预算而无限等待。
  const tags = ['n0', 'n1', 'n2', 'n3'];
  const proxies = selectorProxy('n0', tags, leafTypes(tags));
  const api = makeApi({
    getProxies: async () => ({ proxies }),
    probe: async () => ({ ok: true, delay: 1 }),
  });
  const monitor = createMonitor({
    api,
    config: {
      ...fastConfig,
      realProbeEnabled: true,
      realProbeUrls: ['https://hang.test'],
      realProbeTimeoutMs: 500,
    },
    clock: makeClock(0),
    logger: makeLogger(),
    httpGetImpl: async () => new Promise(() => {}),
  });

  await monitor.watchCycle();
  const realProbePromise = monitor.runRealProbe();

  await Promise.race([
    monitor.poolCycle(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('快扫被 foreground 阻塞')), 200)),
  ]);

  assert.ok(monitor.getSnapshot().diagnostics.candidateSnapshot.generation > 0);
  await realProbePromise.catch(() => {});
});

test('真实探测首个 URL 超时但底层未结束时，不提前启动下一个 URL', async () => {
  const proxies = selectorProxy('n0', ['n0'], leafTypes(['n0']));
  const starts = [];
  let firstSettledAt = 0;
  let firstSettledResolve;
  const firstSettled = new Promise((resolve) => { firstSettledResolve = resolve; });
  const api = makeApi({
    getProxies: async () => ({ proxies }),
    probe: async () => ({ ok: true, delay: 1 }),
  });
  const monitor = createMonitor({
    api,
    config: {
      ...fastConfig,
      realProbeEnabled: true,
      realProbeUrls: ['https://first.test', 'https://second.test'],
      realProbeMinSuccesses: 2,
      realProbeTimeoutMs: 20,
    },
    clock: makeClock(0),
    logger: makeLogger(),
    httpGetImpl: async (url) => {
      starts.push({ url, at: Date.now() });
      if (url === 'https://first.test') {
        await new Promise((resolve) => setTimeout(resolve, 50));
        firstSettledAt = Date.now();
        firstSettledResolve(firstSettledAt);
      }
      return { body: 'ok' };
    },
  });

  await monitor.poolCycle();
  const probe = monitor.runRealProbe();
  await firstSettled;
  await probe;
  const second = starts.find((entry) => entry.url === 'https://second.test');
  assert.ok(second, '第二个 URL 应被调度');
  assert.ok(second.at >= firstSettledAt, `第二个 URL 不应早于第一个底层请求结束：${second.at} < ${firstSettledAt}`);
});

test('真实延迟探测：多个 URL 不并发占用 GFS 原生请求桥', async () => {
  // GFS 的原生 HttpGet 桥在并发调用时可能长期占用前台槽位；真实探测必须串行访问 URL。
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0'], leafTypes(['n0']));

  let concurrent = 0;
  let maxConcurrent = 0;
  const httpGetImpl = async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 30));
    concurrent -= 1;
    return { body: 'ok' };
  };

  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async () => ({ ok: true, delay: 10 }),
  });

  const clock = makeClock(0);
  const monitor = createMonitor({
    api,
    config: {
      ...fastConfig,
      realProbeEnabled: true,
      realProbeUrls: ['https://a.com', 'https://b.com', 'https://c.com'],
      realDelayMs: 100,
      realProbeTimeoutMs: 500,
      realSlowThreshold: 1,
    },
    clock,
    logger: makeLogger(),
    httpGetImpl,
  });

  await monitor.poolCycle();
  await monitor.runRealProbe();

  assert.equal(maxConcurrent, 1, `GFS 原生请求桥不应并发探测（峰值并发 ${maxConcurrent}）`);
});

test('盯梢期真实探测用更短超时：中等慢节点在短超时下被判失败再切', async () => {
  // 切换后进入盯梢期（stalking=true），真实探测超时从 realProbeTimeoutMs 缩短到
  // realStalkTimeoutMs，使「介于两者之间」的慢节点更快被判超时失败并触发再切换。
  let currentNow = 'n0';
  const proxies = () => selectorProxy(currentNow, ['n0', 'n1', 'n2'], leafTypes(['n0', 'n1', 'n2']));

  const selected = [];
  const api = makeApi({
    getProxies: async () => ({ proxies: proxies() }),
    probe: async (node) => {
      if (node === 'n0') return { ok: false, reason: 'timeout' }; // n0 HEAD 失效，触发切换
      return { ok: true, delay: 10 }; // n1/n2 HEAD 快
    },
    select: async (_group, node) => { selected.push(node); currentNow = node; return { ok: true }; },
  });

  // 真实访问：n1 切换后验证时快（20ms），盯梢快探时慢（60ms）；n2 快（20ms）
  let n1ProbeCount = 0;
  const httpGetImpl = async () => {
    if (currentNow === 'n1') {
      n1ProbeCount += 1;
      const delay = n1ProbeCount === 1 ? 20 : 60;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { body: 'ok' };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { body: 'ok' };
  };

  const clock = makeClock(0);
  const monitor = createMonitor({
    api,
    config: {
      ...fastConfig,
      failureThreshold: 1,
      realProbeEnabled: true,
      realProbeUrls: ['https://github.com'],
      realDelayMs: 300,          // 60ms < 300，长超时下不算慢
      realProbeTimeoutMs: 500,   // 长超时 500ms：60ms 成功且不慢
      realStalkTimeoutMs: 30,    // 短超时 30ms：60ms 超时失败
      realSlowThreshold: 1,
    },
    clock,
    logger: makeLogger(),
    httpGetImpl,
  });

  await monitor.poolCycle();
  assert.deepEqual(monitor.getSnapshot().candidates, ['n1', 'n2']);

  // 第一轮：n0 HEAD 失效累积计数（dwell 未满足）；advance 后第二轮触发切换切 n1
  await monitor.watchCycle();
  clock.advance(1000);
  await monitor.watchCycle();
  clock.advance(1000);
  assert.deepEqual(selected, ['n1'], 'n0 失效应切到 n1');
  assert.equal(monitor.getSnapshot().currentNow, 'n1');
  assert.equal(monitor.getSnapshot().channelA.stalking, true, '切换后进入盯梢期');

  // 盯梢期 runRealProbe：n1 真实 60ms > realStalkTimeoutMs=30 超时失败 → realSlowCount=1
  await monitor.runRealProbe();
  assert.equal(monitor.getSnapshot().channelA.realSlowCount, 1, '盯梢期短超时下 n1 60ms 应判失败');

  // 盯梢期 realSlowCount 达标 + 免驻留，触发再切 n2
  clock.advance(1000);
  await monitor.watchCycle();

  assert.deepEqual(selected, ['n1', 'n2'], '盯梢期短超时下 n1 60ms 超时失效应触发再切 n2');
  assert.equal(monitor.getSnapshot().currentNow, 'n2');
});

test('冷启动快扫用 coldStartConcurrency 控制并发（低于 WebView 连接池上限避免排队挂起）', async () => {
  const tags = Array.from({ length: 15 }, (_, i) => `n${i}`);
  const proxies = selectorProxy('n0', tags, leafTypes(tags));
  let inflight = 0;
  let maxInflight = 0;
  const api = makeApi({
    getProxies: async () => ({ proxies }),
    probe: async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight -= 1;
      return { ok: true, delay: 1 };
    },
  });
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, coldStartConcurrency: 5 },
    clock: makeClock(0),
    logger: makeLogger(),
  });
  await monitor.poolCycle();
  assert.ok(maxInflight <= 5, `快扫并发峰值 ${maxInflight} 应不超过 coldStartConcurrency 5`);
});

test('快扫探测挂起时通过软超时继续（不死等挂起的 fetch）', async () => {
  const tags = ['n0', 'n1', 'n2', 'n3'];
  const proxies = selectorProxy('n0', tags, leafTypes(tags));
  const api = makeApi({
    getProxies: async () => ({ proxies }),
    probe: async (node) => (node === 'n2' ? new Promise(() => {}) : { ok: true, delay: 1 }),
  });
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, coldStartTimeoutMs: 20 },
    clock: makeClock(0),
    logger: makeLogger(),
  });
  await Promise.race([
    monitor.poolCycle(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('快扫被挂起的 fetch 卡住')), 500)),
  ]);
  assert.ok(monitor.getSnapshot().diagnostics.candidateSnapshot.generation > 0, 'n2 挂起被软超时放弃，n1/n3 成功建立候选池');
});

test('冷启动快扫超时时发布部分候选池（渐进建立），打破超时回滚死循环', async () => {
  const tags = ['n0', 'n1', 'n2', 'n3', 'n4'];
  let currentNow = 'n0';
  const api = makeApi({
    getProxies: async () => ({ proxies: selectorProxy(currentNow, tags, leafTypes(tags)) }),
    // n4 快速成功（快扫反转后第一批探测到）；其余节点慢（200ms）触发超时中断
    probe: async (node) => {
      if (node === 'n4') return { ok: true, delay: 10 };
      return new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 200));
    },
    select: async (_group, tag) => { currentNow = tag; return { ok: true }; },
  });
  const monitor = createMonitor({
    api,
    config: { ...fastConfig, coldStartConcurrency: 2, backgroundRoundDeadlineMs: 100 },
    clock: makeClock(0),
    logger: makeLogger(),
  });
  await monitor.poolCycle(); // 冷启动快扫，deadline 100ms 超时中断
  const snapshot = monitor.getSnapshot();
  // 快扫超时但部分发布：n4 成功进候选池，generation 递增，下一轮进入正常轮次（不死循环）
  assert.ok(snapshot.diagnostics.candidateSnapshot.generation > 0, JSON.stringify(snapshot.diagnostics.candidateSnapshot));
  assert.deepEqual(snapshot.candidates, ['n4'], JSON.stringify(snapshot.candidates));
});
